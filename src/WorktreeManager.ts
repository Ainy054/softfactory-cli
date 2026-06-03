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

    // Seed .gitignore so workers don't commit build artifacts
    await this.seedGitignore(worktreePath);

    return worktreePath;
  }

  private async seedGitignore(worktreePath: string) {
    const REQUIRED_ENTRIES = [
      'node_modules/',
      '.softfactory/',
      'dist/',
      '.env',
      '.env.local',
    ];

    const gitignorePath = path.join(worktreePath, '.gitignore');
    let existing = '';
    try {
      existing = await fs.readFile(gitignorePath, 'utf-8');
    } catch {}

    const missing = REQUIRED_ENTRIES.filter(e => !existing.includes(e));
    if (missing.length > 0) {
      const suffix = (existing && !existing.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n';
      await fs.appendFile(gitignorePath, suffix);
    }
  }

  async commitWorktree(taskId: string): Promise<{ committed: boolean; filesChanged: number }> {
    const worktreePath = path.join(this.worktreeBase, taskId);

    await execa('git', ['add', '.'], { cwd: worktreePath });

    // Check if there's anything to commit
    const { stdout: status } = await execa('git', ['status', '--porcelain'], { cwd: worktreePath });
    if (!status.trim()) {
      return { committed: false, filesChanged: 0 };
    }

    const filesChanged = status.trim().split('\n').length;
    await execa('git', ['commit', '-m', `softfactory: complete task ${taskId}`], { cwd: worktreePath });
    return { committed: true, filesChanged };
  }

  async hasCommitsAhead(branchName: string, targetBranch: string): Promise<boolean> {
    try {
      const { stdout } = await execa(
        'git', ['rev-list', '--count', `${targetBranch}..${branchName}`],
        { cwd: this.baseDir }
      );
      return parseInt(stdout.trim(), 10) > 0;
    } catch {
      return false;
    }
  }

  async merge(taskId: string, branchName: string, targetBranch: string) {
    // Abort any in-progress merge first
    await execa('git', ['merge', '--abort'], { cwd: this.baseDir, reject: false });

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
