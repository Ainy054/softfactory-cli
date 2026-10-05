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

  it('aborts a conflicting merge so the main checkout is not left mid-merge', async () => {
    const defaultBranch = await manager.getDefaultBranch();
    const w6 = await manager.create('T006', 'line/T006');
    await fs.writeFile(path.join(w6, 'README.md'), '# six');
    await manager.commitWorktree('T006');
    const w7 = await manager.create('T007', 'line/T007');
    await fs.writeFile(path.join(w7, 'README.md'), '# seven');
    await manager.commitWorktree('T007');

    await manager.merge('T006', 'line/T006', defaultBranch);
    await assert.rejects(() => manager.merge('T007', 'line/T007', defaultBranch));

    await assert.rejects(() => fs.access(path.join(tmpDir, '.git', 'MERGE_HEAD')), 'MERGE_HEAD must be gone');
    const readme = await fs.readFile(path.join(tmpDir, 'README.md'), 'utf-8');
    assert.equal(readme, '# six', 'no conflict markers may remain in the user checkout');
    const status = execSync('git status --porcelain', { cwd: tmpDir }).toString();
    assert.ok(!/^(UU|AA|DD) /m.test(status), `unmerged paths remain:\n${status}`);

    await manager.cleanup('T006', 'line/T006');
    await manager.cleanup('T007', 'line/T007');
  });

  it('never commits a hydrated .env, even when the worker edited it', async () => {
    await fs.writeFile(path.join(tmpDir, '.env'), 'APP_SECRET=12345\n');
    const w = await manager.create('T008', 'line/T008');
    await fs.writeFile(path.join(w, '.env'), 'APP_SECRET=leaked\n');
    await fs.writeFile(path.join(w, '.env.production'), 'TOKEN=new\n');
    await fs.writeFile(path.join(w, 'feature.txt'), 'real work');

    const result = await manager.commitWorktree('T008');
    assert.equal(result.committed, true);
    assert.equal(result.filesChanged, 1);
    const committed = execSync('git show --name-only --format= HEAD', { cwd: w }).toString().trim().split('\n');
    assert.deepEqual(committed, ['feature.txt']);
    await manager.cleanup('T008', 'line/T008');
  });

  it('reports no commit, without throwing, when only a secret file changed', async () => {
    await fs.writeFile(path.join(tmpDir, '.env'), 'APP_SECRET=12345\n');
    const w = await manager.create('T010', 'line/T010');
    await fs.writeFile(path.join(w, '.env'), 'APP_SECRET=leaked\n');
    const result = await manager.commitWorktree('T010');
    assert.equal(result.committed, false);
    await manager.cleanup('T010', 'line/T010');
  });

  it('deletes the branch even when the worktree directory is already gone', async () => {
    const w = await manager.create('T009', 'line/T009');
    await fs.rm(w, { recursive: true, force: true });
    await manager.cleanup('T009', 'line/T009');
    assert.equal(await manager.branchExists('line/T009'), false, 'the branch used to survive because one try block covered all three steps');
  });
});

describe('secret file detection', () => {
  it('matches env files and their variants but not examples', () => {
    for (const f of ['.env', '.env.local', 'backend/.env.production', 'frontend/.env.test']) {
      assert.equal(WorktreeManager.isSecretFile(f), true, f);
    }
    for (const f of ['.env.example', 'config.yaml', 'src/env.ts', 'environment.md']) {
      assert.equal(WorktreeManager.isSecretFile(f), false, f);
    }
  });
});
