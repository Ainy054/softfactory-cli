import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SandboxManager } from './Sandbox.js';

// #105: the mongolbank-fastapi demo halted with "Docker is not available"
// although `docker version` answered in 0.1 s before and after: one probe,
// one stall past its 8 s timeout, cached for the whole run.

function manager(results: boolean[], mode: 'auto' | 'docker' | 'none' = 'auto') {
  const logs: string[] = [];
  const m = new SandboxManager(mode, line => logs.push(line));
  let calls = 0;
  m.probeDocker = async () => {
    const ok = results[Math.min(calls, results.length - 1)];
    calls++;
    if (!ok) throw new Error('Cannot connect to the Docker daemon');
  };
  m.detectRetryMs = 0;
  return { m, logs, calls: () => calls };
}

describe('Docker detection retries a slow answer', () => {
  it('is available when a later attempt answers, and says it retried', async () => {
    const { m, logs, calls } = manager([false, false, true]);
    assert.equal(await m.detect(), true);
    assert.equal(calls(), 3);
    assert.equal(m.blockingReason(), null);
    assert.deepEqual(logs.filter(l => l.startsWith('Docker did not answer')), [
      'Docker did not answer (attempt 1 of 3); retrying in 0 s',
      'Docker did not answer (attempt 2 of 3); retrying in 0 s',
    ]);
  });

  it('is unavailable only after three failed attempts, and the halt names Docker', async () => {
    const { m, calls } = manager([false]);
    assert.equal(await m.detect(), false);
    assert.equal(calls(), 3);
    assert.match(m.blockingReason() ?? '', /Docker is not available/);
  });

  it('answers at once when Docker answers at once', async () => {
    const { m, logs, calls } = manager([true]);
    assert.equal(await m.detect(), true);
    assert.equal(calls(), 1);
    assert.deepEqual(logs, []);
  });

  it('does not retry when docker is not installed', async () => {
    const logs: string[] = [];
    const m = new SandboxManager('auto', line => logs.push(line));
    let calls = 0;
    m.probeDocker = async () => { calls++; throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }); };
    m.detectRetryMs = 0;
    assert.equal(await m.detect(), false);
    assert.equal(calls, 1);
    assert.deepEqual(logs, []);
  });

  it('never probes in mode none', async () => {
    const { m, calls } = manager([true], 'none');
    assert.equal(await m.detect(), false);
    assert.equal(calls(), 0);
    assert.equal(m.blockingReason(), null);
  });

  it('caches the answer for the run', async () => {
    const { m, calls } = manager([false, true]);
    assert.equal(await m.detect(), true);
    assert.equal(await m.detect(), true);
    assert.equal(calls(), 2);
  });
});
