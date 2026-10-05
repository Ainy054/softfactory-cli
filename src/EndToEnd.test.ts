import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { Factory } from './Factory.js';
import { ToolLoopWorker } from './ToolLoopWorker.js';
import type { ChatRequest, ChatReply, ChatTransport, ToolCall } from './ChatTransport.js';

/**
 * The whole pipeline on a real temporary git repository: plan, worktree, the
 * real tool loop over a scripted transport, commit, verifier, executed
 * acceptance, mechanical review, merge, cleanup, metrics. Only the model is fake.
 */
type Turn = (request: ChatRequest) => ChatReply;

function scriptedTransport(turns: Turn[]): ChatTransport & { requests: ChatRequest[] } {
  let calls = 0;
  const requests: ChatRequest[] = [];
  return {
    id: 'scripted', name: 'Scripted Worker', label: 'Scripted', limits: { toolOutput: 8000, fileRead: 32000 }, requests,
    contextWindow: () => 32000,
    timeoutMs: () => 10000,
    checkAvailability: async () => ({ reachable: true, modelPresent: true, installed: ['fake'] }),
    unreachable: () => 'scripted transport unreachable',
    missingModel: () => 'scripted model missing',
    chat: async request => {
      requests.push(request);
      calls++;
      // The tool-support probe comes first, every attempt.
      if (request.messages.length === 1 && /probe\.txt/.test(request.messages[0].content)) {
        return { content: '', toolCalls: [call('probe', 'read_file', { filepath: 'probe.txt' })] };
      }
      const turn = turns.shift();
      // A model with nothing left to say finishes; the gates decide what that is worth.
      if (!turn) return { content: '', toolCalls: [call(`end${calls}`, 'finish_task', { summary: 'nothing more to do', test_summary: 'none', status: 'failure' })] };
      return turn(request);
    },
  };
}

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: args } });

const blueprint = {
  feature: 'Farewell greeting',
  requirements_covered: ['a farewell function'],
  tasks: [{
    id: 'T1', title: 'Add a farewell function', description: 'Export a farewell() function next to greet() in app.ts.',
    agent_role: 'coder' as const, phase: 1, dependencies: [], blockedBy: [], files_hint: ['app.ts'], creates_files: [],
    acceptance_criteria: ['app.ts exports farewell'], verification: ['grep farewell app.ts'], verification_command: 'grep farewell app.ts',
    production_targets: [], test_targets: [], behavior_tags: [], executor: 'agent' as const, review_questions: [],
  }],
};

async function repository() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-e2e-'));
  const git = (...args: string[]) => execa('git', args, { cwd: dir });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'factory@example.test');
  await git('config', 'user.name', 'factory');
  await fs.writeFile(path.join(dir, 'app.ts'), "export const greet = () => 'hello';\n");
  await fs.writeFile(path.join(dir, 'README.md'), '# demo\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'init');
  return { dir, git };
}

async function factoryOn(dir: string, transport: ChatTransport) {
  const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none', useDocker: false, plannerProvider: 'local' });
  const logs: string[] = [];
  factory.on('log', (line: string) => logs.push(line));
  factory.planner = { provider: 'local', generateBlueprint: async () => blueprint, refineBlueprint: async () => blueprint };
  await factory.init();
  factory.workerRegistry.preflight = async () => ({ local: true, cloud: false, localModel: 'fake', cloudModel: '' });
  factory.workerRegistry.resolveWorker = async () => ({ worker: new ToolLoopWorker(transport, 'fake'), model: 'fake', provider: 'scripted' });
  // The only model call left on the happy path; a live Ollama must not be consulted by a test.
  factory.inspector.synthesizeMemory = async () => '';
  return { factory, logs };
}

