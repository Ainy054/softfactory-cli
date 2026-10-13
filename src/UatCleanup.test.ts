import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { runUat, UatSchema } from './Uat.js';

// mongolbank-rates (f-20261013073810): the planner's setup ran
// `python3 -m app.backfill --from ... --to ...` followed by
// `uvicorn app.main:app --port 8000 &`, with no teardown. The run finished at
// 19:41 and three hours later uvicorn still held port 8000, so the next live
// check would either fail with "address already in use" or probe the stale
// server and pass against old code. These tests run the real host shell and
// prove that a setup step which backgrounds a server no longer blocks the run
// and no longer survives it.

const skip = process.platform === 'win32' ? 'POSIX process groups are not available on win32' : false;

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sf-uat-cleanup-'));
}

async function readPid(file: string): Promise<number> {
  return Number((await fs.readFile(file, 'utf8')).trim());
}

/** True while the process still exists; ESRCH is the only "gone" answer. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

async function killQuietly(pid: number): Promise<void> {
  if (!pid) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** Whatever a test process left behind must not outlive the test. */
async function cleanup(dir: string, pid: number): Promise<void> {
  await killQuietly(pid);
  await fs.rm(dir, { recursive: true, force: true });
}

describe('a UAT setup that backgrounds a server does not leave it running', () => {
  it('returns at once, stops the group, keeps the output, and passes', { skip }, async () => {
    const dir = await tmpDir();
    let pid = 0;
    const log: string[] = [];
    try {
      const pidFile = path.join(dir, 'pid');
      const config = UatSchema.parse({
        // No `> file 2>&1`: the background child inherits stdout/stderr, which
        // used to keep execa waiting until the timeout.
        setup: [`sleep 300 & echo $! > ${pidFile}`],
        probes: [{ name: 'reachable', run: 'echo probe-reached' }],
      });
      const started = Date.now();
      const result = await runUat(dir, config, {
        runId: 'r',
        featureId: 'f',
        evidenceDir: path.join(dir, 'evidence'),
        log: line => log.push(line),
      });
      const elapsed = Date.now() - started;
      pid = await readPid(pidFile);
      assert.ok(elapsed < 10_000, `runUat waited ${elapsed} ms for the background child`);
      assert.equal(result.passed, true, JSON.stringify(result.steps));
      assert.equal(alive(pid), false, `background process ${pid} is still alive`);
      const evidence = await fs.readFile(result.evidencePath ?? '', 'utf8');
      assert.match(evidence, /probe-reached/, 'the probe output is missing from the evidence log');
      assert.match(evidence, /RESULT: PASS/);
      assert.deepEqual(log.filter(line => line.includes('stopped')), ['UAT: stopped 1 background process group(s) left by setup']);
    } finally {
      await cleanup(dir, pid);
    }
  });

  it('still stops the group when a probe fails', { skip }, async () => {
    const dir = await tmpDir();
    let pid = 0;
    try {
      const pidFile = path.join(dir, 'pid');
      const config = UatSchema.parse({
        setup: [`sleep 300 & echo $! > ${pidFile}`],
        probes: [{ name: 'failing', run: 'false' }],
      });
      const result = await runUat(dir, config, { runId: 'r', featureId: 'f' });
      pid = await readPid(pidFile);
      assert.equal(result.passed, false);
      assert.equal(alive(pid), false, `background process ${pid} survived a failed UAT`);
    } finally {
      await cleanup(dir, pid);
    }
  });

  it('says nothing when teardown already stopped the process', { skip }, async () => {
    const dir = await tmpDir();
    let pid = 0;
    const log: string[] = [];
    try {
      const pidFile = path.join(dir, 'pid');
      const config = UatSchema.parse({
        setup: [`sleep 300 & echo $! > ${pidFile}`],
        probes: [{ name: 'ok', run: 'true' }],
        // The wait makes the assertion deterministic: `kill` returns before the
        // process is reaped, and a reaped group is what ESRCH reports.
        teardown: [`kill $(cat ${pidFile}); while kill -0 $(cat ${pidFile}) 2>/dev/null; do sleep 0.1; done`],
      });
      const result = await runUat(dir, config, { runId: 'r', featureId: 'f', log: line => log.push(line) });
      pid = await readPid(pidFile);
      assert.equal(result.passed, true, JSON.stringify(result.steps));
      assert.equal(alive(pid), false);
      assert.deepEqual(log.filter(line => line.includes('stopped')), [], 'a group teardown stopped must not be reported as left behind');
    } finally {
      await cleanup(dir, pid);
    }
  });

  it('SIGKILLs a process that ignores SIGTERM', { skip }, async () => {
    const dir = await tmpDir();
    let pid = 0;
    try {
      const pidFile = path.join(dir, 'pid');
      const config = UatSchema.parse({
        setup: [`sh -c 'trap "" TERM; sleep 300' & echo $! > ${pidFile}`],
        probes: [{ name: 'ok', run: 'true' }],
      });
      const started = Date.now();
      const result = await runUat(dir, config, { runId: 'r', featureId: 'f' });
      pid = await readPid(pidFile);
      assert.equal(result.passed, true, JSON.stringify(result.steps));
      // The five-second SIGTERM wait ran before the SIGKILL.
      assert.ok(Date.now() - started >= 4_000, 'the setup group was not given its SIGTERM wait');
      assert.equal(await waitGone(pid, 3_000), true, `process ${pid} ignores SIGTERM and was not SIGKILLed`);
    } finally {
      await cleanup(dir, pid);
    }
  });
  it('fails a step that outlives timeout_seconds with exit 124, and stops it', { skip }, async () => {
    const dir = await tmpDir();
    let pid = 0;
    try {
      const pidFile = path.join(dir, 'pid');
      const config = UatSchema.parse({
        probes: [{ name: 'slow', run: `echo $$ > ${pidFile}; sleep 30` }],
        timeout_seconds: 1,
      });
      const started = Date.now();
      const result = await runUat(dir, config, { runId: 'r', featureId: 'f' });
      pid = await readPid(pidFile);
      assert.ok(Date.now() - started < 10_000, 'the timeout did not end the step');
      assert.equal(result.passed, false);
      assert.match(result.steps.find(step => step.name === 'probe: slow')?.detail ?? '', /^exit 124/);
      assert.equal(await waitGone(pid, 3_000), true, `timed-out step ${pid} is still running`);
    } finally {
      await cleanup(dir, pid);
    }
  });
});
