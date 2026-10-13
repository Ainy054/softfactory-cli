import { Task } from './types.js';
import { WorkerEnvironmentError } from './IWorker.js';
import { extractJson } from './extractJson.js';
import type { ITextModel } from './TextModel.js';

export interface InspectionResult {
  verdict: 'PASS' | 'FAIL';
  feedback: string;
  /** For a FAIL: mechanical (one correct form, no test could disagree) or logic. Absent on PASS or when the reviewer did not say. */
  fixKind?: 'mechanical' | 'logic';
  provider: string;
  model: string;
}

export interface Epiphany {
  should_save: boolean;
  lesson: string;
  /** The command or gate that would have caught the failure; a lesson without one is not saved. */
  check?: string;
  tags?: string[];
  scope?: 'project' | 'language' | 'path';
  confidence?: number;
}

/**
 * The fixed shape of a release post-mortem, in the order the sections must
 * appear. `synthesizeMemory` asks the model for exactly these headings and
 * `normalizePostmortem` enforces them on whatever the model returns.
 */
export const POSTMORTEM_SECTIONS = [
  'What worked',
  'What review caught',
  'Codebase facts',
  'Planning advice',
  'Escalations applied',
  'Unverified claims',
];

/**
 * Force a model's free-form post-mortem into the fixed six-section shape: the
 * sections appear in POSTMORTEM_SECTIONS order, each known heading keeps the
 * bullets written under it, a missing section becomes `- none`, and any
 * heading not in the list (with everything under it) is dropped. Pure: the
 * same input always yields the same output.
 */
export function normalizePostmortem(text: string): string {
  const bullets = new Map<string, string[]>(POSTMORTEM_SECTIONS.map(section => [section, []]));
  let current: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.*?)\s*:?\s*$/);
    if (heading) {
      const name = heading[1].trim().toLowerCase();
      current = POSTMORTEM_SECTIONS.find(section => section.toLowerCase() === name);
      continue;
    }
    if (!current) continue;
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const content = (bullet ? bullet[1] : line).trim();
    if (content) bullets.get(current)!.push(`- ${content}`);
  }
  return POSTMORTEM_SECTIONS
    .map(section => {
      const items = bullets.get(section)!;
      return `### ${section}\n${items.length ? items.join('\n') : '- none'}`;
    })
    .join('\n\n');
}

/** Backends that start a CLI agent session before they answer. */
const CLI_PROVIDERS = new Set(['agy', 'openai', 'claude-code', 'gemini-cli', 'muse']);

/**
 * How long a review may take. A CLI backend spends minutes starting a session
 * and reading a large diff (agy timed out at 2 minutes on a 492-line file, which
 * halted the run), so it gets at least 8. SOFTFACTORY_INSPECTOR_TIMEOUT_MS
 * overrides both.
 */
export function reviewTimeoutMs(provider: string, apiDefault: number, env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.SOFTFACTORY_INSPECTOR_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return CLI_PROVIDERS.has(provider) ? Math.max(apiDefault, 8 * 60_000) : apiDefault;
}

/**
 * The merge gate's reviewer, plus the two non-gating syntheses that use the
 * same model. It runs on exactly the model it was given: when that model is
 * unreachable it raises an environment fault that halts the run, rather than
 * quietly asking a different model.
 */
export class Inspector {
  constructor(private readonly textModel: ITextModel) {}

  get provider(): string { return this.textModel.provider; }
  get model(): string { return this.textModel.model; }

  isAvailable(): Promise<boolean> { return this.textModel.isAvailable(); }

