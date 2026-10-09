import fs from 'node:fs/promises';
import path from 'node:path';
import type { FactoryState } from './types.js';

/** Where a run's coverage moved between the base branch and the built head. */
export interface CoverageMetrics {
  before: number;
  after: number;
}

/**
 * What an injectable shell runner may hand back. A string is the command's
 * output; an object may carry the output plus its exit status. Anything else
 * (a throw, a non-zero status, no output) counts as a failed measurement.
 */
export type CoverageRunResult =
  | string
  | {
    stdout?: string;
    output?: string;
    code?: number;
    exitCode?: number;
    status?: number;
    ok?: boolean;
  }
  | null
  | undefined;

export type CoverageRunner = (command: string, cwd: string) => CoverageRunResult | Promise<CoverageRunResult>;

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
  tokens: { input: number; output: number };
  /** The same tokens split by the model that spent them, when backends reported them. */
  tokens_by_model?: Record<string, { input: number; output: number }>;
  /** Total tokens per agent task finished in this run, rounded; 0 when none finished. */
  tokens_per_done_task?: number;
  /** One mechanical review fix per task is allowed without charging an attempt. */
  micro_fixes?: number;
  /** Attempts rescued by the recovery ladder instead of being replanned. */
  recovered_workers?: number;
  /** Live UAT against the merged code: passed, failed, skipped (--no-uat), or none when no UAT is defined. */
  uat?: 'passed' | 'failed' | 'skipped' | 'none';
  /** Coverage before and after the build, when the project configures a coverageCommand. */
  coverage?: CoverageMetrics;
}

const METRICS_FILE = path.join('.softfactory', 'metrics.jsonl');
const ATTEMPTS_FILE = path.join('.softfactory', 'attempts.jsonl');

/**
 * One machine-readable line per finished run. The prose log is for people;
 * this is what the next plan reads, so a failure category that keeps coming
 * back is seen by the planner rather than rediscovered by the next worker.
 */
export async function computeRunMetrics(
  baseDir: string,
  state: FactoryState,
  coverage?: CoverageMetrics | { coverage?: CoverageMetrics },
): Promise<RunMetrics> {
  const taskIds = new Set(state.tasks.map(t => t.id));
  const since = Date.parse(state.created_at) || 0;
  const categories: Record<string, number> = {};
  let microFixes = 0;
  let recoveredWorkers = 0;
  try {
    const rows = (await fs.readFile(path.join(baseDir, ATTEMPTS_FILE), 'utf8')).split('\n').filter(Boolean);
    for (const row of rows) {
      try {
        const entry = JSON.parse(row);
        if (!taskIds.has(entry.task_id) || (Date.parse(entry.timestamp) || 0) < since) continue;
        // Counted before the environment filter: a micro-fix is review working
        // as intended and a recovered worker was rescued, not replanned, so
        // neither may disappear behind a category filter.
        if (entry.category === 'micro_fix') microFixes++;
        else if (entry.category === 'recovered_worker') recoveredWorkers++;
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
  const doneAgentTasks = agentTasks.filter(t => t.status === 'done').length;
  const firstAttemptPass = agentTasks.filter(t => t.status === 'done' && t.attempts === 0 && t.error_history.length === 0).length;
  /* A state written before per-model usage existed has only the totals; a state
   * built by hand may carry only the per-model split. Either is a total. */
  const totalTokens = state.usage
    ? (state.usage.input_tokens || 0) + (state.usage.output_tokens || 0)
    : Object.values(state.usage_by_model || {}).reduce((sum, usage) => sum + (usage.input || 0) + (usage.output || 0), 0);

  const metrics: RunMetrics = {
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
    tokens: { input: state.usage?.input_tokens || 0, output: state.usage?.output_tokens || 0 },
    tokens_per_done_task: doneAgentTasks ? Math.round(totalTokens / doneAgentTasks) : 0,
    micro_fixes: microFixes,
    recovered_workers: recoveredWorkers,
  };
  if (state.usage_by_model) {
    metrics.tokens_by_model = Object.fromEntries(
      Object.entries(state.usage_by_model).map(([model, usage]) => [model, { input: usage.input || 0, output: usage.output || 0 }]),
    );
  }
  if (state.uat_result) metrics.uat = state.uat_result;
  const measured = resolveCoverage(coverage);
  if (measured) metrics.coverage = measured;
  return metrics;
}

/**
 * Accepts either the coverage pair directly or as `{ coverage }`, so callers
 * that thread an options object do not have to unwrap it themselves.
 */
function resolveCoverage(coverage?: CoverageMetrics | { coverage?: CoverageMetrics }): CoverageMetrics | undefined {
  if (!coverage) return undefined;
  const candidate: unknown = 'before' in coverage || 'after' in coverage ? coverage : (coverage as { coverage?: CoverageMetrics }).coverage;
  if (!candidate || typeof (candidate as CoverageMetrics).before !== 'number' || typeof (candidate as CoverageMetrics).after !== 'number') return undefined;
  const { before, after } = candidate as CoverageMetrics;
  return { before, after };
}

/**
 * Runs a project's coverage command through an injectable shell runner and
 * reports the last percentage in its output (`Lines: 81.5%` -> 81.5). A failed
 * run, or output without a percentage, is `undefined` so the caller leaves the
 * field out rather than recording a made-up number.
 */
export async function measureCoverage(cwd: string, command: string, run: CoverageRunner): Promise<number | undefined> {
  let result: CoverageRunResult;
  try {
    result = await run(command, cwd);
  } catch {
    return undefined;
  }
  let output: string | undefined;
  if (typeof result === 'string') {
    output = result;
  } else if (result && typeof result === 'object') {
    const code = typeof result.code === 'number'
      ? result.code
      : typeof result.exitCode === 'number' ? result.exitCode : typeof result.status === 'number' ? result.status : 0;
    if (result.ok === false || code !== 0) return undefined;
    output = typeof result.stdout === 'string' ? result.stdout : typeof result.output === 'string' ? result.output : '';
  }
  if (!output) return undefined;

  const pattern = /(\d+(?:\.\d+)?)%/g;
  let last: string | undefined;
  for (let match = pattern.exec(output); match !== null; match = pattern.exec(output)) last = match[1];
  if (last === undefined) return undefined;
  const value = Number(last);
  return Number.isFinite(value) ? value : undefined;
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
const NOT_ESCALATED = new Set(['micro_fix']);

export function recurringFailures(recent: RunMetrics[], window = 3, threshold = 2): string[] {
  const last = recent.slice(-window);
  const seenIn = new Map<string, number>();
  for (const run of last) {
    for (const category of Object.keys(run.rejected_by_category || {})) {
      // A micro-fix is review working as intended, not a failure to plan around
      // (Softhouse excludes review-caught-defect from its escalation rule).
      if (NOT_ESCALATED.has(category)) continue;
      seenIn.set(category, (seenIn.get(category) || 0) + 1);
    }
  }
  return [...seenIn.entries()].filter(([, count]) => count >= threshold).map(([category]) => category).sort();
}
