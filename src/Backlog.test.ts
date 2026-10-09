import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  appendFollowUps,
  openBacklog,
  triage,
  BACKLOG_FILE,
  MAX_ITEMS_PER_TASK,
  type Entry,
} from './Backlog.js';
import { Factory } from './Factory.js';

/** Every temporary directory this file creates, removed once the suite ends. */
const tempDirs: string[] = [];
async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-backlog-'));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** The raw JSONL entries, in file order. */
async function readRaw(baseDir: string): Promise<Entry[]> {
  const content = await fs.readFile(path.join(baseDir, BACKLOG_FILE), 'utf8').catch(() => '');
  return content.split('\n').filter(Boolean).map(line => JSON.parse(line) as Entry);
}

describe('Backlog.appendFollowUps: dedupe', () => {
  it('records each distinct item once and returns the entries written', async () => {
    const baseDir = await makeDir();

    const added = await appendFollowUps(baseDir, 'feat-1', 'task-1', ['Add a retry to the uploader', 'Document the flag']);

    assert.equal(added.length, 2);
    assert.deepEqual(added.map(e => e.text), ['Add a retry to the uploader', 'Document the flag']);
    assert.ok(added.every(e => e.status === 'open' && e.task_id === 'task-1' && e.feature_id === 'feat-1'));
    assert.equal((await openBacklog(baseDir)).length, 2);
  });

  it('dedupes by normalized text against open entries, so "Fix the X." and "fix the x" are one', async () => {
    const baseDir = await makeDir();

    await appendFollowUps(baseDir, 'feat-1', 'task-1', ['Fix the X.']);
    const again = await appendFollowUps(baseDir, 'feat-1', 'task-2', ['fix   the x']);

    assert.deepEqual(again, [], 'the normalized-equal item must not be written twice');
    assert.equal((await openBacklog(baseDir)).length, 1);
  });

  it('dedupes items within a single call', async () => {
    const baseDir = await makeDir();

    const added = await appendFollowUps(baseDir, 'feat-1', 'task-1', ['Rename the field', 'Rename  the field ']);

    assert.equal(added.length, 1);
    assert.equal((await openBacklog(baseDir)).length, 1);
  });

  it('still dedupes against a kept entry', async () => {
    const baseDir = await makeDir();
    const [entry] = await appendFollowUps(baseDir, 'feat-1', 'task-1', ['Cache the lookup']);
    await triage(baseDir, entry.id, 'keep');

    const again = await appendFollowUps(baseDir, 'feat-1', 'task-2', ['cache the lookup']);

    assert.deepEqual(again, []);
    assert.equal((await openBacklog(baseDir)).length, 1);
  });

  it('treats a dropped entry as gone, so the same gap can be reported again', async () => {
    const baseDir = await makeDir();
    const [entry] = await appendFollowUps(baseDir, 'feat-1', 'task-1', ['Delete the dead branch']);
    await triage(baseDir, entry.id, 'drop');

    const added = await appendFollowUps(baseDir, 'feat-1', 'task-2', ['Delete the dead branch']);

    assert.equal(added.length, 1, 'a dropped item no longer blocks the same text');
    assert.equal((await openBacklog(baseDir)).length, 1);
  });
});

