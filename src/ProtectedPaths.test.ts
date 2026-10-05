import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ProtectedPaths } from './ProtectedPaths.js';
import { WorkerRegistry } from './WorkerRegistry.js';
import { Factory } from './Factory.js';
import { Inspector } from './Inspector.js';
import type { Task, Handoff } from './types.js';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: 't', description: 'd', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
    files_hint: [], creates_files: [], acceptance_criteria: [], verification: [], status: 'pending',
    attempts: 0, escalation_level: 0, error_history: [], worker_type: 'auto', executor: 'agent',
    protected: false, review_questions: [], production_targets: [], test_targets: [], behavior_tags: [],
    ...over,
  } as Task;
}

describe('protected path globs', () => {
  const paths = new ProtectedPaths(['# auth', 'internal/auth/**', 'migrations/*', 'pkg/ledger/*.go', '']);

  it('matches the way the file says it does', () => {
    assert.deepEqual(paths.matches('internal/auth/jwt.go'), ['internal/auth/**']);
    assert.deepEqual(paths.matches('internal/auth/deep/er/x.go'), ['internal/auth/**']);
    assert.deepEqual(paths.matches('migrations/001.sql'), ['migrations/*']);
    assert.deepEqual(paths.matches('migrations/sub/002.sql'), [], '* stays within one segment');
    assert.deepEqual(paths.matches('pkg/ledger/post.go'), ['pkg/ledger/*.go']);
    assert.deepEqual(paths.matches('pkg/ledger/post.sql'), []);
    assert.deepEqual(paths.matches('./internal/auth/jwt.go'), ['internal/auth/**'], 'a leading ./ is normalised');
  });

  it('never counts a test file as protected', () => {
    assert.deepEqual(paths.matches('internal/auth/jwt_test.go'), []);
    assert.deepEqual(paths.matches('pkg/ledger/post.test.ts'), []);
  });

  it('loads from .softfactory/protected-paths.txt and is empty without one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-pp-'));
    assert.equal((await ProtectedPaths.load(dir)).size, 0);
    await fs.mkdir(path.join(dir, '.softfactory'));
    await fs.writeFile(path.join(dir, '.softfactory', 'protected-paths.txt'), '# money\nsrc/payments/**\n');
    const loaded = await ProtectedPaths.load(dir);
    assert.equal(loaded.size, 1);
    assert.deepEqual(loaded.touched(['src/payments/charge.ts', 'src/ui/x.ts']), [{ file: 'src/payments/charge.ts', glob: 'src/payments/**' }]);
  });
});

describe('protected tasks never run on the light tier', () => {
  const registry = new WorkerRegistry('hybrid');
  const small = task({ id: 'T1', files_hint: ['internal/auth/jwt.go'], phase: 1 });

  it('is light by shape but not when protected', () => {
    assert.equal(registry.isLightTask(small), true);
    assert.equal(registry.isLightTask({ ...small, protected: true }), false);
    assert.equal(registry.shouldPreferCloud({ ...small, protected: true }), true);
  });

  it('gets the heavy local model on a first attempt', () => {
    assert.equal(registry.resolveLocalModel(small, false), 'qwen2.5-coder:7b');
    assert.equal(registry.resolveLocalModel({ ...small, protected: true }, false), 'qwen2.5-coder:14b');
  });

  it('is marked at planning time from files_hint', () => {
    const factory: any = new Factory('/tmp', '', { strategy: 'local' });
    factory.protectedPaths = new ProtectedPaths(['internal/auth/**']);
    const [marked, plain] = factory.annotateTasks([small, task({ id: 'T2', files_hint: ['web/x.ts'] })]);
    assert.equal(marked.protected, true);
    assert.equal(plain.protected, false);
  });
});

async function reviewHarness(options: Record<string, unknown>, handoff: Handoff, diff: string) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-blind-'));
  const factory: any = new Factory(baseDir, '', options);
  factory.state = { feature_id: 'f-1', feature: 'test', status: 'active', strategy: options.strategy,
    cloud_provider: 'agy', planner_provider: 'local', created_at: '', last_updated: '', tasks: [], memory_patterns: [] };
  factory.saveState = async () => {};
  factory.getProjectContext = async () => '';
  factory.getDiff = async () => diff;
  factory.lessons.getRelevant = async () => [];
  factory.taskVerifier.prepare = async () => ({ ok: true });
  factory.taskVerifier.verify = async () => ({ executed: true, passed: true, testSummary: 'ok', output: 'suite green' });
  factory.workerRegistry.resolveWorker = async () => ({
    worker: { id: 'stub', name: 'stub', isAvailable: async () => true, execute: async () => handoff },
    model: 'm', provider: 'p',
  });
  factory.worktreeManager.commitWorktree = async () => ({ committed: true, filesChanged: 1 });
  return factory;
}

