import { Task, Handoff } from './types.js';
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
