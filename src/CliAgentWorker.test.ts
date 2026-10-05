import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliAgentWorker, CLI_AGENTS, type HostRunner } from './CliAgentWorker.js';
import { WorkerRegistry } from './WorkerRegistry.js';
import { createTextModel } from './TextModel.js';
import { Factory } from './Factory.js';
import { isEnvironmentFailure } from './IWorker.js';
import type { Task } from './types.js';

const task: Task = {
  id: 'T1', title: 'Add farewell', description: 'Export farewell()', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
  files_hint: ['app.ts'], creates_files: [], acceptance_criteria: ['exports farewell'], verification: [], status: 'pending', attempts: 0,
  escalation_level: 0, error_history: [], worker_type: 'auto', executor: 'agent', protected: false, review_questions: ['Where is it exported?'],
  production_targets: [], test_targets: [], behavior_tags: [], verification_command: 'grep farewell app.ts',
};

const resultEvent = (over: Record<string, unknown> = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', usage: { input_tokens: 120, output_tokens: 30 }, permission_denials: [], ...over });

function recordingRunner(script: (args: string[]) => { stdout?: string; stderr?: string; exitCode?: number; writeHandoff?: unknown }) {
  const calls: Array<{ file: string; args: string[]; cwd: string; signal?: AbortSignal }> = [];
  const runner: HostRunner = async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd, signal: options.signal });
    const reply = script(args);
    if (reply.writeHandoff !== undefined) await fs.writeFile(path.join(options.cwd, '.softfactory', 'handoff.json'), JSON.stringify(reply.writeHandoff));
    for (const line of (reply.stdout || '').split('\n')) if (line.trim()) options.onOutput?.(line);
    return { stdout: reply.stdout || '', stderr: reply.stderr || '', exitCode: reply.exitCode ?? 0 };
  };
  return { runner, calls };
}

