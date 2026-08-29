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
