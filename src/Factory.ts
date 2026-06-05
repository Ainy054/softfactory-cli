import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { FactoryState, FactoryStateSchema, Task, TaskResult, FactoryEvent, FeatureHistoryEntry } from './types.js';
import { WorktreeManager } from './WorktreeManager.js';
import { GeminiClient } from './GeminiClient.js';
import { ClaudeWorker } from './ClaudeWorker.js';
import { DockerVerifier } from './DockerVerifier.js';
import { execa } from 'execa';

export class Factory extends EventEmitter {
  private state!: FactoryState;
  private statePath: string;
  private historyPath: string;
  private archiveDir: string;
  private memoryPath: string;
  private worktreeManager: WorktreeManager;
  private gemini: GeminiClient;
  private worker: ClaudeWorker;
  private dockerVerifier: DockerVerifier | null = null;
  private defaultBranch = 'master';
  private streamToTerminal: boolean;
  private useDocker: boolean;
  private buildStartCommit: string | undefined;

  constructor(
    private baseDir: string,
    apiKey: string,
    options: {
      proModel?: string;
      flashModel?: string;
      streamToTerminal?: boolean;
      useDocker?: boolean;
    } = {}
  ) {
    super();
    const {
      proModel = 'gemini-3.1-pro-preview',
      flashModel = 'gemini-3.5-flash',
      streamToTerminal = false,
      useDocker = true,
    } = options;
    this.useDocker = useDocker;
    this.statePath = path.join(baseDir, '.softfactory', 'factory.json');
    this.historyPath = path.join(baseDir, '.softfactory', 'history.json');
    this.archiveDir = path.join(baseDir, '.softfactory', 'archive');
    this.memoryPath = path.join(baseDir, '.softfactory', 'FACTORY_MEMORY.md');
    this.worktreeManager = new WorktreeManager(baseDir);
    this.gemini = new GeminiClient(apiKey, proModel, flashModel);
    this.worker = new ClaudeWorker();
    this.streamToTerminal = streamToTerminal;
  }

