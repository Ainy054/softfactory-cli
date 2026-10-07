import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Factory } from './Factory.js';
import { Inspector } from './Inspector.js';
import type { Task, Handoff } from './types.js';

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'T1', title: 'Add farewell', description: 'Add a farewell function', agent_role: 'coder',
    phase: 1, dependencies: [], blockedBy: [], files_hint: ['app.ts'], creates_files: [],
    acceptance_criteria: [], verification: [], status: 'pending', attempts: 0,
    escalation_level: 0, error_history: [], worker_type: 'auto', executor: 'agent', protected: false,
    review_questions: [], production_targets: [], test_targets: [], behavior_tags: [], ...over,
  } as Task;
}

const handoff: Handoff = { task_id: 'T1', status: 'success', files_changed: ['app.ts'], summary: 'done' };

/** A reviewer that returns a fixed verdict and records which method was called. */
function reviewer(provider: string, model: string, verdict: 'PASS' | 'FAIL', calls: string[]) {
  const inspector = new Inspector({ provider, model, isAvailable: async () => true, complete: async () => `{"verdict":"${verdict}","feedback":"${provider} says ${verdict}"}` });
  const original = { inspect: inspector.inspect.bind(inspector), inspectBlind: inspector.inspectBlind.bind(inspector) };
  inspector.inspect = async (...args) => { calls.push(`${provider}:inspect`); return original.inspect(...args); };
  inspector.inspectBlind = async (...args) => { calls.push(`${provider}:blind`); return original.inspectBlind(...args); };
  return inspector;
}

async function harness(options: Record<string, unknown>) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-second-'));
  const factory: any = new Factory(baseDir, '', { sandbox: 'none', ...options });
  factory.state = { feature_id: 'f-1', feature: 'test', status: 'active', strategy: options.strategy,
    cloud_provider: 'agy', planner_provider: 'local', created_at: '', last_updated: '', tasks: [], memory_patterns: [] };
  factory.saveState = async () => {};
  factory.getProjectContext = async () => '';
  factory.getDiff = async () => 'diff --git a/app.ts b/app.ts\n+farewell';
  factory.lessons.getRelevant = async () => [];
  factory.taskVerifier.prepare = async () => ({ ok: true });
  factory.taskVerifier.verify = async () => ({ executed: true, passed: true, testSummary: 'ok', output: '' });
  factory.workerRegistry.resolveWorker = async () => ({
    worker: { id: 'stub', name: 'stub', isAvailable: async () => true, execute: async () => handoff },
    model: 'm', provider: 'p',
  });
  factory.worktreeManager.commitWorktree = async () => ({ committed: true, filesChanged: 1 });
  return factory;
}

describe('--second-reviewer is parsed and required at preflight', () => {
  it('builds a reviewer on the named provider and model', () => {
    const factory: any = new Factory('/tmp', '', { strategy: 'hybrid', cloudProvider: 'deepseek', cloudModel: 'd', secondReviewer: 'anthropic/claude-sonnet-4' });
    assert.equal(factory.secondInspector.provider, 'anthropic');
    assert.equal(factory.secondInspector.model, 'claude-sonnet-4');
  });

  it('accepts every text-model provider, not a stale subset (the first dogfood run died on qwen/…)', () => {
    process.env.SOFTFACTORY_COMPAT_BASE_URL ||= 'https://x/v1';
    for (const [provider, model] of [['qwen', 'qwen3-coder-plus'], ['openai-compat', 'kimi-k2.7-code-highspeed'], ['claude-code', 'sonnet'], ['muse', 'default'], ['gemini-cli', 'gemini-2.5-pro'], ['local', 'qwen2.5-coder:7b']]) {
      const factory: any = new Factory('/tmp', '', { strategy: 'cloud', cloudProvider: 'deepseek', cloudModel: 'd', secondReviewer: `${provider}/${model}` });
      assert.equal(factory.secondInspector.provider, provider);
      assert.equal(factory.secondInspector.model, model);
    }
  });

  it('rejects a value that is not provider/model', () => {
    assert.throws(() => new Factory('/tmp', '', { secondReviewer: 'claude-sonnet-4' }), /provider\/model/);
    assert.throws(() => new Factory('/tmp', '', { secondReviewer: 'gemini/x' }), /provider one of/);
  });

  it('halts at preflight when the second reviewer is unreachable', async () => {
    const factory = await harness({ strategy: 'hybrid', cloudProvider: 'deepseek', cloudModel: 'd', secondReviewer: 'anthropic/claude-sonnet-4' });
    factory.workerRegistry.preflight = async () => ({ local: true, cloud: true, localModel: 'q', cloudModel: 'd' });
    factory.inspector.isAvailable = async () => true;
    factory.secondInspector.isAvailable = async () => false;
    await factory.logBackendPreflight();
    assert.match(factory.environmentFault, /Second reviewer \(anthropic\/claude-sonnet-4\) is unavailable/);
  });
});

