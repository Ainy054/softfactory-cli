import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { AgyWorker } from './AgyWorker.js';
import { buildCodexExecOptions } from './CodexWorker.js';
import { reviewTimeoutMs } from './Inspector.js';
import { Factory } from './Factory.js';
import { CURRENT_SCHEMA_VERSION, type Task, type Handoff } from './types.js';

// From the mongolbank-rates run on agy (2026-10-12): the reviewer timed out at
// 2 minutes and halted the run, and a worker inside a 15-minute attempt was
// killed at 10 minutes and reported as "no file changes".

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${over.id}`, description: 'd', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
    files_hint: ['a.txt'], creates_files: [], acceptance_criteria: [], verification: [], status: 'pending',
    attempts: 0, escalation_level: 0, error_history: [], worker_type: 'auto', executor: 'agent',
    protected: false, review_questions: [], production_targets: [], test_targets: [], behavior_tags: [],
    ...over,
  } as Task;
}

/** Put a fake `agy` that sleeps on PATH for the duration of fn. */
async function withSleepingAgy<T>(fn: (worktree: string, pidFile: string) => Promise<T>): Promise<T> {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-agy-bin-'));
  const pidFile = path.join(bin, 'pid');
  await fs.writeFile(path.join(bin, 'agy'), `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`, { mode: 0o755 });
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-agy-wt-'));
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  try { return await fn(worktree, pidFile); } finally { process.env.PATH = saved; }
}

describe('review timeout', () => {
  it('gives a CLI backend at least 8 minutes and an API backend its default', () => {
    assert.equal(reviewTimeoutMs('agy', 120_000, {}), 8 * 60_000);
    assert.equal(reviewTimeoutMs('claude-code', 240_000, {}), 8 * 60_000);
    assert.equal(reviewTimeoutMs('deepseek', 120_000, {}), 120_000);
  });

  it('honours SOFTFACTORY_INSPECTOR_TIMEOUT_MS for every backend', () => {
    assert.equal(reviewTimeoutMs('agy', 120_000, { SOFTFACTORY_INSPECTOR_TIMEOUT_MS: '900000' }), 900_000);
    assert.equal(reviewTimeoutMs('deepseek', 120_000, { SOFTFACTORY_INSPECTOR_TIMEOUT_MS: '900000' }), 900_000);
    assert.equal(reviewTimeoutMs('deepseek', 120_000, { SOFTFACTORY_INSPECTOR_TIMEOUT_MS: 'soon' }), 120_000);
  });
});

describe('CLI workers defer to the attempt budget', () => {
  it('Codex has no fixed cap when the attempt budget can stop it', () => {
    const options: any = buildCodexExecOptions('/tmp/wt', new AbortController().signal);
    assert.equal(options.timeout, undefined);
    assert.ok(options.cancelSignal);
  });

  it('agy stopped by the attempt budget reports a failure, not a finished task', async () => {
    await withSleepingAgy(async worktree => {
      const attempt = new AbortController();
      setTimeout(() => attempt.abort(), 300);
      const handoff = await new AgyWorker().execute(task({ id: 'T1' }), worktree, { signal: attempt.signal, onOutput: () => {} });
      assert.equal(handoff.status, 'failure');
      assert.match(handoff.summary, /attempt timeout/);
      assert.deepEqual(handoff.files_changed, []);
    });
  });

  it('agy killed from outside throws instead of inventing a success', async () => {
    await withSleepingAgy(async (worktree, pidFile) => {
      const execution = new AgyWorker().execute(task({ id: 'T1' }), worktree, { onOutput: () => {} });
      let pid = '';
      for (let i = 0; i < 100 && !pid; i++) {
        await new Promise(r => setTimeout(r, 100));
        pid = (await fs.readFile(pidFile, 'utf8').catch(() => '')).trim();
      }
      process.kill(Number(pid), 'SIGTERM');
      await assert.rejects(execution, /killed by SIGTERM/);
    });
  });
});

describe('an attempt that times out with nothing written', () => {
  it('is recorded as attempt_timeout, not no_file_changes', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-timeout-'));
    await fs.mkdir(path.join(baseDir, '.softfactory'), { recursive: true });
    const factory: any = new Factory(baseDir, '', { strategy: 'local', sandbox: 'none' });
    factory.state = {
      schema_version: CURRENT_SCHEMA_VERSION, feature_id: 'f-1', feature: 'timeout', status: 'active', strategy: 'local',
      cloud_provider: 'agy', planner_provider: 'local', created_at: new Date().toISOString(), last_updated: '', tasks: [task({ id: 'T1' })], memory_patterns: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    factory.saveState = async () => {};
    factory.updateHistory = async () => {};
    factory.getProjectContext = async () => '';
    factory.lessons.getRelevant = async () => [];
    factory.taskVerifier.prepare = async () => ({ ok: true });
    factory.worktreeManager.commitWorktree = async () => ({ committed: false, filesChanged: 0 });
    factory.attemptTimeoutMs = 20;
    factory.workerRegistry.resolveWorker = async () => ({
      model: 'm', provider: 'p',
      worker: { id: 'slow', name: 'slow', isAvailable: async () => true, execute: async (_t: Task, _w: string, options: any): Promise<Handoff> => {
        await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
        return { task_id: 'T1', status: 'failure', files_changed: [], summary: 'stopped' };
      } },
    });
    const t = factory.state.tasks[0];
    assert.equal(await factory.executeAndInspect(t, '/tmp/wt'), null);
    assert.match(t.last_feedback, /ran out of its \d+-minute budget before writing any file/);
    const attempts = (await fs.readFile(path.join(baseDir, '.softfactory', 'attempts.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(attempts[attempts.length - 1].category, 'attempt_timeout');
  });
});
