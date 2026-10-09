import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ToolLoopWorker } from './ToolLoopWorker.js';
import { TaskSchema } from './types.js';
import type { ChatTransport, ChatRequest, ChatReply, ToolCall } from './ChatTransport.js';

/**
 * 5.5: save every worker prompt and journal its hash. The one place a worker
 * hands the exact assembled prompt back to the orchestrator is `onPrompt`, so
 * these tests pin that contract for the tool-loop worker.
 */

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: args } });

function scripted(turns: Array<(request: ChatRequest) => ChatReply>): ChatTransport & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    id: 'scripted', name: 'Scripted', label: 'Scripted', limits: { toolOutput: 8000, fileRead: 32000 }, requests,
    contextWindow: () => 32000, timeoutMs: () => 10000,
    checkAvailability: async () => ({ reachable: true, modelPresent: true, installed: ['fake'] }),
    unreachable: () => 'unreachable', missingModel: () => 'missing',
    chat: async request => {
      requests.push(request);
      if (request.messages.length === 1 && /probe\.txt/.test(request.messages[0].content)) return { content: '', toolCalls: [call('probe', 'read_file', { filepath: 'probe.txt' })] };
      const turn = turns.shift();
      return turn ? turn(request) : { content: '', toolCalls: [call('end', 'finish_task', { summary: 'done', test_summary: 'none', status: 'failure' })] };
    },
  };
}

const task = TaskSchema.parse({
  id: 'T1', title: 'Add AgyStream', description: 'Create src/AgyStream.ts.', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
  files_hint: [], creates_files: ['src/AgyStream.ts'], acceptance_criteria: ['parseAgyEvent returns typed events'], verification: ['npm run build'],
  status: 'pending', attempts: 0,
});

async function worktree(files: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-savedprompt-'));
  for (let i = 1; i <= files; i++) await fs.writeFile(path.join(dir, `f${i}.ts`), `export const v${i} = ${i};\n`);
  return dir;
}

describe('every worker prompt is saved', () => {
  it('hands onPrompt the full prompt once, carrying the task title between the system and first user message', async () => {
    const transport = scripted([]);
    const prompts: string[] = [];
    await new ToolLoopWorker(transport, 'fake').execute(task, await worktree(1), { onPrompt: prompt => prompts.push(prompt) });

    assert.equal(prompts.length, 1, 'onPrompt runs exactly once per attempt');
    const prompt = prompts[0];
    assert.ok(prompt.includes(task.title), `the task title is in the saved prompt:\n${prompt}`);
    assert.match(prompt, new RegExp(`Title: ${task.title}`));

    // The system message and the first user message are joined by a blank line,
    // so the saved file contains the whole prompt the model actually saw.
    const first = transport.requests.find(r => r.messages[0]?.role === 'system')!;
    assert.equal(prompt, `${first.messages[0].content}\n\n${first.messages[1].content}`);
    assert.match(prompt, /\n\nTask ID: T1\n/);
  });

  it('reports the prompt once even when the attempt loops through several turns', async () => {
    const turns = Array.from({ length: 3 }, (_, i) => () => ({ content: `step ${i}`, toolCalls: [call(`r${i}`, 'read_file', { filepath: `f${i + 1}.ts` })] }));
    const transport = scripted(turns);
    const prompts: string[] = [];
    await new ToolLoopWorker(transport, 'fake').execute(task, await worktree(3), { onPrompt: prompt => prompts.push(prompt) });

    assert.equal(prompts.length, 1, 'the loop does not re-emit the prompt on every iteration');
    assert.ok(prompts[0].includes(task.title));
  });
});
