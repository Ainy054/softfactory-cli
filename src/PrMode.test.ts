import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { Factory } from './Factory.js';
import { ToolLoopWorker } from './ToolLoopWorker.js';
import { GitHub, type Exec } from './PullRequest.js';
import { RunJournal } from './RunJournal.js';
import type { ChatRequest, ChatReply, ChatTransport, ToolCall } from './ChatTransport.js';

/**
 * PR mode on a real temporary repository: the integration branch, the base
 * branch left alone, the pull request opened through a recorded fake gh.
 */
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: args } });

function scriptedTransport(turns: Array<(request: ChatRequest) => ChatReply>): ChatTransport {
  let calls = 0;
  return {
    id: 'scripted', name: 'Scripted Worker', label: 'Scripted', limits: { toolOutput: 8000, fileRead: 32000 },
    contextWindow: () => 32000, timeoutMs: () => 10000,
    checkAvailability: async () => ({ reachable: true, modelPresent: true, installed: ['fake'] }),
    unreachable: () => 'u', missingModel: () => 'm',
    chat: async request => {
      calls++;
      if (request.messages.length === 1 && /probe\.txt/.test(request.messages[0].content)) return { content: '', toolCalls: [call('probe', 'read_file', { filepath: 'probe.txt' })] };
      const turn = turns.shift();
      if (!turn) return { content: '', toolCalls: [call(`end${calls}`, 'finish_task', { summary: 'nothing more', test_summary: 'none', status: 'failure' })] };
      return turn(request);
    },
  };
}

const happyTurns = () => [
  () => ({ content: '', toolCalls: [call('c1', 'replace_content', { filepath: 'app.ts', target_content: "export const greet = () => 'hello';", replacement_content: "export const greet = () => 'hello';\nexport const farewell = () => 'bye';" })] }),
  () => ({ content: '', toolCalls: [call('c2', 'finish_task', { summary: 'Added farewell()', test_summary: 'grep passes', status: 'success' })] }),
];

const blueprint = {
  feature: 'Farewell greeting', requirements_covered: ['farewell'],
  tasks: [{
    id: 'T1', title: 'Add a farewell function', description: 'Export a farewell() function next to greet() in app.ts.',
    agent_role: 'coder' as const, phase: 1, dependencies: [], blockedBy: [], files_hint: ['app.ts'], creates_files: [],
    acceptance_criteria: ['app.ts exports farewell'], verification: ['grep farewell app.ts'], verification_command: 'grep farewell app.ts',
    production_targets: [], test_targets: [], behavior_tags: [], executor: 'agent' as const, review_questions: [],
  }],
};

async function repository() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-pr-'));
  const git = (...args: string[]) => execa('git', args, { cwd: dir });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'factory@example.test');
  await git('config', 'user.name', 'factory');
  await fs.writeFile(path.join(dir, 'app.ts'), "export const greet = () => 'hello';\n");
  await git('add', '.');
  await git('commit', '-q', '-m', 'init');
  return { dir, git };
}

/** A gh and git-push stand-in that records what the orchestrator asked for. */
function fakeGitHub(dir: string, existing: { number: number; url: string; isDraft: boolean } | null = null) {
  const calls: Array<{ file: string; args: string[]; input?: string }> = [];
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args, input: options?.input });
    const key = `${file} ${args.slice(0, 2).join(' ')}`;
    if (key === 'gh auth status') return { stdout: 'Logged in', stderr: '', exitCode: 0 };
    if (key === 'git push -u') return { stdout: '', stderr: '', exitCode: 0 };
    if (key === 'gh pr list') return { stdout: JSON.stringify(existing ? [existing] : []), stderr: '', exitCode: 0 };
    if (key === 'gh pr create') return { stdout: 'https://github.com/o/r/pull/42\n', stderr: '', exitCode: 0 };
    if (key === 'gh pr edit' || key === 'gh pr ready') return { stdout: '', stderr: '', exitCode: 0 };
    throw new Error(`unexpected: ${file} ${args.join(' ')}`);
  };
  return { github: new GitHub(dir, exec), calls };
}

async function factoryOn(dir: string, transport: ChatTransport, options: Record<string, unknown> = {}) {
  const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none', useDocker: false, plannerProvider: 'local', prMode: true, issue: { number: 7, url: 'https://github.com/o/r/issues/7', title: 'Add farewell' }, ...options });
  const logs: string[] = [];
  factory.on('log', (line: string) => logs.push(line));
  factory.planner = { provider: 'local', generateBlueprint: async () => blueprint, refineBlueprint: async () => blueprint };
  await factory.init();
  factory.workerRegistry.preflight = async () => ({ local: true, cloud: false, localModel: 'fake', cloudModel: '' });
  factory.workerRegistry.resolveWorker = async () => ({ worker: new ToolLoopWorker(transport, 'fake'), model: 'fake', provider: 'scripted' });
  factory.inspector.synthesizeMemory = async () => '';
  return { factory, logs };
}

