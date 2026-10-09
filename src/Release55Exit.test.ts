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
 * Release 5.5's exit test. One real factory run, one task, a scripted worker
 * that hands in four bad attempts before a clean one. Each bad attempt must be
 * stopped by a different 5.5 check, no attempt may reach a merge, every retry
 * must carry a retry brief, and the clean attempt must merge.
 *
 *   1. cites a line that does not exist        → honesty tags (fabricated_claim)
 *   2. reports acceptance work as not done     → binding "not done" list
 *   3. adds a line the project forbids         → project rules scan
 *   4. reformats the whole file around a fix   → reformat gate
 *   5. clean                                   → merged
 */
type Turn = (request: ChatRequest) => ChatReply;
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: args } });

function scriptedTransport(turns: Turn[]): ChatTransport & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: 'scripted', name: 'Scripted Worker', label: 'Scripted', limits: { toolOutput: 8000, fileRead: 32000 }, prompts,
    contextWindow: () => 32000, timeoutMs: () => 10000,
    checkAvailability: async () => ({ reachable: true, modelPresent: true, installed: ['fake'] }),
    unreachable: () => 'unreachable', missingModel: () => 'missing',
    chat: async request => {
      if (request.messages.length === 1 && /probe\.txt/.test(request.messages[0].content)) {
        return { content: '', toolCalls: [call('probe', 'read_file', { filepath: 'probe.txt' })] };
      }
      if (request.messages[0].role === 'system' && request.messages.length === 2) prompts.push(request.messages[1].content);
      const turn = turns.shift();
      if (!turn) return { content: '', toolCalls: [call('end', 'finish_task', { summary: 'nothing left', test_summary: 'none', status: 'failure' })] };
      return turn(request);
    },
  };
}

// A file long enough that reformatting it is unmistakable.
const helpers = Array.from({ length: 100 }, (_, i) => `export function helper${i}(a: number, b: number) { return a + b + ${i}; }`).join('\n');
const original = `export const greet = () => 'hello';\n${helpers}\n`;
const withFarewell = original.replace("export const greet = () => 'hello';", "export const greet = () => 'hello';\nexport const farewell = () => 'bye';");
const reformatted = withFarewell.split('\n').map(line => line.replace(/^export function (helper\d+)\(a: number, b: number\) \{ return (.*); \}$/, 'export function $1(\n  a: number,\n  b: number,\n) {\n  return $2;\n}')).join('\n');

const edit = (id: string, from: string, to: string): Turn => () => ({ content: '', toolCalls: [call(id, 'replace_content', { filepath: 'app.ts', target_content: from, replacement_content: to })] });
const write = (id: string, content: string): Turn => () => ({ content: '', toolCalls: [call(id, 'write_file', { filepath: 'app.ts', content })] });
const finish = (id: string, extra: Record<string, unknown> = {}): Turn => () => ({ content: '', toolCalls: [call(id, 'finish_task', { summary: 'Added farewell()', test_summary: 'grep passes', status: 'success', ...extra })] });

const blueprint = {
  feature: 'Farewell greeting',
  requirements_covered: [],
  tasks: [{
    id: 'T1', title: 'Add a farewell function', description: 'Export a farewell() function next to greet() in app.ts.',
    agent_role: 'coder' as const, phase: 1, dependencies: [], blockedBy: [], files_hint: ['app.ts'], creates_files: [],
    acceptance_criteria: ['app.ts exports farewell'], verification: ['grep farewell app.ts'], verification_command: 'grep farewell app.ts',
    production_targets: [], test_targets: [], behavior_tags: [], executor: 'agent' as const, review_questions: [],
  }],
};

describe('release 5.5 exit test: a bad handoff is stopped by the new checks, one after another', () => {
  it('rejects four differently bad attempts without merging any, retries with a brief, and merges the clean fifth', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-exit-'));
    const git = (...args: string[]) => execa('git', args, { cwd: dir });
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'factory@example.test');
    await git('config', 'user.name', 'factory');
    await fs.writeFile(path.join(dir, 'app.ts'), original);
    await git('add', '.');
    await git('commit', '-q', '-m', 'init');
    await fs.mkdir(path.join(dir, '.softfactory'), { recursive: true });
    await fs.writeFile(path.join(dir, '.softfactory', 'non-negotiables.txt'), '# project rules\nconsole\\.log :: no console output in library code\n');

    const transport = scriptedTransport([
      // 1: the change is right, the citation is invented.
      edit('a1', "export const greet = () => 'hello';", "export const greet = () => 'hello';\nexport const farewell = () => 'bye';"),
      finish('f1', { claims: [{ text: 'farewell is exported', source: 'app.ts:999' }] }),
      // 2: says the acceptance work is not finished.
      edit('a2', "export const farewell = () => 'bye';", "export const farewell = () => 'bye'; // says goodbye"),
      finish('f2', { not_done: ['farewell is not exported from app.ts yet'] }),
      // 3: adds what the project forbids.
      edit('a3', '// says goodbye', "// says goodbye\nconsole.log('debug');"),
      finish('f3'),
      // 4: removes it, but reformats the whole file.
      write('a4', reformatted),
      finish('f4'),
      // 5: clean.
      write('a5', withFarewell),
      finish('f5', { claims: [{ text: 'farewell is exported', source: 'app.ts:2' }] }),
    ]);

    const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none', useDocker: false, plannerProvider: 'local' });
    const logs: string[] = [];
    factory.on('log', (line: string) => logs.push(line));
    factory.planner = { provider: 'local', generateBlueprint: async () => blueprint, refineBlueprint: async () => blueprint };
    await factory.init();
    factory.workerRegistry.preflight = async () => ({ local: true, cloud: false, localModel: 'fake', cloudModel: '' });
    factory.workerRegistry.resolveWorker = async () => ({ worker: new ToolLoopWorker(transport, 'fake'), model: 'fake', provider: 'scripted' });
    factory.inspector.synthesizeMemory = async () => '';
    try {
      await factory.build('add a farewell function');

      const rejected = logs.filter(l => /^REJECTED: T1/.test(l));
      assert.equal(rejected.length, 4, logs.join('\n'));
      assert.match(rejected[0], /cites sources that do not exist/);
      assert.match(rejected[1], /reported acceptance work as not done/);
      assert.match(rejected[2], /breaks project rule "no console output in library code" in app\.ts/);
      assert.match(rejected[3], /reformats code it did not need to change: app\.ts/);

      const categories = (await fs.readFile(path.join(dir, '.softfactory', 'attempts.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l).category);
      for (const category of ['fabricated_claim', 'reported_not_done', 'project_rule', 'unrelated_reformat']) assert.ok(categories.includes(category), `${category} in ${categories}`);

      assert.equal(factory.state.status, 'completed', logs.join('\n'));
      assert.equal(factory.state.tasks[0].attempts, 4, 'four rejections, merged on the fifth attempt');
      const merged = await fs.readFile(path.join(dir, 'app.ts'), 'utf8');
      assert.equal(merged, withFarewell, 'only the clean change reached main');
      assert.doesNotMatch(merged, /console\.log/);

      assert.equal(transport.prompts.length, 5);
      assert.doesNotMatch(transport.prompts[0], /RETRY BRIEF/);
      for (const prompt of transport.prompts.slice(1)) assert.match(prompt, /RETRY BRIEF/);
      assert.match(transport.prompts[1], /Do not cite a file line you have not read/);
      assert.match(transport.prompts[4], /Do not report the acceptance work as unfinished/);
      assert.match(transport.prompts[4], /app\.ts:\n  export const greet/, 'the brief carries the file\'s real signatures');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
