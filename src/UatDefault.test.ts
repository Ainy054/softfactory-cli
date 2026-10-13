import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { Factory } from './Factory.js';
import { ToolLoopWorker } from './ToolLoopWorker.js';
import { UAT_FILE, UatSchema, loadUat, runUat, type ShellRunner } from './Uat.js';
import type { ChatRequest, ChatReply, ChatTransport, ToolCall } from './ChatTransport.js';

/**
 * "A run with no live check ends unverified": the planner proposes the UAT for
 * a runnable feature, the factory adopts it into the orchestrator-owned
 * .softfactory/uat.json, its probes run against the live system at the end, and
 * a run that never proved the running system ends verified:false with the
 * UNVERIFIED line. Only the model is faked here, the way EndToEnd.test.ts does
 * it; UAT's shell is injected so no real stack is started.
 */

type Turn = (request: ChatRequest) => ChatReply;

function scriptedTransport(turns: Turn[]): ChatTransport & { requests: ChatRequest[] } {
  let calls = 0;
  const requests: ChatRequest[] = [];
  return {
    id: 'scripted', name: 'Scripted Worker', label: 'Scripted', limits: { toolOutput: 8000, fileRead: 32000 }, requests,
    contextWindow: () => 32000,
    timeoutMs: () => 10000,
    checkAvailability: async () => ({ reachable: true, modelPresent: true, installed: ['fake'] }),
    unreachable: () => 'scripted transport unreachable',
    missingModel: () => 'scripted model missing',
    chat: async request => {
      requests.push(request);
      calls++;
      // The tool-support probe comes first, every attempt.
      if (request.messages.length === 1 && /probe\.txt/.test(request.messages[0].content)) {
        return { content: '', toolCalls: [call('probe', 'read_file', { filepath: 'probe.txt' })] };
      }
      const turn = turns.shift();
      if (!turn) return { content: '', toolCalls: [call(`end${calls}`, 'finish_task', { summary: 'nothing more to do', test_summary: 'none', status: 'failure' })] };
      return turn(request);
    },
  };
}

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: args } });

function blueprint(uat?: unknown) {
  return {
    feature: 'Rates service',
    requirements_covered: ['a rates endpoint'],
    ...(uat ? { uat } : {}),
    tasks: [{
      id: 'T1', title: 'Add a rates endpoint', description: 'Export a rates() function from app.ts that returns real rates.',
      agent_role: 'coder' as const, phase: 1, dependencies: [], blockedBy: [], files_hint: ['app.ts'], creates_files: [],
      acceptance_criteria: ['app.ts exports rates'], verification: ['grep rates app.ts'], verification_command: 'grep rates app.ts',
      production_targets: [], test_targets: [], behavior_tags: [], executor: 'agent' as const, review_questions: [],
    }],
  };
}

/** The four model turns a happy path needs: read, edit, run the acceptance command, finish. */
function happyTurns(): Turn[] {
  return [
    () => ({ content: 'Reading the file first.', toolCalls: [call('c1', 'read_file', { filepath: 'app.ts' })] }),
    () => ({ content: '', toolCalls: [call('c2', 'replace_content', {
      filepath: 'app.ts', target_content: "export const greet = () => 'hello';",
      replacement_content: "export const greet = () => 'hello';\nexport const rates = () => [{ currency: 'USD', rate: 1 }];",
    })] }),
    () => ({ content: '', toolCalls: [call('c3', 'run_command', { command: 'grep rates app.ts' })] }),
    () => ({ content: '', toolCalls: [call('c4', 'finish_task', { summary: 'Added rates()', test_summary: 'grep passes', status: 'success' })] }),
  ];
}

async function repository() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-uat-default-'));
  const git = (...args: string[]) => execa('git', args, { cwd: dir });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'factory@example.test');
  await git('config', 'user.name', 'factory');
  await fs.writeFile(path.join(dir, 'app.ts'), "export const greet = () => 'hello';\n");
  await fs.writeFile(path.join(dir, 'README.md'), '# demo\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'init');
  return { dir, git };
}

async function factoryOn(dir: string, transport: ChatTransport, plan: unknown) {
  const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none', useDocker: false, plannerProvider: 'local' });
  const logs: string[] = [];
  factory.on('log', (line: string) => logs.push(line));
  factory.planner = { provider: 'local', generateBlueprint: async () => plan, refineBlueprint: async () => plan };
  await factory.init();
  factory.workerRegistry.preflight = async () => ({ local: true, cloud: false, localModel: 'fake', cloudModel: '' });
  factory.workerRegistry.resolveWorker = async () => ({ worker: new ToolLoopWorker(transport, 'fake'), model: 'fake', provider: 'scripted' });
  // The only model call left on the happy path; a live Ollama must not be consulted by a test.
  factory.inspector.synthesizeMemory = async () => '';
  return { factory, logs };
}

