import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Task, HandoffSchema, Handoff } from './types.js';

export class ClaudeWorker {
  constructor() {}

  async execute(task: Task, worktreePath: string): Promise<Handoff> {
    const handoffPath = path.join(worktreePath, '.softfactory', 'handoff.json');
    await fs.mkdir(path.dirname(handoffPath), { recursive: true });

    const prompt = `
You are a SoftFactory Line Worker (Claude CLI).
Task ID: ${task.id}
Title: ${task.title}
Description: ${task.description}
Files Hint: ${task.files_hint.join(', ')}

Your goal is to implement this task. 
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

    // Start the Claude process
    const process = execa('claude', ['-p', prompt], {
      cwd: worktreePath,
      stdio: 'inherit', // Stream output to terminal
    });

    try {
      await process;
    } catch (e) {
      console.error(`Claude execution failed for ${task.id}:`, e);
    }

    // Wait for handoff file (polling for up to 30 seconds after process ends if not found)
    let attempts = 0;
    while (attempts < 10) {
      try {
        const content = await fs.readFile(handoffPath, 'utf-8');
        const json = JSON.parse(content);
        return HandoffSchema.parse(json);
      } catch (e) {
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    throw new Error(`Handoff file not found at ${handoffPath} after task completion.`);
  }
}
