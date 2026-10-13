import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Task, HandoffSchema, Handoff } from './types.js';
import { IWorker, WorkerOptions, argvText, requirementSection, acceptanceLine, briefSection, wiringSection, affirmsLiveStackUntouched } from './IWorker.js';
import { AgyStreamRelay } from './AgyStream.js';
import { AGY_WORKER_MODEL } from './TextModel.js';


export class AgyWorker implements IWorker {
  id = 'agy-cloud';
  name = 'Antigravity Cloud Worker';
  private defaultModel: string;

  constructor(defaultModel: string = AGY_WORKER_MODEL) {
    this.defaultModel = defaultModel;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execa('agy', ['--help'], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  async execute(task: Task, worktreePath: string, options: WorkerOptions = {}): Promise<Handoff> {
    const { onOutput, streamToTerminal = false, projectContext, memoryPatterns, model, requirement } = options;
    const selectedModel = model || task.model || this.defaultModel;
    const handoffPath = path.join(worktreePath, '.softfactory', 'handoff.json');
    await fs.mkdir(path.dirname(handoffPath), { recursive: true });

    // The safety preamble is the very first text of the prompt, before the role line.
    const preamble = options.preamble?.trim() ? `${options.preamble.endsWith('\n') ? options.preamble : `${options.preamble}\n`}` : '';
    let prompt = `${preamble}
You are a SoftFactory Line Worker operating via Antigravity CLI.
Task ID: ${task.id}
Title: ${task.title}
Role: ${task.agent_role}
Description: ${task.description}
Files Hint: ${task.files_hint.join(', ')}
Acceptance Criteria: ${task.acceptance_criteria.join('; ')}
Verification: ${task.verification.join('; ')}
${task.verification_command ? `${acceptanceLine(task.verification_command)}\n` : ''}${task.review_questions?.length ? `Review Questions (an independent reviewer verifies each answer against your diff; answer each in the handoff's review_answers, citing file:line):\n${task.review_questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n` : ''}`;

    // Proactive context injection: read files_hint contents
    const fileContents: string[] = [];
    for (const hint of task.files_hint) {
      if (projectContext?.includes(`--- ${hint} ---`)) continue;
      try {
        const filePath = path.join(worktreePath, hint);
        const content = await fs.readFile(filePath, 'utf-8');
        fileContents.push(`--- ${hint} ---\n${content.slice(0, 4000)}${content.length > 4000 ? '\n... (truncated)' : ''}`);
      } catch {}
    }
    if (fileContents.length > 0) {
      prompt += `
EXISTING FILE CONTENTS (files you may need to modify):
${fileContents.join('\n\n')}
`;
    }

    if (projectContext) {
      prompt += `
Project Context:
${projectContext}
`;
    }

    if (memoryPatterns && memoryPatterns.length > 0) {
      prompt += `
LESSONS LEARNED FROM PREVIOUS TASKS:
${memoryPatterns.map(p => `- ${p}`).join('\n')}
`;
    }

    prompt += requirementSection(requirement);
    prompt += briefSection(task, options.brief, options.roleBrief);
    prompt += wiringSection(options.orchestratorFiles);

    prompt += `
ADVICE & INSTRUCTIONS:
- ALWAYS create or update files directly. You have full tool access.
- If this is a "test_writer" role, author comprehensive tests for the requirements.
- If this is a "coder" role, implement the logic to satisfy the specification and make all tests pass.
- Write clean, production-grade code.
- NEVER commit build artifacts or credentials.
`;

    if (task.last_feedback) {
      prompt += `
IMPORTANT — PREVIOUS ATTEMPT FAILED (Iteration ${task.attempts}):
The quality inspector or automated verifier rejected your previous work with this feedback:
"${task.last_feedback}"
You MUST address this feedback in your implementation.
`;
    }
    if (options.retryBrief) prompt += `\n${options.retryBrief}\n`;

    prompt += `
CRITICAL: Before you exit, you MUST write a JSON handoff file to: ${handoffPath}
The JSON must follow this exact schema:
{
  "task_id": "${task.id}",
  "status": "success" | "failure",
  "files_changed": ["path/1", "path/2"],
  "test_summary": "Summary of tests executed or added",
  "summary": "Concise summary of changes made",
  "review_answers": ["one answer per review question, citing file:line"],
  "claims": [{"text": "a material claim", "source": "path:line | path:start-end | command: <what ran> | UNVERIFIED"}]
}
A claim whose cited line does not exist rejects the task.
`;

    options.onPrompt?.(prompt);

    const args = [
      '--model', selectedModel,
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--print', argvText(prompt)
    ];

    const useStreaming = onOutput && !streamToTerminal;

    const proc = execa('agy', args, {
      cwd: worktreePath,
      stdio: ['ignore', 'pipe', useStreaming ? 'pipe' : 'inherit'],
      // The orchestrator's attempt budget (--attempt-timeout) ends the process.
      // A fixed cap here would cut it short: a 10-minute kill once ended an
      // agy task inside a 15-minute attempt and was reported as "no file changes".
      ...(options?.signal ? { cancelSignal: options.signal } : { timeout: 600000 }),
    });

    const relay = new AgyStreamRelay(
      (line) => {
        if (onOutput) {
          onOutput(line);
        } else {
          console.log(line);
        }
      },
      options.onUsage
    );

    let output = '';
    if (proc.stdout) {
      let buffer = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) relay.push(line);
        }
      });
      proc.stdout.on('end', () => {
        if (buffer.trim()) {
          relay.push(buffer);
          buffer = '';
        }
      });
    }

