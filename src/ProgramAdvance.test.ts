import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { advance, acquireLock, fruitless, launchdPlist, launchdLabel, launchdPlistPath, LOCK_FILE, type AdvanceDeps, type RunOutcome } from './ProgramAdvance.js';
import { loadProgram, saveProgram, ProgramSchema, unparkContext, readiness, STOPPED_FILE } from './Program.js';
import { decideGate, openGates } from './Gates.js';

const tempDirs: string[] = [];
after(async () => { await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true }))); });

async function programDir(contexts: Array<Record<string, unknown>>, policy: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-advance-'));
  tempDirs.push(dir);
  await saveProgram(dir, ProgramSchema.parse({ goal: 'Ship the rates service', contexts, policy }));
  return dir;
}

/** A world the advance runs in: PR states, the run function's outcomes, and what it was asked to run. */
function world(dir: string, outcomes: Array<Partial<RunOutcome>> = []) {
  const prs = new Map<number, 'OPEN' | 'MERGED' | 'CLOSED'>();
  const runs: Array<{ context: string; requirement: string; resume: boolean }> = [];
  const lines: string[] = [];
  let nextPr = 1;
  let flight: { feature_id: string; status: string } | null = null;
  const deps: AdvanceDeps = {
    archived: async () => null,
    prState: async number => prs.get(number) ?? 'OPEN',
    openGates: async () => openGates(dir, (await loadProgram(dir)).policy.always_stop),
    inFlight: async () => flight,
    now: () => Date.now(),
    pidAlive: () => false,
    log: line => lines.push(line),
    runContext: async (context, requirement, { resume }) => {
      runs.push({ context, requirement, resume });
      const outcome = outcomes.shift() ?? {};
      const pr = outcome.status && outcome.status !== 'completed' ? undefined : nextPr++;
      if (pr) prs.set(pr, 'OPEN');
      return { feature_id: `f-${runs.length}`, status: 'completed', commits: 2, tokens: 1000, pr, ...outcome };
    },
  };
  return { deps, prs, runs, lines, setFlight: (value: typeof flight) => { flight = value; } };
}

const ABC = [
  { id: 'A', goal: 'API', scope: ['api/**'] },
  { id: 'B', goal: 'Web', scope: ['web/**'], depends_on: ['A'] },
  { id: 'C', goal: 'Jobs', scope: ['jobs/**'], depends_on: ['A'] },
];

