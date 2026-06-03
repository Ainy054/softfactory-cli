import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { FactoryState, FactoryStateSchema, Task, TaskResult, FactoryEvent } from './types.js';
import { WorktreeManager } from './WorktreeManager.js';
import { GeminiClient } from './GeminiClient.js';
import { ClaudeWorker } from './ClaudeWorker.js';
import { execa } from 'execa';

export class Factory extends EventEmitter {
  private state!: FactoryState;
  private statePath: string;
  private worktreeManager: WorktreeManager;
  private gemini: GeminiClient;
  private worker: ClaudeWorker;
  private defaultBranch = 'master';
  private streamToTerminal: boolean;

  constructor(
    private baseDir: string,
    apiKey: string,
    options: {
      proModel?: string;
      flashModel?: string;
      streamToTerminal?: boolean;
    } = {}
  ) {
    super();
    const {
      proModel = 'gemini-3.1-pro-preview',
      flashModel = 'gemini-3.5-flash',
      streamToTerminal = false,
    } = options;
    this.statePath = path.join(baseDir, '.softfactory', 'factory.json');
    this.worktreeManager = new WorktreeManager(baseDir);
    this.gemini = new GeminiClient(apiKey, proModel, flashModel);
    this.worker = new ClaudeWorker();
    this.streamToTerminal = streamToTerminal;
  }

  async init() {
    await fs.mkdir(path.join(this.baseDir, '.softfactory'), { recursive: true });
    await this.worktreeManager.init();

    this.defaultBranch = await this.worktreeManager.getDefaultBranch();

    if (await this.exists(this.statePath)) {
      const content = await fs.readFile(this.statePath, 'utf-8');
      this.state = FactoryStateSchema.parse(JSON.parse(content));

      // Reset any 'active' tasks to 'pending' as they were interrupted
      for (const task of this.state.tasks) {
        if (task.status === 'active') {
          task.status = 'pending';
        }
      }
      await this.saveState();
    }
  }

  getState(): FactoryState | undefined {
    return this.state;
  }

  async resume() {
    if (!this.state) {
      this.log('No previous build state found. Nothing to resume.');
      return;
    }

    const failed = this.state.tasks.filter(t => t.status === 'failed' || t.status === 'rejected');
    if (failed.length === 0) {
      this.log('No failed tasks to resume.');
      return;
    }

    this.log(`Resuming build: ${this.state.feature}`);
    this.log(`Resetting ${failed.length} failed/rejected task(s) for retry`);

    for (const task of failed) {
      task.status = 'pending';
      task.attempts = 0;
      task.last_feedback = undefined;
    }

    this.state.status = 'active';
    await this.saveState();
    this.emitEvent({ type: 'state:update', state: this.state });

    // Run the workshop/inspection loop (skip blueprint stage)
    await this.runWorkshopLoop();
  }

  async build(requirement: string) {
    this.log(`Starting build for: ${requirement}`);

    // Stage 1: Blueprint
    if (!this.state || this.state.status === 'planning') {
      const codebaseContext = await this.getRepoContext();
      const memoryPatterns = await this.getMemoryPatterns();

      const blueprint = await this.gemini.generateBlueprint(requirement, codebaseContext, memoryPatterns);

      this.state = {
        feature: blueprint.feature,
        status: 'active',
        created_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        tasks: blueprint.tasks.map((t: any) => ({ ...t, status: 'pending' as const, attempts: 0 })),
        memory_patterns: []
      };
      await this.saveState();
    }

    this.emitEvent({ type: 'state:update', state: this.state });

    await this.runWorkshopLoop();
  }

  private async runWorkshopLoop() {
    while (this.hasUnfinishedTasks()) {
      const readyTasks = this.getReadyTasks();
      if (readyTasks.length === 0) {
        this.log('No ready tasks — possible deadlock or all retries exhausted.');
        break;
      }

      const currentPhase = Math.min(...readyTasks.map(t => t.phase));
      this.emitEvent({ type: 'phase:start', phase: currentPhase });
      this.log(`Phase ${currentPhase}: Running ${readyTasks.length} task(s) in parallel`);

      const results = await Promise.allSettled(
        readyTasks.map(task => this.executeAndInspect(task))
      );

      // Merge passed tasks sequentially (git isn't concurrent-safe)
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          const { task, branchName } = result.value;
          try {
            await this.worktreeManager.merge(task.id, branchName, this.defaultBranch);
            task.status = 'done';
            this.emitEvent({ type: 'task:done', task });
            this.log(`MERGED: ${task.id} - ${task.title}`);
          } catch (e: any) {
            task.status = 'failed';
            task.attempts++;
            this.log(`MERGE FAILED: ${task.id}: ${e.message}`);
            this.emitEvent({ type: 'task:fail', task, feedback: `Merge failed: ${e.message}` });
          }
        }
      }

      for (const task of readyTasks) {
        const branchName = `line/${task.id}`;
        await this.worktreeManager.cleanup(task.id, branchName);
      }

