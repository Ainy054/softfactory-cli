import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { Task, HandoffSchema, Handoff } from './types.js';
import { IWorker, WorkerOptions, WorkerEnvironmentError } from './IWorker.js';
import { TaskVerifier } from './TaskVerifier.js';

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: any[];
}

export class LocalAgentWorker implements IWorker {
  id = 'local-agent';
  name = 'Local Agent Worker (Ollama Tools)';
  private defaultModel: string;
  private ollamaHost: string;
  static readonly REPEAT_WARN = 3;
  static readonly REPEAT_ABORT = 5;          // identical calls back to back
  static readonly REPEAT_TOTAL_ABORT = 8;    // identical calls anywhere in the attempt
  static readonly CYCLE_WINDOW = 6;          // rolling window for A/B/A/B oscillation
  static readonly CYCLE_DISTINCT = 2;
  static readonly NO_PROGRESS_ABORT = 10;    // tool calls with no successful edit
  private readonly maxToolOutput = 6000;
  private readonly maxFileRead = 24000;
  private readonly verifier = new TaskVerifier();

  constructor(defaultModel: string = 'qwen2.5-coder:7b', ollamaHost: string = 'http://127.0.0.1:11434') {
    this.defaultModel = defaultModel;
    this.ollamaHost = ollamaHost;
  }

  async isAvailable(model?: string): Promise<boolean> {
    const status = await this.checkAvailability(model);
    return status.reachable && status.modelPresent;
  }