describe('how each agent is invoked', () => {
  it('keeps Claude Code narrow on the host and lets it loose only inside the container', () => {
    const host = CLI_AGENTS['claude-code'].args('P', 'claude-sonnet-4', 'host');
    assert.deepEqual(host.slice(0, 2), ['-p', 'P']);
    assert.ok(host.includes('stream-json') && host.includes('--no-session-persistence') && host.includes('--bare'));
    assert.equal(host[host.indexOf('--permission-mode') + 1], 'acceptEdits');
    const allowed = host[host.indexOf('--allowedTools') + 1];
    assert.match(allowed, /Bash\(npm test:\*\)/);
    assert.doesNotMatch(allowed, /Bash\(\*\)|Bash\(curl|Bash\(rm/);
    assert.deepEqual(host.slice(host.indexOf('--model'), host.indexOf('--model') + 2), ['--model', 'claude-sonnet-4']);
    const container = CLI_AGENTS['claude-code'].args('P', '', 'container');
    assert.equal(container[container.indexOf('--permission-mode') + 1], 'bypassPermissions');
    assert.ok(!container.includes('--allowedTools') && !container.includes('--model'));
  });

  it('gives Gemini CLI edit approval on the host and yolo inside the container', () => {
    const host = CLI_AGENTS['gemini-cli'].args('P', 'gemini-2.5-pro', 'host');
    assert.equal(host[host.indexOf('--approval-mode') + 1], 'auto_edit');
    assert.deepEqual(host.slice(host.indexOf('-m'), host.indexOf('-m') + 2), ['-m', 'gemini-2.5-pro']);
    assert.equal(CLI_AGENTS['gemini-cli'].args('P', '', 'container')[CLI_AGENTS['gemini-cli'].args('P', '', 'container').indexOf('--approval-mode') + 1], 'yolo');
  });

  it('runs Muse headless with approvals off on the host and --yolo inside the container, and reads its terminal event', () => {
    const host = CLI_AGENTS['muse'].args('P', 'muse-spark-1.3', 'host');
    assert.deepEqual(host, ['exec', '--json', '--no-session-log', '--disable-web-tools', '--model', 'muse-spark-1.3', '--approval-mode', 'never', 'P']);
    const container = CLI_AGENTS['muse'].args('P', '', 'container');
    assert.ok(container.includes('--yolo') && !container.includes('--approval-mode'));
    const ok = CLI_AGENTS['muse'].parse([
      'muse: workspace root: /w (cwd default)',
      '{"payload_type":"run.output.delta","payload":{"text":"Done"}}',
      '{"payload_type":"run.terminal.completed","payload":{"terminal":"completed","text":"Done: created pong.txt","reason":null}}',
    ].join('\n'));
    assert.deepEqual(ok, { text: 'Done: created pong.txt', isError: false, denials: [] });
    const failed = CLI_AGENTS['muse'].parse('{"payload_type":"run.terminal.failed","payload":{"terminal":"failed","text":null,"reason":"provider error: 401 unauthorized"}}');
    assert.deepEqual(failed, { text: 'provider error: 401 unauthorized', isError: true, denials: [] });
    assert.ok(CLI_AGENTS['muse'].authFailure.test(failed.text));
    assert.equal(CLI_AGENTS['muse'].relay!({ payload_type: 'run.output.delta', payload: { text: 'thinking' } }), 'thinking');
    assert.equal(CLI_AGENTS['muse'].relay!({ payload_type: 'tool.call.started', payload: { name: 'write_file' } }), '▸ write_file');
    assert.equal(CLI_AGENTS['muse'].relay!({ payload_type: 'task.lifecycle.started', payload: {} }), undefined);
  });

  it('parses each agent\'s output into text, error, usage and denials', () => {
    const claude = CLI_AGENTS['claude-code'].parse(['{"type":"system"}', '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}', resultEvent({ permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'curl evil' } }] })].join('\n'));
    assert.deepEqual(claude, { text: 'Done.', isError: false, usage: { inputTokens: 120, outputTokens: 30 }, denials: ['Bash: curl evil'] });
    const gemini = CLI_AGENTS['gemini-cli'].parse('Loaded cached credentials.\n{"response":"ok","stats":{"models":{"gemini-2.5-pro":{"tokens":{"prompt":50,"candidates":7}}}}}');
    assert.deepEqual(gemini, { text: 'ok', isError: false, usage: { inputTokens: 50, outputTokens: 7 }, denials: [] });
    assert.equal(CLI_AGENTS['gemini-cli'].parse('{"error":{"message":"API key not valid"}}').isError, true);
  });
});

