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
