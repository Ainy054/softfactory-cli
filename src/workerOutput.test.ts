import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendWorkerLog, normalizeWorkerOutput } from './workerOutput.js';

describe('worker output normalization', () => {
  it('splits chunks, removes terminal escapes, and drops blank lines', () => {
    assert.deepEqual(normalizeWorkerOutput('\u001b[31mError\u001b[0m\n\n  next step  '), [
      'Error',
      'next step',
    ]);
  });

  it('truncates long lines with an ellipsis', () => {
    assert.deepEqual(normalizeWorkerOutput('1234567890', 6), ['12345…']);
  });

  it('keeps only the latest lines from a large chunk', () => {
    assert.deepEqual(normalizeWorkerOutput('one\ntwo\nthree', 240, 2), ['two', 'three']);
  });

  it('bounds retained log history', () => {
    assert.deepEqual(appendWorkerLog([1, 2, 3], 4, 3), [2, 3, 4]);
  });
});
