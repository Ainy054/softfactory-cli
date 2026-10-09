import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Factory } from './Factory.js';
import { ToolLoopWorker } from './ToolLoopWorker.js';
import { CURRENT_SCHEMA_VERSION, type Task, type Handoff } from './types.js';
import type { ChatTransport } from './ChatTransport.js';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${over.id}`, description: 'd', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
    files_hint: ['a.txt'], creates_files: [], acceptance_criteria: [], verification: [], status: 'pending',
    attempts: 0, escalation_level: 0, error_history: [], worker_type: 'auto', executor: 'agent',
    protected: false, review_questions: [], production_targets: [], test_targets: [], behavior_tags: [],
    ...over,
  } as Task;
}

async function factoryWith(options: Record<string, unknown>, tasks: Task[]) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-planned-'));
  await fs.mkdir(path.join(baseDir, '.softfactory'), { recursive: true });
  const factory: any = new Factory(baseDir, '', { strategy: 'local', sandbox: 'none', ...options });
  factory.state = {
    schema_version: CURRENT_SCHEMA_VERSION, feature_id: 'f-1', feature: 'budget', status: 'active', strategy: 'local',
    cloud_provider: 'agy', planner_provider: 'local', created_at: new Date().toISOString(), last_updated: '', tasks, memory_patterns: [],
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  const logs: string[] = [];
  factory.on('log', (l: string) => logs.push(l));
  factory.saveState = async () => {};
  factory.updateHistory = async () => {};
  factory.getProjectContext = async () => '';
  factory.lessons.getRelevant = async () => [];
  factory.taskVerifier.prepare = async () => ({ ok: true });
  factory.taskVerifier.verify = async () => ({ executed: true, passed: true, testSummary: 'ok', output: '' });
  factory.taskVerifier.verifyAll = async () => [];
  factory.workerRegistry.preflight = async () => ({ local: true, cloud: false, localModel: 'q', cloudModel: '' });
  factory.worktreeManager.create = async () => '/tmp/wt';
  factory.worktreeManager.merge = async () => '';
  factory.worktreeManager.cleanup = async () => {};
  factory.worktreeManager.commitWorktree = async () => ({ committed: true, filesChanged: 1 });
  factory.getDiff = async () => 'diff --git a/a.txt b/a.txt\n+x';
  return { factory, logs, baseDir };
}
import { estimateTokens, overEstimate } from './TokenEstimate.js';
import type { RunMetrics } from './Metrics.js';

const run = (tokens: number, done: number, extra: Partial<RunMetrics> & { tokens_per_done_task?: number } = {}) =>
  ({ tokens: { input: tokens, output: 0 }, done, manual: 0, ...extra }) as RunMetrics;

describe('issue #30: the token estimate comes from the project history', () => {
  it('is the median tokens per finished task, times agent tasks, with room for retries', () => {
    // per task: 100, 200, 1000 -> median 200; 3 tasks x 1.5 = 900
    assert.deepEqual(estimateTokens([run(300, 3), run(400, 2), run(1000, 1)], 3), { tokens: 900, runs: 3 });
  });
  it('prefers the recorded tokens per done task, and uses only the last five runs', () => {
    const old = Array.from({ length: 5 }, () => run(1_000_000, 1));
    const recent = Array.from({ length: 5 }, () => run(999, 1, { tokens_per_done_task: 40 }));
    assert.deepEqual(estimateTokens([...old, ...recent], 2), { tokens: 120, runs: 5 });
  });
  it('gives no estimate without usable history', () => {
    assert.equal(estimateTokens([], 4), undefined);
    assert.equal(estimateTokens([run(0, 3), run(500, 0)], 4), undefined);
  });
  it('asks at 80 percent', () => {
    assert.equal(overEstimate(79, { tokens: 100, runs: 1 }), null);
    assert.match(overEstimate(80, { tokens: 100, runs: 1 }) || '', /80% of the planned budget: 80 of about 100 tokens/);
  });
});

describe('issue #30: a run past 80% of its planned budget asks or halts', () => {
  const twoPhases = () => [task({ id: 'T1' }), task({ id: 'T2', phase: 2, dependencies: ['T1'] })];
  const spend = (factory: any, executed: string[]) => async (t: Task) => {
    executed.push(t.id); factory.recordUsage({ inputTokens: 85, outputTokens: 0 }); return { task: t, branchName: `line/${t.id}` };
  };

  it('is estimated at plan time from metrics.jsonl and shown in the plan', async () => {
    const { factory, baseDir } = await factoryWith({}, twoPhases());
    await fs.writeFile(path.join(baseDir, '.softfactory', 'metrics.jsonl'), `${JSON.stringify(run(100, 2))}\n`);
    await factory.planTokenBudget();
    assert.deepEqual(factory.state.token_estimate, { tokens: 150, runs: 1 });
    const { formatPlan } = await import('./PlanApproval.js');
    assert.match(formatPlan(factory.state).join('\n'), /Planned budget: about 150 tokens/);
  });

  it('halts unattended, as an environment fault that --resume continues', async () => {
    const { factory, logs } = await factoryWith({}, twoPhases());
    factory.state.token_estimate = { tokens: 100, runs: 2 };
    const executed: string[] = [];
    factory.executeAndInspect = spend(factory, executed);
    await factory.runWorkshopLoop();
    assert.deepEqual(executed, ['T1']);
    assert.equal(factory.state.tasks[1].status, 'pending', 'no task was failed by the halt');
    assert.equal(factory.state.status, 'active');
    assert.ok(logs.some(l => /HALTED: Token use passed 80% of the planned budget: 85 of about 100/.test(l)), logs.join('\n'));
  });

  it('asks a person once and continues on yes', async () => {
    const asked: string[] = [];
    const { factory } = await factoryWith({ confirmOverBudget: async (m: string) => { asked.push(m); return true; } }, [...twoPhases(), task({ id: 'T3', phase: 3, dependencies: ['T2'] })]);
    factory.state.token_estimate = { tokens: 100, runs: 2 };
    const executed: string[] = [];
    factory.executeAndInspect = spend(factory, executed);
    await factory.runWorkshopLoop();
    assert.deepEqual(executed, ['T1', 'T2', 'T3']);
    assert.equal(asked.length, 1, 'asked once, not before every phase');
    assert.equal(factory.state.over_estimate_accepted, true);
  });

  it('halts when the person says no', async () => {
    const { factory } = await factoryWith({ confirmOverBudget: async () => false }, twoPhases());
    factory.state.token_estimate = { tokens: 100, runs: 2 };
    const executed: string[] = [];
    factory.executeAndInspect = spend(factory, executed);
    await factory.runWorkshopLoop();
    assert.deepEqual(executed, ['T1']);
    assert.equal(factory.state.status, 'active');
  });

  it('does not stop without an estimate, and --max-tokens replaces the estimate', async () => {
    for (const options of [{}, { maxTokens: 10_000 }]) {
      const { factory, baseDir } = await factoryWith(options, twoPhases());
      await fs.writeFile(path.join(baseDir, '.softfactory', 'metrics.jsonl'), `${JSON.stringify(run(100, 2))}\n`);
      if ('maxTokens' in options) { await factory.planTokenBudget(); assert.equal(factory.state.token_estimate, undefined); }
      const executed: string[] = [];
      factory.executeAndInspect = spend(factory, executed);
      await factory.runWorkshopLoop();
      assert.deepEqual(executed, ['T1', 'T2']);
    }
  });
});
