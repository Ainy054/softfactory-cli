import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalAgentWorker } from './LocalAgentWorker.js';

type Turn = { content?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> };

/**
 * Replaces global fetch with a scripted Ollama: the availability check, the
 * tool-support probe, then one scripted reply per loop turn. Drives the real
 * execute() rather than a copy of its logic.
 */
function scriptOllama(turns: Turn[]) {
  const requests: any[] = [];
  let chatCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const target = String(url);
    if (target.endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: [{ name: 'fake-model' }] }), { status: 200 });
    }
    chatCalls++;
    requests.push(init?.body ? JSON.parse(init.body) : {});
    if (chatCalls === 1) {
      return new Response(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { filepath: 'probe.txt' } } }] } }), { status: 200 });
    }
    const turn = turns[chatCalls - 2];
    if (!turn) throw new Error(`unexpected chat call #${chatCalls}: the loop should have stopped`);
    const tool_calls = (turn.calls || []).map(c => ({ function: { name: c.name, arguments: c.args } }));
    return new Response(JSON.stringify({ message: { role: 'assistant', content: turn.content || '', tool_calls } }), { status: 200 });
  }) as typeof fetch;
  return { requests, chatCalls: () => chatCalls, restore: () => { globalThis.fetch = original; } };
}

async function worktree(content: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-loop-'));
  await fs.writeFile(path.join(dir, 'a.txt'), content);
  return dir;
}

const task: any = { id: 'T1', title: 't', agent_role: 'coder', description: 'd', files_hint: ['a.txt'], creates_files: [], attempts: 0 };
const finish = { name: 'finish_task', args: { summary: 's', test_summary: 't', status: 'success' } };

function workerWithVerifier(passed: boolean) {
  const worker: any = new LocalAgentWorker('fake-model');
  worker.verifier = { verify: async () => ({ executed: true, passed, testSummary: passed ? 'ok' : 'boom', output: '' }) };
  return worker;
}

describe('the tool loop stops when finish_task is rejected twice', () => {
  it('ends the attempt instead of letting finish_task be refused until the cap', async () => {
    const dir = await worktree('x');
    const script = scriptOllama([{ calls: [finish] }, { calls: [finish] }, { calls: [finish] }, { calls: [finish] }]);
    try {
      const handoff = await workerWithVerifier(false).execute(task, dir, { diagnosticsDir: dir });
      assert.equal(handoff.status, 'failure');
      assert.match(handoff.summary, /finish_task twice/);
      assert.equal(script.chatCalls(), 3, 'probe plus two loop turns; the throw used to be swallowed and the loop went on');
    } finally {
      script.restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('replace_content treats the replacement as literal text', () => {
  it('writes "$&" as characters, not as the matched text', async () => {
    const dir = await worktree('hello X world');
    const script = scriptOllama([
      { calls: [{ name: 'replace_content', args: { filepath: 'a.txt', target_content: 'X', replacement_content: '$&$&' } }] },
      { calls: [finish] },
    ]);
    try {
      const handoff = await workerWithVerifier(true).execute(task, dir, { diagnosticsDir: dir });
      assert.equal(handoff.status, 'success');
      assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf-8'), 'hello $&$& world');
    } finally {
      script.restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an ambiguous target rather than silently editing the first match', async () => {
    const dir = await worktree('X X');
    const script = scriptOllama([
      { calls: [{ name: 'replace_content', args: { filepath: 'a.txt', target_content: 'X', replacement_content: 'Y' } }] },
      { calls: [finish] },
    ]);
    try {
      await workerWithVerifier(true).execute(task, dir, { diagnosticsDir: dir });
      assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf-8'), 'X X', 'the file must be untouched');
      const last = script.requests[script.requests.length - 1];
      const toolReplies = last.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
      assert.ok(toolReplies.some((c: string) => /occurs 2 times/.test(c)), `model was told: ${toolReplies.join(' | ')}`);
    } finally {
      script.restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('command parsing keeps quoted arguments intact', () => {
  const w: any = new LocalAgentWorker();

  it('strips both quotes, not just the opening one', () => {
    assert.deepEqual(w.parseCommand('grep "foo bar" file'), ['grep', 'foo bar', 'file']);
    assert.deepEqual(w.parseCommand("rg 'a|b' src"), ['rg', 'a|b', 'src']);
    assert.deepEqual(w.parseCommand('ls --color="x y"'), ['ls', '--color=x y']);
  });

  it('splits pipelines outside quotes only', () => {
    assert.deepEqual(w.splitPipeline("rg 'foo|bar' src | head -5"), ["rg 'foo|bar' src", 'head -5']);
    assert.doesNotThrow(() => w.assertAllowedCommand("rg 'foo|bar' src"), 'a | inside quotes is an argument, not a pipe');
    assert.doesNotThrow(() => w.assertAllowedCommand('grep -E "a|b" file | wc -l'));
  });

  it('still rejects shell-or and unsafe pipelines', () => {
    assert.throws(() => w.assertAllowedCommand('ls || rm x'));
    assert.throws(() => w.assertAllowedCommand('cat a | sh'));
  });
});

describe('compaction keeps a turn with several tool results', () => {
  it('does not drop every recent message when one turn made four calls', () => {
    const w: any = new LocalAgentWorker();
    const messages = [
      { role: 'system', content: 'S'.repeat(9000) },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: '', tool_calls: [1, 2, 3, 4] },
      { role: 'tool', content: 't1'.repeat(1000) },
      { role: 'tool', content: 't2'.repeat(1000) },
      { role: 'tool', content: 't3'.repeat(1000) },
      { role: 'tool', content: 't4'.repeat(2500) },
    ];
    const out = w.compactMessages(messages, 4096);
    const tools = out.filter((m: any) => m.role === 'tool');
    assert.equal(tools.length, 4, `all four results must survive; got ${out.map((m: any) => m.role).join(',')}`);
    const assistantAt = out.findIndex((m: any) => m.role === 'assistant');
    assert.ok(assistantAt >= 0 && out[assistantAt + 1].role === 'tool', 'the results must follow the turn that requested them');
    assert.ok(tools[3].content.length > 1000, 'the newest result stays readable');
  });
});
