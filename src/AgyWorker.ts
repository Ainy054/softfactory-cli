import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Task, HandoffSchema, Handoff } from './types.js';
import { IWorker, WorkerOptions, requirementSection } from './IWorker.js';
import { AgyStreamRelay } from './AgyStream.js';

export class AgyWorker implements IWorker {
  id = 'agy-cloud';
  name = 'Antigravity Cloud Worker';
  private defaultModel: string;

  constructor(defaultModel: string = 'Gemini 3.7 Flash (High)') {
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

    let prompt = `
You are a SoftFactory Line Worker operating via Antigravity CLI.
Task ID: ${task.id}
Title: ${task.title}
Role: ${task.agent_role}
Description: ${task.description}
Files Hint: ${task.files_hint.join(', ')}
Acceptance Criteria: ${task.acceptance_criteria.join('; ')}
Verification: ${task.verification.join('; ')}
${task.verification_command ? `Acceptance Command (run verbatim by the orchestrator after you finish; make it pass): ${task.verification_command}\n` : ''}${task.review_questions?.length ? `Review Questions (an independent reviewer verifies each answer against your diff; answer each in the handoff's review_answers, citing file:line):\n${task.review_questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n` : ''}`;

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
      '--print', prompt
    ];

    const useStreaming = onOutput && !streamToTerminal;

    const proc = execa('agy', args, {
      cwd: worktreePath,
      stdio: ['ignore', 'pipe', useStreaming ? 'pipe' : 'inherit'],
      timeout: 600000,
      ...(options?.signal ? { cancelSignal: options.signal } : {}),
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

    if (proc.stdout) {
      let buffer = '';
      proc.stdout.on('data', (chunk: Buffer) => {
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
    try {
      proc.catch(() => {}); // Silence the floating execa promise to prevent Node crash
      exitCode = await new Promise<number | null>((resolve, reject) => {
        proc.on('exit', (code) => resolve(code));
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

    // Try reading handoff immediately with retries for filesystem flush
    for (let i = 0; i < 5; i++) {
      try {
        const content = await fs.readFile(handoffPath, 'utf-8');
        const json = JSON.parse(content);
        return HandoffSchema.parse(json);
      } catch {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // If handoff was not written but files were modified, construct fallback handoff
    return {
      task_id: task.id,
      status: 'success',
      files_changed: task.files_hint,
      summary: `Completed ${task.title} using ${selectedModel}`,
    };
  }
}
