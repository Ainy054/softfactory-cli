import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { Factory } from './Factory.js';
import { ToolLoopWorker } from './ToolLoopWorker.js';
import { TaskSchema } from './types.js';
import type { ChatTransport, ChatRequest, ToolCall } from './ChatTransport.js';

/** Release 5.5, the four items built directly: issues #8 to #11. */

async function repo(files: Record<string, string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-55-'));
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
  return { dir, git };
}

const factoryOn = (dir: string): any => {
  const f: any = new Factory(dir, '', { strategy: 'cloud', cloudProvider: 'deepseek', cloudModel: 'd', sandbox: 'none' });
  f.state = { feature_id: 'f-55', status: 'active', tasks: [], brief: '' };
  f.logs = [];
  f.on('log', (l: string) => f.logs.push(l));
  return f;
};

const task = (over: Record<string, unknown> = {}) => TaskSchema.parse({
  id: 'T1', title: 'Add farewell', description: 'Export farewell() from app.ts.', agent_role: 'coder', phase: 1,
  files_hint: ['app.ts'], creates_files: [], acceptance_criteria: ['app.ts exports farewell'], verification: ['grep farewell app.ts'],
  verification_command: 'grep farewell app.ts', status: 'pending', attempts: 0, ...over,
});

describe('#8 honesty tags: cited sources must exist', () => {
  it('passes real file:line sources, rejects a fabricated one, and carries UNVERIFIED claims', async () => {
    const { dir } = await repo({ 'app.ts': 'export const greet = () => 1;\nexport const farewell = () => 2;\n' });
    const f = factoryOn(dir);
    const ok = await f.claimProblems(task(), { task_id: 'T1', status: 'success', files_changed: ['app.ts'], summary: 's', claims: [{ text: 'farewell is exported', source: 'app.ts:2' }, { text: 'ran the grep', source: 'command: grep farewell app.ts' }, { text: 'callers are unaffected', source: 'UNVERIFIED' }] }, dir);
    assert.equal(ok, null);
    assert.ok(f.notesFor('T2').some((n: string) => /unverified claim: callers are unaffected/.test(n)), 'carried for later tasks');
    const bad = await f.claimProblems(task(), { task_id: 'T1', status: 'success', files_changed: [], summary: 's', claims: [{ text: 'the guard is at line 40', source: 'app.ts:40' }, { text: 'helper exists', source: 'src/helper.ts:3' }] }, dir);
    assert.match(bad, /cites app\.ts:40, but app\.ts has 3 lines/);
    assert.match(bad, /cites src\/helper\.ts:3, but src\/helper\.ts does not exist/);
    assert.equal(await f.claimProblems(task(), { task_id: 'T1', status: 'success', files_changed: [], summary: 's', claims: [{ text: 'the whole file', source: 'app.ts:1-70' }] }, dir), null, 'an overshot range is imprecise, not fabricated');
  });

  it('checks file:line references inside review answers too', async () => {
    const { dir } = await repo({ 'auth.ts': 'line1\nline2\n' });
    const f = factoryOn(dir);
    assert.equal(await f.claimProblems(task(), { task_id: 'T1', status: 'success', files_changed: [], summary: 's', review_answers: ['The tenant is checked at auth.ts:2 before the query.'] }, dir), null);
    assert.match(await f.claimProblems(task(), { task_id: 'T1', status: 'success', files_changed: [], summary: 's', review_answers: ['Checked at auth.ts:99.'] }, dir), /A review answer cites auth\.ts:99/);
  });

  it('the tool-loop worker keeps only well-formed claims', () => {
    assert.deepEqual(ToolLoopWorker.claimsFrom([{ text: 'a', source: 'x.ts:1' }, { text: 'no source' }, 'junk']), [{ text: 'a', source: 'x.ts:1' }]);
    assert.equal(ToolLoopWorker.claimsFrom('nope'), undefined);
  });
});

