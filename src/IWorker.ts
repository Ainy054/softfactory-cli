import { Task, Handoff } from './types.js';
import type { Environment } from './Environment.js';
import type { SandboxManager } from './Sandbox.js';

export interface WorkerOptions {
  onOutput?: (line: string) => void;
  streamToTerminal?: boolean;
  projectContext?: string;
  memoryPatterns?: string[];
  model?: string;
  diagnosticsDir?: string;
  /** Where the worker's run_command calls execute; host allowlist only when absent. */
  sandbox?: SandboxManager;
  /** Aborted when the attempt's wall-clock budget is spent; the worker stops at its next step. */
  signal?: AbortSignal;
  /** Token counts per model turn, when the backend reports them. */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  /**
   * The user's requirement, verbatim. The planner's task description is a
   * paraphrase; the first dogfood run lost the sample data the requirement
   * carried, and the worker went searching the repository for it.
   */
  requirement?: string;
  /**
   * A spec, value table or rename map shared by every task in this run,
   * written once so each task's description carries only its delta.
   */
  brief?: string;
  /** Globs of files only the orchestrator edits (environment.json); changes to them travel as the handoff's wiring_patch. */
  orchestratorFiles?: string[];
  /**
   * From the second attempt: exact signatures of the task's files and what
   * not to do again. Softhouse: a retry is a different prompt, not only a
   * bigger model; one that differs only in feedback repeats the failure.
   */
  retryBrief?: string;
  /**
   * Receives the full assembled worker prompt, called exactly once per execute
   * attempt before the backend runs. Softhouse saves it so a retry can be
   * compared with the attempt before it and a rerun is reproducible.
   */
  onPrompt?: (prompt: string) => void;
  /**
   * The safety block every worker prompt must carry as its very first text,
   * built once per run from environment.json. See safetyPreamble.
   */
  preamble?: string;
}

/**
 * The safety block every worker prompt starts with. It is assembled from the
 * run's environment.json facts, but is a pure function of `env`, so two calls
 * with the same environment produce byte-identical text. Workers cannot run
 * deploy scripts, reach the live stack, or edit the orchestrator's files, and
 * each attempt must affirm that the live stack was left untouched.
 */
/**
 * The safety block ends by asking the worker to affirm "live stack untouched".
 * Only a line that is exactly that phrase counts: an agent's output can echo
 * its prompt, which contains the phrase inside the request itself.
 */
