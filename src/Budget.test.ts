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
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-budget-'));
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

describe('an attempt has a wall-clock budget', () => {
  it('asks the worker to stop, keeps its committed work, and records attempt_timeout', async () => {
    const { factory } = await factoryWith({ attemptTimeoutMinutes: 1 }, [task({ id: 'T1' })]);
    factory.attemptTimeoutMs = 50;
    let sawAbort = false;
    factory.workerRegistry.resolveWorker = async () => ({
      model: 'm', provider: 'p',
      worker: { id: 'slow', name: 'slow', isAvailable: async () => true, execute: async (_t: Task, _w: string, options: any): Promise<Handoff> => {
        await new Promise<void>(resolve => options.signal.addEventListener('abort', () => { sawAbort = true; resolve(); }, { once: true }));
        return { task_id: 'T1', status: 'failure', files_changed: ['a.txt'], summary: 'stopped' };
      } },
    });
    const t = factory.state.tasks[0];
    const result = await factory.executeAndInspect(t, '/tmp/wt');
    assert.equal(result, null);
    assert.equal(sawAbort, true, 'the worker was told to stop through the signal');
    assert.equal(t.attempts, 1, 'an overrun is a task failure that consumes a retry');
    assert.match(t.last_feedback, /ran out of its 0-minute budget|ran out of its \d+-minute budget/);
    const attempts = (await fs.readFile(path.join(factory.baseDir, '.softfactory', 'attempts.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(attempts[attempts.length - 1].category, 'attempt_timeout');
  });

  it('abandons a worker that ignores the signal, without hanging the run', async () => {
    const { factory } = await factoryWith({}, [task({ id: 'T1' })]);
    factory.attemptTimeoutMs = 20;
    factory.workerRegistry.resolveWorker = async () => ({
      model: 'm', provider: 'p',
      worker: { id: 'deaf', name: 'deaf', isAvailable: async () => true, execute: () => new Promise<Handoff>(() => { /* never resolves, never looks at the signal */ }) },
    });
    // The grace period after abort is a minute in production.
    factory.attemptGraceMs = 10;
    const t = factory.state.tasks[0];
    const start = Date.now();
    const result = await factory.executeAndInspect(t, '/tmp/wt');
    assert.equal(result, null);
    assert.ok(Date.now() - start < 5000, 'did not wait on the dead worker');
    assert.equal(t.attempts, 1);
    assert.match(t.last_feedback, /did not stop when asked/);
    const attempts = (await fs.readFile(path.join(factory.baseDir, '.softfactory', 'attempts.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(attempts[attempts.length - 1].category, 'attempt_timeout');
  });
});

describe('a run has token and time budgets', () => {
  it('halts between phases when the token budget is spent, keeps state active, and resumes later', async () => {
    const { factory, logs } = await factoryWith({ maxTokens: 100 }, [task({ id: 'T1' }), task({ id: 'T2', phase: 2, dependencies: ['T1'] })]);
    const executed: string[] = [];
    factory.executeAndInspect = async (t: Task) => { executed.push(t.id); factory.recordUsage({ inputTokens: 90, outputTokens: 20 }); return { task: t, branchName: `line/${t.id}` }; };
    await factory.runWorkshopLoop();
    assert.deepEqual(executed, ['T1'], 'the second phase never started');
    assert.equal(factory.state.tasks[0].status, 'done');
    assert.equal(factory.state.tasks[1].status, 'pending', 'no task was failed by the halt');
    assert.equal(factory.state.status, 'active', 'resumable, like an environment fault');
    assert.ok(logs.some(l => /Token budget is spent: 110 of 100/.test(l)), logs.join('\n'));
    assert.deepEqual(factory.state.usage, { input_tokens: 90, output_tokens: 20 });
  });

  it('halts when the invocation time budget is spent', async () => {
    const { factory, logs } = await factoryWith({ runBudgetMinutes: 1 }, [task({ id: 'T1' }), task({ id: 'T2', phase: 2, dependencies: ['T1'] })]);
    const executed: string[] = [];
    // The budget runs out during the first phase, not before it: a 1 ms
    // budget set up front was spent by setup alone under a loaded test run.
    factory.executeAndInspect = async (t: Task) => { executed.push(t.id); factory.runBudgetMs = 1; await new Promise(r => setTimeout(r, 5)); return { task: t, branchName: `line/${t.id}` }; };
    await factory.runWorkshopLoop();
    assert.deepEqual(executed, ['T1'], 'checked between phases, so the first phase ran');
    assert.ok(logs.some(l => /Run budget of 0 minutes is spent/.test(l)), logs.join('\n'));
    assert.equal(factory.state.status, 'active');
  });

  it('is written to the metrics line', async () => {
    const { factory } = await factoryWith({}, [task({ id: 'T1' })]);
    factory.executeAndInspect = async (t: Task) => { factory.recordUsage({ inputTokens: 5, outputTokens: 7 }); return { task: t, branchName: 'line/T1' }; };
    await factory.runWorkshopLoop();
    const metrics = JSON.parse((await fs.readFile(path.join(factory.baseDir, '.softfactory', 'metrics.jsonl'), 'utf8')).trim());
    assert.deepEqual(metrics.tokens, { input: 5, output: 7 });
  });
});

describe('the tool loop honours the budget signal and reports usage', () => {
  function transport(replies: Array<{ content?: string; calls?: any[]; usage?: { inputTokens: number; outputTokens: number } }>): ChatTransport {
    let n = 0;
    return {
      id: 'x', name: 'x', label: 'X', limits: { toolOutput: 8000, fileRead: 32000 },
      contextWindow: () => 32000, timeoutMs: () => 10000,
      checkAvailability: async () => ({ reachable: true, modelPresent: true, installed: [] }),
      unreachable: () => 'u', missingModel: () => 'm',
      chat: async request => {
        if (request.messages.length === 1) return { content: '', toolCalls: [{ id: 'p', type: 'function', function: { name: 'read_file', arguments: {} } }] };
        const r = replies[n++] || { calls: [] };
        return { content: r.content || '', toolCalls: (r.calls || []).map((c, i) => ({ id: `c${n}${i}`, type: 'function' as const, function: c })), usage: r.usage };
      },
    };
  }

  it('stops at the next step after the signal fires and says so in the handoff', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-sig-'));
    await fs.writeFile(path.join(dir, 'a.txt'), 'x');
    const controller = new AbortController();
    const worker: any = new ToolLoopWorker(transport([
      { calls: [{ name: 'read_file', arguments: { filepath: 'a.txt' } }] },
      { calls: [{ name: 'read_file', arguments: { filepath: 'a.txt' } }] },
    ]), 'fake');
    worker.verifier = { verify: async () => ({ executed: true, passed: true, testSummary: 'ok', output: '' }) };
    const t: any = { id: 'T1', title: 't', agent_role: 'coder', description: 'd', files_hint: ['a.txt'], creates_files: [], attempts: 0 };
    const handoff = await worker.execute(t, dir, { diagnosticsDir: dir, signal: controller.signal, onOutput: (line: string) => { if (/Reading/.test(line)) controller.abort(); } });
    assert.equal(handoff.status, 'failure');
    assert.match(handoff.summary, /time budget ran out/);
  });

  it('forwards token usage from each reply', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-usage-'));
    await fs.writeFile(path.join(dir, 'a.txt'), 'x');
    const seen: Array<{ inputTokens: number; outputTokens: number }> = [];
    const worker: any = new ToolLoopWorker(transport([
      { calls: [{ name: 'read_file', arguments: { filepath: 'a.txt' } }], usage: { inputTokens: 10, outputTokens: 2 } },
      { calls: [{ name: 'finish_task', arguments: { summary: 's', test_summary: 't', status: 'success' } }], usage: { inputTokens: 20, outputTokens: 3 } },
    ]), 'fake');
    worker.verifier = { verify: async () => ({ executed: true, passed: true, testSummary: 'ok', output: '' }) };
    const t: any = { id: 'T1', title: 't', agent_role: 'coder', description: 'd', files_hint: ['a.txt'], creates_files: [], attempts: 0 };
    const handoff = await worker.execute(t, dir, { diagnosticsDir: dir, onUsage: u => seen.push(u) });
    assert.equal(handoff.status, 'success');
    assert.deepEqual(seen, [{ inputTokens: 10, outputTokens: 2 }, { inputTokens: 20, outputTokens: 3 }]);
  });
});

describe('what one task learns, the next task in the run is told', () => {
  it('passes run notes from other tasks into the worker prompt, never the task\'s own', async () => {
    const { factory } = await factoryWith({}, [task({ id: 'T1' }), task({ id: 'T2' })]);
    factory.addRunNote('T1', 'environment setup failed: npm ci needs the lockfile regenerated');
    factory.addRunNote('T1', 'environment setup failed: npm ci needs the lockfile regenerated');
    assert.equal(factory.runNotes.length, 1, 'deduplicated');
    assert.deepEqual(factory.notesFor('T1'), []);
    assert.match(factory.notesFor('T2')[0], /^From T1 earlier in this run: environment setup failed/);

    let received: string[] = [];
    factory.workerRegistry.resolveWorker = async () => ({
      model: 'm', provider: 'p',
      worker: { id: 's', name: 's', isAvailable: async () => true, execute: async (_t: Task, _w: string, options: any): Promise<Handoff> => { received = options.memoryPatterns; return { task_id: 'T2', status: 'success', files_changed: ['a.txt'], summary: 'ok' }; } },
    });
    await factory.executeAndInspect(factory.state.tasks[1], '/tmp/wt');
    assert.ok(received.some(n => /From T1 earlier in this run/.test(n)), received.join(' | '));
  });

  it('records a setup failure as a note for the tasks that follow', async () => {
    const { factory } = await factoryWith({}, [task({ id: 'T1' })]);
    factory.taskVerifier.prepare = async () => ({ ok: false, message: 'npm ci failed: lockfile out of date\nmore detail' });
    factory.workerRegistry.resolveWorker = async () => ({
      model: 'm', provider: 'p',
      worker: { id: 's', name: 's', isAvailable: async () => true, execute: async (): Promise<Handoff> => ({ task_id: 'T1', status: 'success', files_changed: ['a.txt'], summary: 'ok' }) },
    });
    await factory.executeAndInspect(factory.state.tasks[0], '/tmp/wt');
    assert.deepEqual(factory.runNotes, [{ taskId: 'T1', note: 'environment setup failed: npm ci failed: lockfile out of date' }]);
  });
});
