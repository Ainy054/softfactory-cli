import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Task } from './types.js';
import { commandPolicyViolation, runSafeCommand } from './commandPolicy.js';
import { SandboxManager, type ExecOptions, type ExecResult } from './Sandbox.js';

export interface AcceptanceResult {
  /** False when the task declares no command; nothing was checked. */
  ran: boolean;
  passed: boolean;
  exitCode: number | null;
  output: string;
  command: string;
  cwd?: string;
  evidencePath?: string;
  /** The command cannot run here at all: refused by policy, or not installed. */
  unrunnable: boolean;
}

export interface ProjectTestConfig {
  testEnv: Record<string, string>;
  tolerateOfflineDbFailures: boolean;
  neverTolerateFailures: string[];
}

export interface SuiteCounts {
  filesFailed: number;
  filesPassed: number;
  testsFailed: number;
  testsPassed: number;
}

export interface VerifierResult {
  executed: boolean;
  passed: boolean;
  testSummary: string;
  output: string;
  isCompileError?: boolean;
  counts?: SuiteCounts;
  scope?: 'node' | 'go' | 'python' | 'rust' | 'make';
  /** Whether the command covered the complete ecosystem suite or a task subset. */
  fullSuite?: boolean;
}

export class TaskVerifier {
  /** Test runs and acceptance commands execute through the sandbox; dependency installs stay on the host (they need the network). */
  constructor(private readonly sandbox: SandboxManager = new SandboxManager('none')) {}

  private async run(rootPath: string, file: string, args: string[], options: ExecOptions): Promise<ExecResult> {
    const runner = await this.sandbox.runnerFor(rootPath, file);
    return runner.exec(file, args, options);
  }