describe('PR mode merges into an integration branch and opens the pull request', () => {
  it('leaves the base branch untouched, pushes softfactory/<feature>, and records the PR', async () => {
    const { dir, git } = await repository();
    const { factory, logs } = await factoryOn(dir, scriptedTransport(happyTurns()));
    const { github, calls } = fakeGitHub(dir);
    factory.github = github;
    try {
      await factory.build('add a farewell function');
      assert.equal(factory.state.status, 'completed', logs.join('\n'));
      const branch = `softfactory/${factory.state.feature_id}`;
      assert.equal(factory.state.integration_branch, branch);
      assert.equal(factory.state.base_branch, 'main');

      // The work is on the integration branch; main did not move.
      const { stdout: onBranch } = await git('show', `${branch}:app.ts`);
      assert.match(onBranch, /farewell/);
      const { stdout: onMain } = await git('show', 'main:app.ts');
      assert.doesNotMatch(onMain, /farewell/);
      const { stdout: head } = await git('rev-parse', '--abbrev-ref', 'HEAD');
      assert.equal(head.trim(), 'main', 'the checkout is handed back on the base branch');
      const { stdout: mergeSubject } = await git('log', '-1', '--format=%s', branch);
      assert.equal(mergeSubject, 'softfactory: merge T1');

      // What the orchestrator asked GitHub for.
      const keys = calls.map(c => `${c.file} ${c.args.slice(0, 2).join(' ')}`);
      assert.deepEqual(keys, ['gh auth status', 'git push -u', 'gh pr list', 'gh pr create']);
      assert.deepEqual(calls[1].args, ['push', '-u', 'origin', branch]);
      const create = calls[3];
      assert.ok(create.args.includes('--base') && create.args[create.args.indexOf('--base') + 1] === 'main');
      assert.equal(create.args[create.args.indexOf('--head') + 1], branch);
      assert.ok(!create.args.includes('--draft'), 'a completed run opens a ready PR');
      assert.equal(create.args[create.args.indexOf('--title') + 1], 'Farewell greeting (#7)');
      assert.match(create.input!, /Closes #7/);
      assert.match(create.input!, /\| T1 \| Add a farewell function \| done \| 0 \| mechanical gates only \| `grep farewell app\.ts` PASS \|/);
      assert.match(create.input!, /RESULT: PASS/);
      assert.match(create.input!, /hash-chained entries, head `[0-9a-f]{64}`, verified/);
      assert.match(create.input!, /Sandbox: UNSANDBOXED/);

      assert.deepEqual(factory.state.pull_request, { number: 42, url: 'https://github.com/o/r/pull/42', branch });
      assert.deepEqual(factory.state.source, { kind: 'issue', number: 7, url: 'https://github.com/o/r/issues/7', title: 'Add farewell' });
      const saved = JSON.parse(await fs.readFile(path.join(dir, '.softfactory', 'factory.json'), 'utf-8'));
      assert.equal(saved.pull_request.number, 42);
      const events = (await RunJournal.read(RunJournal.pathFor(dir, factory.state.feature_id))).map(e => e.event);
      assert.ok(events.includes('run:pull-request'), events.join(','));
      assert.ok(logs.some(l => /PR: https:\/\/github.com\/o\/r\/pull\/42/.test(l)));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('opens nothing when no task merged, and still returns to the base branch', async () => {
    const { dir, git } = await repository();
    const { factory, logs } = await factoryOn(dir, scriptedTransport([
      () => ({ content: '', toolCalls: [call('c1', 'finish_task', { summary: 'claimed', test_summary: 'none', status: 'success' })] }),
    ]));
    factory.autoReplanBlockedTasks = async () => {};
    const { github, calls } = fakeGitHub(dir);
    factory.github = github;
    try {
      await factory.build('add a farewell function');
      assert.equal(factory.state.status, 'failed');
      assert.deepEqual(calls, [], 'gh was never consulted');
      assert.ok(logs.some(l => /nothing merged into softfactory\//.test(l)), logs.join('\n'));
      const { stdout: head } = await git('rev-parse', '--abbrev-ref', 'HEAD');
      assert.equal(head.trim(), 'main');
      assert.equal(factory.state.pull_request, undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('updates an existing pull request on a later run and marks it ready when complete', async () => {
    const { dir } = await repository();
    const { factory } = await factoryOn(dir, scriptedTransport(happyTurns()));
    const { github, calls } = fakeGitHub(dir, { number: 42, url: 'https://github.com/o/r/pull/42', isDraft: true });
    factory.github = github;
    try {
      await factory.build('add a farewell function');
      assert.equal(factory.state.status, 'completed');
      const keys = calls.map(c => `${c.file} ${c.args.slice(0, 2).join(' ')}`);
      assert.deepEqual(keys, ['gh auth status', 'git push -u', 'gh pr list', 'gh pr edit', 'gh pr ready']);
      assert.deepEqual(factory.state.pull_request, { number: 42, url: 'https://github.com/o/r/pull/42', branch: `softfactory/${factory.state.feature_id}` });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('finishes the run and names the local branch when gh is not available', async () => {
    const { dir, git } = await repository();
    const { factory, logs } = await factoryOn(dir, scriptedTransport(happyTurns()));
    const exec: Exec = async () => { throw new Error('spawn gh ENOENT'); };
    factory.github = new GitHub(dir, exec);
    try {
      await factory.build('add a farewell function');
      assert.equal(factory.state.status, 'completed', 'the PR step never fails the run');
      assert.ok(logs.some(l => /PR: gh is not installed .*The work is on local branch softfactory\//.test(l)), logs.join('\n'));
      const { stdout: head } = await git('rev-parse', '--abbrev-ref', 'HEAD');
      assert.equal(head.trim(), 'main');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers the base branch when a crash left HEAD on the integration branch', async () => {
    const { dir, git } = await repository();
    const { factory } = await factoryOn(dir, scriptedTransport(happyTurns()));
    factory.github = fakeGitHub(dir).github;
    try {
      await factory.build('add a farewell function');
      const branch = factory.state.integration_branch;
      await git('checkout', '-q', branch);
      const again: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none', useDocker: false, plannerProvider: 'local' });
      await again.init();
      assert.equal(again.defaultBranch, 'main', 'the base is read from the state, not from wherever HEAD happens to be');
      assert.equal(again.mergeTarget(), branch);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
