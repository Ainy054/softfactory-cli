import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Factory } from './Factory.js';

const f: any = new Factory('/tmp', '', { strategy: 'local' });

describe('the final gate only fails a build for failures it caused', () => {
  it('tolerates a suite that cannot reach its database', () => {
    // Exactly what marked the currency build failed: godo's postgres_test
    // was not running, on a frontend-only feature.
    assert.equal(f.wasAlreadyFailing({
      testSummary: 'Go test failure',
      output: 'isolation.go:190: Failed to create test database pool: '
        + 'failed to connect to `host=localhost`: dial tcp 127.0.0.1:5433: connect: connection refused',
    }), true);
  });

  it('tolerates pre-existing assertion failures alongside passes', () => {
    assert.equal(f.wasAlreadyFailing({
      testSummary: 'npm test failure',
      output: ' Test Files  5 failed | 21 passed (26)\n Tests  14 failed | 371 passed',
    }), true);
  });

  it('still fails a build that broke the compile', () => {
    for (const output of [
      'src/x.ts(4,9): error TS2345: Argument of type string',
      '# github.com/x/y\\nundefined: Foo\\nbuild failed',
      'Failed to load /src/foo.ts',
    ]) {
      assert.equal(f.wasAlreadyFailing({ testSummary: 'failure', output }), false, output.slice(0, 30));
    }
  });

  it('still fails a suite where nothing passed at all', () => {
    assert.equal(f.wasAlreadyFailing({
      testSummary: 'npm test failure',
      output: ' Test Files  26 failed (26)',
    }), false);
  });
});

describe('the final gate covers every ecosystem in the project', () => {
  it('probes node and go rather than dispatching to one', async () => {
    const { TaskVerifier } = await import('./TaskVerifier.js');
    const calls: string[] = [];
    const stub: any = {
      ecosystemsPresent: async () => new Set(['node', 'go']),
      verify: async (_p: string, task: any) => {
        const hint = task?.files_hint?.[0] ?? '(none)';
        calls.push(hint);
        return { executed: true, passed: true, testSummary: `ran for ${hint}`, output: '' };
      },
    };
    const results = await (TaskVerifier.prototype as any).verifyAll.call(stub, '/proj');
    // The currency build ran Go only, on a frontend-only feature, and failed it.
    assert.deepEqual(calls, ['frontend/x.tsx', 'backend/x.go']);
    assert.equal(results.length, 2, 'both ecosystems must be reported, not just the first');
  });

  it('runs a Node-only project once, not once per probe', async () => {
    const { TaskVerifier } = await import('./TaskVerifier.js');
    const calls: string[] = [];
    const stub: any = {
      ecosystemsPresent: async () => new Set(['node']),
      verify: async (_p: string, task: any) => {
        calls.push(task?.files_hint?.[0] ?? '(none)');
        // Both probes used to dispatch to Node here, and the dedupe key
        // included this summary, so the suite ran and was reported twice.
        return { executed: true, passed: true, testSummary: `node suite via ${task?.files_hint?.[0]}`, output: '' };
      },
    };
    const results = await (TaskVerifier.prototype as any).verifyAll.call(stub, '/proj');
    assert.deepEqual(calls, ['frontend/x.tsx']);
    assert.equal(results.length, 1);
  });

  it('falls back to a single untargeted run when neither probe executes', async () => {
    const { TaskVerifier } = await import('./TaskVerifier.js');
    const stub: any = {
      ecosystemsPresent: async () => new Set(),
      verify: async (_p: string, task: any) =>
        task ? { executed: false, passed: true, testSummary: 'nothing', output: '' }
             : { executed: true, passed: true, testSummary: 'fallback', output: '' },
    };
    const results = await (TaskVerifier.prototype as any).verifyAll.call(stub, '/proj');
    assert.equal(results.length, 1);
    assert.equal(results[0].testSummary, 'fallback');
  });

  it('detects ecosystems from the manifests on disk', async () => {
    const { TaskVerifier } = await import('./TaskVerifier.js');
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-eco-'));
    try {
      await fs.writeFile(path.join(dir, 'package.json'), '{}');
      assert.deepEqual([...await new TaskVerifier().ecosystemsPresent(dir)], ['node']);
      await fs.mkdir(path.join(dir, 'backend'));
      await fs.writeFile(path.join(dir, 'backend', 'go.mod'), 'module x');
      assert.deepEqual([...await new TaskVerifier().ecosystemsPresent(dir)].sort(), ['go', 'node']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