  async init() {
    await fs.mkdir(path.join(this.baseDir, '.softfactory'), { recursive: true });
    await fs.mkdir(this.archiveDir, { recursive: true });
    await this.worktreeManager.init();

    this.defaultBranch = await this.worktreeManager.getDefaultBranch();

    if (this.useDocker) {
      const verifier = new DockerVerifier();
      if (await verifier.detect()) {
        this.dockerVerifier = verifier;
        this.log('Docker verification enabled');
      } else {
        this.log('Docker not available — skipping post-build verification');
      }
    }

    if (await this.exists(this.statePath)) {
      const content = await fs.readFile(this.statePath, 'utf-8');
      this.state = FactoryStateSchema.parse(JSON.parse(content));

      if (!this.state.feature_id) {
        this.state.feature_id = this.generateFeatureId();
      }

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

  async refine(refinement: string) {
    if (!this.state) {
      this.log('No existing build to refine. Run a build first.');
      return;
    }

    if (this.state.status === 'completed') {
      this.log('Build already completed. Use a new build instead of --refine.');
      return;
    }

    const doneTasks = this.state.tasks.filter(t => t.status === 'done');
    const pendingOrFailed = this.state.tasks.filter(t => t.status !== 'done');

    this.log(`Refining plan: "${refinement}"`);
    this.log(`Preserving ${doneTasks.length} done task(s), ${pendingOrFailed.length} task(s) eligible for modification`);

    const codebaseContext = await this.getRepoContext();
    const refined = await this.gemini.refineBlueprint(refinement, this.state.tasks, codebaseContext);

    const newTasks = refined.tasks.map((t: any) => ({
      ...t,
      status: t.status || 'pending',
      attempts: t.status === 'done' ? (this.state.tasks.find(old => old.id === t.id)?.attempts ?? 0) : 0,
      dependencies: t.dependencies || [],
      blockedBy: t.blockedBy || [],
      files_hint: t.files_hint || [],
    }));

    // Verify done tasks weren't tampered with
    for (const done of doneTasks) {
      const match = newTasks.find((t: any) => t.id === done.id);
      if (!match || match.status !== 'done') {
        this.log(`WARNING: Gemini tried to modify done task ${done.id} — restoring original`);
        const idx = newTasks.findIndex((t: any) => t.id === done.id);
        if (idx >= 0) {
          newTasks[idx] = { ...done };
        } else {
          newTasks.push({ ...done });
        }
      }
    }

    const added = newTasks.filter((t: any) => !this.state.tasks.find(old => old.id === t.id));
    const removed = this.state.tasks.filter(t => t.status !== 'done' && !newTasks.find((n: any) => n.id === t.id));
    const modified = newTasks.filter((t: any) => {
      const old = this.state.tasks.find(o => o.id === t.id);
      return old && old.status !== 'done' && (old.title !== t.title || old.description !== t.description);
    });

    if (added.length) this.log(`Added ${added.length} task(s): ${added.map((t: any) => t.id).join(', ')}`);
    if (removed.length) this.log(`Removed ${removed.length} task(s): ${removed.map(t => t.id).join(', ')}`);
    if (modified.length) this.log(`Modified ${modified.length} task(s): ${modified.map((t: any) => t.id).join(', ')}`);

    this.state.feature = refined.feature || this.state.feature;
    this.state.tasks = newTasks;
    this.state.status = 'active';
    this.buildStartCommit = await this.getCurrentCommit();
    await this.saveState();
    await this.updateHistory('active');

    this.emitEvent({ type: 'state:update', state: this.state });
    await this.runWorkshopLoop();
  }

  async resume(featureId?: string) {
    if (featureId) {
      const archivePath = path.join(this.archiveDir, `${featureId}.json`);
      if (await this.exists(archivePath)) {
        const content = await fs.readFile(archivePath, 'utf-8');
        this.state = FactoryStateSchema.parse(JSON.parse(content));
        await this.saveState();
        await fs.unlink(archivePath);
        this.log(`Restored archived feature: ${this.state.feature}`);
      } else {
        this.log(`Feature ${featureId} not found in archive.`);
        return;
      }
    }

    if (!this.state) {
      this.log('No previous build state found. Nothing to resume.');
      return;
    }

    this.buildStartCommit = await this.getCurrentCommit();
    await this.validateDoneTasks();

    if (this.state.status === 'planned') {
      this.log(`Executing planned feature: ${this.state.feature}`);
      this.state.status = 'active';
      await this.saveState();
      this.emitEvent({ type: 'state:update', state: this.state });
      await this.runWorkshopLoop();
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

    await this.runWorkshopLoop();
  }

  private async validateDoneTasks() {
    let resetCount = 0;
    for (const task of this.state.tasks) {
      if (task.status !== 'done') continue;

      // Check if a merge commit for this task exists in git history
      const mergeExists = await this.mergeExistsInHistory(task.id);
      if (!mergeExists) {
        this.log(`GHOST: ${task.id} - ${task.title} (marked done but no merge found in git — resetting to pending)`);
        task.status = 'pending';
        task.attempts = 0;
        task.last_feedback = undefined;
        resetCount++;
      }
    }

    if (resetCount > 0) {
      this.log(`Validated state: ${resetCount} ghost task(s) reset to pending`);
      await this.saveState();
    }
  }

  private async mergeExistsInHistory(taskId: string): Promise<boolean> {
    try {
      const { stdout } = await execa(
        'git', ['log', '--oneline', '--all', '--grep', `softfactory: merge ${taskId}`],
        { cwd: this.baseDir }
      );
      if (stdout.trim()) return true;

      // Also check for direct commits (in case merge was fast-forward)
      const { stdout: stdout2 } = await execa(
        'git', ['log', '--oneline', '--all', '--grep', `softfactory: complete task ${taskId}`],
        { cwd: this.baseDir }
      );
      return !!stdout2.trim();
    } catch {
      return false;
    }
  }

  async plan(requirement: string) {
    if (this.state && (this.state.status === 'completed' || this.state.status === 'failed')) {
      await this.archiveCurrentState();
      this.state = undefined!;
    }

    if (this.state && this.state.status === 'active') {
      this.log(`Existing in-progress feature found: ${this.state.feature}`);
      this.log('Use --resume to continue it, or wait for it to complete/fail before planning a new one.');
      return;
    }

    this.log(`Generating plan for: ${requirement}`);

    const codebaseContext = await this.getRepoContext();
    const memoryPatterns = await this.getMemoryPatterns();
    const history = await this.getHistory();
    const featureHistory = history.length > 0
      ? history.map(f => `- ${f.feature} (${f.status}, ${f.tasks_done}/${f.task_count} tasks)`).join('\n')
      : '';

    const blueprint = await this.gemini.generateBlueprint(requirement, codebaseContext, memoryPatterns, featureHistory);

    const featureId = this.generateFeatureId();
    this.state = {
      feature_id: featureId,
      feature: blueprint.feature,
      status: 'planned',
      created_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      tasks: blueprint.tasks.map((t: any) => ({ ...t, status: 'pending' as const, attempts: 0 })),
      memory_patterns: []
    };
    await this.saveState();
    await this.updateHistory('planned');

    this.emitEvent({ type: 'state:update', state: this.state });
    this.emitEvent({ type: 'build:complete', status: 'planned', feature: this.state.feature });

    this.log(`Plan saved with ${this.state.tasks.length} task(s):`);
    for (const task of this.state.tasks) {
      const deps = [...task.dependencies, ...task.blockedBy];
      const depStr = deps.length > 0 ? ` (depends: ${deps.join(', ')})` : '';
      this.log(`  [P${task.phase}] ${task.id}: ${task.title}${depStr}`);
      this.log(`         ${task.description.slice(0, 120)}${task.description.length > 120 ? '...' : ''}`);
      if (task.files_hint.length > 0) {
        this.log(`         files: ${task.files_hint.join(', ')}`);
      }
    }
    this.log(`\nTo execute this plan: softfactory --resume`);
  }

  async build(requirement: string) {
    if (this.state && (this.state.status === 'completed' || this.state.status === 'failed')) {
      await this.archiveCurrentState();
      this.state = undefined!;
    }

    if (this.state && (this.state.status === 'active' || this.state.status === 'planned')) {
      this.log(`Resuming ${this.state.status === 'planned' ? 'planned' : 'in-progress'} feature: ${this.state.feature}`);
      this.state.status = 'active';
      await this.validateDoneTasks();
      await this.saveState();
      this.emitEvent({ type: 'state:update', state: this.state });
      await this.runWorkshopLoop();
      return;
    }

    this.log(`Starting build for: ${requirement}`);
    this.buildStartCommit = await this.getCurrentCommit();

    const codebaseContext = await this.getRepoContext();
    const memoryPatterns = await this.getMemoryPatterns();
    const history = await this.getHistory();
    const featureHistory = history.length > 0
      ? history.map(f => `- ${f.feature} (${f.status}, ${f.tasks_done}/${f.task_count} tasks)`).join('\n')
      : '';

    const blueprint = await this.gemini.generateBlueprint(requirement, codebaseContext, memoryPatterns, featureHistory);

    const featureId = this.generateFeatureId();
    this.state = {
      feature_id: featureId,
      feature: blueprint.feature,
      status: 'active',
      created_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      tasks: blueprint.tasks.map((t: any) => ({ ...t, status: 'pending' as const, attempts: 0 })),
      memory_patterns: []
    };
    await this.saveState();
    await this.updateHistory('active');

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
    await this.updateHistory(this.state.status);

    if (this.state.status === 'completed') {
      await this.runDockerVerification();
      await this.synthesizeMemory();
    }

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
      const commitResult = await this.worktreeManager.commitWorktree(task.id);

      if (!commitResult.committed) {
        this.log(`EMPTY: ${task.id} — worker produced no file changes`);
        task.status = 'failed';
        task.attempts++;
        task.last_feedback = 'Worker completed but produced no file changes. Ensure you actually create/modify files, not just describe what to do.';
        this.emitEvent({ type: 'task:fail', task, feedback: task.last_feedback });
        return null;
      }

      this.log(`Committed ${commitResult.filesChanged} file(s) for ${task.id}`);

      const diff = await this.getDiff(branchName);

      if (!diff.trim()) {
        this.log(`EMPTY DIFF: ${task.id} — commit succeeded but diff is empty (possible git state issue)`);
        task.status = 'failed';
        task.attempts++;
        task.last_feedback = 'Changes were committed but diff against target branch is empty. This is likely a git state desync.';
        this.emitEvent({ type: 'task:fail', task, feedback: task.last_feedback });
        return null;
      }

      this.log(`Inspection: Reviewing ${task.id}`);
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

  private generateFeatureId(): string {
    const now = new Date();
    const ts = now.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    return `f-${ts}`;
  }

  private async archiveCurrentState() {
    const featureId = this.state.feature_id || this.generateFeatureId();
    const archivePath = path.join(this.archiveDir, `${featureId}.json`);
    await fs.copyFile(this.statePath, archivePath);
    await this.updateHistory(this.state.status);
    this.log(`Archived previous feature: ${this.state.feature} → ${featureId}`);
  }

  async getHistory(): Promise<FeatureHistoryEntry[]> {
    try {
      const content = await fs.readFile(this.historyPath, 'utf-8');
      const data = JSON.parse(content);
      return data.features || [];
    } catch {
      return [];
    }
  }

  private async updateHistory(status: string) {
    let features: FeatureHistoryEntry[] = [];
    try {
      const content = await fs.readFile(this.historyPath, 'utf-8');
      features = JSON.parse(content).features || [];
    } catch {}

    const featureId = this.state.feature_id;
    const entry: FeatureHistoryEntry = {
      feature_id: featureId,
      feature: this.state.feature,
      status,
      created_at: this.state.created_at,
      completed_at: (status === 'completed' || status === 'failed') ? new Date().toISOString() : undefined,
      task_count: this.state.tasks.length,
      tasks_done: this.state.tasks.filter(t => t.status === 'done').length,
    };

    const idx = features.findIndex(f => f.feature_id === featureId);
    if (idx >= 0) {
      features[idx] = entry;
    } else {
      features.push(entry);
    }

    const tmpPath = this.historyPath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify({ features }, null, 2));
    await fs.rename(tmpPath, this.historyPath);
  }

  private async getCurrentCommit(): Promise<string | undefined> {
    try {
      const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: this.baseDir });
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  private async runDockerVerification() {
    if (!this.dockerVerifier) return;

    const composePath = path.join(this.baseDir, 'docker-compose.yml');
    const composeAltPath = path.join(this.baseDir, 'compose.yml');
    const hasCompose = await this.exists(composePath) || await this.exists(composeAltPath);

    if (!hasCompose) {
      this.log('No docker-compose.yml found — skipping Docker verification');
      return;
    }

    this.log('Running Docker verification...');
    const result = await this.dockerVerifier.verify(this.baseDir);

    if (result.passed) {
      this.log('Docker verification PASSED — app builds and starts successfully');
    } else {
      this.log('Docker verification FAILED — app does not build or start correctly');
      this.log(result.logs.slice(-500));
      this.state.status = 'failed';
      await this.saveState();
      await this.updateHistory('failed');
    }
  }

  private async synthesizeMemory() {
    try {
      let diff = '';
      if (this.buildStartCommit) {
        const { stdout } = await execa(
          'git', ['diff', '--stat', this.buildStartCommit, 'HEAD'],
          { cwd: this.baseDir }
        );
        diff = stdout;
      }

      if (!diff.trim()) {
        this.log('No diff available for memory synthesis — skipping.');
        return;
      }

      this.log('Synthesizing memory from completed build...');
      const memory = await this.gemini.synthesizeMemory(this.state.feature, diff);

      if (memory.trim()) {
        let existing = '';
        try {
          existing = await fs.readFile(this.memoryPath, 'utf-8');
        } catch {}

        const separator = existing ? '\n\n---\n\n' : '';
        const header = `## ${this.state.feature} (${this.state.feature_id})\n`;
        await fs.appendFile(this.memoryPath, `${separator}${header}${memory}\n`);
        this.log('Memory saved to FACTORY_MEMORY.md');
      }
    } catch (e: any) {
      this.log(`Memory synthesis failed (non-fatal): ${e.message}`);
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
    const tmpPath = this.statePath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(this.state, null, 2));
    await fs.rename(tmpPath, this.statePath);
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
