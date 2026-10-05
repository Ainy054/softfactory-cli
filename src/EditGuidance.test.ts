import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocalAgentWorker } from './ToolLoopWorker.js';

// godo's frontend/package.json, the file 14 of 15 edits failed to match.
const PKG = [
  '{',
  '  "name": "godo-frontend",',
  '  "scripts": {',
  '    "dev": "vite",',
  '    "test": "vitest",',
  '    "test:e2e": "playwright test"',
  '  }',
  '}',
].join('\n');

describe('a failed exact-match edit gets usable guidance', () => {
  const worker: any = new LocalAgentWorker();

  it('locates the intended line and points at replace_lines', () => {
    // Right text, wrong indentation — exactly how the model kept missing.
    const guidance = worker.matchFailureGuidance('package.json', PKG, '"test": "vitest",');
    assert.match(guidance, /similar text is at line 5/);
    assert.match(guidance, /replace_lines/);
    assert.match(guidance, /Do not retry an exact-text match/);
    assert.match(guidance, /^\s+5\|\s+"test": "vitest",$/m, 'must show numbered lines to use');
  });

  it('tolerates whitespace differences when locating the anchor', () => {
    const guidance = worker.matchFailureGuidance('package.json', PKG, '"test":"vitest",');
    assert.match(guidance, /similar text is at line 5/);
  });

  it('falls back to the numbered file when nothing resembles the target', () => {
    const guidance = worker.matchFailureGuidance('package.json', PKG, '"nonexistent": "xyzzy"');
    assert.match(guidance, /not in package\.json/);
    assert.match(guidance, /replace_lines/);
    assert.match(guidance, /^\s+1\|\s\{$/m, 'must still show the file with line numbers');
  });

  it('never repeats the old advice to match whitespace harder', () => {
    for (const target of ['"test": "vitest",', 'nope']) {
      assert.doesNotMatch(worker.matchFailureGuidance('package.json', PKG, target),
        /Ensure exact whitespace match/);
    }
  });
});
