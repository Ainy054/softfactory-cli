import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { TaskVerifier } from './TaskVerifier.js';
import { Factory } from './Factory.js';

/** A project with a real unit test but no "test" script — godo after T1 merged. */
async function projectWithTestsButNoScript() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-failclosed-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'App.test.tsx'), 'it("x", () => {});');
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'p', scripts: { 'test:unit': 'vitest', build: 'vite build' },
  }));
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });   // skip `npm ci`
  return dir;
}

describe('verification fails closed', () => {
  it('rejects a project that has tests but no way to run them', async () => {
    const dir = await projectWithTestsButNoScript();
    const result = await new TaskVerifier().verify(dir, undefined, false);
    assert.equal(result.passed, false,
      'T1 passed by renaming "test" to "test:unit"; that must never be a pass');
    assert.match(result.testSummary, /No "test" script/);
  });

  it('still passes a project that genuinely has no tests', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-notests-'));
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { build: 'x' } }));
    await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
    const result = await new TaskVerifier().verify(dir, undefined, false);
    assert.equal(result.passed, true);
    assert.match(result.testSummary, /no test files found/);
  });

  it('detects test files across languages', async () => {
    const v: any = new TaskVerifier();
    for (const [name, expected] of [['App.test.tsx', true], ['api_test.go', true], ['test_util.py', false],
                                    ['util.spec.ts', true], ['README.md', false]] as const) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-hastests-'));
      await fs.writeFile(path.join(dir, name), 'x');
      assert.equal(await v.hasTestFiles(dir), expected, `${name} -> ${expected}`);
    }
  });
});

describe('a task cannot pass by disabling its own verification', () => {
  const factory: any = new Factory('/tmp', '', { strategy: 'local' });

  it('rejects a diff that removes the "test" script', () => {
    // The literal change that merged as T1 on godo.
    const diff = [
      '--- a/frontend/package.json',
      '+++ b/frontend/package.json',
      '-    "test": "vitest",',
      '+    "test:unit": "vitest",',
    ].join('\n');
    assert.match(factory.detectVerificationSabotage(diff), /"test" script was removed/);
  });

  it('allows changing the test script to something else', () => {
    const diff = '-    "test": "vitest",\n+    "test": "vitest run",';
    assert.equal(factory.detectVerificationSabotage(diff), null);
  });

  it('rejects a diff that deletes test files', () => {
    const diff = [
      'diff --git a/src/App.test.tsx b/src/App.test.tsx',
      'deleted file mode 100644',
      'index 111..000',
      '--- a/src/App.test.tsx',
      '+++ /dev/null',
    ].join('\n');
    assert.match(factory.detectVerificationSabotage(diff), /test files were deleted/);
  });

  it('leaves ordinary changes alone', () => {
    assert.equal(factory.detectVerificationSabotage('--- a/src/x.ts\n+++ b/src/x.ts\n-const a = 1\n+const a = 2'), null);
  });
});