  async prepare(worktreePath: string, task?: Task): Promise<{ ok: boolean; message?: string }> {
    const hints = task?.files_hint || [];
    const isFrontendHint = hints.some(f => f.startsWith('frontend/'));
    const nodeDir = (isFrontendHint && await this.exists(path.join(worktreePath, 'frontend', 'package.json')))
      ? path.join(worktreePath, 'frontend')
      : (await this.exists(path.join(worktreePath, 'package.json')))
        ? worktreePath
        : (await this.exists(path.join(worktreePath, 'frontend', 'package.json')))
          ? path.join(worktreePath, 'frontend') : null;
    if (!nodeDir || await this.exists(path.join(nodeDir, 'node_modules')) || await this.exists(path.join(worktreePath, 'node_modules'))) {
      return { ok: true };
    }
    if (!await this.exists(path.join(nodeDir, 'package-lock.json')) && !await this.exists(path.join(nodeDir, 'npm-shrinkwrap.json'))) {
      return { ok: false, message: 'Node dependencies are missing and no lockfile exists' };
    }
    try {
      await execa('npm', ['ci', '--ignore-scripts'], {
        cwd: nodeDir,
        env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
        timeout: 180000,
      });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, message: (e.stderr || e.stdout || e.message || 'npm ci failed') };
    }
  }

  /**
   * Runs every ecosystem the project actually has. verify() dispatches to a
   * single one, chosen from the task's files_hint — fine per task, wrong for a
   * whole-project gate: a frontend-only feature was marked failed by Go tests
   * that were never run against it and were already broken.
   */
  async verifyAll(projectPath: string): Promise<VerifierResult[]> {
    const results: VerifierResult[] = [];
    // Probe only the ecosystems that exist. Probing both unconditionally and
    // de-duplicating afterwards never worked — the key included the summary
    // text, which differs per probe — so a Node-only project ran its whole
    // suite twice at every final gate.
    const present = await this.ecosystemsPresent(projectPath);
    for (const probe of [
      { hint: 'frontend/x.tsx', key: 'node' as const },
      { hint: 'backend/x.go', key: 'go' as const },
    ]) {
      if (!present.has(probe.key)) continue;
      const result = await this.verify(projectPath, { files_hint: [probe.hint] } as Task, true);
      if (result.executed) results.push(result);
    }
    if (results.length === 0) results.push(await this.verify(projectPath, undefined, true));
    return results;
  }

  /** Which ecosystems the project contains, so the final gate runs each once. */
  async ecosystemsPresent(projectPath: string): Promise<Set<'node' | 'go'>> {
    const present = new Set<'node' | 'go'>();
    if (await this.exists(path.join(projectPath, 'package.json')) || await this.exists(path.join(projectPath, 'frontend', 'package.json'))) present.add('node');
    if (await this.exists(path.join(projectPath, 'go.mod')) || await this.exists(path.join(projectPath, 'backend', 'go.mod'))) present.add('go');
    return present;
  }

  async verify(worktreePath: string, task?: Task, fullSuite = false): Promise<VerifierResult> {
    // Caches live for one verification only. A retry reuses the same worktree
    // path, and a test file or config added since the last attempt must be seen.
    this.testFileCache.clear();
    this.configCache.clear();
    const result = await this.runVerification(worktreePath, task, fullSuite);
    const scope = this.scopeForTask(task);
    const enriched = result.executed && !result.counts
      ? { ...result, counts: this.parseCounts(result.output) }
      : result;
    return { ...enriched, ...(scope ? { scope } : {}), fullSuite };
  }

  private scopeForTask(task?: Task): VerifierResult['scope'] {
    const hints = task?.files_hint || [];
    if (hints.some(file => /(^|[\\/])frontend([\\/]|$)|\.(tsx?|jsx?)$/i.test(file))) return 'node';
    if (hints.some(file => /(^|[\\/])backend([\\/]|$)|\.go$/i.test(file))) return 'go';
    return undefined;
  }

  private async runVerification(worktreePath: string, task?: Task, fullSuite = false): Promise<VerifierResult> {
    const isGoProject = await this.exists(path.join(worktreePath, 'go.mod')) ||
      await this.exists(path.join(worktreePath, 'backend', 'go.mod'));
    const isNodeProject = await this.exists(path.join(worktreePath, 'package.json')) ||
      await this.exists(path.join(worktreePath, 'frontend', 'package.json'));
    const isPythonProject = (await this.exists(path.join(worktreePath, 'pytest.ini'))) ||
      (await this.exists(path.join(worktreePath, 'pyproject.toml'))) ||
      (await this.exists(path.join(worktreePath, 'requirements.txt')));
    const isRustProject = await this.exists(path.join(worktreePath, 'Cargo.toml'));
    const hasMakefile = await this.exists(path.join(worktreePath, 'Makefile')) || await this.exists(path.join(worktreePath, 'makefile'));

    const hints = task?.files_hint || [];
    const isFrontendOnly = hints.length > 0 && hints.every(f => f.startsWith('frontend/') || /\.(tsx?|jsx?|vue|svelte|css|html)$/.test(f));
    const isBackendOnly = hints.length > 0 && hints.every(f => f.startsWith('backend/') || /\.go$/.test(f));

    // Project-specific env and failure-tolerance live in .softfactory/config.json,
    // not in this file. Hardcoding one project's values here silently changed the
    // verdict for every other repository.
    const testEnv = { ...process.env, CI: 'true', ...(await this.projectConfig(worktreePath)).testEnv };

    // 1. Node / TS Verification (Prioritized when task is frontend-only)
    if (isNodeProject && (isFrontendOnly || (!isBackendOnly && !isGoProject))) {
      return this.verifyNode(worktreePath, task, testEnv, fullSuite);
    }

    // 2. Go Project Verification (Prioritized when task is backend-only or general Go)
    if (isGoProject && (isBackendOnly || !isFrontendOnly)) {
      return this.verifyGo(worktreePath, task, testEnv, fullSuite);
    }

    // 3. Fallback to Node / TS if Go not applicable
    if (isNodeProject) {
      return this.verifyNode(worktreePath, task, testEnv, fullSuite);
    }

    // 4. Python Project Verification
    if (isPythonProject) {
      const pythonTests = hints.filter(f => f.endsWith('.py') && (f.includes('test_') || f.includes('_test.')));
      const pytestArgs = pythonTests.length > 0 ? pythonTests : [];

      try {
        const { stdout, stderr } = await this.run(worktreePath, 'pytest', pytestArgs, {
          cwd: worktreePath,
          env: testEnv,
          timeout: 60000,
        });
        return {
          executed: true,
          passed: true,
          testSummary: 'pytest suite passed',
          output: this.clip(stdout || stderr),
        };
      } catch (e: any) {
        if (e.exitCode !== undefined) {
          return {
            executed: true,
            passed: false,
            testSummary: 'pytest failure',
            output: this.clip(e.stdout || e.stderr || e.message),
          };
        }
      }
    }

    // 5. Rust Project Verification
    if (isRustProject) {
      try {
        const { stdout, stderr } = await this.run(worktreePath, 'cargo', ['test'], {
          cwd: worktreePath,
          env: testEnv,
          timeout: 90000,
        });
        return {
          executed: true,
          passed: true,
          testSummary: 'cargo test passed',
          output: this.clip(stdout || stderr),
        };
      } catch (e: any) {
        return {
          executed: true,
          passed: false,
          testSummary: 'cargo test failure',
          output: this.clip(e.stdout || e.stderr || e.message),
        };
      }
    }

    // 6. Makefile Verification
    if (hasMakefile) {
      try {
        const { stdout, stderr } = await this.run(worktreePath, 'make', ['test'], {
          cwd: worktreePath,
          env: testEnv,
          timeout: 60000,
        });
        return {
          executed: true,
          passed: true,
          testSummary: 'make test passed',
          output: this.clip(stdout || stderr),
        };
      } catch (e: any) {
        // Only a missing `make`, or a Makefile without a test target, means
        // "no runner here". A failing target is a failing suite; swallowing it
        // fell through to "no runner detected" and passed the task.
        const out = String(e.stderr || e.stdout || e.message || '');
        const noRunner = e.exitCode === undefined || e.exitCode === 127 || /No rule to make target/i.test(out);
        if (!noRunner) {
          return {
            executed: true,
            passed: false,
            testSummary: 'make test failure',
            output: this.clip(e.stdout || e.stderr || e.message),
          };
        }
      }
    }

    if (await this.hasTestFiles(worktreePath)) {
      return {
        executed: false,
        passed: false,
        testSummary: 'The project contains test files but no runner could be detected. Nothing was verified.',
        output: '',
      };
    }
    return {
      executed: false,
      passed: true,
      testSummary: 'No automated test runner detected and no test files found',
      output: '',
    };
  }

  /** Cheap check for whether this project has tests at all, tracked or not. */
  private async hasTestFiles(rootDir: string): Promise<boolean> {
    const cached = this.testFileCache.get(rootDir);
    if (cached !== undefined) return cached;
    const pattern = /(\.|_)(test|spec)\.(tsx?|jsx?|py|go|rs)$|_test\.go$/i;
    const skip = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', 'target', '.next', 'coverage']);
    const walk = async (dir: string, depth: number): Promise<boolean> => {
      if (depth > 6) return false;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (skip.has(entry.name)) continue;
          if (await walk(path.join(dir, entry.name), depth + 1)) return true;
        } else if (pattern.test(entry.name)) {
          return true;
        }
      }
      return false;
    };
    const found = await walk(rootDir, 0);
    this.testFileCache.set(rootDir, found);
    return found;
  }

  private testFileCache = new Map<string, boolean>();

  private async verifyNode(worktreePath: string, task: Task | undefined, testEnv: NodeJS.ProcessEnv, fullSuite = false): Promise<VerifierResult> {
    const isFrontendHint = task?.files_hint.some(f => f.startsWith('frontend/'));
    const nodeDir = (isFrontendHint && await this.exists(path.join(worktreePath, 'frontend', 'package.json')))
      ? path.join(worktreePath, 'frontend')
      : (await this.exists(path.join(worktreePath, 'package.json')))
        ? worktreePath
        : (await this.exists(path.join(worktreePath, 'frontend', 'package.json')))
          ? path.join(worktreePath, 'frontend')
          : null;

    if (!nodeDir) {
      return { executed: false, passed: true, testSummary: 'No Node package found', output: '' };
    }

    try {
      const pkgContent = await fs.readFile(path.join(nodeDir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(pkgContent);

      const hasNodeModules = await this.exists(path.join(nodeDir, 'node_modules')) ||
        await this.exists(path.join(worktreePath, 'node_modules'));

      if (!hasNodeModules) {
        const prepared = await this.prepare(worktreePath, task);
        if (!prepared.ok) return { executed: false, passed: false, testSummary: 'Node/TS dependency installation failed; tests were not executed', output: prepared.message || '' };
      }

      if (pkg.scripts && pkg.scripts.test) {
        let testFiles = fullSuite ? [] : (task?.files_hint || [])
          .map(f => f.startsWith('frontend/') ? f.slice('frontend/'.length) : f)
          .filter(f => f.endsWith('.test.ts') || f.endsWith('.test.tsx') || f.endsWith('.spec.ts') || f.endsWith('.spec.tsx'));

        // If no test files were explicitly hinted, check if corresponding test files exist on disk for the hinted implementation files
        if (!fullSuite && testFiles.length === 0 && task?.files_hint) {
          for (const hint of task.files_hint) {
            const rel = hint.startsWith('frontend/') ? hint.slice('frontend/'.length) : hint;
            const ext = path.extname(rel);
            if (!ext) continue;
            const baseWithoutExt = rel.slice(0, -ext.length);
            const candidates = [
              `${baseWithoutExt}.test${ext}`,
              `${baseWithoutExt}.test.ts`,
              `${baseWithoutExt}.test.tsx`,
              `${baseWithoutExt}.spec${ext}`,
              `${baseWithoutExt}.spec.ts`,
              `${baseWithoutExt}.spec.tsx`,
            ];
            for (const candidate of candidates) {
              if (await this.exists(path.join(nodeDir, candidate))) {
                if (!testFiles.includes(candidate)) testFiles.push(candidate);
              }
            }
          }
        }

        const hasVitest = await this.exists(path.join(nodeDir, 'node_modules', '.bin', 'vitest'));

        // Falling back to the whole of src gates a task on failures it does not
        // own: godo's T1 touches six config files, yet was held to a green
        // CalendarView.test.tsx that T5-T8 are meant to fix.
        if (!fullSuite && testFiles.length === 0) {
          testFiles = await this.testDirectoriesForTask(nodeDir, task);
        }
        // A config-only task has no test neighbourhood at all. Run everything so
        // it cannot break collection or compilation unnoticed, but do not blame
        // it for assertion failures that pre-date it.
        const unscoped = !fullSuite && testFiles.length === 0;
        const scope = testFiles.length > 0 ? testFiles : ['src'];
        const { binary, args } = this.testRunnerArgs(String(pkg.scripts.test), hasVitest, scope);

        const runEnv = { ...testEnv, CI: 'true', VITEST_WATCH: 'false' };
        let stdout: string, stderr: string;
        try {
          ({ stdout, stderr } = await this.run(worktreePath, binary, args, { cwd: nodeDir, env: runEnv, timeout: 180000 }));
        } catch (runError: any) {
          const out = (runError.stdout || runError.stderr || runError.message || '') as string;
          if (unscoped && this.isPreExistingAssertionFailure(out)) {
            return {
              executed: true,
              passed: true,
              testSummary: 'Task touches no test directory; suite compiles and collects. Pre-existing assertion failures were not attributed to this task.',
              output: this.clip(out),
            };
          }
          throw runError;
        }
        return {
          executed: true,
          passed: true,
          testSummary: 'Node/TS test suite passed',
          output: this.clip(stdout || stderr || 'npm test passed'),
        };
      }

      // "No runner configured" is only benign when the project genuinely has no
      // tests. godo's T1 renamed `test` to `test:unit`, which made verification
      // vacuous, and the task that was supposed to fix the test setup passed by
      // deleting its entry point and merged.
      if (await this.hasTestFiles(nodeDir)) {
        return {
          executed: false,
          passed: false,
          testSummary: 'No "test" script in package.json, but the project contains test files. Verification cannot run.',
          output: 'Restore a "test" script that runs the unit suite.',
        };
      }
      return { executed: false, passed: true, testSummary: 'No npm test script configured and no test files found', output: '' };
    } catch (e: any) {
      if (e.exitCode === 127 || (e.message && e.message.includes('command not found'))) {
        return {
          executed: false,
          passed: false,
          testSummary: 'Node/TS: the test runner binary is not installed, so nothing was verified',
          output: (e.stderr || e.stdout || e.message || ''),
        };
      }

      return {
        executed: true,
        passed: false,
        testSummary: 'npm test failure',
        output: this.clip(e.stdout || e.stderr || e.message),
      };
    }
  }

  private async verifyGo(worktreePath: string, task: Task | undefined, testEnv: NodeJS.ProcessEnv, fullSuite = false): Promise<VerifierResult> {
    const goDir = (await this.exists(path.join(worktreePath, 'go.mod')))
      ? worktreePath
      : path.join(worktreePath, 'backend');

    const packages = fullSuite ? [] : this.resolveGoPackages(task?.files_hint || [], goDir, worktreePath);

    // A) Verify compilation first
    try {
      await this.run(worktreePath, 'go', ['vet', ...(packages.length > 0 ? packages : ['./...'])], {
        cwd: goDir,
        env: testEnv,
        timeout: 90000,
      });
    } catch (e: any) {
      const out = this.clip(e.stdout || e.stderr || e.message);
      return {
        executed: true,
        passed: false,
        isCompileError: true,
        testSummary: 'Go compilation/vet failure',
        output: this.clip(out),
      };
    }

    // B) Find targeted unit test names from files_hint if available
    const testPattern = await this.extractTestPatterns(worktreePath, goDir, task?.files_hint || []);

    // C) Targeted package tests if hints exist
    if (packages.length > 0) {
      const testArgs = ['test', '-v', '-short'];
      if (testPattern) {
        testArgs.push('-run', testPattern);
      }
      testArgs.push(...packages);

      try {
        const { stdout, stderr } = await this.run(worktreePath, 'go', testArgs, {
          cwd: goDir,
          env: testEnv,
          timeout: 180000,
        });
        const out = stdout || stderr || 'Go tests passed';
        return {
          executed: true,
          passed: true,
          testSummary: `Go unit tests passed (${packages.join(', ')})`,
          output: this.clip(out),
        };
      } catch (e: any) {
        const out = this.clip(e.stdout || e.stderr || e.message);

        // Check if failure is only due to missing offline database (port 5433 connection refused)
        // when our targeted tests passed or when running a pure unit task
        const isDbConnError = out.includes('connect: connection refused') && (out.includes(':5433') || out.includes(':5432'));
        const hasPassedSubtests = out.includes('--- PASS:');

        const config = await this.projectConfig(worktreePath);
        const toleratedOffline = config.tolerateOfflineDbFailures &&
          !config.neverTolerateFailures.some(name => out.includes(`--- FAIL: ${name}`));
        if (isDbConnError && hasPassedSubtests && toleratedOffline) {
          return {
            executed: true,
            passed: true,
            testSummary: `Go unit tests passed (ignoring offline DB integration failures in unrelated tests)`,
            output: this.clip(out),
          };
        }

        return {
          executed: true,
          passed: false,
          testSummary: `Go test failure in ${packages.join(', ')}`,
          output: this.clip(out),
        };
      }
    }

    // D) Full test suite fallback
    try {
      const { stdout, stderr } = await this.run(worktreePath, 'go', ['test', '-short', '-p', '1', './...'], {
        cwd: goDir,
        env: testEnv,
        timeout: 120000,
      });
      const out = stdout || stderr || 'go test passed';
      return {
        executed: true,
        passed: true,
        testSummary: 'Go unit & package tests passed',
        output: this.clip(out),
      };
    } catch (e: any) {
      return {
        executed: true,
        passed: false,
        testSummary: 'Go test failure',
        output: this.clip(e.stdout || e.stderr || e.message),
      };
    }
  }

  private async extractTestPatterns(worktreePath: string, goDir: string, filesHint: string[]): Promise<string | null> {
    const testFuncNames: string[] = [];

    for (const hint of filesHint) {
      if (!hint.endsWith('_test.go')) continue;
      const fullPath = path.isAbsolute(hint) ? hint : path.join(worktreePath, hint);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const matches = content.matchAll(/^func\s+(Test[A-Za-z0-9_]+)\s*\(/gm);
        for (const match of matches) {
          testFuncNames.push(match[1]);
        }
      } catch {}
    }

    if (testFuncNames.length > 0) {
      return `^(${testFuncNames.join('|')})$`;
    }
    return null;
  }

  private resolveGoPackages(filesHint: string[], goDir: string, worktreePath: string): string[] {
    const isBackendSubdir = goDir !== worktreePath && goDir.endsWith('backend');
    const packages = new Set<string>();

    for (const hint of filesHint) {
      if (!hint.endsWith('.go')) continue;
      let rel = hint;
      if (isBackendSubdir && rel.startsWith('backend/')) {
        rel = rel.slice('backend/'.length);
      }
      const dir = path.dirname(rel);
      if (dir && dir !== '.') {
        packages.add(`./${dir}/...`);
      }
    }

    return Array.from(packages);
  }

  /**
   * True when the suite compiled and collected — some files passed and nothing
   * failed to load — so the remaining failures are assertions that existed
   * before this task and are some other task's job.
   */
  private isPreExistingAssertionFailure(raw: string): boolean {
    // Coloured output never matched here while parseCounts stripped its
    // escape codes, so a real red-but-collecting suite always failed the task.
    const output = this.stripAnsi(raw);
    if (/Failed to load|Cannot find (?:module|package|dependency)|SyntaxError|Transform failed|esbuild|Unexpected token|ERR_MODULE_NOT_FOUND|error TS\d+/i.test(output)) {
      return false;
    }
    const files = this.tallyLine(output, /Test Files[^\n]*\(\d+\)/);
    return Boolean(files && files.passed > 0);
  }

  /**
   * Arguments for the project's own runner. `--run` belongs to vitest; jest
   * rejects it as an unknown option and `node --test` treats it as a file.
   */
  testRunnerArgs(testScript: string, hasVitestBinary: boolean, scope: string[]): { binary: string; args: string[] } {
    if (hasVitestBinary) return { binary: './node_modules/.bin/vitest', args: ['run', ...scope] };
    const usesVitest = /\bvitest\b/.test(testScript);
    return { binary: 'npm', args: ['test', '--', ...(usesVitest ? ['--run'] : []), ...scope] };
  }

  /**
   * Directories the task touched that contain tests. Empty means the task
   * touched nothing testable — configuration only — and the caller should not
   * invent a scope for it.
   */
  private async testDirectoriesForTask(nodeDir: string, task: Task | undefined): Promise<string[]> {
    const touched = [...(task?.files_hint || []), ...(task?.creates_files || [])];
    const dirs = new Set<string>();
    for (const file of touched) {
      const rel = file.startsWith('frontend/') ? file.slice('frontend/'.length) : file;
      const dir = path.dirname(rel);
      if (!dir || dir === '.') continue;
      if (!await this.exists(path.join(nodeDir, dir))) continue;
      const entries = await fs.readdir(path.join(nodeDir, dir)).catch(() => [] as string[]);
      if (entries.some(e => /\.(test|spec)\.(tsx?|jsx?)$/.test(e))) dirs.add(dir);
    }
    return [...dirs];
  }

  /**
   * Pass/fail tallies scraped from runner output. "Does it pass" is too coarse
   * a gate for a project that is already red: a task took the suite from
   * 21 failed / 22 passed to 68 failed / 33 passed and merged, because both
   * states are simply "failing".
   */
  /**
   * Keeps the head (where compile errors appear) and the tail (where every
   * runner prints its tally). Truncating to the first 2,000 characters meant
   * vitest's summary — at character 117,586 of 117,780 — was never visible, so
   * parseCounts always returned undefined and the regression gate was silently
   * inert while three broken merges went through it.
   */
  clip(output: string, limit = 4000): string {
    const text = String(output ?? '');
    if (text.length <= limit) return text;
    const head = Math.floor(limit * 0.4);
    return `${text.slice(0, head)}\n...[trimmed]...\n${text.slice(-(limit - head))}`;
  }

  /**
   * Executes a task's own acceptance command under the command policy and
   * writes the evidence log. The planner has always been required to emit
   * one; until now nothing ran it, so it was a claim rather than a gate.
   */
  async runAcceptance(
    worktreePath: string,
    task: Pick<Task, 'id' | 'verification_command' | 'attempts'>,
    options: { evidenceDir?: string; timeoutMs?: number; note?: string } = {},
  ): Promise<AcceptanceResult> {
    const command = (task.verification_command || '').trim();
    if (!command) return { ran: false, passed: true, exitCode: null, output: '', command: '', unrunnable: false };
    const cwd = await this.acceptanceCwd(worktreePath, command);
    const violation = commandPolicyViolation(command, { root: worktreePath, cwd });
    let exitCode: number | null = null;
    let output = '';
    let passed = false;
    let unrunnable = false;
    if (violation) {
      output = `Acceptance command refused by the command policy: ${violation}`;
      unrunnable = true;
    } else {
      try {
        const runner = await this.sandbox.runnerFor(worktreePath, command.split(/\s+/, 1)[0]);
        const result = await runSafeCommand(command, cwd, options.timeoutMs ?? 180000, { root: worktreePath, runner });
        exitCode = result.exitCode;
        output = `${result.stdout}\n${result.stderr}`.trim();
        passed = true;
      } catch (error: any) {
        exitCode = typeof error?.exitCode === 'number' ? error.exitCode : null;
        const timedOut = Boolean(error?.timedOut);
        output = `${error?.stdout || ''}\n${error?.stderr || ''}\n${exitCode === null ? (timedOut ? `timed out after ${options.timeoutMs ?? 180000}ms` : (error?.shortMessage || error?.message || '')) : ''}`.trim();
        // A missing binary or a spawn failure means the gate can never fire;
        // a slow suite that timed out is red, not absent.
        unrunnable = (exitCode === null && !timedOut) || exitCode === 127;
      }
    }
    let evidencePath: string | undefined;
    if (options.evidenceDir) {
      evidencePath = path.join(options.evidenceDir, `${task.id}-attempt${(task.attempts ?? 0) + 1}.log`);
      await fs.mkdir(options.evidenceDir, { recursive: true });
      await fs.writeFile(evidencePath, [
        '# softfactory acceptance evidence',
        `task: ${task.id}`,
        `command: ${command}`,
        `cwd: ${path.relative(worktreePath, cwd) || '.'}`,
        `exit_code: ${exitCode ?? 'n/a'}`,
        `timestamp: ${new Date().toISOString()}`,
        ...(options.note ? [`note: ${options.note}`] : []),
        '',
        this.clip(output, 20000),
        '',
        `RESULT: ${passed ? 'PASS' : 'FAIL'}`,
        '',
      ].join('\n'), 'utf8');
    }
    return { ran: true, passed, exitCode, output: this.clip(output), command, cwd, evidencePath, unrunnable };
  }

  /** A command that names its ecosystem runs from that ecosystem's root in a split repo. */
  private async acceptanceCwd(worktreePath: string, command: string): Promise<string> {
    const executable = command.trim().split(/\s+/, 1)[0];
    if (executable === 'go' && !await this.exists(path.join(worktreePath, 'go.mod')) && await this.exists(path.join(worktreePath, 'backend', 'go.mod'))) {
      return path.join(worktreePath, 'backend');
    }
    if (['npm', 'pnpm', 'yarn', 'node', 'vitest', 'tsc', 'eslint'].includes(executable)
        && !await this.exists(path.join(worktreePath, 'package.json'))
        && await this.exists(path.join(worktreePath, 'frontend', 'package.json'))) {
      return path.join(worktreePath, 'frontend');
    }
    return worktreePath;
  }

  private stripAnsi(raw: string): string {
    return String(raw ?? '').replace(/\u001b\[[0-9;]*m/g, '');
  }

  /**
   * Reads each tally word independently. One regex across the whole line lost
   * the passed count whenever a "skipped" or "todo" segment sat between
   * "passed" and the total, which the regression gate then read as a drop.
   */
  private tallyLine(output: string, label: RegExp): { failed: number; passed: number; skipped: number } | undefined {
    const match = output.match(label);
    if (!match) return undefined;
    const line = match[0];
    const num = (word: string) => Number((line.match(new RegExp(`(\\d+) ${word}`)) || [])[1] || 0);
    return { failed: num('failed'), passed: num('passed'), skipped: num('skipped') };
  }

  parseCounts(raw: string): SuiteCounts | undefined {
    // Vitest colours its summary, so the line reads
    // "\u001b[2m Test Files \u001b[22m \u001b[31m43 failed" and \s+ never
    // matches across the escape codes.
    const output = this.stripAnsi(raw);
    const files = this.tallyLine(output, /Test Files[^\n]*\(\d+\)/);
    const tests = this.tallyLine(output, /(?:^|\n)\s*Tests[^\n]*\(\d+\)/);
    if (files || tests) {
      return {
        filesFailed: files?.failed || 0, filesPassed: files?.passed || 0,
        testsFailed: tests?.failed || 0, testsPassed: tests?.passed || 0,
      };
    }
    const goFail = (output.match(/^--- FAIL:/gm) || []).length;
    const goPass = (output.match(/^--- PASS:/gm) || []).length + (output.match(/^ok\s+\S+/gm) || []).length;
    if (goFail || goPass) {
      return { filesFailed: 0, filesPassed: 0, testsFailed: goFail, testsPassed: goPass };
    }
    return undefined;
  }

  private configCache = new Map<string, ProjectTestConfig>();

  /** Reads optional .softfactory/config.json; absent or malformed means "no overrides". */
  private async projectConfig(worktreePath: string): Promise<ProjectTestConfig> {
    const cached = this.configCache.get(worktreePath);
    if (cached) return cached;
    const empty: ProjectTestConfig = { testEnv: {}, tolerateOfflineDbFailures: false, neverTolerateFailures: [] };
    let config = empty;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(worktreePath, '.softfactory', 'config.json'), 'utf-8'));
      config = {
        testEnv: (raw && typeof raw.testEnv === 'object' && raw.testEnv) || {},
        tolerateOfflineDbFailures: raw?.tolerateOfflineDbFailures === true,
        neverTolerateFailures: Array.isArray(raw?.neverTolerateFailures) ? raw.neverTolerateFailures.map(String) : [],
      };
    } catch { /* no config, or unreadable: use no overrides */ }
    this.configCache.set(worktreePath, config);
    return config;
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }
}