describe('two reviewers on an ordinary diff', () => {
  it('merge when both pass, and the record names both', async () => {
    const factory = await harness({ strategy: 'hybrid', cloudProvider: 'deepseek', cloudModel: 'd', secondReviewer: 'anthropic/c' });
    const calls: string[] = [];
    factory.inspector = reviewer('deepseek', 'd', 'PASS', calls);
    factory.secondInspector = reviewer('anthropic', 'c', 'PASS', calls);
    factory.frontierInspector = reviewer('frontier', 'f', 'FAIL', calls);
    const task = makeTask();
    assert.ok(await factory.executeAndInspect(task, '/tmp/wt'));
    assert.equal(task.inspection, 'model');
    assert.equal(task.inspector_model, 'deepseek+anthropic/d+c');
    assert.deepEqual(calls.sort(), ['anthropic:inspect', 'deepseek:inspect'], 'the frontier reviewer is not consulted when they agree');
  });

  it('fail when both fail', async () => {
    const factory = await harness({ strategy: 'hybrid', cloudProvider: 'deepseek', cloudModel: 'd', secondReviewer: 'anthropic/c' });
    const calls: string[] = [];
    factory.inspector = reviewer('deepseek', 'd', 'FAIL', calls);
    factory.secondInspector = reviewer('anthropic', 'c', 'FAIL', calls);
    const task = makeTask();
    assert.equal(await factory.executeAndInspect(task, '/tmp/wt'), null);
    assert.equal(task.status, 'failed');
    assert.match(task.last_feedback, /deepseek\/d: deepseek says FAIL/);
    assert.match(task.last_feedback, /anthropic\/c: anthropic says FAIL/);
  });

  it('send a split decision to the blind review, whose verdict decides', async () => {
    const factory = await harness({ strategy: 'hybrid', cloudProvider: 'deepseek', cloudModel: 'd', secondReviewer: 'anthropic/c' });
    const calls: string[] = [];
    factory.inspector = reviewer('deepseek', 'd', 'PASS', calls);
    factory.secondInspector = reviewer('anthropic', 'c', 'FAIL', calls);
    factory.frontierInspector = reviewer('frontier', 'f', 'PASS', calls);
    const task = makeTask();
    assert.ok(await factory.executeAndInspect(task, '/tmp/wt'), 'the tie-break passed it');
    assert.ok(calls.includes('frontier:blind'), calls.join(','));
    assert.equal(task.inspection, 'blind-review', 'the decision that counted was the blind one');
    assert.match(task.inspector_model, /^frontier\/f \(tie-break of d\+c\)/);

    const split = await harness({ strategy: 'hybrid', cloudProvider: 'deepseek', cloudModel: 'd', secondReviewer: 'anthropic/c' });
    split.inspector = reviewer('deepseek', 'd', 'PASS', []);
    split.secondInspector = reviewer('anthropic', 'c', 'FAIL', []);
    split.frontierInspector = reviewer('frontier', 'f', 'FAIL', []);
    const rejected = makeTask();
    assert.equal(await split.executeAndInspect(rejected, '/tmp/wt'), null);
    assert.match(rejected.last_feedback, /Independent review after deepseek\/d said PASS and anthropic\/c said FAIL/);
  });
});

describe('two reviewers on a protected diff', () => {
  it('both review blind and a single FAIL rejects', async () => {
    const factory = await harness({ strategy: 'hybrid', cloudProvider: 'deepseek', cloudModel: 'd', secondReviewer: 'anthropic/c' });
    const calls: string[] = [];
    factory.inspector = reviewer('deepseek', 'd', 'PASS', calls);
    factory.frontierInspector = reviewer('frontier', 'f', 'PASS', calls);
    factory.secondInspector = reviewer('anthropic', 'c', 'FAIL', calls);
    const task = makeTask({ protected: true });
    assert.equal(await factory.executeAndInspect(task, '/tmp/wt'), null);
    assert.deepEqual(calls.sort(), ['anthropic:blind', 'frontier:blind'], 'neither reviewer saw the worker summary');
    assert.match(task.last_feedback, /Reviewers disagreed on a protected diff/);
    assert.equal(task.inspection, 'blind-review');
  });
});

describe('a local run with a second reviewer has a reviewer', () => {
  it('is no longer mechanical-only; the second reviewer is the reviewer', async () => {
    const factory = await harness({ strategy: 'local', secondReviewer: 'anthropic/c' });
    const calls: string[] = [];
    factory.inspector.inspect = async () => { throw new Error('the local inspector must not review'); };
    factory.secondInspector = reviewer('anthropic', 'c', 'PASS', calls);
    const task = makeTask();
    assert.ok(await factory.executeAndInspect(task, '/tmp/wt'));
    assert.equal(task.inspection, 'model');
    assert.equal(task.inspector_model, 'anthropic/c');
  });
});
