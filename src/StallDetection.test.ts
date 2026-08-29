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
