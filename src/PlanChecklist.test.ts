import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { checkPlan, checklistApprover, programChecklistContext, tokensInWindow, type ChecklistContext } from './PlanChecklist.js';
import { Factory } from './Factory.js';
import { openGates, readGates } from './Gates.js';
import { defaultProgram, saveProgram, ProgramSchema } from './Program.js';
import { TaskSchema, type Task } from './types.js';

const tempDirs: string[] = [];
after(async () => { await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true }))); });

const task = (over: Record<string, unknown> = {}): Task => TaskSchema.parse({
  id: 'T1', title: 'Add the rates route', description: 'Serve /rates from app/routes.py.', agent_role: 'coder', phase: 1,
  files_hint: ['app/routes.py'], creates_files: ['tests/test_rates.py'], acceptance_criteria: ['GET /rates returns 200'],
  verification: ['pytest tests/test_rates.py'], verification_command: 'pytest tests/test_rates.py',
  acceptance_baseline: { exit_code: 1, summary: 'red (exit 1)' }, status: 'pending', attempts: 0, ...over,
});

const ctx = (over: Partial<ChecklistContext> = {}): ChecklistContext => ({
  contextId: 'api', scope: ['app/**', 'tests/**'], alwaysStop: ['cutover', 'contract', 'regulatory', 'activation'],
  openGates: [], budgetTokensLeft: 6_000_000, ...over,
});

const misses = (tasks: Task[], c = ctx(), tokens?: number) => checkPlan({ tasks, token_estimate: tokens === undefined ? undefined : { tokens, runs: 3 } }, c).misses;