describe('program advance', () => {
  it('runs A, waits while its PR is open, then runs B after the merge', async () => {
    const dir = await programDir(ABC);
    const w = world(dir);

    const first = await advance(dir, w.deps);
    assert.deepEqual([first.action, 'context' in first && first.context], ['done', 'A']);
    assert.match(w.runs[0].requirement, /Ship the rates service[\s\S]*API[\s\S]*change only files under: api\/\*\*/);

    const second = await advance(dir, w.deps);
    assert.equal(second.action, 'idle');
    assert.ok(w.lines.includes('  B: waits on A (PR #1 open)'), w.lines.join('\n'));

    w.prs.set(1, 'MERGED');
    const third = await advance(dir, w.deps);
    assert.deepEqual([third.action, 'context' in third && third.context], ['done', 'B']);

    const program = await loadProgram(dir);
    assert.deepEqual(program.contexts.map(c => [c.id, c.status, c.feature_id, c.pr]), [['A', 'done', 'f-1', 1], ['B', 'done', 'f-2', 2], ['C', 'pending', null, null]]);
    assert.deepEqual(program.history.map(h => [h.context, h.action, h.commits ?? null]), [['A', 'done', 2], ['program', 'idle', null], ['B', 'done', 2]]);
    await assert.rejects(fs.access(path.join(dir, LOCK_FILE)), 'the lock is released');
  });

  it('parks a run that blocks, and the next advance picks the next ready context', async () => {
    const dir = await programDir([{ id: 'A', scope: ['api/**'] }, { id: 'B', scope: ['web/**'] }]);
    const w = world(dir, [{ status: 'partial', commits: 1, blocked_reason: 'T2 blocked: no file changed' }]);

    const first = await advance(dir, w.deps);
    assert.equal(first.action, 'parked');
    assert.match(first.message, /A parked: T2 blocked: no file changed/);

    const second = await advance(dir, w.deps);
    assert.deepEqual([second.action, 'context' in second && second.context], ['done', 'B']);

    const program = await loadProgram(dir);
    assert.deepEqual(program.contexts.map(c => [c.id, c.status, c.parked_reason]), [['A', 'parked', 'T2 blocked: no file changed'], ['B', 'done', null]]);

    await unparkContext(dir, 'A');
    assert.equal((await loadProgram(dir)).contexts[0].status, 'pending');
    assert.equal((await loadProgram(dir)).history.at(-1)?.action, 'unpark');
  });

  it('parks a context whose plan the checklist declined, and one whose run throws', async () => {
    const dir = await programDir([{ id: 'A', scope: ['api/**'] }, { id: 'B', scope: ['web/**'] }]);
    const w = world(dir, [{ status: 'planned', commits: 0 }]);
    assert.match((await advance(dir, w.deps)).message, /A parked: the plan checklist declined the plan; see \.softfactory\/gates\.md/);
    w.deps.runContext = async () => { throw new Error('DeepSeek returned 402\nbody'); };
    assert.match((await advance(dir, w.deps)).message, /B parked: run failed: DeepSeek returned 402/);
  });

  it('an open always-stop gate on C\'s scope keeps C waiting, and the advance says so', async () => {
    const dir = await programDir([{ id: 'C', scope: ['jobs/**'] }]);
    await decideGate(dir, { class: 'contract', scope: 'jobs/**', question: 'Change the job payload?', choice: '', reason: '' }, ['contract']);
    const w = world(dir);
    const result = await advance(dir, w.deps);
    assert.equal(result.action, 'idle');
    assert.equal(w.runs.length, 0);
    assert.ok(w.lines.includes('  C: open contract gate G1 covers scope'), w.lines.join('\n'));
  });

  it('stops itself after three runs that merge nothing, and the fourth advance does nothing', async () => {
    const dir = await programDir([{ id: 'A', scope: ['api/**'] }, { id: 'B', scope: ['web/**'] }, { id: 'C', scope: ['jobs/**'] }, { id: 'D', scope: ['docs/**'] }]);
    const w = world(dir, [{ status: 'failed', commits: 0 }, { status: 'failed', commits: 0 }, { status: 'failed', commits: 0 }]);
    for (let i = 0; i < 3; i++) assert.equal((await advance(dir, w.deps)).action, 'parked');
    const fourth = await advance(dir, w.deps);
    assert.equal(fourth.action, 'stopped');
    assert.match(fourth.message, /stopped after 3 fruitless advances/);
    assert.match(await fs.readFile(path.join(dir, STOPPED_FILE), 'utf8'), /stopped after 3 fruitless advances/);
    const fifth = await advance(dir, w.deps);
    assert.equal(fifth.action, 'stopped');
    assert.equal(w.runs.length, 3, 'D never ran');
  });

  it('a run that merged something resets the fruitless count, and so does program resume', () => {
    const entry = (action: string, commits?: number) => ({ at: new Date().toISOString(), context: 'A', action, result: 'x', commits });
    const program = (history: ReturnType<typeof entry>[]) => ProgramSchema.parse({ goal: 'g', history });
    assert.equal(fruitless(program([entry('parked', 0), entry('parked', 0), entry('parked', 0)])), true);
    assert.equal(fruitless(program([entry('parked', 0), entry('done', 3), entry('parked', 0), entry('parked', 0)])), false);
    assert.equal(fruitless(program([entry('parked', 0), entry('parked', 0), entry('parked', 0), entry('resume')])), false);
    assert.equal(fruitless(program([entry('parked', 0), entry('idle'), entry('parked', 0), entry('idle')])), false, 'idle advances are not runs');
  });

  it('waits when the budget window is spent', async () => {
    const dir = await programDir([{ id: 'A', scope: ['api/**'] }], { budget_window: { tokens: 1000, hours: 24 } });
    const w = world(dir);
    await advance(dir, w.deps);
    const second = await advance(dir, w.deps);
    assert.equal(second.action, 'idle');
    assert.match(second.message, /budget window spent \(1000 of 1000 tokens in 24h\)/);
  });

  it('resumes the context whose feature is in flight instead of starting another', async () => {
    const dir = await programDir([{ id: 'A', scope: ['api/**'], status: 'active', feature_id: 'f-9' }, { id: 'B', scope: ['web/**'] }]);
    const w = world(dir, [{ status: 'halted', commits: 1 }]);
    w.setFlight({ feature_id: 'f-9', status: 'active' });
    const result = await advance(dir, w.deps);
    assert.deepEqual(w.runs.map(r => [r.context, r.resume]), [['A', true]]);
    assert.equal(result.action, 'resumed');
    assert.equal((await loadProgram(dir)).contexts[0].status, 'active', 'a halted run stays in flight');
  });

  it('starts the next slice only after the previous slice\'s PR merges', async () => {
    const dir = await programDir([{ id: 'A', scope: ['api/**'], size: 'xl', slices: ['models', 'routes'] }]);
    const w = world(dir);
    assert.equal((await advance(dir, w.deps)).action, 'started');
    let program = await loadProgram(dir);
    assert.deepEqual([program.contexts[0].status, program.contexts[0].slice_index, program.contexts[0].pr], ['pending', 1, 1]);
    assert.deepEqual((await readiness(program, w.deps)).map(v => v.reason), ['waits on its slice 1 PR #1 (open)']);
    w.prs.set(1, 'MERGED');
    assert.equal((await advance(dir, w.deps)).action, 'done');
    assert.match(w.runs[1].requirement, /routes[\s\S]*this is slice 2 of 2/);
    program = await loadProgram(dir);
    assert.equal(program.contexts[0].status, 'done');
  });
});

