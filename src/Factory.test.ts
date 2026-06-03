import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Task } from './types.js';

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
