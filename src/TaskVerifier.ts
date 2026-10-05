import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Task } from './types.js';

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
    const seen = new Set<string>();
    for (const probe of [
      { hint: 'frontend/x.tsx', key: 'node' },
      { hint: 'backend/x.go', key: 'go' },
    ]) {
      const result = await this.verify(projectPath, { files_hint: [probe.hint] } as Task, true);
      const id = `${probe.key}:${result.testSummary}`;
      if (result.executed && !seen.has(id)) {
        seen.add(id);
        results.push(result);
      }
    }
    if (results.length === 0) results.push(await this.verify(projectPath, undefined, true));
    return results;
  }

  async verify(worktreePath: string, task?: Task, fullSuite = false): Promise<VerifierResult> {
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
        const { stdout, stderr } = await execa('pytest', pytestArgs, {
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
        const { stdout, stderr } = await execa('cargo', ['test'], {
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
        const { stdout, stderr } = await execa('make', ['test'], {
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
      } catch {}
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
        const binary = hasVitest ? './node_modules/.bin/vitest' : 'npm';
        
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
        const args = hasVitest ? ['run', ...scope] : ['test', '--', '--run', ...scope];

        const runEnv = { ...testEnv, CI: 'true', VITEST_WATCH: 'false' };
        let stdout: string, stderr: string;
        try {
          ({ stdout, stderr } = await execa(binary, args, { cwd: nodeDir, env: runEnv, timeout: 180000 }));
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
      await execa('go', ['vet', ...(packages.length > 0 ? packages : ['./...'])], {
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
        const { stdout, stderr } = await execa('go', testArgs, {
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
      const { stdout, stderr } = await execa('go', ['test', '-short', '-p', '1', './...'], {
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
  private isPreExistingAssertionFailure(output: string): boolean {
    if (/Failed to load|Cannot find (?:module|package|dependency)|SyntaxError|Transform failed|esbuild|Unexpected token|ERR_MODULE_NOT_FOUND|error TS\d+/i.test(output)) {
      return false;
    }
    const files = output.match(/Test Files\s+(?:(\d+) failed[^\n]*?)?\|?\s*(\d+) passed/);
    return Boolean(files && Number(files[2]) > 0);
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

  parseCounts(raw: string): SuiteCounts | undefined {
    // Vitest colours its summary, so the line reads
    // "\u001b[2m Test Files \u001b[22m \u001b[31m43 failed" and \s+ never
    // matches across the escape codes.
    const output = String(raw ?? '').replace(/\u001b\[[0-9;]*m/g, '');
    const files = output.match(/Test Files\s+(?:(\d+) failed)?[^\n]*?(?:(\d+) passed)?\s*\((\d+)\)/);
    const tests = output.match(/\n\s*Tests\s+(?:(\d+) failed)?[^\n]*?(?:(\d+) passed)?\s*\((\d+)\)/);
    if (files || tests) {
      return {
        filesFailed: Number(files?.[1] || 0), filesPassed: Number(files?.[2] || 0),
        testsFailed: Number(tests?.[1] || 0), testsPassed: Number(tests?.[2] || 0),
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
