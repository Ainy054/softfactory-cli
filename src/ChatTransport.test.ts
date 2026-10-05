import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AnthropicChatTransport, OllamaChatTransport, OpenAiCompatibleChatTransport, createChatTransport, type ChatMessage } from './ChatTransport.js';
import { ToolLoopWorker } from './ToolLoopWorker.js';
import { WorkerRegistry } from './WorkerRegistry.js';

const transcript: ChatMessage[] = [
  { role: 'system', content: 'SYS' },
  { role: 'user', content: 'do it' },
  { role: 'assistant', content: 'reading', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"filepath":"a"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'A' },
  { role: 'assistant', content: '', tool_calls: [
    { id: 'c2', type: 'function', function: { name: 'read_file', arguments: { filepath: 'b' } } },
    { id: 'c3', type: 'function', function: { name: 'read_file', arguments: { filepath: 'c' } } },
  ] },
  { role: 'tool', tool_call_id: 'c2', content: 'B' },
  { role: 'tool', tool_call_id: 'c3', content: 'C' },
  { role: 'system', content: 'compacted' },
  { role: 'user', content: 'You must call a tool.' },
];

function capture(reply: unknown) {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: any, init?: any) => {
    bodies.push(init?.body ? JSON.parse(init.body) : {});
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as typeof fetch;
  return { bodies, fetchImpl };
}

const request = (messages: ChatMessage[], model = 'm') => ({ model, messages, tools: ToolLoopWorker.TOOLS, temperature: 0.1, contextWindow: 8192, signal: new AbortController().signal });

