import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { startFactoryRun } from './runMode.js';
import { Factory } from './Factory.js';
import { Task } from './types.js';

function spyFactory() {
  const calls: any[] = [];
  return {
    calls,
    factory: {
      resume: async (id?: string, retryBlocked?: boolean) => { calls.push(['resume', id, retryBlocked]); },
      refine: async (r: string) => { calls.push(['refine', r]); },
      plan: async (r: string) => { calls.push(['plan', r]); },
      build: async (r: string) => { calls.push(['build', r]); },
    } as unknown as Factory,
  };
}

describe('startFactoryRun', () => {
  it('forwards retryBlocked to resume — the TUI and stdout paths share this', async () => {
    const { factory, calls } = spyFactory();
    await startFactoryRun(factory, '', { resumeMode: true, resumeFeatureId: 'f-1', retryBlocked: true });
    assert.deepEqual(calls, [['resume', 'f-1', true]]);
  });

  it('does not set retryBlocked when the flag is absent', async () => {
    const { factory, calls } = spyFactory();
    await startFactoryRun(factory, '', { resumeMode: true });
    assert.deepEqual(calls, [['resume', undefined, undefined]]);
  });

  it('routes refine, plan and build', async () => {
    for (const [opts, expected] of [
      [{ refineMode: true }, ['refine', 'req']],
      [{ planMode: true }, ['plan', 'req']],
      [{}, ['build', 'req']],
    ] as const) {
      const { factory, calls } = spyFactory();
      await startFactoryRun(factory, 'req', opts as any);
      assert.deepEqual(calls, [expected]);
    }
  });
});

function task(id: string, status: Task['status'], phase: number, deps: string[] = []): Task {
  return { id, title: id, description: 'x', agent_role: 'coder', phase, dependencies: deps,
    blockedBy: [], files_hint: [], creates_files: [], acceptance_criteria: [], verification: [],
    status, attempts: 0, escalation_level: 0, error_history: [], worker_type: 'auto' };
}

async function resumeHarness(tasks: Task[]) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-resume-'));
  const factory: any = new Factory(baseDir, '', { strategy: 'local' });
  factory.state = { feature_id: 'f-1', feature: 'demo', status: 'failed', strategy: 'local',
    cloud_provider: 'agy', planner_provider: 'local', created_at: '', last_updated: '',
    tasks, memory_patterns: [] };
  const logs: string[] = [];
  factory.on('log', (m: string) => logs.push(m));
  factory.saveState = async () => {};
  factory.updateHistory = async () => {};
  factory.validateDoneTasks = async () => {};
  factory.getCurrentCommit = async () => 'abc';
  let loopRan = false;
  factory.runWorkshopLoop = async () => { loopRan = true; };
  return { factory, logs, ranLoop: () => loopRan };
}

describe('resume with no runnable work', () => {
  it('explains the deadlock and points at --retry-blocked instead of silently failing', async () => {
    // T1 blocked; T2 depends on it; T3 depends on T2 — nothing can ever start.
    const { factory, logs, ranLoop } = await resumeHarness([
      task('T1', 'blocked', 1), task('T2', 'pending', 2, ['T1']), task('T3', 'pending', 3, ['T2']),
    ]);
    await factory.resume(undefined, false);
    assert.equal(ranLoop(), false, 'must not enter the workshop loop with nothing runnable');
    assert.ok(logs.some(l => l.includes('No runnable tasks remain')), logs.join('\n'));
    assert.ok(logs.some(l => l.includes('--retry-blocked')), 'must tell the user how to recover');
  });

  it('cascades rejection through the whole chain in one pass, not one layer per run', async () => {
    const { factory } = await resumeHarness([
      task('T1', 'blocked', 1), task('T2', 'pending', 2, ['T1']), task('T3', 'pending', 3, ['T2']),
    ]);
    await factory.resume(undefined, false);
    assert.equal(factory.state.tasks[1].status, 'rejected');
    assert.equal(factory.state.tasks[2].status, 'rejected', 'the far end of the chain must settle too');
  });

  it('retryBlocked revives blocked and rejected tasks and runs', async () => {
    const { factory, ranLoop } = await resumeHarness([
      task('T1', 'blocked', 1), task('T2', 'rejected', 2, ['T1']),
    ]);
    factory.state.tasks[0].attempts = 5;
    await factory.resume(undefined, true);
    assert.equal(ranLoop(), true);
    assert.equal(factory.state.tasks[0].status, 'pending');
    assert.equal(factory.state.tasks[0].attempts, 0);
    assert.equal(factory.state.tasks[1].status, 'pending');
  });
});
