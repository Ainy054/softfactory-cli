import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { findSecrets, redactSecrets } from './redact.js';
import { LessonManager } from './LessonManager.js';

describe('credential shapes are redacted', () => {
  const cases: Array<[string, string]> = [
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
    ['aws key AKIAIOSFODNN7EXAMPLE in config', 'AKIAIOSFODNN7EXAMPLE'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghij'],
    ['DATABASE_URL=postgres://app:s3cretpw@db:5432/app', 's3cretpw'],
    ['{"password": "hunter2", "user": "x"}', 'hunter2'],
    ['{"apiKey":"abc123xyz"}', 'abc123xyz'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', 'MIIEow'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ', 'eyJhbGciOiJIUzI1NiJ9'],
    ['OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz', 'abcdefghijklmnop'],
    ['slack xoxb-123456789012-abcdefghijkl', 'xoxb-123456789012'],
  ];

  for (const [input, secret] of cases) {
    it(`hides ${input.slice(0, 32)}…`, () => {
      const out = redactSecrets(input);
      assert.ok(!out.includes(secret), `still contains the secret: ${out}`);
      assert.match(out, /REDACTED/);
    });
  }

  it('keeps the structure around the secret so the record stays readable', () => {
    assert.equal(redactSecrets('DATABASE_URL=postgres://app:s3cretpw@db:5432/app'), 'DATABASE_URL=postgres://app:[REDACTED_SECRET]@db:5432/app');
    assert.equal(redactSecrets('{"password": "hunter2"}'), '{"password": "[REDACTED_SECRET]"}');
  });

  it('leaves ordinary text alone', () => {
    for (const text of ['npm test failed: expected 2 to be 3', 'the token parser in src/lex.ts', 'password reset page renders']) {
      assert.equal(redactSecrets(text), text);
    }
  });
});

describe('findSecrets locates credentials without redacting them away', () => {
  it('detects each provider pattern, a PEM block and a generic assignment', () => {
    const text = [
      'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'aws key AKIAIOSFODNN7EXAMPLE in config',
      'slack xoxb-123456789012-abcdefghijkl',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
      'API_KEY=real_secret_123',
    ].join('\n');

    const hits = findSecrets(text);
    const kinds = hits.map((h) => h.kind);
    assert.ok(kinds.includes('GitHub token'), `expected GitHub token, got ${kinds.join(', ')}`);
    assert.ok(kinds.includes('AWS access key'));
    assert.ok(kinds.includes('Slack token'));
    assert.ok(kinds.includes('JWT'));
    assert.ok(kinds.includes('PEM private key'));
    assert.ok(kinds.includes('Generic assignment'));
    assert.ok(hits.some((h) => h.kind === 'PEM private key' && h.match.includes('MIIEow')));
  });

  it('ignores obvious placeholder values', () => {
    const text = [
      'API_KEY=xxx',
      'API_KEY=your-api-key',
      'API_KEY=<your-token>',
      'API_KEY=changeme',
      'API_KEY=example',
      'API_KEY=aaaa',
    ].join('\n');

    const hits = findSecrets(text);
    assert.deepEqual(hits.filter((h) => h.kind === 'Generic assignment'), []);
  });

  it('does not flag .env.example-style placeholder content', () => {
    const text = [
      '# .env.example',
      'GITHUB_TOKEN=your-api-key',
      'AWS_ACCESS_KEY_ID=xxx',
      'SLACK_TOKEN=changeme',
      'JWT_SECRET=example',
      'DATABASE_PASSWORD=AAAAAAAA',
    ].join('\n');

    assert.deepEqual(findSecrets(text), []);
  });

  it('honors secretScanAllow patterns by skipping the matching line', () => {
    const text = [
      'API_KEY=real_secret_123',
      'skip_me=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    ].join('\n');

    const hits = findSecrets(text, { allowedPatterns: [/SKIP_ME/] });
    assert.ok(hits.some((h) => h.kind === 'Generic assignment' && h.match.includes('real_secret_123')));
    assert.ok(!hits.some((h) => h.kind === 'GitHub token' || h.match.includes('skip_me')), JSON.stringify(hits));
  });

  it('keeps provider-prefixed patterns strict for placeholder-like and fixture-like values', () => {
    const fixture = 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const fixtureHits = findSecrets(fixture);
    assert.ok(fixtureHits.some((h) => h.kind === 'GitHub token' && h.match === 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'));

    const repeatedAwsValue = `AWS_ACCESS_KEY_ID=AKIA${'A'.repeat(16)}`;
    const awsHits = findSecrets(repeatedAwsValue);
    assert.ok(awsHits.some((h) => h.kind === 'AWS access key' && h.match === `AKIA${'A'.repeat(16)}`));
  });
});

describe('lesson evidence is redacted before it is stored', () => {
  it('never writes a credential quoted from failure output into lessons.json', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-lesson-'));
    await fs.mkdir(path.join(baseDir, '.softfactory'));
    const lessons = new LessonManager(baseDir);
    const added = await lessons.add({
      lesson: 'Always load the database URL from the environment, not a literal.', tags: ['config'], scope: 'project', confidence: 0.9, check: 'grep -rn "postgres://" src',
      evidence: { taskId: 'T1', failure: 'connection refused for postgres://app:s3cretpw@db/app', resolution: 'set DATABASE_URL=postgres://app:s3cretpw@db/app in config' },
    });
    assert.equal(added, true);
    const stored = await fs.readFile(path.join(baseDir, '.softfactory', 'lessons.json'), 'utf8');
    assert.ok(!stored.includes('s3cretpw'), stored);
    assert.match(stored, /REDACTED_SECRET/);
  });
});