describe('#9 delta review after a fork-freshness merge', () => {
  async function stale(protectedTask: boolean, verdict: 'PASS' | 'FAIL') {
    const { dir, git } = await repo({ 'auth.ts': 'a\nb\nc\nd\ne\n', 'other.ts': 'x\n' });
    const worktree = path.join(dir, '.git', 'wt-T2');
    await git('worktree', 'add', '-q', '-b', 'line/T2', worktree);
    await fs.writeFile(path.join(worktree, 'auth.ts'), 'a\nb\nc\nd\nE-guard\n');
    await execa('git', ['commit', '-qam', 'T2'], { cwd: worktree });
    await fs.writeFile(path.join(dir, 'auth.ts'), 'A-from-T1\nb\nc\nd\ne\n');
    await git('commit', '-qam', 'T1 merged first');
    const f = factoryOn(dir);
    f.mergeTarget = () => 'main';
    const seen: string[] = [];
    f.frontierInspector = { inspectBlind: async (_t: unknown, diff: string) => { seen.push(diff); return { verdict, feedback: verdict === 'FAIL' ? 'the guard no longer covers A-from-T1' : 'fine', provider: 'p', model: 'm' }; } };
    const t = task({ id: 'T2', files_hint: ['auth.ts'], protected: protectedTask, verification_command: 'grep E-guard auth.ts' });
    const before = (await execa('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout;
    const result = await f.forkFreshness(t, 'line/T2', worktree);
    const after = (await execa('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout;
    return { result, seen, before, after, f };
  }

  it('sends a protected task back to the blind reviewer with the combined diff', async () => {
    const { result, seen } = await stale(true, 'PASS');
    assert.equal(result, null);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /E-guard/);
  });

  it('refuses the merge and undoes the trial merge when the delta review fails', async () => {
    const { result, before, after } = await stale(true, 'FAIL');
    assert.match(result, /Delta review failed after combining this protected change.*the guard no longer covers A-from-T1/);
    assert.equal(after, before);
  });

  it('leaves ordinary tasks to the acceptance re-check alone', async () => {
    const { result, seen } = await stale(false, 'FAIL');
    assert.equal(result, null);
    assert.equal(seen.length, 0);
  });
});

describe('#10 a retry must change the prompt', () => {
  it('adds exact signatures and a prohibition per earlier failure', async () => {
    const { dir } = await repo({ 'app.ts': 'export function greet(name: string): string {\n  return name;\n}\nconst hidden = 1;\n' });
    const f = factoryOn(dir);
    await f.recordAttempt(task(), 'verification', 'tests failed');
    await f.recordAttempt(task(), 'stale_fork', 'moved');
    const brief = await f.retryBrief(task({ attempts: 2 }), dir);
    assert.match(brief, /RETRY BRIEF \(attempt 3/);
    assert.match(brief, /app\.ts:\n  export function greet\(name: string\): string\n/);
    assert.doesNotMatch(brief, /hidden/);
    assert.match(brief, /Do not finish while the scoped tests fail/);
    assert.match(brief, /re-read them, they changed/);
    assert.match(brief, /run the acceptance command yourself and it passes: grep farewell app\.ts/);
  });

  it('reaches the worker: the second attempt\'s prompt differs from the first outside the feedback', async () => {
    const dir = (await repo({ 'app.ts': 'export const greet = () => 1;\n' })).dir;
    const prompts: string[] = [];
    const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: args } });
    const transport: ChatTransport = {
      id: 's', name: 's', label: 'S', limits: { toolOutput: 8000, fileRead: 32000 }, contextWindow: () => 32000, timeoutMs: () => 10000,
      checkAvailability: async () => ({ reachable: true, modelPresent: true, installed: ['m'] }), unreachable: () => '', missingModel: () => '',
      chat: async (request: ChatRequest) => {
        if (request.messages.length === 1 && /probe\.txt/.test(request.messages[0].content)) return { content: '', toolCalls: [call('p', 'read_file', { filepath: 'probe.txt' })] };
        if (request.messages[0].role === 'system' && request.messages.length === 2) prompts.push(request.messages[1].content);
        return { content: '', toolCalls: [call('e', 'finish_task', { summary: 's', test_summary: 't', status: 'failure' })] };
      },
    };
    const worker = new ToolLoopWorker(transport, 'm');
    await worker.execute(task(), dir, {});
    const brief = await factoryOn(dir).retryBrief(task({ attempts: 1 }), dir);
    await worker.execute(task({ attempts: 1, last_feedback: 'tests failed' }), dir, { retryBrief: brief });
    assert.equal(prompts.length, 2);
    const strip = (p: string) => p.replace(/PREVIOUS ATTEMPT FAILED[\s\S]*?Ensure you fix this\.\n/, '');
    assert.notEqual(strip(prompts[1]), strip(prompts[0]));
    assert.match(prompts[1], /RETRY BRIEF/);
  });
});

describe('#11 recover a crashed worker\'s correct work', () => {
  it('hands uncommitted work whose acceptance passes to the gates', async () => {
    const { dir } = await repo({ 'app.ts': 'export const greet = () => 1;\n' });
    await fs.appendFile(path.join(dir, 'app.ts'), 'export const farewell = () => 2;\n');
    const f = factoryOn(dir);
    const handoff = await f.recoverCrashedWork(task(), dir, new Error('worker process killed'));
    assert.equal(handoff.status, 'success');
    assert.deepEqual(handoff.files_changed, ['app.ts']);
    assert.ok(f.logs.some((l: string) => /RECOVERED: T1 — the worker stopped \(worker process killed\)/.test(l)));
  });

  it('does not recover when nothing changed, the acceptance fails, it is a test writer, or the backend was down', async () => {
    const { dir } = await repo({ 'app.ts': 'export const greet = () => 1;\n' });
    const f = factoryOn(dir);
    assert.equal(await f.recoverCrashedWork(task(), dir, new Error('x')), null, 'nothing changed');
    await fs.appendFile(path.join(dir, 'app.ts'), 'export const other = 3;\n');
    assert.equal(await f.recoverCrashedWork(task(), dir, new Error('x')), null, 'acceptance fails');
    await fs.appendFile(path.join(dir, 'app.ts'), 'export const farewell = 2;\n');
    assert.equal(await f.recoverCrashedWork(task({ agent_role: 'test_writer' }), dir, new Error('x')), null);
    const { WorkerEnvironmentError } = await import('./IWorker.js');
    assert.equal(await f.recoverCrashedWork(task(), dir, new WorkerEnvironmentError('down')), null);
  });
});

describe('planner: a test writer may depend on its implementation instead of naming targets', () => {
  it('accepts the dependency the error message always offered, and says how to fix it when missing', async () => {
    const { validateBlueprint } = await import('./Planner.js');
    const input = { requirement: '## Scope\nx', codebaseContext: '', memoryPatterns: '', featureHistory: '', repositoryFiles: new Set(['src/a.ts']) };
    const base = { agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [], files_hint: ['src/a.ts'], creates_files: [], acceptance_criteria: ['a works'], verification: ['npm test'] };
    const tester = { ...base, id: 'T2', title: 'Tests', description: 'Add tests for the new parser', agent_role: 'test_writer', phase: 2, files_hint: ['src/a.test.ts'], creates_files: ['src/a.test.ts'] };
    const withDep = { feature: 'Parser tests', requirements_covered: ['Scope'], tasks: [{ ...base, id: 'T1', title: 'Impl', description: 'Implement the parser' }, { ...tester, dependencies: ['T1'] }] };
    assert.equal(validateBlueprint(withDep, input).tasks.length, 2);
    const without = { ...withDep, tasks: [withDep.tasks[0], { ...tester }] };
    assert.throws(() => validateBlueprint(without, input), /set its production_targets to the implementation files .* or add the id of the task that implements them to its dependencies/);
  });
});

describe('an acceptance command that times out at planning rejects the plan', () => {
  it('names the slow command instead of recording it as the expected red', async () => {
    const f = factoryOn('/tmp');
    f.taskVerifier.runAcceptance = async () => ({ ran: true, passed: false, exitCode: null, output: 'timed out after 90000ms', command: 'npm test', unrunnable: false, timedOut: true });
    const raw = { id: 'T2', title: 'Rules', description: 'Enforce rules', agent_role: 'coder', phase: 1, files_hint: ['src/a.ts'], verification_command: 'npm test' };
    await assert.rejects(f.prepareTasks([raw]), /T2: npm test \(unrunnable: did not finish in 90s at planning/);
  });

  it('marks a run killed at its limit as timed out', async () => {
    const { TaskVerifier } = await import('./TaskVerifier.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-slow-'));
    await fs.writeFile(path.join(dir, 'slow.js'), 'setTimeout(() => {}, 5000);\n');
    const result = await new TaskVerifier().runAcceptance(dir, { id: 'T1', verification_command: 'node slow.js', attempts: 0 }, { timeoutMs: 300 });
    assert.equal(result.passed, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.unrunnable, false);
  });
});

describe('a diff that reformats code it did not need to change is rejected', () => {
  const original = Array.from({ length: 120 }, (_, i) => `export function f${i}(a: number, b: number) { return a + b + ${i}; }`).join('\n') + '\n';
  const reformatted = Array.from({ length: 120 }, (_, i) => `export function f${i}(\n  a: number,\n  b: number,\n) {\n  return a + b + ${i};\n}`).join('\n') + '\n';

  async function diffOf(after: string) {
    const { dir, git } = await repo({ 'lib.ts': original });
    await fs.writeFile(path.join(dir, 'lib.ts'), after);
    const { stdout } = await git('diff', 'HEAD');
    return { dir, diff: stdout };
  }

  it('flags a whole-file reformat with a small real change inside it', async () => {
    const { dir, diff } = await diffOf(reformatted.replace('return a + b + 7;', 'return a * b + 7;'));
    const message = await Factory.reformatViolation(diff, dir);
    assert.match(message!, /reformats code it did not need to change: lib\.ts \(1(19|20) of 120 deleted lines are unchanged code/);
  });

  it('leaves a real rewrite and a small edit alone', async () => {
    const rewrite = await diffOf(Array.from({ length: 120 }, (_, i) => `export const g${i} = (x: string) => x.repeat(${i});`).join('\n') + '\n');
    assert.equal(await Factory.reformatViolation(rewrite.diff, rewrite.dir), null);
    const small = await diffOf(original.replace('return a + b + 7;', 'return a * b + 7;'));
    assert.equal(await Factory.reformatViolation(small.diff, small.dir), null);
  });
});

describe('a new requirement never resumes a different feature', () => {
  async function withActive() {
    const { dir } = await repo({ 'a.txt': 'a\n' });
    const f: any = new Factory(dir, '', { strategy: 'cloud', cloudProvider: 'deepseek', cloudModel: 'd', sandbox: 'none' });
    await fs.mkdir(path.join(dir, '.softfactory', 'archive'), { recursive: true });
    f.state = { feature_id: 'f-6', feature: 'project-rules-scan', requirement: 'issue six text', brief: '', status: 'active', tasks: [], usage: { input_tokens: 0, output_tokens: 0 } };
    await f.saveState();
    return { dir, f };
  }

  it('refuses, naming the feature and both ways forward', async () => {
    const { f } = await withActive();
    let resumed = false;
    f.runWorkshopLoop = async () => { resumed = true; };
    await assert.rejects(f.build('issue four text'), /A different feature is in progress: "project-rules-scan" \(f-6\)\. Run with --resume to continue it, or add --abandon/);
    assert.equal(resumed, false);
  });

  it('still resumes when the requirement is the same', async () => {
    const { f } = await withActive();
    let resumed = false;
    f.runWorkshopLoop = async () => { resumed = true; };
    f.validateDoneTasks = async () => {};
    await f.build('issue six text');
    assert.equal(resumed, true);
  });

  it('--abandon archives the unfinished feature and plans the new requirement', async () => {
    const { dir } = await withActive();
    const f: any = new Factory(dir, '', { strategy: 'cloud', cloudProvider: 'deepseek', cloudModel: 'd', sandbox: 'none', abandon: true });
    f.state = JSON.parse(await fs.readFile(path.join(dir, '.softfactory', 'factory.json'), 'utf8'));
    let planned = '';
    f.planner = { provider: 'deepseek', generateBlueprint: async (input: any) => { planned = input.requirement; throw new Error('stop after planning'); } };
    await assert.rejects(f.build('issue four text'), /stop after planning/);
    assert.equal(planned, 'issue four text');
    const archived = JSON.parse(await fs.readFile(path.join(dir, '.softfactory', 'archive', 'f-6.json'), 'utf8'));
    assert.equal(archived.status, 'failed');
  });
});

describe('planning a ticket', () => {
  it('does not treat ticket-structure headings as requirement areas', async () => {
    const { validateBlueprint } = await import('./Planner.js');
    const requirement = '## Change\nAdd X.\n## Acceptance\nTests pass.\n## Exporter\nThe CSV exporter.';
    const input = { requirement, codebaseContext: '', memoryPatterns: '', featureHistory: '', repositoryFiles: new Set(['src/a.ts']) };
    const plan = { feature: 'Exporter work', requirements_covered: ['Exporter'], tasks: [{ id: 'T1', title: 'Add the exporter', description: 'Add the CSV exporter module', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [], files_hint: ['src/a.ts'], creates_files: [], acceptance_criteria: ['exporter writes rows'], verification: ['npm test'] }] };
    assert.equal(validateBlueprint(plan, input).tasks.length, 1, 'Change and Acceptance are not areas');
    assert.throws(() => validateBlueprint({ ...plan, requirements_covered: [] }, input), /missing requirement coverage: Exporter/);
  });

  it('re-plans once with the reason when the acceptance probe rejects the plan', async () => {
    const f = factoryOn('/tmp');
    const requirements: string[] = [];
    const blueprint = (cmd: string) => ({ feature: 'f', requirements_covered: [], tasks: [{ id: 'T1', title: 't', description: 'd', agent_role: 'coder', phase: 1, files_hint: ['a.ts'], verification_command: cmd }] });
    f.planner = { provider: 'deepseek', generateBlueprint: async (input: any) => { requirements.push(input.requirement); return requirements.length === 1 ? blueprint('npm test') : blueprint('node --test a.test.js'); } };
    f.taskVerifier.runAcceptance = async (_dir: string, t: any) => t.verification_command === 'npm test'
      ? { ran: true, passed: false, exitCode: null, output: '', command: 'npm test', unrunnable: false, timedOut: true }
      : { ran: true, passed: false, exitCode: 1, output: '', command: t.verification_command, unrunnable: false };
    const { tasks } = await f.planTasks({ requirement: 'Add a thing', codebaseContext: '', memoryPatterns: '', featureHistory: '', repositoryFiles: new Set() });
    assert.equal(tasks[0].verification_command, 'node --test a.test.js');
    assert.equal(requirements.length, 2);
    assert.match(requirements[1], /^Add a thing\n\nPLANNER FEEDBACK: the previous plan was rejected[\s\S]*T1: npm test/);
  });
});

describe('the edit tool formats only in the project\'s own style', () => {
  // Prettier comes from npx's cache on a developer machine; the network-less
  // sandbox has none, and npx would spend a minute failing to reach the registry.
  const prettier = execa('npx', ['--no-install', 'prettier', '--version'], { timeout: 10_000, reject: false, env: { ...process.env, npm_config_offline: 'true' } }).then(r => r.exitCode === 0);
  const ugly = "export const a = {x:1,y:2}\nexport function f(a:number,b:number){return a+b}\n";
  async function project(config: boolean) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-fmt-'));
    await fs.symlink(path.resolve('node_modules'), path.join(dir, 'node_modules'));
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(config ? { name: 'x', prettier: { singleQuote: true } } : { name: 'x' }));
    await fs.writeFile(path.join(dir, 'a.ts'), ugly);
    return dir;
  }

  it('leaves a file alone in a project with no Prettier config', async () => {
    const { AutoHeal } = await import('./AutoHeal.js');
    const dir = await project(false);
    assert.equal(await AutoHeal.hasPrettierConfig(dir), false);
    await AutoHeal.formatCode(dir, 'a.ts', ugly);
    assert.equal(await fs.readFile(path.join(dir, 'a.ts'), 'utf8'), ugly);
  });

  it('leaves an unformatted file alone even when the project uses Prettier, so untouched lines never change', async (t) => {
    if (!await prettier) return t.skip('Prettier is not available offline here');
    const { AutoHeal } = await import('./AutoHeal.js');
    const dir = await project(true);
    assert.equal(await AutoHeal.hasPrettierConfig(dir), true);
    await AutoHeal.formatCode(dir, 'a.ts', ugly);
    assert.equal(await fs.readFile(path.join(dir, 'a.ts'), 'utf8'), ugly);
  });

  it('formats a file the project already keeps Prettier-clean', async (t) => {
    if (!await prettier) return t.skip('Prettier is not available offline here');
    const { AutoHeal } = await import('./AutoHeal.js');
    const dir = await project(true);
    const clean = 'export const a = { x: 1, y: 2 };\n';
    await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = {x:1,y:2}\n');
    await AutoHeal.formatCode(dir, 'a.ts', clean);
    assert.equal(await fs.readFile(path.join(dir, 'a.ts'), 'utf8'), clean);
  });
});

