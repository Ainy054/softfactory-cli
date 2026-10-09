import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { computeRunMetrics, measureCoverage } from './Metrics.js';
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

async function tmpBaseDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sf-richer-metrics-'));
}

describe('richer run metrics', () => {
  it('splits tokens by the model that spent them', async () => {
    const baseDir = await tmpBaseDir();
    const state: any = {
      schema_version: CURRENT_SCHEMA_VERSION, feature_id: 'f-1', feature: 'metrics', status: 'completed',
      created_at: new Date().toISOString(),
      usage: { input_tokens: 150, output_tokens: 225 },
      usage_by_model: {
        qwen: { input: 100, output: 200 },
        pro: { input: 50, output: 25 },
      },
      tasks: [task({ id: 'T1', model: 'qwen' }), task({ id: 'T2', model: 'pro' })],
    };

    const metrics = await computeRunMetrics(baseDir, state);

    assert.deepEqual(metrics.tokens_by_model, {
      qwen: { input: 100, output: 200 },
      pro: { input: 50, output: 25 },
    });
    assert.deepEqual(metrics.tokens, { input: 150, output: 225 });
    assert.equal(metrics.tokens_per_done_task, Math.round((150 + 225) / 2), 'total tokens over the two done agent tasks');
  });

  it('keeps the per-model split when a state only carries usage_by_model', async () => {
    const baseDir = await tmpBaseDir();
    const state: any = {
      schema_version: CURRENT_SCHEMA_VERSION, feature_id: 'f-2', feature: 'metrics', status: 'completed',
      created_at: new Date().toISOString(),
      usage_by_model: { qwen: { input: 10, output: 5 } },
      tasks: [task({ id: 'T1', model: 'qwen' })],
    };

    const metrics = await computeRunMetrics(baseDir, state);

    assert.deepEqual(metrics.tokens_by_model, { qwen: { input: 10, output: 5 } });
    assert.equal(metrics.tokens_per_done_task, 15);
  });

  it('counts micro_fixes and recovered_workers for this run before the environment filter', async () => {
    const baseDir = await tmpBaseDir();
    await fs.mkdir(path.join(baseDir, '.softfactory'));
    const created = new Date(Date.now() - 60_000).toISOString();
    const row = (task_id: string, category: string, timestamp = new Date().toISOString()) =>
      JSON.stringify({ timestamp, task_id, category, detail: '' });
    await fs.writeFile(path.join(baseDir, '.softfactory', 'attempts.jsonl'), [
      row('T1', 'micro_fix'),
      row('T1', 'micro_fix'),
      row('T2', 'recovered_worker'),
      row('T3', 'environment_unavailable'),                                           // never a rejection
      row('T9', 'micro_fix'),                                                         // a task from another feature
      row('T1', 'recovered_worker', new Date(Date.now() - 3_600_000).toISOString()),   // before this run started
    ].join('\n') + '\n');
    const state: any = {
      schema_version: CURRENT_SCHEMA_VERSION, feature_id: 'f-3', feature: 'metrics', status: 'completed', created_at: created,
      tasks: [task({ id: 'T1' }), task({ id: 'T2' }), task({ id: 'T3' })],
    };

    const metrics = await computeRunMetrics(baseDir, state);

    assert.equal(metrics.micro_fixes, 2, 'both micro_fixes for this run and feature');
    assert.equal(metrics.recovered_workers, 1, 'only the recovered worker for this run and feature');
    assert.ok(!('environment_unavailable' in metrics.rejected_by_category), 'environment faults are not rejections');
  });

  it('reports zero counts when there is no attempts journal', async () => {
    const baseDir = await tmpBaseDir();
    const state: any = {
      schema_version: CURRENT_SCHEMA_VERSION, feature_id: 'f-4', feature: 'metrics', status: 'completed',
      created_at: new Date().toISOString(),
      tasks: [task({ id: 'T1' })],
    };

    const metrics = await computeRunMetrics(baseDir, state);

    assert.equal(metrics.micro_fixes, 0);
    assert.equal(metrics.recovered_workers, 0);
    assert.equal(metrics.tokens_by_model, undefined, 'no per-model usage means no field');
  });
});

describe('measureCoverage', () => {
  it('parses the last percentage printed by the coverage command', async () => {
    const seen: Array<{ command: string; cwd: string }> = [];
    const value = await measureCoverage('/repo', 'npm run coverage', (command, cwd) => {
      seen.push({ command, cwd });
      return 'Statements: 70%\nLines: 81.5%\n';
    });

    assert.equal(value, 81.5);
    assert.deepEqual(seen, [{ command: 'npm run coverage', cwd: '/repo' }]);
  });

  it('accepts an object result that carries the output and a zero exit code', async () => {
    const value = await measureCoverage('/repo', 'npm run coverage', () => ({ stdout: 'Lines: 81.5%', code: 0 }));
    assert.equal(value, 81.5);
  });

  it('returns undefined when the command exits non-zero', async () => {
    const value = await measureCoverage('/repo', 'npm run coverage', () => ({ output: 'Lines: 81.5%', code: 1 }));
    assert.equal(value, undefined);
  });

  it('returns undefined when the object result is explicitly not ok', async () => {
    const value = await measureCoverage('/repo', 'npm run coverage', () => ({ output: 'Lines: 81.5%', ok: false }));
    assert.equal(value, undefined);
  });

  it('returns undefined when the command throws', async () => {
    const value = await measureCoverage('/repo', 'npm run coverage', () => { throw new Error('boom'); });
    assert.equal(value, undefined);
  });

  it('returns undefined when the output carries no percentage', async () => {
    const value = await measureCoverage('/repo', 'npm run coverage', () => 'coverage finished\n');
    assert.equal(value, undefined);
  });
});
