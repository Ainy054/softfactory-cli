import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safetyPreamble, affirmsLiveStackUntouched } from './IWorker.js';
import { EnvironmentSchema } from './Environment.js';
import { ToolLoopWorker } from './ToolLoopWorker.js';
import { Factory } from './Factory.js';
import { TaskSchema, type Handoff } from './types.js';
import type { ChatRequest, ChatTransport } from './ChatTransport.js';

/** Issue #45: every worker prompt starts with the same safety block, and every worker affirms it. */
const env = EnvironmentSchema.parse({
  live: 'production at https://app.example.com',
  test_env: { name: 'STAGING', deploy: './deploy.sh test' },
  production: { deploy: './deploy.sh prod' },
  orchestrator_files: ['docker-compose.yml'],
});

describe('the safety preamble', () => {
  it('is byte-identical for the same environment and names the live system, deploys and owned files', () => {
    const text = safetyPreamble(env);
    assert.equal(text, safetyPreamble(EnvironmentSchema.parse(JSON.parse(JSON.stringify(env)))));
    assert.match(text, /^CRITICAL SAFETY:/);
    for (const needle of ['production at https://app.example.com', './deploy.sh test', './deploy.sh prod', 'docker-compose.yml', 'live stack untouched']) assert.ok(text.includes(needle), needle);
  });

  it('without environment.json still tells the worker to touch nothing outside its worktree', () => {
    assert.match(safetyPreamble(undefined), /No environment\.json: assume a live system may exist/);
  });

  it('is the very first text of the tool-loop system prompt', async () => {
    const prompts: string[] = [];
    const transport: ChatTransport = {
      id: 't', name: 'T', label: 'T', limits: { toolOutput: 8000, fileRead: 32000 }, contextWindow: () => 32000, timeoutMs: () => 10000,
      checkAvailability: async () => ({ reachable: true, modelPresent: true, installed: ['m'] }), unreachable: () => 'u', missingModel: () => 'm',
      chat: async (request: ChatRequest) => {
        if (request.messages.length > 1) prompts.push(request.messages[0].content);
        return { content: '', toolCalls: [{ id: 'f', type: 'function', function: { name: request.messages.length === 1 ? 'read_file' : 'finish_task', arguments: request.messages.length === 1 ? { filepath: 'probe.txt' } : { summary: 's', test_summary: 't', status: 'failure' } } }] };
      },
    };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-preamble-'));
    const task = TaskSchema.parse({ id: 'T1', title: 't', description: 'd', agent_role: 'coder', phase: 1, files_hint: ['a.ts'], acceptance_criteria: ['x'], verification: ['true'], status: 'pending', attempts: 0 });
    await new ToolLoopWorker(transport, 'm').execute(task, dir, { preamble: safetyPreamble(env) }).catch(() => undefined);
    assert.ok(prompts[0]?.startsWith('CRITICAL SAFETY:'), prompts[0]?.slice(0, 80));
  });
});

describe('the live-stack affirmation', () => {
  it('counts only a line that is the phrase itself, not the request for it echoed from the prompt', () => {
    assert.equal(affirmsLiveStackUntouched('tests pass\nlive stack untouched\n'), true);
    assert.equal(affirmsLiveStackUntouched('Done.\n  Live stack untouched.'), true);
    assert.equal(affirmsLiveStackUntouched('- When you finish, affirm "live stack untouched": set it.'), false);
    assert.equal(affirmsLiveStackUntouched(undefined), false);
  });

  it('is required when environment.json exists, and not otherwise', async () => {
    const factory: any = new Factory(await fs.mkdtemp(path.join(os.tmpdir(), 'sf-affirm-')), '', { strategy: 'local', sandbox: 'none' });
    const handoff: Handoff = { task_id: 'T1', status: 'success', files_changed: ['a.ts'], summary: 'did it' };
    factory.environment = undefined;
    assert.equal(factory.safetyAffirmationViolation(handoff), null);
    factory.environment = env;
    assert.match(factory.safetyAffirmationViolation(handoff), /Affirm "live stack untouched"/);
    assert.equal(factory.safetyAffirmationViolation({ ...handoff, live_stack_untouched: true }), null);
  });
});
