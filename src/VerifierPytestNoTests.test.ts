import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { TaskVerifier } from './TaskVerifier.js';

// The mongolbank-fastapi demo (2026-10-15): T1 only creates requirements.txt
// and .gitignore, which makes the verifier treat the repo as Python, and pytest
// in a project with no tests yet exits 5 ("no tests ran"). Counting that as a
// failure gave T1 a task no attempt could pass.

const NO_TESTS = '============================= test session starts ==============================\ncollected 0 items\n\n============================ no tests ran in 0.01s =============================';

async function pythonRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-pytest-'));
  await fs.writeFile(path.join(dir, 'requirements.txt'), 'fastapi\npytest\n');
  return dir;
}

function verifierWithPytest(exitCode: number, stdout: string, seen: string[][] = []): TaskVerifier {
  const v = new TaskVerifier();
  (v as any).run = async (_root: string, file: string, args: string[]) => {
    seen.push([file, ...args]);
    if (exitCode === 0) return { stdout, stderr: '' };
    throw Object.assign(new Error(`pytest exited ${exitCode}`), { exitCode, stdout, stderr: '' });
  };
  return v;
}

const setupTask = { id: 'T1', title: 'Setup dependencies manifest and gitignore', files_hint: ['requirements.txt', '.gitignore'] } as any;

describe('pytest that collects no tests', () => {
  it('is not a failure when the task names no test files and the project has none yet', async () => {
    const result = await verifierWithPytest(5, NO_TESTS).verify(await pythonRepo(), setupTask);
    assert.equal(result.passed, true);
    assert.equal(result.executed, false);
    assert.match(result.testSummary, /collected no tests/);
  });

  it('still fails when a test file the task names holds no tests', async () => {
    const seen: string[][] = [];
    const task = { ...setupTask, files_hint: ['app/source.py', 'tests/test_source.py'] };
    const result = await verifierWithPytest(5, NO_TESTS, seen).verify(await pythonRepo(), task);
    assert.equal(result.passed, false);
    assert.match(result.testSummary, /no tests from the task's test files/);
    assert.deepEqual(seen[0], ['pytest', 'tests/test_source.py']);
  });

  it('still fails on a real test failure (exit 1)', async () => {
    const result = await verifierWithPytest(1, '1 failed in 0.02s').verify(await pythonRepo(), setupTask);
    assert.equal(result.passed, false);
    assert.equal(result.testSummary, 'pytest failure');
  });

  it('still fails on a collection error (exit 2)', async () => {
    const result = await verifierWithPytest(2, "ModuleNotFoundError: No module named 'bs4'").verify(await pythonRepo(), setupTask);
    assert.equal(result.passed, false);
    assert.equal(result.testSummary, 'pytest failure');
  });

  it('passes a green suite as before', async () => {
    const result = await verifierWithPytest(0, '3 passed in 0.01s').verify(await pythonRepo(), setupTask);
    assert.equal(result.passed, true);
    assert.equal(result.executed, true);
  });
});
