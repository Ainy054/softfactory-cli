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

  it('should hydrate untracked config and env files into the worktree', async () => {
    // Create an untracked config.yaml in the root repo
    await fs.writeFile(path.join(tmpDir, 'config.yaml'), 'database:\n  host: localhost\n');
    await fs.writeFile(path.join(tmpDir, '.env'), 'APP_SECRET=12345\n');

    const worktreePath = await manager.create('T004', 'line/T004');

    // Check that config.yaml and .env were copied to the worktree
    const configContent = await fs.readFile(path.join(worktreePath, 'config.yaml'), 'utf-8');
    assert.equal(configContent, 'database:\n  host: localhost\n');

    const envContent = await fs.readFile(path.join(worktreePath, '.env'), 'utf-8');
    assert.equal(envContent, 'APP_SECRET=12345\n');

    await manager.cleanup('T004', 'line/T004');
  });

  it('should preserve unrelated untracked files when merging', async () => {
    const scratchPath = path.join(tmpDir, 'local-notes.txt');
    await fs.writeFile(scratchPath, 'keep me');
    const defaultBranch = await manager.getDefaultBranch();
    const worktreePath = await manager.create('T005', 'line/T005');
    await fs.writeFile(path.join(worktreePath, 'merged-file.txt'), 'merged');
    await manager.commitWorktree('T005');
    await manager.merge('T005', 'line/T005', defaultBranch);

    assert.equal(await fs.readFile(scratchPath, 'utf-8'), 'keep me');
    await manager.cleanup('T005', 'line/T005');
  });
});