  async inspect(task: Task, diff: string, handoffSummary: string, verifierOutput?: string, swallowed?: Array<{ file: string; line: number; snippet: string }>): Promise<InspectionResult> {
    const swallowedHits = swallowed ?? [];
    const swallowedSection = swallowedHits.length
      ? `\nErrors swallowed into empty results (file:line):\n${swallowedHits.map(hit => `- ${hit.file}:${hit.line}: ${hit.snippet}`).join('\n')}\n`
      : '';
    const swallowedRule = swallowedHits.length
      ? '\n5. Errors swallowed into empty results: for every hit listed in "Errors swallowed into empty results (file:line):", the diff must make the failure visible — logged, counted, returned as an error status, or surfaced to the caller. If it does not, FAIL with fix_kind "logic". An outside call (network, file, subprocess, database) that fails must never look like an empty success.'
      : '';
    const prompt = `
You are the SoftFactory Quality Inspector.
Your task is to review a code diff against a task description, the worker's handoff summary, and local test execution output.

Task Role: ${task.agent_role}
Task Description: ${task.description}
Acceptance Criteria: ${task.acceptance_criteria.join('; ') || '(none declared)'}
Handoff Summary: ${handoffSummary}
${verifierOutput ? `\nLocal Automated Test & Verification Output:\n${verifierOutput}\n` : ''}

Code Diff:
${diff}
${swallowedSection}
Verdict Rules:
1. Does the code fulfill the task requirements and acceptance criteria?
2. Are there obvious bugs, syntax errors, or architectural violations?
3. If the task role is "test_writer" (TDD): It is EXPECTED and NORMAL for newly written test assertions to fail against not-yet-implemented business logic. You must NOT fail a "test_writer" task simply because the tests fail against unimplemented code, as long as the test code compiles and validly tests the required behavior.
4. For implementation roles ("coder", etc.): Ensure automated tests compile and pass.
5. Errors swallowed into empty results: for every hit listed in "Errors swallowed into empty results (file:line):", the diff must make the failure visible — logged, counted, returned as an error status, or surfaced to the caller. If it does not, FAIL with fix_kind "logic". An outside call (network, file, subprocess, database) that fails must never look like an empty success.


If the verdict is FAIL, classify the fix:
- "mechanical": every defect has exactly one correct form and no test could disagree with it (a typo in a message, a missing import, an off-by-one in a script, a wrong file name in a string).
- "logic": anything else. Error or status-code mapping, TTL or expiry rules, auth or role lists, configuration inside folded YAML, and any change to what a function returns are logic at any line count.

CRITICAL: Return ONLY a valid JSON object:
{
  "verdict": "PASS" | "FAIL",
  "fix_kind": "none" | "mechanical" | "logic",
  "feedback": "Concise explanation of your decision"
}
`;
    let raw: string;
    try {
      raw = await this.textModel.complete(prompt, { timeoutMs: reviewTimeoutMs(this.provider, 120_000), json: true });
    } catch (error: any) {
      // The inspector is a merge gate. Nothing may pass because the reviewer
      // was unavailable, and nothing else may review in its place.
      throw new WorkerEnvironmentError(`Quality inspector (${this.provider}/${this.model}) is unavailable: ${error?.message || 'inference failed'}. No diff was reviewed, so nothing was merged.`);
    }
    try {
      const parsed = extractJson(raw);
      return {
        verdict: parsed.verdict?.toUpperCase() === 'PASS' ? 'PASS' : 'FAIL',
        ...(parsed.verdict?.toUpperCase() !== 'PASS' && ['mechanical', 'logic'].includes(parsed.fix_kind) ? { fixKind: parsed.fix_kind } : {}),
        feedback: parsed.feedback || 'No feedback provided.',
        provider: this.provider,
        model: this.model,
      };
    } catch {
      return {
        verdict: 'FAIL',
        feedback: `Inspector returned unreadable output (expected JSON with verdict and feedback). Raw: ${raw.slice(0, 300)}`,
        provider: this.provider,
        model: this.model,
      };
    }
  }

