import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { execa } from 'execa';
import { Factory } from './Factory.js';
import { WorkerRegistry } from './WorkerRegistry.js';
import { formatPlan, isInteractive, terminalApprover } from './PlanApproval.js';
import { acceptanceLine, isDeferredAcceptance } from './IWorker.js';
import { TaskVerifier } from './TaskVerifier.js';
import { validateBlueprint } from './Planner.js';
import { TaskSchema } from './types.js';

/** Release 5.6, the five items built directly: issues #21 to #25. */

async function repo(files: Record<string, string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-56-'));
  const git = (...args: string[]) => execa('git', args, { cwd: dir });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'f@example.test');
  await git('config', 'user.name', 'f');
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), content);
  }
  await git('add', '.');
  await git('commit', '-q', '-m', 'init');
  return dir;
}

const task = (over: Record<string, unknown> = {}) => TaskSchema.parse({
  id: 'T1', title: 'Add farewell', description: 'Export farewell() from app.ts.', agent_role: 'coder', phase: 1,
  files_hint: ['app.ts'], acceptance_criteria: ['app.ts exports farewell'], verification: ['grep farewell app.ts'],
  verification_command: 'grep farewell app.ts', status: 'pending', attempts: 0, ...over,
});

const blueprint = { feature: 'Farewell greeting', requirements_covered: [], tasks: [{ id: 'T1', title: 'Add a farewell function', description: 'Export a farewell() function from app.ts.', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [], files_hint: ['app.ts'], creates_files: [], acceptance_criteria: ['app.ts exports farewell'], verification: ['grep farewell app.ts'], verification_command: 'grep farewell app.ts', production_targets: [], test_targets: [], behavior_tags: [], executor: 'agent', review_questions: [] }] };

describe('#21 interactive runs stop for plan approval', () => {
  it('is interactive only when both ends are a terminal and --yes is absent', () => {
    assert.equal(isInteractive([], { isTTY: true }, { isTTY: true }), true);
    assert.equal(isInteractive(['--yes'], { isTTY: true }, { isTTY: true }), false);
    assert.equal(isInteractive([], { isTTY: false }, { isTTY: true }), false, 'piped input, as in CI');
    assert.equal(isInteractive([], { isTTY: true }, { isTTY: undefined }), false, 'output to a file');
  });

  it('formats the plan a person can check in one read', () => {
    const lines = formatPlan({ feature: 'Farewell', tasks: [task({ creates_files: ['farewell.ts'], protected: true }), task({ id: 'T2', dependencies: ['T1'], executor: 'user' })] });
    const text = lines.join('\n');
    assert.match(text, /^Plan: Farewell \(2 tasks\)/);
    assert.match(text, /T1  phase 1  coder  \[protected\]  no dependencies/);
    assert.match(text, /files: app\.ts, farewell\.ts \(new\)/);
    assert.match(text, /done when: grep farewell app\.ts/);
    assert.match(text, /T2  phase 1  coder  \[user\]  after T1/);
  });

  it('asks on the terminal and treats anything but yes as no', async () => {
    for (const [answer, decision] of [['y\n', 'approve'], ['yes\n', 'approve'], ['\n', 'abort'], ['n\n', 'abort'], ['maybe\n', 'abort']] as const) {
      const input = new PassThrough();
      const output = new PassThrough();
      let shown = '';
      output.on('data', chunk => { shown += chunk.toString(); });
      const pending = terminalApprover(input, output)({ feature: 'Farewell', tasks: [task()] } as any);
      input.end(answer);
      assert.equal(await pending, decision, answer);
      assert.match(shown, /Start this plan\? \[y\/N\]/);
    }
  });

  async function factoryWith(decision: 'approve' | 'abort') {
    const dir = await repo({ 'app.ts': "export const greet = () => 'hello';\n" });
    const asked: string[] = [];
    const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none', useDocker: false, plannerProvider: 'local', approvePlan: async state => { asked.push(state.feature); return decision; } });
    factory.planner = { provider: 'local', generateBlueprint: async () => blueprint, refineBlueprint: async () => blueprint };
    await factory.init();
    let ran = false;
    factory.runWorkshopLoop = async () => { ran = true; };
    return { factory, asked, ran: () => ran, dir };
  }

  it('a declined plan is saved as planned and nothing runs', async () => {
    const { factory, asked, ran } = await factoryWith('abort');
    await factory.build('add a farewell function');
    assert.deepEqual(asked, ['Farewell greeting']);
    assert.equal(ran(), false);
    assert.equal(factory.state.status, 'planned', 'kept for --refine or --resume');
  });

  it('an approved plan runs', async () => {
    const { factory, ran } = await factoryWith('approve');
    await factory.build('add a farewell function');
    assert.equal(ran(), true);
    assert.equal(factory.state.status, 'active');
  });
});

