import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { TaskVerifier } from './TaskVerifier.js';
import { Factory } from './Factory.js';
import { validateBlueprint, type PlanningInput } from './Planner.js';
import type { Task, Handoff } from './types.js';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: 't', description: 'd', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
    files_hint: ['app.ts'], creates_files: [], acceptance_criteria: [], verification: [], status: 'pending',
    attempts: 0, escalation_level: 0, error_history: [], worker_type: 'auto', executor: 'agent',
    protected: false, review_questions: [], production_targets: [], test_targets: [], behavior_tags: [],
    ...over,
  } as Task;
}

async function worktree() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-acc-'));
  await fs.writeFile(path.join(dir, 'app.ts'), 'export const farewell = () => "bye";\n');
  return dir;
}

describe('the acceptance command is executed and its evidence written', () => {
  const v = new TaskVerifier();

  it('passes, and the log ends with RESULT: PASS', async () => {
    const dir = await worktree();
    const evidenceDir = path.join(dir, '.softfactory', 'evidence', 'f-1');
    const result = await v.runAcceptance(dir, task({ id: 'T1', verification_command: 'grep farewell app.ts' }), { evidenceDir });
    assert.equal(result.ran, true);
    assert.equal(result.passed, true);
    assert.equal(result.exitCode, 0);
    const log = await fs.readFile(result.evidencePath!, 'utf8');
    assert.match(log, /^# softfactory acceptance evidence/);
    assert.match(log, /command: grep farewell app\.ts/);
    assert.match(log, /RESULT: PASS\n$/);
    assert.match(path.basename(result.evidencePath!), /^T1-attempt1\.log$/);
  });

  it('fails on a non-zero exit, which is red, not unrunnable', async () => {
    const dir = await worktree();
    const result = await v.runAcceptance(dir, task({ id: 'T1', verification_command: 'grep absent app.ts' }), { evidenceDir: path.join(dir, 'ev') });
    assert.equal(result.passed, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.unrunnable, false);
    assert.match(await fs.readFile(result.evidencePath!, 'utf8'), /RESULT: FAIL\n$/);
  });

  it('refuses a command the policy forbids and calls it unrunnable', async () => {
    const dir = await worktree();
    for (const command of ['node -e "process.exit(0)"', 'cd x && npm test', 'curl http://x', 'npx vitest run']) {
      const result = await v.runAcceptance(dir, task({ id: 'T1', verification_command: command }));
      assert.equal(result.passed, false, command);
      assert.equal(result.unrunnable, true, command);
      assert.match(result.output, /command policy/);
    }
  });

  it('does nothing for a task without a command', async () => {
    const result = await v.runAcceptance(await worktree(), task({ id: 'T1' }));
    assert.equal(result.ran, false);
    assert.equal(result.passed, true);
  });

  it('runs an ecosystem command from the ecosystem root in a split repo', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-cwd-'));
    await fs.mkdir(path.join(dir, 'frontend'));
    await fs.writeFile(path.join(dir, 'frontend', 'package.json'), '{}');
    assert.equal(await (v as any).acceptanceCwd(dir, 'npm test -- --run x'), path.join(dir, 'frontend'));
    assert.equal(await (v as any).acceptanceCwd(dir, 'grep x y'), dir);
  });
});

async function gateHarness(handoff: Handoff) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-gate-'));
  const factory: any = new Factory(baseDir, '', { strategy: 'local' });
  factory.state = { feature_id: 'f-1', feature: 'test', status: 'active', strategy: 'local',
    cloud_provider: 'agy', planner_provider: 'local', created_at: '', last_updated: '', tasks: [], memory_patterns: [] };
  factory.saveState = async () => {};
  factory.getProjectContext = async () => '';
  factory.getDiff = async () => 'diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n+farewell';
  factory.lessons.getRelevant = async () => [];
  factory.taskVerifier.prepare = async () => ({ ok: true });
  factory.taskVerifier.verify = async () => ({ executed: true, passed: true, testSummary: 'ok', output: '' });
  factory.workerRegistry.resolveWorker = async () => ({
    worker: { id: 'stub', name: 'stub', isAvailable: async () => true, execute: async () => handoff },
    model: 'm', provider: 'p',
  });
  factory.worktreeManager.commitWorktree = async () => ({ committed: true, filesChanged: 1 });
  return { factory, baseDir };
}

