import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { Task, Handoff } from './types.js';
import { IWorker, WorkerOptions, requirementSection, acceptanceLine, isDeferredAcceptance, WorkerEnvironmentError } from './IWorker.js';
import { TaskVerifier } from './TaskVerifier.js';
import { AutoHeal } from './AutoHeal.js';
import { assertAllowedCommand, parseCommand, runSafeCommand, splitPipeline, type CommandScope } from './commandPolicy.js';
import type { SandboxManager } from './Sandbox.js';
import { createChatTransport, OllamaChatTransport, type ChatMessage, type ChatTransport, type ToolCall, type ToolDefinition } from './ChatTransport.js';

/** The shared brief, spec, out-of-scope and notes block every worker prompt carries, when present. */
function briefSection(task: Task, brief?: string): string {
  let section = '';
  const shared = brief?.trim();
  if (shared) section += `\nRUN BRIEF (shared by every task in this run):\n${shared}\n`;
  if (task.spec) section += `\nSpec: ${task.spec}\n`;
  if (task.out_of_scope?.length) section += `\nOut of scope (do not touch):\n${task.out_of_scope.map(o => `- ${o}`).join('\n')}\n`;
  if (task.notes_to_executor?.length) section += `\nNotes from the planner:\n${task.notes_to_executor.map(n => `- ${n}`).join('\n')}\n`;
  return section;
}

/**
 * The one tool-calling worker. It owns the loop, the tools, the edit checks and
 * the stall detection; which model answers is the transport's concern. Local
 * Ollama models and the cloud APIs run exactly the same code, so a fix to the
 * loop reaches every backend at once instead of one copy at a time.
 */
export class ToolLoopWorker implements IWorker {
  id: string;
  name: string;
  static readonly REPEAT_WARN = 3;
  static readonly REPEAT_ABORT = 5;          // identical calls back to back
  static readonly REPEAT_TOTAL_ABORT = 8;    // identical calls anywhere in the attempt
  static readonly CYCLE_WINDOW = 6;          // rolling window for A/B/A/B oscillation
  static readonly CYCLE_DISTINCT = 2;
  /** Claims as the model sent them, kept only when they have both a text and a source. */
  static claimsFrom(raw: unknown): Array<{ text: string; source: string }> | undefined {
    if (!Array.isArray(raw)) return undefined;
    const claims = raw.filter((c: any) => c && typeof c.text === 'string' && typeof c.source === 'string').map((c: any) => ({ text: c.text.slice(0, 500), source: c.source.slice(0, 200) }));
    return claims.length ? claims : undefined;
  }
  static readonly NO_PROGRESS_WARN = 6;      // a nudge: enough reading, change a file
  static readonly NO_PROGRESS_ABORT = 12;    // allow initial inspection; cycle guards stop repetitive exploration sooner
  static readonly NO_PROGRESS_MAX = 30;

  /**
   * The read budget before the first edit, scaled to the files the task
   * names: one extra call per 200 lines, up to 30 in all. A flat 12 stopped
   * a worker before its first edit to the 2,400-line Factory.ts, which takes
   * twelve reads to see once (dogfood issue #4).
   */
  static async progressLimits(worktreePath: string, files: string[]): Promise<{ warn: number; abort: number }> {
    let lines = 0;
    for (const file of files) {
      try { lines += (await fs.readFile(path.join(worktreePath, file), 'utf8')).split('\n').length; } catch { /* not created yet */ }
    }
    const abort = Math.min(ToolLoopWorker.NO_PROGRESS_MAX, ToolLoopWorker.NO_PROGRESS_ABORT + Math.ceil(lines / 200));
    return { warn: Math.max(ToolLoopWorker.NO_PROGRESS_WARN, Math.floor(abort / 2)), abort };
  }
  static readonly MAX_ITERATIONS = 30;
  private readonly verifier = new TaskVerifier();

  constructor(readonly transport: ChatTransport, private readonly defaultModel: string) {
    this.id = transport.id;
    this.name = transport.name;
  }

  private get maxToolOutput(): number { return this.transport.limits.toolOutput; }
  private get maxFileRead(): number { return this.transport.limits.fileRead; }
  private get label(): string { return this.transport.label; }

  async isAvailable(model?: string): Promise<boolean> {
    const status = await this.checkAvailability(model);
    return status.reachable && status.modelPresent;
  }

  checkAvailability(model?: string) {
    return this.transport.checkAvailability(model ?? this.defaultModel);
  }

  getSafeContextWindow(modelName: string): number {
    return this.transport.contextWindow(modelName);
  }

  private buildSystemPrompt(task: Task, projectContext: string, projectRoots: string[] = []): string {
    return `You are a precision autonomous software engineer working in an isolated Git worktree.
Your goal is to implement the requested feature or fix the bug.

CRITICAL INSTRUCTIONS:
1. You have access to tools. ALWAYS use the provided tools to read files, modify files, and run tests.
2. DO NOT output code blocks directly in your response expecting them to be saved. You MUST use the 'replace_content' or 'write_file' tools.
3. When using 'replace_content', provide the EXACT target content you want to replace, including all whitespace.
4. If tests are failing, read the test files, understand the requirements, and modify the code.
5. When you are completely finished, call 'finish_task'.
6. Stay strictly within the task's declared files. Do not edit unrelated files to fix baseline failures.
7. For test-writing tasks, add real executable assertions and interactions; never leave placeholder comments or empty tests.
8. Only read-only pipelines using | are available (for example rg ... | head -20). Other shell operators (&&, ;, redirects, substitutions) are NOT available. Use working_dir for subprojects.
9. Run focused tests only: the one test file for your change, or the acceptance command. Do not run the whole suite. The orchestrator runs the scoped suite and the acceptance command after you finish; a whole suite inside the sandbox is slow and is killed by the command timeout, and chasing its unrelated failures ends the attempt.
${projectRoots.length ? `\nPACKAGE ROOTS (run commands with the matching working_dir):\n${projectRoots.map(r => `- ${r}`).join('\n')}` : ''}

PROJECT CONTEXT:
${projectContext}
`;
  }