describe('#22 silent-failure work starts on the frontier tier', () => {
  it('recognises protected and silent-failure work, and leaves loud work alone', () => {
    assert.equal(WorkerRegistry.silentFailureRisk(task({ protected: true })), true);
    assert.equal(WorkerRegistry.silentFailureRisk(task({ title: 'Check the tenant before the query' })), true);
    assert.equal(WorkerRegistry.silentFailureRisk(task({ description: 'Round the ledger entries to cents' })), true);
    assert.equal(WorkerRegistry.silentFailureRisk(task({ behavior_tags: ['authorization'] })), true);
    assert.equal(WorkerRegistry.silentFailureRisk(task()), false);
    assert.equal(WorkerRegistry.silentFailureRisk(task({ title: 'Delete the unused CSS' })), false);
  });

  it('gives that work the frontier model on its first attempt in cloud mode', async () => {
    const registry: any = new WorkerRegistry('cloud', 'auto', 'flash', 'pro', 'l', 'h', 'deepseek');
    assert.equal((await registry.resolveWorker(task())).model, 'flash');
    assert.equal((await registry.resolveWorker(task({ protected: true }))).model, 'pro');
    assert.equal((await registry.resolveWorker(task({ title: 'Encrypt the stored tokens' }))).model, 'pro');
  });
});

describe('#23 file lists derived by repository search', () => {
  it('rejects a rename that misses a file using the symbol, and accepts it once another task lists that file', async () => {
    const dir = await repo({ 'src/money.ts': 'export function toCents(x: number) { return x * 100; }\n', 'src/cart.ts': "import { toCents } from './money.js';\nexport const total = toCents(3);\n", 'src/adapter.ts': "import { toCents } from './money.js';\nexport const fee = toCents(1);\n" });
    const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none' });
    const rename = task({ title: 'Rename toCents', description: 'Rename `toCents` to `toMinorUnits` everywhere.', files_hint: ['src/money.ts', 'src/cart.ts'], verification_command: undefined });
    const problems = await factory.fileListProblems([rename]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /T1 changes `toCents`, but these files use it and no task lists them: src\/adapter\.ts/);
    assert.deepEqual(await factory.fileListProblems([rename, task({ id: 'T2', files_hint: ['src/adapter.ts'], verification_command: undefined })]), []);
    assert.deepEqual(await factory.fileListProblems([task({ verification_command: undefined })]), [], 'only renames, removals and consolidations are checked');
  });
});

