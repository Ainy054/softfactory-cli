import { execa } from 'execa';
import path from 'node:path';
import fs from 'node:fs/promises';

export class WorktreeManager {
  protected baseDir: string;
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
    // An interrupted attempt can leave the directory behind once its
    // registration is pruned; `worktree add` then refuses the non-empty path
    // and the retry died with the fallback's misleading "invalid reference".
    // The directory is softfactory's own; committed work lives on the branch.
    await fs.rm(worktreePath, { recursive: true, force: true });
    if (!reuse) {
      await execa('git', ['branch', '-D', branchName], { cwd: this.baseDir, reject: false });
    }

    if (reuse) {
      await execa('git', ['worktree', 'add', worktreePath, branchName], { cwd: this.baseDir });
    } else {
      try {
        await execa('git', ['worktree', 'add', '-b', branchName, worktreePath], { cwd: this.baseDir });
      } catch (first: any) {
        try {
          await execa('git', ['worktree', 'add', worktreePath, branchName], { cwd: this.baseDir });
        } catch (second: any) {
          throw new Error(`git worktree add failed for ${taskId}: ${(first?.stderr || first?.message || first).toString().trim()}; then ${(second?.stderr || second?.message || second).toString().trim()}`);
        }
      }
    }

    // Hydrate untracked configs, env files, and templates
    await this.hydrate(worktreePath, taskId);

