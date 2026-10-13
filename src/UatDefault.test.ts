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
 * "an adopted live check belongs to its run": the planner proposes the UAT for
 * a runnable feature, the factory adopts it into that run's state
 * (state.planned_uat), its probes run against the live system at the end, and
 * nothing is written to .softfactory/uat.json, so a later run inherits nothing.
 * Probes that only re-run the test suite are dropped, because the gates already
 * ran it. Only the model is faked here, the way EndToEnd.test.ts does it; UAT's
 * shell is injected so no real stack is started.
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

/** A factory with its logs collected and an empty state, for direct adopt/definition calls. */
async function bareFactory(dir: string) {
  const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none', useDocker: false, plannerProvider: 'local' });
  const logs: string[] = [];
  factory.on('log', (line: string) => logs.push(line));
  await factory.init();
  factory.state = { tasks: [] };
  return { factory, logs };
}

const noFile = async (dir: string) => fs.access(path.join(dir, UAT_FILE)).then(() => true, () => false);

describe('UAT by default: the planner proposes the live check', () => {
  it('keeps the adopted live check in the run state and writes no uat.json', async () => {
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
      assert.deepEqual(factory.state.planned_uat?.setup, ['start the rates server']);
      assert.deepEqual(factory.state.planned_uat?.probes.map((p: { name: string }) => p.name), ['latest rates']);
      // The proposal belongs to the run, not to the shared project file.
      assert.equal(await noFile(dir), false, 'adopting must not write .softfactory/uat.json');
      assert.equal(await loadUat(dir), undefined, 'nothing is inherited from the run');
      assert.ok(commands.some(c => c.includes('/rates/latest')), 'the adopted probe ran at the end');
      assert.match(logs.join('\n'), /UAT: adopted the planner's live check \(1 probes\)\./);
      assert.match(logs.join('\n'), /UAT: running the plan's live check \(1 probes\)\./);
      assert.match(logs.join('\n'), /UAT PASS — probe: latest rates/);
      assert.equal(factory.state.uat_result, 'passed');
      assert.equal(factory.state.verified, true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("uatDefinition runs the plan's probes when there is no uat.json", async () => {
    const { dir } = await repository();
    const { factory, logs } = await bareFactory(dir);
    try {
      await factory.adoptPlannerUat({ uat: { setup: ['start the rates server'], probes: [{ name: 'latest rates', run: 'curl -fsS http://localhost:8080/rates/latest' }] } });
      assert.deepEqual(factory.state.planned_uat.probes.map((p: { name: string }) => p.name), ['latest rates']);

      const defined = await factory.uatDefinition();

      assert.ok(defined, 'the plan\'s live check is this run\'s UAT definition');
      assert.deepEqual(defined.config.setup, ['start the rates server']);
      assert.deepEqual(defined.config.probes.map((p: { name: string }) => p.name), ['latest rates']);
      assert.match(logs.join('\n'), /UAT: running the plan's live check \(1 probes\)\./);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("an existing uat.json wins over the plan's stored live check", async () => {
    const { dir } = await repository();
    try {
      await fs.mkdir(path.join(dir, '.softfactory'), { recursive: true });
      const raw = `${JSON.stringify({ probes: [{ name: 'project probe', run: 'curl -fsS http://localhost:8080/health' }], timeout_seconds: 30 }, null, 2)}\n`;
      await fs.writeFile(path.join(dir, UAT_FILE), raw);
      const { factory, logs } = await bareFactory(dir);
      factory.state.planned_uat = { setup: [], probes: [{ name: 'planner probe', run: 'curl -fsS http://localhost:8080/other' }] };

      await factory.adoptPlannerUat({ uat: { setup: [], probes: [{ name: 'planner probe', run: 'curl -fsS http://localhost:8080/other' }] } });

      assert.equal(await fs.readFile(path.join(dir, UAT_FILE), 'utf-8'), raw, 'the project file is untouched');
      const loaded = await loadUat(dir);
      assert.deepEqual(loaded?.probes.map(p => p.name), ['project probe']);

      const defined = await factory.uatDefinition();
      assert.deepEqual(defined?.config.probes.map((p: { name: string }) => p.name), ['project probe'], 'the project file, not the plan, defines the check');
      assert.doesNotMatch(logs.join('\n'), /running the plan's live check/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('drops a probe that runs the test suite and keeps the curl probe', async () => {
    const { dir } = await repository();
    const { factory, logs } = await bareFactory(dir);
    try {
      await factory.adoptPlannerUat({ uat: { setup: [], probes: [
        { name: 'Swallowed error detector tests pass', run: 'npm test -- src/SwallowedErrors.test.ts' },
        { name: 'latest rates', run: 'curl -fsS http://localhost:8080/rates/latest' },
      ] } });

      assert.deepEqual(factory.state.planned_uat.probes.map((p: { name: string }) => p.name), ['latest rates']);
      assert.match(logs.join('\n'), /UAT: dropped probe "Swallowed error detector tests pass": it runs the test suite, which the gates already did\./);
      assert.match(logs.join('\n'), /UAT: adopted the planner's live check \(1 probes\)\./);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("adopts nothing when the plan's only probe is a test runner", async () => {
    const { dir } = await repository();
    const { factory, logs } = await bareFactory(dir);
    try {
      await factory.adoptPlannerUat({ uat: { setup: ['npm install'], probes: [{ name: 'Swallowed error detector tests pass', run: 'npm test -- src/SwallowedErrors.test.ts' }] } });

      assert.equal(factory.state.planned_uat, undefined, 'a unit test is not a live check');
      assert.match(logs.join('\n'), /UAT: dropped probe "Swallowed error detector tests pass"/);
      assert.doesNotMatch(logs.join('\n'), /adopted the planner's live check/);
      // No stored check and no file: this run has no live check at all.
      assert.equal(await factory.uatDefinition(), undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('a second run in the same repository starts with no UAT from the first', async () => {
    const { dir } = await repository();
    const plan = blueprint({
      setup: ['start the rates server'],
      probes: [{ name: 'latest rates', run: 'curl -fsS http://localhost:8080/rates/latest' }],
    });
    const first = await factoryOn(dir, scriptedTransport(happyTurns()), plan);
    first.factory.uatShell = (async (command: string) => ({ exitCode: 0, output: command.includes('/rates/latest') ? '[{"currency":"USD"}]' : 'started' })) as ShellRunner;
    try {
      await first.factory.build('a rates service');
      assert.equal(first.factory.state.verified, true, first.logs.join('\n'));
      assert.ok(first.factory.state.planned_uat, 'the first run kept its live check in its own state');
      // The check was never persisted, so a later run cannot inherit it.
      assert.equal(await loadUat(dir), undefined);
      assert.equal(await noFile(dir), false);

      // Reset the demo so the same happy path applies to a genuinely fresh run.
      await fs.writeFile(path.join(dir, 'app.ts'), "export const greet = () => 'hello';\n");
      await execa('git', ['commit', '-am', 'reset app.ts for the second run'], { cwd: dir, reject: false });

      const second = await factoryOn(dir, scriptedTransport(happyTurns()), blueprint());
      await second.factory.build('a rates service');

      assert.equal(second.factory.state.status, 'completed', second.logs.join('\n'));
      assert.equal(second.factory.state.planned_uat, undefined, 'the second run planned without the first run\'s check');
      assert.equal(second.factory.state.uat_result, 'none');
      assert.equal(second.factory.state.verified, false);
      assert.doesNotMatch(second.logs.join('\n'), /running the plan's live check/);
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
      assert.equal(await noFile(dir), false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('a planner live check with an empty expect', () => {
  it('treats an empty expect from strict output as no expectation, and requires a command', async () => {
    const { BlueprintUatSchema } = await import('./Planner.js');
    assert.equal(BlueprintUatSchema.parse({ setup: [], probes: [{ name: 'p', run: 'curl x', expect: '' }] }).probes[0].expect, undefined);
    assert.throws(() => BlueprintUatSchema.parse({ probes: [{ name: 'p', run: '' }] }));
  });
});

describe('a probe that only runs the test suite is recognised in its usual forms', () => {
  it('matches runners wherever they sit in the command, and leaves real probes alone', async () => {
    const { isTestRunnerProbe } = await import('./Factory.js');
    for (const run of [
      'npm test -- src/SwallowedErrors.test.ts', 'node --import tsx --test src/x.test.ts', 'npm --prefix web test',
      'npm run test:unit', 'yarn run test', 'python3 -m pytest -q', 'cd app && pytest', 'make test', 'bun test',
      'go test ./...', 'npx vitest run',
    ]) assert.equal(isTestRunnerProbe(run), true, run);
    for (const run of [
      "curl -fsS 'http://localhost:8000/rates/latest'", 'node dist/index.js --history', 'python3 -m app.backfill --from 2026-01-01',
      'npm run build && node dist/server.js --port 3000', 'cat out/report.json', 'grep -q currency out.json',
    ]) assert.equal(isTestRunnerProbe(run), false, run);
  });
});