describe('protected diffs get the blind review on the frontier model', () => {
  const diff = 'diff --git a/src/auth/guard.ts b/src/auth/guard.ts\n--- a/src/auth/guard.ts\n+++ b/src/auth/guard.ts\n+if (!tenant) return deny();';
  const handoff: Handoff = { task_id: 'T1', status: 'success', files_changed: ['src/auth/guard.ts'], summary: 'HANDOFF_SUMMARY_SENTINEL all good',
    review_answers: ['src/auth/guard.ts:12 checks tenant before the query'] };

  it('reviews blind: no handoff summary, questions with answers, standing questions', async () => {
    const factory = await reviewHarness({ strategy: 'hybrid', cloudProvider: 'deepseek', cloudModel: 'flash', frontierModel: 'pro' }, handoff, diff);
    factory.protectedPaths = new ProtectedPaths(['src/auth/**']);
    const prompts: string[] = [];
    factory.frontierInspector = new Inspector({ provider: 'deepseek', model: 'pro', isAvailable: async () => true,
      complete: async (p: string) => { prompts.push(p); return '{"verdict":"PASS","feedback":"Checked: tenant path"}'; } });
    factory.inspector.inspect = async () => { throw new Error('the ordinary inspector must not review protected code'); };

    const t = task({ id: 'T1', files_hint: ['src/auth/guard.ts'], review_questions: ['Where is the tenant checked before the query?'] });
    const result = await factory.executeAndInspect(t, '/tmp/wt');
    assert.ok(result);
    assert.equal(t.protected, true, 'protection follows the diff, not only the plan');
    assert.equal(t.inspection, 'blind-review');
    assert.equal(t.inspector_model, 'deepseek/pro');
    assert.equal(prompts.length, 1);
    assert.doesNotMatch(prompts[0], /HANDOFF_SUMMARY_SENTINEL/, 'the reviewer never sees the worker\'s own account');
    assert.match(prompts[0], /Q1: Where is the tenant checked/);
    assert.match(prompts[0], /Worker's answer: src\/auth\/guard\.ts:12/);
    assert.match(prompts[0], /Standing questions/);
    assert.match(prompts[0], /suite green/, 'the verifier output is evidence the reviewer gets');
  });

  it('marks a task protected when its diff touches a protected path the plan did not list', async () => {
    const factory = await reviewHarness({ strategy: 'hybrid', cloudProvider: 'deepseek', cloudModel: 'flash' }, handoff, diff);
    factory.protectedPaths = new ProtectedPaths(['src/auth/**']);
    factory.frontierInspector = new Inspector({ provider: 'deepseek', model: 'flash', isAvailable: async () => true, complete: async () => '{"verdict":"FAIL","feedback":"fails open on empty tenant"}' });
    const t = task({ id: 'T1', files_hint: ['src/other.ts'] });
    const result = await factory.executeAndInspect(t, '/tmp/wt');
    assert.equal(result, null);
    assert.equal(t.protected, true);
    assert.match(t.last_feedback, /fails open/);
  });

  it('still reviews protected code in a local run, on the local model, instead of mechanical-only', async () => {
    const factory = await reviewHarness({ strategy: 'local' }, handoff, diff);
    factory.protectedPaths = new ProtectedPaths(['src/auth/**']);
    factory.frontierInspector = new Inspector({ provider: 'local', model: 'qwen2.5-coder:14b', isAvailable: async () => true, complete: async () => '{"verdict":"PASS","feedback":"Checked: all"}' });
    const t = task({ id: 'T1', files_hint: ['src/auth/guard.ts'] });
    await factory.executeAndInspect(t, '/tmp/wt');
    assert.equal(t.inspection, 'blind-review');
    assert.equal(t.inspector_model, 'local/qwen2.5-coder:14b');
  });
});
