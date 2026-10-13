import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Factory } from './Factory.js';
import { Inspector } from './Inspector.js';
import { swallowedErrors } from './SwallowedErrors.js';
import { Task, Handoff } from './types.js';

// Mirror the scheduling logic from Factory for unit testing.

function markRejected(tasks: Task[]) {
  const terminallyFailed = new Set(
    tasks
      .filter(t => t.status === 'rejected' || (t.status === 'failed' && t.attempts >= 3))
      .map(t => t.id)
  );
  for (const task of tasks) {
    if (task.status === 'pending' || (task.status === 'failed' && task.attempts < 3)) {
      const deps = [...task.dependencies, ...task.blockedBy];
      if (deps.some(dep => terminallyFailed.has(dep))) {
        task.status = 'rejected';
      }
    }
  }
}

function getReadyTasks(tasks: Task[]): Task[] {
  markRejected(tasks);

  const doneTasks = new Set(
    tasks.filter(t => t.status === 'done').map(t => t.id)
  );

  return tasks.filter(t => {
    if (t.status !== 'pending' && !(t.status === 'failed' && t.attempts < 3)) return false;

    const allDepsResolved = [...t.dependencies, ...t.blockedBy].every(dep => doneTasks.has(dep));
    if (!allDepsResolved) return false;

    const earlierPhaseTasks = tasks.filter(other => other.phase < t.phase);
    const allEarlierSettled = earlierPhaseTasks.every(
      other => other.status === 'done' || other.status === 'rejected' || (other.status === 'failed' && other.attempts >= 3)
    );
    return allEarlierSettled;
  });
}

function hasUnfinishedTasks(tasks: Task[]): boolean {
  return tasks.some(
    t => t.status === 'pending' || t.status === 'active' || (t.status === 'failed' && t.attempts < 3)
  );
}

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: 'Test',
    description: 'Test task',
    agent_role: 'coder',
    phase: 1,
    dependencies: [],
    blockedBy: [],
    files_hint: [],
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

