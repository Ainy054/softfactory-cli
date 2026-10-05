import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, shouldRecommendSplit } from './FailurePolicy.js';

const broadTask = {
  files_hint: ['frontend/a.ts', 'backend/b.go'],
  creates_files: [],
  acceptance_criteria: ['frontend works', 'backend works'],
  verification: ['npm test'],
};

describe('repeated-failure decomposition policy', () => {
  it('does not split environment failures', () => {
    assert.equal(classifyFailure('Ollama is not reachable'), 'environment');
    assert.equal(shouldRecommendSplit(broadTask, 'Ollama is not reachable'), false);
  });

  it('does not split ordinary implementation failures', () => {
    assert.equal(classifyFailure('TypeError: cannot read property x'), 'implementation');
    assert.equal(shouldRecommendSplit(broadTask, 'TypeError: cannot read property x'), false);
  });

  it('recommends decomposition only for repeated scope-shaped work', () => {
    assert.equal(classifyFailure('Task is too broad for the available context; split independent areas'), 'scope');
    assert.equal(shouldRecommendSplit(broadTask, 'Task is too broad for the available context; split independent areas'), true);
  });

  it('requires multiple declared work and acceptance areas', () => {
    assert.equal(shouldRecommendSplit({ ...broadTask, files_hint: ['a.ts'] }, 'task is too broad; decompose it'), false);
    assert.equal(shouldRecommendSplit({ ...broadTask, acceptance_criteria: ['one'] }, 'task is too broad; decompose it'), false);
  });
});
