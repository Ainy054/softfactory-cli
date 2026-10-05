import fs from 'node:fs/promises';
import path from 'node:path';
import type { FactoryState } from './types.js';

export interface RunMetrics {
  run_id: string;
  date: string;
  feature: string;
  status: string;
  schema_version: number;
  tasks: number;
  done: number;
  manual: number;
  protected: number;
  first_attempt_pass: number;
  first_attempt_rate: number;
  rejected_by_category: Record<string, number>;
  models: Record<string, number>;
  inspections: Record<string, number>;
}

const METRICS_FILE = path.join('.softfactory', 'metrics.jsonl');
const ATTEMPTS_FILE = path.join('.softfactory', 'attempts.jsonl');

/**
 * One machine-readable line per finished run. The prose log is for people;
 * this is what the next plan reads, so a failure category that keeps coming
 * back is seen by the planner rather than rediscovered by the next worker.
 */
export async function computeRunMetrics(baseDir: string, state: FactoryState): Promise<RunMetrics> {
  const taskIds = new Set(state.tasks.map(t => t.id));
  const since = Date.parse(state.created_at) || 0;
  const categories: Record<string, number> = {};
  try {
    const rows = (await fs.readFile(path.join(baseDir, ATTEMPTS_FILE), 'utf8')).split('\n').filter(Boolean);
    for (const row of rows) {
      try {
        const entry = JSON.parse(row);
        if (!taskIds.has(entry.task_id) || (Date.parse(entry.timestamp) || 0) < since) continue;
        if (!entry.category || entry.category.startsWith('environment')) continue;
        categories[entry.category] = (categories[entry.category] || 0) + 1;
      } catch { /* a malformed journal line is not a reason to lose the run's metrics */ }
    }
  } catch { /* no journal yet */ }

  const models: Record<string, number> = {};
  const inspections: Record<string, number> = {};
  for (const task of state.tasks) {
    if (task.model) models[task.model] = (models[task.model] || 0) + 1;
    if (task.inspection) inspections[task.inspection] = (inspections[task.inspection] || 0) + 1;
  }
  const agentTasks = state.tasks.filter(t => t.executor === 'agent');
  const done = state.tasks.filter(t => t.status === 'done');
  const firstAttemptPass = agentTasks.filter(t => t.status === 'done' && t.attempts === 0 && t.error_history.length === 0).length;
  return {
    run_id: state.feature_id,
    date: new Date().toISOString().slice(0, 10),
    feature: state.feature,
    status: state.status,
    schema_version: state.schema_version,
    tasks: state.tasks.length,
    done: done.length,
    manual: state.tasks.filter(t => t.executor !== 'agent').length,
    protected: state.tasks.filter(t => t.protected).length,
    first_attempt_pass: firstAttemptPass,
    first_attempt_rate: agentTasks.length ? Number((firstAttemptPass / agentTasks.length).toFixed(2)) : 0,
    rejected_by_category: categories,
    models,
    inspections,
  };
}

export async function appendRunMetrics(baseDir: string, metrics: RunMetrics): Promise<void> {
  await fs.mkdir(path.join(baseDir, '.softfactory'), { recursive: true });
  await fs.appendFile(path.join(baseDir, METRICS_FILE), `${JSON.stringify(metrics)}\n`, 'utf8');
}

export async function readRecentMetrics(baseDir: string, limit = 5): Promise<RunMetrics[]> {
  try {
    const rows = (await fs.readFile(path.join(baseDir, METRICS_FILE), 'utf8')).split('\n').filter(Boolean);
    return rows.slice(-limit).map(row => { try { return JSON.parse(row); } catch { return null; } }).filter(Boolean) as RunMetrics[];
  } catch {
    return [];
  }
}

/**
 * Failure categories seen in at least two of the last three runs. The plan
 * must change its approach for these; a stronger model alone is not a change.
 */
export function recurringFailures(recent: RunMetrics[], window = 3, threshold = 2): string[] {
  const last = recent.slice(-window);
  const seenIn = new Map<string, number>();
  for (const run of last) {
    for (const category of Object.keys(run.rejected_by_category || {})) {
      seenIn.set(category, (seenIn.get(category) || 0) + 1);
    }
  }
  return [...seenIn.entries()].filter(([, count]) => count >= threshold).map(([category]) => category).sort();
}