describe('the Anthropic transport speaks content blocks', () => {
  it('translates the canonical transcript: system apart, tool results as user blocks, same-role turns merged', () => {
    const { system, messages } = AnthropicChatTransport.toAnthropic(transcript);
    assert.equal(system, 'SYS\n\ncompacted', 'both system messages fold into the system field');
    assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
    assert.deepEqual(messages[1].content, [{ type: 'text', text: 'reading' }, { type: 'tool_use', id: 'c1', name: 'read_file', input: { filepath: 'a' } }]);
    assert.deepEqual(messages[3].content.map((b: any) => b.type), ['tool_use', 'tool_use']);
    assert.deepEqual(messages[4].content, [
      { type: 'tool_result', tool_use_id: 'c2', content: 'B' },
      { type: 'tool_result', tool_use_id: 'c3', content: 'C' },
      { type: 'text', text: 'You must call a tool.' },
    ], 'two tool results and the reminder share one user turn, so roles alternate');
  });

  it('sends tools as input_schema and reads tool_use blocks back as calls', async () => {
    const { bodies, fetchImpl } = capture({ content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu1', name: 'write_file', input: { filepath: 'x', content: 'y' } }] });
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'k';
    try {
      const reply = await new AnthropicChatTransport(fetchImpl).chat(request(transcript));
      assert.equal(bodies[0].tools[0].name, 'read_file');
      assert.ok(bodies[0].tools[0].input_schema.properties.filepath);
      assert.equal(bodies[0].system, 'SYS\n\ncompacted');
      assert.equal(reply.content, 'ok');
      assert.deepEqual(reply.toolCalls, [{ id: 'tu1', type: 'function', function: { name: 'write_file', arguments: { filepath: 'x', content: 'y' } } }]);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});

describe('the OpenAI-compatible transport', () => {
  const config = { id: 'x', name: 'X', label: 'X', chatUrl: 'https://x/chat', modelsUrl: 'https://x/models', apiKeyEnv: 'X_KEY', contextWindow: 1000, timeoutEnv: 'X_TIMEOUT', supportsTemperature: (m: string) => !/^gpt-5/.test(m) };

  it('serialises arguments as JSON strings, omits empty tool_calls and answers by id', async () => {
    const { bodies, fetchImpl } = capture({ choices: [{ message: { content: null, tool_calls: [{ id: 'z', type: 'function', function: { name: 'read_file', arguments: '{"filepath":"q"}' } }] } }] });
    const reply = await new OpenAiCompatibleChatTransport(config, fetchImpl).chat(request(transcript));
    const sent = bodies[0].messages;
    assert.equal(sent[2].tool_calls[0].function.arguments, '{"filepath":"a"}');
    assert.equal(sent[4].tool_calls[1].function.arguments, '{"filepath":"c"}', 'object arguments are stringified');
    assert.equal('tool_calls' in sent[1], false);
    assert.equal(sent[3].tool_call_id, 'c1');
    assert.equal(bodies[0].temperature, 0.1);
    assert.equal(reply.content, '');
    assert.equal(reply.toolCalls[0].function.name, 'read_file');
  });

  it('drops temperature for a model family that rejects it', async () => {
    const { bodies, fetchImpl } = capture({ choices: [{ message: { content: 'hi' } }] });
    await new OpenAiCompatibleChatTransport(config, fetchImpl).chat(request(transcript, 'gpt-5.4'));
    assert.equal('temperature' in bodies[0], false);
  });
});

describe('the Ollama transport', () => {
  it('sends object arguments and the context window, and never a tool_call_id', async () => {
    const { bodies, fetchImpl } = capture({ message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: { filepath: 'q' } } }] } });
    const reply = await new OllamaChatTransport('http://h', fetchImpl).chat(request(transcript));
    const sent = bodies[0].messages;
    assert.deepEqual(sent[2].tool_calls[0].function.arguments, { filepath: 'a' }, 'a JSON string becomes an object');
    assert.equal(bodies[0].options.num_ctx, 8192);
    assert.equal('tool_call_id' in sent[3], false);
    assert.equal(reply.toolCalls[0].id, '', 'ids are assigned by the loop, not the transport');
  });
});

describe('the loop is the same code over every transport', () => {
  it('finishes a task over the Anthropic wire format', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-anth-'));
    await fs.writeFile(path.join(dir, 'a.txt'), 'hello');
    let calls = 0;
    const fetchImpl = (async (url: any, init?: any) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [{ id: 'claude-x' }] }), { status: 200 });
      calls++;
      const body = JSON.parse(init.body);
      const reply = (content: any[]) => new Response(JSON.stringify({ content }), { status: 200 });
      if (calls === 1) return reply([{ type: 'tool_use', id: 'p', name: 'read_file', input: { filepath: 'probe.txt' } }]);
      if (calls === 2) return reply([{ type: 'tool_use', id: 'u1', name: 'replace_content', input: { filepath: 'a.txt', target_content: 'hello', replacement_content: 'bye' } }]);
      // The previous tool result must have arrived as a tool_result block answering u1.
      const last = body.messages[body.messages.length - 1];
      assert.equal(last.role, 'user');
      assert.equal(last.content[0].type, 'tool_result');
      assert.equal(last.content[0].tool_use_id, 'u1');
      return reply([{ type: 'text', text: 'done' }, { type: 'tool_use', id: 'u2', name: 'finish_task', input: { summary: 's', test_summary: 't', status: 'success' } }]);
    }) as typeof fetch;
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'k';
    try {
      const worker: any = new ToolLoopWorker(createChatTransport('anthropic', { fetchImpl }), 'claude-x');
      worker.verifier = { verify: async () => ({ executed: true, passed: true, testSummary: 'ok', output: '' }) };
      const task: any = { id: 'T1', title: 't', agent_role: 'coder', description: 'd', files_hint: ['a.txt'], creates_files: [], attempts: 0 };
      const handoff = await worker.execute(task, dir, { diagnosticsDir: dir });
      assert.equal(handoff.status, 'success');
      assert.deepEqual(handoff.files_changed, ['a.txt']);
      assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf-8'), 'bye');
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('is what the registry hands out for every model-API provider', () => {
    for (const [provider, id] of [['deepseek', 'deepseek-cloud'], ['openai-api', 'openai-cloud'], ['anthropic', 'anthropic-cloud']] as const) {
      const registry: any = new WorkerRegistry('cloud', 'auto', 'm', 'f', 'l', 'h', provider);
      assert.ok(registry.cloudWorker instanceof ToolLoopWorker, provider);
      assert.equal(registry.cloudWorker.id, id);
    }
    const local: any = new WorkerRegistry('local');
    assert.ok(local.localWorker instanceof ToolLoopWorker);
    assert.equal(local.localWorker.id, 'local-agent');
  });
});
