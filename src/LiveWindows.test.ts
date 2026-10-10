import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Factory } from './Factory.js';
import { validateBlueprint, type PlanningInput } from './Planner.js';
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

/** A Factory with persistence and the event journal stubbed; only window bookkeeping is under test. */
async function harness(tasks: Task[]) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-window-'));
  await fs.mkdir(path.join(baseDir, '.softfactory'), { recursive: true });
  const factory: any = new Factory(baseDir, '', { strategy: 'local', sandbox: 'none' });
  factory.state = {
    schema_version: CURRENT_SCHEMA_VERSION, feature_id: 'f-1', feature: 'live windows', status: 'paused',
    strategy: 'local', cloud_provider: 'agy', planner_provider: 'local', created_at: new Date().toISOString(),
    last_updated: '', tasks, memory_patterns: [],
  };
  factory.saveState = async () => {};
  factory.recordTaskEvent = async () => {};
  return { factory };
}

describe('atomic live windows', () => {
  it('refuses to mark one task of a two-task window and changes nothing', async () => {
    const { factory } = await harness([
      task({ id: 'T1', executor: 'orchestrator', window: 'live-1', status: 'manual' }),
      task({ id: 'T2', executor: 'orchestrator', window: 'live-1', status: 'manual' }),
    ]);

    await assert.rejects(() => factory.markManualDone('T1'), /Window live-1 must be closed as one step: --mark-done T1,T2/);

    const byId = Object.fromEntries(factory.state.tasks.map((t: Task) => [t.id, t.status]));
    assert.deepEqual(byId, { T1: 'manual', T2: 'manual' }, 'the refused step leaves every task of the window untouched');
  });

  it('marks both tasks done when the whole window is named', async () => {
    const { factory } = await harness([
      task({ id: 'T3', executor: 'user', window: 'live-2', status: 'manual' }),
      task({ id: 'T4', executor: 'orchestrator', window: 'live-2', status: 'manual' }),
    ]);

    await factory.markManualDone('T3,T4', 'rotated the secret and restarted');

    const byId = Object.fromEntries(factory.state.tasks.map((t: Task) => [t.id, t.status]));
    assert.deepEqual(byId, { T3: 'done', T4: 'done' }, 'one --mark-done closes the whole window');
    for (const t of factory.state.tasks as Task[]) {
      assert.match(t.last_feedback || '', /rotated the secret and restarted/);
    }
  });

  it('marks a task without a window done on its own', async () => {
    const { factory } = await harness([
      task({ id: 'T5', executor: 'orchestrator', status: 'manual' }),
    ]);

    await factory.markManualDone('T5', 'done alone');

    const t5 = factory.state.tasks.find((t: Task) => t.id === 'T5');
    assert.equal(t5.status, 'done');
    assert.match(t5.last_feedback, /done alone/);
  });
});

describe('blueprint rejects a windowed agent task', () => {
  const input: PlanningInput = {
    requirement: '## Live window\nApply the change.',
    codebaseContext: '', memoryPatterns: '', featureHistory: '',
    repositoryFiles: new Set(['src/App.tsx']),
  };

  const blueprint = {
    feature: 'Live window',
    requirements_covered: ['Live window'],
    tasks: [{
      id: 'T001', title: 'Apply the host change', description: 'Apply the config change to the live host.',
      agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
      files_hint: ['src/App.tsx'], creates_files: [],
      acceptance_criteria: ['the host change is applied'], verification: ['npm test -- --run'],
    }],
  };

  it('rejects an agent task that carries a window', () => {
    const plan = structuredClone(blueprint);
    (plan.tasks[0] as any).window = 'live-1';
    assert.throws(() => validateBlueprint(plan, input), /only orchestrator and user tasks share a live window/);
  });

  it('accepts an orchestrator task that carries a window', () => {
    const plan = structuredClone(blueprint);
    const orchestrator = { ...plan.tasks[0], executor: 'orchestrator', files_hint: [], creates_files: [] };
    assert.doesNotThrow(() => validateBlueprint({ ...plan, tasks: [orchestrator] }, input));
  });
});
