import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { Factory } from './Factory.js';
import { ToolLoopWorker } from './ToolLoopWorker.js';
import type { ChatReply, ChatRequest, ChatTransport, ToolCall } from './ChatTransport.js';

/** Issue #49: orchestrator-owned files arrive as a patch, applied before review. */
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: args } });

const ROUTES = "export const routes = ['health'];\n";
const WIRED = "export const routes = ['health', 'users'];\n";
const patchFor = (file: string) => `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-export const routes = ['health'];\n+export const routes = ['health', 'users'];\n`;

function scripted(turns: ToolCall[], toolResults: string[] = []): ChatTransport {
  return {
    id: 'scripted', name: 'Scripted Worker', label: 'Scripted', limits: { toolOutput: 8000, fileRead: 32000 },
    contextWindow: () => 32000, timeoutMs: () => 10000,
    checkAvailability: async () => ({ reachable: true, modelPresent: true, installed: ['fake'] }),
    unreachable: () => 'u', missingModel: () => 'm',
    chat: async (request: ChatRequest): Promise<ChatReply> => {
      if (request.messages.length === 1 && /probe\.txt/.test(request.messages[0].content)) return { content: '', toolCalls: [call('probe', 'read_file', { filepath: 'probe.txt' })] };
      const last = request.messages[request.messages.length - 1];
      if (last.role === 'tool') toolResults.push(last.content);
      const next = turns.shift();
      return { content: '', toolCalls: [next || call('end', 'finish_task', { summary: 'stop', test_summary: 'none', status: 'failure' })] };
    },
  };
}

async function run(finish: Record<string, unknown>, extraTurns: ToolCall[] = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-wire-'));
  const git = (...args: string[]) => execa('git', args, { cwd: dir });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'f@example.test');
  await git('config', 'user.name', 'f');
  await fs.writeFile(path.join(dir, '.gitignore'), '.softfactory/\n');
  await fs.writeFile(path.join(dir, 'routes.ts'), ROUTES);
  await git('add', '.');
  await git('commit', '-q', '-m', 'init');
  await fs.mkdir(path.join(dir, '.softfactory'));
  await fs.writeFile(path.join(dir, '.softfactory', 'environment.json'), JSON.stringify({ live: 'dev only', orchestrator_files: ['routes.ts'] }));
  const blueprint = { feature: 'Users route', requirements_covered: ['users'], tasks: [{
    id: 'T1', title: 'Add the users handler', description: 'Create users.ts and register it in routes.ts.', agent_role: 'coder' as const, phase: 1,
    dependencies: [], blockedBy: [], files_hint: ['users.ts', 'routes.ts'], creates_files: ['users.ts'], acceptance_criteria: ['users is routed'],
    verification: ['grep users routes.ts'], verification_command: 'grep users routes.ts', production_targets: [], test_targets: [], behavior_tags: [],
    executor: 'agent' as const, review_questions: [],
  }] };
  const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none', useDocker: false, plannerProvider: 'local' });
  const logs: string[] = [];
  factory.on('log', (line: string) => logs.push(line));
  factory.planner = { provider: 'local', generateBlueprint: async () => blueprint, refineBlueprint: async () => blueprint };
  await factory.init();
  const toolResults: string[] = [];
  const turns = () => [...extraTurns, call('w', 'write_file', { filepath: 'users.ts', content: 'export const users = () => [];\n' }), call('f', 'finish_task', { summary: 'users handler', test_summary: 'grep', status: 'success', live_stack_untouched: true, ...finish })];
  factory.workerRegistry.preflight = async () => ({ local: true, cloud: false, localModel: 'fake', cloudModel: '' });
  factory.workerRegistry.resolveWorker = async () => ({ worker: new ToolLoopWorker(scripted(turns(), toolResults), 'fake'), model: 'fake', provider: 'scripted' });
  factory.inspector.synthesizeMemory = async () => '';
  await factory.build('add the users route');
  return { factory, logs, git, dir, toolResults };
}

describe('wire before review', () => {
  it('applies a route registration sent as a patch on the branch, before the acceptance command and review', async () => {
    const { factory, logs, git, dir } = await run({ wiring_patch: patchFor('routes.ts') });
    const text = logs.join('\n');
    assert.match(text, /WIRED: T1 — applied its wiring patch for routes\.ts on the branch before review/);
    assert.ok(text.indexOf('WIRED: T1') < text.indexOf('ACCEPTANCE PASS: T1'), 'wired before the acceptance command ran');
    assert.equal(factory.state.tasks[0].status, 'done', text);
    assert.equal(await fs.readFile(path.join(dir, 'routes.ts'), 'utf8'), WIRED);
    const { stdout } = await git('log', '--format=%s', 'main');
    assert.match(stdout, /softfactory: orchestrator wiring for T1/);
  });

  it('rejects a wiring patch that reaches beyond the owned files', async () => {
    const { logs } = await run({ wiring_patch: patchFor('routes.ts').replaceAll('routes.ts', 'other.ts') });
    assert.ok(logs.some(l => /REJECTED: T1 — wiring_patch may change only orchestrator-owned files; it also changes other\.ts/.test(l)), logs.join('\n'));
  });

  it('refuses a worker write to an owned file and tells it to send a patch', async () => {
    const { toolResults } = await run({ wiring_patch: patchFor('routes.ts') }, [call('bad', 'write_file', { filepath: 'routes.ts', content: WIRED })]);
    assert.ok(toolResults.some(r => /routes\.ts is orchestrator-owned: do not edit it\. Put the exact change in finish_task's wiring_patch/.test(r)), toolResults.join('\n'));
  });
});
