import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Factory } from './Factory.js';
import type { Task, Handoff } from './types.js';

/** Issue #62: a task diff that adds a credential is rejected before review and merge. */
function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: 't', description: 'd', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
    files_hint: ['src/config.py'], creates_files: [], acceptance_criteria: [], verification: [], status: 'pending',
    attempts: 0, escalation_level: 0, error_history: [], worker_type: 'auto', executor: 'agent',
    protected: false, review_questions: [], production_targets: [], test_targets: [], behavior_tags: [],
    ...over,
  } as Task;
}

const TOKEN = `ghp_${'q7Lm2Xv9'.repeat(4)}abcd`;
const HANDOFF: Handoff = { task_id: 'T1', status: 'success', files_changed: ['src/config.py'], summary: 'done' };

const diffAdding = (file: string, line: string) => [
  `diff --git a/${file} b/${file}`,
  `--- a/${file}`,
  `+++ b/${file}`,
  '@@ -0,0 +1,2 @@',
  '+import os',
  `+${line}`,
].join('\n');

async function harness(diff: string) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-secret-gate-'));
  const factory: any = new Factory(baseDir, '', { strategy: 'local' });
  factory.state = {
    feature_id: 'f-1', feature: 'test', status: 'active', strategy: 'local',
    cloud_provider: 'agy', planner_provider: 'local', created_at: '', last_updated: '', tasks: [], memory_patterns: [],
  };
  factory.saveState = async () => {};
  factory.getProjectContext = async () => '';
  factory.getDiff = async () => diff;
  factory.lessons.getRelevant = async () => [];
  factory.taskVerifier.prepare = async () => ({ ok: true });
  factory.taskVerifier.verify = async () => ({ executed: true, passed: true, testSummary: 'ok', output: 'suite green' });
  factory.taskVerifier.runAcceptance = async () => ({ ran: false, passed: true, exitCode: null, output: '', command: '' });
  factory.workerRegistry.resolveWorker = async () => ({
    worker: { id: 'stub', name: 'stub', isAvailable: async () => true, execute: async () => HANDOFF },
    model: 'm', provider: 'p',
  });
  factory.worktreeManager.commitWorktree = async () => ({ committed: true, filesChanged: 1 });
  factory.claimProblems = async () => null;
  const logs: string[] = [];
  factory.on('log', (line: string) => logs.push(line));
  const attempts: Array<{ category: string; detail: string }> = [];
  const record = factory.recordAttempt.bind(factory);
  factory.recordAttempt = async (t: Task, category: string, detail: string) => {
    attempts.push({ category, detail });
    return record(t, category, detail);
  };
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-secret-wt-'));
  return { factory, baseDir, logs, attempts, worktree };
}

describe('the secret gate rejects a diff that adds a credential', () => {
  it('rejects a hard-coded GitHub token with secret_in_diff, and never writes the value anywhere', async () => {
    const { factory, baseDir, logs, attempts, worktree } = await harness(diffAdding('src/config.py', `GITHUB_TOKEN = "${TOKEN}"`));
    const t = task({ id: 'T1' });
    assert.equal(await factory.executeAndInspect(t, worktree), null);
    assert.equal(t.status, 'failed');
    assert.ok(logs.some(l => l.startsWith('REJECTED: T1 — diff adds a credential (src/config.py:2, GitHub token)')), logs.join('\n'));
    const attempt = attempts.find(a => a.category === 'secret_in_diff');
    assert.ok(attempt, JSON.stringify(attempts));
    assert.match(t.last_feedback, /environment variable/);
    // Nothing softfactory writes may carry the value: logs, feedback, attempts, the journal and records on disk.
    const persisted = await readTree(path.join(baseDir, '.softfactory'));
    for (const text of [logs.join('\n'), t.last_feedback, JSON.stringify(attempts), JSON.stringify(t.error_history), persisted]) {
      assert.ok(!text.includes(TOKEN), `the token leaked into: ${text.slice(0, 400)}`);
    }
  });

  it('lets the retry merge once it reads the value from the environment', async () => {
    const { factory, worktree } = await harness(diffAdding('src/config.py', 'GITHUB_TOKEN = os.environ["GITHUB_TOKEN"]'));
    const t = task({ id: 'T1' });
    assert.ok(await factory.executeAndInspect(t, worktree), 'reading the environment is the fix the feedback asks for');
  });

  it('does not reject ordinary code that names a credential', async () => {
    const code = [
      'diff --git a/src/auth.ts b/src/auth.ts', '--- a/src/auth.ts', '+++ b/src/auth.ts', '@@ -0,0 +1,4 @@',
      '+const token = await getToken();',
      '+export interface Session { token: string; password?: string }',
      '+const apiKey = process.env.API_KEY;',
      "+if (!password) throw new Error('password: required');",
    ].join('\n');
    const { factory, worktree, attempts } = await harness(code);
    const t = task({ id: 'T1', files_hint: ['src/auth.ts'] });
    assert.ok(await factory.executeAndInspect(t, worktree), JSON.stringify(attempts));
  });

  it('rejects a committed .env file, and allows .env.example', async () => {
    const env = await harness(diffAdding('.env', 'DATABASE_URL=postgres://localhost/app'));
    const t1 = task({ id: 'T1', files_hint: ['.env'] });
    assert.equal(await env.factory.executeAndInspect(t1, env.worktree), null);
    assert.ok(env.logs.some(l => /REJECTED: T1 — diff adds a credential \(\.env:1, Secret file path\)/.test(l)), env.logs.join('\n'));

    const example = await harness(diffAdding('.env.example', 'API_KEY=your-api-key'));
    const t2 = task({ id: 'T2', files_hint: ['.env.example'] });
    assert.ok(await example.factory.executeAndInspect(t2, example.worktree));
  });
});

async function readTree(dir: string): Promise<string> {
  let out = '';
  let entries: Array<import('node:fs').Dirent> = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return ''; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    out += entry.isDirectory() ? await readTree(full) : await fs.readFile(full, 'utf8').catch(() => '');
  }
  return out;
}