describe('UAT by default: the planner proposes the live check', () => {
  it('writes uat.json for a blueprint with uat and runs its probes at the end, ending verified', async () => {
    const { dir } = await repository();
    const plan = blueprint({
      setup: ['start the rates server'],
      probes: [{ name: 'latest rates', run: 'curl -fsS http://localhost:8080/rates/latest', expect: '\\[\\s*\\{[^\\]]*"currency"' }],
    });
    const { factory, logs } = await factoryOn(dir, scriptedTransport(happyTurns()), plan);
    const commands: string[] = [];
    factory.uatShell = (async (command: string) => {
      commands.push(command);
      return { exitCode: 0, output: command.includes('/rates/latest') ? '[{"currency":"USD","rate":1}]' : 'started' };
    }) as ShellRunner;
    try {
      await factory.build('a rates service');

      assert.equal(factory.state.status, 'completed', logs.join('\n'));
      const adopted = await loadUat(dir);
      assert.ok(adopted, 'the planner UAT was written to .softfactory/uat.json');
      assert.deepEqual(adopted.probes.map(p => p.name), ['latest rates']);
      assert.ok(commands.some(c => c.includes('/rates/latest')), 'the adopted probe ran at the end');
      assert.match(logs.join('\n'), /UAT: adopted the planner's live check \(1 probes\)\./);
      assert.match(logs.join('\n'), /UAT PASS — probe: latest rates/);
      assert.equal(factory.state.uat_result, 'passed');
      assert.equal(factory.state.verified, true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('never overwrites an existing uat.json', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-uat-existing-'));
    try {
      await fs.mkdir(path.join(dir, '.softfactory'), { recursive: true });
      const raw = `${JSON.stringify({ probes: [{ name: 'project probe', run: 'curl -fsS http://localhost:8080/health' }], timeout_seconds: 30 }, null, 2)}\n`;
      await fs.writeFile(path.join(dir, UAT_FILE), raw);
      const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none', useDocker: false, plannerProvider: 'local' });
      await factory.adoptPlannerUat({ uat: { setup: [], probes: [{ name: 'planner probe', run: 'curl -fsS http://localhost:8080/other' }] } });

      assert.equal(await fs.readFile(path.join(dir, UAT_FILE), 'utf-8'), raw, 'the project file is untouched');
      const loaded = await loadUat(dir);
      assert.deepEqual(loaded?.probes.map(p => p.name), ['project probe']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('UAT probes require real data', () => {
  const expectObject = '\\[\\s*\\{[^\\]]*"currency"';

  it('fails a probe whose expect requires an object when the endpoint prints []', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-uat-empty-'));
    try {
      const config = UatSchema.parse({ probes: [{ name: 'latest rates', run: 'curl -fsS http://localhost:8080/rates/latest', expect: expectObject }] });
      const result = await runUat(dir, config, { runId: 'run', featureId: 'F1', shell: async () => ({ exitCode: 0, output: '[]' }) });

      assert.equal(result.passed, false, 'an empty list is not proof the feature works');
      const step = result.steps.find(s => s.name === 'probe: latest rates');
      assert.ok(step);
      assert.equal(step.passed, false);
      assert.match(step.detail, /did not match/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('passes the same probe when the endpoint prints an object with the promised field', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-uat-real-'));
    try {
      const config = UatSchema.parse({ probes: [{ name: 'latest rates', run: 'curl -fsS http://localhost:8080/rates/latest', expect: expectObject }] });
      const result = await runUat(dir, config, { runId: 'run', featureId: 'F1', shell: async () => ({ exitCode: 0, output: '[\n  {"currency":"USD","rate":1}\n]' }) });

      assert.equal(result.passed, true);
      assert.equal(result.steps.find(s => s.name === 'probe: latest rates')?.passed, true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('a completed run with no live check', () => {
  it('ends verified:false with the UNVERIFIED log line', async () => {
    const { dir } = await repository();
    const { factory, logs } = await factoryOn(dir, scriptedTransport(happyTurns()), blueprint());
    try {
      await factory.build('a rates service');

      assert.equal(factory.state.status, 'completed', logs.join('\n'));
      assert.equal(factory.state.uat_result, 'none');
      assert.equal(factory.state.verified, false);
      assert.match(logs.join('\n'), /COMPLETED — UNVERIFIED: no live check ran; the tests are the only evidence\./);
      // No uat.json was conjured out of thin air for a blueprint that has none.
      assert.equal(await fs.access(path.join(dir, UAT_FILE)).then(() => true, () => false), false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
