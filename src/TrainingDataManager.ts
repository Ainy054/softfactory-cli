import fs from 'node:fs/promises';
import path from 'node:path';
import type { Task } from './types.js';
import { redactSecrets } from './redact.js';

export interface TrainingCandidateInput {
  task: Pick<Task, 'id' | 'title' | 'description' | 'agent_role' | 'files_hint' | 'attempts' | 'model' | 'provider' | 'error_history'>;
  diff: string;
  verification: string;
  resolution: string;
}

export interface TrainingCandidate {
  version: 1; timestamp: string; task_id: string; title: string; description: string;
  agent_role: Task['agent_role']; files_hint: string[]; attempts: number; model?: string;
  provider?: string; repaired: boolean; failures: string[]; verification: string;
  resolution: string; diff: string;
}

export interface FailureLessonInput {
  task: Pick<Task, 'id' | 'title' | 'description' | 'agent_role' | 'files_hint' | 'attempts' | 'model' | 'provider' | 'error_history'>;
  category: string;
  detail: string;
}

export interface FailureLesson {
  version: 1; timestamp: string; kind: 'failure_lesson'; task_id: string;
  title: string; description: string; agent_role: Task['agent_role']; files_hint: string[];
  attempt: number; model?: string; provider?: string; category: string;
  error: string; prior_failures: string[];
}

export function redactTrainingText(value: string, limit = 40000): string {
  return redactSecrets(value).slice(0, limit);
}

/** Stores only verified, sanitized examples; raw attempts remain diagnostics. */
export class TrainingDataManager {
  private readonly file: string;
  private readonly failureFile: string;
  constructor(baseDir: string) {
    this.file = path.join(baseDir, '.softfactory', 'training-candidates.jsonl');
    this.failureFile = path.join(baseDir, '.softfactory', 'training-failure-lessons.jsonl');
  }

  async addVerified(input: TrainingCandidateInput): Promise<boolean> {
    if (!input.diff.trim() || !input.verification.trim()) return false;
    const candidate: TrainingCandidate = {
      version: 1, timestamp: new Date().toISOString(), task_id: redactTrainingText(input.task.id, 200),
      title: redactTrainingText(input.task.title, 500), description: redactTrainingText(input.task.description, 2000),
      agent_role: input.task.agent_role, files_hint: input.task.files_hint.slice(0, 100).map(file => redactTrainingText(file, 300)),
      attempts: input.task.attempts, model: input.task.model, provider: input.task.provider,
      repaired: input.task.error_history.length > 0, failures: input.task.error_history.slice(-5).map(error => redactTrainingText(error, 1000)),
      verification: redactTrainingText(input.verification, 2000), resolution: redactTrainingText(input.resolution, 2000), diff: redactTrainingText(input.diff),
    };
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, `${JSON.stringify(candidate)}\n`, 'utf8');
      return true;
    } catch { return false; }
  }

  /** Stores sanitized failures separately as rejected examples/lessons. */
  async addFailureLesson(input: FailureLessonInput): Promise<boolean> {
    if (!input.category.trim() || !input.detail.trim()) return false;
    const lesson: FailureLesson = {
      version: 1, timestamp: new Date().toISOString(), kind: 'failure_lesson',
      task_id: redactTrainingText(input.task.id, 200), title: redactTrainingText(input.task.title, 500),
      description: redactTrainingText(input.task.description, 2000), agent_role: input.task.agent_role,
      files_hint: input.task.files_hint.slice(0, 100).map(file => redactTrainingText(file, 300)),
      attempt: input.task.attempts, model: input.task.model, provider: input.task.provider,
      category: redactTrainingText(input.category, 200), error: redactTrainingText(input.detail, 4000),
      prior_failures: input.task.error_history.slice(-5).map(error => redactTrainingText(error, 1000)),
    };
    try {
      await fs.mkdir(path.dirname(this.failureFile), { recursive: true });
      await fs.appendFile(this.failureFile, `${JSON.stringify(lesson)}\n`, 'utf8');
      return true;
    } catch { return false; }
  }
}
