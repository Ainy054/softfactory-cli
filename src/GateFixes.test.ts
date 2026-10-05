import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskVerifier } from './TaskVerifier.js';

const E = String.fromCharCode(27);

async function scratch(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), `sf-${prefix}-`));
}

describe('a failing Makefile target fails the task', () => {
  it('reports make test failure instead of falling through to "no runner"', async () => {
    const dir = await scratch('make-fail');
    try {
      await fs.writeFile(path.join(dir, 'Makefile'), 'test:\n\t@echo "1 test failed" && exit 1\n');
      const result = await new TaskVerifier().verify(dir);
      assert.equal(result.executed, true);
      assert.equal(result.passed, false, 'a red make target used to pass as "no automated test runner detected"');
      assert.equal(result.testSummary, 'make test failure');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('still treats a Makefile without a test target as no runner', async () => {
    const dir = await scratch('make-none');
    try {
      await fs.writeFile(path.join(dir, 'Makefile'), 'build:\n\t@echo built\n');
      const result = await new TaskVerifier().verify(dir);
      assert.equal(result.executed, false);
      assert.equal(result.passed, true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('suite tallies survive skipped and todo segments', () => {
  const v = new TaskVerifier();

  it('keeps the passed count when a skipped segment follows it', () => {
    // Real vitest shape once a project has it.skip or it.todo. The single
    // regex read passed as 0 here, and the regression gate saw a false drop.
    const out = ' Test Files  1 failed | 40 passed | 3 skipped (44)\n      Tests  2 failed | 300 passed | 10 skipped (312)';
    assert.deepEqual(v.parseCounts(out), { filesFailed: 1, filesPassed: 40, testsFailed: 2, testsPassed: 300 });
  });

  it('still parses the plain shape', () => {
    assert.deepEqual(v.parseCounts(' Test Files  21 failed | 22 passed (43)\n      Tests  14 failed | 374 passed (388)'),
      { filesFailed: 21, filesPassed: 22, testsFailed: 14, testsPassed: 374 });
  });

  it('recognises a coloured, collecting suite as pre-existing failure', () => {
    const coloured = ` ${E}[2m Test Files ${E}[22m ${E}[31m2 failed${E}[39m ${E}[2m|${E}[22m ${E}[32m20 passed${E}[39m ${E}[90m(22)${E}[39m\n`;
    assert.equal((v as any).isPreExistingAssertionFailure(coloured), true,
      'escape codes between the words used to hide the passed count');
    assert.equal((v as any).isPreExistingAssertionFailure(`${coloured}\nSyntaxError: Unexpected token`), false);
  });
});

describe('the test runner is given only flags it understands', () => {
  const v = new TaskVerifier();

  it('passes --run to vitest only', () => {
    assert.deepEqual(v.testRunnerArgs('vitest', false, ['a.test.ts']).args, ['test', '--', '--run', 'a.test.ts']);
    assert.deepEqual(v.testRunnerArgs('jest', false, ['a.test.ts']).args, ['test', '--', 'a.test.ts']);
    assert.deepEqual(v.testRunnerArgs('node --test', false, ['src']).args, ['test', '--', 'src']);
  });

  it('prefers the local vitest binary when it is installed', () => {
    const { binary, args } = v.testRunnerArgs('vitest', true, ['src']);
    assert.match(binary, /vitest$/);
    assert.deepEqual(args, ['run', 'src']);
  });
});

describe('verifier caches do not outlive one verification', () => {
  it('sees a test file added since the previous attempt on the same path', async () => {
    const dir = await scratch('cache');
    try {
      const v = new TaskVerifier();
      const first = await v.verify(dir);
      assert.equal(first.passed, true, 'no tests and no runner is benign');
      await fs.writeFile(path.join(dir, 'x.test.ts'), 'it("x", () => {});');
      const second = await v.verify(dir);
      assert.equal(second.passed, false, 'the retry must notice the new test file, not reuse the cached "no tests" answer');
      assert.match(second.testSummary, /test files but no runner/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