  private buildUserPrompt(task: Task, requirement?: string, retryBrief?: string, brief?: string): string {
    let userPrompt = `Task ID: ${task.id}\nTitle: ${task.title}\nRole: ${task.agent_role}\n\nDescription:\n${task.description}\n`;
    if (task.acceptance_criteria?.length) userPrompt += `\nAcceptance criteria:\n${task.acceptance_criteria.map(c => `- ${c}`).join('\n')}\n`;
    if (task.verification?.length) userPrompt += `\nVerification:\n${task.verification.map(v => `- ${v}`).join('\n')}\n`;
    if (task.last_feedback) {
      userPrompt += `\nPREVIOUS ATTEMPT FAILED (Iteration ${task.attempts}):\n${task.last_feedback}\nEnsure you fix this.\n`;
      if (/parse|syntax|invalid|test file|test failure/i.test(task.last_feedback)) {
        userPrompt += `\nRECOVERY RULE: Treat the current worktree as potentially damaged. First inspect the complete affected file, restore a parseable structure, and run its focused test or syntax check before making further incremental edits. Do not stack speculative line edits on malformed code.\n`;
      }
    }
    if (task.files_hint && task.files_hint.length > 0) {
      userPrompt += `\nRelevant files:\n${task.files_hint.join('\n')}\n`;
      const tests = task.files_hint.filter(file => /(?:\.test|\.spec)\.[a-z]+$/i.test(file));
      if (tests.length) {
        userPrompt += `\nSCOPED VERIFICATION: Run the focused tests for these files first (for example, npm test -- ${tests.join(' ')} from the package root). Do not use unrelated suite failures to justify edits outside the declared scope.\n`;
      }
    }
    if (task.verification_command) {
      userPrompt += isDeferredAcceptance(task.verification_command)
        ? `\n${acceptanceLine(task.verification_command)}\n`
        : `\nACCEPTANCE COMMAND (the orchestrator runs this verbatim after you finish; make it pass): ${task.verification_command}\n`;
    }
    if (task.review_questions?.length) {
      userPrompt += `\nREVIEW QUESTIONS (an independent reviewer will verify each answer against your diff; answer every one in finish_task's review_answers, citing file:line):\n${task.review_questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n`;
    }
    userPrompt += requirementSection(requirement);
    userPrompt += briefSection(task, brief);
    if (retryBrief) userPrompt += `\n${retryBrief}\n`;
    return userPrompt;
  }