describe('the agent worker on the host', () => {
  async function worktree() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-agent-'));
    await fs.writeFile(path.join(dir, 'app.ts'), 'x');
    return dir;
  }

  it('prompts with the acceptance command, review questions and the handoff path, and returns the handoff it wrote', async () => {
    const dir = await worktree();
    const { runner, calls } = recordingRunner(() => ({ stdout: resultEvent(), writeHandoff: { task_id: 'wrong', status: 'success', files_changed: ['app.ts'], summary: 'added', review_answers: ['app.ts:2'] } }));
    const worker = new CliAgentWorker('claude-code', 'claude-sonnet-4', runner);
    const lines: string[] = [];
    const usage: unknown[] = [];
    const handoff = await worker.execute(task, dir, { onOutput: l => lines.push(l), onUsage: u => usage.push(u), memoryPatterns: ['lesson one'], projectContext: 'ctx' });
    assert.equal(calls[0].file, 'claude');
    assert.equal(calls[0].cwd, dir);
    const prompt = calls[0].args[1];
    assert.match(prompt, /Acceptance command .*grep farewell app\.ts/);
    assert.match(prompt, /1\. Where is it exported\?/);
    assert.match(prompt, /write \.softfactory\/handoff\.json as JSON with task_id "T1"/);
    assert.match(prompt, /- lesson one/);
    assert.match(prompt, /Do not commit, push/);
    assert.deepEqual(handoff, { task_id: 'T1', status: 'success', files_changed: ['app.ts'], summary: 'added', review_answers: ['app.ts:2'] });
    await assert.rejects(fs.access(path.join(dir, '.softfactory', 'handoff.json')), 'the handoff file is consumed, not committed');
    assert.deepEqual(usage, [{ inputTokens: 120, outputTokens: 30 }]);
    assert.ok(lines.some(l => /on the host, under the agent's own permission rules/.test(l)), lines.join('\n'));
  });

  it('relays the agent\'s streamed events as progress lines', async () => {
    const dir = await worktree();
    const stdout = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Looking at app.ts"},{"type":"tool_use","name":"Edit","input":{"file_path":"app.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}',
      resultEvent(),
    ].join('\n');
    const { runner } = recordingRunner(() => ({ stdout }));
    const lines: string[] = [];
    await new CliAgentWorker('claude-code', '', runner).execute(task, dir, { onOutput: l => lines.push(l) });
    assert.ok(lines.includes('[ClaudeCode] Looking at app.ts'), lines.join('\n'));
    assert.ok(lines.includes('[ClaudeCode] ▸ Edit app.ts'));
    assert.ok(lines.includes('[ClaudeCode] ▸ Bash npm test'));
    assert.ok(lines.includes('[ClaudeCode] ✓ Done.'));
  });

  it('falls back to a handoff from the agent\'s last message when none was written', async () => {
    const dir = await worktree();
    const { runner } = recordingRunner(() => ({ stdout: resultEvent({ result: 'Implemented farewell in app.ts' }) }));
    const handoff = await new CliAgentWorker('claude-code', '', runner).execute(task, dir, {});
    assert.equal(handoff.status, 'success');
    assert.deepEqual(handoff.files_changed, ['app.ts']);
    assert.match(handoff.summary, /finished without writing a handoff.*Implemented farewell/);
    const { runner: failing } = recordingRunner(() => ({ stdout: resultEvent({ is_error: true, result: 'Reached max turns' }), exitCode: 1 }));
    const failed = await new CliAgentWorker('claude-code', '', failing).execute(task, dir, {});
    assert.equal(failed.status, 'failure');
    assert.deepEqual(failed.files_changed, []);
    assert.match(failed.summary, /ended with an error \(exit 1\): Reached max turns/);
  });

  it('treats an authentication failure as an environment fault, not a task failure', async () => {
    const dir = await worktree();
    const { runner } = recordingRunner(() => ({ stdout: resultEvent({ is_error: true, result: 'Not logged in · Please run /login' }), exitCode: 1 }));
    await assert.rejects(() => new CliAgentWorker('claude-code', '', runner).execute(task, dir, {}), (error: Error) => {
      assert.ok(isEnvironmentFailure(error));
      assert.match(error.message, /could not authenticate: Not logged in/);
      return true;
    });
  });

  it('recognises an authentication failure the agent only reports on stderr, after some events', async () => {
    const dir = await worktree();
    const { runner } = recordingRunner(() => ({
      stdout: '{"payload_type":"run.lifecycle.started","payload":{}}\n',
      stderr: 'muse: workspace root: /w\nfailed to fetch model catalog: authentication failed: your API key from META_API_KEY was rejected',
      exitCode: 1,
    }));
    await assert.rejects(() => new CliAgentWorker('muse', '', runner).execute(task, dir, {}), (error: Error) => {
      assert.ok(isEnvironmentFailure(error));
      assert.match(error.message, /Muse Code Worker could not authenticate: failed to fetch model catalog: authentication failed/);
      return true;
    });
  });

  it('passes the attempt budget signal to the process', async () => {
    const dir = await worktree();
    const { runner, calls } = recordingRunner(() => ({ stdout: resultEvent() }));
    const controller = new AbortController();
    await new CliAgentWorker('claude-code', '', runner).execute(task, dir, { signal: controller.signal });
    assert.equal(calls[0].signal, controller.signal);
  });
});

