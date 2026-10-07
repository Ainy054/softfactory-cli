import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execa } from 'execa';
import { LocalAgentWorker } from './ToolLoopWorker.js';
import { Factory } from './Factory.js';

// The exact file T01 merged: four stray closing brackets after the array.
const BROKEN_TS = `import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    coverage: {
      exclude: [
        'node_modules/',
        'frontend/e2e/**',
      ],
      ],
      ],
    },
  },
});
`;
const GOOD_TS = BROKEN_TS.replace(/^\s+\],\n\s+\],\n/m, '');

/** A worktree with the project's own esbuild, as a real target repo has. */
async function worktreeWithEsbuild(binary?: string) {
  let real: string;
  try {
    const require = createRequire(import.meta.url);
    // Resolve from this test module, including dependencies shared by git worktrees.
    real = binary ?? path.join(path.dirname(require.resolve('esbuild/package.json')), 'bin', 'esbuild');
    await fs.access(real);
    await execa(real, ['--version'], { timeout: 2_000 });
  } catch { return null; }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-ts-'));
  await fs.mkdir(path.join(dir, 'frontend', 'node_modules', '.bin'), { recursive: true });
  await fs.symlink(real, path.join(dir, 'frontend', 'node_modules', '.bin', 'esbuild'));
  return dir;
}

describe('the esbuild fixture requires a runnable dependency', () => {
  it('skips missing, dangling, and non-runnable binaries before creating a fixture', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-esbuild-probe-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const missing = path.join(dir, 'missing');
    const dangling = path.join(dir, 'dangling');
    const nonRunnable = path.join(dir, 'non-runnable');
    const failedVersion = path.join(dir, 'failed-version');
    const hungVersion = path.join(dir, 'hung-version');
    await fs.symlink(missing, dangling);
    await fs.writeFile(nonRunnable, 'not an executable', { mode: 0o600 });
    await fs.writeFile(failedVersion, '#!/usr/bin/env node\nprocess.exit(1);\n', { mode: 0o755 });
    await fs.writeFile(hungVersion, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o755 });
    const mkdir = t.mock.method(fs, 'mkdir', () => {
      assert.fail('unavailable binaries must be skipped before fixture creation');
    });
    for (const binary of [missing, dangling, nonRunnable, failedVersion, hungVersion]) {
      assert.equal(await worktreeWithEsbuild(binary), null, binary);
    }
    assert.equal(mkdir.mock.callCount(), 0);
  });

  it('propagates fixture-creation errors after a successful binary probe', async (t) => {
    const failure = new Error('fixture creation failed');
    const mkdtemp = t.mock.method(fs, 'mkdtemp', async () => { throw failure; });
    // Node provides a portable executable that also supports --version.
    await assert.rejects(worktreeWithEsbuild(process.execPath), (error) => error === failure);
    assert.equal(mkdtemp.mock.callCount(), 1);
  });
});

describe('a script edit that breaks parsing is rejected', () => {
  const w: any = new LocalAgentWorker();

  it('catches the vitest.config.ts that merged and killed the suite', async (t) => {
    const dir = await worktreeWithEsbuild();
    if (!dir) return t.skip('no esbuild available to borrow');
    const file = path.join(dir, 'frontend', 'vitest.config.ts');
    await fs.writeFile(file, GOOD_TS);
    const changed = new Set<string>();
    const result = await w.writeChecked(file, 'frontend/vitest.config.ts', BROKEN_TS, GOOD_TS, changed, 'ok', dir);

    assert.match(result, /edit rejected and reverted/);
    assert.match(result, /no longer parses/);
    assert.equal(await fs.readFile(file, 'utf-8'), GOOD_TS, 'the working config must be restored');
    assert.equal(changed.size, 0);
  });

  it('accepts a valid TypeScript edit', async (t) => {
    const dir = await worktreeWithEsbuild();
    if (!dir) return t.skip('no esbuild available to borrow');
    const file = path.join(dir, 'frontend', 'vitest.config.ts');
    await fs.writeFile(file, GOOD_TS);
    const changed = new Set<string>();
    const next = GOOD_TS.replace("'node_modules/',", "'node_modules/', 'dist/',");
    assert.equal(await w.writeChecked(file, 'frontend/vitest.config.ts', next, GOOD_TS, changed, 'ok', dir), 'ok');
    assert.deepEqual([...changed], ['frontend/vitest.config.ts']);
  });

  it('allows the edit when the project has no parser to judge with', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-nots-'));
    const file = path.join(dir, 'x.ts');
    const changed = new Set<string>();
    assert.equal(await w.writeChecked(file, 'x.ts', 'this is ( not valid', null, changed, 'ok', dir), 'ok');
  });

  it('still rejects an empty file of any type', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-empty-'));
    const file = path.join(dir, 'x.ts');
    await fs.writeFile(file, 'const a = 1;');
    const changed = new Set<string>();
    assert.match(await w.writeChecked(file, 'x.ts', '  ', 'const a = 1;', changed, 'ok', dir), /the file is empty/);
  });
});

describe('a suite that cannot start is never treated as pre-existing', () => {
  const f: any = new Factory('/tmp', '', { strategy: 'local' });

  it('fails the build on a config that will not load, even beside passing output', () => {
    // The discriminating case: passes are present, so the "pre-existing"
    // heuristic would tolerate it were the load failure not detected first.
    for (const output of [
      ' Test Files  20 passed (26)\nError: Transform failed with 1 error:\nvitest.config.ts:9:6: ERROR: Unexpected "]"',
      ' Tests  371 passed\nfailed to load config from vitest.config.ts\n at esbuild/lib/main.js:970',
      'ok  github.com/x/y  0.4s\nERR_MODULE_NOT_FOUND',
      ' Test Files  20 passed\nSyntaxError: Unexpected token',
    ]) {
      assert.equal(f.wasAlreadyFailing({ testSummary: 'npm test failure', output }), false, output.slice(0, 40));
    }
  });

  it('still tolerates a database that is not running', () => {
    assert.equal(f.wasAlreadyFailing({
      testSummary: 'Go test failure',
      output: 'ok github.com/x/y 0.4s\n--- FAIL: T\n dial tcp 127.0.0.1:5433: connect: connection refused',
    }), true);
  });
});
