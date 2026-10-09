import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Factory } from './Factory.js';
import { Inspector } from './Inspector.js';
import type { Task, Handoff } from './types.js';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: 't', description: 'd', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
    files_hint: ['src/app.ts'], creates_files: [], acceptance_criteria: [], verification: [], status: 'pending',
    attempts: 0, escalation_level: 0, error_history: [], worker_type: 'auto', executor: 'agent',
    protected: false, review_questions: [], production_targets: [], test_targets: [], behavior_tags: [],
    ...over,
  } as Task;
}

const RULES = [
  '# rules no test catches',
  'console\\.log :: no console.log in src',
  'BEGIN (RSA|OPENSSH) PRIVATE KEY :: never commit private keys',
].join('\n');

const HANDOFF: Handoff = { task_id: 'T1', status: 'success', files_changed: ['src/app.ts'], summary: 'done' };

async function worktree() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sf-rules-wt-'));
}

/** A gateHarness-like stub: a real Factory with the worktree, worker and verifier faked out. */
async function harness(diff: string, options: Record<string, unknown> = {}) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-rules-'));
  await fs.mkdir(path.join(baseDir, '.softfactory'), { recursive: true });
  await fs.writeFile(path.join(baseDir, '.softfactory', 'non-negotiables.txt'), RULES);

  const factory: any = new Factory(baseDir, '', { strategy: 'local', ...options });
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
  return { factory, baseDir, logs, attempts };
}

const violating = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '+console.log("card 4111");',
  '+const pem = "BEGIN RSA PRIVATE KEY";',
].join('\n');

const clean = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '+export const total = (a: number) => a;',
].join('\n');

describe('project rules scan is wired into the Factory gate', () => {
  it('rejects a violating diff, logs it, records project_rule and lists every violation', async () => {
    const { factory, logs, attempts } = await harness(violating);
    const t = task({ id: 'T1' });
    const result = await factory.executeAndInspect(t, await worktree());

    assert.equal(result, null, 'the attempt must fail');
    assert.equal(t.status, 'failed');
    assert.ok(
      logs.includes('REJECTED: T1 — breaks project rule "no console.log in src" in src/app.ts'),
      `expected the console.log rejection log, got:\n${logs.join('\n')}`,
    );
    assert.ok(
      logs.includes('REJECTED: T1 — breaks project rule "never commit private keys" in src/app.ts'),
      `expected the private-key rejection log, got:\n${logs.join('\n')}`,
    );

    const ruleAttempt = attempts.find(a => a.category === 'project_rule');
    assert.ok(ruleAttempt, 'recordAttempt must be called with category project_rule');
    assert.match(ruleAttempt!.detail, /no console\.log in src/);
    assert.match(ruleAttempt!.detail, /never commit private keys/);
    assert.match(t.last_feedback, /no console\.log in src/);
    assert.match(t.last_feedback, /never commit private keys/);
  });

  it('appends the loaded rules to the reviewer evidence before review', async () => {
    const { factory } = await harness(clean, { strategy: 'hybrid', cloudProvider: 'deepseek', cloudModel: 'flash' });
    const prompts: string[] = [];
    factory.inspector = new Inspector({
      provider: 'deepseek', model: 'flash', isAvailable: async () => true,
      complete: async (p: string) => { prompts.push(p); return '{"verdict":"PASS","feedback":"ok"}'; },
    });

    const t = task({ id: 'T1' });
    const result = await factory.executeAndInspect(t, await worktree());
    assert.ok(result, 'a clean diff still merges');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /non-negotiables\.txt/, 'the reviewer sees where the rules come from');
    assert.match(prompts[0], /no console\.log in src/, 'the reviewer sees the rule text');
    assert.match(prompts[0], /never commit private keys/);
  });

  it('loads the rules once per run and caches them', async () => {
    const { factory, baseDir } = await harness(violating);

    // Two direct loads return the same array: the file is not re-read.
    const first = await factory.loadProjectRules();
    const second = await factory.loadProjectRules();
    assert.equal(first, second, 'the rules are cached on the Factory instance');
    assert.equal(first.length, 2);

    const t1 = task({ id: 'T1' });
    assert.equal(await factory.executeAndInspect(t1, await worktree()), null);

    // Replace the rules with one that cannot match the still-violating diff.
    await fs.writeFile(path.join(baseDir, '.softfactory', 'non-negotiables.txt'), 'ZZZ_NEVER_MATCHES :: gone\n');

    const t2 = task({ id: 'T2' });
    assert.equal(
      await factory.executeAndInspect(t2, await worktree()),
      null,
      'the cached rules still reject; the file was not re-read',
    );
    assert.equal(t2.status, 'failed');
  });
});
