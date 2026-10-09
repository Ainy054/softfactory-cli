import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateBlueprint } from './Planner.js';
import { ToolLoopWorker } from './ToolLoopWorker.js';
import { briefSection } from './IWorker.js';
import { TaskSchema } from './types.js';
import type { ChatTransport, ChatRequest, ToolCall } from './ChatTransport.js';

/** Issue #20: shared briefs and per-task spec, out-of-scope and notes fields. */

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: args } });

describe('shared briefs and task fields', () => {
  it('the validator keeps brief, spec, out_of_scope and notes_to_executor', () => {
    const plan = {
      feature: 'Rename the money helpers', requirements_covered: [], brief: 'Rename map: toCents -> toMinorUnits; fromCents -> fromMinorUnits.',
      tasks: [{ id: 'T1', title: 'Rename in the core', description: 'Apply the rename map in src/money.ts.', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [], files_hint: ['src/money.ts'], creates_files: [], acceptance_criteria: ['renamed'], verification: ['grep toMinorUnits src/money.ts'], spec: 'docs/money.md §2', out_of_scope: ['the billing adapter'], notes_to_executor: ['keep the old names as deprecated aliases'] }],
    };
    const blueprint = validateBlueprint(plan, { requirement: 'x', codebaseContext: '', memoryPatterns: '', featureHistory: '', repositoryFiles: new Set(['src/money.ts']) });
    assert.equal(blueprint.brief, plan.brief);
    assert.equal(blueprint.tasks[0].spec, 'docs/money.md §2');
    assert.deepEqual(blueprint.tasks[0].out_of_scope, ['the billing adapter']);
    assert.deepEqual(blueprint.tasks[0].notes_to_executor, ['keep the old names as deprecated aliases']);
  });

  it('a section is empty when there is nothing to say', () => {
    assert.equal(briefSection({ out_of_scope: [], notes_to_executor: [] }), '');
  });

  it('the tool-loop worker puts the brief, spec, out-of-scope items and notes in its first user message', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-brief-'));
    await fs.writeFile(path.join(dir, 'money.ts'), 'export const toCents = (x: number) => x * 100;\n');
    const prompts: string[] = [];
    const transport: ChatTransport = {
      id: 's', name: 's', label: 'S', limits: { toolOutput: 8000, fileRead: 32000 }, contextWindow: () => 32000, timeoutMs: () => 10000,
      checkAvailability: async () => ({ reachable: true, modelPresent: true, installed: ['m'] }), unreachable: () => '', missingModel: () => '',
      chat: async (request: ChatRequest) => {
        if (request.messages.length === 1 && /probe\.txt/.test(request.messages[0].content)) return { content: '', toolCalls: [call('p', 'read_file', { filepath: 'probe.txt' })] };
        if (request.messages[0].role === 'system' && request.messages.length === 2) prompts.push(request.messages[1].content);
        return { content: '', toolCalls: [call('e', 'finish_task', { summary: 's', test_summary: 't', status: 'failure' })] };
      },
    };
    const task = TaskSchema.parse({ id: 'T1', title: 'Rename', description: 'Apply the rename map.', agent_role: 'coder', phase: 1, files_hint: ['money.ts'], acceptance_criteria: ['renamed'], verification: ['grep toMinorUnits money.ts'], status: 'pending', attempts: 0, spec: 'docs/money.md §2', out_of_scope: ['the billing adapter'], notes_to_executor: ['keep deprecated aliases'] });
    await new ToolLoopWorker(transport, 'm').execute(task, dir, { brief: 'Rename map: toCents -> toMinorUnits.' });
    const prompt = prompts[0];
    assert.match(prompt, /RUN BRIEF \(shared by every task in this run\):\nRename map: toCents -> toMinorUnits\./);
    assert.match(prompt, /Spec: docs\/money\.md §2/);
    assert.match(prompt, /Out of scope \(do not touch\):\n- the billing adapter/);
    assert.match(prompt, /Notes from the planner:\n- keep deprecated aliases/);
  });
});
