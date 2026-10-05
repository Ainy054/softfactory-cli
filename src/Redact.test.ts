import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { redactSecrets } from './redact.js';
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

describe('lesson evidence is redacted before it is stored', () => {
  it('never writes a credential quoted from failure output into lessons.json', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-lesson-'));
    await fs.mkdir(path.join(baseDir, '.softfactory'));
    const lessons = new LessonManager(baseDir);
    const added = await lessons.add({
      lesson: 'Always load the database URL from the environment, not a literal.', tags: ['config'], scope: 'project', confidence: 0.9,
      evidence: { taskId: 'T1', failure: 'connection refused for postgres://app:s3cretpw@db/app', resolution: 'set DATABASE_URL=postgres://app:s3cretpw@db/app in config' },
    });
    assert.equal(added, true);
    const stored = await fs.readFile(path.join(baseDir, '.softfactory', 'lessons.json'), 'utf8');
    assert.ok(!stored.includes('s3cretpw'), stored);
    assert.match(stored, /REDACTED_SECRET/);
  });
});