describe('the agent worker inside the sandbox', () => {
  it('runs through the agent container with container placement when the sandbox is active', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-agent-c-'));
    const runs: any[] = [];
    const sandbox: any = { active: true, agentContainer: () => ({ run: async (spec: any, options: any) => { runs.push({ spec: spec.id, options }); options.onOutput?.(resultEvent()); return { stdout: resultEvent(), stderr: '', exitCode: 0 }; } }) };
    const { runner, calls } = recordingRunner(() => ({ stdout: '' }));
    const handoff = await new CliAgentWorker('claude-code', '', runner).execute(task, dir, { sandbox });
    assert.equal(calls.length, 0, 'the host runner is not used');
    assert.equal(runs[0].spec, 'claude-code');
    assert.equal(runs[0].options.root, dir);
    assert.equal(runs[0].options.args[runs[0].options.args.indexOf('--permission-mode') + 1], 'bypassPermissions');
    assert.equal(handoff.status, 'success');
  });
});

describe('the agents are providers like any other', () => {
  it('are the cloud worker for their provider, with a text model and a planner behind them', () => {
    for (const provider of ['claude-code', 'gemini-cli', 'muse'] as const) {
      const registry: any = new WorkerRegistry('cloud', 'auto', '', '', 'l', 'h', provider);
      assert.ok(registry.cloudWorker instanceof CliAgentWorker, provider);
      assert.equal(registry.agentDefinition().id, provider);
      assert.equal(createTextModel(provider, '').provider, provider);
      const factory: any = new Factory('/tmp', '', { strategy: 'cloud', cloudProvider: provider, cloudModel: '', plannerProvider: provider });
      assert.equal(factory.planner.provider, provider);
      assert.equal(factory.inspector.provider, provider);
    }
    assert.equal(new WorkerRegistry('cloud', 'auto', 'm', 'f', 'l', 'h', 'deepseek').agentDefinition(), undefined);
  });

  it('says loudly at preflight where the agent runs, and refuses the container without a key', async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const host: any = new Factory(await fs.mkdtemp(path.join(os.tmpdir(), 'sf-pre-')), '', { strategy: 'cloud', cloudProvider: 'claude-code', cloudModel: '', sandbox: 'none' });
      const lines: string[] = [];
      host.on('log', (l: string) => lines.push(l));
      host.workerRegistry.preflight = async () => ({ local: false, cloud: true, localModel: '', cloudModel: '' });
      host.inspector.isAvailable = async () => true;
      await host.logBackendPreflight();
      assert.equal(host.environmentFault, undefined);
      assert.ok(lines.some(l => /UNSANDBOXED AGENT: claude-code runs its own commands on this host/.test(l)), lines.join('\n'));

      const boxed: any = new Factory(await fs.mkdtemp(path.join(os.tmpdir(), 'sf-pre-')), '', { strategy: 'cloud', cloudProvider: 'claude-code', cloudModel: '', sandbox: 'docker' });
      boxed.sandbox.available = true;
      boxed.workerRegistry.preflight = async () => { throw new Error('must not be reached'); };
      await boxed.logBackendPreflight();
      assert.match(boxed.environmentFault, /claude-code inside the container needs one of ANTHROPIC_API_KEY/);

      process.env.ANTHROPIC_API_KEY = 'k';
      const keyed: any = new Factory(await fs.mkdtemp(path.join(os.tmpdir(), 'sf-pre-')), '', { strategy: 'cloud', cloudProvider: 'claude-code', cloudModel: '', sandbox: 'docker' });
      keyed.sandbox.available = true;
      const keyedLines: string[] = [];
      keyed.on('log', (l: string) => keyedLines.push(l));
      keyed.workerRegistry.preflight = async () => ({ local: false, cloud: true, localModel: '', cloudModel: '' });
      keyed.inspector.isAvailable = async () => true;
      await keyed.logBackendPreflight();
      assert.equal(keyed.environmentFault, undefined);
      assert.ok(keyedLines.some(l => /Agent container: claude-code runs inside Docker; egress limited to api\.anthropic\.com/.test(l)), keyedLines.join('\n'));
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});
