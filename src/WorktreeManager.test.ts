import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { WorktreeManager } from './WorktreeManager.js';

let tmpDir: string;
let manager: WorktreeManager;

async function setupGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-test-'));
  execSync('git init', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), '# Test');
  execSync('git add . && git commit -m "init"', { cwd: dir });
  return dir;
}

describe('WorktreeManager', () => {
  before(async () => {
    tmpDir = await setupGitRepo();
    manager = new WorktreeManager(tmpDir);
    await manager.init();
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should detect default branch', async () => {
    const branch = await manager.getDefaultBranch();
    assert.ok(['master', 'main'].includes(branch), `Expected master or main, got ${branch}`);
  });

  it('should create a worktree', async () => {
    const worktreePath = await manager.create('T001', 'line/T001');
    const stat = await fs.stat(worktreePath);
    assert.ok(stat.isDirectory());

    // Verify the README exists in the worktree
    const readme = await fs.readFile(path.join(worktreePath, 'README.md'), 'utf-8');
    assert.equal(readme, '# Test');

    // Cleanup
    await manager.cleanup('T001', 'line/T001');
  });

  it('should commit and merge changes from worktree', async () => {
    const defaultBranch = await manager.getDefaultBranch();
    const worktreePath = await manager.create('T002', 'line/T002');

    // Make a change in the worktree
    await fs.writeFile(path.join(worktreePath, 'new-file.txt'), 'hello');

    // Commit in worktree first, then merge
    await manager.commitWorktree('T002');
    await manager.merge('T002', 'line/T002', defaultBranch);

    // Verify the file exists on the main branch
    const content = await fs.readFile(path.join(tmpDir, 'new-file.txt'), 'utf-8');
    assert.equal(content, 'hello');

    // Cleanup
    await manager.cleanup('T002', 'line/T002');
  });

  it('should handle cleanup gracefully for non-existent worktrees', async () => {
    // Should not throw
    await manager.cleanup('T999', 'line/T999');
  });

  it('should recreate a worktree if branch exists from previous run', async () => {
    const worktreePath1 = await manager.create('T003', 'line/T003');
    await manager.cleanup('T003', 'line/T003');

    // Create again with same IDs — should not throw
    const worktreePath2 = await manager.create('T003', 'line/T003');
    const stat = await fs.stat(worktreePath2);
    assert.ok(stat.isDirectory());

    await manager.cleanup('T003', 'line/T003');
  });
});
