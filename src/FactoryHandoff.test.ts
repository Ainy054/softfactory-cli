import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Factory } from './Factory.js';
import { Task, Handoff } from './types.js';

function makeTask(): Task {
  return {
    id: 'T1', title: 'Add farewell', description: 'Add a farewell function', agent_role: 'coder',
    phase: 1, dependencies: [], blockedBy: [], files_hint: ['app.ts'], creates_files: [],
    acceptance_criteria: [], verification: [], status: 'pending', attempts: 0,
    escalation_level: 0, error_history: [], worker_type: 'auto',
  };
}

/**
 * Builds a Factory with every collaborator stubbed, so executeAndInspect runs
 * against real control flow without git, Ollama, or a cloud provider.
 */
async function harness(handoff: Handoff, committed: boolean) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-handoff-'));
  // 'local' strategy keeps the inspector offline; the verifier is the gate.
  const factory: any = new Factory(baseDir, '', { strategy: 'local' });
  factory.state = { feature_id: 'f-1', feature: 'test', status: 'active', strategy: 'local',
    cloud_provider: 'agy', planner_provider: 'local', created_at: '', last_updated: '',
    tasks: [], memory_patterns: [] };
  factory.saveState = async () => {};
  factory.getProjectContext = async () => '';
  factory.getDiff = async () => 'diff --git a/app.ts b/app.ts\n+farewell';
  factory.lessons.getRelevant = async () => [];
  factory.taskVerifier.prepare = async () => ({ ok: true });
  factory.taskVerifier.verify = async () => ({ executed: true, passed: true, testSummary: 'ok', output: '' });
  factory.workerRegistry.resolveWorker = async () => ({
    worker: { id: 'stub', name: 'stub', isAvailable: async () => true, execute: async () => handoff },
    model: 'qwen2.5-coder:7b', provider: 'ollama',
  });
  factory.worktreeManager.commitWorktree = async () => ({ committed, filesChanged: committed ? 1 : 0 });
  return { factory, baseDir };
}

const failedHandoff: Handoff = {
  task_id: 'T1', status: 'failure', files_changed: ['app.ts'],
  summary: 'LocalAgent stopped before calling finish_task.',
};

describe('executeAndInspect: worker self-reported failure', () => {
  it('keeps the work when the worker changed files but never called finish_task', async () => {
    const { factory } = await harness(failedHandoff, true);
    const task = makeTask();
    const result = await factory.executeAndInspect(task, '/tmp/wt');
    assert.ok(result, 'work with committed changes must not be discarded');
    assert.equal(result.branchName, 'line/T1');
    assert.notEqual(task.status, 'failed');
    assert.equal(task.attempts, 0, 'a self-report alone must not burn a retry');
  });

  it('still fails when the worker reports failure and the worktree is empty', async () => {
    const { factory } = await harness(failedHandoff, false);
    const task = makeTask();
    const result = await factory.executeAndInspect(task, '/tmp/wt');
    assert.equal(result, null);
    assert.equal(task.status, 'failed');
    assert.equal(task.attempts, 1);
    assert.match(task.error_history[0], /reported failure and produced no file changes/);
  });

  it('still fails an empty worktree when the worker reports success', async () => {
    const { factory } = await harness({ ...failedHandoff, status: 'success' }, false);
    const task = makeTask();
    const result = await factory.executeAndInspect(task, '/tmp/wt');
    assert.equal(result, null);
    assert.equal(task.status, 'failed');
    assert.match(task.error_history[0], /produced no file changes/);
  });
});