describe('#24 scope self-check', () => {
  it('rejects an acceptance command that names a file outside the task and its dependencies', async () => {
    const dir = await repo({ 'app.ts': 'a\n', 'other.ts': 'b\n', 'src/app.test.ts': 'test\n' });
    const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none' });
    const problems = await factory.acceptanceScopeProblems([task({ verification_command: 'grep farewell other.ts' })]);
    assert.match(problems[0], /T1's acceptance command names other\.ts, which neither the task nor its dependencies change/);
    assert.deepEqual(await factory.acceptanceScopeProblems([task()]), [], 'its own file');
    const tests = task({ id: 'T1', agent_role: 'test_writer', files_hint: ['src/app.test.ts'], verification_command: undefined });
    assert.deepEqual(await factory.acceptanceScopeProblems([tests, task({ id: 'T2', dependencies: ['T1'], verification_command: 'node --test src/app.test.ts' })]), [], 'a dependency\'s test file');
    assert.deepEqual(await factory.acceptanceScopeProblems([task({ verification_command: 'orchestrator: curl -fsS http://localhost/health' })]), [], 'live checks name URLs, not files');
  });

  it('turns both checks into a plan rejection the planner gets once as feedback', async () => {
    const dir = await repo({ 'app.ts': 'a\n', 'other.ts': 'b\n' });
    const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none' });
    await assert.rejects(factory.prepareTasks([{ ...blueprint.tasks[0], verification_command: 'grep farewell other.ts' }]), /Plan rejected: the plan's file lists do not match the repository:\n- T1's acceptance command names other\.ts/);
  });
});

describe('#25 split acceptance', () => {
  it('marks orchestrator checks as deferred and tells the worker it cannot run them', () => {
    assert.equal(isDeferredAcceptance('orchestrator: curl -fsS http://localhost/api'), true);
    assert.equal(isDeferredAcceptance('grep x a.ts'), false);
    assert.match(acceptanceLine('orchestrator: curl -fsS http://localhost/api'), /^Live check \(the orchestrator runs this against the running system after merge; you cannot run it.*\): curl -fsS http:\/\/localhost\/api$/);
    assert.match(acceptanceLine('grep x a.ts'), /^Acceptance command \(run verbatim/);
  });

  it('the per-task gate does not run a live check, and the validator does not hold it to the worker policy', async () => {
    const result = await new TaskVerifier().runAcceptance('/tmp', { id: 'T1', verification_command: 'orchestrator: curl -fsS http://localhost/health', attempts: 0 });
    assert.deepEqual([result.ran, result.passed, result.deferred], [false, true, true]);
    const plan = { ...blueprint, tasks: [{ ...blueprint.tasks[0], verification_command: 'orchestrator: curl -fsS -H "Authorization: Bearer $T" http://localhost/admin' }] };
    assert.equal(validateBlueprint(plan, { requirement: 'x', codebaseContext: '', memoryPatterns: '', featureHistory: '', repositoryFiles: new Set(['app.ts']) }).tasks.length, 1);
  });

  it('runs merged tasks\' live checks after merge, without a uat.json, and names the task that failed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-live-'));
    const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none' });
    const logs: string[] = [];
    factory.on('log', (l: string) => logs.push(l));
    factory.saveState = async () => {};
    factory.updateHistory = async () => {};
    factory.mergeTarget = () => 'main';
    factory.state = { feature_id: 'f-56', status: 'completed', tasks: [
      task({ id: 'T1', status: 'done', verification_command: 'orchestrator: echo reachable' }),
      task({ id: 'T2', status: 'done', verification_command: 'orchestrator: exit 3' }),
      task({ id: 'T3', status: 'done' }),
    ] };
    await factory.uatGate();
    assert.ok(logs.some(l => /UAT: running 2 task live check\(s\) on the host after merge/.test(l)), logs.join('\n'));
    assert.ok(logs.some(l => /UAT PASS — probe: T1 live check/.test(l)));
    assert.ok(logs.some(l => /UAT: the live check of T2 failed; that task did not make the change reachable/.test(l)), logs.join('\n'));
    assert.equal(factory.state.status, 'failed');
  });
});

describe('honesty tags read dotted file names whole', () => {
  it('checks src/PlanningRules.test.ts:60, not test.ts:60', async () => {
    const dir = await repo({ 'src/PlanningRules.test.ts': Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n') });
    const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none' });
    factory.state = { feature_id: 'f', tasks: [] };
    const ok = await factory.claimProblems(task(), { task_id: 'T1', status: 'success', files_changed: [], summary: 's', review_answers: ['Covered at src/PlanningRules.test.ts:60-74 and PlanningRules.test.ts is the file.'] }, dir);
    assert.equal(ok, null);
    const bad = await factory.claimProblems(task(), { task_id: 'T1', status: 'success', files_changed: [], summary: 's', review_answers: ['See src/PlanningRules.test.ts:500.'] }, dir);
    assert.match(bad, /cites src\/PlanningRules\.test\.ts:500, but src\/PlanningRules\.test\.ts has 80 lines/);
  });
});

describe('a not-done item that belongs to another task', () => {
  it('does not reject this task, while its own unfinished acceptance work still does', () => {
    const factory: any = new Factory('/tmp', '', { strategy: 'local', sandbox: 'none' });
    const impl = task({ id: 'T1', files_hint: ['src/Scout.ts'], acceptance_criteria: ['Scout finds the defining file and tests cover it'] });
    factory.state = { tasks: [impl, task({ id: 'T2', agent_role: 'test_writer', files_hint: [], creates_files: ['src/Scout.test.ts'] })] };
    const handoff = (item: string) => ({ task_id: 'T1', status: 'success', files_changed: [], summary: 's', not_done: [item] });
    assert.equal(factory.notDoneViolation(impl, handoff('Could not create src/Scout.test.ts: outside my declared files; the tests belong to T2')), null);
    assert.match(factory.notDoneViolation(impl, handoff('Scout does not yet report the defining file')), /reported acceptance work as not done/);
    assert.match(factory.notDoneViolation(impl, handoff('src/Scout.ts still misses the defining file')), /reported acceptance work as not done/, 'a file of its own');
  });
});