  /**
   * "Ollama is down" and "the model was never pulled" are different faults with
   * different fixes. Collapsing both into a false forces the caller to guess,
   * and the guess has historically been the wrong one.
   */
  async checkAvailability(model?: string): Promise<{ reachable: boolean; modelPresent: boolean; installed: string[] }> {
    try {
      const response = await fetch(`${this.ollamaHost}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { reachable: false, modelPresent: false, installed: [] };
      const data = await response.json() as any;
      const installed: string[] = (data.models || []).map((entry: any) => entry.name).filter(Boolean);
      return { reachable: true, modelPresent: !model || installed.includes(model), installed };
    } catch {
      return { reachable: false, modelPresent: false, installed: [] };
    }
  }

  /**
   * Size the window against the host, not the model's name. A 14B at 8192 is
   * ~10 GB resident: on a 16 GB machine that swaps and a single turn stops
   * completing at all, which is what the original hard-coded 4096 was guarding
   * against. Keep that guard, but scope it to machines that actually need it so
   * escalating to a stronger model is not a silent context downgrade elsewhere.
   */
  getSafeContextWindow(modelName: string): number {
    const configured = Number(process.env.SOFTFACTORY_LOCAL_NUM_CTX);
    if (Number.isFinite(configured) && configured >= 2048) return Math.floor(configured);
    const totalGb = os.totalmem() / 1024 ** 3;
    const isLargeModel = /(?:1[0-9]|[2-9][0-9])b\b/i.test(modelName);
    if (isLargeModel && totalGb < 32) return 4096;
    return 8192;
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
6. Shell operators (&&, ;, |) are NOT available. To run a command inside a subproject, pass run_command's working_dir, e.g. {"command": "npm test", "working_dir": "frontend"}.
${projectRoots.length ? `\nPACKAGE ROOTS (run commands with the matching working_dir):\n${projectRoots.map(r => `- ${r}`).join('\n')}` : ''}

PROJECT CONTEXT:
${projectContext}
`;
  }

  async execute(task: Task, worktreePath: string, options?: WorkerOptions): Promise<Handoff> {
    const onOutput = options?.onOutput || (() => {});
    const model = options?.model || this.defaultModel;
    const availability = await this.checkAvailability(model);
    if (!availability.reachable) {
      throw new WorkerEnvironmentError(`Ollama is not reachable at ${this.ollamaHost}. Start it (\`ollama serve\`, or launch the Ollama app) and resume. No task retry was consumed.`);
    }
    if (!availability.modelPresent) {
      throw new Error(`Ollama is running but the model "${model}" is not installed. Install it with: ollama pull ${model}. Installed models: ${availability.installed.join(', ') || '(none)'}`);
    }
    
    let userPrompt = `Task ID: ${task.id}\nTitle: ${task.title}\nRole: ${task.agent_role}\n\nDescription:\n${task.description}\n`;
    if (task.last_feedback) {
      userPrompt += `\nPREVIOUS ATTEMPT FAILED (Iteration ${task.attempts}):\n${task.last_feedback}\nEnsure you fix this.\n`;
    }
    if (task.files_hint && task.files_hint.length > 0) {
      userPrompt += `\nRelevant files:\n${task.files_hint.join('\n')}\n`;
    }

    let messages: Message[] = [
      { role: 'system', content: this.buildSystemPrompt(task, options?.projectContext || '', await this.projectRoots(worktreePath)) },
      { role: 'user', content: userPrompt }
    ];

    const tools = [
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
            required: ['filepath']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'replace_lines',
          description: 'Replace an inclusive 1-based line range in a file.',
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
              replacement_content: { type: 'string', description: 'The new content.' }
            },
            required: ['filepath', 'target_content', 'replacement_content']
          }
        }
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
              content: { type: 'string' }
            },
            required: ['filepath', 'content']
          }
        }
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
              working_dir: { type: 'string', description: 'Directory to run in, relative to the repository root (e.g. "frontend"). Defaults to the root.' }
            },
            required: ['command']
          }
        }
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
              status: { type: 'string', enum: ['success', 'failure'] }
            },
            required: ['summary', 'test_summary', 'status']
          }
        }
      }
    ];

    const safeCtx = this.getSafeContextWindow(model);
    onOutput(`[LocalAgent] Booting multi-step ReAct loop with ${model} (ctx: ${safeCtx})`);
    if (!await this.probeToolSupport(model, tools, safeCtx)) {
      throw new Error(`Ollama model "${model}" did not produce a parseable tool call; use a tool-capable model or the legacy worker.`);
    }
    
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
    // The pattern checks above each catch one stall shape, and three times a
    // new shape walked past the tuning of the last: 30 identical reads, then an
    // A/B install oscillation, then a 4-file read cycle. The invariant is not
    // "calls repeat" but "nothing is changing", so count calls since the last
    // successful edit and stop on that regardless of what the calls look like.
    let callsSinceProgress = 0;
    let stalledWithoutProgress = false;
    const diagnosticsDir = options?.diagnosticsDir || path.join(worktreePath, '.softfactory');
    await fs.mkdir(diagnosticsDir, { recursive: true });

    for (let iteration = 0; iteration < 30; iteration++) {
      try {
        messages = this.compactMessages(messages, safeCtx);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Number(process.env.SOFTFACTORY_LOCAL_TIMEOUT_MS) || 360000);
        const response = await fetch(`${this.ollamaHost}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            messages,
            tools,
            stream: false,
            options: { temperature: 0.1, num_ctx: safeCtx }
          }),
        });
        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`Ollama API error: ${response.statusText}`);
        }

        const data = await response.json() as any;
        const msg = data.message || {};
        lastModelContent = msg.content || '';
        const toolCalls = this.extractToolCalls(msg);
        
        // Sometimes Ollama outputs content along with tool calls
        if (msg.content) {
            onOutput(`[LocalAgent] ${msg.content}`);
        }
        
        messages.push({ ...msg, tool_calls: toolCalls });

        if (toolCalls.length === 0) {
          // Model returned plain text without calling a tool.
          onOutput(`[LocalAgent] Model stopped without finishing. Reminding it...`);
          messages.push({ role: 'user', content: 'You must call a tool. Either use read_file/replace_content to work, or finish_task to complete.' });
          continue;
        }

        sawToolCall = true;
        for (const call of toolCalls) {
          const name = call.function.name;
          const args = this.parseToolArguments(call.function.arguments);
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
          if (recentCalls.length > LocalAgentWorker.CYCLE_WINDOW) recentCalls.shift();

          const cycling = recentCalls.length === LocalAgentWorker.CYCLE_WINDOW
            && new Set(recentCalls).size <= LocalAgentWorker.CYCLE_DISTINCT;
          const seen = Math.max(consecutive, cycling ? LocalAgentWorker.REPEAT_ABORT : 0);
          if (seen >= LocalAgentWorker.REPEAT_ABORT || total >= LocalAgentWorker.REPEAT_TOTAL_ABORT) {
            repeatedCall = fingerprint;
            const why = cycling
              ? `the last ${LocalAgentWorker.CYCLE_WINDOW} calls cycled between ${new Set(recentCalls).size} actions`
              : consecutive >= LocalAgentWorker.REPEAT_ABORT
                ? `'${name}' repeated ${consecutive} times in a row`
                : `'${name}' called ${total} times with identical arguments`;
            onOutput(`[LocalAgent] ⛔ Aborting: ${why} with no progress.`);
            break;
          }
          if (consecutive >= LocalAgentWorker.REPEAT_WARN) {
            onOutput(`[LocalAgent] ↻ '${name}' repeated ${consecutive}x — refusing to re-run it.`);
            messages.push({ role: 'tool', content: `You have already called ${name} with these exact arguments ${consecutive} times and the result is earlier in this conversation. Do not call it again. Either make an edit with write_file/replace_lines/replace_content, read a different file or line range, or call finish_task.` } as any);
            continue;
          }

          try {
            if (name === 'read_file') {
              onOutput(`[LocalAgent] 📖 Reading ${args.filepath}`);
              const fullPath = this.resolveToolPath(worktreePath, args.filepath, task, false);
              await this.rejectSymlinkPath(worktreePath, fullPath);
              const content = await fs.readFile(fullPath, 'utf-8');
              const allLines = content.split(/\r?\n/);
              const start = Number.isInteger(Number(args.start_line)) && Number(args.start_line) > 0 ? Number(args.start_line) : 1;
              const end = Number.isInteger(Number(args.end_line)) && Number(args.end_line) >= start ? Math.min(Number(args.end_line), allLines.length) : Math.min(allLines.length, start + 199);
              toolResult = `FILE: ${args.filepath}\nLINES: ${start}-${end}/${allLines.length}\n${allLines.slice(start - 1, end).join('\n')}`.slice(0, this.maxFileRead);
            } else if (name === 'replace_lines') {
              onOutput(`[LocalAgent] ✂️ Replacing lines ${args.start_line}-${args.end_line} in ${args.filepath}`);
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
              onOutput(`[LocalAgent] ✍️ Writing ${args.filepath}`);
              const fullPath = this.resolveToolPath(worktreePath, args.filepath, task, true);
              await this.rejectSymlinkPath(worktreePath, fullPath);
              await fs.mkdir(path.dirname(fullPath), { recursive: true });
              const previous = await fs.readFile(fullPath, 'utf-8').catch(() => null);
              toolResult = await this.writeChecked(fullPath, args.filepath, String(args.content), previous, changedFiles, 'File successfully written.', worktreePath);
            } else if (name === 'replace_content') {
              onOutput(`[LocalAgent] ✂️ Editing ${args.filepath}`);
              const fullPath = this.resolveToolPath(worktreePath, args.filepath, task, true);
              await this.rejectSymlinkPath(worktreePath, fullPath);
              const content = await fs.readFile(fullPath, 'utf-8');
              if (content.includes(args.target_content)) {
                const newContent = content.replace(args.target_content, args.replacement_content);
                toolResult = await this.writeChecked(fullPath, args.filepath, newContent, content, changedFiles, 'Content successfully replaced.', worktreePath);
              } else {
                // Telling a small model to "match whitespace exactly" is telling
                // it to retry the thing it just proved it cannot do: 14 of 15
                // edits failed this way in a row while replace_lines went
                // unused. Hand it line numbers and point at that tool instead.
                toolResult = this.matchFailureGuidance(args.filepath, content, String(args.target_content ?? ''));
                onOutput(`[LocalAgent] ❌ target_content not found in ${args.filepath} — suggesting replace_lines`);
              }
            } else if (name === 'run_command') {
              onOutput(`[LocalAgent] 🖥️ Running: ${args.command}`);
              this.assertAllowedCommand(args.command);
              try {
                const [executable, ...commandArgs] = this.parseCommand(args.command);
                // `cd x && y` is blocked by the allowlist, so without this a
                // monorepo worker could never run the project's own tests: godo
                // keeps package.json in frontend/, and every `npm test` at the
                // worktree root died with ENOENT.
                const cwd = this.resolveWorkingDir(worktreePath, args.working_dir);
                const { stdout, stderr } = await execa(executable, commandArgs, { cwd, timeout: 30000, env: this.safeCommandEnv() });
                toolResult = this.truncateToolResult(`STDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
              } catch (cmdErr: any) {
                toolResult = this.truncateToolResult(`Command failed with exit code ${cmdErr.exitCode}.\nSTDOUT:\n${cmdErr.stdout}\nSTDERR:\n${cmdErr.stderr}`);
              }
            } else if (name === 'finish_task') {
              const verification = await this.verifier.verify(worktreePath, task);
              if (!verification.passed) {
                toolResult = this.truncateToolResult(`Cannot finish. Tests failed: ${verification.testSummary}\n${verification.output}`);
                onOutput(`[LocalAgent] ❌ Finish rejected: ${verification.testSummary}`);
              } else {
                onOutput(`[LocalAgent] ✅ Task finished: ${args.status}`);
                handoffResult = { task_id: task.id, status: 'success', summary: args.summary, test_summary: verification.testSummary, files_changed: Array.from(changedFiles) };
                toolResult = 'Task completed and verification passed.';
              }
            } else {
              toolResult = `Unknown tool: ${name}`;
            }
          } catch (e: any) {
            toolResult = `Tool execution failed: ${e.message}`;
            onOutput(`[LocalAgent] ❌ Tool error: ${e.message}`);
          }

          const mutated = ['write_file', 'replace_content', 'replace_lines'].includes(name)
            && !toolResult.startsWith('ERROR');
          if (mutated || name === 'finish_task') {
            callsSinceProgress = 0;
          } else if (++callsSinceProgress >= LocalAgentWorker.NO_PROGRESS_ABORT) {
            stalledWithoutProgress = true;
            onOutput(`[LocalAgent] ⛔ Aborting: ${callsSinceProgress} tool calls with no successful edit.`);
          }

          messages.push({
            role: 'tool',
            content: toolResult
          } as any);
          await this.recordToolCall(diagnosticsDir, task, name, toolResult, args);
        }
        
        if (repeatedCall || stalledWithoutProgress) break;
        if (handoffResult) break;

      } catch (e: any) {
        onOutput(`[LocalAgent] Crash in ReAct loop: ${e.message}`);
        break;
      }
    }

    if (handoffResult) {
      return handoffResult;
    }

    return {
      task_id: task.id,
      status: 'failure',
      summary: stalledWithoutProgress
        ? `LocalAgent made ${LocalAgentWorker.NO_PROGRESS_ABORT} tool calls without a single successful edit. Stop exploring and change a file, or report why the task cannot be done.`
        : repeatedCall
        ? `LocalAgent stalled in a loop around ${repeatedCall.slice(0, 120)} without making progress. Try a different approach.`
        : sawToolCall
        ? 'LocalAgent stopped before calling finish_task or completing verification.'
        : `LocalAgent received no parseable tool calls from Ollama. Last response: ${lastModelContent.slice(0, 500)}`,
      files_changed: Array.from(changedFiles)
    };
  }

  /**
   * Writes an edit, then checks the file is still parseable. A dropped comma in
   * package.json used to be committed, and every later attempt then died in
   * `npm ci` before a model could be asked to repair it. Reject the edit at the
   * point of damage instead.
   */
  /**
   * Turns a failed exact-match edit into something actionable: the numbered
   * lines around the model's best guess, and an explicit push to replace_lines.
   */
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

  private async writeChecked(
    fullPath: string,
    relativePath: string,
    content: string,
    previous: string | null,
    changedFiles: Set<string>,
    successMessage: string,
    worktreeRoot = '',
  ): Promise<string> {
    await fs.writeFile(fullPath, content, 'utf-8');
    const invalid = await this.structuralError(worktreeRoot, relativePath, content);
    if (invalid) {
      if (previous === null) await fs.rm(fullPath, { force: true });
      else await fs.writeFile(fullPath, previous, 'utf-8');
      return `ERROR: edit rejected and reverted — ${relativePath} would no longer be valid: ${invalid}. Re-read the file and make a corrected edit.`;
    }
    changedFiles.add(relativePath);
    return successMessage;
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

  private extractToolCalls(message: any): any[] {
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return message.tool_calls;
    const content = typeof message.content === 'string' ? message.content : '';
    const calls: any[] = [];
    const pattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed?.name && parsed?.arguments !== undefined) {
          calls.push({ function: { name: parsed.name, arguments: parsed.arguments } });
        }
      } catch { /* malformed model output is reported as no tool call */ }
    }
    if (calls.length === 0 && content.trim()) {
      const candidates = [content.trim(), content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')];
      for (const candidate of candidates) {
        try {
          const parsed = JSON.parse(candidate);
          if (parsed?.name && parsed?.arguments !== undefined) {
            calls.push({ function: { name: parsed.name, arguments: parsed.arguments } });
            break;
          }
        } catch { /* ordinary assistant text */ }
      }
    }
    return calls;
  }

  private async probeToolSupport(model: string, tools: any[], contextWindow: number): Promise<boolean> {
    const controller = new AbortController();
    // A thinking model spends tokens before its first tool call; 20s at 2048
    // tokens rejected gemma4:12b, which emits perfectly good tool_calls.
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(`${this.ollamaHost}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Call read_file for probe.txt now.' }], tools: tools.slice(0, 1), stream: false, options: { temperature: 0, num_ctx: contextWindow } }),
      });
      if (!response.ok) return false;
      const data = await response.json() as any;
      return this.extractToolCalls(data.message || {}).length > 0;
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

  private assertAllowedCommand(command: unknown): asserts command is string {
    if (typeof command !== 'string' || command.length > 300) throw new Error('Invalid command.');
    if (/[;&|`$<>\n\r]/.test(command)) throw new Error('Shell operators are not allowed.');
    const executable = command.trim().split(/\s+/, 1)[0];
    const allowed = new Set(['npm', 'npx', 'pnpm', 'yarn', 'node', 'go', 'pytest', 'python', 'python3', 'cargo', 'git', 'tsc', 'eslint', 'vitest']);
    if (!allowed.has(executable)) throw new Error(`Command is not allowlisted: ${executable}`);
    // -e/-c were blocked but --eval and -p were not, and `git -c alias.x=!cmd`
    // is a shell escape. This raises the bar against accidents; it is not a
    // sandbox, and must not be relied on as one.
    if (/(^|\s)-(?:e|c|p|-eval|-print|-command)\b/.test(command)) {
      throw new Error('Inline interpreter execution is not permitted.');
    }
    if (executable === 'git' && /(^|\s)-c\s|alias\.|!\s*\w/.test(command)) {
      throw new Error('git -c / alias execution is not permitted.');
    }
    if (executable === 'npx') throw new Error('npx is not permitted because it can download and execute arbitrary packages.');
  }

  private parseCommand(command: string): string[] {
    const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    return parts.map(part => part.replace(/^(["'])|\1$/g, ''));
  }

  private safeCommandEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/TOKEN|SECRET|PASSWORD|PRIVATE|API_KEY|AUTH/i.test(key)) delete env[key];
    }
    return { ...env, CI: 'true' };
  }

  private truncateToolResult(result: string): string {
    return result.length > this.maxToolOutput ? `${result.slice(0, this.maxToolOutput)}\n...[truncated]` : result;
  }

  private compactMessages(messages: Message[], contextWindow: number): Message[] {
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
    while (start < messages.length && messages[start].role === 'tool') start++;

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
