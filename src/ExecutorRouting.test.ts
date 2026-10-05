import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Factory } from './Factory.js';
import { CURRENT_SCHEMA_VERSION, type Task } from './types.js';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${over.id}`, description: 'd', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
    files_hint: [], creates_files: [], acceptance_criteria: [], verification: [], status: 'pending',
    attempts: 0, escalation_level: 0, error_history: [], worker_type: 'auto', executor: 'agent',
    protected: false, review_questions: [], production_targets: [], test_targets: [], behavior_tags: [],
    ...over,
  } as Task;
}

/** The workshop loop with git, workers and verifiers stubbed; routing is what is under test. */
async function loopHarness(tasks: Task[]) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-exec-'));
  await fs.mkdir(path.join(baseDir, '.softfactory'), { recursive: true });
  const factory: any = new Factory(baseDir, '', { strategy: 'local', sandbox: 'none' });
  factory.state = {
    schema_version: CURRENT_SCHEMA_VERSION, feature_id: 'f-1', feature: 'routing', status: 'active', strategy: 'local',
    cloud_provider: 'agy', planner_provider: 'local', created_at: new Date().toISOString(), last_updated: '', tasks, memory_patterns: [],
  };
  const executed: string[] = [];
  const events: any[] = [];
  factory.on('task:manual', (e: any) => events.push(e));
  factory.on('build:complete', (e: any) => events.push(e));
  factory.saveState = async () => {};
  factory.updateHistory = async () => {};
  factory.workerRegistry.preflight = async () => ({ local: true, cloud: false, localModel: 'q', cloudModel: '' });
  factory.taskVerifier.verifyAll = async () => [];
  factory.worktreeManager.create = async () => '/tmp/wt';
  factory.worktreeManager.merge = async () => '';
  factory.worktreeManager.cleanup = async () => {};
  factory.executeAndInspect = async (t: Task) => { executed.push(t.id); return { task: t, branchName: `line/${t.id}` }; };
  return { factory, executed, events, baseDir };
}

describe('orchestrator and user tasks never reach a worker', () => {
  it('parks the manual task, runs the agent work beside it, and pauses the run', async () => {
    const { factory, executed, events } = await loopHarness([
      task({ id: 'T1', executor: 'user', title: 'Approve the pricing table' }),
      task({ id: 'T2', executor: 'agent' }),
      task({ id: 'T3', executor: 'agent', phase: 2, dependencies: ['T1'] }),
    ]);
    await factory.runWorkshopLoop();

    assert.deepEqual(executed, ['T2'], 'only the agent task without a human dependency runs');
    const byId = Object.fromEntries(factory.state.tasks.map((t: Task) => [t.id, t.status]));
    assert.deepEqual(byId, { T1: 'manual', T2: 'done', T3: 'pending' });
    assert.equal(factory.state.status, 'paused', 'a plan that reached human work is paused, not failed');
    assert.ok(events.some(e => e.type === 'task:manual' && e.task.id === 'T1'));
    assert.ok(events.some(e => e.type === 'build:complete' && e.status === 'paused'));
  });

  it('continues after --mark-done and finishes the dependents', async () => {
    const { factory, executed } = await loopHarness([
      task({ id: 'T1', executor: 'orchestrator', title: 'Rotate the API key' }),
      task({ id: 'T2', executor: 'agent', phase: 2, dependencies: ['T1'] }),
    ]);
    await factory.runWorkshopLoop();
    assert.equal(factory.state.status, 'paused');
    assert.deepEqual(executed, []);

    await factory.markManualDone('T1', 'rotated in the vault');
    const t1 = factory.state.tasks.find((t: Task) => t.id === 'T1');
    assert.equal(t1.status, 'done');
    assert.match(t1.last_feedback, /rotated in the vault/);
    assert.equal(factory.state.status, 'active');

    await factory.runWorkshopLoop();
    assert.deepEqual(executed, ['T2']);
    assert.equal(factory.state.status, 'completed');
  });

  it('refuses to mark an agent task done by hand', async () => {
    const { factory } = await loopHarness([task({ id: 'T1', executor: 'agent' })]);
    await assert.rejects(() => factory.markManualDone('T1'), /agent task/);
    await assert.rejects(() => factory.markManualDone('T9'), /No task T9/);
  });

  it('does not treat a manually completed task as a ghost on resume', async () => {
    const { factory } = await loopHarness([
      task({ id: 'T1', executor: 'user', status: 'done' }),
      task({ id: 'T2', executor: 'agent', status: 'done' }),
    ]);
    factory.mergeExistsInHistory = async () => false;
    await factory.validateDoneTasks();
    const byId = Object.fromEntries(factory.state.tasks.map((t: Task) => [t.id, t.status]));
    assert.deepEqual(byId, { T1: 'done', T2: 'pending' }, 'only the agent task without a merge commit is a ghost');
  });
});

describe('state schema versioning', () => {
  const base = { feature: 'x', status: 'active', created_at: '', last_updated: '', tasks: [] };

  it('refuses a state written by a newer softfactory', () => {
    const factory: any = new Factory('/tmp', '', { strategy: 'local' });
    assert.throws(() => factory.loadState(JSON.stringify({ ...base, schema_version: CURRENT_SCHEMA_VERSION + 1 })), /newer softfactory/);
  });

  it('migrates an older state forward', () => {
    const factory: any = new Factory('/tmp', '', { strategy: 'local' });
    const state = factory.loadState(JSON.stringify({ ...base, tasks: [{ id: 'T1', title: 't', description: 'd', agent_role: 'coder', phase: 1 }] }));
    assert.equal(state.schema_version, CURRENT_SCHEMA_VERSION);
    assert.equal(state.tasks[0].executor, 'agent', 'pre-routing tasks are agent tasks');
    assert.equal(state.tasks[0].protected, false);
  });
});
