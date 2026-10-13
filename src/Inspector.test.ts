import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Factory } from './Factory.js';
import { Inspector } from './Inspector.js';
import { createTextModel } from './TextModel.js';
import { isEnvironmentFailure } from './IWorker.js';
import type { Task, Handoff } from './types.js';

function makeTask(): Task {
  return {
    id: 'T1', title: 'Add farewell', description: 'Add a farewell function', agent_role: 'coder',
    phase: 1, dependencies: [], blockedBy: [], files_hint: ['app.ts'], creates_files: [],
    acceptance_criteria: [], verification: [], status: 'pending', attempts: 0,
    escalation_level: 0, error_history: [], worker_type: 'auto',
  };
}

const handoff: Handoff = { task_id: 'T1', status: 'success', files_changed: ['app.ts'], summary: 'done' };

/** executeAndInspect with every collaborator but the inspector stubbed out. */
async function harness(options: Record<string, unknown>) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-inspect-'));
  const factory: any = new Factory(baseDir, '', options);
  factory.state = { feature_id: 'f-1', feature: 'test', status: 'active', strategy: options.strategy,
    cloud_provider: 'agy', planner_provider: 'local', created_at: '', last_updated: '', tasks: [], memory_patterns: [] };
  factory.saveState = async () => {};
  factory.getProjectContext = async () => '';
  factory.getDiff = async () => 'diff --git a/app.ts b/app.ts\n+farewell';
  factory.lessons.getRelevant = async () => [];
  factory.taskVerifier.prepare = async () => ({ ok: true });
  factory.taskVerifier.verify = async () => ({ executed: true, passed: true, testSummary: 'ok', output: '' });
  factory.workerRegistry.resolveWorker = async () => ({
    worker: { id: 'stub', name: 'stub', isAvailable: async () => true, execute: async () => handoff },
    model: 'm', provider: 'p',
  });
  factory.worktreeManager.commitWorktree = async () => ({ committed: true, filesChanged: 1 });
  return factory;
}

describe('the reviewer is the configured provider, nothing else', () => {
  it('builds the inspector on the cloud provider the user chose', () => {
    for (const [cloudProvider, expected] of [['deepseek', 'deepseek'], ['openai', 'openai'], ['anthropic', 'anthropic'], ['agy', 'agy']]) {
      const factory: any = new Factory('/tmp', '', { strategy: 'hybrid', cloudProvider, cloudModel: 'm' } as any);
      assert.equal(factory.inspector.provider, expected, `provider ${cloudProvider}`);
      assert.equal(factory.inspector.model, 'm');
    }
  });

  it('maps every provider name to a transport', () => {
    for (const provider of ['local', 'agy', 'openai', 'openai-api', 'anthropic', 'deepseek'] as const) {
      assert.equal(createTextModel(provider, 'm').provider, provider);
    }
  });

  it('halts the run when the configured reviewer is unreachable, without consuming a retry', async () => {
    const factory = await harness({ strategy: 'hybrid', cloudProvider: 'deepseek', cloudModel: 'deepseek-v4-flash' });
    // The transport fails the way a dead endpoint does. Before, this fell
    // through to the Antigravity CLI and then to a local 7B without a word.
    factory.inspector = new Inspector({ provider: 'deepseek', model: 'deepseek-v4-flash', isAvailable: async () => false,
      complete: async () => { throw new Error('fetch failed: ECONNREFUSED'); } });
    const task = makeTask();
    await assert.rejects(() => factory.executeAndInspect(task, '/tmp/wt'), (error: Error) => {
      assert.ok(isEnvironmentFailure(error));
      assert.match(error.message, /deepseek\/deepseek-v4-flash/, 'the fault names the model that was supposed to review');
      return true;
    });
    assert.equal(task.attempts, 0);
    assert.equal(task.status, 'pending');
  });

  it('records which model issued the verdict', async () => {
    const factory = await harness({ strategy: 'hybrid', cloudProvider: 'deepseek', cloudModel: 'deepseek-v4-flash' });
    factory.inspector = new Inspector({ provider: 'deepseek', model: 'deepseek-v4-flash', isAvailable: async () => true,
      complete: async () => '{"verdict":"PASS","feedback":"fine"}' });
    const task = makeTask();
    const result = await factory.executeAndInspect(task, '/tmp/wt');
    assert.ok(result);
    assert.equal(task.inspection, 'model');
    assert.equal(task.inspector_model, 'deepseek/deepseek-v4-flash');
  });
});

