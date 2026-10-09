import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { Factory } from './Factory.js';
import { ToolLoopWorker } from './ToolLoopWorker.js';
import { formatPlan } from './PlanApproval.js';
import type { ChatRequest, ChatReply, ChatTransport, ToolCall } from './ChatTransport.js';

/**
 * Release 5.6's exit test. One real factory run of a rename:
 *   1. the planner's first draft lists the definition and one caller, and
 *      misses a second caller the repository search finds;
 *   2. the plan check rejects it and the planner receives the reason;
 *   3. the corrected plan lists every caller and is shown for approval;
 *   4. approved, the rename runs and merges, and no old name is left.
 */
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: args } });

const files = {
  'src/money.ts': 'export function toCents(x: number) { return Math.round(x * 100); }\n',
  'src/cart.ts': "import { toCents } from './money.js';\nexport const total = (x: number) => toCents(x);\n",
  'src/adapter.ts': "import { toCents } from './money.js';\nexport const fee = () => toCents(0.3);\n",
};
const renamed = Object.fromEntries(Object.entries(files).map(([f, c]) => [f, c.replaceAll('toCents', 'toMinorUnits')]));

const task = (filesHint: string[]) => ({
  id: 'T1', title: 'Rename toCents to toMinorUnits', description: 'Rename `toCents` to `toMinorUnits` in the definition and every caller.',
  agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [], files_hint: filesHint, creates_files: [],
  acceptance_criteria: ['no file uses toCents'], verification: ['grep -c toMinorUnits src/money.ts'], verification_command: 'grep -c toMinorUnits src/money.ts',
  production_targets: [], test_targets: [], behavior_tags: [], executor: 'agent', review_questions: [],
});

describe('release 5.6 exit test: a rename plan is completed by the repository search and approved before it runs', () => {
  it('rejects the plan that misses a caller, re-plans with the reason, asks for approval, then renames everything', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-exit56-'));
    const git = (...args: string[]) => execa('git', args, { cwd: dir });
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'factory@example.test');
    await git('config', 'user.name', 'factory');
    for (const [file, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await fs.writeFile(path.join(dir, file), content);
    }
    await git('add', '.');
    await git('commit', '-q', '-m', 'init');

    const plannerInputs: string[] = [];
    const planner = {
      provider: 'local',
      generateBlueprint: async (input: any) => {
        plannerInputs.push(input.requirement);
        const complete = /PLANNER FEEDBACK/.test(input.requirement);
        return { feature: 'Minor units rename', requirements_covered: [], tasks: [task(complete ? Object.keys(files) : ['src/money.ts', 'src/cart.ts'])] };
      },
      refineBlueprint: async () => { throw new Error('not used'); },
    };

    const shown: string[] = [];
    const turns: Array<(r: ChatRequest) => ChatReply> = [
      ...Object.entries(renamed).map(([file, content], i) => () => ({ content: '', toolCalls: [call(`w${i}`, 'write_file', { filepath: file, content })] })),
      () => ({ content: '', toolCalls: [call('done', 'finish_task', { summary: 'Renamed toCents to toMinorUnits everywhere', test_summary: 'grep passes', status: 'success', claims: [{ text: 'definition renamed', source: 'src/money.ts:1' }] })] }),
    ];
    const transport: ChatTransport = {
      id: 's', name: 's', label: 'S', limits: { toolOutput: 8000, fileRead: 32000 }, contextWindow: () => 32000, timeoutMs: () => 10000,
      checkAvailability: async () => ({ reachable: true, modelPresent: true, installed: ['m'] }), unreachable: () => '', missingModel: () => '',
      chat: async request => {
        if (request.messages.length === 1 && /probe\.txt/.test(request.messages[0].content)) return { content: '', toolCalls: [call('p', 'read_file', { filepath: 'probe.txt' })] };
        const turn = turns.shift();
        return turn ? turn(request) : { content: '', toolCalls: [call('end', 'finish_task', { summary: 'nothing left', test_summary: 'none', status: 'failure' })] };
      },
    };

    const factory: any = new Factory(dir, '', {
      strategy: 'local', sandbox: 'none', useDocker: false, plannerProvider: 'local',
      approvePlan: async state => { shown.push(formatPlan(state).join('\n')); return 'approve'; },
    });
    const logs: string[] = [];
    factory.on('log', (line: string) => logs.push(line));
    factory.planner = planner;
    await factory.init();
    factory.workerRegistry.preflight = async () => ({ local: true, cloud: false, localModel: 'm', cloudModel: '' });
    factory.workerRegistry.resolveWorker = async () => ({ worker: new ToolLoopWorker(transport, 'm'), model: 'm', provider: 'scripted' });
    factory.inspector.synthesizeMemory = async () => '';
    try {
      await factory.build('Rename toCents to toMinorUnits');

      assert.equal(plannerInputs.length, 2, 'planned twice');
      assert.ok(logs.some(l => /Planning check: T1 changes `toCents`, but these files use it and no task lists them: src\/adapter\.ts/.test(l)), logs.join('\n'));
      assert.match(plannerInputs[1], /PLANNER FEEDBACK: the previous plan was rejected for these reasons:\n- T1 changes `toCents`, but these files use it and no task lists them: src\/adapter\.ts/);

      assert.equal(shown.length, 1, 'approval asked once, for the corrected plan');
      assert.match(shown[0], /files: src\/money\.ts, src\/cart\.ts, src\/adapter\.ts/);
      assert.ok(logs.includes('Plan approved.'));

      assert.equal(factory.state.status, 'completed', logs.join('\n'));
      for (const [file, content] of Object.entries(renamed)) assert.equal(await fs.readFile(path.join(dir, file), 'utf8'), content, file);
      const leftover = await execa('git', ['grep', '-l', 'toCents'], { cwd: dir, reject: false });
      assert.equal(leftover.exitCode, 1, `no file still uses the old name: ${leftover.stdout}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
