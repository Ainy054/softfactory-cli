import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { Factory } from './Factory.js';
import { ToolLoopWorker } from './ToolLoopWorker.js';
import type { ChatReply, ChatRequest, ChatTransport, ToolCall } from './ChatTransport.js';

/**
 * 6.0 exit gate, as a real run on a temporary repository: a bad merge among
 * four is blamed by bisection, reverted and retried once, and good work
 * stops at TEST without ever deploying to production.
 */
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: args } });

/** Writes the task's files; `bad` tasks plant broken.flag on their first attempt and remove it on a retry. */
function writer(bad: Set<string>): ChatTransport {
  const attempts = new Map<string, number>();
  const pending = new Map<string, ToolCall[]>();
  return {
    id: 'scripted', name: 'Scripted Worker', label: 'Scripted', limits: { toolOutput: 8000, fileRead: 32000 },
    contextWindow: () => 32000, timeoutMs: () => 10000,
    checkAvailability: async () => ({ reachable: true, modelPresent: true, installed: ['fake'] }),
    unreachable: () => 'u', missingModel: () => 'm',
    chat: async (request: ChatRequest): Promise<ChatReply> => {
      if (request.messages.length === 1 && /probe\.txt/.test(request.messages[0].content)) return { content: '', toolCalls: [call('probe', 'read_file', { filepath: 'probe.txt' })] };
      const id = /Write (t\d)\.txt/.exec(request.messages.map(m => m.content).join('\n'))![1].toUpperCase();
      const key = `${id}:${request.messages[1].content.length}`;
      if (!pending.has(key)) {
        const n = (attempts.get(id) || 0) + 1;
        attempts.set(id, n);
        const file = `${id.toLowerCase()}.txt`;
        pending.set(key, [
          // A retry acts on the feedback: the planted file goes, the real one is rewritten.
          ...(bad.has(id) && n > 1 ? [call(`${id}r`, 'run_command', { command: 'git rm -q --ignore-unmatch broken.flag' })] : []),
          call(`${id}w`, 'write_file', { filepath: file, content: `${id} attempt ${n}\n` }),
          ...(bad.has(id) && n === 1 ? [call(`${id}b`, 'write_file', { filepath: 'broken.flag', content: 'oops\n' })] : []),
          call(`${id}f`, 'finish_task', { summary: `wrote ${file}`, test_summary: `ls ${file}`, status: 'success', live_stack_untouched: true }),
        ]);
      }
      const next = pending.get(key)!.shift();
      return next ? { content: '', toolCalls: [next] } : { content: '', toolCalls: [call('end', 'finish_task', { summary: 'done', test_summary: 'none', status: 'success' })] };
    },
  };
}

const task = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `T${n}`, title: `Write t${n}.txt`, description: `Write t${n}.txt containing T${n}.`,
  agent_role: 'coder' as const, phase: 1, dependencies: [], blockedBy: [], files_hint: [`t${n}.txt`, 'broken.flag'], creates_files: [`t${n}.txt`],
  acceptance_criteria: [`t${n}.txt exists`], verification: [`ls t${n}.txt`], verification_command: `ls t${n}.txt`,
  production_targets: [], test_targets: [], behavior_tags: [], executor: 'agent' as const, review_questions: [], ...extra,
});

