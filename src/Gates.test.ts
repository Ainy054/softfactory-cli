import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readGates, openGates, decideGate, answered, GATES_FILE } from './Gates.js';
import { readiness, ProgramSchema, DEFAULT_ALWAYS_STOP } from './Program.js';

const tempDirs: string[] = [];
async function repoWith(gatesMd?: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-gates-'));
  tempDirs.push(dir);
  if (gatesMd !== undefined) {
    await fs.mkdir(path.join(dir, '.softfactory'), { recursive: true });
    await fs.writeFile(path.join(dir, GATES_FILE), gatesMd);
  }
  return dir;
}
after(async () => {
  await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

const SAMPLE = `# Gates

| id | class | status | scope | question | chosen by | date |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | contract | open | api/** | Do we version the /rates response? | | |
|  G2  |engineering| decided | app/db/**, app/cache/** | SQLite or Postgres for the cache? | driver: SQLite, single-node deploy | 2026-10-12 |
| broken row |
| G3 | regulatory | open | ops/** | Data retention period?
`;

describe('readGates', () => {
  it('parses the table, tolerating spacing and missing trailing cells, and reports a malformed row', async () => {
    const { gates, skipped } = await readGates(await repoWith(SAMPLE));
    assert.deepEqual(gates.map(g => [g.id, g.class, g.status, g.scope]), [
      ['G1', 'contract', 'open', ['api/**']],
      ['G2', 'engineering', 'decided', ['app/db/**', 'app/cache/**']],
      ['G3', 'regulatory', 'open', ['ops/**']],
    ]);
    assert.equal(gates[1].chosen_by, 'driver: SQLite, single-node deploy');
    assert.equal(gates[2].question, 'Data retention period?');
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /^line 7: \| broken row \|/);
  });

  it('returns nothing when there is no register', async () => {
    assert.deepEqual(await readGates(await repoWith()), { gates: [], skipped: [] });
  });
});

describe('openGates', () => {
  it('keeps only open gates whose class always stops', async () => {
    const dir = await repoWith(SAMPLE);
    assert.deepEqual((await openGates(dir, ['contract'])).map(g => g.id), ['G1']);
    assert.deepEqual((await openGates(dir, DEFAULT_ALWAYS_STOP)).map(g => g.id), ['G1', 'G3']);
  });
});

describe('decideGate', () => {
  it('decides and logs an engineering question with its reason', async () => {
    const dir = await repoWith(SAMPLE);
    const decision = await decideGate(dir, { class: 'engineering', scope: 'app/**', question: 'Use httpx or requests?', choice: 'httpx', reason: 'async client already in use' }, DEFAULT_ALWAYS_STOP);
    assert.equal(decision.stop, false);
    assert.equal(decision.gate.id, 'G4');
    const row = (await readGates(dir)).gates.find(g => g.id === 'G4')!;
    assert.equal(row.status, 'decided');
    assert.equal(row.chosen_by, 'driver: httpx, async client already in use');
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('appends an open row for a contract question and says stop', async () => {
    const dir = await repoWith();
    const decision = await decideGate(dir, { class: 'contract', scope: 'api/**', question: 'Rename the rate field?', choice: 'yes', reason: 'clearer' }, DEFAULT_ALWAYS_STOP);
    assert.equal(decision.stop, true);
    assert.equal(decision.gate.id, 'G1');
    const content = await fs.readFile(path.join(dir, GATES_FILE), 'utf8');
    assert.match(content, /^# Gates\n\n\| id \| class \| status \| scope \| question \| chosen by \| date \|/);
    assert.deepEqual((await openGates(dir, DEFAULT_ALWAYS_STOP)).map(g => [g.id, g.question, g.chosen_by]), [['G1', 'Rename the rate field?', '']]);
  });

  it('cites a question already decided instead of appending it again', async () => {
    const dir = await repoWith(SAMPLE);
    const decision = await decideGate(dir, { class: 'engineering', scope: 'app/**', question: 'sqlite or postgres for the cache', choice: 'Postgres', reason: 'changed my mind' }, DEFAULT_ALWAYS_STOP);
    assert.deepEqual([decision.stop, decision.stop ? undefined : decision.cited, decision.gate.id], [false, true, 'G2']);
    assert.equal((await readGates(dir)).gates.length, 3);
    assert.equal((await answered(dir, 'SQLite or Postgres for the cache?'))?.id, 'G2');
  });

  it('keeps a pipe inside a cell', async () => {
    const dir = await repoWith();
    await decideGate(dir, { class: 'engineering', scope: 'app/**', question: 'Use a | b?', choice: 'a', reason: 'simpler' }, DEFAULT_ALWAYS_STOP);
    assert.equal((await readGates(dir)).gates[0].question, 'Use a | b?');
  });
});

describe('readiness with the gate register', () => {
  const program = ProgramSchema.parse({
    goal: 'g',
    contexts: [
      { id: 'api', scope: ['api/v1/*.py'] },
      { id: 'app', scope: ['app/**'] },
      { id: 'ops', scope: ['ops/**'] },
    ],
  });
  const deps = (dir: string) => ({
    archived: async () => null,
    prState: async () => 'OPEN' as const,
    openGates: () => openGates(dir, program.policy.always_stop),
  });

  it('a context whose scope overlaps an open contract gate is not ready; others are', async () => {
    const verdicts = await readiness(program, deps(await repoWith(SAMPLE)));
    assert.deepEqual(verdicts.map(v => [v.id, v.ready, v.reason]), [
      ['api', false, 'open contract gate G1 covers scope'],
      ['app', true, 'ready'],
      ['ops', false, 'open regulatory gate G3 covers scope'],
    ]);
  });

  it('a decided gate or one outside the scope does not stop anything', async () => {
    const md = SAMPLE.replace('| G1 | contract | open |', '| G1 | contract | decided |').replace('| G3 | regulatory | open | ops/** |', '| G3 | regulatory | open | docs/*.md |');
    const verdicts = await readiness(program, deps(await repoWith(md)));
    assert.deepEqual(verdicts.map(v => v.ready), [true, true, true]);
  });
});
