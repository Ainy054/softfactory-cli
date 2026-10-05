import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekCloudWorker } from './DeepSeekCloudWorker.js';

describe('DeepSeek provider integration', () => {
  it('discovers account models and recognizes the configured model', async () => {
    const previousKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'test-key';
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }), { status: 200 })) as typeof fetch;
    try {
      const result = await new DeepSeekCloudWorker('deepseek-v4-flash', fetchImpl).checkAvailability();
      assert.deepEqual(result, { reachable: true, modelPresent: true, installed: ['deepseek-v4-flash'] });
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previousKey;
    }
  });

  it('treats rejected credentials as unavailable rather than a missing model', async () => {
    const previousKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'test-key';
    const fetchImpl = (async () => new Response('', { status: 401 })) as typeof fetch;
    try {
      const result = await new DeepSeekCloudWorker('deepseek-v4-flash', fetchImpl).checkAvailability();
      assert.deepEqual(result, { reachable: false, modelPresent: false, installed: [] });
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previousKey;
    }
  });
});