const handoff: Handoff = { task_id: 'T1', status: 'success', files_changed: ['app.ts'], summary: 'done' };

describe('a task with an acceptance command cannot merge without a PASS', () => {
  it('merges on PASS and records the evidence path on the task', async () => {
    const { factory, baseDir } = await gateHarness(handoff);
    const t = task({ id: 'T1', verification_command: 'grep farewell app.ts' });
    const result = await factory.executeAndInspect(t, await worktree());
    assert.ok(result);
    assert.match(t.evidence!, /^\.softfactory\/evidence\/f-1\/T1-attempt1\.log$/);
    assert.match(await fs.readFile(path.join(baseDir, t.evidence!), 'utf8'), /RESULT: PASS/);
  });

  it('rejects on FAIL with the command and its output in the retry feedback', async () => {
    const { factory } = await gateHarness(handoff);
    const t = task({ id: 'T1', verification_command: 'grep absent app.ts' });
    const result = await factory.executeAndInspect(t, await worktree());
    assert.equal(result, null);
    assert.equal(t.status, 'failed');
    assert.match(t.error_history[0], /acceptance command failed \(exit 1\): grep absent app\.ts/);
  });

  it('tolerates a red acceptance for a test writer, whose tests are meant to fail first', async () => {
    const { factory } = await gateHarness(handoff);
    factory.getDiff = async () => '+++ b/app.test.ts\n+it("x", () => { expect(1).toBe(2) })';
    const t = task({ id: 'T1', agent_role: 'test_writer', verification_command: 'grep absent app.ts' });
    const result = await factory.executeAndInspect(t, await worktree());
    assert.ok(result, 'red is the expected state before implementation');
  });

  it('does not tolerate an unrunnable command for anyone', async () => {
    const { factory } = await gateHarness(handoff);
    factory.getDiff = async () => '+++ b/app.test.ts\n+it("x", () => { expect(1).toBe(2) })';
    const t = task({ id: 'T1', agent_role: 'test_writer', verification_command: 'curl http://x' });
    const result = await factory.executeAndInspect(t, await worktree());
    assert.equal(result, null);
    assert.match(t.error_history[0], /could not run at all/);
  });
});

describe('the plan is checked for runnable acceptance commands', () => {
  const input: PlanningInput = {
    requirement: 'x', codebaseContext: '', memoryPatterns: '', featureHistory: '',
    repositoryFiles: new Set(['src/App.tsx', 'src/App.test.tsx']),
  };
  const plan = (verification_command: string) => ({
    feature: 'Palette', requirements_covered: [],
    tasks: [{ id: 'T1', title: 'Repair', description: 'Repair the palette integration.', agent_role: 'coder', phase: 1,
      files_hint: ['src/App.tsx'], acceptance_criteria: ['works'], verification: ['npm test'], verification_command }],
  });

  it('rejects shell operators, npx and unknown tools in the validator, so the repair loop fixes them', () => {
    for (const bad of ['cd src && npm test', 'npx vitest run src/App.test.tsx', 'curl localhost:3000', 'npm test; rm -rf x']) {
      assert.throws(() => validateBlueprint(plan(bad), input), /command policy/, bad);
    }
    assert.equal(validateBlueprint(plan('npm test -- --run src/App.test.tsx'), input).tasks.length, 1);
  });

  it('rejects a plan whose command cannot run in this environment, and records the red baseline otherwise', async () => {
    const factory: any = new Factory(await fs.mkdtemp(path.join(os.tmpdir(), 'sf-prep-')), '', { strategy: 'local' });
    const blueprintTask = { id: 'T1', title: 'Repair', description: 'Repair the palette integration.', agent_role: 'coder', phase: 1,
      files_hint: ['src/App.tsx'], test_targets: ['tests/x.py'], acceptance_criteria: ['works'], verification: ['npm test'], verification_command: 'pytest tests/x.py' };

    factory.taskVerifier.runAcceptance = async () => ({ ran: true, passed: false, exitCode: null, output: 'spawn pytest ENOENT', command: 'pytest tests/x.py', unrunnable: true });
    await assert.rejects(() => factory.prepareTasks([blueprintTask]), /Plan rejected: these acceptance commands cannot run/);

    factory.taskVerifier.runAcceptance = async () => ({ ran: true, passed: false, exitCode: 1, output: '1 failed', command: 'pytest tests/x.py', unrunnable: false });
    const [prepared] = await factory.prepareTasks([blueprintTask]);
    assert.deepEqual(prepared.acceptance_baseline, { exit_code: 1, summary: 'red (exit 1)' });
  });
});

