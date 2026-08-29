import { Task, Handoff } from './types.js';

export interface WorkerOptions {
  onOutput?: (line: string) => void;
  streamToTerminal?: boolean;
  projectContext?: string;
  memoryPatterns?: string[];
  model?: string;
  diagnosticsDir?: string;
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