describe('checkPlan', () => {
  it('passes a plan that is inside scope, red at planning time, and within budget', () => {
    const plan = [task(), task({ id: 'T2', files_hint: ['app/models.py'], creates_files: [], verification_command: 'pytest tests/test_models.py', dependencies: ['T1'] })];
    assert.deepEqual(checkPlan({ tasks: plan, token_estimate: { tokens: 2_000_000, runs: 4 } }, ctx()), { ok: true, misses: [] });
  });

  it('1: an acceptance command that is missing, unprobed, unrunnable or already passing', () => {
    assert.match(misses([task({ verification_command: undefined })]).join('\n'), /^1 acceptance: T1 has no verification_command/);
    assert.match(misses([task({ acceptance_baseline: undefined })]).join('\n'), /^1 acceptance: T1 was not probed/);
    assert.match(misses([task({ acceptance_baseline: { exit_code: 0, summary: 'already passing on the base branch' } })]).join('\n'), /^1 acceptance: T1 .* is not red at planning time \(already passing/);
    assert.match(misses([task({ acceptance_baseline: { exit_code: 127, summary: 'unrunnable: pytest: not found' } })]).join('\n'), /not red at planning time \(unrunnable/);
  });

  it('2: a file outside the context scope', () => {
    assert.deepEqual(misses([task({ files_hint: ['app/routes.py', 'web/index.html'] })]), ['2 scope: T1 touches web/index.html, outside app/**, tests/**']);
  });

  it('3: person-run steps, live windows, TEST promotion, always-stop subjects and open gates', () => {
    assert.deepEqual(misses([task({ executor: 'user', verification_command: undefined, acceptance_baseline: undefined })]), ['3 always-stop: T1 is a step a person performs']);
    assert.deepEqual(misses([task({ window: 'db-cutover-window' })]), ['3 always-stop: T1 is part of live window "db-cutover-window"']);
    assert.deepEqual(misses([task({ promotion: 'test' })]), ['3 always-stop: T1 is promoted through TEST, which a person decides']);
    assert.deepEqual(misses([task({ description: 'Change the response format of /rates to nest the currency.' })]), ['3 always-stop: T1 is about contract ("response format")']);
    assert.deepEqual(misses([task({ title: 'Switch production traffic to the new service' })]), ['3 always-stop: T1 is about cutover ("Switch production traffic")']);
    // A class the program does not stop on is not a miss.
    assert.deepEqual(misses([task({ description: 'Change the response format.' })], ctx({ alwaysStop: ['cutover'] })), []);
    assert.deepEqual(misses([task()], ctx({ openGates: [{ id: 'G4', class: 'regulatory', scope: ['app/db/**'] }] })), ['3 always-stop: open regulatory gate G4 covers app/**, tests/**']);
  });

  it('4: a protected task without a specific review question', () => {
    assert.deepEqual(misses([task({ protected: true, review_questions: [] })]), ['4 review questions: protected T1 has no specific question for the blind reviewer']);
    assert.deepEqual(misses([task({ protected: true, review_questions: ['Review the code.'] })]), ['4 review questions: protected T1 has no specific question for the blind reviewer']);
    assert.deepEqual(misses([task({ protected: true, review_questions: ['Does a missing rate return 404 rather than 0?'] })]), []);
  });

  it('5: a plan bigger than what is left in the budget window', () => {
    assert.deepEqual(misses([task()], ctx({ budgetTokensLeft: 1_000_000 }), 2_500_000), ['5 budget: the plan needs about 2500000 tokens; 1000000 are left in the window']);
    assert.deepEqual(misses([task()], ctx({ budgetTokensLeft: 1_000_000, maxTokens: 900_000 }), 2_500_000), [], 'an explicit --max-tokens replaces the estimate');
  });

  it('6: same-phase tasks that share a file with no dependency between them', () => {
    const plan = [task(), task({ id: 'T2', creates_files: [], verification_command: 'pytest tests/test_other.py' })];
    assert.deepEqual(misses(plan), ['6 shared files: T1 and T2 both change app/routes.py in phase 1 with no dependency between them']);
    plan[1] = task({ id: 'T2', creates_files: [], verification_command: 'pytest tests/test_other.py', dependencies: ['T1'] });
    assert.deepEqual(misses(plan), []);
  });

  it('7: an acceptance command that names a file outside scope and not created by the plan', () => {
    assert.deepEqual(misses([task({ verification_command: 'pytest ../shared/test_rates.py' })]), ['7 acceptance scope: T1 `pytest ../shared/test_rates.py` names ../shared/test_rates.py, outside app/**, tests/**']);
    assert.deepEqual(misses([task({ verification_command: 'grep -q rates README.md' })]), ['7 acceptance scope: T1 `grep -q rates README.md` names README.md, outside app/**, tests/**']);
  });
});

describe('the program checklist context', () => {
  it('counts only tokens recorded inside the budget window', () => {
    const program = ProgramSchema.parse({ goal: 'g', policy: { budget_window: { tokens: 1000, hours: 24 } }, history: [
      { at: new Date(Date.now() - 2 * 3_600_000).toISOString(), context: 'api', action: 'started', result: 'completed', tokens: 300 },
      { at: new Date(Date.now() - 30 * 3_600_000).toISOString(), context: 'api', action: 'started', result: 'completed', tokens: 500 },
    ] });
    assert.equal(tokensInWindow(program), 300);
  });

  it('names the known contexts when the id is wrong', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-checklist-'));
    tempDirs.push(dir);
    const program = defaultProgram('g');
    program.contexts = [ProgramSchema.parse({ contexts: [{ id: 'api', scope: ['app/**'] }] }).contexts[0]];
    await saveProgram(dir, program);
    assert.deepEqual((await programChecklistContext(dir, 'api', 500)).scope, ['app/**']);
    await assert.rejects(() => programChecklistContext(dir, 'web'), /no context "web" in \.softfactory\/program\.json \(contexts: api\)/);
  });
});

describe('the checklist as the plan approver', () => {
  async function repo() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-checklist-run-'));
    tempDirs.push(dir);
    const git = (...args: string[]) => execa('git', args, { cwd: dir });
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'f@example.test');
    await git('config', 'user.name', 'f');
    await fs.mkdir(path.join(dir, 'app'), { recursive: true });
    await fs.writeFile(path.join(dir, 'app', 'routes.py'), 'ROUTES = []\n');
    await fs.writeFile(path.join(dir, 'README.md'), '# rates\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'init');
    return dir;
  }

  const blueprint = (files: string[]) => ({ feature: 'Rates route', requirements_covered: [], tasks: [{ id: 'T1', title: 'Add the rates route', description: 'Register a rates entry in app/routes.py.', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [], files_hint: files, creates_files: [], acceptance_criteria: ['routes lists rates'], verification: ['grep -q rates app/routes.py'], verification_command: 'grep -q rates app/routes.py', production_targets: [], test_targets: [], behavior_tags: [], executor: 'agent', review_questions: [] }] });

  async function build(files: string[]) {
    const dir = await repo();
    const lines: string[] = [];
    const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none', useDocker: false, plannerProvider: 'local' });
    factory.planner = { provider: 'local', generateBlueprint: async () => blueprint(files), refineBlueprint: async () => blueprint(files) };
    await factory.init();
    factory.approvePlan = checklistApprover(dir, ctx({ scope: ['app/**'] }), line => lines.push(line));
    let ran = false;
    factory.runWorkshopLoop = async () => { ran = true; };
    await factory.build('add the rates route');
    return { dir, factory, lines, ran };
  }

  it('a plan with a file outside scope is saved as planned, not started, with an open plan gate', async () => {
    const { dir, factory, lines, ran } = await build(['app/routes.py', 'README.md']);
    assert.equal(ran, false);
    assert.equal(factory.state.status, 'planned');
    assert.match(lines.join('\n'), /PLAN CHECKLIST: 1 miss\(es\) for api[\s\S]*2 scope: T1 touches README\.md, outside app\/\*\*/);
    const [gate] = (await readGates(dir)).gates;
    assert.equal(gate.class, 'plan');
    assert.equal(gate.status, 'open');
    assert.match(gate.question, /missed the checklist: 2 scope: T1 touches README\.md/);
    assert.equal((await openGates(dir, ['plan'])).length, 1);
  });

  it('a plan that passes every check starts without a person', async () => {
    const { factory, lines, ran } = await build(['app/routes.py']);
    assert.equal(ran, true);
    assert.equal(factory.state.status, 'active');
    assert.match(lines.join('\n'), /all 7 checks passed for api/);
  });
});