export function affirmsLiveStackUntouched(output: string | undefined): boolean {
  return String(output ?? '').split('\n').some(line => /^["'`*\s]*live stack untouched[."'`*\s]*$/i.test(line));
}

export function safetyPreamble(env: Environment | undefined): string {
  const bullets: string[] = [];
  bullets.push(env
    ? `- Live system (never touch it; work only in your isolated worktree): ${env.live}`
    : `- No environment.json: assume a live system may exist and touch nothing outside your worktree.`);
  const deploys: string[] = [];
  if (env?.test_env?.deploy) deploys.push(`${env.test_env.name || 'TEST'} deploy "${env.test_env.deploy}"`);
  if (env?.production?.deploy) deploys.push(`production deploy "${env.production.deploy}"`);
  bullets.push(deploys.length
    ? `- Never run deploy scripts (${deploys.join(', ')}), never ssh, and never touch .env or secrets.`
    : `- Never run deploy scripts, never ssh, and never touch .env or secrets.`);
  bullets.push(`- Do not run \`docker compose up/down/build/restart\`; the orchestrator owns the stacks.`);
  bullets.push(`- You are in an isolated worktree; never run git against another checkout.`);
  if (env?.orchestrator_files?.length) {
    bullets.push(`- Files only the orchestrator edits (never edit these; send the change as the handoff's wiring_patch): ${env.orchestrator_files.join(', ')}`);
  }
  bullets.push(`- When you finish, affirm "live stack untouched": set finish_task's live_stack_untouched, or end your final message with that phrase alone on its own line.`);
  return `CRITICAL SAFETY:\n${bullets.join('\n')}\n`;
}

/**
 * A backend that refused to work for reasons outside the task: a spent usage
 * limit, a rate limit, a billing stop. Codex answered "You've hit your usage
 * limit" four times in a row and each one was charged to the task as a crash.
 * Returns the line that says so, or null.
 */
export function backendRefusal(text: string): string | null {
  const pattern = /usage limit|rate[ _-]?limit|too many requests|(?:status|http|code|error)\D{0,12}\b(?:429|529)\b|insufficient[ _]quota|quota (?:exceeded|exhausted)|out of credits|purchase more credits|billing (?:hard )?limit|overloaded_error/i;
  const line = String(text || '').split('\n').find(l => pattern.test(l));
  return line ? line.trim().slice(0, 200) : null;
}

/**
 * Split acceptance (Softhouse): a check that needs the running stack is
 * written "orchestrator: <command>". Workers cannot run it and the per-task
 * gate skips it; the orchestrator runs it on the host after merge, with UAT.
 */
export function isDeferredAcceptance(command: string | undefined): boolean {
  return /^\s*orchestrator:/i.test(command || '');
}
export function deferredCommand(command: string): string {
  return command.replace(/^\s*orchestrator:\s*/i, '').trim();
}

/** The acceptance line every worker prompt carries. */
export function acceptanceLine(command: string | undefined): string {
  if (!command) return '';
  return isDeferredAcceptance(command)
    ? `Live check (the orchestrator runs this against the running system after merge; you cannot run it, so make sure your change satisfies it): ${deferredCommand(command)}`
    : `Acceptance command (run verbatim by the orchestrator after you finish; make it pass): ${command}`;
}

/** The shared brief, spec, out-of-scope and notes block every worker prompt carries, when present. */
export function briefSection(task: Pick<Task, 'spec' | 'out_of_scope' | 'notes_to_executor'>, brief?: string): string {
  let section = '';
  const shared = brief?.trim();
  if (shared) section += `\nRUN BRIEF (shared by every task in this run):\n${shared}\n`;
  if (task.spec) section += `\nSpec: ${task.spec}\n`;
  if (task.out_of_scope?.length) section += `\nOut of scope (do not touch):\n${task.out_of_scope.map(o => `- ${o}`).join('\n')}\n`;
  if (task.notes_to_executor?.length) section += `\nNotes from the planner:\n${task.notes_to_executor.map(n => `- ${n}`).join('\n')}\n`;
  return section;
}

/**
 * Wire before review, borrowed from Softhouse: bootstrap, route registration
 * and compose files belong to the orchestrator. A worker that needs a change
 * there sends it as a unified diff, which is applied on its branch and built
 * before review.
 */
export function wiringSection(files: string[] | undefined): string {
  if (!files?.length) return '';
  return `\nORCHESTRATOR-OWNED FILES (never edit these; put the exact change in the handoff's wiring_patch as one unified diff, paths relative to the repository root, --- a/<path> and +++ b/<path>; it is applied on your branch before review):\n${files.map(f => `- ${f}`).join('\n')}\n`;
}

/** The requirement block every worker prompt carries, bounded so it cannot crowd out the task. */
export function requirementSection(requirement: string | undefined, limit = 6000): string {
  const text = requirement?.trim();
  if (!text) return '';
  const shown = text.length > limit ? `${text.slice(0, limit)}\n…(truncated; the task description above carries the rest)` : text;
  return `\nFEATURE REQUIREMENT (verbatim from the user; this task is one part of it, and any sample data, formats or exact names in it are authoritative):\n${shown}\n`;
}

export interface IWorker {
  id: string;
  name: string;
  isAvailable(model?: string): Promise<boolean>;
  execute(task: Task, worktreePath: string, options?: WorkerOptions): Promise<Handoff>;
}

/**
 * Raised when the worker's backend is unreachable (daemon down, network gone).
 * This is an environment fault, not a task fault: it must never consume a
 * task's retry budget, because no work was attempted.
 */
export class WorkerEnvironmentError extends Error {
  readonly isEnvironmentFailure = true;
  constructor(message: string) {
    super(message);
    this.name = 'WorkerEnvironmentError';
  }
}

export function isEnvironmentFailure(error: unknown): boolean {
  return Boolean(error && (error as any).isEnvironmentFailure === true);
}