describe('Backlog.appendFollowUps: the 5-per-task cap', () => {
  it('keeps at most five follow-ups per task', async () => {
    const baseDir = await makeDir();

    const added = await appendFollowUps(baseDir, 'feat-1', 'task-1', ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']);

    assert.equal(MAX_ITEMS_PER_TASK, 5);
    assert.equal(added.length, 5);
    assert.deepEqual(added.map(e => e.text), ['a1', 'a2', 'a3', 'a4', 'a5']);
    assert.equal((await openBacklog(baseDir)).length, 5);
  });

  it('gives the cap back when a task is already at the limit on a later call', async () => {
    const baseDir = await makeDir();

    await appendFollowUps(baseDir, 'feat-1', 'task-1', ['a1', 'a2', 'a3', 'a4', 'a5']);
    const more = await appendFollowUps(baseDir, 'feat-1', 'task-1', ['a6', 'a7']);

    assert.deepEqual(more, [], 'a task already owning five open items may not add more');
    assert.equal((await openBacklog(baseDir)).length, 5);
  });

  it('applies the cap per task, not per feature', async () => {
    const baseDir = await makeDir();

    await appendFollowUps(baseDir, 'feat-1', 'task-1', ['a1', 'a2', 'a3', 'a4', 'a5']);
    const other = await appendFollowUps(baseDir, 'feat-1', 'task-2', ['b1', 'b2']);

    assert.equal(other.length, 2);
    assert.equal((await openBacklog(baseDir)).length, 7);
  });
});

describe('Backlog.triage: statuses', () => {
  it('keep marks the entry kept and leaves it open for the next plan', async () => {
    const baseDir = await makeDir();
    const [entry] = await appendFollowUps(baseDir, 'feat-1', 'task-1', ['Keep me']);

    const result = await triage(baseDir, entry.id, 'keep');

    assert.equal(result, undefined);
    const open = await openBacklog(baseDir);
    assert.equal(open.length, 1);
    assert.equal(open[0].status, 'kept');
    assert.equal((await readRaw(baseDir))[0].status, 'kept');
  });

  it('drop marks the entry dropped and removes it from the open backlog', async () => {
    const baseDir = await makeDir();
    const [entry] = await appendFollowUps(baseDir, 'feat-1', 'task-1', ['Drop me']);

    const result = await triage(baseDir, entry.id, 'drop');

    assert.equal(result, undefined);
    assert.deepEqual(await openBacklog(baseDir), []);
    assert.equal((await readRaw(baseDir))[0].status, 'dropped');
  });

  it('promote returns the text so the caller can queue it and marks it promoted', async () => {
    const baseDir = await makeDir();
    const [entry] = await appendFollowUps(baseDir, 'feat-1', 'task-1', ['Promote me']);

    const result = await triage(baseDir, entry.id, 'promote');

    assert.equal(result, 'Promote me');
    assert.deepEqual(await openBacklog(baseDir), []);
    assert.equal((await readRaw(baseDir))[0].status, 'promoted');
  });

  it('is a no-op for an unknown id, so a stale list cannot crash a run', async () => {
    const baseDir = await makeDir();
    await appendFollowUps(baseDir, 'feat-1', 'task-1', ['Stay open']);

    const result = await triage(baseDir, 'bl-does-not-exist', 'drop');

    assert.equal(result, undefined);
    const open = await openBacklog(baseDir);
    assert.equal(open.length, 1);
    assert.equal(open[0].status, 'open');
  });
});

describe('Factory.planningHistory: backlog section', () => {
  it('includes an open item but not a dropped one', async () => {
    const baseDir = await makeDir();
    const factory: any = new Factory(baseDir, '', { strategy: 'local' });
    factory.log = () => {};

    const [openEntry, droppedEntry] = await appendFollowUps(baseDir, 'feat-1', 'task-1', ['OPEN-BACKLOG-ITEM', 'DROPPED-BACKLOG-ITEM']);
    await triage(baseDir, droppedEntry.id, 'drop');

    const history = await factory.planningHistory([], 'the requirement', []);

    assert.match(history, /Backlog from earlier runs \(plan these only if the requirement covers them\):/);
    assert.ok(history.includes(openEntry.text), 'the open item must reach the planner');
    assert.ok(history.includes(openEntry.id), 'the open item id must reach the planner');
    assert.ok(!history.includes(droppedEntry.text), 'a dropped item must not reach the planner');
    assert.ok(!history.includes(droppedEntry.id), 'a dropped item id must not reach the planner');
  });

  it('includes a kept item as well', async () => {
    const baseDir = await makeDir();
    const factory: any = new Factory(baseDir, '', { strategy: 'local' });
    factory.log = () => {};

    const [kept] = await appendFollowUps(baseDir, 'feat-1', 'task-1', ['KEPT-BACKLOG-ITEM']);
    await triage(baseDir, kept.id, 'keep');

    const history = await factory.planningHistory([], 'the requirement', []);

    assert.ok(history.includes(kept.text));
  });

  it('omits the section entirely when every entry has been triaged away', async () => {
    const baseDir = await makeDir();
    const factory: any = new Factory(baseDir, '', { strategy: 'local' });
    factory.log = () => {};

    const [entry] = await appendFollowUps(baseDir, 'feat-1', 'task-1', ['GONE-BACKLOG-ITEM']);
    await triage(baseDir, entry.id, 'drop');

    const history = await factory.planningHistory([], 'the requirement', []);

    assert.doesNotMatch(history, /Backlog from earlier runs/);
    assert.ok(!history.includes(entry.text));
  });
});
