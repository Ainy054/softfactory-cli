import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeepSeekCloudWorker } from './ToolLoopWorker.js';

type Turn = { content?: string; calls?: Array<{ id: string; name: string; args: Record<string, unknown> }> };

/** A scripted OpenAI-compatible endpoint: /models, the probe, then one reply per turn. */
function scriptDeepSeek(turns: Turn[]) {
  const requests: any[] = [];
  let chatCalls = 0;
  const fetchImpl = (async (url: any, init?: any) => {
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }), { status: 200 });
    }
    chatCalls++;
    requests.push(init?.body ? JSON.parse(init.body) : {});
    const reply = (message: any) => new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    if (chatCalls === 1) {
      return reply({ role: 'assistant', content: '', tool_calls: [{ id: 'p1', type: 'function', function: { name: 'read_file', arguments: '{"filepath":"probe.txt"}' } }] });
    }
    const turn = turns[chatCalls - 2];
    if (!turn) throw new Error(`unexpected chat call #${chatCalls}`);
    const tool_calls = (turn.calls || []).map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    return reply({ role: 'assistant', content: turn.content ?? null, ...(tool_calls.length ? { tool_calls } : {}) });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe('DeepSeek requests stay within the OpenAI-compatible protocol', () => {
  it('omits empty tool_calls and answers every tool message by id, the repeat warning included', async () => {
    const previousKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'test-key';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-ds-'));
    await fs.writeFile(path.join(dir, 'a.txt'), 'x');
    const read = (id: string) => ({ id, name: 'read_file', args: { filepath: 'a.txt' } });
    const script = scriptDeepSeek([
      { content: 'Let me think.' },
      { calls: [read('c3')] },
      { calls: [read('c4')] },
      { calls: [read('c5')] },           // third identical call: the repeat warning
      { calls: [{ id: 'c6', name: 'finish_task', args: { summary: 's', test_summary: 't', status: 'success' } }] },
    ]);
    try {
      const worker: any = new DeepSeekCloudWorker('deepseek-v4-flash', script.fetchImpl);
      worker.verifier = { verify: async () => ({ executed: true, passed: true, testSummary: 'ok', output: '' }) };
      const task: any = { id: 'T1', title: 't', agent_role: 'coder', description: 'd', files_hint: ['a.txt'], creates_files: [], attempts: 0 };
      const handoff = await worker.execute(task, dir, { diagnosticsDir: dir });
      assert.equal(handoff.status, 'success');

      const final = script.requests[script.requests.length - 1].messages;
      const textOnly = final.find((m: any) => m.role === 'assistant' && m.content === 'Let me think.');
      assert.ok(textOnly, 'the text-only turn must be in the transcript');
      assert.equal('tool_calls' in textOnly, false, 'an empty tool_calls array is rejected by the API');

      const toolMessages = final.filter((m: any) => m.role === 'tool');
      assert.ok(toolMessages.length >= 3);
      for (const m of toolMessages) assert.ok(m.tool_call_id, `tool message without tool_call_id: ${m.content.slice(0, 60)}`);
      const warning = toolMessages.find((m: any) => /already called read_file/.test(m.content));
      assert.ok(warning, 'the repeat warning must be present');
      assert.equal(warning.tool_call_id, 'c5');
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previousKey;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

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
