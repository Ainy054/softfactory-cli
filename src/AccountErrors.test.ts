import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeepSeekCloudWorker } from './ToolLoopWorker.js';
import { isEnvironmentFailure } from './IWorker.js';
import { TaskSchema } from './types.js';

// Observed 2026-10-09: the DeepSeek balance ran out mid-run; the 402s were
// swallowed by the tool-call probe and charged as four failed attempts.
function deepseek(chatStatus: number, chatBody: unknown) {
  let chats = 0;
  const fetchImpl = (async (url: any) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }), { status: 200 });
    chats++;
    return new Response(JSON.stringify(chatBody), { status: chatStatus, statusText: chatStatus === 402 ? 'Payment Required' : 'Unauthorized' });
  }) as typeof fetch;
  return { fetchImpl, chats: () => chats };
}

const task = TaskSchema.parse({ id: 'T1', title: 'Edit', description: 'Edit a.ts.', agent_role: 'coder', phase: 1, files_hint: ['a.ts'], acceptance_criteria: ['edited'], verification: ['true'], status: 'pending', attempts: 0 });

describe('an account fault is the environment\'s, not the task\'s', () => {
  for (const [status, body] of [[402, { error: { message: 'Insufficient Balance' } }], [401, { error: { message: 'Authentication Fails' } }]] as const) {
    it(`a ${status} halts the attempt uncharged instead of failing the tool-call probe`, async () => {
      const previous = process.env.DEEPSEEK_API_KEY;
      process.env.DEEPSEEK_API_KEY = 'sk-test';
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-account-'));
      try {
        const api = deepseek(status, body);
        const error = await new DeepSeekCloudWorker('deepseek-v4-flash', api.fetchImpl).execute(task, dir).then(() => null, e => e);
        assert.ok(error, 'the attempt must not succeed');
        assert.ok(isEnvironmentFailure(error), `expected an environment failure, got: ${error?.message}`);
        assert.match(error.message, new RegExp(`${status}`));
        assert.doesNotMatch(error.message, /parseable tool call/);
        assert.equal(api.chats(), 1, 'an account error is not retried');
      } finally {
        if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous;
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
});