describe('auto-replan replacements pass the planning-time acceptance probe', () => {
  async function replanFactory(commands: string[]) {
    const factory: any = new Factory(await fs.mkdtemp(path.join(os.tmpdir(), 'sf-replan-')), '', { strategy: 'local' });
    const blocked = task({ id: 'T1', status: 'blocked', files_hint: ['src/Gates.ts'], replan_reason: 'escalation_fit_failure', last_feedback: 'no progress' } as any);
    factory.state = { feature_id: 'f-1', feature: 'gates', status: 'active', tasks: [blocked], usage: { input_tokens: 0, output_tokens: 0 } };
    factory.saveState = async () => {};
    factory.getRepoContext = async () => '';
    factory.getRepositoryFiles = async () => ['src/Gates.ts'];
    factory.lessons = { getForPlanning: async () => '' };
    const requirements: string[] = [];
    factory.planner = {
      provider: 'local',
      generateBlueprint: async (input: { requirement: string }) => {
        requirements.push(input.requirement);
        const verification_command = commands[Math.min(requirements.length - 1, commands.length - 1)];
        return { feature: 'gates', tasks: [{ id: 'T1', title: 'Gates types', description: 'Define the gate types in src/Gates.ts.', agent_role: 'coder', phase: 1, files_hint: ['src/Gates.ts'], acceptance_criteria: ['compiles'], verification: [verification_command], verification_command }] };
      },
    };
    factory.taskVerifier.runAcceptance = async (_dir: string, t: Task) => t.verification_command!.startsWith('tsc')
      ? { ran: true, passed: false, exitCode: 127, output: 'tsc: command not found', command: t.verification_command, unrunnable: true }
      : { ran: true, passed: false, exitCode: 1, output: '1 failed', command: t.verification_command, unrunnable: false };
    return { factory, requirements };
  }

  it('re-plans once when a replacement acceptance cannot run, and keeps the runnable set with its red baseline', async () => {
    const { factory, requirements } = await replanFactory(['tsc --noEmit src/Gates.ts', 'npm test -- src/Gates.test.ts']);
    await factory.autoReplanBlockedTasks();
    assert.equal(requirements.length, 2);
    assert.match(requirements[1], /cannot run in this environment:\n- T1\.1: tsc --noEmit src\/Gates\.ts/);
    assert.deepEqual(factory.state.tasks.map((t: Task) => [t.id, t.verification_command, t.acceptance_baseline?.summary]), [['T1.1', 'npm test -- src/Gates.test.ts', 'red (exit 1)']]);
  });

  it('leaves the task blocked with the reason when the second set cannot run either', async () => {
    const { factory, requirements } = await replanFactory(['tsc --noEmit src/Gates.ts']);
    await factory.autoReplanBlockedTasks();
    assert.equal(requirements.length, 2);
    assert.deepEqual(factory.state.tasks.map((t: Task) => [t.id, t.status]), [['T1', 'blocked']]);
    assert.match(factory.state.tasks[0].last_feedback, /Automatic re-plan failed: replacement acceptance commands cannot run here/);
  });
});
