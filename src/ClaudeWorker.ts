import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Task, HandoffSchema, Handoff } from './types.js';

export interface WorkerOptions {
  onOutput?: (line: string) => void;
  streamToTerminal?: boolean;
  projectContext?: string;
}

export class ClaudeWorker {
  async execute(task: Task, worktreePath: string, options: WorkerOptions = {}): Promise<Handoff> {
    const { onOutput, streamToTerminal = false, projectContext } = options;
    const handoffPath = path.join(worktreePath, '.softfactory', 'handoff.json');
    await fs.mkdir(path.dirname(handoffPath), { recursive: true });

    let prompt = `
You are a SoftFactory Line Worker (Claude CLI).
Task ID: ${task.id}
Title: ${task.title}
Description: ${task.description}
Files Hint: ${task.files_hint.join(', ')}
`;

    if (projectContext) {
      prompt += `
Project Context:
${projectContext}
`;
    }

    prompt += `
RULES:
- NEVER commit node_modules/, dist/, .env, or build artifacts. They belong in .gitignore.
- If you run npm install or any package manager, the dependencies are for runtime only — do NOT stage node_modules.
- Respect the existing .gitignore file.
- Write clean, production-quality code.
`;

    if (task.last_feedback) {
      prompt += `
IMPORTANT — PREVIOUS ATTEMPT FAILED (attempt ${task.attempts}/3):
The quality inspector rejected your previous work with this feedback:
"${task.last_feedback}"
You MUST address this feedback in your implementation. Do NOT repeat the same mistake.
`;
    }

    prompt += `
CRITICAL: Before you exit, you MUST write a JSON handoff file to: ${handoffPath}
The JSON must follow this schema:
{
  "task_id": "${task.id}",
  "status": "success" | "failure",
  "files_changed": ["path/1", "path/2"],
  "test_summary": "Optional summary of tests run",
  "summary": "Brief summary of what was done"
}

You have full tool access in this worktree. Begin.
`;

    const command = 'npx';
    const args = ['--yes', '@anthropic-ai/claude-code', '--print', '--dangerously-skip-permissions', prompt];

    const useStreaming = onOutput && !streamToTerminal;

    const proc = execa(command, args, {
      cwd: worktreePath,
      stdio: useStreaming ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });

    if (useStreaming && proc.stdout) {
      let buffer = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) onOutput(line);
        }
      });
    }

    if (useStreaming && proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) onOutput?.(`[stderr] ${line}`);
      });
    }

    try {
      await proc;
    } catch (e) {
      onOutput?.(`Claude execution error for ${task.id}`);
    }

    // Poll for handoff file (up to 30 seconds)
    let attempts = 0;
    while (attempts < 30) {
      try {
        const content = await fs.readFile(handoffPath, 'utf-8');
        const json = JSON.parse(content);
        return HandoffSchema.parse(json);
      } catch {
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    throw new Error(`Handoff file not found at ${handoffPath} after task completion.`);
  }
}
