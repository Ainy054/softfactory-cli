import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testWriterScopeViolation } from './Factory.js';

/** A minimal unified diff whose `diff --git` headers list the given paths. */
function diffFor(...files: string[]): string {
  return files
    .map(file => [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      '@@ -1,1 +1,2 @@',
      '+change',
    ].join('\n'))
    .join('\n');
}

describe('a test writer may only add or change test files', () => {
  const testWriter = { agent_role: 'test_writer' };

  it('accepts a diff that touches only a test file', () => {
    const diff = diffFor('src/a.test.ts');
    assert.equal(testWriterScopeViolation(testWriter, diff), null);
  });

  it('rejects a test writer that also changes a source file', () => {
    const diff = diffFor('src/a.test.ts', 'src/a.ts');
    const violation = testWriterScopeViolation(testWriter, diff);
    assert.ok(violation, 'a test writer that edits production code must be rejected');
    assert.match(violation, /src\/a\.ts/, 'the message must name the offending source file');
  });

  it('does not apply to a coder task touching a source file', () => {
    const diff = diffFor('src/a.ts');
    assert.equal(testWriterScopeViolation({ agent_role: 'coder' }, diff), null);
  });
});