async function run(options: { bad: string[]; tasks: ReturnType<typeof task>[]; environment?: Record<string, unknown>; protectedPaths?: string[] }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-exit60-'));
  const git = (...args: string[]) => execa('git', args, { cwd: dir });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'factory@example.test');
  await git('config', 'user.name', 'factory');
  await fs.writeFile(path.join(dir, '.gitignore'), '.softfactory/\n');
  await fs.writeFile(path.join(dir, 'README.md'), 'demo\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'init');
  await fs.mkdir(path.join(dir, '.softfactory'));
  await fs.writeFile(path.join(dir, '.softfactory', 'uat.json'), JSON.stringify({ probes: [{ name: 'no broken flag', run: 'test ! -f broken.flag' }] }));
  if (options.protectedPaths) await fs.writeFile(path.join(dir, '.softfactory', 'protected-paths.txt'), `${options.protectedPaths.join('\n')}\n`);
  if (options.environment) await fs.writeFile(path.join(dir, '.softfactory', 'environment.json'), JSON.stringify(options.environment));
  const blueprint = { feature: 'Four files', requirements_covered: ['files'], tasks: options.tasks };
  const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none', useDocker: false, plannerProvider: 'local' });
  const logs: string[] = [];
  factory.on('log', (line: string) => logs.push(line));
  factory.planner = { provider: 'local', generateBlueprint: async () => blueprint, refineBlueprint: async () => blueprint };
  await factory.init();
  const transport = writer(new Set(options.bad));
  factory.workerRegistry.preflight = async () => ({ local: true, cloud: false, localModel: 'fake', cloudModel: '' });
  factory.workerRegistry.resolveWorker = async () => ({ worker: new ToolLoopWorker(transport, 'fake'), model: 'fake', provider: 'scripted' });
  factory.inspector.synthesizeMemory = async () => '';
  // Reviewers are not under test here: live verification is what must catch the planted file.
  factory.frontierInspector.inspectBlind = async () => ({ verdict: 'PASS', feedback: 'ok', provider: 'stub', model: 'stub' });
  const deploys: string[] = [];
  factory.deployShell = async (command: string) => { deploys.push(command); return { exitCode: 0, output: 'deployed' }; };
  await factory.build('write four files');
  return { factory, logs, deploys, dir, git };
}

describe('6.0 exit gate: blame by bisection, work stops at TEST', () => {
  it('blames the second of four merges, retries it once, and holds the run at TEST', async () => {
    const { factory, logs, deploys, dir } = await run({
      bad: ['T2'],
      tasks: [1, 2, 3, 4].map(n => task(n, { promotion: 'test' })),
      environment: { live: 'prod elsewhere', test_env: { name: 'TEST', deploy: './deploy test' }, production: { deploy: './deploy prod' } },
    });
    const text = logs.join('\n');
    assert.match(text, /UAT FAILED: the merged code does not pass live verification/);
    assert.match(text, /UAT bisect: base passes/);
    assert.match(text, /UAT BLAME: T2 — its merge \([0-9a-f]{8}\) breaks live verification; found in 3 bisection UAT run\(s\)/);
    assert.match(text, /reverted the merge of T2; it gets one retry/);
    assert.equal(factory.state.status, 'completed', text);
    const t2 = factory.state.tasks.find((t: any) => t.id === 'T2');
    assert.equal(t2.status, 'done');
    assert.equal(t2.uat_retry_used, true);
    await assert.rejects(fs.access(path.join(dir, 'broken.flag')), 'the retried T2 left no broken flag');
    assert.deepEqual(deploys, ['./deploy test', './deploy test'], 'TEST before each UAT; production never');
    assert.equal(factory.state.promotion?.status, 'pending');
  });

  it('a protected merge is checked live before the rest of its phase, and reverted when it fails', async () => {
    const { factory, logs, dir } = await run({ bad: ['T1'], tasks: [task(1), task(2, { files_hint: ['t2.txt'] }), task(3, { files_hint: ['t3.txt'] })], protectedPaths: ['t1.txt'] });
    const text = logs.join('\n');
    assert.match(text, /Mid-wave UAT: T1 touched a protected path/);
    assert.match(text, /Mid-wave UAT FAIL after T1: its merge was reverted; the rest of the phase merges without it/);
    assert.ok(text.indexOf('Mid-wave UAT FAIL after T1') < text.indexOf('MERGED: T2'), 'checked before T2 merged on top');
    assert.equal(factory.state.status, 'completed', text);
    assert.equal(factory.state.tasks.find((t: any) => t.id === 'T1').status, 'done', 'T1 retried and merged cleanly');
    await assert.rejects(fs.access(path.join(dir, 'broken.flag')));
  });
});