  /**
   * Review for protected code. The reviewer sees the diff, the task's own
   * acceptance criteria, the verification output and the worker's answers to
   * the review questions. It never sees the worker's summary, so it verifies
   * instead of being told. Softhouse measured this as its single most
   * valuable gate: every failure it raised was a real defect that had
   * compiled and passed the worker's tests.
   */
  async inspectBlind(task: Task, diff: string, verifierOutput: string, reviewAnswers: string[] = []): Promise<InspectionResult> {
    const questions = task.review_questions || [];
    const qa = questions.length
      ? questions.map((q, i) => `Q${i + 1}: ${q}\nWorker's answer: ${reviewAnswers[i] || '(no answer given — treat as unverified)'}`).join('\n\n')
      : '(none declared; apply the standing questions below)';
    const prompt = `
You are an INDEPENDENT reviewer for a change to protected code: authentication, authorization, tenancy, money, cryptography, secrets, or any path this project marked protected.
You see only the diff, the task's acceptance criteria, the verification output, and the worker's answers to the review questions. You have NOT seen the worker's own account of the work and must not assume good intent. Code that compiles and passes the worker's tests can still be wrong.

Task: ${task.title}
Description: ${task.description}
Acceptance Criteria: ${task.acceptance_criteria.join('; ') || '(none declared)'}

Review questions and the worker's answers:
${qa}

Standing questions for every protected change:
- Which route, caller or event reaches this code, with which authentication, and which test proves it?
- Where is the tenant or principal checked before every read and write, and what happens when it is absent?
- Does any path fail open (an empty list, a missing claim, an error swallowed) where it must fail closed?
- Is any money or quantity computed here? Re-derive it yourself from the diff; do not read the worker's figure.
- Could a secret, token or card number reach a log, an event, or a response?

Method: verify each worker answer at the cited file and line in the diff BEFORE anything else; an answer that does not match the diff is a FAIL. Then trace every path the standing questions name. End your feedback with "Checked:" and the list of what you examined, even when you found nothing.

Verification output:
${verifierOutput || '(none)'}

Diff:
${diff}


If the verdict is FAIL, classify the fix:
- "mechanical": every defect has exactly one correct form and no test could disagree with it (a typo in a message, a missing import, an off-by-one in a script, a wrong file name in a string).
- "logic": anything else. Error or status-code mapping, TTL or expiry rules, auth or role lists, configuration inside folded YAML, and any change to what a function returns are logic at any line count.

CRITICAL: Return ONLY a valid JSON object:
{
  "verdict": "PASS" | "FAIL",
  "fix_kind": "none" | "mechanical" | "logic",
  "feedback": "findings first (severity, location, what is wrong, the fix), then Checked: ..."
}
`;
    let raw: string;
    try {
      raw = await this.textModel.complete(prompt, { timeoutMs: reviewTimeoutMs(this.provider, 240_000), json: true });
    } catch (error: any) {
      throw new WorkerEnvironmentError(`Independent reviewer (${this.provider}/${this.model}) is unavailable: ${error?.message || 'inference failed'}. No protected diff was reviewed, so nothing was merged.`);
    }
    try {
      const parsed = extractJson(raw);
      return {
        verdict: parsed.verdict?.toUpperCase() === 'PASS' ? 'PASS' : 'FAIL',
        ...(parsed.verdict?.toUpperCase() !== 'PASS' && ['mechanical', 'logic'].includes(parsed.fix_kind) ? { fixKind: parsed.fix_kind } : {}),
        feedback: parsed.feedback || 'No feedback provided.',
        provider: this.provider,
        model: this.model,
      };
    } catch {
      return { verdict: 'FAIL', feedback: `Independent reviewer returned unreadable output. Raw: ${raw.slice(0, 300)}`, provider: this.provider, model: this.model };
    }
  }

  async synthesizeEpiphany(task: Task, diff: string): Promise<Epiphany | null> {
    const prompt = `Extract one specific, reusable project lesson from this successfully repaired task. Return only JSON: {"should_save":boolean,"lesson":string,"check":string,"tags":string[],"scope":"project"|"language"|"path","confidence":number}. "check" is the concrete command, test or gate that would have caught this failure before review (for example "npm test -- src/x.test.ts" or "grep -n 'export' src/x.ts"); if no check could have caught it, set should_save to false. Reject generic advice.\nTask: ${task.description}\nFailures: ${(task.error_history || []).join('\n')}\nFinal diff: ${diff.slice(0, 6000)}`;
    try {
      return extractJson<Epiphany>(await this.textModel.complete(prompt, { timeoutMs: 60000, json: true }));
    } catch {
      return null;
    }
  }

  /**
   * The fixed-shape post-mortem for a finished build. Empty string when the
   * model cannot be reached; the caller skips the write. `facts` carries the
   * run state the diff cannot show — each task's id, status, attempts and last
   * error — which the synthesizer must use for "What review caught" and
   * "Escalations applied".
   */
  async synthesizeMemory(feature: string, diff: string, facts?: string): Promise<string> {
    const prompt = `
You are the SoftFactory Memory Synthesizer.
A feature has been successfully built. Produce a post-mortem for future builds, in exactly this shape.

Feature: ${feature}

Run facts (each task's id, status, attempts and last error — the diff does not show these):
${facts?.trim() || '(none provided)'}

Changes:
${diff}

Return markdown with EXACTLY these six headings, in this order, and no other headings:
### What worked
### What review caught
### Codebase facts
### Planning advice
### Escalations applied
### Unverified claims

Rules:
- Under each heading write at most 4 bullets, each starting with "- ".
- If a section has nothing to say, write the single word none under that heading.
- "What review caught" and "Escalations applied" must come from the run facts above; do not invent reviews or escalations the facts do not show.
- Describe only what the diff and facts show. No generic advice.
`;
    try {
      return (await this.textModel.complete(prompt, { timeoutMs: 60000 })).trim();
    } catch {
      return '';
    }
  }
}
