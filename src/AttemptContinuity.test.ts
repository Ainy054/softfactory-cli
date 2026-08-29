import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import { WorktreeManager } from './WorktreeManager.js';
import { TaskVerifier } from './TaskVerifier.js';
import { Task } from './types.js';

async function repo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-wt-'));
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execa('git', ['config', 'user.email', 't@t'], { cwd: dir });
  await execa('git', ['config', 'user.name', 't'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'seed.txt'), 'seed');
  await execa('git', ['add', '-A'], { cwd: dir });
  await execa('git', ['commit', '-qm', 'seed'], { cwd: dir });
  return dir;
}

describe('a retry continues from the previous attempt', () => {
  it('keeps committed work when the branch is preserved and resumed', async () => {
    const dir = await repo();
    const wm = new WorktreeManager(dir);
    await wm.init();

    // Attempt 1: do work, commit it, then fail.
    const wt = await wm.create('T1', 'line/T1');
    await fs.writeFile(path.join(wt, 'progress.txt'), 'attempt-1 work');
    const first = await wm.commitWorktree('T1');
    assert.equal(first.committed, true);
    await wm.cleanup('T1', 'line/T1', /* keepBranch */ true);
    assert.equal(await wm.branchExists('line/T1'), true, 'a retryable task must keep its branch');

    // Attempt 2 resumes: the earlier work is still there.
    const wt2 = await wm.create('T1', 'line/T1', /* resume */ true);
    assert.equal(await fs.readFile(path.join(wt2, 'progress.txt'), 'utf-8'), 'attempt-1 work',
      'attempt 2 must build on attempt 1, not start from HEAD');
  });

  it('discards the branch when the task has exhausted its retries', async () => {
    const dir = await repo();
    const wm = new WorktreeManager(dir);
    await wm.init();
    const wt = await wm.create('T2', 'line/T2');
    await fs.writeFile(path.join(wt, 'x.txt'), 'x');
    await wm.commitWorktree('T2');
    await wm.cleanup('T2', 'line/T2', /* keepBranch */ false);
    assert.equal(await wm.branchExists('line/T2'), false);
  });

  it('a fresh task starts from HEAD even if a stale branch lingers', async () => {
    const dir = await repo();
    const wm = new WorktreeManager(dir);
    await wm.init();
    const wt = await wm.create('T3', 'line/T3');
    await fs.writeFile(path.join(wt, 'stale.txt'), 'stale');
    await wm.commitWorktree('T3');
    await wm.cleanup('T3', 'line/T3', true);

    const fresh = await wm.create('T3', 'line/T3', /* resume */ false);
    await assert.rejects(() => fs.readFile(path.join(fresh, 'stale.txt'), 'utf-8'),
      'attempt 1 of a task must not inherit a previous run\'s branch');
  });
});

describe('verification scope matches task scope', () => {
  const v: any = new TaskVerifier();

  it('tolerates pre-existing assertion failures for a task with no test neighbourhood', () => {
    // godo today: 21 failed | 21 passed. T1 owns six config files and none of
    // the failing component tests.
    assert.equal(v.isPreExistingAssertionFailure(
      ' Test Files  21 failed | 21 passed (42)\n Tests  14 failed | 371 passed (385)'), true);
  });

  it('still fails when the task itself broke collection or compilation', () => {
    for (const out of [
      " MISSING DEPENDENCY  Cannot find dependency 'happy-dom'",
      ' Failed to load /src/foo.ts\n Test Files  1 failed',
      "error TS2345: Argument of type 'x'",
      ' Test Files  42 failed (42)',            // nothing passed: total collapse
    ]) {
      assert.equal(v.isPreExistingAssertionFailure(out), false, `must fail on: ${out.slice(0, 40)}`);
    }
  });

  it('picks up only directories the task touched that actually contain tests', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-scope-'));
    await fs.mkdir(path.join(dir, 'src', 'widgets'), { recursive: true });
    await fs.mkdir(path.join(dir, 'src', 'test'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'widgets', 'Chip.tsx'), 'x');
    await fs.writeFile(path.join(dir, 'src', 'widgets', 'Chip.test.tsx'), 'x');
    await fs.writeFile(path.join(dir, 'src', 'test', 'setup.ts'), 'x');   // no tests here

    const withTests = { files_hint: ['frontend/src/widgets/Chip.tsx'], creates_files: [] } as unknown as Task;
    assert.deepEqual(await v.testDirectoriesForTask(dir, withTests), ['src/widgets']);

    const configOnly = { files_hint: ['frontend/src/test/setup.ts'], creates_files: [] } as unknown as Task;
    assert.deepEqual(await v.testDirectoriesForTask(dir, configOnly), [],
      'a config-only task has no test neighbourhood to verify against');
  });
});