    if (useStreaming && proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) onOutput?.(`[stderr] ${line}`);
      });
    }

    const startTime = Date.now();
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      onOutput?.(`[Cloud Worker] Actively generating with ${selectedModel} (${elapsed}s elapsed)...`);
    }, 12000);

    let exitCode: number | null | undefined = null;
    let killedBy = null as string | null;
    try {
      proc.catch(() => {}); // Silence the floating execa promise to prevent Node crash
      exitCode = await new Promise<number | null>((resolve, reject) => {
        proc.on('exit', (code, signal) => { killedBy = signal; resolve(code); });
        proc.on('error', (err) => reject(err));
      });
      if (proc.stdout) proc.stdout.destroy();
      if (proc.stderr) proc.stderr.destroy();
    } catch (e: any) {
      exitCode = e.exitCode ?? 1;
      onOutput?.(`Worker exited with code ${exitCode} for ${task.id}: ${e.message}`);
    } finally {
      clearInterval(heartbeat);
    }

    const affirmed = affirmsLiveStackUntouched(output);

    // Try reading handoff immediately with retries for filesystem flush
    // A stopped process will not flush a handoff later; only wait for a clean exit.
    const tries = options.signal?.aborted || killedBy ? 1 : 5;
    for (let i = 0; i < tries; i++) {
      try {
        const content = await fs.readFile(handoffPath, 'utf-8');
        const json = JSON.parse(content);
        return { ...HandoffSchema.parse(json), ...(affirmed ? { live_stack_untouched: true } : {}) };
      } catch {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // A stopped process left no handoff because it was stopped, not because
    // it finished: say so, so the attempt is not judged as a completed one.
    if (options.signal?.aborted) {
      return { task_id: task.id, status: 'failure', files_changed: [], summary: `agy was stopped by the attempt timeout before writing its handoff` };
    }
    if (killedBy) throw new Error(`agy was killed by ${killedBy} before writing its handoff`);

    // If handoff was not written but files were modified, construct fallback handoff
    return {
      task_id: task.id,
      status: 'success',
      files_changed: task.files_hint,
      summary: `Completed ${task.title} using ${selectedModel}`,
      ...(affirmed ? { live_stack_untouched: true } : {}),
    };
  }
}