  static readonly TOOLS: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read the contents of a file from the repository.',
        parameters: {
          type: 'object',
          properties: {
            filepath: { type: 'string', description: 'Path to the file to read, relative to the repository root' },
            start_line: { type: 'integer', minimum: 1 },
            end_line: { type: 'integer', minimum: 1 },
          },
          required: ['filepath'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'replace_lines',
        description: 'Replace an inclusive 1-based line range in a file. IMPORTANT: Do not include the line number prefixes (e.g. "12 | ") in the replacement_content. Provide only the raw text.',
        parameters: {
          type: 'object',
          properties: {
            filepath: { type: 'string' },
            start_line: { type: 'integer', minimum: 1 },
            end_line: { type: 'integer', minimum: 1 },
            replacement_content: { type: 'string' },
          },
          required: ['filepath', 'start_line', 'end_line', 'replacement_content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'replace_content',
        description: 'Replace a specific block of text in a file. The target_content must EXACTLY match the existing file content.',
        parameters: {
          type: 'object',
          properties: {
            filepath: { type: 'string' },
            target_content: { type: 'string', description: 'The exact string to be replaced, including leading whitespace.' },
            replacement_content: { type: 'string', description: 'The new content.' },
          },
          required: ['filepath', 'target_content', 'replacement_content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create a new file or completely overwrite an existing file.',
        parameters: {
          type: 'object',
          properties: {
            filepath: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['filepath', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Run a command (tests, linters). Shell operators are not available, so use working_dir to run inside a subproject rather than chaining with cd.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            working_dir: { type: 'string', description: 'Directory to run in, relative to the repository root (e.g. "frontend"). Defaults to the root.' },
            timeout_seconds: { type: 'number', description: 'Seconds before the command is killed: default 120, at most 600. Prefer focused tests over a longer timeout.' },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'finish_task',
        description: 'Call this tool when you have completed the task and verified tests pass.',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'Summary of the changes made' },
            test_summary: { type: 'string', description: 'Summary of the testing performed' },
            status: { type: 'string', enum: ['success', 'failure'] },
            review_answers: { type: 'array', items: { type: 'string' }, description: 'One answer per REVIEW QUESTION, each citing file:line' },
            claims: {
              type: 'array',
              description: 'Material claims about your change, each with a checkable source: "path:line", "path:start-end", "command: <what you ran>", or "UNVERIFIED" when you could not check it. A cited line that does not exist rejects the task.',
              items: { type: 'object', properties: { text: { type: 'string' }, source: { type: 'string' } }, required: ['text', 'source'] },
            },
            not_done: { type: 'array', items: { type: 'string' }, description: 'anything in the task you did not finish, one item each; leave empty when everything is done' },
          },
          required: ['summary', 'test_summary', 'status'],
        },
      },
    },
  ];

  async execute(task: Task, worktreePath: string, options?: WorkerOptions): Promise<Handoff> {
    const onOutput = options?.onOutput || (() => {});
    const model = options?.model || this.defaultModel;
    const availability = await this.transport.checkAvailability(model);
    if (!availability.reachable) throw new WorkerEnvironmentError(this.transport.unreachable());
    if (!availability.modelPresent) throw new Error(this.transport.missingModel(model, availability.installed));

    let messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt(task, options?.projectContext || '', await this.projectRoots(worktreePath)) },
      { role: 'user', content: this.buildUserPrompt(task, options?.requirement, options?.retryBrief, options?.brief) },
    ];
    // Emit the exact prompt the model will receive, once per attempt, before
    // any transport work. The orchestrator saves it so a retry can be compared
    // against the attempt before it and a rerun stays reproducible.
    options?.onPrompt?.(`${messages[0].content}\n\n${messages[1].content}`);
    const tools = ToolLoopWorker.TOOLS;
    const safeCtx = this.getSafeContextWindow(model);
    // A little more exploration on each retry; the first attempt stays near-deterministic.
    const temperature = Math.min(0.1 + ((task.attempts || 0) * 0.15), 0.8);
    onOutput(`[${this.label}] Booting multi-step ReAct loop with ${model} (ctx: ${safeCtx})`);
    if (!await this.probeToolSupport(model, tools, safeCtx)) {
      throw new Error(`${this.label} model "${model}" did not produce a parseable tool call; use a tool-capable model.`);
    }

    let finishRejections = 0;
    let handoffResult: Handoff | null = null;
    const changedFiles = new Set<string>();
    let sawToolCall = false;
    let lastModelContent = '';
    // A degenerate ReAct loop repeats one identical call until the iteration cap.
    // Observed: 30 byte-identical read_file calls per attempt, three attempts
    // running, zero writes. Detect it and stop instead of burning the budget.
    const callCounts = new Map<string, number>();
    let lastFingerprint: string | null = null;
    let repeatedCall: string | null = null;
    const recentCalls: string[] = [];
    // The pattern checks each catch one stall shape, and three times a new
    // shape walked past the tuning of the last: 30 identical reads, then an
    // A/B install oscillation, then a 4-file read cycle. The invariant is not
    // "calls repeat" but "nothing is changing", so count calls since the last
    // successful edit and stop on that regardless of what the calls look like.
    let callsSinceProgress = 0;
    // The code a test writer must read counts too: issue #18's test task was
    // stopped at 12 calls while reading the 2,400-line file its tests exercise.
    const limits = await ToolLoopWorker.progressLimits(worktreePath, [...new Set([...(task.files_hint || []), ...(task.creates_files || []), ...(task.production_targets || [])])]);
    let stalledWithoutProgress = false;
    let finishAborted = false;
    let lastFinishFailure = '';
    let protocolError = '';
    let budgetStopped = false;
    let scopeViolations = 0;
    const syntaxRejects = new Map<string, number>();
    const diagnosticsDir = options?.diagnosticsDir || path.join(worktreePath, '.softfactory');
    await fs.mkdir(diagnosticsDir, { recursive: true });

    for (let iteration = 0; iteration < ToolLoopWorker.MAX_ITERATIONS; iteration++) {
      if (options?.signal?.aborted) {
        // The orchestrator's attempt budget ran out. Stop here; what was
        // edited so far is committed and gated like any other attempt.
        budgetStopped = true;
        onOutput(`[${this.label}] ⛔ Stopping: the attempt's time budget is spent.`);
        break;
      }
      try {
        messages = this.compactMessages(messages, safeCtx);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.transport.timeoutMs());
        const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
        let reply;
        try {
          reply = await this.transport.chat({ model, messages, tools, temperature, contextWindow: safeCtx, signal });
        } finally {
          // A failed request used to leave a six-minute timer holding the process open.
          clearTimeout(timeout);
        }
        if (reply.usage) options?.onUsage?.(reply.usage);

        lastModelContent = reply.content || '';
        const toolCalls = this.extractToolCalls(reply.content, reply.toolCalls).map((call, index) => ({
          ...call,
          id: call.id || `sf_call_${iteration}_${index}`,
          type: 'function' as const,
        }));
        if (reply.content) onOutput(`[${this.label}] ${reply.content}`);
        messages.push({ role: 'assistant', content: reply.content || '', tool_calls: toolCalls.length > 0 ? toolCalls : undefined });

        if (toolCalls.length === 0) {
          onOutput(`[${this.label}] Model stopped without finishing. Reminding it...`);
          messages.push({ role: 'user', content: 'You must call a tool. Either use read_file/replace_content to work, or finish_task to complete.' });
          continue;
        }

        sawToolCall = true;
        for (const call of toolCalls) {
          const name = call.function.name;
          let args: any;
          try { args = this.parseToolArguments(call.function.arguments); }
          catch (error: any) {
            protocolError = `Malformed tool arguments from ${this.label}: ${error.message}`;
            onOutput(`[${this.label}] ❌ ${protocolError}`);
            repeatedCall = `protocol:${name || 'unknown'}`;
            break;
          }
          let toolResult = '';

          // Three shapes of stall, and each hides from the other two checks.
          // Consecutive alone missed an A/B/A/B npm-install oscillation (12
          // rounds, max consecutive run of 1). Cumulative alone aborted workers
          // that were legitimately re-reading between edits.
          const fingerprint = `${name}:${JSON.stringify(args)}`;
          const consecutive = (lastFingerprint === fingerprint ? (callCounts.get(`c:${fingerprint}`) || 0) : 0) + 1;
          const total = (callCounts.get(`t:${fingerprint}`) || 0) + 1;
          callCounts.set(`c:${fingerprint}`, consecutive);
          callCounts.set(`t:${fingerprint}`, total);
          lastFingerprint = fingerprint;
          recentCalls.push(fingerprint);
          if (recentCalls.length > ToolLoopWorker.CYCLE_WINDOW) recentCalls.shift();

          const cycling = recentCalls.length === ToolLoopWorker.CYCLE_WINDOW
            && new Set(recentCalls).size <= ToolLoopWorker.CYCLE_DISTINCT;
          const seen = Math.max(consecutive, cycling ? ToolLoopWorker.REPEAT_ABORT : 0);
          if (seen >= ToolLoopWorker.REPEAT_ABORT || total >= ToolLoopWorker.REPEAT_TOTAL_ABORT) {
            repeatedCall = fingerprint;
            const why = cycling
              ? `the last ${ToolLoopWorker.CYCLE_WINDOW} calls cycled between ${new Set(recentCalls).size} actions`
              : consecutive >= ToolLoopWorker.REPEAT_ABORT
                ? `'${name}' repeated ${consecutive} times in a row`
                : `'${name}' called ${total} times with identical arguments`;
            onOutput(`[${this.label}] ⛔ Aborting: ${why} with no progress.`);
            break;
          }
          if (consecutive >= ToolLoopWorker.REPEAT_WARN) {
            onOutput(`[${this.label}] ↻ '${name}' repeated ${consecutive}x — refusing to re-run it.`);
            // Every tool message answers a call by id, this one included, or
            // an OpenAI-compatible endpoint rejects the next request.
            messages.push({ role: 'tool', tool_call_id: call.id, content: `You have already called ${name} with these exact arguments ${consecutive} times and the result is earlier in this conversation. Do not call it again. Either make an edit with write_file/replace_lines/replace_content, read a different file or line range, or call finish_task.` });
            continue;
          }

          try {
            if (name === 'read_file') {
              onOutput(`[${this.label}] 📖 Reading ${args.filepath}`);
              const fullPath = this.resolveToolPath(worktreePath, args.filepath, task, false);
              await this.rejectSymlinkPath(worktreePath, fullPath);
              const content = await fs.readFile(fullPath, 'utf-8');
              const allLines = content.split(/\r?\n/);
              const start = Number.isInteger(Number(args.start_line)) && Number(args.start_line) > 0 ? Number(args.start_line) : 1;
              const end = Number.isInteger(Number(args.end_line)) && Number(args.end_line) >= start ? Math.min(Number(args.end_line), allLines.length) : Math.min(allLines.length, start + 199);
              toolResult = `FILE: ${args.filepath}\nLINES: ${start}-${end}/${allLines.length}\n${allLines.slice(start - 1, end).map((line, i) => `${start + i} | ${line}`).join('\n')}`.slice(0, this.maxFileRead);
            } else if (name === 'replace_lines') {
              onOutput(`[${this.label}] ✂️ Replacing lines ${args.start_line}-${args.end_line} in ${args.filepath}`);
              const fullPath = this.resolveToolPath(worktreePath, args.filepath, task, true);
              await this.rejectSymlinkPath(worktreePath, fullPath);
              const content = await fs.readFile(fullPath, 'utf-8');
              const lines = content.split(/\r?\n/);
              const start = Number(args.start_line);
              const end = Number(args.end_line);
              if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
                throw new Error(`Invalid line range ${start}-${end}; file has ${lines.length} lines.`);
              }
              lines.splice(start - 1, end - start + 1, String(args.replacement_content));
              toolResult = await this.writeChecked(fullPath, args.filepath, lines.join('\n'), content, changedFiles, 'Lines successfully replaced.', worktreePath);
            } else if (name === 'write_file') {
              onOutput(`[${this.label}] ✍️ Writing ${args.filepath}`);
              const fullPath = this.resolveToolPath(worktreePath, args.filepath, task, true);
              await this.rejectSymlinkPath(worktreePath, fullPath);
              await fs.mkdir(path.dirname(fullPath), { recursive: true });
              const previous = await fs.readFile(fullPath, 'utf-8').catch(() => null);
              toolResult = await this.writeChecked(fullPath, args.filepath, String(args.content), previous, changedFiles, 'File successfully written.', worktreePath);
            } else if (name === 'replace_content') {
              onOutput(`[${this.label}] ✂️ Editing ${args.filepath}`);
              const fullPath = this.resolveToolPath(worktreePath, args.filepath, task, true);
              await this.rejectSymlinkPath(worktreePath, fullPath);
              const content = await fs.readFile(fullPath, 'utf-8');
              const target = typeof args.target_content === 'string' ? args.target_content : '';
              const occurrences = target ? content.split(target).length - 1 : 0;
              if (occurrences === 1) {
                // A function replacer: "$&", "$'" or "$1" in the model's text
                // are literal code here, not pattern tokens.
                const newContent = content.replace(target, () => String(args.replacement_content));
                toolResult = await this.writeChecked(fullPath, args.filepath, newContent, content, changedFiles, 'Content successfully replaced.', worktreePath);
              } else if (occurrences > 1) {
                toolResult = `ERROR: target_content occurs ${occurrences} times in ${args.filepath}, so the edit is ambiguous. Include more surrounding lines to make it unique, or use replace_lines with a line range.`;
                onOutput(`[${this.label}] ❌ target_content is ambiguous in ${args.filepath} (${occurrences} matches)`);
              } else {
                // Telling a small model to "match whitespace exactly" is telling
                // it to retry the thing it just proved it cannot do: 14 of 15
                // edits failed this way in a row while replace_lines went
                // unused. Hand it line numbers and point at that tool instead.
                toolResult = this.matchFailureGuidance(args.filepath, content, String(args.target_content ?? ''));
                onOutput(`[${this.label}] ❌ target_content not found in ${args.filepath} — suggesting replace_lines`);
              }
            } else if (name === 'run_command') {
              onOutput(`[${this.label}] 🖥️ Running: ${args.command}`);
              // `cd x && y` is blocked by the allowlist, so without this a
              // monorepo worker could never run the project's own tests.
              const cwd = this.resolveWorkingDir(worktreePath, args.working_dir);
              this.assertAllowedCommand(args.command, { root: worktreePath, cwd });
              try {
                const result = await this.runSafeCommand(args.command, cwd, worktreePath, options?.sandbox, ToolLoopWorker.commandTimeoutMs(args.timeout_seconds));
                toolResult = this.truncateToolResult(`STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
              } catch (cmdErr: any) {
                toolResult = this.truncateToolResult(`Command failed with exit code ${cmdErr.exitCode}.\nSTDOUT:\n${cmdErr.stdout}\nSTDERR:\n${cmdErr.stderr}`);
              }
            } else if (name === 'finish_task') {
              const verification = await this.verifier.verify(worktreePath, task, false);
              if (!verification.passed) {
                finishRejections++;
                lastFinishFailure = verification.testSummary;
                toolResult = this.truncateToolResult(`Cannot finish. Tests failed: ${verification.testSummary}\n${verification.output}`);
                onOutput(`[${this.label}] ❌ Finish rejected (${finishRejections}/2): ${verification.testSummary}`);
                if (finishRejections >= 2) {
                  // Thrown from here, this was caught as an ordinary tool error
                  // and the loop carried on to the iteration cap.
                  finishAborted = true;
                  onOutput(`[${this.label}] ⛔ Aborting: finish_task rejected twice due to test failures. Escalating...`);
                }
              } else {
                onOutput(`[${this.label}] ✅ Task finished: ${args.status}`);
                handoffResult = { task_id: task.id, status: 'success', summary: args.summary, test_summary: verification.testSummary, files_changed: Array.from(changedFiles),
                  review_answers: Array.isArray(args.review_answers) ? args.review_answers.map(String) : undefined,
                  claims: ToolLoopWorker.claimsFrom(args.claims),
                  not_done: Array.isArray(args.not_done) ? args.not_done.map(String) : undefined };
                toolResult = 'Task completed and verification passed.';
              }
            } else {
              toolResult = `Unknown tool: ${name}`;
            }
          } catch (e: any) {
            toolResult = `Tool execution failed: ${e.message}`;
            onOutput(`[${this.label}] ❌ Tool error: ${e.message}`);
            if (/outside declared task scope/i.test(e.message)) {
              scopeViolations++;
              if (scopeViolations >= 2) {
                repeatedCall = `scope:${args.filepath}`;
                onOutput(`[${this.label}] ⛔ Aborting: repeated out-of-scope edits for ${args.filepath}.`);
              }
            }
          }

          const mutated = ['write_file', 'replace_content', 'replace_lines'].includes(name)
            && !toolResult.startsWith('ERROR')
            && !toolResult.startsWith('Tool execution failed:');
          if (toolResult.startsWith('ERROR: edit rejected and reverted')) {
            const file = String(args.filepath || 'unknown');
            const count = (syntaxRejects.get(file) || 0) + 1;
            syntaxRejects.set(file, count);
            if (count >= 2) {
              repeatedCall = `syntax:${file}`;
              onOutput(`[${this.label}] ⛔ Aborting: repeated syntax-rejected edits for ${file}.`);
            }
          }
          // A rejected finish_task is not progress; only an accepted one is.
          if (mutated || (name === 'finish_task' && handoffResult)) {
            callsSinceProgress = 0;
          } else if (++callsSinceProgress >= limits.abort) {
            stalledWithoutProgress = true;
            onOutput(`[${this.label}] ⛔ Aborting: ${callsSinceProgress} tool calls with no successful edit.`);
          } else if (callsSinceProgress === limits.warn) {
            toolResult += `\n\n[orchestrator] ${callsSinceProgress} tool calls and no file changed yet. You have enough context: create or edit the file now with write_file or replace_content, then run the acceptance command. The attempt ends after ${limits.abort} calls without an edit.`;
            onOutput(`[${this.label}] ${callsSinceProgress} calls without an edit; nudged.`);
          }

          messages.push({ role: 'tool', tool_call_id: call.id, content: toolResult });
          await this.recordToolCall(diagnosticsDir, task, name, toolResult, args);
          if (finishAborted) break;
        }

        if (repeatedCall || stalledWithoutProgress || finishAborted) break;
        if (handoffResult) break;

      } catch (e: any) {
        if (/deserialize|400|422|tool_call_id|tool_calls/i.test(String(e.message))) {
          protocolError = String(e.message).slice(0, 1000);
          onOutput(`[${this.label}] ❌ Protocol error: ${protocolError}`);
        }
        onOutput(`[${this.label}] Crash in ReAct loop: ${e.message}`);
        break;
      }
    }

    if (handoffResult) {
      return handoffResult;
    }

    const who = `${this.label} worker`;
    return {
      task_id: task.id,
      status: 'failure',
      summary: budgetStopped
        ? `${who} was stopped because the attempt's time budget ran out before finish_task. Work so far is committed; continue from it.`
        : protocolError
        ? `${who} hit a protocol error: ${protocolError}. Validate tool-call IDs and tool responses before retrying.`
        : finishAborted
        ? `${who} called finish_task twice while verification was still failing (${lastFinishFailure}). Fix the failing tests before finishing, or report the concrete blocker.`
        : stalledWithoutProgress && changedFiles.size > 0
        ? `${who} stopped after ${limits.abort} tool calls with no further edit; the ${changedFiles.size} edited file(s) stand and go to verification. Call finish_task once the focused tests pass instead of re-running the suite.`
        : stalledWithoutProgress
        ? `${who} made ${limits.abort} tool calls without a single successful edit. Stop exploring and change a file, or report why the task cannot be done.`
        : repeatedCall?.startsWith('scope:')
        ? `${who} attempted out-of-scope edits repeatedly (${repeatedCall.slice(6)}). Stop and report the blocker or revise the task scope.`
        : repeatedCall?.startsWith('syntax:')
        ? `${who} produced repeated invalid edits for ${repeatedCall.slice(7)}. Restore the last valid file and rewrite it coherently.`
        : repeatedCall
        ? `${who} stalled in a loop around ${repeatedCall.slice(0, 120)} without making progress. Try a different approach.`
        : sawToolCall
        ? `${who} stopped before calling finish_task or completing verification.`
        : `${who} received no parseable tool calls from ${this.label}. Last response: ${lastModelContent.slice(0, 500)}`,
      files_changed: Array.from(changedFiles),
    };
  }

  /** A subdirectory of the worktree to run a command in. Never outside it. */
  private resolveWorkingDir(worktreePath: string, raw: unknown): string {
    const root = path.resolve(worktreePath);
    if (raw === undefined || raw === null || raw === '') return root;
    if (typeof raw !== 'string' || path.isAbsolute(raw)) throw new Error('working_dir must be a relative path inside the repository.');
    const target = path.resolve(root, raw);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('working_dir escapes the task worktree.');
    return target;
  }

  /** Directories holding a package manifest, so the model knows where to run things. */
  private async projectRoots(worktreePath: string): Promise<string[]> {
    const roots: string[] = [];
    const candidates = ['.', 'frontend', 'backend', 'web', 'client', 'server', 'app', 'api'];
    for (const dir of candidates) {
      for (const manifest of ['package.json', 'go.mod', 'pyproject.toml', 'Cargo.toml']) {
        try {
          await fs.access(path.join(worktreePath, dir, manifest));
          roots.push(`${dir === '.' ? '(root)' : dir} -> ${manifest}`);
          break;
        } catch { /* not here */ }
      }
    }
    return roots;
  }

  /**
   * Turns a failed exact-match edit into something actionable: the numbered
   * lines around the model's best guess, and an explicit push to replace_lines.
   */
  private matchFailureGuidance(filepath: string, content: string, target: string): string {
    const lines = content.split(/\r?\n/);
    const needle = (target.split(/\r?\n/).find(line => line.trim().length > 3) || '').trim();
    let anchor = needle ? lines.findIndex(line => line.includes(needle)) : -1;
    if (anchor === -1 && needle.length > 8) {
      const loose = needle.replace(/\s+/g, '');
      anchor = lines.findIndex(line => line.replace(/\s+/g, '').includes(loose));
    }
    const numbered = (from: number, to: number) => lines.slice(from, to)
      .map((line, i) => `${String(from + i + 1).padStart(4)}| ${line}`).join('\n');

    if (anchor === -1) {
      return `ERROR: that exact text is not in ${filepath}. Do not retry an exact-text match. `
        + `Use replace_lines with start_line and end_line instead. Current file:\n${numbered(0, Math.min(lines.length, 80))}`;
    }
    const from = Math.max(0, anchor - 4);
    const to = Math.min(lines.length, anchor + 6);
    return `ERROR: that exact text is not in ${filepath}, but similar text is at line ${anchor + 1}. `
      + `Do not retry an exact-text match — whitespace will differ. Call replace_lines with start_line/end_line `
      + `covering the lines you want to change:\n${numbered(from, to)}`;
  }

  /**
   * Writes an edit, then checks the file is still parseable. A dropped comma in
   * package.json used to be committed, and every later attempt then died in
   * `npm ci` before a model could be asked to repair it. Reject the edit at the
   * point of damage instead.
   */
  private async writeChecked(
    fullPath: string,
    relativePath: string,
    content: string,
    previous: string | null,
    changedFiles: Set<string>,
    successMessage: string,
    worktreeRoot = '',
  ): Promise<string> {
    let healed = false;
    if (fullPath.toLowerCase().endsWith('.json') && await this.structuralError(worktreeRoot, relativePath, content)) {
      const repaired = AutoHeal.healJson(content);
      if (repaired !== content && !(await this.structuralError(worktreeRoot, relativePath, repaired))) {
        content = repaired;
        healed = true;
      }
    }
    await fs.writeFile(fullPath, content, 'utf-8');
    const invalid = await this.structuralError(worktreeRoot, relativePath, content);
    if (invalid) {
      if (previous === null) await fs.rm(fullPath, { force: true });
      else await fs.writeFile(fullPath, previous, 'utf-8');
      return `ERROR: edit rejected and reverted — ${relativePath} would no longer be valid: ${invalid}. Re-read the file and make a corrected edit.`;
    }
    changedFiles.add(relativePath);
    await AutoHeal.formatCode(worktreeRoot, relativePath, previous);
    return healed ? `${successMessage} (JSON auto-healed and revalidated)` : successMessage;
  }

  /**
   * Non-null when the new content will not parse. Limiting this to JSON let a
   * vitest.config.ts with four stray closing brackets merge to main, after
   * which the whole frontend suite could no longer start.
   */
  private async structuralError(worktreeRoot: string, relativePath: string, content: string): Promise<string | null> {
    if (!content.trim()) return 'the file is empty';
    if (/\.json$/i.test(relativePath)) {
      try {
        JSON.parse(content);
        return null;
      } catch (error: any) {
        return `invalid JSON (${error.message})`;
      }
    }
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(relativePath)) return null;
    return this.scriptSyntaxError(worktreeRoot, relativePath, content);
  }

  /**
   * Parses with the project's own esbuild. Absent one we cannot judge, and
   * refusing every edit would be worse than allowing them, so we allow.
   */
  private async scriptSyntaxError(worktreeRoot: string, relativePath: string, content: string): Promise<string | null> {
    if (!worktreeRoot) return null;
    const dirs = [path.dirname(relativePath), '.', 'frontend', 'backend'];
    let binary: string | null = null;
    for (const dir of dirs) {
      const candidate = path.join(worktreeRoot, dir, 'node_modules', '.bin', 'esbuild');
      try {
        await fs.access(candidate);
        binary = candidate;
        break;
      } catch { /* keep looking */ }
    }
    if (!binary) return null;
    const loader = /\.(tsx|jsx)$/i.test(relativePath) ? 'tsx' : /\.tsx?$/i.test(relativePath) ? 'ts' : 'js';
    try {
      await execa(binary, [`--loader=${loader}`], { input: content, timeout: 20000 });
      return null;
    } catch (error: any) {
      const message = String(error.stderr || error.stdout || error.message).split('\n')
        .filter((line: string) => line.trim()).slice(0, 4).join(' ');
      if (/ENOENT|not found|timed out/i.test(message)) return null;
      return `it no longer parses (${message.slice(0, 300)})`;
    }
  }

  private parseToolArguments(raw: unknown): any {
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { throw new Error('Malformed tool arguments (expected JSON object).'); }
    }
    if (!raw || typeof raw !== 'object') throw new Error('Malformed tool arguments.');
    return raw;
  }

  /** Structured tool calls when the backend returned them; otherwise calls a model wrote into its text. */
  private extractToolCalls(content: string, structured: ToolCall[]): ToolCall[] {
    if (structured.length > 0) return structured;
    const calls: ToolCall[] = [];
    const text = typeof content === 'string' ? content : '';
    const pattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed?.name && parsed?.arguments !== undefined) {
          calls.push({ id: '', type: 'function', function: { name: parsed.name, arguments: parsed.arguments } });
        }
      } catch { /* malformed model output is reported as no tool call */ }
    }
    if (calls.length === 0 && text.trim()) {
      const candidates = [text.trim(), text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')];
      for (const candidate of candidates) {
        try {
          const parsed = JSON.parse(candidate);
          if (parsed?.name && parsed?.arguments !== undefined) {
            calls.push({ id: '', type: 'function', function: { name: parsed.name, arguments: parsed.arguments } });
            break;
          }
        } catch { /* ordinary assistant text */ }
      }
    }
    return calls;
  }

  private async probeToolSupport(model: string, tools: ToolDefinition[], contextWindow: number): Promise<boolean> {
    const controller = new AbortController();
    // A thinking model spends tokens before its first tool call; 20s at 2048
    // tokens rejected gemma4:12b, which emits perfectly good tool_calls.
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      const reply = await this.transport.chat({
        model, messages: [{ role: 'user', content: 'Call read_file for probe.txt now.' }], tools: tools.slice(0, 1),
        temperature: 0, contextWindow, signal: controller.signal,
      });
      return this.extractToolCalls(reply.content, reply.toolCalls).length > 0;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private resolveToolPath(worktreePath: string, rawPath: unknown, task: Task, write: boolean): string {
    if (typeof rawPath !== 'string' || !rawPath || path.isAbsolute(rawPath)) throw new Error('Path must be a non-empty relative path.');
    const root = path.resolve(worktreePath);
    const target = path.resolve(root, rawPath);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Path escapes the task worktree.');
    const allowed = new Set([...task.files_hint, ...task.creates_files]);
    if (write && allowed.size > 0 && !allowed.has(rawPath)) throw new Error(`Write path is outside declared task scope: ${rawPath}`);
    return target;
  }

  private async rejectSymlinkPath(rootPath: string, targetPath: string): Promise<void> {
    const root = path.resolve(rootPath);
    const relative = path.relative(root, targetPath);
    let current = root;
    for (const part of relative.split(path.sep)) {
      if (!part) continue;
      current = path.join(current, part);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Symlink paths are not permitted.');
      } catch (error: any) {
        if (error?.code === 'ENOENT') break;
        throw error;
      }
    }
  }

  // The command policy is shared with the acceptance runner (commandPolicy.ts);
  // these thin wrappers keep the call sites local.
  private assertAllowedCommand(command: unknown, scope?: CommandScope): asserts command is string { assertAllowedCommand(command, scope); }
  private splitPipeline(command: string): string[] { return splitPipeline(command); }
  private parseCommand(command: string): string[] { return parseCommand(command); }
  /** The model may ask for up to ten minutes; 30 seconds killed every `npm test` in the sandbox. */
  static commandTimeoutMs(requested: unknown): number {
    const seconds = Number(requested);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(600, Math.max(5, Math.floor(seconds))) * 1000 : 120_000;
  }

  private async runSafeCommand(command: string, cwd: string, root: string = cwd, sandbox?: SandboxManager, timeoutMs = 120_000) {
    const runner = sandbox ? await sandbox.runnerFor(root, command.trim().split(/\s+/, 1)[0]) : undefined;
    return runSafeCommand(command, cwd, timeoutMs, { root, runner });
  }

  private truncateToolResult(result: string): string {
    return result.length > this.maxToolOutput ? `${result.slice(0, this.maxToolOutput)}\n...[truncated]` : result;
  }

  private compactMessages(messages: ChatMessage[], contextWindow: number): ChatMessage[] {
    const charBudget = Math.max(5000, Math.floor(contextWindow * 1.8));
    const total = messages.reduce((sum, message) => sum + (message.content || '').length, 0);
    if (total <= charBudget) return messages;

    // The head was previously exempt from compaction, which made it the one
    // message that could silently exceed the whole window. Budget it like any
    // other, generously but finitely.
    const headBudget = Math.floor(charBudget * 0.4);
    const head = messages.slice(0, 2).map(message => {
      const content = message.content || '';
      return content.length > headBudget
        ? { ...message, content: `${content.slice(0, headBudget)}\n...[context truncated — use read_file for anything not shown]` }
        : message;
    });

    let start = Math.max(2, messages.length - 4);
    // Never begin on a tool result whose call is cut off: step back to the
    // assistant turn that made it. Stepping forward instead walked past the
    // end whenever one turn produced four or more tool results, which emptied
    // the recent window and recreated the read_file livelock. The walk is
    // bounded so a pathological run of results cannot drag history back in.
    let owner = start;
    while (owner > 2 && messages[owner].role === 'tool' && start - owner < 12) owner--;
    if (messages[owner].role !== 'tool') start = owner;

    // The final tool result is what the model just asked for. Compacting it
    // before the model has ever seen it is what produced the read_file livelock:
    // the answer vanished, so the model asked the same question again.
    const lastIndex = messages.length - 1;
    const recent = messages.slice(start).map((message, offset) => {
      const content = message.content || '';
      const isNewestToolResult = start + offset === lastIndex && message.role === 'tool';
      const limit = isNewestToolResult ? Math.floor(charBudget * 0.5) : 1000;
      if (content.length <= limit) return { ...message, content };
      return isNewestToolResult
        ? { ...message, content: `${content.slice(0, limit)}\n...[truncated — read a specific line range to see more]` }
        : { ...message, content: `${content.slice(0, 500)}\n...[older output compacted]...\n${content.slice(-400)}` };
    });

    return [...head, { role: 'system' as const, content: 'Earlier tool output was compacted; re-read files or rerun focused checks as needed.' }, ...recent];
  }

  private async recordToolCall(diagnosticsDir: string, task: Task, tool: string, result: string, args?: any): Promise<void> {
    try {
      await fs.appendFile(path.join(diagnosticsDir, 'tool-calls.jsonl'), JSON.stringify({
        timestamp: new Date().toISOString(), task_id: task.id, tool, result: this.truncateToolResult(result),
        // Without the arguments, a failing edit cannot be diagnosed afterwards.
        args: args ? JSON.parse(JSON.stringify(args, (_k, v) => typeof v === 'string' && v.length > 600 ? `${v.slice(0, 600)}...[truncated]` : v)) : undefined,
      }) + '\n');
    } catch { /* diagnostics must not fail work */ }
  }
}

/** The tool loop on a local Ollama model. */
export class LocalAgentWorker extends ToolLoopWorker {
  constructor(defaultModel: string = 'qwen2.5-coder:7b', ollamaHost: string = 'http://127.0.0.1:11434') {
    super(new OllamaChatTransport(ollamaHost), defaultModel);
  }
}

/** The tool loop on DeepSeek's OpenAI-compatible API. */
export class DeepSeekCloudWorker extends ToolLoopWorker {
  constructor(defaultModel: string = 'deepseek-v4-flash', fetchImpl?: typeof fetch) {
    super(createChatTransport('deepseek', { fetchImpl }), defaultModel);
  }
}
