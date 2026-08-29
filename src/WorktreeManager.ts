import { execa } from 'execa';
import path from 'node:path';
import fs from 'node:fs/promises';

export class WorktreeManager {
  private baseDir: string;
  private worktreeBase: string;
  private hydratedFiles = new Map<string, Map<string, Buffer>>();

  constructor(baseDir: string = process.cwd()) {
    this.baseDir = baseDir;
    this.worktreeBase = path.join(baseDir, '.git', 'softfactory-worktrees');
  }

  async init() {
    await fs.mkdir(this.worktreeBase, { recursive: true });
    await this.seedGitignore(this.baseDir);
    await execa('git', ['worktree', 'prune'], { cwd: this.baseDir, reject: false });
  }

  async getDefaultBranch(): Promise<string> {
    try {
      const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.baseDir });
      const branch = stdout.trim();
      if (branch && branch !== 'HEAD') return branch;
    } catch {}

    try {
      const { stdout } = await execa('git', ['branch', '--list', 'main'], { cwd: this.baseDir });
      if (stdout.trim()) return 'main';
    } catch {}

    return 'master';
  }

  /** True when a branch exists, i.e. a previous attempt left committed work. */
  async branchExists(branchName: string): Promise<boolean> {
    const { exitCode } = await execa('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
      { cwd: this.baseDir, reject: false });
    return exitCode === 0;
  }

  /**
   * `resume` keeps a previous attempt's commits so a retry builds on them.
   * Discarding them made every retry start from zero with only a 4,000-char
   * feedback string, so a task needing more than one attempt's work could
   * never converge.
   */
  async create(taskId: string, branchName: string, resume = false): Promise<string> {
    const worktreePath = path.join(this.worktreeBase, taskId);
    const reuse = resume && await this.branchExists(branchName);

    // Ensure no existing worktree conflict
    await execa('git', ['worktree', 'remove', '-f', worktreePath], { cwd: this.baseDir, reject: false });
    await execa('git', ['worktree', 'prune'], { cwd: this.baseDir, reject: false });
    if (!reuse) {
      await execa('git', ['branch', '-D', branchName], { cwd: this.baseDir, reject: false });
    }

    if (reuse) {
      await execa('git', ['worktree', 'add', worktreePath, branchName], { cwd: this.baseDir });
    } else {
      try {
        await execa('git', ['worktree', 'add', '-b', branchName, worktreePath], { cwd: this.baseDir });
      } catch {
        await execa('git', ['worktree', 'add', worktreePath, branchName], { cwd: this.baseDir });
      }
    }

    // Hydrate untracked configs, env files, and templates
    await this.hydrate(worktreePath, taskId);

    return worktreePath;
  }

  async hydrate(worktreePath: string, taskId?: string): Promise<void> {
    const CANDIDATE_FILES = [
      '.env',
      '.env.local',
      '.env.test',
      '.env.development',
      'config.yaml',
      'config.json',
      '.air.toml',
      'settings.json',
      'docker-compose.yml',
      'compose.yml',
      'backend/.env',
      'backend/.env.test',
      'backend/.env.local',
      'backend/config.yaml',
      'backend/.air.toml',
      'frontend/.env',
      'frontend/.env.local',
      'frontend/.env.test',
      'frontend/.env.development',
    ];

    for (const relFile of CANDIDATE_FILES) {
      const srcPath = path.join(this.baseDir, relFile);
      const destPath = path.join(worktreePath, relFile);

      try {
        await fs.access(srcPath);
        // Source exists; ensure dest dir exists and copy if not already identical
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.copyFile(srcPath, destPath);
        await this.recordHydratedFile(taskId, relFile, destPath);
      } catch {
        // Source file does not exist
      }
    }

    // If config.yaml is missing, check if config.yaml.example exists and copy as fallback
    const EXAMPLE_FALLBACKS = [
      { example: 'config.yaml.example', target: 'config.yaml' },
      { example: 'backend/config.yaml.example', target: 'backend/config.yaml' },
      { example: '.env.example', target: '.env' },
      { example: 'backend/.env.example', target: 'backend/.env' },
      { example: 'frontend/.env.example', target: 'frontend/.env' },
    ];

    for (const { example, target } of EXAMPLE_FALLBACKS) {
      const targetDest = path.join(worktreePath, target);
      try {
        await fs.access(targetDest);
      } catch {
        // Target does not exist in worktree; check if example exists in baseDir
        const exampleSrc = path.join(this.baseDir, example);
        try {
          await fs.access(exampleSrc);
          await fs.mkdir(path.dirname(targetDest), { recursive: true });
          await fs.copyFile(exampleSrc, targetDest);
          await this.recordHydratedFile(taskId, target, targetDest);
        } catch {}
      }
    }
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
    await this.unstageUnchangedHydratedFiles(taskId, worktreePath);

    const { stdout: status } = await execa('git', ['status', '--porcelain'], { cwd: worktreePath });
    if (status.trim()) {
      const filesChanged = status.trim().split('\n').length;
      await execa('git', ['commit', '-m', `softfactory: complete task ${taskId}`], { cwd: worktreePath });
      return { committed: true, filesChanged };
    }

    // Worker may have committed its own changes (common with --dangerously-skip-permissions).
    // Check if the worktree branch has commits ahead of the base.
    const defaultBranch = await this.getDefaultBranch();
    const { stdout: aheadCount } = await execa(
      'git', ['rev-list', '--count', `${defaultBranch}..HEAD`],
      { cwd: worktreePath }
    );
    if (parseInt(aheadCount.trim(), 10) > 0) {
      const { stdout: diffStat } = await execa(
        'git', ['diff', '--stat', `${defaultBranch}..HEAD`],
        { cwd: worktreePath }
      );
      const filesChanged = diffStat.trim().split('\n').filter(l => l.includes('|')).length || 1;
      return { committed: true, filesChanged };
    }

    return { committed: false, filesChanged: 0 };
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

  async merge(taskId: string, branchName: string, targetBranch?: string): Promise<string> {
    const defaultBranch = await this.getDefaultBranch();
    const branch = (targetBranch && targetBranch !== 'master') ? targetBranch : defaultBranch;
    // Abort any in-progress merge first
    await execa('git', ['merge', '--abort'], { cwd: this.baseDir, reject: false });

    // Ensure we're on the target branch and merge
    // Never reset or clean the primary checkout here: it may contain user work
    // unrelated to the factory task.
    await execa('git', ['checkout', branch], { cwd: this.baseDir });
    const { stdout, stderr } = await execa('git', ['merge', branchName, '--no-ff', '-m', `softfactory: merge ${taskId}`], { cwd: this.baseDir });
    return stdout || stderr;
  }

  /** `keepBranch` preserves a failed attempt's commits for the next retry. */
  async cleanup(taskId: string, branchName: string, keepBranch = false) {
    const worktreePath = path.join(this.worktreeBase, taskId);

    try {
      await execa('git', ['worktree', 'remove', '-f', worktreePath], { cwd: this.baseDir });
      await execa('git', ['worktree', 'prune'], { cwd: this.baseDir });
      if (!keepBranch) {
        await execa('git', ['branch', '-D', branchName], { cwd: this.baseDir });
      }
    } catch (e) {
      // Cleanup is best-effort
    }
    this.hydratedFiles.delete(taskId);
  }

  private async recordHydratedFile(taskId: string | undefined, relativePath: string, filePath: string): Promise<void> {
    if (!taskId) return;
    const files = this.hydratedFiles.get(taskId) || new Map<string, Buffer>();
    files.set(relativePath, await fs.readFile(filePath));
    this.hydratedFiles.set(taskId, files);
  }

  private async unstageUnchangedHydratedFiles(taskId: string, worktreePath: string): Promise<void> {
    const files = this.hydratedFiles.get(taskId);
    if (!files) return;
    for (const [relativePath, original] of files) {
      try {
        const current = await fs.readFile(path.join(worktreePath, relativePath));
        if (current.equals(original)) {
          await execa('git', ['reset', '--', relativePath], { cwd: worktreePath, reject: false });
        }
      } catch {}
    }
  }
}
