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
    production_targets: [], test_targets: [], behavior_tags: [], executor: 'agent' as const, promotion: 'test' as const, review_questions: [],
  }],
};

async function repository() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-promo-'));
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

async function factoryOn(dir: string, environment?: Record<string, unknown>, failing: string[] = []) {
  if (environment) {
    await fs.mkdir(path.join(dir, '.softfactory'), { recursive: true });
    await fs.writeFile(path.join(dir, '.softfactory', 'environment.json'), JSON.stringify(environment));
  }
  const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none', useDocker: false, plannerProvider: 'local', prMode: true, issue: { number: 7, url: 'https://github.com/o/r/issues/7', title: 'Add farewell' } });
  const logs: string[] = [];
  factory.on('log', (line: string) => logs.push(line));
  factory.planner = { provider: 'local', generateBlueprint: async () => blueprint, refineBlueprint: async () => blueprint };
  await factory.init();
  factory.workerRegistry.preflight = async () => ({ local: true, cloud: false, localModel: 'fake', cloudModel: '' });
  factory.workerRegistry.resolveWorker = async () => ({ worker: new ToolLoopWorker(scriptedTransport(happyTurns()), 'fake'), model: 'fake', provider: 'scripted' });
  factory.inspector.synthesizeMemory = async () => '';
  const deploys: Array<{ command: string; env: NodeJS.ProcessEnv }> = [];
  factory.deployShell = async (command: string, options: { env: NodeJS.ProcessEnv }) => {
    deploys.push({ command, env: options.env });
    return { exitCode: failing.includes(command) ? 1 : 0, output: `ran ${command}` };
  };
  const uatEnvs: Array<Record<string, string> | undefined> = [];
  const realUat = factory.uatGate.bind(factory);
  factory.uatGate = async (env?: Record<string, string>) => { uatEnvs.push(env); return realUat(env); };
  const { github, calls } = fakeGitHub(dir);
  factory.github = github;
  return { factory, logs, deploys, uatEnvs, calls };
}

const ENV = {
  live: 'production at https://app.example.com',
  test_env: { name: 'STAGING', deploy: './deploy.sh test', url: 'https://test.example.com' },
  production: { deploy: './deploy.sh prod' },
};

describe('issue #48: promotion-marked work stops at TEST', () => {
  it('deploys to TEST, runs UAT there, holds production, and keeps the PR a draft', async () => {
    const { dir } = await repository();
    const { factory, logs, deploys, uatEnvs, calls } = await factoryOn(dir, ENV);
    await factory.build('add a farewell function');
    assert.equal(factory.state.status, 'completed', logs.join('\n'));
    assert.deepEqual(deploys.map(d => d.command), ['./deploy.sh test'], 'production is never deployed by a run');
    assert.deepEqual(uatEnvs, [{ SOFTFACTORY_TARGET: 'test', SOFTFACTORY_BASE_URL: 'https://test.example.com' }]);
    assert.deepEqual(factory.state.promotion, { status: 'pending', tasks: ['T1'], test_env: 'STAGING' });
    assert.ok(logs.some(l => /PROMOTION PENDING: T1 passed at STAGING/.test(l)), logs.join('\n'));
    const create = calls.find(c => c.args[0] === 'pr' && c.args[1] === 'create')!;
    assert.ok(create.args.includes('--draft'), 'the PR stays a draft until production is decided');
    assert.ok(logs.some(l => /draft until production promotion is decided/.test(l)));
    const evidence = await fs.readFile(path.join(dir, '.softfactory', 'evidence', factory.state.feature_id, 'test-deploy.log'), 'utf8');
    assert.match(evidence, /RESULT: PASS/);
  });

  it('--promote now runs the production deploy and marks the PR ready; later and no deploy nothing', async () => {
    const { dir } = await repository();
    const { factory, deploys, calls } = await factoryOn(dir, ENV);
    await factory.build('add a farewell function');
    const id = factory.state.feature_id;
    await factory.promote(id, 'later', 'after the release freeze');
    assert.equal(factory.state.promotion.status, 'later');
    assert.equal(factory.state.promotion.note, 'after the release freeze');
    assert.deepEqual(deploys.map(d => d.command), ['./deploy.sh test']);
    await factory.promote(id, 'now');
    assert.deepEqual(deploys.map(d => d.command), ['./deploy.sh test', './deploy.sh prod']);
    assert.equal(factory.state.promotion.status, 'promoted');
    assert.ok(calls.some(c => c.args[0] === 'pr' && c.args[1] === 'ready'), 'the PR is marked ready once promoted');
    await assert.rejects(factory.promote(id, 'now'), /already promoted/);
  });

  it('a failed production deploy promotes nothing', async () => {
    const { dir } = await repository();
    const { factory } = await factoryOn(dir, ENV, ['./deploy.sh prod']);
    await factory.build('add a farewell function');
    await assert.rejects(factory.promote(factory.state.feature_id, 'now'), /production deploy exited non-zero/);
    assert.equal(factory.state.promotion.status, 'pending');
  });

  it('a failed TEST deploy fails the run', async () => {
    const { dir } = await repository();
    const { factory, logs } = await factoryOn(dir, ENV, ['./deploy.sh test']);
    await factory.build('add a farewell function');
    assert.equal(factory.state.status, 'failed');
    assert.equal(factory.state.promotion, undefined);
    assert.ok(logs.some(l => /PROMOTION FAILED: the STAGING deploy exited non-zero/.test(l)), logs.join('\n'));
  });

  it('without a TEST environment the field is ignored, and said so', async () => {
    const { dir } = await repository();
    const { factory, logs, deploys, calls } = await factoryOn(dir, { live: 'there is no production; this host is dev' });
    await factory.build('add a farewell function');
    assert.equal(factory.state.status, 'completed');
    assert.equal(factory.state.promotion, undefined);
    assert.deepEqual(deploys, []);
    assert.ok(logs.some(l => /marked "test", but environment.json defines no test_env; the field is ignored/.test(l)), logs.join('\n'));
    const create = calls.find(c => c.args[0] === 'pr' && c.args[1] === 'create')!;
    assert.ok(!create.args.includes('--draft'));
  });

  it('refuses --promote now without a production deploy in environment.json', async () => {
    const { dir } = await repository();
    const { factory } = await factoryOn(dir, { live: 'prod elsewhere', test_env: { deploy: './deploy.sh test' } });
    await factory.build('add a farewell function');
    await assert.rejects(factory.promote(factory.state.feature_id, 'now'), /defines no production deploy/);
  });
});
