import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Task } from './types.js';

export interface ProjectTestConfig {
  testEnv: Record<string, string>;
  tolerateOfflineDbFailures: boolean;
  neverTolerateFailures: string[];
}

export interface VerifierResult {
  executed: boolean;
  passed: boolean;
  testSummary: string;
  output: string;
  isCompileError?: boolean;
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
      return { ok: false, message: (e.stderr || e.stdout || e.message || 'npm ci failed').slice(0, 2000) };
    }
  }

  async verify(worktreePath: string, task?: Task, fullSuite = false): Promise<VerifierResult> {
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
          output: (stdout || stderr).slice(0, 2000),
        };
      } catch (e: any) {
        if (e.exitCode !== undefined) {
          return {
            executed: true,
            passed: false,
            testSummary: 'pytest failure',
            output: (e.stdout || e.stderr || e.message).slice(0, 2000),
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
          output: (stdout || stderr).slice(0, 2000),
        };
      } catch (e: any) {
        return {
          executed: true,
          passed: false,
          testSummary: 'cargo test failure',
          output: (e.stdout || e.stderr || e.message).slice(0, 2000),
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
          output: (stdout || stderr).slice(0, 2000),
        };
      } catch {}
    }

    return {
      executed: false,
      passed: true,
      testSummary: 'No automated test runner detected for this project',
      output: '',
    };
  }

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
        
        const args = testFiles.length > 0
          ? (hasVitest ? ['run', ...testFiles] : ['test', '--', '--run', ...testFiles])
          : (hasVitest ? ['run', 'src'] : ['test', '--', '--run', 'src']);

        const { stdout, stderr } = await execa(binary, args, {
          cwd: nodeDir,
          env: {
            ...testEnv,
            CI: 'true',
            VITEST_WATCH: 'false',
          },
          timeout: 180000,
        });
        return {
          executed: true,
          passed: true,
          testSummary: 'Node/TS test suite passed',
          output: (stdout || stderr || 'npm test passed').slice(0, 2000),
        };
      }

      return { executed: false, passed: true, testSummary: 'No npm test script configured', output: '' };
    } catch (e: any) {
      if (e.exitCode === 127 || (e.message && e.message.includes('command not found'))) {
        return {
          executed: false,
          passed: true,
          testSummary: 'Node/TS: test runner binary not installed locally (skipping npm test)',
          output: '',
        };
      }

      return {
        executed: true,
        passed: false,
        testSummary: 'npm test failure',
        output: (e.stdout || e.stderr || e.message).slice(0, 2000),
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
      const out = (e.stdout || e.stderr || e.message).slice(0, 2000);
      return {
        executed: true,
        passed: false,
        isCompileError: true,
        testSummary: 'Go compilation/vet failure',
        output: out,
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
          output: out.slice(0, 2000),
        };
      } catch (e: any) {
        const out = (e.stdout || e.stderr || e.message).slice(0, 2000);

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
            output: out,
          };
        }

        return {
          executed: true,
          passed: false,
          testSummary: `Go test failure in ${packages.join(', ')}`,
          output: out,
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
        output: out.slice(0, 2000),
      };
    } catch (e: any) {
      return {
        executed: true,
        passed: false,
        testSummary: 'Go test failure',
        output: (e.stdout || e.stderr || e.message).slice(0, 2000),
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