describe('a local run does not claim a review it never had', () => {
  it('labels the merge decision as mechanical gates only', async () => {
    const factory = await harness({ strategy: 'local' });
    factory.inspector.inspect = async () => { throw new Error('a local run must never call a reviewer'); };
    const task = makeTask();
    const result = await factory.executeAndInspect(task, '/tmp/wt');
    assert.ok(result, 'mechanical gates passed, so the task proceeds to merge');
    assert.equal(task.inspection, 'mechanical-only');
    assert.equal(task.inspector_model, undefined);
  });
});

describe('preflight requires the reviewer for hybrid and cloud runs', () => {
  it('reports an environment fault naming the inspector when it is unavailable', async () => {
    const factory: any = new Factory(await fs.mkdtemp(path.join(os.tmpdir(), 'sf-pre-')), '', { strategy: 'hybrid', cloudProvider: 'deepseek', cloudModel: 'deepseek-v4-flash', sandbox: 'none' });
    factory.workerRegistry.preflight = async () => ({ local: true, cloud: false, localModel: 'q', cloudModel: 'deepseek-v4-flash' });
    factory.inspector.isAvailable = async () => false;
    await factory.logBackendPreflight();
    assert.match(factory.environmentFault, /Quality inspector \(deepseek\/deepseek-v4-flash\) is unavailable/);
  });

  it('does not require one for a local run', async () => {
    const factory: any = new Factory(await fs.mkdtemp(path.join(os.tmpdir(), 'sf-pre-')), '', { strategy: 'local', sandbox: 'none' });
    factory.workerRegistry.preflight = async () => ({ local: true, cloud: false, localModel: 'q', cloudModel: '' });
    factory.inspector.isAvailable = async () => false;
    await factory.logBackendPreflight();
    assert.equal(factory.environmentFault, undefined);
  });
});

describe('errors swallowed into empty results reach the reviewer', () => {
  it('lists each hit under the section and states the FAIL-with-logic rule', async () => {
    let seen = '';
    const inspector = new Inspector({ provider: 'deepseek', model: 'deepseek-v4-flash', isAvailable: async () => true,
      complete: async (prompt: string) => { seen = prompt; return '{"verdict":"FAIL","fix_kind":"logic","feedback":"swallowed"}'; } });
    const result = await inspector.inspect(makeTask(), 'diff --git a/api.py b/api.py', 'summary', undefined, [
      { file: 'api.py', line: 4, snippet: 'except Exception:' },
    ]);
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.fixKind, 'logic');
    assert.match(seen, /Errors swallowed into empty results \(file:line\):/);
    assert.match(seen, /api\.py:4: except Exception:/);
    assert.match(seen, /fix_kind "logic"/);
    assert.match(seen, /never look like an empty success/i);
  });

  it('omits the section when there are no swallowed hits', async () => {
    let seen = '';
    const inspector = new Inspector({ provider: 'deepseek', model: 'deepseek-v4-flash', isAvailable: async () => true,
      complete: async (prompt: string) => { seen = prompt; return '{"verdict":"PASS","feedback":"fine"}'; } });
    await inspector.inspect(makeTask(), 'diff --git a/api.py b/api.py', 'summary');
    assert.doesNotMatch(seen, /Errors swallowed into empty results \(file:line\):/);
  });
});
