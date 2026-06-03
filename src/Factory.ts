import fs from 'node:fs/promises';
import path from 'node:path';
import { FactoryState, FactoryStateSchema, Task } from './types.js';
import { WorktreeManager } from './WorktreeManager.js';
import { GeminiClient } from './GeminiClient.js';
import { ClaudeWorker } from './ClaudeWorker.js';
import { execa } from 'execa';

export class Factory {
  private state!: FactoryState;
  private statePath: string;
  private worktreeManager: WorktreeManager;
  private gemini: GeminiClient;
  private worker: ClaudeWorker;

  constructor(
    private baseDir: string,
    apiKey: string,
    proModel?: string,
    flashModel?: string
  ) {
    this.statePath = path.join(baseDir, '.softfactory', 'factory.json');
    this.worktreeManager = new WorktreeManager(baseDir);
    this.gemini = new GeminiClient(apiKey, proModel, flashModel);
    this.worker = new ClaudeWorker();
  }

  async init() {
    await fs.mkdir(path.join(this.baseDir, '.softfactory'), { recursive: true });
    await this.worktreeManager.init();
    
    if (await this.exists(this.statePath)) {
      const content = await fs.readFile(this.statePath, 'utf-8');
      this.state = FactoryStateSchema.parse(JSON.parse(content));
    }
  }

  async build(requirement: string) {
    console.log(`[SoftFactory] Starting build for: ${requirement}`);
    
    // 1. Stage 1: Blueprint
    if (!this.state || this.state.status === 'planning') {
      const codebaseContext = await this.getRepoContext();
      const memoryPatterns = await this.getMemoryPatterns();
      
      const blueprint = await this.gemini.generateBlueprint(requirement, codebaseContext, memoryPatterns);
      
      this.state = {
        feature: blueprint.feature,
        status: 'active',
        created_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        tasks: blueprint.tasks.map((t: any) => ({ ...t, status: 'pending', attempts: 0 })),
        memory_patterns: []
      };
      await this.saveState();
    }

    // 2. Stage 2 & 3: Workshop & Inspection Loop
    while (this.hasPendingTasks()) {
      const nextTask = this.getNextTask();
      if (!nextTask) break;

      await this.runTask(nextTask);
    }

    this.state.status = 'completed';
    await this.saveState();
    console.log(`[SoftFactory] Feature completed: ${this.state.feature}`);
  }

  private async runTask(task: Task) {
    console.log(`[SoftFactory] Workshop: Running ${task.id} - ${task.title}`);
    task.status = 'active';
    await this.saveState();

    const branchName = `line/${task.id}`;
    const worktreePath = await this.worktreeManager.create(task.id, branchName);

    try {
      const handoff = await this.worker.execute(task, worktreePath);
      
      console.log(`[SoftFactory] Inspection: Reviewing ${task.id}`);
      const diff = await this.getDiff(branchName);
      const review = await this.gemini.inspectTask(task, diff, handoff.summary);

      if (review.verdict === 'PASS') {
        console.log(`[SoftFactory] PASSED: ${task.id}`);
        await this.worktreeManager.merge(task.id, branchName);
        task.status = 'done';
      } else {
        console.warn(`[SoftFactory] FAILED: ${task.id}. Feedback: ${review.feedback}`);
        task.status = 'failed';
        task.attempts++;
      }
    } catch (e) {
      console.error(`Error running task ${task.id}:`, e);
      task.status = 'failed';
    } finally {
      await this.worktreeManager.cleanup(task.id, branchName);
      await this.saveState();
    }
  }

  private async getRepoContext(): Promise<string> {
    // Simple context: list files and README
    const { stdout: files } = await execa('git', ['ls-files'], { cwd: this.baseDir });
    let readme = "";
    try {
      readme = await fs.readFile(path.join(this.baseDir, 'README.md'), 'utf-8');
    } catch (e) {}

    return `Files:\n${files}\n\nREADME:\n${readme}`;
  }

  private async getMemoryPatterns(): Promise<string> {
    try {
      return await fs.readFile(path.join(this.baseDir, '.softfactory', 'FACTORY_MEMORY.md'), 'utf-8');
    } catch (e) {
      return "No patterns yet.";
    }
  }

  private async getDiff(branch: string): Promise<string> {
    const { stdout } = await execa('git', ['diff', 'main...' + branch], { cwd: this.baseDir });
    return stdout;
  }

  private async saveState() {
    this.state.last_updated = new Date().toISOString();
    await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2));
  }

  private hasPendingTasks() {
    return this.state.tasks.some(t => t.status === 'pending' || t.status === 'failed');
  }

  private getNextTask() {
    return this.state.tasks.find(t => t.status === 'pending' || (t.status === 'failed' && t.attempts < 3));
  }

  private async exists(p: string) {
    try {
      await fs.access(p);
      return true;
    } catch (e) {
      return false;
    }
  }
}
