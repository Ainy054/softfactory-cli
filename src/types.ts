import { z } from 'zod';

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  agent_role: z.enum(['coder', 'test_writer', 'docs', 'devops', 'architect', 'builder']),
  phase: z.number(),
  dependencies: z.array(z.string()).default([]),
  blockedBy: z.array(z.string()).default([]),
  files_hint: z.array(z.string()).default([]),
  status: z.enum(['pending', 'active', 'done', 'failed', 'rejected']).default('pending'),
  worktree_branch: z.string().optional(),
  attempts: z.number().default(0),
  last_feedback: z.string().optional(),
});

export type Task = z.infer<typeof TaskSchema>;

export const FactoryStateSchema = z.object({
  feature: z.string(),
  status: z.enum(['planning', 'active', 'completed', 'failed']),
  created_at: z.string(),
  last_updated: z.string(),
  tasks: z.array(TaskSchema),
  memory_patterns: z.array(z.string()).default([]),
});

export type FactoryState = z.infer<typeof FactoryStateSchema>;

export const HandoffSchema = z.object({
  task_id: z.string(),
  status: z.enum(['success', 'failure']),
  files_changed: z.array(z.string()),
  test_summary: z.string().optional(),
  unresolved_issues: z.string().optional(),
  summary: z.string(),
});

export type Handoff = z.infer<typeof HandoffSchema>;

export interface TaskResult {
  task: Task;
  branchName: string;
}

export type FactoryEvent =
  | { type: 'task:start'; task: Task }
  | { type: 'task:done'; task: Task }
  | { type: 'task:fail'; task: Task; feedback?: string }
  | { type: 'state:update'; state: FactoryState }
  | { type: 'worker:output'; taskId: string; line: string }
  | { type: 'phase:start'; phase: number }
  | { type: 'build:complete'; status: 'completed' | 'failed'; feature: string };