describe('end to end: a requirement becomes a merged, evidenced commit', () => {
  it('plans, implements in a worktree, passes every gate, merges, and cleans up', async () => {
    const { dir, git } = await repository();
    const transport = scriptedTransport([
      () => ({ content: 'Reading the file first.', toolCalls: [call('c1', 'read_file', { filepath: 'app.ts' })] }),
      request => {
        const last = request.messages[request.messages.length - 1];
        assert.equal(last.role, 'tool');
        assert.match(last.content, /greet/, 'the model sees the file it asked for');
        return { content: '', toolCalls: [call('c2', 'replace_content', {
          filepath: 'app.ts', target_content: "export const greet = () => 'hello';",
          replacement_content: "export const greet = () => 'hello';\nexport const farewell = () => 'bye';",
        })] };
      },
      () => ({ content: '', toolCalls: [call('c3', 'run_command', { command: 'grep farewell app.ts' })] }),
      request => {
        const last = request.messages[request.messages.length - 1];
        assert.match(last.content, /STDOUT:\s*export const farewell/, 'the command ran in the worktree');
        return { content: '', toolCalls: [call('c4', 'finish_task', { summary: 'Added farewell()', test_summary: 'grep passes', status: 'success' })] };
      },
    ]);
    const { factory, logs } = await factoryOn(dir, transport);
    try {
      await factory.build('add a farewell function');

      assert.equal(factory.state.status, 'completed', logs.join('\n'));
      const task = factory.state.tasks[0];
      assert.equal(task.status, 'done');
      assert.equal(task.attempts, 0, 'first attempt');
      assert.equal(task.inspection, 'mechanical-only', 'a local run records that no model reviewed the diff');
      assert.equal(task.inspector_model, undefined);

      // The merged result on the default branch.
      assert.match(await fs.readFile(path.join(dir, 'app.ts'), 'utf-8'), /export const farewell/);
      const { stdout: head } = await git('log', '-1', '--format=%s');
      assert.equal(head, 'softfactory: merge T1');
      const { stdout: parents } = await git('log', '-1', '--format=%P');
      assert.equal(parents.split(' ').length, 2, 'a --no-ff merge commit');

      // Evidence of the executed acceptance command.
      assert.ok(task.evidence, 'the task records its evidence log');
      const evidence = await fs.readFile(path.join(dir, task.evidence), 'utf-8');
      assert.match(evidence, /grep farewell app\.ts/);
      assert.match(evidence.trim(), /RESULT: PASS$/);

      // The worker's prompt carried the acceptance command, and the probe used one tool.
      const firstTurn = transport.requests.find(r => r.messages[0].role === 'system')!;
      const userPrompt = firstTurn.messages[1].content;
      assert.match(userPrompt, /ACCEPTANCE COMMAND .*grep farewell app\.ts/);
      assert.equal(transport.requests[0].tools.length, 1);

      // Cleanup: no worktree, no line branch, state and metrics on disk.
      await assert.rejects(fs.access(path.join(dir, '.git', 'softfactory-worktrees', 'T1')));
      const { stdout: branches } = await git('branch', '--list', 'line/*');
      assert.equal(branches.trim(), '');
      const state = JSON.parse(await fs.readFile(path.join(dir, '.softfactory', 'factory.json'), 'utf-8'));
      assert.equal(state.status, 'completed');
      const metrics = (await fs.readFile(path.join(dir, '.softfactory', 'metrics.jsonl'), 'utf-8')).trim().split('\n');
      assert.equal(metrics.length, 1);
      assert.equal(JSON.parse(metrics[0]).done, 1);
      const toolCalls = (await fs.readFile(path.join(dir, '.softfactory', 'tool-calls.jsonl'), 'utf-8')).trim().split('\n').map(l => JSON.parse(l).tool);
      assert.deepEqual(toolCalls, ['read_file', 'replace_content', 'run_command', 'finish_task']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the default branch untouched when the worker claims success but the acceptance command fails', async () => {
    const { dir, git } = await repository();
    const transport = scriptedTransport([
      () => ({ content: '', toolCalls: [call('c1', 'replace_content', {
        filepath: 'app.ts', target_content: "export const greet = () => 'hello';",
        replacement_content: "export const greet = () => 'hello';\nexport const goodbye = () => 'bye';",
      })] }),
      () => ({ content: '', toolCalls: [call('c2', 'finish_task', { summary: 'Added farewell()', test_summary: 'all good', status: 'success' })] }),
    ]);
    const { factory, logs } = await factoryOn(dir, transport);
    // Re-planning a blocked task is covered elsewhere; here the question is the gate.
    factory.autoReplanBlockedTasks = async () => {};
    try {
      await factory.build('add a farewell function');

      assert.equal(factory.state.status, 'failed', logs.join('\n'));
      const task = factory.state.tasks[0];
      assert.notEqual(task.status, 'done');
      assert.match(task.error_history[0], /acceptance command failed/);
      assert.match(task.error_history[0], /grep farewell app\.ts/, 'the retry feedback names the command');
      const evidence = await fs.readFile(path.join(dir, '.softfactory', 'evidence', factory.state.feature_id, 'T1-attempt1.log'), 'utf-8');
      assert.match(evidence.trim(), /RESULT: FAIL$/);

      assert.doesNotMatch(await fs.readFile(path.join(dir, 'app.ts'), 'utf-8'), /goodbye/, 'nothing merged');
      const { stdout: head } = await git('log', '-1', '--format=%s');
      assert.equal(head, 'init');
      const { stdout: branches } = await git('branch', '--list', 'line/*');
      assert.equal(branches.trim(), '', 'the failed line branch is removed once retries are exhausted');
      const metrics = JSON.parse((await fs.readFile(path.join(dir, '.softfactory', 'metrics.jsonl'), 'utf-8')).trim());
      assert.equal(metrics.done, 0);
      assert.ok(metrics.rejected_by_category.acceptance >= 1, JSON.stringify(metrics.rejected_by_category));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
