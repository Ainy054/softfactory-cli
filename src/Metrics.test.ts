import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { appendRunMetrics, computeRunMetrics, readRecentMetrics, recurringFailures, type RunMetrics } from './Metrics.js';
import { TextModelPlanner } from './Planner.js';
import { CURRENT_SCHEMA_VERSION, type Task } from './types.js';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: 't', description: 'd', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
    files_hint: [], creates_files: [], acceptance_criteria: [], verification: [], status: 'done',
    attempts: 0, escalation_level: 0, error_history: [], worker_type: 'auto', executor: 'agent',
    protected: false, review_questions: [], production_targets: [], test_targets: [], behavior_tags: [],
    ...over,
  } as Task;
}

const run = (over: Partial<RunMetrics>): RunMetrics => ({
  run_id: 'r', date: '2026-10-05', feature: 'f', status: 'completed', schema_version: 2, tasks: 1, done: 1, manual: 0,
  protected: 0, first_attempt_pass: 1, first_attempt_rate: 1, rejected_by_category: {}, models: {}, inspections: {}, ...over,
});

describe('one metrics line per run, computed from the journals', () => {
  it('counts rejections by category for this run only, and the first-attempt rate over agent tasks', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-metrics-'));
    await fs.mkdir(path.join(baseDir, '.softfactory'));
    const created = new Date(Date.now() - 60_000).toISOString();
    const row = (task_id: string, category: string, timestamp = new Date().toISOString()) => JSON.stringify({ timestamp, task_id, category, detail: '' });
    await fs.writeFile(path.join(baseDir, '.softfactory', 'attempts.jsonl'), [
      row('T1', 'verification'), row('T1', 'verification'), row('T1', 'regression'),
      row('T1', 'environment_unavailable'),                                   // not the task's fault
      row('T9', 'verification'),                                              // a task from another feature
      row('T2', 'verification', new Date(Date.now() - 3_600_000).toISOString()), // before this run started
    ].join('\n') + '\n');
    const state: any = {
      schema_version: CURRENT_SCHEMA_VERSION, feature_id: 'f-1', feature: 'metrics', status: 'completed', created_at: created,
      tasks: [
        task({ id: 'T1', attempts: 3, error_history: ['a', 'b', 'c'], model: 'qwen', inspection: 'model' }),
        task({ id: 'T2', model: 'qwen', inspection: 'mechanical-only' }),
        task({ id: 'T3', executor: 'user' }),
        task({ id: 'T4', protected: true, inspection: 'blind-review', model: 'pro' }),
      ],
    };
    const metrics = await computeRunMetrics(baseDir, state);
    assert.deepEqual(metrics.rejected_by_category, { verification: 2, regression: 1 });
    assert.equal(metrics.first_attempt_pass, 2, 'T2 and T4');
    assert.equal(metrics.first_attempt_rate, 0.67, 'over the three agent tasks');
    assert.equal(metrics.manual, 1);
    assert.equal(metrics.protected, 1);
    assert.deepEqual(metrics.inspections, { model: 1, 'mechanical-only': 1, 'blind-review': 1 });
    assert.deepEqual(metrics.models, { qwen: 2, pro: 1 });

    await appendRunMetrics(baseDir, metrics);
    await appendRunMetrics(baseDir, { ...metrics, run_id: 'f-2' });
    const recent = await readRecentMetrics(baseDir, 5);
    assert.deepEqual(recent.map(r => r.run_id), ['f-1', 'f-2']);
  });

  it('records the live-check verdict: false when a completed run had no UAT, true when it passed', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-metrics-'));
    const state = (verified?: boolean) => ({
      schema_version: CURRENT_SCHEMA_VERSION, feature_id: 'f-1', feature: 'metrics', status: 'completed',
      created_at: new Date().toISOString(), tasks: [task({ id: 'T1' })],
      uat_result: 'none',
      ...(verified === undefined ? {} : { verified }),
    }) as any;

    const none = await computeRunMetrics(baseDir, state(false));
    assert.equal(none.verified, false);
    assert.equal(typeof none.verified, 'boolean');

    const passed = await computeRunMetrics(baseDir, state(true));
    assert.equal(passed.verified, true);

    const unknown = await computeRunMetrics(baseDir, state());
    assert.equal(unknown.verified, undefined, 'an older state without the field records no verdict');
  });
});

describe('a failure category that keeps coming back is escalated to the planner', () => {
  it('fires on 2 of the last 3 runs, not on an older streak', () => {
    const recent = [
      run({ rejected_by_category: { regression: 2 } }),       // too old to count
      run({ rejected_by_category: { verification: 1 } }),
      run({ rejected_by_category: { verification: 2, missing_declared_files: 1 } }),
      run({ rejected_by_category: { acceptance: 1 } }),
    ];
    assert.deepEqual(recurringFailures(recent), ['verification']);
    assert.deepEqual(recurringFailures([run({ rejected_by_category: { acceptance: 1 } })]), []);
  });

  it('puts the escalation in the planning prompt', async () => {
    const prompts: string[] = [];
    const good = JSON.stringify({ feature: 'A feature', requirements_covered: [], tasks: [{
      id: 'T1', title: 'Do it', description: 'Do the thing described', agent_role: 'coder', phase: 1,
      files_hint: ['a.ts'], acceptance_criteria: ['it works'], verification: ['npm test'],
    }] });
    const planner = new TextModelPlanner('local', { provider: 'local', model: 'm', isAvailable: async () => true, complete: async (p: string) => { prompts.push(p); return good; } });
    const input: any = { requirement: 'x', codebaseContext: '', memoryPatterns: '', featureHistory: '', repositoryFiles: new Set(['a.ts']) };
    await planner.generateBlueprint({ ...input, recurringFailures: ['verification', 'regression'] });
    assert.match(prompts[0], /ESCALATION — these failure categories recurred in 2 of the last 3 runs: verification, regression/);
    assert.match(prompts[0], /A stronger model alone is not a change/);
    await planner.generateBlueprint(input);
    assert.doesNotMatch(prompts[1], /ESCALATION/);
  });
});
