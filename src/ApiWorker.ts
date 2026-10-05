import fs from 'node:fs/promises';
import path from 'node:path';
import { Handoff, HandoffSchema, Task } from './types.js';
import { IWorker, WorkerOptions } from './IWorker.js';

export type ApiProvider = 'openai' | 'anthropic';

export class ApiWorker implements IWorker {
  id: string;
  name: string;

  constructor(private provider: ApiProvider, private defaultModel: string) {
    this.id = `${provider}-cloud`;
    this.name = `${provider === 'openai' ? 'OpenAI' : 'Anthropic'} Cloud Worker`;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(process.env[this.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY']);
  }

  async execute(task: Task, worktreePath: string, options: WorkerOptions = {}): Promise<Handoff> {
    const model = options.model || task.model || this.defaultModel;
    const handoffPath = path.join(worktreePath, '.softfactory', 'handoff.json');
    await fs.mkdir(path.dirname(handoffPath), { recursive: true });
    options.onOutput?.(`[Cloud Worker] Starting ${task.id} with ${this.provider}/${model}`);

    const prompt = `You are an autonomous software engineer in a git worktree. Implement this task directly by returning complete files only.
Task ID: ${task.id}
Title: ${task.title}
Role: ${task.agent_role}
Description: ${task.description}
Files hint: ${task.files_hint.join(', ')}
Acceptance criteria: ${task.acceptance_criteria.join('; ')}
Verification: ${task.verification.join('; ')}
${task.verification_command ? `Acceptance command (run verbatim by the orchestrator after you finish; make it pass): ${task.verification_command}` : ''}
${task.review_questions?.length ? `Review questions (an independent reviewer verifies each answer against your diff; answer each in the handoff's review_answers, citing file:line):\n${task.review_questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}` : ''}
${task.last_feedback ? `Previous feedback: ${task.last_feedback}` : ''}
${options.memoryPatterns?.length ? `Verified project lessons:\n${options.memoryPatterns.map(x => `- ${x}`).join('\n')}` : ''}

For every changed file return exactly:
<<<FILE:relative/path>>>
full contents
<<<END_FILE>>>
Do not use absolute paths or ../. Also return .softfactory/handoff.json with task_id "${task.id}", status, files_changed, summary and, if there were review questions, review_answers.`;
    const response = await this.request(prompt, model);
    const files = await this.writeFiles(worktreePath, response, options.onOutput);

    try {
      return HandoffSchema.parse(JSON.parse(await fs.readFile(handoffPath, 'utf-8')));
    } catch {
      return { task_id: task.id, status: files.length ? 'success' : 'failure', files_changed: files, summary: `Completed with ${this.provider}/${model}` };
    }
  }

  private async request(prompt: string, model: string): Promise<string> {
    if (this.provider === 'openai') {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: prompt, store: false }),
      });
      if (!response.ok) throw new Error(`OpenAI request failed: ${await response.text()}`);
      const data: any = await response.json();
      return data.output_text || data.output?.flatMap((item: any) => item.content || []).map((part: any) => part.text || '').join('') || '';
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 16000, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) throw new Error(`Anthropic request failed: ${await response.text()}`);
    const data: any = await response.json();
    return data.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('') || '';
  }

  private async writeFiles(worktreePath: string, response: string, onOutput?: (line: string) => void): Promise<string[]> {
    const root = path.resolve(worktreePath);
    const files: string[] = [];
    const matcher = /<<<FILE:([^>]+)>>>([\s\S]*?)(?:<<<END_FILE>>>|(?=<<<FILE:)|$)/g;
    for (const match of response.matchAll(matcher)) {
      const relativePath = match[1].trim();
      const target = path.resolve(root, relativePath);
      if (!relativePath || !target.startsWith(`${root}${path.sep}`)) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, match[2].trim() + '\n', 'utf8');
      if (relativePath !== '.softfactory/handoff.json') files.push(relativePath);
      onOutput?.(`[Cloud Worker] Wrote ${relativePath}`);
    }
    return files;
  }
}
