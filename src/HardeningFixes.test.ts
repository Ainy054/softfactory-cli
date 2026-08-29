import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { WorkerRegistry } from './WorkerRegistry.js';
import { LocalAgentWorker } from './LocalAgentWorker.js';
import { TaskVerifier } from './TaskVerifier.js';
import { AgyClient } from './GeminiClient.js';
import { isEnvironmentFailure } from './IWorker.js';
import { Factory } from './Factory.js';
import { Task } from './types.js';

function task(over: Partial<Task> & { id: string }): Task {
  return { title: 't', description: 'd', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
    files_hint: [], creates_files: [], acceptance_criteria: [], verification: [], status: 'pending',
    attempts: 0, escalation_level: 0, error_history: [], worker_type: 'auto', ...over } as Task;
}

describe('isLightTask routes on task shape, not agent_role', () => {
  const r = new WorkerRegistry();
  it('does not call a multi-file devops task light', () => {
    // This is godo's T1: it was sent to the 7B model four runs in a row.
    assert.equal(r.isLightTask(task({ id: 'T1', agent_role: 'devops', phase: 1,
      files_hint: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.json', 'f.js'], creates_files: ['f.js'] })), false);
  });
  it('does not call a long-specced task light', () => {
    assert.equal(r.isLightTask(task({ id: 'T2', agent_role: 'devops', files_hint: ['a.ts'],
      description: 'x'.repeat(700) })), false);
  });
  it('still calls a genuinely small early task light', () => {
    assert.equal(r.isLightTask(task({ id: 'T3', agent_role: 'devops', phase: 1, files_hint: ['a.ts'] })), true);
  });
});

describe('local context window', () => {
  it('keeps a large model inside RAM on a small host', () => {
    // A 14B at 8192 is ~10 GB resident. On a 16 GB machine that swaps and the
    // worker stops completing turns entirely — observed live, 0 tool calls in
    // 5 minutes where the 7B was landing one every few seconds.
    const w: any = new LocalAgentWorker();
    const totalGb = os.totalmem() / 1024 ** 3;
    const expected = totalGb < 32 ? 4096 : 8192;
    assert.equal(w.getSafeContextWindow('qwen2.5-coder:14b'), expected);
  });
  it('never shrinks the window for a small model', () => {
    assert.equal(new LocalAgentWorker().getSafeContextWindow('qwen2.5-coder:7b'), 8192);
  });
  it('honours SOFTFACTORY_LOCAL_NUM_CTX for low-memory machines', () => {
    process.env.SOFTFACTORY_LOCAL_NUM_CTX = '4096';
    try { assert.equal(new LocalAgentWorker().getSafeContextWindow('qwen2.5-coder:14b'), 4096); }
    finally { delete process.env.SOFTFACTORY_LOCAL_NUM_CTX; }
  });
});

describe('command allowlist', () => {
  const guard = (c: string) => (new LocalAgentWorker() as any).assertAllowedCommand(c);
  it('closes the --eval / -p / git-alias escapes', () => {
    for (const c of ['node --eval "x"', 'node -p "x"', 'python3 -c "x"', 'node -e "x"',
                     'git -c alias.z=!id z', 'npx cowsay', 'curl example.com', 'npm test && curl x']) {
      assert.throws(() => guard(c), new RegExp('.'), `must reject: ${c}`);
    }
  });
  it('still allows ordinary test commands', () => {
    for (const c of ['npm test', 'go test ./...', 'pytest -q', 'vitest run']) {
      assert.doesNotThrow(() => guard(c), `must allow: ${c}`);
    }
  });
});

describe('inspector fails closed', () => {
  it('raises an environment fault when inference is unavailable, never PASS', async () => {
    const client: any = new AgyClient(undefined, 'unreachable-model', 'unreachable-model');
    client.callLlm = async () => { throw new Error('Inference failed across both cloud agy and local Ollama.'); };
    await assert.rejects(() => client.inspectTask(task({ id: 'T1' }), 'diff', 'summary'), isEnvironmentFailure);
  });
  it('returns FAIL, not PASS, when the inspector output is unreadable', async () => {
    const client: any = new AgyClient();
    client.callLlm = async () => 'I think it looks fine to me!';
    assert.equal((await client.inspectTask(task({ id: 'T1' }), 'diff', 'summary')).verdict, 'FAIL');
  });
});

describe('verifier is project-agnostic', () => {
  it('injects no project-specific env unless .softfactory/config.json asks', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-cfg-'));
    const cfg = await (new TaskVerifier() as any).projectConfig(dir);
    assert.deepEqual(cfg.testEnv, {});
    assert.equal(cfg.tolerateOfflineDbFailures, false);
  });
  it('reads overrides from .softfactory/config.json', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-cfg2-'));
    await fs.mkdir(path.join(dir, '.softfactory'), { recursive: true });
    await fs.writeFile(path.join(dir, '.softfactory', 'config.json'),
      JSON.stringify({ testEnv: { GODO_ENV: 'test' }, tolerateOfflineDbFailures: true, neverTolerateFailures: ['TestFormat'] }));
    const cfg = await (new TaskVerifier() as any).projectConfig(dir);
    assert.deepEqual(cfg.testEnv, { GODO_ENV: 'test' });
    assert.equal(cfg.tolerateOfflineDbFailures, true);
    assert.deepEqual(cfg.neverTolerateFailures, ['TestFormat']);
  });
});

describe('Factory.shutdown honours what the signal handler promises', () => {
  it('resets in-flight tasks to pending and cleans up their worktrees', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-shutdown-'));
    const factory: any = new Factory(baseDir, '', { strategy: 'local' });
    factory.state = { feature_id: 'f-1', feature: 'x', status: 'active', strategy: 'local',
      cloud_provider: 'agy', planner_provider: 'local', created_at: '', last_updated: '',
      tasks: [task({ id: 'T1', status: 'active' }), task({ id: 'T2', status: 'pending' })], memory_patterns: [] };
    factory.saveState = async () => {};
    const cleaned: string[] = [];
    factory.worktreeManager.cleanup = async (id: string) => { cleaned.push(id); };

    const result = await factory.shutdown();
    assert.equal(result.reset, 1);
    assert.equal(factory.state.tasks[0].status, 'pending', 'the interrupted task must be resumable');
    assert.deepEqual(cleaned, ['T1'], 'its worktree must not leak');
  });
});
