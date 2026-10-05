import { Task } from './types.js';
import { WorkerEnvironmentError } from './IWorker.js';
import { extractJson } from './extractJson.js';
import type { ITextModel } from './TextModel.js';

export interface InspectionResult {
  verdict: 'PASS' | 'FAIL';
  feedback: string;
  provider: string;
  model: string;
}

export interface Epiphany {
  should_save: boolean;
  lesson: string;
  tags?: string[];
  scope?: 'project' | 'language' | 'path';
  confidence?: number;
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

  async inspect(task: Task, diff: string, handoffSummary: string, verifierOutput?: string): Promise<InspectionResult> {
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

Verdict Rules:
1. Does the code fulfill the task requirements and acceptance criteria?
2. Are there obvious bugs, syntax errors, or architectural violations?
3. If the task role is "test_writer" (TDD): It is EXPECTED and NORMAL for newly written test assertions to fail against not-yet-implemented business logic. You must NOT fail a "test_writer" task simply because the tests fail against unimplemented code, as long as the test code compiles and validly tests the required behavior.
4. For implementation roles ("coder", etc.): Ensure automated tests compile and pass.

CRITICAL: Return ONLY a valid JSON object:
{
  "verdict": "PASS" | "FAIL",
  "feedback": "Concise explanation of your decision"
}
`;
    let raw: string;
    try {
      raw = await this.textModel.complete(prompt, { timeoutMs: 120000, json: true });
    } catch (error: any) {
      // The inspector is a merge gate. Nothing may pass because the reviewer
      // was unavailable, and nothing else may review in its place.
      throw new WorkerEnvironmentError(`Quality inspector (${this.provider}/${this.model}) is unavailable: ${error?.message || 'inference failed'}. No diff was reviewed, so nothing was merged.`);
    }
    try {
      const parsed = extractJson(raw);
      return {
        verdict: parsed.verdict?.toUpperCase() === 'PASS' ? 'PASS' : 'FAIL',
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

CRITICAL: Return ONLY a valid JSON object:
{
  "verdict": "PASS" | "FAIL",
  "feedback": "findings first (severity, location, what is wrong, the fix), then Checked: ..."
}
`;
    let raw: string;
    try {
      raw = await this.textModel.complete(prompt, { timeoutMs: 240000, json: true });
    } catch (error: any) {
      throw new WorkerEnvironmentError(`Independent reviewer (${this.provider}/${this.model}) is unavailable: ${error?.message || 'inference failed'}. No protected diff was reviewed, so nothing was merged.`);
    }
    try {
      const parsed = extractJson(raw);
      return {
        verdict: parsed.verdict?.toUpperCase() === 'PASS' ? 'PASS' : 'FAIL',
        feedback: parsed.feedback || 'No feedback provided.',
        provider: this.provider,
        model: this.model,
      };
    } catch {
      return { verdict: 'FAIL', feedback: `Independent reviewer returned unreadable output. Raw: ${raw.slice(0, 300)}`, provider: this.provider, model: this.model };
    }
  }

  async synthesizeEpiphany(task: Task, diff: string): Promise<Epiphany | null> {
    const prompt = `Extract one specific, reusable project lesson from this successfully repaired task. Return only JSON: {"should_save":boolean,"lesson":string,"tags":string[],"scope":"project"|"language"|"path","confidence":number}. Reject generic advice.\nTask: ${task.description}\nFailures: ${(task.error_history || []).join('\n')}\nFinal diff: ${diff.slice(0, 6000)}`;
    try {
      return extractJson<Epiphany>(await this.textModel.complete(prompt, { timeoutMs: 60000, json: true }));
    } catch {
      return null;
    }
  }

  /** Empty string when the model cannot be reached; the caller skips the write. */
  async synthesizeMemory(feature: string, diff: string): Promise<string> {
    const prompt = `
You are the SoftFactory Memory Synthesizer.
A feature has been successfully built. Extract the key architectural patterns and decisions worth remembering for future builds.

Feature: ${feature}

Changes:
${diff}

Extract and return a concise markdown summary covering:
- Key architectural decisions made (tech stack choices, patterns used)
- Important file paths and their purposes
- Conventions established (naming, structure, testing approach)
- Integration points that future features should be aware of

Keep it under 20 lines. Focus on what would help a future Architect plan the NEXT feature.
Do NOT include generic advice — only project-specific patterns. Describe only what the diff shows.
`;
    try {
      return (await this.textModel.complete(prompt, { timeoutMs: 60000 })).trim();
    } catch {
      return '';
    }
  }
}
