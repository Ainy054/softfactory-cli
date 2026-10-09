import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadRules, violations, type Rule } from './NonNegotiables.js';

/** Writes a `non-negotiables.txt` into a throwaway checkout and returns its root. */
async function checkout(text: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-nn-'));
  await fs.mkdir(path.join(dir, '.softfactory'), { recursive: true });
  await fs.writeFile(path.join(dir, '.softfactory', 'non-negotiables.txt'), text);
  return dir;
}

const rule = (regex: string, reason: string): Rule => ({ regex, reason, pattern: new RegExp(regex) });

describe('loadRules', () => {
  it('parses rules, skipping blank lines and comments, splitting off the reason', async () => {
    const dir = await checkout([
      '# rules no test catches',
      '',
      'console\\.log :: no console.log in src',
      '   ',
      '# a second comment',
      'BEGIN (RSA|OPENSSH) PRIVATE KEY :: never commit private keys',
      '',
    ].join('\n'));

    const rules = await loadRules(dir);
    assert.equal(rules.length, 2);
    assert.equal(rules[0].regex, 'console\\.log');
    assert.equal(rules[0].reason, 'no console.log in src');
    assert.equal(rules[1].regex, 'BEGIN (RSA|OPENSSH) PRIVATE KEY');
    assert.equal(rules[1].reason, 'never commit private keys');
  });

  it('uses the regex itself as the reason when there is no separator', async () => {
    const rules = await loadRules(await checkout('TODO\\(fix\\)\n'));
    assert.deepEqual(rules.map(r => [r.regex, r.reason]), [['TODO\\(fix\\)', 'TODO\\(fix\\)']]);
  });

  it('throws an error naming the line of an invalid regex', async () => {
    const dir = await checkout('ok-rule :: fine\n[unclosed :: bad pattern\n');
    await assert.rejects(loadRules(dir), (err: Error) => {
      assert.match(err.message, /line 2/);
      return true;
    });
  });

  it('is empty when the project declares no rules', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-nn-'));
    assert.deepEqual(await loadRules(dir), []);
  });
});

describe('violations', () => {
  const consoleLog = rule('console\\.log', 'no console.log in src');

  it('ignores a rule that only matches a removed line', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '-console.log("old")',
      '+const x = 1;',
    ].join('\n');
    assert.deepEqual(violations([consoleLog], diff), []);
  });

  it('reports the file and the reason for a rule matching an added line', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '-const x = 1;',
      '+console.log("new")',
    ].join('\n');
    assert.deepEqual(violations([consoleLog], diff), [
      { rule: 'console\\.log', reason: 'no console.log in src', file: 'src/app.ts', line: 'console.log("new")' },
    ]);
  });

  it('never treats a +++ header as an added line and follows the nearest diff --git header', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '+console.log("a")',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '+console.log("b")',
    ].join('\n');
    const hits = violations([consoleLog], diff);
    assert.deepEqual(hits.map(h => [h.file, h.line]), [
      ['src/a.ts', 'console.log("a")'],
      ['src/b.ts', 'console.log("b")'],
    ]);
  });
});