describe('test-writer acceptance evidence', () => {
  it('rejects a placeholder test diff', () => {
    const factory: any = new Factory('/tmp', '', { strategy: 'local' });
    assert.match(factory.validateTestWriterEvidence({ agent_role: 'test_writer' }, '+export {};'), /no test cases/);
  });

  it('accepts executable assertions', () => {
    const factory: any = new Factory('/tmp', '', { strategy: 'local' });
    assert.equal(factory.validateTestWriterEvidence({ agent_role: 'test_writer' }, '+it("works", () => expect(true).toBe(true));'), null);
  });

  it('accepts pytest, Rust and JUnit tests', () => {
    const factory: any = new Factory('/tmp', '', { strategy: 'local' });
    for (const diff of [
      '+def test_schema_creation(cache):\n+    assert cache',
      '+    async def test_latest(client):',
      '+class TestParser:\n+    def check(self): ...',
      '+#[test]\n+fn parses() {}',
      '+  @Test\n+  void parses() {}',
    ]) assert.equal(factory.validateTestWriterEvidence({ agent_role: 'test_writer' }, diff), null, diff);
  });

  it('still rejects a Python file with no tests', () => {
    const factory: any = new Factory('/tmp', '', { strategy: 'local' });
    assert.match(factory.validateTestWriterEvidence({ agent_role: 'test_writer' }, '+import pytest\n+def helper(x):\n+    return x'), /no test cases/);
  });
});

describe('automatic re-plan scope', () => {
  it('allows splitting work across the parent task files', () => {
    const factory: any = new Factory('/tmp', '', { strategy: 'local' });
    const parent = { ...makeTask(), files_hint: ['app.ts', 'app.test.ts'] };
    const replacements = [
      { ...makeTask(), id: 'T1.1', files_hint: ['app.ts'] },
      { ...makeTask(), id: 'T1.2', files_hint: ['app.test.ts'] },
    ];
    assert.doesNotThrow(() => factory.validateAutoReplanScope(parent, replacements));
  });

  it('rejects invented paths that expand the parent scope', () => {
    const factory: any = new Factory('/tmp', '', { strategy: 'local' });
    const replacements = [{
      ...makeTask(), id: 'T1.1',
      files_hint: ['src/invented/__tests__/app.test.ts'],
      creates_files: ['src/invented/__tests__/app.test.ts'],
    }];
    assert.throws(() => factory.validateAutoReplanScope(makeTask(), replacements), /expanded task scope/);
  });
});

describe('resume runtime configuration', () => {
  it('synchronizes persisted provider metadata with the current process', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-runtime-'));
    await fs.mkdir(path.join(baseDir, '.softfactory'), { recursive: true });
    await fs.writeFile(path.join(baseDir, '.softfactory', 'factory.json'), JSON.stringify({
      feature_id: 'f-1', feature: 'test', status: 'active', strategy: 'hybrid',
      cloud_provider: 'openai', planner_provider: 'openai', created_at: '', last_updated: '',
      tasks: [], memory_patterns: [],
    }));
    const factory: any = new Factory(baseDir, '', {
      strategy: 'hybrid', cloudProvider: 'deepseek', plannerProvider: 'local', useDocker: false,
    });
    factory.worktreeManager.init = async () => {};
    factory.worktreeManager.getDefaultBranch = async () => 'master';
    await factory.init();
    assert.equal(factory.state.cloud_provider, 'deepseek');
    assert.equal(factory.state.planner_provider, 'local');
  });
});

describe('training capture configuration', () => {
  it('is enabled by default and supports an explicit opt-out', () => {
    const previous = process.env.SOFTFACTORY_TRAINING_CAPTURE;
    try {
      delete process.env.SOFTFACTORY_TRAINING_CAPTURE;
      assert.equal((new Factory('/tmp', '', { strategy: 'local' }) as any).trainingCaptureEnabled, true);
      process.env.SOFTFACTORY_TRAINING_CAPTURE = '0';
      assert.equal((new Factory('/tmp', '', { strategy: 'local' }) as any).trainingCaptureEnabled, false);
    } finally {
      if (previous === undefined) delete process.env.SOFTFACTORY_TRAINING_CAPTURE;
      else process.env.SOFTFACTORY_TRAINING_CAPTURE = previous;
    }
  });
});
