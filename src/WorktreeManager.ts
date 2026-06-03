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

  async getDefaultBranch(): Promise<string> {
    try {
      const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.baseDir });
      return stdout.trim() || 'master';
    } catch {
      return 'master';
    }
  }

  async create(taskId: string, branchName: string): Promise<string> {
    const worktreePath = path.join(this.worktreeBase, taskId);

    // Ensure no existing worktree or branch conflict
    await execa('git', ['worktree', 'prune'], { cwd: this.baseDir, reject: false });
    await execa('git', ['worktree', 'remove', '-f', worktreePath], { cwd: this.baseDir, reject: false });
    await execa('git', ['branch', '-D', branchName], { cwd: this.baseDir, reject: false });

    await execa('git', ['worktree', 'add', '-b', branchName, worktreePath], { cwd: this.baseDir });

    return worktreePath;
  }

  async merge(taskId: string, branchName: string, targetBranch: string) {
    const worktreePath = path.join(this.worktreeBase, taskId);

    // Stage and commit in the worktree
    await execa('git', ['add', '.'], { cwd: worktreePath });
    try {
      await execa('git', ['commit', '-m', `softfactory: complete task ${taskId}`], { cwd: worktreePath });
    } catch {
      // No changes to commit — that's okay
    }

    // Ensure we're on the target branch and merge
    await execa('git', ['checkout', targetBranch], { cwd: this.baseDir, reject: false });
    await execa('git', ['merge', branchName, '--no-ff', '-m', `softfactory: merge ${taskId}`], { cwd: this.baseDir });
  }

  async cleanup(taskId: string, branchName: string) {
    const worktreePath = path.join(this.worktreeBase, taskId);

    try {
      await execa('git', ['worktree', 'remove', '-f', worktreePath], { cwd: this.baseDir });
      await execa('git', ['branch', '-D', branchName], { cwd: this.baseDir });
    } catch (e) {
      // Cleanup is best-effort
    }
  }
}
