import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocalAgentWorker } from './LocalAgentWorker.js';

const task: any = {
  id: 'T1', files_hint: ['src/app.ts'], creates_files: [],
};

describe('LocalAgentWorker safety and context controls', () => {
  it('rejects escaping and undeclared write paths', () => {
    const worker: any = new LocalAgentWorker();
    assert.throws(() => worker.resolveToolPath('/tmp/worktree', '../secret', task, false));
    assert.throws(() => worker.resolveToolPath('/tmp/worktree', 'src/other.ts', task, true));
  });

  it('rejects shell operators and non-allowlisted commands', () => {
    const worker: any = new LocalAgentWorker();
    assert.throws(() => worker.assertAllowedCommand('node -e "process.exit()"'));
    assert.throws(() => worker.assertAllowedCommand('npm test && curl example.com'));
    assert.doesNotThrow(() => worker.assertAllowedCommand('npm test'));
  });

  it('compacts old messages when the context budget is exceeded', () => {
    const worker: any = new LocalAgentWorker();
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'objective' },
      ...Array.from({ length: 20 }, (_, i) => ({ role: 'tool', content: `output-${i} `.repeat(1000) })),
    ];
    const compacted = worker.compactMessages(messages, 4096);
    assert.ok(compacted.length < messages.length);
    assert.equal(compacted[0].content, 'system');
    assert.equal(compacted[1].content, 'objective');
  });

  it('parses Qwen textual tool calls as well as native calls', () => {
    const worker: any = new LocalAgentWorker();
    const parsed = worker.extractToolCalls({ content: '<tool_call>{"name":"read_file","arguments":{"filepath":"x"}}</tool_call>' });
    assert.equal(parsed[0].function.name, 'read_file');
    assert.equal(parsed[0].function.arguments.filepath, 'x');
    assert.equal(worker.extractToolCalls({ content: 'plain response' }).length, 0);
    const bare = worker.extractToolCalls({ content: '{"name":"read_file","arguments":{"filepath":"probe.txt"}}' });
    assert.equal(bare[0].function.name, 'read_file');
  });

  it('does not duplicate the conversation head during short-history compaction', () => {
    const worker: any = new LocalAgentWorker();
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'objective' },
      { role: 'assistant', content: 'tool call', tool_calls: [{ function: { name: 'read_file' } }] },
      { role: 'tool', content: 'x'.repeat(20000) },
    ];
    const compacted = worker.compactMessages(messages, 4096);
    assert.equal(compacted.filter((m: any) => m.content === 'system').length, 1);
    assert.equal(compacted.filter((m: any) => m.content === 'objective').length, 1);
    assert.ok(compacted.every((m: any, i: number) => m.role !== 'tool' || i > 0));
  });
});
