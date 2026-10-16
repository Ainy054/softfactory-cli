import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { runUat, UatSchema, type ShellRunner } from './Uat.js';

// #106: the mongolbank-fastapi demo's live check failed on the Bank of
// Mongolia's own "502 Server Error: Bad Gateway" during backfill. Every task
// was fine, and the bank answered 200 a few minutes later.

const BANK_502 = 'Error during backfill: HTTP request to Mongolbank API failed: 502 Server Error: Bad Gateway for url: https://www.mongolbank.mn/en/currency-rates/data?startDate=2026-01-01&endDate=2026-01-10';

/** Answers each command from a script, in order; records every call. */
function scripted(answers: Record<string, Array<{ exitCode: number; output: string }>>) {
  const calls: string[] = [];
  const shell: ShellRunner = async command => {
    calls.push(command);
    const queue = answers[command];
    const answer = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
    return answer ?? { exitCode: 0, output: '' };
  };
  return { shell, calls };
}

async function dir(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), 'sf-uat-upstream-')); }

const opts = (shell: ShellRunner, logs: string[] = []) => ({ runId: 'r', featureId: 'f', shell, upstreamRetryMs: 0, log: (l: string) => logs.push(l) });

describe('a live check step that hits an upstream 5xx runs once more', () => {
  it('passes when the retry succeeds, and says so', async () => {
    const backfill = 'python -m app.backfill --from 2026-01-01 --to 2026-01-10';
    const { shell, calls } = scripted({ [backfill]: [{ exitCode: 1, output: BANK_502 }, { exitCode: 0, output: '2026: 10 days, 380 rates' }] });
    const logs: string[] = [];
    const result = await runUat(await dir(), UatSchema.parse({ setup: [backfill], probes: [{ name: 'ok', run: 'true' }] }), opts(shell, logs));
    assert.equal(result.passed, true, JSON.stringify(result.steps));
    assert.equal(calls.filter(c => c === backfill).length, 2);
    assert.equal(result.steps.find(s => s.name === 'setup 1')?.detail, 'ok after one retry (upstream server error)');
    assert.ok(logs.some(l => /setup 1 hit an upstream server error; retrying once in 0 s/.test(l)), logs.join('\n'));
  });

  it('fails when the retry hits a 5xx again', async () => {
    const backfill = 'python -m app.backfill';
    const { shell, calls } = scripted({ [backfill]: [{ exitCode: 1, output: BANK_502 }] });
    const result = await runUat(await dir(), UatSchema.parse({ setup: [backfill], probes: [{ name: 'ok', run: 'true' }] }), opts(shell));
    assert.equal(result.passed, false);
    assert.equal(calls.filter(c => c === backfill).length, 2, 'retried exactly once');
    assert.match(result.steps.find(s => s.name === 'setup 1')?.detail ?? '', /502 Server Error/);
  });

  it('does not retry a failure that is not an upstream server error', async () => {
    const backfill = 'python -m app.backfill';
    const { shell, calls } = scripted({ [backfill]: [{ exitCode: 1, output: "ModuleNotFoundError: No module named 'requests'" }] });
    const result = await runUat(await dir(), UatSchema.parse({ setup: [backfill], probes: [{ name: 'ok', run: 'true' }] }), opts(shell));
    assert.equal(result.passed, false);
    assert.equal(calls.filter(c => c === backfill).length, 1);
  });

  it('retries a curl probe that reports a 503, and passes', async () => {
    const probe = "curl -fsS 'http://127.0.0.1:8000/rates/latest'";
    const { shell, calls } = scripted({ [probe]: [{ exitCode: 22, output: 'curl: (22) The requested URL returned error: 503' }, { exitCode: 0, output: '[{"currency":"USD"}]' }] });
    const result = await runUat(await dir(), UatSchema.parse({ probes: [{ name: 'latest', run: probe, expect: 'USD' }] }), opts(shell));
    assert.equal(result.passed, true, JSON.stringify(result.steps));
    assert.equal(calls.filter(c => c === probe).length, 2);
    assert.equal(result.steps.find(s => s.name === 'probe: latest')?.detail, 'reachable after one retry (upstream server error)');
  });

  it('does not retry a probe whose output does not match its expect', async () => {
    const probe = "curl -fsS 'http://127.0.0.1:8000/rates/latest'";
    const { shell, calls } = scripted({ [probe]: [{ exitCode: 0, output: '[]' }] });
    const result = await runUat(await dir(), UatSchema.parse({ probes: [{ name: 'latest', run: probe, expect: 'USD' }] }), opts(shell));
    assert.equal(result.passed, false);
    assert.equal(calls.filter(c => c === probe).length, 1);
  });
});