    return worktreePath;
  }

  async hydrate(worktreePath: string, taskId?: string): Promise<void> {
    // Real .env files are not on this list on purpose. They hold the user's
    // credentials, and copying them put every secret within reach of every
    // worker's commands and, when a worker edited one, into history. A
    // worker that needs environment shape gets the committed .env.example
    // via the fallbacks below; environment values are orchestrator work.
    const CANDIDATE_FILES = [
      'config.yaml',
      'config.json',
      '.air.toml',
      'settings.json',
      'docker-compose.yml',
      'compose.yml',
      'backend/config.yaml',
      'backend/.air.toml',
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

    // git's own per-repository exclude file, shared by every worktree. Writing
    // the tracked .gitignore instead left the user's checkout dirty on every
    // run, and the next preflight warned about softfactory's own edit.
    const { stdout: commonDir } = await execa('git', ['rev-parse', '--git-common-dir'], { cwd: worktreePath });
    const gitignorePath = path.join(path.resolve(worktreePath, commonDir.trim()), 'info', 'exclude');
    await fs.mkdir(path.dirname(gitignorePath), { recursive: true });
    let existing = '';
    try {
      existing = await fs.readFile(gitignorePath, 'utf-8');
    } catch {}
    try {
      existing += `\n${await fs.readFile(path.join(worktreePath, '.gitignore'), 'utf-8')}`;
    } catch {}

    const missing = REQUIRED_ENTRIES.filter(e => !existing.split('\n').some(line => line.trim() === e || line.trim() === e.replace(/\/$/, '')));
    if (missing.length > 0) {
      let current = '';
      try { current = await fs.readFile(gitignorePath, 'utf-8'); } catch {}
      const suffix = (current && !current.endsWith('\n') ? '\n' : '') + `# added by softfactory\n${missing.join('\n')}\n`;
      await fs.appendFile(gitignorePath, suffix);
    }
  }

  /** Files that carry credentials: hydrated for the worker's benefit, never committed. */
  static isSecretFile(relativePath: string): boolean {
    return /(^|[\\/])\.env(\.[A-Za-z0-9_.-]+)?$/.test(relativePath) && !/\.example$/i.test(relativePath);
  }

  /** Where a task's files are; the main checkout in shared-sequential mode. */
  protected worktreePathFor(taskId: string): string {
    return path.join(this.worktreeBase, taskId);
  }

  async commitWorktree(taskId: string): Promise<{ committed: boolean; filesChanged: number }> {
    const worktreePath = this.worktreePathFor(taskId);

    await execa('git', ['add', '.'], { cwd: worktreePath });
    await this.unstageHydratedAndSecretFiles(taskId, worktreePath);

    // Count what is staged, not what `status --porcelain` lists: an unstaged
    // hydrated file shows there as untracked, and committing "nothing added
    // but untracked files present" throws.
    const { stdout: staged } = await execa('git', ['diff', '--cached', '--name-only'], { cwd: worktreePath });
    const stagedFiles = staged.split('\n').filter(Boolean);
    if (stagedFiles.length > 0) {
      await execa('git', ['commit', '-m', `softfactory: complete task ${taskId}`], { cwd: worktreePath });
      return { committed: true, filesChanged: stagedFiles.length };
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

  async merge(taskId: string, branchName: string, targetBranch?: string): Promise<string> {
    const defaultBranch = await this.getDefaultBranch();
    const branch = (targetBranch && targetBranch !== 'master') ? targetBranch : defaultBranch;
    // Abort any in-progress merge first
    await execa('git', ['merge', '--abort'], { cwd: this.baseDir, reject: false });

    // Ensure we're on the target branch and merge
    // Never reset or clean the primary checkout here: it may contain user work
    // unrelated to the factory task.
    await execa('git', ['checkout', branch], { cwd: this.baseDir });
    try {
      const { stdout, stderr } = await execa('git', ['merge', branchName, '--no-ff', '-m', `softfactory: merge ${taskId}`], { cwd: this.baseDir });
      return stdout || stderr;
    } catch (error) {
      // A conflict must not leave the user's checkout mid-merge, with
      // MERGE_HEAD set and conflict markers in tracked files, until the next
      // task happens to call merge().
      await execa('git', ['merge', '--abort'], { cwd: this.baseDir, reject: false });
      throw error;
    }
  }

  /**
   * Why git refused a merge because of the user's checkout rather than the
   * branches: uncommitted edits (or untracked files) in paths the merge would
   * write. Null for a genuine conflict or any other failure.
   */
  static mergeBlockedByWorkingTree(gitOutput: string): string | null {
    const text = String(gitOutput || '');
    const local = text.match(/local changes to the following files would be overwritten by merge:\s*\n([\s\S]*?)(?:\n\s*(?:Please|Aborting)|$)/i);
    if (local) return `uncommitted changes in ${local[1].split('\n').map(l => l.trim()).filter(Boolean).join(', ')}`;
    const untracked = text.match(/untracked working tree files would be overwritten by merge:\s*\n([\s\S]*?)(?:\n\s*(?:Please|Aborting)|$)/i);
    if (untracked) return `untracked files in the way: ${untracked[1].split('\n').map(l => l.trim()).filter(Boolean).join(', ')}`;
    return null;
  }

  /** Tracked files with uncommitted changes in the primary checkout. */
  async uncommittedTrackedFiles(): Promise<string[]> {
    const { stdout } = await execa('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: this.baseDir, reject: false });
    return stdout.split('\n').filter(Boolean).map(line => line.slice(3).trim());
  }

  /** `keepBranch` preserves a failed attempt's commits for the next retry. */
  async cleanup(taskId: string, branchName: string, keepBranch = false) {
    const worktreePath = path.join(this.worktreeBase, taskId);

    // Each step is best-effort on its own. One try block around all three
    // meant a worktree that was already gone from disk skipped the branch
    // delete, and line/* branches accumulated.
    await execa('git', ['worktree', 'remove', '-f', worktreePath], { cwd: this.baseDir, reject: false });
    await execa('git', ['worktree', 'prune'], { cwd: this.baseDir, reject: false });
    if (!keepBranch) {
      await execa('git', ['branch', '-D', branchName], { cwd: this.baseDir, reject: false });
    }
    this.hydratedFiles.delete(taskId);
  }

  private async recordHydratedFile(taskId: string | undefined, relativePath: string, filePath: string): Promise<void> {
    if (!taskId) return;
    const files = this.hydratedFiles.get(taskId) || new Map<string, Buffer>();
    files.set(relativePath, await fs.readFile(filePath));
    this.hydratedFiles.set(taskId, files);
  }

  private async unstageHydratedAndSecretFiles(taskId: string, worktreePath: string): Promise<void> {
    const files = this.hydratedFiles.get(taskId) || new Map<string, Buffer>();
    for (const [relativePath, original] of files) {
      // A hydrated .env came from the user's untracked local copy. Changed or
      // not, it must never enter history: it was being committed, merged and
      // captured into training data whenever a worker touched it.
      if (WorktreeManager.isSecretFile(relativePath)) {
        await execa('git', ['reset', '--', relativePath], { cwd: worktreePath, reject: false });
        continue;
      }
      try {
        const current = await fs.readFile(path.join(worktreePath, relativePath));
        if (current.equals(original)) {
          await execa('git', ['reset', '--', relativePath], { cwd: worktreePath, reject: false });
        }
      } catch {}
    }
    // A credential file the worker created itself gets the same treatment.
    const { stdout } = await execa('git', ['diff', '--cached', '--name-only', '--diff-filter=A'], { cwd: worktreePath, reject: false });
    for (const added of stdout.split('\n').filter(f => f && WorktreeManager.isSecretFile(f))) {
      await execa('git', ['reset', '--', added], { cwd: worktreePath, reject: false });
    }
  }
}

/**
 * Shared-sequential isolation, borrowed from Softhouse, for repositories
 * where worktrees are impractical (a slow monorepo install). No worktrees:
 * one task at a time works in the main checkout, on its own line/<task>
 * branch, and merges as usual, so every gate and every diff is unchanged.
 * The checkout must be clean. The worker can see .softfactory/ here, so the
 * gate files are snapshotted before each task and restored if touched.
 */
export class SharedCheckoutManager extends WorktreeManager {
  static readonly GATE_FILES = ['uat.json', 'environment.json', 'protected-paths.txt', 'non-negotiables.txt', 'config.json', 'worker-context.md'];
  private target: string | undefined;
  private snapshot = new Map<string, string | null>();

  async getDefaultBranch(): Promise<string> {
    return this.target ?? super.getDefaultBranch();
  }

  protected worktreePathFor(): string {
    return this.baseDir;
  }

  async create(taskId: string, branchName: string, resume = false): Promise<string> {
    const dirty = await this.uncommittedTrackedFiles();
    if (dirty.length) throw new Error(`shared isolation needs a clean checkout; commit or stash: ${dirty.slice(0, 5).join(', ')}`);
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.baseDir });
    if (!stdout.trim().startsWith('line/')) this.target = stdout.trim();
    if (resume && await this.branchExists(branchName)) await execa('git', ['checkout', '-q', branchName], { cwd: this.baseDir });
    else await execa('git', ['checkout', '-q', '-B', branchName, this.target!], { cwd: this.baseDir });
    this.snapshot.clear();
    for (const name of SharedCheckoutManager.GATE_FILES) {
      this.snapshot.set(name, await fs.readFile(path.join(this.baseDir, '.softfactory', name), 'utf8').catch(() => null));
    }
    return this.baseDir;
  }

  /** Gate files the task changed, each restored to its snapshot. */
  async tamperedGateFiles(): Promise<string[]> {
    const changed: string[] = [];
    for (const [name, before] of this.snapshot) {
      const file = path.join(this.baseDir, '.softfactory', name);
      const now = await fs.readFile(file, 'utf8').catch(() => null);
      if (now === before) continue;
      changed.push(`.softfactory/${name}`);
      if (before === null) await fs.rm(file, { force: true });
      else await fs.writeFile(file, before);
    }
    return changed;
  }

  async cleanup(_taskId: string, branchName: string, keepBranch = false) {
    if (this.target) await execa('git', ['checkout', '-q', this.target], { cwd: this.baseDir, reject: false });
    if (!keepBranch) await execa('git', ['branch', '-D', branchName], { cwd: this.baseDir, reject: false });
  }
}
