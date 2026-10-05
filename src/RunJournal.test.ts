import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunJournal, GENESIS, canonical, entryHash } from './RunJournal.js';

async function tempRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-journal-'));
  await fs.mkdir(path.join(dir, '.softfactory', 'evidence', 'f-1'), { recursive: true });
  await fs.writeFile(path.join(dir, '.softfactory', 'evidence', 'f-1', 'T1-attempt1.log'), 'grep x\nRESULT: PASS\n');
  return dir;
}

describe('the run journal is a hash chain over the run and its evidence', () => {
  it('links every entry to the one before it and hashes the files it cites', async () => {
    const dir = await tempRepo();
    const journal = new RunJournal(dir, 'f-1');
    const first = await journal.append('plan:accepted', { tasks: ['T1'] });
    const second = await journal.append('task:acceptance', { task_id: 'T1', passed: true }, ['.softfactory/evidence/f-1/T1-attempt1.log']);
    assert.equal(first.seq, 1);
    assert.equal(first.prev, GENESIS);
    assert.equal(second.prev, first.hash);
    assert.match(second.files!['.softfactory/evidence/f-1/T1-attempt1.log'], /^[0-9a-f]{64}$/);
    const result = await RunJournal.verify(dir, 'f-1');
    assert.deepEqual({ ok: result.ok, entries: result.entries, filesChecked: result.filesChecked, problems: result.problems }, { ok: true, entries: 2, filesChecked: 1, problems: [] });
    assert.equal(result.head, second.hash);
  });

  it('continues the chain across processes by reading the head back from disk', async () => {
    const dir = await tempRepo();
    const a = await new RunJournal(dir, 'f-1').append('one', {});
    const b = await new RunJournal(dir, 'f-1').append('two', {});
    assert.equal(b.prev, a.hash);
    assert.equal(b.seq, 2);
    assert.equal((await RunJournal.verify(dir, 'f-1')).ok, true);
  });

  it('detects an edited entry, a removed entry, and changed evidence, naming each', async () => {
    const dir = await tempRepo();
    const journal = new RunJournal(dir, 'f-1');
    await journal.append('plan:accepted', { tasks: ['T1'] });
    await journal.append('task:acceptance', { task_id: 'T1', passed: false }, ['.softfactory/evidence/f-1/T1-attempt1.log']);
    await journal.append('task:merged', { task_id: 'T1' });
    const file = RunJournal.pathFor(dir, 'f-1');
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');

    // 1. The verdict is flipped after the fact.
    const edited = [...lines];
    edited[1] = edited[1].replace('"passed":false', '"passed":true');
    await fs.writeFile(file, edited.join('\n') + '\n');
    let result = await RunJournal.verify(dir, 'f-1');
    assert.equal(result.ok, false);
    assert.ok(result.problems.some(p => /entry 2 \(task:acceptance\): content was changed/.test(p)), result.problems.join('\n'));

    // 2. The failing acceptance is dropped from the record.
    await fs.writeFile(file, [lines[0], lines[2]].join('\n') + '\n');
    result = await RunJournal.verify(dir, 'f-1');
    assert.ok(result.problems.some(p => /seq is 3, expected 2/.test(p)), result.problems.join('\n'));
    assert.ok(result.problems.some(p => /prev hash does not match/.test(p)));

    // 3. The evidence file is rewritten to say PASS.
    await fs.writeFile(file, lines.join('\n') + '\n');
    await fs.writeFile(path.join(dir, '.softfactory', 'evidence', 'f-1', 'T1-attempt1.log'), 'grep x\nRESULT: PASS (edited)\n');
    result = await RunJournal.verify(dir, 'f-1');
    assert.ok(result.problems.some(p => /T1-attempt1\.log differs from the content recorded/.test(p)), result.problems.join('\n'));
    assert.equal(result.problems.length, 1, 'the chain itself is intact; only the evidence changed');
  });

  it('reports a missing journal plainly', async () => {
    const result = await RunJournal.verify(await tempRepo(), 'f-none');
    assert.equal(result.ok, false);
    assert.match(result.problems[0], /no journal for run f-none/);
  });

  it('hashes canonically, so key order cannot forge or break a chain', () => {
    assert.equal(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
    const base = { seq: 1, timestamp: 't', event: 'e', data: { x: 1 }, prev: GENESIS };
    assert.equal(entryHash(base), entryHash({ ...base, data: { x: 1 } }));
    assert.notEqual(entryHash(base), entryHash({ ...base, data: { x: 2 } }));
  });

  it('redacts secrets before they are written', async () => {
    const dir = await tempRepo();
    const entry = await new RunJournal(dir, 'f-1').append('attempt:failed', { detail: 'token sk-abcdefghijklmnopqrstuvwxyz0123456789 leaked' });
    assert.doesNotMatch(JSON.stringify(entry.data), /sk-abcdefghijklmnopqrstuvwxyz/);
  });
});
