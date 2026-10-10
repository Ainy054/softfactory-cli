import { describe, it } from 'node:test';
import { EnvironmentSchema } from './Environment.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { loadUat, runUat, UatSchema, type ShellRunner } from './Uat.js';
import { appendHandoff, readHandoffs, similarHandoffs } from './HandoffIndex.js';
import { wiringCensus, newlyUnwired, censusKey } from './WiringCensus.js';
import { LessonManager } from './LessonManager.js';
import { Factory } from './Factory.js';
import { initProject } from './Init.js';
import { recurringFailures } from './Metrics.js';

/** The five features borrowed from Softhouse 2.8; see its CHANGELOG for the incident behind each. */

const tmp = (prefix: string) => fs.mkdtemp(path.join(os.tmpdir(), prefix));

async function repo(files: Record<string, string>) {
  const dir = await tmp('sf-borrow-');
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

describe('1. live verification (UAT, binary proof, reachability)', () => {
  it('passes when the build rewrote the artifact with the run id and every probe answers', async () => {
    const dir = await tmp('sf-uat-');
    const config = UatSchema.parse({
      build: 'node -e "require(\'fs\').mkdirSync(\'dist\',{recursive:true});require(\'fs\').writeFileSync(\'dist/app.js\',\'built \'+process.env.SOFTFACTORY_RUN_ID)"',
      artifacts: [{ path: 'dist/app.js', contains: ['$SOFTFACTORY_RUN_ID'] }],
      probes: [{ name: 'health', run: 'echo status=ok', expect: 'status=ok' }],
      teardown: ['echo down'],
    });
    const result = await runUat(dir, config, { runId: 'run-abc123', featureId: 'f-1', evidenceDir: path.join(dir, 'ev') });
    assert.equal(result.passed, true, JSON.stringify(result.steps));
    assert.deepEqual(result.steps.map(s => s.name), ['build', 'binary proof: dist/app.js', 'probe: health']);
    const evidence = await fs.readFile(result.evidencePath!, 'utf8');
    assert.match(evidence, /run_id: run-abc123/);
    assert.match(evidence.trim(), /RESULT: PASS$/);
    assert.match(evidence, /\$ echo down/, 'teardown always runs and is recorded');
  });

  it('fails binary proof when the build did not rewrite the artifact: the pre-merge image', async () => {
    const dir = await tmp('sf-uat-stale-');
    await fs.mkdir(path.join(dir, 'dist'));
    await fs.writeFile(path.join(dir, 'dist', 'app.js'), 'old build');
    const past = new Date(Date.now() - 3_600_000);
    await fs.utimes(path.join(dir, 'dist', 'app.js'), past, past);
    const config = UatSchema.parse({ build: 'true', artifacts: [{ path: 'dist/app.js' }], probes: [{ name: 'p', run: 'true' }] });
    const result = await runUat(dir, config, { runId: 'r', featureId: 'f' });
    assert.equal(result.passed, false);
    assert.match(result.steps[1].detail, /not rebuilt/);
    assert.equal(result.steps.some(s => s.name.startsWith('probe')), false, 'no probe runs against an unproven binary');
  });

  it('fails a probe on a non-zero exit or an unmatched expectation, and still tears down', async () => {
    const calls: string[] = [];
    const shell: ShellRunner = async command => { calls.push(command); return command.includes('admin') ? { exitCode: 0, output: 'HTTP 401' } : { exitCode: 0, output: 'ok' }; };
    const config = UatSchema.parse({ probes: [{ name: 'health', run: 'curl /health', expect: 'ok' }, { name: 'admin route with JWT', run: 'curl /admin', expect: '^HTTP 200' }], teardown: ['stop'] });
    const result = await runUat('/tmp', config, { runId: 'r', featureId: 'f', shell });
    assert.equal(result.passed, false);
    assert.match(result.steps[1].detail, /did not match/);
    assert.deepEqual(calls, ['curl /health', 'curl /admin', 'stop']);
  });

  it('reads the definition from the main checkout, rejects a malformed one, and is absent without one', async () => {
    const dir = await tmp('sf-uat-load-');
    assert.equal(await loadUat(dir), undefined);
    await fs.mkdir(path.join(dir, '.softfactory'));
    await fs.writeFile(path.join(dir, '.softfactory', 'uat.json'), JSON.stringify({ probes: [{ run: 'x' }] }));
    await assert.rejects(loadUat(dir), /uat\.json is invalid: probes\.0\.name/);
  });

  it('the factory fails a completed run whose UAT fails, and says when none is defined', async () => {
    const dir = await tmp('sf-uat-factory-');
    const factory: any = new Factory(dir, '', { strategy: 'cloud', cloudProvider: 'deepseek', cloudModel: 'd', sandbox: 'none' });
    const logs: string[] = [];
    factory.on('log', (l: string) => logs.push(l));
    factory.state = { feature_id: 'f-9', status: 'completed', tasks: [] };
    factory.saveState = async () => {};
    factory.updateHistory = async () => {};
    factory.mergeTarget = () => 'main';
    await factory.uatGate();
    assert.equal(factory.state.status, 'completed');
    assert.ok(logs.some(l => /UAT: none defined/.test(l)));
    await fs.mkdir(path.join(dir, '.softfactory'), { recursive: true });
    await fs.writeFile(path.join(dir, '.softfactory', 'uat.json'), JSON.stringify({ probes: [{ name: 'down', run: 'exit 7' }] }));
    await factory.uatGate();
    assert.equal(factory.state.status, 'failed');
    assert.ok(logs.some(l => /UAT FAIL — probe: down: exit 7/.test(l)), logs.join('\n'));
  });
});

describe('2. bounded learning', () => {
  const lesson = (n: number, check?: string) => ({ lesson: `Lesson number ${n} about the ledger rounding`, tags: ['ledger'], scope: 'project' as const, confidence: 0.9, check, evidence: { taskId: `T${n}`, failure: 'f', resolution: 'r' } });

  it('saves a lesson only with the check that enforces it, and at most three per run', async () => {
    const dir = await tmp('sf-bounded-');
    await fs.mkdir(path.join(dir, '.softfactory'));
    const manager = new LessonManager(dir);
    assert.equal(await manager.add(lesson(0)), false, 'no check, no lesson');
    for (const n of [1, 2, 3]) assert.equal(await manager.add(lesson(n, `npm test -- ledger${n}.test.ts`)), true);
    assert.equal(await manager.add(lesson(4, 'npm test -- ledger4.test.ts')), false, 'a fourth in one run');
    assert.match(await manager.getForPlanning(), /\(enforced by: npm test -- ledger1\.test\.ts\)/);
  });

  it('retires the least used, oldest lessons over the cap instead of growing', () => {
    const lessons = Array.from({ length: 5 }, (_, i) => ({ id: `l${i}`, lesson: `x${i}`.padEnd(12, '.'), tags: [], scope: 'project' as const, confidence: 0.9, evidence: { taskId: 'T', failure: '', resolution: '' }, createdAt: `2026-01-0${i + 1}`, useCount: i === 0 ? 9 : 0, status: 'active' as const }));
    const bounded = LessonManager.bound(lessons, 3);
    assert.deepEqual(bounded.filter(l => l.status === 'retired').map(l => l.id), ['l1', 'l2']);
    assert.equal(bounded.length, 5, 'retired, not deleted');
  });

  it('keeps FACTORY_MEMORY.md within 150 lines by archiving whole old sections', () => {
    const section = (n: number) => `## Feature ${n}\n${Array.from({ length: 60 }, (_, i) => `- fact ${n}.${i}`).join('\n')}`;
    const { kept, archived } = Factory.boundMemory([1, 2, 3, 4].map(section).join('\n\n---\n\n'));
    assert.ok(kept.split('\n').length <= 150);
    assert.match(kept, /## Feature 4/);
    assert.doesNotMatch(kept, /## Feature 1\n/);
    assert.match(archived, /## Feature 1\n/);
  });

  it('indexes merged tasks and hands the planner the similar ones', async () => {
    const dir = await tmp('sf-handoff-');
    await appendHandoff(dir, { date: '2026-10-01', feature_id: 'f-1', task_id: 'T1', title: 'Add CSV export to the reports page', files: ['src/reports/export.ts'], acceptance: 'npm test -- src/reports/export.test.ts', summary: 'Streams rows with\ta tab and a\nnewline' });
    await appendHandoff(dir, { date: '2026-10-02', feature_id: 'f-2', task_id: 'T1', title: 'Rotate signing keys', files: ['src/auth/keys.ts'], acceptance: 'npm test', summary: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' });
    const rows = await readHandoffs(dir);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].summary, 'Streams rows with a tab and a newline', 'tabs and newlines cannot break a row');
    assert.doesNotMatch(rows[1].summary, /abcdefghijklmnop/, 'redacted');
    const similar = await similarHandoffs(dir, 'Add a PDF export next to the CSV export on the reports page');
    assert.equal(similar.length, 1);
    assert.match(similar[0], /T1 "Add CSV export to the reports page" — files: src\/reports\/export\.ts; checked by: npm test/);
  });

  it('keeps micro-fixes out of the escalation rule', () => {
    const run = (cats: string[]) => ({ rejected_by_category: Object.fromEntries(cats.map(c => [c, 1])) }) as any;
    assert.deepEqual(recurringFailures([run(['micro_fix', 'verification']), run(['micro_fix', 'verification']), run([])]), ['verification']);
  });
});

describe('3. the worker-context digest', () => {
  it('leads every worker prompt, outside the listing cap, bounded at 200 lines', async () => {
    const { dir } = await repo({ 'src/a.ts': 'export const a = 1;\n' });
    await fs.mkdir(path.join(dir, '.softfactory'), { recursive: true });
    await fs.writeFile(path.join(dir, '.softfactory', 'worker-context.md'), Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n'));
    const factory: any = new Factory(dir, '', { strategy: 'cloud', cloudProvider: 'deepseek', cloudModel: 'd', sandbox: 'none' });
    const logs: string[] = [];
    factory.on('log', (l: string) => logs.push(l));
    const context = await factory.getProjectContext(dir, { files_hint: ['src/a.ts'] });
    assert.match(context, /^Project digest \(\.softfactory\/worker-context\.md\):\nline 1\n/);
    assert.match(context, /line 200\n/);
    assert.doesNotMatch(context, /line 201/);
    assert.match(context, /Files near this task/);
    assert.ok(logs.some(l => /250 lines; workers see the first 200/.test(l)));
  });

  it('--init writes the starter files and never overwrites one', async () => {
    const dir = await tmp('sf-init-');
    await fs.mkdir(path.join(dir, '.softfactory'));
    await fs.writeFile(path.join(dir, '.softfactory', 'worker-context.md'), 'mine');
    const results = await initProject(dir);
    assert.deepEqual(results.map(r => [r.file, r.written]), [['.softfactory/worker-context.md', false], ['.softfactory/uat.example.json', true], ['.softfactory/environment.example.json', true], ['.softfactory/design/design.md', true], ['.softfactory/protected-paths.txt', true]]);
    assert.equal(await fs.readFile(path.join(dir, '.softfactory', 'worker-context.md'), 'utf8'), 'mine');
    UatSchema.parse(JSON.parse(await fs.readFile(path.join(dir, '.softfactory', 'uat.example.json'), 'utf8')));
    EnvironmentSchema.parse(JSON.parse(await fs.readFile(path.join(dir, '.softfactory', 'environment.example.json'), 'utf8')));
  });
});

describe('4. fork freshness and the wiring census', () => {
  it('lists exports with no call site, counting use inside their own file as wired', async () => {
    const { dir } = await repo({
      'src/used.ts': 'export function used() { return 1; }\n',
      'src/main.ts': "import { used } from './used.js';\nused();\n",
      'src/internal.ts': 'export function helper() { return 2; }\nexport const value = helper();\n',
      'src/orphan.ts': 'export class Orphan {}\n',
      'src/orphan.test.ts': "import { Orphan } from './orphan.js';\nnew Orphan();\n",
      'cmd/server.go': 'package main\nfunc NewServer() {}\nfunc NewUnused() {}\nfunc main() { NewServer() }\n',
    });
    const unwired = await wiringCensus(dir);
    assert.deepEqual(unwired.map(u => `${u.file}#${u.name}`), ['cmd/server.go#NewUnused', 'src/orphan.ts#Orphan'], 'a test is not a call site');
    assert.deepEqual(newlyUnwired(unwired.map(censusKey), unwired), []);
    assert.deepEqual(newlyUnwired(['src/orphan.ts#Orphan'], unwired).map(u => u.name), ['NewUnused']);
  });

  it('the final gate fails a run that adds library code nothing calls', async () => {
    const { dir, git } = await repo({ 'src/main.ts': 'console.log(1);\n' });
    const factory: any = new Factory(dir, '', { strategy: 'cloud', cloudProvider: 'deepseek', cloudModel: 'd', sandbox: 'none' });
    const logs: string[] = [];
    factory.on('log', (l: string) => logs.push(l));
    factory.state = { feature_id: 'f-1', status: 'completed', tasks: [] };
    factory.saveState = async () => {};
    factory.updateHistory = async () => {};
    await factory.captureBaseline();
    assert.deepEqual(factory.state.wiring_baseline, []);
    await fs.writeFile(path.join(dir, 'src', 'lib.ts'), 'export function unreachable() {}\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'lib');
    await factory.wiringGate();
    assert.equal(factory.state.status, 'failed');
    assert.ok(logs.some(l => /added library code that nothing calls: unreachable \(src\/lib\.ts\)/.test(l)), logs.join('\n'));
  });

  async function staleSetup(appMain: string, laterMain: string, branchChange: string, acceptance: string) {
    const { dir, git } = await repo({ 'app.ts': appMain, 'other.ts': 'export const other = 1;\n' });
    const worktree = path.join(dir, '.git', 'wt-T2');
    await git('worktree', 'add', '-q', '-b', 'line/T2', worktree);
    await fs.writeFile(path.join(worktree, 'app.ts'), branchChange);
    await execa('git', ['commit', '-qam', 'T2'], { cwd: worktree });
    await fs.writeFile(path.join(dir, 'app.ts'), laterMain);
    await git('commit', '-qam', 'T1 merged first');
    const factory: any = new Factory(dir, '', { strategy: 'cloud', cloudProvider: 'deepseek', cloudModel: 'd', sandbox: 'none' });
    factory.state = { feature_id: 'f-1', status: 'active', tasks: [] };
    factory.mergeTarget = () => 'main';
    const task = { id: 'T2', title: 't', agent_role: 'coder', verification_command: acceptance, attempts: 0, files_hint: ['app.ts'], creates_files: [] };
    return { factory, task, worktree, git };
  }

  it('lets a stale branch merge when it combines cleanly and its acceptance still passes', async () => {
    const { factory, task, worktree } = await staleSetup('a\nb\nc\nd\ne\n', 'a\nB-from-T1\nc\nd\ne\n', 'a\nb\nc\nd\nE-from-T2\n', 'grep E-from-T2 app.ts');
    assert.equal(await factory.forkFreshness(task, 'line/T2', worktree), null);
    assert.match(await fs.readFile(path.join(worktree, 'app.ts'), 'utf8'), /B-from-T1[\s\S]*E-from-T2/, 'the branch now carries what merged first');
  });

  it('refuses a stale branch whose acceptance fails once combined with what merged first, and rolls the trial merge back', async () => {
    const { factory, task, worktree } = await staleSetup('flag=old\nx\ny\nz\ntail\n', 'flag=renamed\nx\ny\nz\ntail\n', 'flag=old\nx\ny\nz\ntail-uses-flag=old\n', 'grep -x flag=old app.ts');
    const before = (await execa('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout;
    const stale = await factory.forkFreshness(task, 'line/T2', worktree);
    assert.match(stale, /Combined with work merged after this task started, its acceptance command fails: grep -x flag=old app\.ts exited 1\. Both changed: app\.ts\./);
    assert.equal((await execa('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout, before, 'the trial merge is undone');
  });

  it('refuses a stale branch that conflicts, naming the files', async () => {
    const { factory, task, worktree } = await staleSetup('one\n', 'one-from-T1\n', 'one-from-T2\n', 'grep one app.ts');
    assert.match(await factory.forkFreshness(task, 'line/T2', worktree), /conflicts with work merged after it started \(app\.ts\)/);
    assert.equal((await execa('git', ['status', '--porcelain'], { cwd: worktree })).stdout.trim(), '', 'the merge was aborted');
  });

  it('says nothing about a fresh branch', async () => {
    const { dir, git } = await repo({ 'app.ts': 'a\n' });
    const worktree = path.join(dir, '.git', 'wt-T1');
    await git('worktree', 'add', '-q', '-b', 'line/T1', worktree);
    const factory: any = new Factory(dir, '', { strategy: 'cloud', cloudProvider: 'deepseek', cloudModel: 'd', sandbox: 'none' });
    factory.state = { feature_id: 'f-1', status: 'active', tasks: [] };
    factory.mergeTarget = () => 'main';
    assert.equal(await factory.forkFreshness({ id: 'T1', verification_command: 'false' }, 'line/T1', worktree), null);
  });
});

describe('5. micro-fix', () => {
  const factory: any = new Factory('/tmp', '', { strategy: 'cloud', cloudProvider: 'deepseek', cloudModel: 'd', sandbox: 'none' });
  const task = (over: Record<string, unknown> = {}) => ({ id: 'T1', protected: false, micro_fix_used: false, agent_role: 'coder', ...over });

  it('is allowed once, for a mechanical defect, on unprotected implementation work', () => {
    assert.equal(factory.microFixAllowed(task(), { fixKind: 'mechanical' }), true);
    assert.equal(factory.microFixAllowed(task(), { fixKind: 'logic' }), false);
    assert.equal(factory.microFixAllowed(task(), {}), false, 'unclassified is not mechanical');
    assert.equal(factory.microFixAllowed(task({ protected: true }), { fixKind: 'mechanical' }), false);
    assert.equal(factory.microFixAllowed(task({ micro_fix_used: true }), { fixKind: 'mechanical' }), false);
    assert.equal(factory.microFixAllowed(task({ agent_role: 'test_writer' }), { fixKind: 'mechanical' }), false);
  });

  it('two reviewers make it mechanical only when every failing one says so', async () => {
    const v = (verdict: 'PASS' | 'FAIL', fixKind?: 'mechanical' | 'logic') => ({ verdict, feedback: 'f', provider: 'p', model: 'm', ...(fixKind ? { fixKind } : {}) });
    assert.equal((await factory.combineVerdicts([v('FAIL', 'mechanical'), v('FAIL', 'mechanical')], false, async () => v('PASS'))).review.fixKind, 'mechanical');
    assert.equal((await factory.combineVerdicts([v('FAIL', 'mechanical'), v('FAIL', 'logic')], false, async () => v('PASS'))).review.fixKind, 'logic');
  });
});

describe('a dependency-free Node package', () => {
  it('needs no lockfile and no install, with or without the sandbox', async () => {
    const { TaskVerifier } = await import('./TaskVerifier.js');
    const dir = await tmp('sf-nodeps-');
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }));
    const sandbox: any = { active: true, nodeDependencyMounts: async () => [] };
    assert.deepEqual(await new TaskVerifier(sandbox).prepare(dir, { files_hint: ['a.js'] } as any), { ok: true });
    assert.deepEqual(await new TaskVerifier().prepare(dir, { files_hint: ['a.js'] } as any), { ok: true });
  });
});

describe('softfactory leaves the tracked .gitignore alone', () => {
  it('seeds git\'s local exclude file instead, so the checkout stays clean', async () => {
    const { WorktreeManager } = await import('./WorktreeManager.js');
    const { dir, git } = await repo({ '.gitignore': 'dist/\n', 'a.txt': 'a\n' });
    await new WorktreeManager(dir).init();
    assert.equal((await git('status', '--porcelain')).stdout.trim(), '', 'nothing to commit');
    const exclude = await fs.readFile(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    assert.match(exclude, /# added by softfactory\nnode_modules\/\n\.softfactory\/\n\.env\n\.env\.local\n/);
    assert.doesNotMatch(exclude, /^dist\/$/m, 'already ignored by the project');
    await fs.mkdir(path.join(dir, '.softfactory'));
    await fs.writeFile(path.join(dir, '.softfactory', 'x'), '');
    await fs.writeFile(path.join(dir, '.env'), 'K=v');
    assert.equal((await git('status', '--porcelain')).stdout.trim(), '', 'still ignored');
  });
});
