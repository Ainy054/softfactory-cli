import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { swallowedErrors } from './SwallowedErrors.js';

function diffFor(file: string, addedLines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    'index 0000000..1111111',
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +1,${addedLines.length} @@`,
    ...addedLines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

describe('swallowedErrors — Python', () => {
  it('flags the exact mongolbank snippet and points at the except line', () => {
    const diff = diffFor('app.py', [
      'try:',
      '    parsed = parse_latest_rates()',
      'except Exception:',
      '    parsed = []',
    ]);
    const hits = swallowedErrors(diff);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, 'app.py');
    assert.equal(hits[0].line, 3, 'line number is the except line in the new file');
    assert.equal(hits[0].snippet, 'except Exception:');
  });

  it('does not flag a handler that logs and returns empty', () => {
    const diff = diffFor('app.py', [
      'try:',
      '    parsed = parse_latest_rates()',
      'except Exception as e:',
      '    logger.warning(f"failed: {e}")',
      '    return []',
    ]);
    assert.deepEqual(swallowedErrors(diff), []);
  });

  it('does not flag a one-line handler that logs then returns empty', () => {
    const diff = diffFor('app.py', [
      'try:',
      '    parsed = parse_latest_rates()',
      'except Exception as e: logger.warning("failed"); return []',
    ]);
    assert.deepEqual(swallowedErrors(diff), []);
  });

  it('does not flag a narrow except (except ValueError: return None)', () => {
    const diff = diffFor('app.py', [
      'try:',
      '    value = int(raw)',
      'except ValueError:',
      '    return None',
    ]);
    assert.deepEqual(swallowedErrors(diff), []);
  });

  it('does not flag a re-raise', () => {
    const diff = diffFor('app.py', [
      'try:',
      '    parsed = parse_latest_rates()',
      'except Exception:',
      '    raise',
    ]);
    assert.deepEqual(swallowedErrors(diff), []);
  });

  it('flags bare except followed by pass, continue, return None and empty assignments', () => {
    const cases: string[][] = [
      ['try:', '    run()', 'except:', '    pass'],
      ['try:', '    run()', 'except Exception:', '    continue'],
      ['try:', '    run()', 'except Exception:', '    return None'],
      ['try:', '    run()', 'except Exception:', '    data = {}'],
    ];
    for (const lines of cases) {
      const hits = swallowedErrors(diffFor('app.py', lines));
      assert.equal(hits.length, 1, `expected one hit for: ${lines.join(' / ')}`);
      assert.equal(hits[0].line, 3);
    }
  });

  it('does not flag a handler that records the error through logging or raise', () => {
    for (const body of ['    logger.error(e)', '    raise RuntimeError(e)', '    logging.exception("boom")']) {
      const hits = swallowedErrors(diffFor('app.py', ['try:', '    run()', 'except Exception as e:', body]));
      assert.deepEqual(hits, [], `expected no hit for body: ${body}`);
    }
  });
});

describe('swallowedErrors — JavaScript / TypeScript', () => {
  it('flags catch { return []; }', () => {
    const diff = diffFor('app.ts', ['try {', '  f();', '} catch { return []; }']);
    const hits = swallowedErrors(diff);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, 'app.ts');
    assert.equal(hits[0].line, 3);
  });

  it('flags a multi-line catch that discards', () => {
    const diff = diffFor('app.js', [
      'function f() {',
      '  try {',
      '    return g();',
      '  } catch {',
      '    return [];',
      '  }',
      '}',
    ]);
    const hits = swallowedErrors(diff);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 4);
  });

  it('does not flag catch (e) { console.error(e); throw e; }', () => {
    const diff = diffFor('app.js', ['try {', '  f();', '} catch (e) { console.error(e); throw e; }']);
    assert.deepEqual(swallowedErrors(diff), []);
  });

  it('does not flag a multi-line catch that re-throws', () => {
    const diff = diffFor('app.js', [
      'try {',
      '  f();',
      '} catch (e) {',
      '  console.error(e);',
      '  throw e;',
      '}',
    ]);
    assert.deepEqual(swallowedErrors(diff), []);
  });

  it('flags one-line .catch(() => {}) / [] / null handlers', () => {
    for (const line of ['return fetch(u).catch(() => {})', 'return fetch(u).catch(() => [])', 'return fetch(u).catch(() => null)']) {
      const hits = swallowedErrors(diffFor('app.ts', [line]));
      assert.equal(hits.length, 1, `expected a hit for: ${line}`);
      assert.equal(hits[0].line, 1);
    }
  });

  it('does not flag a catch that does other work', () => {
    const diff = diffFor('app.ts', ['try {', '  f();', '} catch (e) {', '  report(e);', '}']);
    assert.deepEqual(swallowedErrors(diff), []);
  });
});

describe('swallowedErrors — test files and line numbers', () => {
  it('skips a hit inside tests/test_x.py', () => {
    const diff = diffFor('tests/test_x.py', [
      'try:',
      '    run()',
      'except Exception:',
      '    parsed = []',
    ]);
    assert.deepEqual(swallowedErrors(diff), []);
  });

  it('skips *.test.* and test_*.py files', () => {
    const tsDiff = diffFor('src/foo.test.ts', ['try {', '  f();', '} catch { return []; }']);
    assert.deepEqual(swallowedErrors(tsDiff), []);
    const pyDiff = diffFor('test_rates.py', ['try:', '    run()', 'except Exception:', '    return []']);
    assert.deepEqual(swallowedErrors(pyDiff), []);
  });

  it('reports each handler in diff order with correct line numbers', () => {
    const diff = diffFor('app.py', [
      'try:',                    // 1
      '    a()',                 // 2
      'except Exception:',       // 3
      '    a = []',              // 4
      'try:',                    // 5
      '    b()',                 // 6
      'except Exception:',       // 7
      '    pass',                // 8
    ]);
    const hits = swallowedErrors(diff);
    assert.deepEqual(hits.map(h => h.line), [3, 7]);
    assert.ok(hits.every(h => h.file === 'app.py'));
  });

  it('ignores removed lines and counts only added lines for the line number', () => {
    const diff = [
      'diff --git a/app.py b/app.py',
      '--- a/app.py',
      '+++ b/app.py',
      '@@ -10,3 +10,4 @@',
      ' context_line',
      '-except ValueError:',
      '+except Exception:',
      '+    parsed = []',
      '',
    ].join('\n');
    // Removed lines do not advance the new-file number; the handler is line 11.
    const hits = swallowedErrors(diff);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 11);
  });
});
