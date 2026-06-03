import { execa } from 'execa';
import path from 'node:path';
import fs from 'node:fs/promises';

export class WorktreeManager {
  private baseDir: string;
  private worktreeBase: string;

  constructor(baseDir: string = process.cwd()) {
    this.baseDir = baseDir;
    this.worktreeBase = path.join(baseDir, '.softfactory', 'worktrees');
  }

  async init() {
    await fs.mkdir(this.worktreeBase, { recursive: true });
  }

  async create(taskId: string, branchName: string): Promise<string> {
    const worktreePath = path.join(this.worktreeBase, taskId);
    
    // Ensure no existing worktree or branch conflict
    try {
      await execa('git', ['worktree', 'prune'], { cwd: this.baseDir });
      await execa('git', ['branch', '-D', branchName], { cwd: this.baseDir, reject: false });
    } catch (e) {
      // Ignore branch not found
    }

    await execa('git', ['worktree', 'add', '-b', branchName, worktreePath], { cwd: this.baseDir });
    
    return worktreePath;
  }

  async merge(taskId: string, branchName: string) {
    const worktreePath = path.join(this.worktreeBase, taskId);
    
    // 1. Stage and commit in the worktree
    await execa('git', ['add', '.'], { cwd: worktreePath });
    await execa('git', ['commit', '-m', `softfactory: complete task ${taskId}`], { cwd: worktreePath });

    // 2. Switch back to main (assuming main for now, could be dynamic)
    // We actually merge from the baseDir
    await execa('git', ['merge', branchName], { cwd: this.baseDir });
  }

  async cleanup(taskId: string, branchName: string) {
    const worktreePath = path.join(this.worktreeBase, taskId);
    
    try {
      await execa('git', ['worktree', 'remove', '-f', worktreePath], { cwd: this.baseDir });
      await execa('git', ['branch', '-D', branchName], { cwd: this.baseDir });
    } catch (e) {
      console.warn(`Cleanup failed for ${taskId}:`, e);
    }
  }
}
