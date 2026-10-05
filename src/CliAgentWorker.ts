import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Task, Handoff, HandoffSchema } from './types.js';
import { IWorker, WorkerOptions, WorkerEnvironmentError } from './IWorker.js';
import type { AgentSpec } from './AgentContainer.js';

export type CliAgentId = 'claude-code' | 'gemini-cli';

/** Where the agent runs decides how much it may do on its own. */
export type Placement = 'host' | 'container';

export interface ParsedAgentResult {
  text: string;
  isError: boolean;
  usage?: { inputTokens: number; outputTokens: number };
  /** Tools or commands the agent asked for and was refused. */
  denials: string[];
}

export interface CliAgentDefinition extends AgentSpec {
  name: string;
  label: string;
  versionArgs: string[];
  args(prompt: string, model: string, placement: Placement): string[];
  parse(stdout: string): ParsedAgentResult;
  /** Output that means the agent could not authenticate: an environment fault, not a task fault. */
  authFailure: RegExp;
}

/** On the host, Claude Code's own permission system is the only filter, so it is kept narrow. */
const CLAUDE_HOST_TOOLS = [
  'Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'LS', 'NotebookEdit',
  'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(pnpm test:*)', 'Bash(yarn test:*)', 'Bash(node:*)',
  'Bash(go test:*)', 'Bash(go vet:*)', 'Bash(go build:*)',
  'Bash(pytest:*)', 'Bash(python -m pytest:*)', 'Bash(python3 -m pytest:*)',
  'Bash(cargo test:*)', 'Bash(cargo build:*)', 'Bash(cargo check:*)', 'Bash(make test:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(grep:*)', 'Bash(rg:*)', 'Bash(find:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)',
];

export const CLI_AGENTS: Record<CliAgentId, CliAgentDefinition> = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code Worker',
    label: 'ClaudeCode',
    executable: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
    versionArgs: ['--version'],
    passEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    egress: ['api.anthropic.com'],
    authFailure: /not logged in|please run \/login|invalid api key|authentication_error|401/i,
    args(prompt, model, placement) {
      // stream-json gives one line per event, so progress reaches the TUI as it happens.
      const base = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--bare', ...(model ? ['--model', model] : [])];
      return placement === 'container'
        ? [...base, '--permission-mode', 'bypassPermissions']
        : [...base, '--permission-mode', 'acceptEdits', '--allowedTools', CLAUDE_HOST_TOOLS.join(' ')];
    },
    parse(stdout) {
      let text = '';
      let isError = false;
      let usage: ParsedAgentResult['usage'];
      const denials: string[] = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'result') {
          text = String(event.result ?? '');
          isError = Boolean(event.is_error);
          if (event.usage) usage = { inputTokens: Number(event.usage.input_tokens) || 0, outputTokens: Number(event.usage.output_tokens) || 0 };
          for (const denial of event.permission_denials || []) denials.push(`${denial.tool_name || denial.tool || 'tool'}${denial.tool_input?.command ? `: ${denial.tool_input.command}` : ''}`);
        }
      }
      return { text, isError, usage, denials };
    },
  },
  'gemini-cli': {
    id: 'gemini-cli',
    name: 'Gemini CLI Worker',
    label: 'GeminiCLI',
    executable: 'gemini',
    npmPackage: '@google/gemini-cli',
    versionArgs: ['--version'],
    passEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    egress: ['generativelanguage.googleapis.com'],
    authFailure: /not authenticated|api key not valid|please set an auth method|401|PERMISSION_DENIED/i,
    args(prompt, model, placement) {
      // auto_edit approves edits only; inside the container the agent may also run commands.
      return ['-p', prompt, '--output-format', 'json', '--approval-mode', placement === 'container' ? 'yolo' : 'auto_edit', ...(model ? ['-m', model] : [])];
    },
    parse(stdout) {
      const start = stdout.indexOf('{');
      try {
        const data = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
        if (data.error) return { text: String(data.error.message || data.error), isError: true, denials: [] };
        const tokens = data.stats?.models ? Object.values(data.stats.models as Record<string, any>) : [];
        const usage = tokens.length ? tokens.reduce((acc: { inputTokens: number; outputTokens: number }, m: any) => ({ inputTokens: acc.inputTokens + (Number(m?.tokens?.prompt) || 0), outputTokens: acc.outputTokens + (Number(m?.tokens?.candidates) || 0) }), { inputTokens: 0, outputTokens: 0 }) : undefined;
        return { text: String(data.response ?? ''), isError: false, usage, denials: [] };
      } catch {
        return { text: stdout.trim(), isError: false, denials: [] };
      }
    },
  },
};

export interface AgentProcessResult { stdout: string; stderr: string; exitCode: number }

/** Runs the agent on the host; tests replace it. */
export type HostRunner = (file: string, args: string[], options: { cwd: string; signal?: AbortSignal; onOutput?: (line: string) => void }) => Promise<AgentProcessResult>;

const defaultHostRunner: HostRunner = async (file, args, options) => {
  const proc = execa(file, args, { cwd: options.cwd, stdin: 'ignore', timeout: 60 * 60_000, all: true, reject: false, ...(options.signal ? { cancelSignal: options.signal } : {}) });
  if (options.onOutput) proc.all?.on('data', chunk => { for (const line of chunk.toString().split('\n')) if (line.trim()) options.onOutput!(line); });
  const result = await proc;
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
};

/**
 * An external coding agent as a worker. It brings its own loop, tools and
 * permission system, so softfactory's command policy does not apply to what
 * it runs. With the sandbox active the whole agent runs in a container whose
 * only network exit is the allowlisting proxy; without it the agent runs on
 * the host under its own permission rules and preflight says so loudly.
 */