      await this.saveState();
    }

    const failedTasks = this.state.tasks.filter(t => t.status === 'failed' || t.status === 'rejected');
    const doneTasks = this.state.tasks.filter(t => t.status === 'done');
    this.state.status = failedTasks.length > 0 ? 'failed' : 'completed';
    await this.saveState();

    this.emitEvent({ type: 'build:complete', status: this.state.status, feature: this.state.feature });
    if (failedTasks.length > 0) {
      this.log(`Build partial: ${doneTasks.length}/${this.state.tasks.length} tasks completed, ${failedTasks.length} failed/skipped`);
      for (const t of failedTasks) {
        this.log(`  - ${t.id} ${t.title}: ${t.status}${t.last_feedback ? ` (${t.last_feedback.slice(0, 100)})` : ''}`);
      }
    } else {
      this.log(`Build completed: ${this.state.feature}`);
    }
  }

  private async executeAndInspect(task: Task): Promise<TaskResult | null> {
    this.log(`Workshop: Running ${task.id} - ${task.title}`);
    task.status = 'active';
    this.emitEvent({ type: 'task:start', task });
    await this.saveState();

    const branchName = `line/${task.id}`;
    const worktreePath = await this.worktreeManager.create(task.id, branchName);

    try {
      const projectContext = await this.getProjectContext(worktreePath);
      const handoff = await this.worker.execute(task, worktreePath, {
        streamToTerminal: this.streamToTerminal,
        projectContext,
        onOutput: (line) => {
          this.emitEvent({ type: 'worker:output', taskId: task.id, line });
        },
      });

      // Commit changes in worktree so diff is visible for inspection
      await this.worktreeManager.commitWorktree(task.id);

      this.log(`Inspection: Reviewing ${task.id}`);
      const diff = await this.getDiff(branchName);
      const review = await this.gemini.inspectTask(task, diff, handoff.summary);

      if (review.verdict === 'PASS') {
        this.log(`PASSED: ${task.id}`);
        return { task, branchName };
      } else {
        this.log(`FAILED: ${task.id}. Feedback: ${review.feedback}`);
        task.status = 'failed';
        task.attempts++;
        task.last_feedback = review.feedback;
        this.emitEvent({ type: 'task:fail', task, feedback: review.feedback });
        return null;
      }
    } catch (e: any) {
      this.log(`Error running task ${task.id}: ${e.message || e}`);
      task.status = 'failed';
      task.attempts++;
      task.last_feedback = e.message;
      this.emitEvent({ type: 'task:fail', task, feedback: e.message });
      return null;
    }
  }

  private getReadyTasks(): Task[] {
    const doneTasks = new Set(
      this.state.tasks.filter(t => t.status === 'done').map(t => t.id)
    );
    const terminallyFailed = new Set(
      this.state.tasks
        .filter(t => t.status === 'rejected' || (t.status === 'failed' && t.attempts >= 3))
        .map(t => t.id)
    );

    // Mark tasks blocked by terminally failed dependencies as 'rejected'
    for (const task of this.state.tasks) {
      if (task.status === 'pending' || (task.status === 'failed' && task.attempts < 3)) {
        const deps = [...task.dependencies, ...task.blockedBy];
        const blockedByExhausted = deps.some(dep => terminallyFailed.has(dep));
        if (blockedByExhausted) {
          task.status = 'rejected';
          this.log(`SKIPPED: ${task.id} - ${task.title} (dependency exhausted retries)`);
          this.emitEvent({ type: 'task:fail', task, feedback: 'Skipped: dependency failed permanently' });
        }
      }
    }

    const eligible = this.state.tasks.filter(t => {
      if (t.status !== 'pending' && !(t.status === 'failed' && t.attempts < 3)) return false;

      // All dependencies and blockers must be done
      const allDepsResolved = [...t.dependencies, ...t.blockedBy].every(dep => doneTasks.has(dep));
      if (!allDepsResolved) return false;

      // All tasks in earlier phases must be done or permanently settled
      const earlierPhaseTasks = this.state.tasks.filter(other => other.phase < t.phase);
      const allEarlierSettled = earlierPhaseTasks.every(
        other => other.status === 'done' || other.status === 'rejected' || (other.status === 'failed' && other.attempts >= 3)
      );
      return allEarlierSettled;
    });

    return eligible;
  }

  private async getProjectContext(worktreePath: string): Promise<string> {
    const parts: string[] = [];

    // Include .gitignore
    try {
      const gitignore = await fs.readFile(path.join(worktreePath, '.gitignore'), 'utf-8');
      parts.push(`.gitignore:\n${gitignore}`);
    } catch {}

    // Include file listing
    try {
      const { stdout } = await execa('git', ['ls-files'], { cwd: worktreePath });
      if (stdout.trim()) parts.push(`Tracked files:\n${stdout}`);
    } catch {}

    // Include package.json if it exists
    try {
      const pkg = await fs.readFile(path.join(worktreePath, 'package.json'), 'utf-8');
      parts.push(`package.json:\n${pkg}`);
    } catch {}

    return parts.join('\n\n');
  }

  private async getRepoContext(): Promise<string> {
    const { stdout: files } = await execa('git', ['ls-files'], { cwd: this.baseDir });
    let readme = '';
    try {
      readme = await fs.readFile(path.join(this.baseDir, 'README.md'), 'utf-8');
    } catch {}

    return `Files:\n${files}\n\nREADME:\n${readme}`;
  }

  private async getMemoryPatterns(): Promise<string> {
    try {
      return await fs.readFile(path.join(this.baseDir, '.softfactory', 'FACTORY_MEMORY.md'), 'utf-8');
    } catch {
      return 'No patterns yet.';
    }
  }

  private async getDiff(branch: string): Promise<string> {
    const { stdout } = await execa('git', ['diff', `${this.defaultBranch}...${branch}`], { cwd: this.baseDir });
    return stdout;
  }

  private async saveState() {
    this.state.last_updated = new Date().toISOString();
    await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2));
    this.emitEvent({ type: 'state:update', state: this.state });
  }

  private hasUnfinishedTasks() {
    return this.state.tasks.some(
      t => t.status === 'pending' || t.status === 'active' || (t.status === 'failed' && t.attempts < 3)
    );
  }

  private async exists(p: string) {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private emitEvent(event: FactoryEvent) {
    this.emit(event.type, event);
  }

  private log(msg: string) {
    this.emit('log', msg);
    if (this.streamToTerminal) {
      console.log(`[SoftFactory] ${msg}`);
    }
  }
}