describe('getReadyTasks', () => {
  it('should return all pending phase-1 tasks when nothing is done', () => {
    const tasks = [
      makeTask({ id: 'T001', phase: 1 }),
      makeTask({ id: 'T002', phase: 1 }),
      makeTask({ id: 'T003', phase: 2 }),
    ];
    const ready = getReadyTasks(tasks);
    assert.equal(ready.length, 2);
    assert.deepEqual(ready.map(t => t.id), ['T001', 'T002']);
  });

  it('should not return phase-2 tasks until all phase-1 are done', () => {
    const tasks = [
      makeTask({ id: 'T001', phase: 1, status: 'done' }),
      makeTask({ id: 'T002', phase: 1, status: 'pending' }),
      makeTask({ id: 'T003', phase: 2 }),
    ];
    const ready = getReadyTasks(tasks);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, 'T002');
  });

  it('should return phase-2 tasks once all phase-1 are done', () => {
    const tasks = [
      makeTask({ id: 'T001', phase: 1, status: 'done' }),
      makeTask({ id: 'T002', phase: 1, status: 'done' }),
      makeTask({ id: 'T003', phase: 2 }),
    ];
    const ready = getReadyTasks(tasks);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, 'T003');
  });

  it('should respect dependency ordering', () => {
    const tasks = [
      makeTask({ id: 'T001', phase: 1, status: 'pending' }),
      makeTask({ id: 'T002', phase: 1, status: 'pending', dependencies: ['T001'] }),
    ];
    const ready = getReadyTasks(tasks);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, 'T001');
  });

  it('should respect blockedBy', () => {
    const tasks = [
      makeTask({ id: 'T001', phase: 1, status: 'pending' }),
      makeTask({ id: 'T002', phase: 1, status: 'pending', blockedBy: ['T001'] }),
    ];
    const ready = getReadyTasks(tasks);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, 'T001');
  });

  it('should include failed tasks with retries remaining', () => {
    const tasks = [
      makeTask({ id: 'T001', phase: 1, status: 'failed', attempts: 1 }),
      makeTask({ id: 'T002', phase: 1, status: 'done' }),
    ];
    const ready = getReadyTasks(tasks);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, 'T001');
  });

  it('should exclude failed tasks with no retries left', () => {
    const tasks = [
      makeTask({ id: 'T001', phase: 1, status: 'failed', attempts: 3 }),
    ];
    const ready = getReadyTasks(tasks);
    assert.equal(ready.length, 0);
  });

  it('should not return active tasks', () => {
    const tasks = [
      makeTask({ id: 'T001', phase: 1, status: 'active' }),
    ];
    const ready = getReadyTasks(tasks);
    assert.equal(ready.length, 0);
  });

  it('should unblock dependent after dependency completes', () => {
    const tasks = [
      makeTask({ id: 'T001', phase: 1, status: 'done' }),
      makeTask({ id: 'T002', phase: 1, status: 'pending', dependencies: ['T001'] }),
    ];
    const ready = getReadyTasks(tasks);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, 'T002');
  });

  it('should return empty array for deadlock', () => {
    const tasks = [
      makeTask({ id: 'T001', phase: 1, status: 'pending', dependencies: ['T002'] }),
      makeTask({ id: 'T002', phase: 1, status: 'pending', dependencies: ['T001'] }),
    ];
    const ready = getReadyTasks(tasks);
    assert.equal(ready.length, 0);
  });

  it('should reject tasks whose dependency exhausted retries', () => {
    const tasks = [
      makeTask({ id: 'T001', phase: 1, status: 'failed', attempts: 3 }),
      makeTask({ id: 'T002', phase: 1, status: 'pending', dependencies: ['T001'] }),
    ];
    getReadyTasks(tasks);
    assert.equal(tasks[1].status, 'rejected');
  });

  it('should allow phase-2 tasks when phase-1 has exhausted failures', () => {
    const tasks = [
      makeTask({ id: 'T001', phase: 1, status: 'done' }),
      makeTask({ id: 'T002', phase: 1, status: 'failed', attempts: 3 }),
      makeTask({ id: 'T003', phase: 2 }),
    ];
    const ready = getReadyTasks(tasks);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, 'T003');
  });

  it('should cascade rejection through dependency chains', () => {
    const tasks = [
      makeTask({ id: 'T001', phase: 1, status: 'failed', attempts: 3 }),
      makeTask({ id: 'T002', phase: 2, status: 'pending', dependencies: ['T001'] }),
      makeTask({ id: 'T003', phase: 3, status: 'pending', dependencies: ['T002'] }),
    ];
    getReadyTasks(tasks);
    assert.equal(tasks[1].status, 'rejected');
    // T003 depends on T002 which is now rejected — run again to cascade
    getReadyTasks(tasks);
    assert.equal(tasks[2].status, 'rejected');
  });

  it('should preserve last_feedback on task', () => {
    const task = makeTask({ id: 'T001', status: 'failed', attempts: 1, last_feedback: 'Remove node_modules' });
    assert.equal(task.last_feedback, 'Remove node_modules');
  });
});
describe('generateFeatureId', () => {
  it('should produce f-YYYYMMDDHHMMSS format', () => {
    const id = `f-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
    assert.match(id, /^f-\d{14}$/);
  });

  it('should produce unique IDs across time', () => {
    const id1 = `f-${new Date('2026-06-03T12:00:00Z').toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
    const id2 = `f-${new Date('2026-06-03T12:01:00Z').toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
    assert.notEqual(id1, id2);
  });
});
describe('hasUnfinishedTasks', () => {
  it('should return false when all tasks are done', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'done' }),
    ];
    assert.equal(hasUnfinishedTasks(tasks), false);
  });

  it('should return true for pending tasks', () => {
    const tasks = [makeTask({ id: 'T001', status: 'pending' })];
    assert.equal(hasUnfinishedTasks(tasks), true);
  });

  it('should return true for active tasks', () => {
    const tasks = [makeTask({ id: 'T001', status: 'active' })];
    assert.equal(hasUnfinishedTasks(tasks), true);
  });

  it('should return true for failed tasks with retries', () => {
    const tasks = [makeTask({ id: 'T001', status: 'failed', attempts: 2 })];
    assert.equal(hasUnfinishedTasks(tasks), true);
  });

  it('should return false for failed tasks with no retries', () => {
    const tasks = [makeTask({ id: 'T001', status: 'failed', attempts: 3 })];
    assert.equal(hasUnfinishedTasks(tasks), false);
  });

  it('should return false for rejected tasks', () => {
    const tasks = [makeTask({ id: 'T001', status: 'rejected' })];
    assert.equal(hasUnfinishedTasks(tasks), false);
  });

  it('should return false when all tasks are settled (mix of done, failed, rejected)', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'failed', attempts: 3 }),
      makeTask({ id: 'T003', status: 'rejected' }),
    ];
    assert.equal(hasUnfinishedTasks(tasks), false);
  });
});

describe('WorkerRegistry Escalation Ladder & Tiering', () => {
  it('should escalate to frontier model for cloud strategy on attempt 2', async () => {
    const { WorkerRegistry } = await import('./WorkerRegistry.js');
    const registry = new WorkerRegistry('cloud', 'auto', 'Gemini 3.7 Flash (High)', 'Gemini 3.1 Pro (High)');

    const task0 = makeTask({ id: 'T001', attempts: 0 });
    const res0 = await registry.resolveWorker(task0);
    assert.equal(res0.model, 'Gemini 3.7 Flash (High)');
    assert.equal(res0.escalated, false);

    const task2 = makeTask({ id: 'T001', attempts: 2 });
    const res2 = await registry.resolveWorker(task2);
    assert.equal(res2.model, 'Gemini 3.1 Pro (High)');
    assert.equal(res2.escalated, true);
  });

  it('should use 7b for light tasks and 14b for heavy tasks in local strategy', async () => {
    const { WorkerRegistry } = await import('./WorkerRegistry.js');
    const registry = new WorkerRegistry('local', 'auto');

    // Light task (devops)
    const devopsTask = makeTask({ id: 'T001', agent_role: 'devops', phase: 1, attempts: 0 });
    const resDevops = await registry.resolveWorker(devopsTask);
    assert.equal(resDevops.model, 'qwen2.5-coder:7b');

    // Light task (test_writer)
    const testTask = makeTask({ id: 'T002', agent_role: 'test_writer', phase: 2, attempts: 0 });
    const resTest = await registry.resolveWorker(testTask);
    assert.equal(resTest.model, 'qwen2.5-coder:7b');

    // Heavy task (coder with multi-file)
    const coderTask = makeTask({
      id: 'T005',
      agent_role: 'coder',
      phase: 3,
      files_hint: ['backend/a.go', 'backend/b.go'],
      attempts: 0,
    });
    const resCoder = await registry.resolveWorker(coderTask);
    assert.equal(resCoder.model, 'qwen2.5-coder:14b');

    // Retry of light task should escalate to 14b
    const devopsRetry = makeTask({ id: 'T001', agent_role: 'devops', phase: 1, attempts: 1 });
    const resRetry = await registry.resolveWorker(devopsRetry);
    assert.equal(resRetry.model, 'qwen2.5-coder:14b');
    assert.equal(resRetry.escalated, true);
  });

  it('should select the configured direct cloud provider', async () => {
    const { WorkerRegistry } = await import('./WorkerRegistry.js');
    const registry = new WorkerRegistry('cloud', 'auto', 'gpt-fast', 'gpt-pro', undefined, undefined, 'openai');
    const result = await registry.resolveWorker(makeTask({ id: 'T009' }));
    assert.equal(result.provider, 'openai');
    assert.equal(result.worker.id, 'codex-cloud');
    assert.equal(result.model, 'gpt-fast');
    const escalated = await registry.resolveWorker(makeTask({ id: 'T010', attempts: 2 }));
    assert.equal(escalated.model, 'gpt-pro');
  });

  it('should use Codex fast and frontier tiers in hybrid fallback', async () => {
    const { WorkerRegistry } = await import('./WorkerRegistry.js');
    const registry = new WorkerRegistry('hybrid', 'auto', 'gpt-fast', 'gpt-pro', undefined, undefined, 'openai');
    // Make the routing assertion independent of credentials installed on the host.
    (registry as any).cloudWorker.isAvailable = async () => true;
    const fast = await registry.resolveWorker(makeTask({ id: 'T011', attempts: 2 }));
    assert.equal(fast.provider, 'openai');
    assert.equal(fast.model, 'gpt-fast');
    const frontier = await registry.resolveWorker(makeTask({ id: 'T012', attempts: 3 }));
    assert.equal(frontier.provider, 'openai');
    assert.equal(frontier.model, 'gpt-pro');
  });
});

/**
 * executeAndInspect with every collaborator but the reviewer stubbed out, so a
 * test can watch what the inspector is handed and which run notes are written.
 */
async function swallowedHarness(diff: string) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-swallowed-'));
  const factory: any = new Factory(baseDir, '', { strategy: 'hybrid', cloudProvider: 'deepseek', cloudModel: 'deepseek-v4-flash' });
  factory.state = { feature_id: 'f-1', feature: 'test', status: 'active', strategy: 'hybrid',
    cloud_provider: 'deepseek', planner_provider: 'local', created_at: '', last_updated: '', tasks: [], memory_patterns: [] };
  factory.saveState = async () => {};
  factory.getProjectContext = async () => '';
  factory.getDiff = async () => diff;
  factory.lessons.getRelevant = async () => [];
  factory.taskVerifier.prepare = async () => ({ ok: true });
  factory.taskVerifier.verify = async () => ({ executed: true, passed: true, testSummary: 'ok', output: '' });
  factory.workerRegistry.resolveWorker = async () => ({
    worker: { id: 'stub', name: 'stub', isAvailable: async () => true,
      execute: async (): Promise<Handoff> => ({ task_id: 'T1', status: 'success', files_changed: ['api.py'], summary: 'done' }) },
    model: 'm', provider: 'p',
  });
  factory.worktreeManager.commitWorktree = async () => ({ committed: true, filesChanged: 1 });
  return factory;
}

function swallowedTask(): Task {
  return { id: 'T1', title: 'Fetch rates', description: 'Fetch the latest rates', agent_role: 'coder',
    phase: 1, dependencies: [], blockedBy: [], files_hint: ['api.py'], creates_files: [],
    acceptance_criteria: [], verification: [], status: 'pending', attempts: 0,
    escalation_level: 0, error_history: [], worker_type: 'auto' };
}

/** The mongolbank shape: `except Exception:` whose body sets `parsed = []`. */
const SWALLOWING_DIFF = [
  'diff --git a/api.py b/api.py',
  '--- a/api.py',
  '+++ b/api.py',
  '@@ -1,3 +1,6 @@',
  ' def rates():',
  '+    try:',
  '         parsed = parse_latest_rates()',
  '+    except Exception:',
  '+        parsed = []',
  '     return parsed',
].join('\n');

describe('executeAndInspect surfaces swallowed errors to the inspector', () => {
  it('passes swallowedErrors(diff) to inspect and records a run note per hit', async () => {
    const factory = await swallowedHarness(SWALLOWING_DIFF);
    let captured: Array<{ file: string; line: number; snippet: string }> | undefined;
    factory.inspector.inspect = async (_task: Task, _diff: string, _summary: string, _verifier: string, swallowed: any) => {
      captured = swallowed;
      return { verdict: 'PASS', feedback: 'ok', provider: 'deepseek', model: 'deepseek-v4-flash' };
    };
    const notes: string[] = [];
    const realAddRunNote = factory.addRunNote.bind(factory);
    factory.addRunNote = (taskId: string, note: string) => { notes.push(note); realAddRunNote(taskId, note); };

    const result = await factory.executeAndInspect(swallowedTask(), '/tmp/wt');
    assert.ok(result, 'the task merged, so the inspection ran');

    const expected = swallowedErrors(SWALLOWING_DIFF);
    assert.ok(expected.length >= 1, 'the diff contains a swallowed handler');
    assert.deepEqual(captured, expected, 'inspect receives swallowedErrors(diff)');
    for (const hit of expected) {
      assert.ok(notes.some(n => n.includes(`${hit.file}:${hit.line}`) && n.includes(hit.snippet)),
        `a run note names ${hit.file}:${hit.line}`);
    }
  });

  it('the inspector prompt names the swallowed hit and the FAIL-with-logic rule', async () => {
    const factory = await swallowedHarness(SWALLOWING_DIFF);
    let prompt = '';
    factory.inspector = new Inspector({ provider: 'deepseek', model: 'deepseek-v4-flash', isAvailable: async () => true,
      complete: async (p: string) => { prompt = p; return '{"verdict":"PASS","feedback":"fine"}'; } });

    const result = await factory.executeAndInspect(swallowedTask(), '/tmp/wt');
    assert.ok(result, 'the task merged');
    assert.match(prompt, /Errors swallowed into empty results \(file:line\):/);
    assert.match(prompt, /api\.py:4/);
    assert.match(prompt, /fix_kind "logic"/);
    assert.match(prompt, /never look like an empty success/i);
  });
});
