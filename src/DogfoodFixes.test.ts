import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ToolLoopWorker } from './ToolLoopWorker.js';
import { requirementSection } from './IWorker.js';
import { TaskSchema } from './types.js';
import type { ChatTransport, ChatRequest, ChatReply, ToolCall } from './ChatTransport.js';

/** What the first run of softfactory on its own repository taught: see the 5.3.0 notes. */

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-dogfood-'));
  for (let i = 1; i <= files; i++) await fs.writeFile(path.join(dir, `f${i}.ts`), `export const v${i} = ${i};\n`);
  return dir;
}

describe('the worker sees the requirement, not only the planner\'s paraphrase', () => {
  it('puts the verbatim requirement and the acceptance criteria in the first user message', async () => {
    const sample = '{"event":"result","result":{"status":"SUCCESS","usage":{"input_tokens":11878}}}';
    const transport = scripted([]);
    await new ToolLoopWorker(transport, 'fake').execute(task, await worktree(1), { requirement: `Switch to stream-json. Sample line:\n${sample}` });
    const first = transport.requests.find(r => r.messages[0].role === 'system')!;
    const user = first.messages[1].content;
    assert.match(user, /Acceptance criteria:\n- parseAgyEvent returns typed events/);
    assert.match(user, /Verification:\n- npm run build/);
    assert.ok(user.includes(`FEATURE REQUIREMENT (verbatim from the user`), user);
    assert.ok(user.includes(sample), 'the sample data survives verbatim');
  });

  it('bounds the requirement so a long brief cannot crowd out the task', () => {
    assert.equal(requirementSection(undefined), '');
    assert.equal(requirementSection('   '), '');
    const section = requirementSection('x'.repeat(10_000), 6000);
    assert.ok(section.length < 6400, String(section.length));
    assert.match(section, /…\(truncated; the task description above carries the rest\)/);
    assert.equal(requirementSection('short').includes('truncated'), false);
  });
});

describe('a worker that only reads is nudged before it is stopped', () => {
  const editTask = TaskSchema.parse({ ...task, files_hint: ['f1.ts'], creates_files: [] });

  async function readOnly(t: typeof task, reads: (i: number) => string, turnsCount: number, dir: string) {
    const seen: string[] = [];
    const turns = Array.from({ length: turnsCount }, (_, i) => (request: ChatRequest) => {
      const last = request.messages[request.messages.length - 1];
      if (last.role === 'tool') seen.push(last.content);
      return { content: '', toolCalls: [call(`r${i}`, 'read_file', { filepath: reads(i) })] };
    });
    const output: string[] = [];
    const handoff = await new ToolLoopWorker(scripted(turns), 'fake').execute(t, dir, { onOutput: line => output.push(line) });
    return { seen, output, handoff };
  }

  it('appends the nudge at the warn call, and aborts once re-reading stops adding code', async () => {
    const dir = await worktree(4);
    const limits = await ToolLoopWorker.progressLimits(dir, ['f1.ts']);
    // A 4-file cycle: the four first reads each raise the limit by one; the rest do not.
    const { seen, output, handoff } = await readOnly(editTask, i => `f${(i % 4) + 1}.ts`, 40, dir);
    const nudged = seen.findIndex(content => content.includes('[orchestrator]'));
    assert.equal(nudged + 1, limits.warn, `nudge on call ${limits.warn}, got ${nudged + 1}`);
    assert.match(seen[nudged], new RegExp(`${limits.warn} tool calls and no file changed yet. You have enough context`));
    assert.equal(seen.slice(0, nudged).some(c => c.includes('[orchestrator]')), false, 'no nudge before that');
    assert.equal(handoff.status, 'failure');
    assert.match(handoff.summary ?? '', new RegExp(`${limits.abort + 4} tool calls without a single successful edit`));
    assert.ok(output.some(l => new RegExp(`Aborting: ${limits.abort + 4} tool calls with no successful edit \\(limit ${limits.abort + 4}\\)`).test(l)), output.join('\n'));
    assert.ok(output.some(l => /nudged/.test(l)));
  });

  it('a create task reading new code is not stopped before its first edit (#75)', async () => {
    const dir = await worktree(1);
    await fs.writeFile(path.join(dir, 'big.ts'), Array.from({ length: 3000 }, (_, i) => `export const l${i} = ${i};`).join('\n'));
    const turns = [
      ...Array.from({ length: 16 }, (_, i) => () => ({ content: '', toolCalls: [call(`r${i}`, 'read_file', { filepath: 'big.ts', start_line: 1 + i * 200, end_line: 200 + i * 200 })] })),
      () => ({ content: '', toolCalls: [call('w', 'write_file', { filepath: 'src/AgyStream.ts', content: 'export const parseAgyEvent = (line: string) => JSON.parse(line);\n' })] }),
    ];
    const output: string[] = [];
    await new ToolLoopWorker(scripted(turns), 'fake').execute(task, dir, { onOutput: line => output.push(line) });
    assert.equal(output.some(l => /Aborting/.test(l)), false, output.join('\n'));
    assert.match(await fs.readFile(path.join(dir, 'src', 'AgyStream.ts'), 'utf8'), /parseAgyEvent/);
  });

  it('a create task\'s nudge names the file to write, and a cycle over the same files still ends', async () => {
    const dir = await worktree(4);
    const { seen, output } = await readOnly(task, i => `f${(i % 4) + 1}.ts`, 40, dir);
    const nudge = seen.find(content => content.includes('[orchestrator]'));
    assert.match(nudge ?? '', /Write src\/AgyStream\.ts now with write_file: the exports the task names/);
    assert.ok(output.some(l => /Aborting: 24 tool calls with no successful edit \(limit 24\)/.test(l)), output.join('\n'));
  });
});

