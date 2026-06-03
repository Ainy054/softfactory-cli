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

    // Stage 2 & 3: Parallel Workshop & Inspection Loop
    while (this.hasUnfinishedTasks()) {
      const readyTasks = this.getReadyTasks();
      if (readyTasks.length === 0) {
        this.log('No ready tasks — possible deadlock or all retries exhausted.');
        break;
      }

      const currentPhase = Math.min(...readyTasks.map(t => t.phase));
      this.emitEvent({ type: 'phase:start', phase: currentPhase });
      this.log(`Phase ${currentPhase}: Running ${readyTasks.length} task(s) in parallel`);

      // Execute all ready tasks in parallel
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

      // Cleanup all worktrees from this batch
      for (const task of readyTasks) {
        const branchName = `line/${task.id}`;
        await this.worktreeManager.cleanup(task.id, branchName);
      }

      await this.saveState();
    }

    const hasFailed = this.state.tasks.some(t => t.status === 'failed' || t.status === 'rejected');
    this.state.status = hasFailed ? 'failed' : 'completed';
    await this.saveState();

    this.emitEvent({ type: 'build:complete', status: this.state.status, feature: this.state.feature });
    this.log(`Build ${this.state.status}: ${this.state.feature}`);
  }

  private async executeAndInspect(task: Task): Promise<TaskResult | null> {
    this.log(`Workshop: Running ${task.id} - ${task.title}`);
    task.status = 'active';
    this.emitEvent({ type: 'task:start', task });
    await this.saveState();

    const branchName = `line/${task.id}`;
    const worktreePath = await this.worktreeManager.create(task.id, branchName);

    try {
      const handoff = await this.worker.execute(task, worktreePath, {
        streamToTerminal: this.streamToTerminal,
        onOutput: (line) => {
          this.emitEvent({ type: 'worker:output', taskId: task.id, line });
        },
      });

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
        this.emitEvent({ type: 'task:fail', task, feedback: review.feedback });
        return null;
      }
    } catch (e: any) {
      this.log(`Error running task ${task.id}: ${e.message || e}`);
      task.status = 'failed';
      task.attempts++;
      this.emitEvent({ type: 'task:fail', task, feedback: e.message });
      return null;
    }
  }

  private getReadyTasks(): Task[] {
    const doneTasks = new Set(
      this.state.tasks.filter(t => t.status === 'done').map(t => t.id)
    );

    const eligible = this.state.tasks.filter(t => {
      if (t.status !== 'pending' && !(t.status === 'failed' && t.attempts < 3)) return false;

      // All dependencies and blockers must be done
      const allDepsResolved = [...t.dependencies, ...t.blockedBy].every(dep => doneTasks.has(dep));
      if (!allDepsResolved) return false;

      // All tasks in earlier phases must be done
      const earlierPhaseTasks = this.state.tasks.filter(other => other.phase < t.phase);
      const allEarlierDone = earlierPhaseTasks.every(other => other.status === 'done');
      return allEarlierDone;
    });

    return eligible;
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