describe('the read budget before the first edit scales with the task\'s files', () => {
  it('is 12 for small files and grows a call per 200 lines, up to 30', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-budget-'));
    await fs.writeFile(path.join(dir, 'small.ts'), 'x\n'.repeat(50));
    await fs.writeFile(path.join(dir, 'big.ts'), 'x\n'.repeat(2400));
    assert.deepEqual(await ToolLoopWorker.progressLimits(dir, ['small.ts']), { warn: 6, abort: 13 });
    assert.deepEqual(await ToolLoopWorker.progressLimits(dir, ['big.ts']), { warn: 12, abort: 25 });
    assert.deepEqual(await ToolLoopWorker.progressLimits(dir, ['big.ts', 'big.ts', 'missing.ts']), { warn: 15, abort: 30 });
    assert.deepEqual(await ToolLoopWorker.progressLimits(dir, []), { warn: 6, abort: 12 });
    // #75: a task whose only files are still to be created starts at 20.
    assert.deepEqual(await ToolLoopWorker.progressLimits(dir, ['src/New.ts'], ['src/New.ts']), { warn: 10, abort: 20 });
    assert.deepEqual(await ToolLoopWorker.progressLimits(dir, ['small.ts'], ['small.ts']), { warn: 6, abort: 13 }, 'an existing file is an edit, not a create');
  });
});

