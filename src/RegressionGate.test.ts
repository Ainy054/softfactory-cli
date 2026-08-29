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

// Real vitest output is coloured and enormous; its summary is the last line.
const E = String.fromCharCode(27);
const ANSI_TAIL = ` ${E}[2m Test Files ${E}[22m ${E}[31m43 failed${E}[39m ${E}[90m(43)${E}[39m\n`
  + `      ${E}[2m Tests ${E}[22m ${E}[31m388 failed${E}[39m ${E}[90m(388)${E}[39m\n`
  + `   ${E}[2m Duration ${E}[22m 7.47s\n`;

describe('counts survive real runner output', () => {
  const v = new TaskVerifier();

  it('reads a coloured vitest summary', () => {
    // Without stripping ANSI this parsed as 0/0/0/0 and the gate went inert.
    assert.deepEqual(v.parseCounts(ANSI_TAIL),
      { filesFailed: 43, filesPassed: 0, testsFailed: 388, testsPassed: 0 });
  });

  it('keeps the tail when trimming, because that is where the summary is', () => {
    // Measured on godo: the summary begins at char 117,586 of 117,780.
    const huge = 'noise\n'.repeat(20000) + ANSI_TAIL;
    const clipped = v.clip(huge);
    assert.ok(clipped.length < 5000, 'must actually trim');
    assert.equal(v.parseCounts(clipped)?.filesFailed, 43, 'the summary must survive trimming');
  });

  it('keeps the head too, where compile errors appear', () => {
    const huge = 'error TS2345: Argument of type\n' + 'noise\n'.repeat(20000) + ANSI_TAIL;
    assert.match(v.clip(huge), /error TS2345/);
  });

  it('a short output is returned untouched', () => {
    assert.equal(v.clip('brief'), 'brief');
  });
});