describe('the advance lock', () => {
  it('a live lock makes a concurrent advance exit without work; a dead-pid lock is replaced', async () => {
    const dir = await programDir([{ id: 'A', scope: ['api/**'] }]);
    await fs.writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 4242, host: 'h', started_at: new Date().toISOString() }));
    const w = world(dir);
    w.deps.pidAlive = pid => pid === 4242;
    const locked = await advance(dir, w.deps);
    assert.deepEqual([locked.action, locked.message], ['locked', 'program: another advance is running (pid 4242)']);
    assert.equal(w.runs.length, 0);

    w.deps.pidAlive = () => false;
    assert.equal((await advance(dir, w.deps)).action, 'done');
    assert.equal(w.runs.length, 1);
  });

  it('a lock older than six hours is stale even if its pid is alive', async () => {
    const dir = await programDir([]);
    await fs.writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 4242, started_at: new Date(Date.now() - 7 * 3_600_000).toISOString() }));
    const lock = await acquireLock(dir, { now: () => Date.now(), pidAlive: () => true });
    assert.ok('release' in lock);
    await lock.release();
  });
});

describe('the launchd schedule', () => {
  it('writes a plist that runs one advance in the repository on an interval, logging to program.log', () => {
    const plist = launchdPlist({ repoPath: '/Users/me/rates', nodePath: '/usr/local/bin/node', cliPath: '/opt/softfactory/dist/index.js', everyMinutes: 30, args: ['--strategy=cloud', '--cloud-provider=deepseek'] });
    assert.match(plist, new RegExp(`<string>${launchdLabel('/Users/me/rates').replace(/\./g, '\\.')}</string>`));
    assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>\n    <string>\/opt\/softfactory\/dist\/index\.js<\/string>\n    <string>program<\/string>\n    <string>--strategy=cloud<\/string>/);
    assert.match(plist, /<key>WorkingDirectory<\/key>\n  <string>\/Users\/me\/rates<\/string>/);
    assert.match(plist, /<key>StartInterval<\/key>\n  <integer>1800<\/integer>/);
    assert.match(plist, /<key>StandardOutPath<\/key>\n  <string>\/Users\/me\/rates\/\.softfactory\/program\.log<\/string>/);
    assert.equal(launchdPlistPath('/Users/me/rates', '/Users/me'), `/Users/me/Library/LaunchAgents/${launchdLabel('/Users/me/rates')}.plist`);
    assert.notEqual(launchdLabel('/Users/me/rates'), launchdLabel('/Users/me/other'));
  });
});
