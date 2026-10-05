import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocalAgentWorker as W } from './LocalAgentWorker.js';

/**
 * Mirrors the detector in execute(): three independent stall shapes, each of
 * which hid from the checks written for the other two.
 */
function runDetector(calls: string[]): { abortedAt: number | null; why: string } {
  const counts = new Map<string, number>();
  const recent: string[] = [];
  let last: string | null = null;
  for (let i = 0; i < calls.length; i++) {
    const fp = calls[i];
    const consecutive = (last === fp ? counts.get(`c:${fp}`) || 0 : 0) + 1;
    const total = (counts.get(`t:${fp}`) || 0) + 1;
    counts.set(`c:${fp}`, consecutive);
    counts.set(`t:${fp}`, total);
    last = fp;
    recent.push(fp);
    if (recent.length > W.CYCLE_WINDOW) recent.shift();
    const cycling = recent.length === W.CYCLE_WINDOW && new Set(recent).size <= W.CYCLE_DISTINCT;
    if (consecutive >= W.REPEAT_ABORT || cycling || total >= W.REPEAT_TOTAL_ABORT) {
      return { abortedAt: i, why: cycling ? 'cycle' : consecutive >= W.REPEAT_ABORT ? 'consecutive' : 'total' };
    }
  }
  return { abortedAt: null, why: 'none' };
}

const rep = (fp: string, n: number) => Array(n).fill(fp);
const alternate = (a: string, b: string, n: number) =>
  Array.from({ length: n * 2 }, (_, i) => (i % 2 ? b : a));

describe('stall detection catches all three shapes', () => {
  it('catches the eslint A/B oscillation that ran 12 rounds undetected', () => {
    // npm install eslint@latest / eslint@8.45.0, back and forth, forever.
    const r = runDetector(alternate('run:latest', 'run:8.45.0', 12));
    assert.equal(r.why, 'cycle');
    assert.ok(r.abortedAt !== null && r.abortedAt < 8, `aborted at ${r.abortedAt}, must be early`);
  });

  it('still catches a straight identical repeat', () => {
    const r = runDetector(rep('read:pkg', 10));
    assert.equal(r.why, 'consecutive');
    assert.equal(r.abortedAt, W.REPEAT_ABORT - 1);
  });

  it('catches a call repeated non-consecutively many times over', () => {
    // read, edit, read, edit ... the reads never stack up consecutively.
    const calls: string[] = [];
    for (let i = 0; i < 10; i++) calls.push('read:pkg', `edit:${i}`);
    const r = runDetector(calls);
    assert.equal(r.why, 'total');
  });

  it('leaves genuine progress alone', () => {
    // The productive shape from the run that reached a merge.
    const calls = ['read:a', 'edit:a', 'read:b', 'edit:b', 'read:c', 'edit:c',
                   'run:test', 'read:a', 'edit:a2', 'finish'];
    assert.equal(runDetector(calls).abortedAt, null);
  });

  it('does not fire on a short alternation that then moves on', () => {
    const calls = ['read:a', 'edit:a', 'read:a', 'edit:a', 'read:b', 'edit:b', 'finish'];
    assert.equal(runDetector(calls).abortedAt, null);
  });

  it('thresholds stay ordered and well inside the 30-iteration cap', () => {
    assert.ok(W.REPEAT_WARN < W.REPEAT_ABORT);
    assert.ok(W.REPEAT_ABORT <= W.REPEAT_TOTAL_ABORT);
    assert.ok(W.REPEAT_TOTAL_ABORT < 30);
    assert.ok(W.CYCLE_DISTINCT < W.CYCLE_WINDOW);
  });
});

/** Mirrors the progress rule: calls since the last successful edit. */
function runProgressDetector(calls: Array<{ tool: string; ok?: boolean; result?: string }>): number | null {
  let since = 0;
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    const mutated = ['write_file', 'replace_content', 'replace_lines'].includes(c.tool)
      && c.ok !== false
      && !c.result?.startsWith('Tool execution failed:');
    if (mutated || c.tool === 'finish_task') since = 0;
    else if (++since >= W.NO_PROGRESS_ABORT) return i;
  }
  return null;
}

const read = (f: string) => ({ tool: 'read_file', file: f });

describe('progress-based stall detection catches shapes the pattern checks miss', () => {
  it('catches the 4-file read cycle that walked past CYCLE_DISTINCT=2', () => {
    // The live stall: vitest.config -> playwright.config -> setup -> package.json,
    // repeating. Six full rounds, 27 calls, zero edits, and every pattern check
    // saw nothing: consecutive 1, distinct-in-window 4, cumulative under 8.
    const cycle = ['a', 'b', 'c', 'd'].map(read);
    const calls = Array.from({ length: 8 }, () => cycle).flat();
    const at = runProgressDetector(calls);
    assert.equal(at, W.NO_PROGRESS_ABORT - 1, 'must stop after 10 fruitless calls');
  });

  it('catches a read/run_command loop with no edits', () => {
    const calls = Array.from({ length: 6 }, () => [read('pkg'), { tool: 'run_command' }]).flat();
    assert.notEqual(runProgressDetector(calls), null);
  });

  it('does not fire while edits are landing', () => {
    // The healthy run: ~4 calls per successful edit, 155 calls, 37 edits.
    const calls = Array.from({ length: 20 }, () =>
      [read('a'), read('b'), { tool: 'run_command' }, { tool: 'replace_lines' }]).flat();
    assert.equal(runProgressDetector(calls), null);
  });

  it('counts a rejected edit as no progress', () => {
    // A model retrying an edit that keeps failing is not making progress.
    const calls = Array.from({ length: 12 }, () => ({ tool: 'replace_content', ok: false }));
    assert.equal(runProgressDetector(calls), W.NO_PROGRESS_ABORT - 1);
  });

  it('counts a tool exception as no progress', () => {
    const calls = Array.from({ length: 12 }, () => ({
      tool: 'write_file', result: 'Tool execution failed: Write path is outside declared task scope',
    }));
    assert.equal(runProgressDetector(calls), W.NO_PROGRESS_ABORT - 1);
  });

  it('allows a long read-in before the first edit', () => {
    const calls = [...Array.from({ length: 9 }, (_, i) => read(`f${i}`)), { tool: 'write_file' }];
    assert.equal(runProgressDetector(calls), null);
  });
});
