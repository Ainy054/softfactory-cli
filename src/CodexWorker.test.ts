import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexExecArgs, buildCodexExecOptions } from './CodexWorker.js';

describe('CodexWorker command construction', () => {
  it('uses automatic approval without the mutually exclusive sandbox flag', () => {
    const args = buildCodexExecArgs('implement the task', 'gpt-5.6-sol');

    assert.deepEqual(args, [
      'exec',
      '--approve-for-me',
      '--model',
      'gpt-5.6-sol',
      'implement the task',
    ]);
    assert.equal(args.includes('--sandbox'), false);
  });

  it('omits the model option when Codex should use its configured default', () => {
    assert.deepEqual(buildCodexExecArgs('implement the task'), [
      'exec',
      '--approve-for-me',
      'implement the task',
    ]);
  });

  it('closes stdin so Codex cannot wait for additional input', () => {
    const options = buildCodexExecOptions('/tmp/worktree');

    assert.equal(options.stdin, 'ignore');
    assert.equal(options.cwd, '/tmp/worktree');
    assert.equal(options.timeout, 600000);
  });
});
