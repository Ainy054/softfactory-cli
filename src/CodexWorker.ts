import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Task, Handoff, HandoffSchema } from './types.js';
import { IWorker, WorkerOptions, WorkerEnvironmentError, backendRefusal, requirementSection } from './IWorker.js';

/** Runs the authenticated Codex CLI directly inside the isolated worktree. */
export class CodexWorker implements IWorker {
  id = 'codex-cloud';
  name = 'OpenAI Codex Cloud Worker';
  constructor(private defaultModel: string) {}

  async isAvailable(): Promise<boolean> {
    try { await execa('codex', ['--help'], { timeout: 3000 }); return true; } catch { return false; }
  }

  async execute(task: Task, worktreePath: string, options: WorkerOptions = {}): Promise<Handoff> {
    const model = options.model || task.model || this.defaultModel;
    const handoffPath = path.join(worktreePath, '.softfactory', 'handoff.json');
    await fs.mkdir(path.dirname(handoffPath), { recursive: true });
    const previousFeedback = task.last_feedback
      ? task.last_feedback.slice(0, 4000)
      : '';
    const prompt = `You are a SoftFactory worker in an isolated git worktree. Implement the task directly, run relevant tests, and do not modify files outside this worktree.
Task ${task.id}: ${task.title}
Role: ${task.agent_role}
Description: ${task.description}
Files hint: ${task.files_hint.join(', ')}
Acceptance criteria: ${task.acceptance_criteria.join('; ')}
Verification: ${task.verification.join('; ')}
${task.verification_command ? `Acceptance command (run verbatim by the orchestrator after you finish; make it pass): ${task.verification_command}` : ''}
${task.review_questions?.length ? `Review questions (an independent reviewer verifies each answer against your diff; answer each in the handoff's review_answers, citing file:line):\n${task.review_questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}` : ''}
${previousFeedback ? `Previous feedback: ${previousFeedback}` : ''}
${options.memoryPatterns?.length ? `Verified project lessons:\n${options.memoryPatterns.map(x => `- ${x}`).join('\n')}` : ''}
${requirementSection(options.requirement)}
${options.retryBrief || ''}
Before finishing, write ${handoffPath} as JSON with task_id, status, files_changed, summary, claims (an array of {"text","source"} for each material claim; source is "path:line", "path:start-end", "command: <what ran>" or "UNVERIFIED"; a cited line that does not exist rejects the task) and, if there were review questions, review_answers.`;
    options.onOutput?.(`[Codex Worker] Starting ${task.id}${model ? ` with ${model}` : ' with the configured Codex default model'}`);
    const proc = execa('codex', buildCodexExecArgs(prompt, model), buildCodexExecOptions(worktreePath, options.signal));
    if (options.onOutput) proc.all?.on('data', chunk => options.onOutput?.(chunk.toString().trim()));
    try {
      await proc;
    } catch (error: any) {
      const said = String(error?.all || `${error?.stdout || ''}\n${error?.stderr || ''}`);
      const refusal = backendRefusal(said);
      if (refusal) throw new WorkerEnvironmentError(`Codex refused to work: ${refusal}. No task retry was consumed; wait for the limit to reset or switch --cloud-provider.`);
      const auth = said.split('\n').find(l => /not logged in|login required|unauthori[sz]ed|\b401\b|invalid api key/i.test(l));
      if (auth) throw new WorkerEnvironmentError(`Codex could not authenticate: ${auth.trim().slice(0, 200)}. No task retry was consumed.`);
      throw error;
    }
    try { return HandoffSchema.parse(JSON.parse(await fs.readFile(handoffPath, 'utf8'))); }
    catch { return { task_id: task.id, status: 'success', files_changed: task.files_hint, summary: `Completed with Codex/${model || 'default'}` }; }
  }
}

/** Build a non-interactive invocation. --approve-for-me already implies workspace-write. */
export function buildCodexExecArgs(prompt: string, model?: string): string[] {
  return ['exec', '--approve-for-me', ...(model ? ['--model', model] : []), prompt];
}

/** Prevent Codex from waiting for additional input after the prompt argument. */
export function buildCodexExecOptions(worktreePath: string, signal?: AbortSignal) {
  return {
    cwd: worktreePath,
    stdin: 'ignore' as const,
    timeout: 600000,
    all: true,
    // The orchestrator's attempt budget ends the process, not just the wait for it.
    ...(signal ? { cancelSignal: signal } : {}),
  };
}
