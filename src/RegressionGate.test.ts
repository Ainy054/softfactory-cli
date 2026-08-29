import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TaskVerifier } from './TaskVerifier.js';
import { Factory } from './Factory.js';

// Real vitest output from godo, before and after the merges that got reverted.
const BASELINE_OUT = ' Test Files  21 failed | 22 passed (43)\n      Tests  14 failed | 374 passed (388)';
const REGRESSED_OUT = ' Test Files  68 failed | 33 passed (101)\n      Tests  188 failed | 562 passed (750)';

describe('suite counts are read from runner output', () => {
  const v = new TaskVerifier();

  it('parses vitest tallies', () => {
    assert.deepEqual(v.parseCounts(BASELINE_OUT),
      { filesFailed: 21, filesPassed: 22, testsFailed: 14, testsPassed: 374 });
    assert.deepEqual(v.parseCounts(REGRESSED_OUT),
      { filesFailed: 68, filesPassed: 33, testsFailed: 188, testsPassed: 562 });
  });

  it('parses go tallies', () => {
    const counts = v.parseCounts('ok  \tgithub.com/x/a\t0.4s\n--- FAIL: TestOne\n--- PASS: TestTwo\n');
    assert.equal(counts?.testsFailed, 1);
    assert.ok((counts?.testsPassed ?? 0) >= 1);
  });

  it('returns nothing when there is no tally to read', () => {
    assert.equal(v.parseCounts('some unrelated output'), undefined);
  });
});

describe('a task may not make the suite worse', () => {
  const factory = () => new Factory('/tmp', '', { strategy: 'local' }) as any;
  const v = new TaskVerifier();

  it('rejects the exact regression that merged twice', () => {
    const f = factory();
    f.baseline = v.parseCounts(BASELINE_OUT);
    const verdict = f.detectRegression({ counts: v.parseCounts(REGRESSED_OUT) });
    assert.match(verdict, /failing tests went from 14 to 188/);
  });

  it('rejects a drop in passing tests even if failures do not rise', () => {
    const f = factory();
    f.baseline = { filesFailed: 5, filesPassed: 20, testsFailed: 10, testsPassed: 300 };
    assert.match(f.detectRegression({ counts: { filesFailed: 5, filesPassed: 20, testsFailed: 10, testsPassed: 250 } }),
      /passing tests dropped from 300 to 250/);
  });

  it('rejects a suite that suddenly collects far more files', () => {
    // T01 took collection from 43 files to 101 by mis-scoping the config.
    const f = factory();
    f.baseline = { filesFailed: 21, filesPassed: 22, testsFailed: 0, testsPassed: 0 };
    assert.match(f.detectRegression({ counts: { filesFailed: 21, filesPassed: 80, testsFailed: 0, testsPassed: 0 } }),
      /collects 101 files where the baseline collected 43/);
  });

  it('allows a task that improves the suite', () => {
    const f = factory();
    f.baseline = v.parseCounts(BASELINE_OUT);
    assert.equal(f.detectRegression({ counts: { filesFailed: 5, filesPassed: 38, testsFailed: 5, testsPassed: 383 } }), null);
  });

  it('allows a task that changes nothing', () => {
    const f = factory();
    f.baseline = v.parseCounts(BASELINE_OUT);
    assert.equal(f.detectRegression({ counts: v.parseCounts(BASELINE_OUT) }), null);
  });

  it('does not fire without a baseline or without counts', () => {
    const f = factory();
    assert.equal(f.detectRegression({ counts: v.parseCounts(REGRESSED_OUT) }), null);
    f.baseline = v.parseCounts(BASELINE_OUT);
    assert.equal(f.detectRegression({}), null);
  });
});