describe('the sandbox never mounts dependencies over a symlinked node_modules', () => {
  it('skips the mount and says why', async () => {
    const { SandboxManager } = await import('./Sandbox.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-symdeps-'));
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-elsewhere-'));
    await fs.writeFile(path.join(dir, 'package.json'), '{}');
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
    await fs.symlink(elsewhere, path.join(dir, 'node_modules'));
    const logs: string[] = [];
    const sandbox: any = new SandboxManager('docker', (l: string) => logs.push(l));
    sandbox.installDependencyVolume = async () => { throw new Error('must not install'); };
    assert.deepEqual(await sandbox.nodeDependencyMounts(dir), []);
    assert.ok(logs.some(l => /is a symlink; Linux dependencies are not mounted over it/.test(l)));
  });
});

describe('an advisory plan field never costs a repair round', () => {
  it('drops an unknown complexity value', async () => {
    const { validateBlueprint } = await import('./Planner.js');
    const input = { requirement: 'x', codebaseContext: '', memoryPatterns: '', featureHistory: '', repositoryFiles: new Set(['src/a.ts']) };
    const plan = { feature: 'Some feature', requirements_covered: [], tasks: [{ id: 'T1', title: 'Do the thing', description: 'Do the thing well', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [], files_hint: ['src/a.ts'], creates_files: [], acceptance_criteria: ['works'], verification: ['npm test'], complexity: 'medium' }] };
    assert.equal(validateBlueprint(plan, input).tasks[0].complexity, undefined);
  });
});

describe('a malformed rules file halts the run instead of failing a task', () => {
  it('raises an environment fault that names the file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-badrules-'));
    await fs.mkdir(path.join(dir, '.softfactory'));
    await fs.writeFile(path.join(dir, '.softfactory', 'non-negotiables.txt'), 'ok-rule :: fine\n([unclosed :: broken\n');
    const f = factoryOn(dir);
    await assert.rejects(f.loadProjectRules(), (error: any) => error.isEnvironmentFailure === true && /line 2.*Fix \.softfactory\/non-negotiables\.txt and run --resume; no task retry was consumed/.test(error.message));
  });
});
