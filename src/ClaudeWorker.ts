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
// Proactive context injection: read files_hint contents so the worker
// doesn't spend tool calls reading files it was already told to modify.
// We skip files that are likely already in projectContext (like package.json)
// to avoid redundancy, unless they are the primary target.
const fileContents: string[] = [];
for (const hint of task.files_hint) {
  if (projectContext?.includes(`--- ${hint} ---`)) continue; 

  try {
    const filePath = path.join(worktreePath, hint);
    const content = await fs.readFile(filePath, 'utf-8');
    // Limit to 4000 chars to keep context manageable
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

prompt += `
ADVICE:
- Start by exploring the codebase if you need more context.
- ALWAYS create a plan before you start writing code.
- If this is a "test_writer" role, focus ONLY on creating robust tests (unit/integration).
- If this is a "coder" role, focus on implementing the logic to pass the tests.
`;

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

    let exitCode: number | null | undefined = null;
    try {
      const result = await proc;
      exitCode = result.exitCode;
    } catch (e: any) {
      exitCode = e.exitCode ?? 1;
      onOutput?.(`Claude exited with code ${exitCode} for ${task.id}`);
    }

    // Try reading handoff immediately — the file should exist after process exit
    try {
      const content = await fs.readFile(handoffPath, 'utf-8');
      const json = JSON.parse(content);
      return HandoffSchema.parse(json);
    } catch {}

    // Brief retry window (5s) for filesystem flush delays
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const content = await fs.readFile(handoffPath, 'utf-8');
        const json = JSON.parse(content);
        return HandoffSchema.parse(json);
      } catch {}
    }

    throw new Error(`Worker exited (code ${exitCode}) without writing handoff file for ${task.id}.`);
  }
}
