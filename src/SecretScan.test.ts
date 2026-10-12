import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { isSecretPath, loadSecretScanAllow, parseAddedLines, scanDiff } from './secretScan.js';

async function emptyBaseDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sf-secret-scan-'));
}

async function configBaseDir(config: unknown): Promise<string> {
  const baseDir = await emptyBaseDir();
  await fs.mkdir(path.join(baseDir, '.softfactory'), { recursive: true });
  await fs.writeFile(path.join(baseDir, '.softfactory', 'config.json'), JSON.stringify(config));
  return baseDir;
}

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

describe('parseAddedLines', () => {
  it('extracts only added lines, with new-file line numbers, and ignores headers', () => {
    const diff = [
      'diff --git a/src/config.py b/src/config.py',
      'index 0000000..1111111',
      '--- a/src/config.py',
      '+++ b/src/config.py',
      '@@ -1,4 +1,5 @@',
      ' import os',
      '+TOKEN=abc',
      ' DEBUG=False',
      '-OLD=removed',
      '+API_KEY=xyz',
    ].join('\n');

    assert.deepEqual(parseAddedLines(diff), [
      { path: 'src/config.py', lineNumber: 2, content: 'TOKEN=abc' },
      { path: 'src/config.py', lineNumber: 4, content: 'API_KEY=xyz' },
    ]);
  });

  it('ignores +++ headers and non-added lines across files', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      'index 0000000..1111111',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -0,0 +1,2 @@',
      '+first',
      '+second',
      'diff --git a/b.txt b/b.txt',
      'index 0000000..1111111',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -0,0 +1,1 @@',
      '+third',
    ].join('\n');

    assert.deepEqual(parseAddedLines(diff), [
      { path: 'a.txt', lineNumber: 1, content: 'first' },
      { path: 'a.txt', lineNumber: 2, content: 'second' },
      { path: 'b.txt', lineNumber: 1, content: 'third' },
    ]);
  });

  it('handles a diff with no newline at the end of the file', () => {
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -0,0 +1,1 @@',
      '+SECRET=value',
    ].join('\n');

    assert.deepEqual(parseAddedLines(diff), [{ path: 'x', lineNumber: 1, content: 'SECRET=value' }]);
  });

  it('ignores the "no newline at end of file" marker', () => {
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -0,0 +1,1 @@',
      '+SECRET=value',
      '\\ No newline at end of file',
    ].join('\n');

    assert.deepEqual(parseAddedLines(diff), [{ path: 'x', lineNumber: 1, content: 'SECRET=value' }]);
  });
});

describe('isSecretPath', () => {
  it('differentiates .env from allowed .env.example variants', () => {
    assert.equal(isSecretPath('.env'), true);
    assert.equal(isSecretPath('server/.env'), true);
    assert.equal(isSecretPath('.env.local'), true);
    assert.equal(isSecretPath('.env.production'), true);
    assert.equal(isSecretPath('.env.example'), false);
    assert.equal(isSecretPath('.env.sample'), false);
    assert.equal(isSecretPath('.env.template'), false);
  });

  it('recognizes key and credential files', () => {
    assert.equal(isSecretPath('certs/server.pem'), true);
    assert.equal(isSecretPath('keys/service.key'), true);
    assert.equal(isSecretPath('keys/id_rsa'), true);
    assert.equal(isSecretPath('keys/id_rsa.pub'), true);
    assert.equal(isSecretPath('bundle.p12'), true);
    assert.equal(isSecretPath('credentials.json'), true);
    assert.equal(isSecretPath('src/config.ts'), false);
  });

  it('treats .npmrc and .pypirc as secret only when they contain an auth token', () => {
    assert.equal(isSecretPath('.npmrc', 'registry=https://registry.npmjs.org/'), false);
    assert.equal(isSecretPath('.npmrc', '//registry.npmjs.org/:_authToken=npm_secret'), true);
    assert.equal(isSecretPath('.pypirc', '[distutils]\nindex-servers = pypi'), false);
    assert.equal(isSecretPath('.pypirc', '[pypi]\npassword = hunter2'), true);
  });
});

describe('scanDiff', () => {
  it('returns file, line number and kind for a diff adding a real secret', async () => {
    const baseDir = await emptyBaseDir();
    const diff = diffFor('src/config.py', ['GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789']);

    const hits = await scanDiff(diff, baseDir);

    assert.ok(hits.some((h) => h.path === 'src/config.py' && h.lineNumber === 1 && h.kind === 'GitHub token'));
  });

  it('rejects secret file paths and allows .env.example', async () => {
    const baseDir = await emptyBaseDir();

    const envHits = await scanDiff(diffFor('.env', ['API_KEY=real_secret_123']), baseDir);
    assert.deepEqual(envHits, [{ path: '.env', lineNumber: 1, kind: 'Secret file path' }]);

    const pemHits = await scanDiff(diffFor('certs/server.pem', ['-----BEGIN RSA PRIVATE KEY-----']), baseDir);
    assert.deepEqual(pemHits.map((h) => h.path), ['certs/server.pem']);

    const exampleHits = await scanDiff(diffFor('.env.example', ['API_KEY=your-api-key']), baseDir);
    assert.deepEqual(exampleHits, []);
  });

  it('skips generic assignments in test fixtures but keeps provider-prefixed secrets', async () => {
    const baseDir = await emptyBaseDir();
    const diff = diffFor('test/fixtures/config.ts', [
      'API_KEY=real_secret_123',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    ]);

    const hits = await scanDiff(diff, baseDir);
    const kinds = hits.map((h) => h.kind);

    assert.ok(!kinds.includes('Generic assignment'), `expected generic hit to be suppressed: ${JSON.stringify(hits)}`);
    assert.ok(kinds.includes('GitHub token'), `expected provider-prefixed hit to remain: ${JSON.stringify(hits)}`);
    assert.ok(hits.some((h) => h.path === 'test/fixtures/config.ts' && h.lineNumber === 2));
  });

  it('honors secretScanAllow by skipping matching lines', async () => {
    const baseDir = await configBaseDir({ secretScanAllow: ['real_secret_123'] });
    const hits = await scanDiff(diffFor('src/config.ts', ['API_KEY=real_secret_123']), baseDir);

    assert.deepEqual(hits, []);
  });

  it('returns only redacted facts, never the matched secret value', async () => {
    const baseDir = await emptyBaseDir();
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const hits = await scanDiff(diffFor('src/config.py', [`GITHUB_TOKEN=${secret}`]), baseDir);

    const serialized = JSON.stringify(hits);
    assert.ok(!serialized.includes(secret), serialized);
    for (const hit of hits) {
      assert.deepEqual(Object.keys(hit).sort(), ['kind', 'lineNumber', 'path']);
    }
  });
});

describe('loadSecretScanAllow', () => {
  it('returns an empty list when config or field is absent', async () => {
    const baseDir = await emptyBaseDir();
    assert.deepEqual(await loadSecretScanAllow(baseDir), []);
  });

  it('compiles the secretScanAllow regex list', async () => {
    const baseDir = await configBaseDir({ secretScanAllow: ['SKIP_ME', 'another.*line'] });
    const allow = await loadSecretScanAllow(baseDir);

    assert.equal(allow.length, 2);
    assert.ok(allow[0].test('SKIP_ME token'));
    assert.ok(allow[1].test('another skipped line'));
  });
});