describe('the sandbox makes whole-suite runs slow, so scope and timeouts must be right', () => {
  it('lets a worker ask for up to ten minutes, defaulting to two', () => {
    assert.equal(ToolLoopWorker.commandTimeoutMs(undefined), 120_000);
    assert.equal(ToolLoopWorker.commandTimeoutMs('abc'), 120_000);
    assert.equal(ToolLoopWorker.commandTimeoutMs(600), 600_000);
    assert.equal(ToolLoopWorker.commandTimeoutMs(5000), 600_000);
    assert.equal(ToolLoopWorker.commandTimeoutMs(1), 5_000);
  });

  it('counts node:test TAP output, where the Go pattern used to count five "ok" lines', async () => {
    const { TaskVerifier } = await import('./TaskVerifier.js');
    const tap = ['TAP version 13', '# Subtest: /w/src/a.test.ts', 'ok 1 - /w/src/a.test.ts', '# Subtest: /w/src/b.test.ts', 'not ok 2 - /w/src/b.test.ts', '1..2', '# tests 400', '# suites 124', '# pass 398', '# fail 2', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 302000'].join('\n');
    assert.deepEqual(new TaskVerifier().parseCounts(tap), { filesFailed: 1, filesPassed: 1, testsFailed: 2, testsPassed: 398 });
  });

  it('scopes verification to the test neighbour of a file the task creates', async () => {
    const { TaskVerifier } = await import('./TaskVerifier.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-scope-'));
    await fs.mkdir(path.join(dir, 'src'));
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --import tsx --test src/*.test.ts' } }));
    await fs.writeFile(path.join(dir, 'src', 'AgyStream.test.ts'), '');
    await fs.writeFile(path.join(dir, 'src', 'Other.test.ts'), '');
    const calls: string[][] = [];
    const runner = { kind: 'host', describe: () => 'fake', exec: async (file: string, args: string[]) => { calls.push([file, ...args]); return { stdout: 'ok', stderr: '', exitCode: 0 }; } };
    const sandbox: any = { runnerFor: async () => runner, active: true };
    const created = { id: 'T2', files_hint: ['src/AgyWorker.ts'], creates_files: ['src/AgyStream.ts'], attempts: 0 } as any;
    await new TaskVerifier(sandbox).verify(dir, created);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['node', '--import', 'tsx', '--test', 'src/AgyStream.test.ts'], 'the script\'s own glob is gone, or the whole suite runs');
  });

  it('rebuilds a node:test script around the scope and leaves other runners to npm', async () => {
    const { TaskVerifier } = await import('./TaskVerifier.js');
    const v = new TaskVerifier();
    assert.deepEqual(v.testRunnerArgs('node --import tsx --test src/*.test.ts', false, ['src/a.test.ts']), { binary: 'node', args: ['--import', 'tsx', '--test', 'src/a.test.ts'] });
    assert.deepEqual(v.testRunnerArgs('node --test --test-reporter dot --experimental-strip-types test/', false, ['test/b.spec.mjs']), { binary: 'node', args: ['--test', '--test-reporter', 'dot', '--experimental-strip-types', 'test/b.spec.mjs'] });
    assert.deepEqual(v.testRunnerArgs('node --import tsx --test src/*.test.ts', false, ['src']), { binary: 'npm', args: ['test'] }, 'a directory scope is the whole suite: node --test <dir> finds nothing on Node 20');
    assert.deepEqual(v.testRunnerArgs('node --import tsx --test src/*.test.ts', false, []), { binary: 'npm', args: ['test'] });
    assert.deepEqual(v.testRunnerArgs('jest --ci', false, ['src/a.test.ts']), { binary: 'npm', args: ['test', '--', 'src/a.test.ts'] });
    assert.deepEqual(v.testRunnerArgs('vitest', false, ['src/a.test.ts']), { binary: 'npm', args: ['test', '--', '--run', 'src/a.test.ts'] });
  });
});

describe('what the first pull-request run surfaced', () => {
  it('a retry survives a stale worktree directory left by an interrupted attempt', async () => {
    const { execa } = await import('execa');
    const { WorktreeManager } = await import('./WorktreeManager.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-stale-'));
    const git = (...args: string[]) => execa('git', args, { cwd: dir });
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'f@example.test');
    await git('config', 'user.name', 'f');
    await fs.writeFile(path.join(dir, 'a.txt'), 'a\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'init');
    const stale = path.join(dir, '.git', 'softfactory-worktrees', 'T9');
    await fs.mkdir(stale, { recursive: true });
    await fs.writeFile(path.join(stale, 'leftover.txt'), 'from an interrupted attempt\n');
    const worktree = await new WorktreeManager(dir).create('T9', 'line/T9');
    assert.equal(worktree, stale);
    await assert.rejects(fs.access(path.join(stale, 'leftover.txt')), 'the stale contents are gone');
    assert.match(await fs.readFile(path.join(stale, 'a.txt'), 'utf8'), /^a$/m);
  });

  it('never overwrites an evidence log the journal already hashed', async () => {
    const { TaskVerifier } = await import('./TaskVerifier.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-evid-'));
    const runner = { kind: 'host', describe: () => 'fake', exec: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) };
    const verifier = new TaskVerifier({ runnerFor: async () => runner, active: true } as any);
    const task = { id: 'T1', verification_command: 'grep x a.ts', attempts: 0 };
    const first = await verifier.runAcceptance(dir, task, { evidenceDir: path.join(dir, 'ev') });
    const second = await verifier.runAcceptance(dir, task, { evidenceDir: path.join(dir, 'ev') });
    assert.equal(path.basename(first.evidencePath!), 'T1-attempt1.log');
    assert.equal(path.basename(second.evidencePath!), 'T1-attempt1-2.log');
  });

  it('reports a test writer\'s red acceptance as expected, not as PASS', async () => {
    const { buildPullRequestBody } = await import('./PullRequest.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-prbody-'));
    await fs.mkdir(path.join(dir, 'ev'), { recursive: true });
    await fs.writeFile(path.join(dir, 'ev', 'T1-attempt1.log'), 'command: node --test x\n# fail 1\nRESULT: FAIL\n');
    await fs.writeFile(path.join(dir, 'ev', 'T2-attempt1.log'), 'command: node --test x\nRESULT: PASS\n');
    const state: any = {
      feature: 'Relay', feature_id: 'f-2', brief: '', status: 'completed', strategy: 'cloud', cloud_provider: 'deepseek', planner_provider: 'deepseek', integration_branch: 'softfactory/f-2',
      tasks: [
        { id: 'T1', title: 'Tests first', status: 'done', attempts: 0, executor: 'agent', agent_role: 'test_writer', inspection: 'model', inspector_model: 'deepseek+qwen', verification_command: 'node --test x', evidence: 'ev/T1-attempt1.log' },
        { id: 'T2', title: 'Then the code', status: 'done', attempts: 0, executor: 'agent', agent_role: 'coder', inspection: 'model', inspector_model: 'deepseek+qwen', verification_command: 'node --test x', evidence: 'ev/T2-attempt1.log' },
      ],
    };
    const body = await buildPullRequestBody({ state, baseDir: dir, baseBranch: 'master', sandbox: 's', generator: 'softfactory test' });
    assert.match(body, /\| T1 \| Tests first \| done \| 0 \| [^|]+ \| `node --test x` red, as expected before the implementation \|/);
    assert.match(body, /\| T2 \| Then the code \| done \| 0 \| [^|]+ \| `node --test x` PASS \|/);
  });
});

describe('a merge refused by the user\'s checkout is not the task\'s failure', () => {
  it('recognises git\'s working-tree refusals and nothing else', async () => {
    const { WorktreeManager } = await import('./WorktreeManager.js');
    const refusal = 'error: Your local changes to the following files would be overwritten by merge:\n\tsrc/AgyWorker.ts\n\tsrc/IWorker.ts\nPlease commit your changes or stash them before you merge.\nAborting\n';
    assert.equal(WorktreeManager.mergeBlockedByWorkingTree(refusal), 'uncommitted changes in src/AgyWorker.ts, src/IWorker.ts');
    assert.equal(WorktreeManager.mergeBlockedByWorkingTree('error: The following untracked working tree files would be overwritten by merge:\n\tsrc/New.ts\nPlease move or remove them before you merge.\nAborting'), 'untracked files in the way: src/New.ts');
    assert.equal(WorktreeManager.mergeBlockedByWorkingTree('CONFLICT (content): Merge conflict in src/a.ts\nAutomatic merge failed; fix conflicts and then commit the result.'), null);
  });

  it('lists the tracked files a preflight should warn about', async () => {
    const { execa } = await import('execa');
    const { WorktreeManager } = await import('./WorktreeManager.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-dirty-'));
    const git = (...args: string[]) => execa('git', args, { cwd: dir });
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'f@example.test');
    await git('config', 'user.name', 'f');
    await fs.writeFile(path.join(dir, 'a.txt'), 'a\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'init');
    const manager = new WorktreeManager(dir);
    assert.deepEqual(await manager.uncommittedTrackedFiles(), []);
    await fs.writeFile(path.join(dir, 'a.txt'), 'changed\n');
    await fs.writeFile(path.join(dir, 'untracked.txt'), 'new\n');
    assert.deepEqual(await manager.uncommittedTrackedFiles(), ['a.txt'], 'untracked files do not block a merge of other paths');
  });
});

describe('the final gate reads tallies, not only its heuristic', () => {
  it('treats a run no worse than the baseline as pre-existing red, and recognises a node:test tally', async () => {
    const { Factory } = await import('./Factory.js');
    const factory: any = new Factory('/tmp', '', { strategy: 'cloud', cloudProvider: 'deepseek', cloudModel: 'd', sandbox: 'none' });
    factory.baseline = { filesFailed: 0, filesPassed: 0, testsFailed: 3, testsPassed: 387 };
    assert.equal(factory.noWorseThanBaseline({ counts: { filesFailed: 0, filesPassed: 0, testsFailed: 2, testsPassed: 405 } }), true, 'fewer failures, more passes');
    assert.equal(factory.noWorseThanBaseline({ counts: { filesFailed: 0, filesPassed: 0, testsFailed: 4, testsPassed: 405 } }), false, 'one new failure');
    assert.equal(factory.noWorseThanBaseline({ counts: undefined }), false, 'no tally, no claim');
    assert.equal(factory.wasAlreadyFailing({ testSummary: 'npm test failure', output: 'TAP version 13\nnot ok 6 - x\n# tests 407\n# pass 405\n# fail 2\n' }), true);
    assert.equal(factory.wasAlreadyFailing({ testSummary: 'npm test failure', output: 'TAP version 13\n# tests 2\n# pass 0\n# fail 2\nError [TransformError]: esbuild' }), false, 'a suite that cannot start');
  });
});

describe('a backend that refuses to work is the environment, not the task', () => {
  it('recognises usage and rate limits, and nothing else', async () => {
    const { backendRefusal } = await import('./IWorker.js');
    assert.equal(backendRefusal("OpenAI Codex v0.153.4\nERROR: You've hit your usage limit. Upgrade to Pro or try again at 6:12 PM."), "ERROR: You've hit your usage limit. Upgrade to Pro or try again at 6:12 PM.");
    assert.ok(backendRefusal('{"error":{"type":"rate_limit_error","message":"Too many requests"}}'));
    assert.ok(backendRefusal('HTTP 429 from api.example'));
    assert.equal(backendRefusal('TypeError: x is not a function\n    at run (file.ts:1:1)'), null);
    assert.equal(backendRefusal('Tests failed: 3 of 429 assertions'), null, 'a number inside a word is not a status');
  });

  it('turns a Codex usage-limit exit into an environment fault that consumes no retry', async () => {
    const { CodexWorker } = await import('./CodexWorker.js');
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-fake-codex-'));
    await fs.writeFile(path.join(bin, 'codex'), "#!/bin/sh\necho 'OpenAI Codex v0.153.4'\necho \"ERROR: You've hit your usage limit. Upgrade to Pro, or try again at 6:12 PM.\" >&2\nexit 1\n", { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous}`;
    try {
      const dir = await worktree(0);
      await assert.rejects(new CodexWorker('').execute(task, dir, {}), (error: any) => error.isEnvironmentFailure === true && /refused to work: ERROR: You've hit your usage limit/.test(error.message));
    } finally {
      process.env.PATH = previous;
    }
  });
});