export class CliAgentWorker implements IWorker {
  readonly id: string;
  readonly name: string;
  readonly definition: CliAgentDefinition;
  private authProblem: string | null = null;

  constructor(agent: CliAgentId, private readonly defaultModel: string = '', private readonly hostRunner: HostRunner = defaultHostRunner) {
    this.definition = CLI_AGENTS[agent];
    this.id = `${agent}-agent`;
    this.name = this.definition.name;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execa(this.definition.executable, this.definition.versionArgs, { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  buildPrompt(task: Task, handoffPath: string, options: WorkerOptions): string {
    const previousFeedback = task.last_feedback ? task.last_feedback.slice(0, 4000) : '';
    return `You are a SoftFactory worker in an isolated git worktree. Implement the task directly, run the relevant tests, and do not modify files outside this worktree. Do not commit, push or change git configuration; the orchestrator commits.
Task ${task.id}: ${task.title}
Role: ${task.agent_role}
Description: ${task.description}
Files hint: ${task.files_hint.join(', ')}
Acceptance criteria: ${task.acceptance_criteria.join('; ')}
Verification: ${task.verification.join('; ')}
${task.verification_command ? `Acceptance command (run verbatim by the orchestrator after you finish; make it pass): ${task.verification_command}` : ''}
${task.review_questions?.length ? `Review questions (an independent reviewer verifies each answer against your diff; answer each in the handoff's review_answers, citing file:line):\n${task.review_questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}` : ''}
${previousFeedback ? `Previous feedback: ${previousFeedback}` : ''}
${options.memoryPatterns?.length ? `Verified project lessons:\n${options.memoryPatterns.map(x => `- ${x}`).join('\n')}` : ''}
${options.projectContext ? `Project context:\n${options.projectContext}` : ''}
Before finishing, write ${handoffPath} as JSON with task_id "${task.id}", status ("success" or "failure"), files_changed (relative paths), summary and, if there were review questions, review_answers.`;
  }

  async execute(task: Task, worktreePath: string, options: WorkerOptions = {}): Promise<Handoff> {
    const model = options.model || task.model || this.defaultModel;
    const onOutput = options.onOutput || (() => {});
    const handoffRelative = path.join('.softfactory', 'handoff.json');
    const handoffPath = path.join(worktreePath, handoffRelative);
    await fs.mkdir(path.dirname(handoffPath), { recursive: true });
    const prompt = this.buildPrompt(task, handoffRelative, options);
    const container = options.sandbox?.active ? options.sandbox.agentContainer() : undefined;
    const placement: Placement = container ? 'container' : 'host';
    const args = this.definition.args(prompt, model, placement);
    onOutput(`[${this.definition.label}] Starting ${task.id}${model ? ` with ${model}` : ' with the agent\'s default model'} (${placement === 'container' ? 'in the agent container, egress allowlisted' : 'on the host, under the agent\'s own permission rules'})`);

    const stream = (line: string) => this.relay(line, onOutput);
    let result: AgentProcessResult;
    if (container) {
      result = await container.run(this.definition, { root: worktreePath, cwd: worktreePath, args, signal: options.signal, onOutput: stream });
    } else {
      result = await this.hostRunner(this.definition.executable, args, { cwd: worktreePath, signal: options.signal, onOutput: stream });
    }
    const parsed = this.definition.parse(result.stdout);
    if (parsed.usage) options.onUsage?.(parsed.usage);
    if (parsed.isError && this.definition.authFailure.test(parsed.text)) {
      throw new WorkerEnvironmentError(`${this.definition.name} could not authenticate: ${parsed.text.slice(0, 200)}. No task retry was consumed.`);
    }
    if (result.exitCode !== 0 && !result.stdout.trim() && this.definition.authFailure.test(result.stderr)) {
      throw new WorkerEnvironmentError(`${this.definition.name} could not authenticate: ${result.stderr.trim().slice(0, 200)}. No task retry was consumed.`);
    }
    if (parsed.denials.length) onOutput(`[${this.definition.label}] Refused by the agent's permission rules: ${parsed.denials.slice(0, 5).join('; ')}`);

    try {
      const handoff = HandoffSchema.parse(JSON.parse(await fs.readFile(handoffPath, 'utf8')));
      await fs.rm(handoffPath, { force: true });
      return { ...handoff, task_id: task.id };
    } catch {
      const failed = parsed.isError || result.exitCode !== 0;
      return {
        task_id: task.id,
        status: failed ? 'failure' : 'success',
        files_changed: failed ? [] : task.files_hint,
        summary: failed
          ? `${this.definition.name} ended with an error (exit ${result.exitCode}): ${(parsed.text || result.stderr).trim().slice(0, 500)}`
          : `${this.definition.name} finished without writing a handoff. Its last message: ${parsed.text.trim().slice(0, 500)}`,
      };
    }
  }

  /** Turns the agent's streamed events into short progress lines. */
  private relay(line: string, onOutput: (line: string) => void): void {
    if (!line.trim().startsWith('{')) { onOutput(`[${this.definition.label}] ${line.trim()}`); return; }
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'assistant') {
      for (const block of event.message?.content || []) {
        if (block.type === 'text' && block.text?.trim()) onOutput(`[${this.definition.label}] ${String(block.text).trim().slice(0, 300)}`);
        if (block.type === 'tool_use') onOutput(`[${this.definition.label}] ▸ ${block.name}${summarizeInput(block.input)}`);
      }
    } else if (event.type === 'result') {
      onOutput(`[${this.definition.label}] ${event.is_error ? '✗' : '✓'} ${String(event.result || '').trim().slice(0, 300)}`);
    }
  }
}

function summarizeInput(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const value = input.command || input.file_path || input.path || input.pattern || input.filepath;
  return value ? ` ${String(value).slice(0, 120)}` : '';
}
