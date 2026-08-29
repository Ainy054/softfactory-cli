import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { FactoryStateSchema, TaskSchema, type FactoryState, type FeatureHistoryEntry } from './types.js';
import { WorktreeManager } from './WorktreeManager.js';
import { GeminiClient } from './GeminiClient.js';
import { WorkerRegistry, type CloudProvider } from './WorkerRegistry.js';
import { isEnvironmentFailure } from './IWorker.js';
import { TaskVerifier } from './TaskVerifier.js';
import { DockerVerifier } from './DockerVerifier.js';
import { LessonManager } from './LessonManager.js';
import { execa } from 'execa';
import { AgyPlanner, CodexPlanner, LocalPlanner, type IPlanner, type PlannerProvider } from './Planner.js';
export class Factory extends EventEmitter {
    static readonly MAX_TASK_ATTEMPTS = 5;
    baseDir;
    state!: FactoryState;
    statePath;
    historyPath;
    archiveDir;
    memoryPath;
    worktreeManager;
    gemini;
    workerRegistry;
    taskVerifier;
    lessons;
    planner: IPlanner;
    dockerVerifier: DockerVerifier | null = null;
    defaultBranch = 'master';
    streamToTerminal;
    useDocker;
    strategy;
    buildStartCommit: string | undefined;
    saveLock = Promise.resolve();
    environmentFault: string | undefined;
    constructor(baseDir, apiKey, options: any = {}) {
        super();
        this.baseDir = baseDir;
        const { proModel = 'Gemini 3.1 Pro (High)', flashModel = 'Gemini 3.7 Flash (High)', streamToTerminal = false, useDocker = true, strategy = 'hybrid', localModel = 'auto', cloudModel = 'Gemini 3.7 Flash (High)', frontierModel = 'Gemini 3.1 Pro (High)', cloudProvider = 'agy' as CloudProvider, plannerProvider = 'openai' as PlannerProvider, plannerModel = '' } = options;
        this.useDocker = useDocker;
        this.strategy = strategy;
        this.statePath = path.join(baseDir, '.softfactory', 'factory.json');
        this.historyPath = path.join(baseDir, '.softfactory', 'history.json');
        this.archiveDir = path.join(baseDir, '.softfactory', 'archive');
        this.memoryPath = path.join(baseDir, '.softfactory', 'FACTORY_MEMORY.md');
        this.worktreeManager = new WorktreeManager(baseDir);
        this.gemini = new GeminiClient(apiKey, proModel, flashModel);
        this.planner = plannerProvider === 'openai'
            ? new CodexPlanner(plannerModel)
            : plannerProvider === 'local'
                ? new LocalPlanner(plannerModel || (localModel === 'auto' ? 'qwen2.5-coder:14b' : localModel))
                : new AgyPlanner(this.gemini);
        this.workerRegistry = new WorkerRegistry(strategy, localModel, cloudModel, frontierModel, undefined, undefined, cloudProvider);
        this.taskVerifier = new TaskVerifier();
        this.lessons = new LessonManager(baseDir);
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
            }
            else {
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
    getState() {
        return this.state;
    }
    async refine(refinement) {
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
        const codebaseContext = await this.getRepoContext(refinement);
        const refined = await this.gemini.refineBlueprint(refinement, this.state.tasks, codebaseContext);
        const newTasks = refined.tasks.map((t) => TaskSchema.parse({
            ...t,
            status: t.status || 'pending',
            attempts: t.status === 'done' ? (this.state.tasks.find(old => old.id === t.id)?.attempts ?? 0) : 0,
            dependencies: t.dependencies || [],
            blockedBy: t.blockedBy || [],
            files_hint: t.files_hint || [],
        }));
        // Verify done tasks weren't tampered with
        for (const done of doneTasks) {
            const match = newTasks.find((t) => t.id === done.id);
            if (!match || match.status !== 'done') {
                this.log(`WARNING: Gemini tried to modify done task ${done.id} — restoring original`);
                const idx = newTasks.findIndex((t) => t.id === done.id);
                if (idx >= 0) {
                    newTasks[idx] = { ...done };
                }
                else {
                    newTasks.push({ ...done });
                }
            }
        }
        const added = newTasks.filter((t) => !this.state.tasks.find(old => old.id === t.id));
        const removed = this.state.tasks.filter(t => t.status !== 'done' && !newTasks.find((n) => n.id === t.id));
        const modified = newTasks.filter((t) => {
            const old = this.state.tasks.find(o => o.id === t.id);
            return old && old.status !== 'done' && (old.title !== t.title || old.description !== t.description);
        });
        if (added.length)
            this.log(`Added ${added.length} task(s): ${added.map((t) => t.id).join(', ')}`);
        if (removed.length)
            this.log(`Removed ${removed.length} task(s): ${removed.map(t => t.id).join(', ')}`);
        if (modified.length)
            this.log(`Modified ${modified.length} task(s): ${modified.map((t) => t.id).join(', ')}`);
        this.state.feature = refined.feature || this.state.feature;
        this.state.tasks = newTasks;
        this.state.status = 'active';
        this.buildStartCommit = await this.getCurrentCommit();
        await this.saveState();
        await this.updateHistory('active');
        this.emitEvent({ type: 'state:update', state: this.state });
        await this.runWorkshopLoop();
    }
    async resume(featureId, retryBlocked = false) {
        if (featureId) {
            const archivePath = path.join(this.archiveDir, `${featureId}.json`);
            if (await this.exists(archivePath)) {
                const content = await fs.readFile(archivePath, 'utf-8');
                this.state = FactoryStateSchema.parse(JSON.parse(content));
                await this.saveState();
                await fs.unlink(archivePath);
                this.log(`Restored archived feature: ${this.state.feature}`);
            }
            else {
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
        // Reset any interrupted active tasks to pending so they can resume
        for (const task of this.state.tasks) {
            if (task.status === 'active') {
                task.status = 'pending';
            }
        }

        const failed = this.state.tasks.filter(t => t.status === 'failed' || (retryBlocked && (t.status === 'rejected' || t.status === 'blocked')));
        const pending = this.state.tasks.filter(t => t.status === 'pending');

        if (failed.length === 0 && pending.length === 0) {
            const allDone = this.state.tasks.length > 0 && this.state.tasks.every(t => t.status === 'done');
            if (allDone) {
                this.log('No unfinished tasks to resume; all tasks are already complete.');
                this.state.status = 'completed';
            } else {
                const unresolved = this.state.tasks.filter(t => t.status !== 'done').map(t => `${t.id}:${t.status}`).join(', ');
                this.log(`No retryable tasks remain. Unresolved tasks: ${unresolved}. Use --retry-blocked to explicitly retry blocked/rejected tasks.`);
                this.state.status = 'failed';
            }
            await this.saveState();
            await this.updateHistory(this.state.status);
            return;
        }
        this.log(`Resuming build: ${this.state.feature}`);
        if (failed.length > 0) {
            this.log(`Resetting ${failed.length} task(s) for retry: ${failed.map(t => t.id).join(', ')}`);
        }
        for (const task of failed) {
            task.status = 'pending';
            task.attempts = 0;
            task.escalation_level = 0;
            task.error_history = [];
            task.last_feedback = undefined;
        }
        // Pending tasks are not the same as runnable tasks: a pending task whose
        // dependency is blocked can never start. Say so, rather than entering the
        // workshop loop and reporting a bare 'failed'.
        if (this.getReadyTasks().length === 0) {
            const unresolved = this.state.tasks.filter(t => t.status !== 'done');
            this.log(`No runnable tasks remain: ${unresolved.map(t => `${t.id}:${t.status}`).join(', ')}`);
            if (!retryBlocked && unresolved.some(t => t.status === 'blocked' || t.status === 'rejected')) {
                this.log('These tasks are blocked or rejected. Re-run with --retry-blocked to retry them.');
            }
            this.state.status = 'failed';
            await this.saveState();
            await this.updateHistory('failed');
            this.emitEvent({ type: 'state:update', state: this.state });
            this.emitEvent({ type: 'build:complete', status: 'failed', feature: this.state.feature });
            return;
        }
        this.state.status = 'active';
        await this.saveState();
        this.emitEvent({ type: 'state:update', state: this.state });
        await this.runWorkshopLoop();
    }
    /**
     * Ctrl-C used to print "safely reconciling tasks and pruning worktrees" and
     * do nothing, leaking a worktree and a line/* branch every time. This is
     * that promise, kept.
     */
    async shutdown() {
        const active = this.state?.tasks?.filter(t => t.status === 'active') || [];
        for (const task of active) {
            task.status = 'pending';
        }
        if (this.state) {
            try {
                await this.saveState();
            } catch { /* best effort: never block exit on a write */ }
        }
        for (const task of active) {
            try {
                await this.worktreeManager.cleanup(task.id, `line/${task.id}`);
            } catch { /* best effort */ }
        }
        return { reset: active.length };
    }
    async validateDoneTasks() {
        let resetCount = 0;
        for (const task of this.state.tasks) {
            if (task.status !== 'done')
                continue;
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
    async mergeExistsInHistory(taskId) {
        try {
            const { stdout } = await execa('git', ['log', '--oneline', '--all', '--grep', `softfactory: merge ${taskId}`], { cwd: this.baseDir });
            if (stdout.trim())
                return true;
            // Also check for direct commits (in case merge was fast-forward)
            const { stdout: stdout2 } = await execa('git', ['log', '--oneline', '--all', '--grep', `softfactory: complete task ${taskId}`], { cwd: this.baseDir });
            return !!stdout2.trim();
        }
        catch {
            return false;
        }
    }
    async plan(requirement) {
        if (this.state && (this.state.status === 'completed' || this.state.status === 'failed')) {
            await this.archiveCurrentState();
        }
        if (this.state && this.state.status === 'active') {
            this.log(`Existing in-progress feature found: ${this.state.feature}`);
            this.log('Use --resume to continue it, or wait for it to complete/fail before planning a new one.');
            return;
        }
        this.log(`Generating plan for: ${requirement}`);
        const codebaseContext = await this.getRepoContext(requirement);
        const repositoryFiles = new Set(await this.getRepositoryFiles());
        const memoryPatterns = await this.getMemoryPatterns();
        const history = await this.getHistory();
        const featureHistory = history.length > 0
            ? history.map(f => `- ${f.feature} (${f.status}, ${f.tasks_done}/${f.task_count} tasks)`).join('\n')
            : '';
        this.log(`Planner: ${this.planner.provider}${this.planner.provider === 'openai' ? ' (read-only structured output)' : ''}`);
        const blueprint = await this.planner.generateBlueprint({ requirement, codebaseContext, memoryPatterns, featureHistory, repositoryFiles });
        const featureId = this.generateFeatureId();
        this.state = {
            feature_id: featureId,
            feature: blueprint.feature,
            status: 'planned',
            created_at: new Date().toISOString(),
            last_updated: new Date().toISOString(),
            strategy: this.strategy,
            cloud_provider: this.workerRegistry.getCloudProvider(),
            planner_provider: this.planner.provider,
            tasks: blueprint.tasks.map((t) => TaskSchema.parse({ ...t, status: 'pending', attempts: 0 })),
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
    async build(requirement) {
        if (this.state && (this.state.status === 'completed' || this.state.status === 'failed')) {
            await this.archiveCurrentState();
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
        const codebaseContext = await this.getRepoContext(requirement);
        const repositoryFiles = new Set(await this.getRepositoryFiles());
        const memoryPatterns = await this.getMemoryPatterns();
        const history = await this.getHistory();
        const featureHistory = history.length > 0
            ? history.map(f => `- ${f.feature} (${f.status}, ${f.tasks_done}/${f.task_count} tasks)`).join('\n')
            : '';
        const blueprint = await this.planner.generateBlueprint({ requirement, codebaseContext, memoryPatterns, featureHistory, repositoryFiles });
        const featureId = this.generateFeatureId();
        this.state = {
            feature_id: featureId,
            feature: blueprint.feature,
            status: 'active',
            created_at: new Date().toISOString(),
            last_updated: new Date().toISOString(),
            strategy: this.strategy,
            cloud_provider: this.workerRegistry.getCloudProvider(),
            planner_provider: this.planner.provider,
            tasks: blueprint.tasks.map((t) => TaskSchema.parse({ ...t, status: 'pending', attempts: 0 })),
            memory_patterns: []
        };
        await this.saveState();
        await this.updateHistory('active');
        this.emitEvent({ type: 'state:update', state: this.state });
        await this.runWorkshopLoop();
    }
    async runWorkshopLoop() {
        while (this.hasUnfinishedTasks()) {
            const readyCandidates = this.getReadyTasks();
            if (readyCandidates.length === 0) {
                this.log('No ready tasks — possible deadlock or all retries exhausted.');
                break;
            }
            const currentPhase = Math.min(...readyCandidates.map(t => t.phase));
            // Only dispatch the earliest open phase. Without this the variable was
            // decorative and a later phase could run beside a retrying predecessor.
            const phaseCandidates = readyCandidates.filter(t => t.phase === currentPhase);
            // Same-phase tasks that claim the same files must be serialized to
            // avoid avoidable merge conflicts.
            const claimedFiles = new Set();
            const readyTasks = phaseCandidates.filter(task => {
                const touched = [...task.files_hint, ...task.creates_files];
                const overlaps = touched.some(file => claimedFiles.has(file));
                if (!overlaps) {
                    touched.forEach(file => claimedFiles.add(file));
                }
                return !overlaps;
            });
            this.emitEvent({ type: 'phase:start', phase: currentPhase });
            this.log(`Phase ${currentPhase}: Running ${readyTasks.length} task(s) in parallel`);
            // Pre-create worktrees sequentially (git uses a lock file, concurrent creates race)
            const worktreeMap = new Map();
            for (const task of readyTasks) {
                const branchName = `line/${task.id}`;
                try {
                    const worktreePath = await this.worktreeManager.create(task.id, branchName, task.attempts > 0);
                    worktreeMap.set(task.id, worktreePath);
                }
                catch (e) {
                    this.log(`Failed to create worktree for ${task.id}: ${e.message}`);
                    task.status = 'failed';
                    task.attempts++;
                    task.last_feedback = `Worktree creation failed: ${e.message}`;
                }
            }
            const results = await Promise.allSettled(readyTasks
                .filter(task => worktreeMap.has(task.id))
                .map(task => this.executeAndInspect(task, worktreeMap.get(task.id))));
            const environmentFault = results.find(r => r.status === 'rejected' && isEnvironmentFailure(r.reason));
            // Merge passed tasks sequentially (git isn't concurrent-safe)
            for (const result of results) {
                if (result.status === 'fulfilled' && result.value) {
                    const { task, branchName } = result.value;
                    try {
                        await this.worktreeManager.merge(task.id, branchName, this.defaultBranch);
                        task.status = 'done';
                        this.emitEvent({ type: 'task:done', task });
                        this.log(`MERGED: ${task.id} - ${task.title}`);
                    }
                    catch (e) {
                        task.status = 'failed';
                        task.attempts++;
                        this.log(`MERGE FAILED: ${task.id}: ${e.message}`);
                        this.emitEvent({ type: 'task:fail', task, feedback: `Merge failed: ${e.message}` });
                    }
                }
            }
            for (const task of readyTasks) {
                const branchName = `line/${task.id}`;
                // Keep the branch while the task still has retries left, so the
                // next attempt continues from this one instead of from HEAD.
                const willRetry = (task.status === 'failed' || task.status === 'pending')
                    && task.attempts < Factory.MAX_TASK_ATTEMPTS;
                await this.worktreeManager.cleanup(task.id, branchName, willRetry);
            }
            await this.saveState();
            if (environmentFault) {
                this.environmentFault = (environmentFault as PromiseRejectedResult).reason?.message || 'worker backend unavailable';
                this.log(`HALTED: ${this.environmentFault}`);
                this.log('No task state was changed. Fix the environment and run --resume.');
                break;
            }
        }
        const failedTasks = this.state.tasks.filter(t => t.status === 'failed' || t.status === 'rejected' || t.status === 'blocked');
        const doneTasks = this.state.tasks.filter(t => t.status === 'done');
        if (this.environmentFault) {
            // Leave the feature 'active' so --resume picks up exactly where it
            // stopped once the backend is back. Nothing here is a task failure.
            this.state.status = 'active';
            await this.saveState();
            await this.updateHistory('active');
            this.log(`Run halted by an environment fault: ${this.environmentFault}`);
            this.emitEvent({ type: 'build:complete', status: 'failed', feature: this.state.feature });
            return;
        }
        this.state.status = failedTasks.length > 0 || this.state.tasks.some(t => t.status !== 'done') ? 'failed' : 'completed';
        await this.saveState();
        await this.updateHistory(this.state.status);
        if (this.state.status === 'completed') {
            const finalCheck = await this.taskVerifier.verify(this.baseDir, undefined, true);
            if (finalCheck.executed && !finalCheck.passed) {
                this.log(`FINAL GATE FAILED: the full test suite does not pass on ${this.defaultBranch} — ${finalCheck.testSummary}`);
                this.log(finalCheck.output.slice(0, 1000));
                this.state.status = 'failed';
                await this.saveState();
                await this.updateHistory('failed');
            } else if (finalCheck.executed) {
                this.log(`Final gate passed: ${finalCheck.testSummary}`);
            }
        }
        if (this.state.status === 'completed') {
            await this.runDockerVerification();
            if (this.state.status === 'completed') await this.synthesizeMemory();
        }
        this.emitEvent({ type: 'build:complete', status: this.state.status, feature: this.state.feature });
        if (failedTasks.length > 0) {
            this.log(`Build partial: ${doneTasks.length}/${this.state.tasks.length} tasks completed, ${failedTasks.length} failed/skipped`);
            for (const t of failedTasks) {
                this.log(`  - ${t.id} ${t.title}: ${t.status}${t.last_feedback ? ` (${t.last_feedback.slice(0, 100)})` : ''}`);
            }
        }
        else {
            this.log(`Build completed: ${this.state.feature}`);
        }
    }
    async executeAndInspect(task: any, preCreatedWorktree?: string) {
        task.error_history = task.error_history || [];
        task.escalation_level = task.escalation_level || 0;
        const processFailure = (feedback: string) => {
            const currentError = feedback.trim().substring(0, 500);
            const lastError = task.error_history.length > 0 ? task.error_history[task.error_history.length - 1] : '';
            const sameError = lastError && lastError.length > 50 && currentError.includes(lastError.substring(0, 50));
            if (sameError) {
                task.escalation_level++;
            }
            task.error_history.push(currentError);
            task.attempts++;
            // Keep retries actionable without recursively embedding entire failed
            // command lines and earlier prompts into every subsequent prompt.
            task.last_feedback = feedback.trim().substring(0, 4000);
            if (task.attempts >= Factory.MAX_TASK_ATTEMPTS) {
                task.status = 'blocked';
                this.log(`BLOCKED: ${task.id} — maximum ${Factory.MAX_TASK_ATTEMPTS} attempts reached.`);
            } else if (task.escalation_level > 2 && sameError) {
                task.status = 'blocked';
                this.log(`BLOCKED: ${task.id} — Task is permanently blocked due to identical repeated failures at highest escalation level.`);
            } else {
                task.status = 'failed';
            }
            this.emitEvent({ type: 'task:fail', task, feedback: task.last_feedback });
        };
        const branchName = `line/${task.id}`;
        const worktreePath = preCreatedWorktree || await this.worktreeManager.create(task.id, branchName, task.attempts > 0);
        try {
            const { worker, model, provider, escalated } = await this.workerRegistry.resolveWorker(task);
            task.model = model;
            task.provider = provider;
            if (escalated) {
                this.log(`ESCALATION: ${task.id} escalated to ${model} (Iteration ${task.attempts + 1})`);
            } else {
                this.log(`Worker: ${model}`);
            }
            this.log(`Workshop: Running ${task.id} - ${task.title}`);
            task.status = 'active';
            this.emitEvent({ type: 'task:start', task, worker: worker.name, model });
            if (task.attempts > 0) {
                this.emitEvent({ type: 'worker:output', taskId: task.id, line: `⟳ [Iteration ${task.attempts + 1}] Self-Repairing with ${model}...` });
                this.emitEvent({ type: 'worker:output', taskId: task.id, line: `Analyzing previous failure...` });
            }
            await this.saveState();
            const projectContext = await this.getProjectContext(worktreePath, task);
            const preparation = await this.taskVerifier.prepare(worktreePath, task);
            if (!preparation.ok) {
                // Usually a file an earlier attempt broke. Ending the attempt here
                // means no model ever sees the error, so the damage is permanent
                // and each remaining retry dies in setup within a second. Hand it
                // to the worker as the first thing to fix instead.
                const setupError = preparation.message || 'unknown setup error';
                this.log(`ENVIRONMENT: ${task.id} — setup failed, asking the worker to repair it: ${setupError.slice(0, 200)}`);
                await this.recordAttempt(task, 'environment', setupError);
                task.last_feedback = `Environment setup is failing and you must fix this before anything else:\n${setupError}\n\n${task.last_feedback || ''}`.slice(0, 4000);
            }
            const handoff = await worker.execute(task, worktreePath, {
                streamToTerminal: this.streamToTerminal,
                projectContext,
                memoryPatterns: await this.lessons.getRelevant(task),
                model,
                diagnosticsDir: path.join(this.baseDir, '.softfactory'),
                onOutput: (line: string) => {
                    this.emitEvent({ type: 'worker:output', taskId: task.id, line });
                },
            });
            // A worker's self-report is a hint, not a verdict. Local models
            // routinely finish the work and then forget to call finish_task, so
            // only treat a reported failure as fatal when the worktree is also
            // empty. Otherwise let the verifier and inspector adjudicate.
            // Commit changes in worktree so diff is visible for inspection
            const commitResult = await this.worktreeManager.commitWorktree(task.id);
            if (!commitResult.committed) {
                if (handoff.status === 'failure') {
                    this.log(`EMPTY: ${task.id} — worker reported failure and produced no file changes`);
                    processFailure(`Worker reported failure and produced no file changes: ${handoff.summary}`);
                    await this.recordAttempt(task, 'worker_reported_failure', handoff.summary);
                    return null;
                }
                this.log(`EMPTY: ${task.id} — worker produced no file changes`);
                processFailure('Worker completed but produced no file changes. Ensure you actually create/modify files, not just describe what to do.');
                await this.recordAttempt(task, 'no_file_changes', task.last_feedback || 'no file changes');
                return null;
            }
            if (handoff.status === 'failure') {
                this.log(`SELF-REPORTED FAILURE: ${task.id} — ${handoff.summary} (files changed; verifier and inspector will adjudicate)`);
                this.emitEvent({ type: 'worker:output', taskId: task.id, line: `Worker self-reported failure but changed files — gating on verification instead` });
                await this.recordAttempt(task, 'worker_reported_failure_with_changes', handoff.summary);
            }
            this.emitEvent({ type: 'worker:output', taskId: task.id, line: `Committed ${commitResult.filesChanged} file(s)` });

            // Automated in-worktree verification (Scoped UAT Gate)
            this.emitEvent({ type: 'verifier:start', taskId: task.id });
            this.emitEvent({ type: 'worker:output', taskId: task.id, line: `Running verification tests...` });
            // A 'builder' task is the plan's quality gate; scoping it to its own
            // files_hint is what let a broken suite ship as 12/12 completed.
            const verifierResult = await this.taskVerifier.verify(worktreePath, task, task.agent_role === 'builder');
            this.emitEvent({
                type: 'verifier:done',
                taskId: task.id,
                passed: verifierResult.passed,
                testSummary: verifierResult.testSummary,
                output: verifierResult.output
            });

            // TDD test-writer tasks intentionally begin with failing assertions.
            // Compile/vet failures are still always rejected.
            const expectedTddFailure = task.agent_role === 'test_writer' &&
                verifierResult.executed && !verifierResult.isCompileError;
            if (!verifierResult.passed && !expectedTddFailure) {
                this.log(`VERIFIER FAILED: ${task.id} — ${verifierResult.testSummary}`);
                this.emitEvent({ type: 'worker:output', taskId: task.id, line: `Verifier FAILED: ${verifierResult.testSummary}` });
                processFailure(`Automated verification failed:\n${verifierResult.testSummary}\n\nHint: ${verifierResult.hints?.join(', ') || ''}`);
                await this.recordAttempt(task, 'verification', verifierResult.testSummary);
                return null;
            }
            this.emitEvent({ type: 'worker:output', taskId: task.id, line: expectedTddFailure ? `Verifier expected TDD failure: ${verifierResult.testSummary}` : `Verifier PASSED: ${verifierResult.testSummary}` });

            const diff = await this.getDiff(branchName);
            if (!diff.trim()) {
                this.log(`EMPTY DIFF: ${task.id} — commit succeeded but diff is empty (possible git state issue)`);
                processFailure('Changes were committed but diff against target branch is empty. This is likely a git state desync.');
                return null;
            }
            this.log(`Inspection: Reviewing ${task.id}`);
            this.emitEvent({ type: 'worker:output', taskId: task.id, line: `Quality Inspector reviewing diff...` });
            // Local mode must remain offline: the automated verifier is the
            // review gate when no cloud provider is allowed.
            const review = this.strategy === 'local'
                ? { verdict: 'PASS' as const, feedback: 'Local mode: passed automated verification and non-empty diff checks.' }
                : await this.gemini.inspectTask(task, diff, handoff.summary, verifierResult.output);
            if (review.verdict === 'PASS') {
                this.log(`PASSED: ${task.id}`);
                this.emitEvent({ type: 'worker:output', taskId: task.id, line: `Quality Inspector: PASSED` });

                // Epiphany Hook: Extract generalized learnings from fixed bugs
                if (this.strategy !== 'local' && task.error_history && task.error_history.length > 0) {
                    this.emitEvent({ type: 'worker:output', taskId: task.id, line: `Synthesizing Epiphany from ${task.error_history.length} failures...` });
                    try {
                        const epiphany = await this.gemini.synthesizeEpiphany(task, diff);
                        if (epiphany?.should_save && await this.lessons.add({ lesson: epiphany.lesson, tags: epiphany.tags || [], scope: epiphany.scope || 'project', confidence: epiphany.confidence || 0, evidence: { taskId: task.id, failure: task.error_history.join('\n').slice(0, 500), resolution: handoff.summary } })) {
                            this.state.memory_patterns = this.state.memory_patterns || [];
                            this.state.memory_patterns.push(epiphany.lesson);
                            this.emitEvent({ type: 'worker:output', taskId: task.id, line: `💡 Epiphany Saved: ${epiphany}` });
                        }
                    } catch (e: any) {
                        this.log(`Epiphany synthesis failed: ${e.message}`);
                    }
                }

                return { task, branchName };
            }
            else {
                this.log(`FAILED: ${task.id}. Feedback: ${review.feedback}`);
                this.emitEvent({ type: 'worker:output', taskId: task.id, line: `Quality Inspector: FAILED - ${review.feedback.slice(0, 120)}` });
                processFailure(review.feedback);
                return null;
            }
        }
        catch (e: any) {
            // The backend being down is not the task's fault and no work was
            // attempted, so it must not consume a retry or poison task state.
            // Left unguarded, a brief outage blocks every task in seconds.
            if (isEnvironmentFailure(e)) {
                task.status = 'pending';
                this.log(`ENVIRONMENT: ${task.id} could not run — ${e.message}`);
                await this.recordAttempt(task, 'environment_unavailable', e.message);
                throw e;
            }
            const exitCode = e.exitCode ?? 1;
            this.log(`Worker exited with code ${exitCode} for ${task.id}: ${e.message}`);
            processFailure(`Worker crashed or timed out: ${e.message}`);
            await this.recordAttempt(task, 'worker_error', e.message);
            return null;
        }
    }
    async recordAttempt(task, category, detail) {
        try {
            const journalPath = path.join(this.baseDir, '.softfactory', 'attempts.jsonl');
            await fs.appendFile(journalPath, JSON.stringify({
                timestamp: new Date().toISOString(), task_id: task.id, attempt: task.attempts,
                escalation_level: task.escalation_level || 0, model: task.model, provider: task.provider,
                category, detail: String(detail).slice(0, 2000),
            }) + '\n');
        } catch { /* diagnostics must never fail a build */ }
    }
    generateFeatureId() {
        const now = new Date();
        const ts = now.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        return `f-${ts}`;
    }
    async archiveCurrentState() {
        const featureId = this.state.feature_id || this.generateFeatureId();
        const archivePath = path.join(this.archiveDir, `${featureId}.json`);
        await fs.copyFile(this.statePath, archivePath);
        await this.updateHistory(this.state.status);
        this.log(`Archived previous feature: ${this.state.feature} → ${featureId}`);
    }
    async getHistory() {
        try {
            const content = await fs.readFile(this.historyPath, 'utf-8');
            const data = JSON.parse(content);
            return data.features || [];
        }
        catch {
            return [];
        }
    }
    async updateHistory(status) {
        let features: FeatureHistoryEntry[] = [];
        try {
            const content = await fs.readFile(this.historyPath, 'utf-8');
            features = JSON.parse(content).features || [];
        }
        catch { }
        const featureId = this.state.feature_id;
        const entry = {
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
        }
        else {
            features.push(entry);
        }
        const tmpPath = this.historyPath + '.tmp';
        await fs.writeFile(tmpPath, JSON.stringify({ features }, null, 2));
        await fs.rename(tmpPath, this.historyPath);
    }
    async getCurrentCommit() {
        try {
            const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: this.baseDir });
            return stdout.trim();
        }
        catch {
            return undefined;
        }
    }
    async runDockerVerification() {
        if (!this.dockerVerifier)
            return;
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
        }
        else {
            this.log('Docker verification FAILED — app does not build or start correctly');
            this.log(result.logs.slice(-500));
            this.state.status = 'failed';
            await this.saveState();
            await this.updateHistory('failed');
        }
    }
    async synthesizeMemory() {
        try {
            // --stat alone is a list of filenames and line counts. Asking a model
            // for "architectural decisions" from that produced confident fiction
            // (a React 16->17 migration that never happened, an axios dependency
            // the project does not have). Give it the actual changes.
            let diff = '';
            if (this.buildStartCommit) {
                const { stdout: stat } = await execa('git', ['diff', '--stat', this.buildStartCommit, 'HEAD'], { cwd: this.baseDir });
                const { stdout: content } = await execa('git', ['diff', '--unified=1', this.buildStartCommit, 'HEAD'], { cwd: this.baseDir });
                diff = stat.trim() ? `${stat}\n\nChanges:\n${content.slice(0, 40000)}` : '';
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
                }
                catch { }
                const separator = existing ? '\n\n---\n\n' : '';
                const header = `## ${this.state.feature} (${this.state.feature_id})\n`;
                await fs.appendFile(this.memoryPath, `${separator}${header}${memory}\n`);
                this.log('Memory saved to FACTORY_MEMORY.md');
            }
        }
        catch (e) {
            this.log(`Memory synthesis failed (non-fatal): ${e.message}`);
        }
    }
    getReadyTasks() {
        const doneTasks = new Set(this.state.tasks.filter(t => t.status === 'done').map(t => t.id));
        const terminallyFailed = new Set(this.state.tasks
            .filter(t => t.status === 'rejected' || t.status === 'blocked' || (t.status === 'failed' && t.attempts >= Factory.MAX_TASK_ATTEMPTS))
            .map(t => t.id));
        // Mark tasks blocked by terminally failed dependencies as 'rejected'.
        // Repeat to a fixpoint: a rejection can strand a task further down the
        // chain, and settling one layer per run makes a dead plan look like it
        // is still making progress.
        for (;;) {
            let changed = false;
            for (const task of this.state.tasks) {
                if (task.status === 'pending' || task.status === 'failed') {
                    const deps = [...task.dependencies, ...task.blockedBy];
                    const blockedByExhausted = deps.some(dep => terminallyFailed.has(dep));
                    if (blockedByExhausted) {
                        task.status = 'rejected';
                        terminallyFailed.add(task.id);
                        changed = true;
                        this.log(`SKIPPED: ${task.id} - ${task.title} (dependency blocked permanently)`);
                        this.emitEvent({ type: 'task:fail', task, feedback: 'Skipped: dependency failed permanently' });
                    }
                }
            }
            if (!changed) break;
        }
        const eligible = this.state.tasks.filter(t => {
            if (t.status !== 'pending' && t.status !== 'failed')
                return false;
            if (t.status === 'failed' && t.attempts >= Factory.MAX_TASK_ATTEMPTS) return false;
            // All dependencies and blockers must be done
            const allDepsResolved = [...t.dependencies, ...t.blockedBy].every(dep => doneTasks.has(dep));
            if (!allDepsResolved)
                return false;
            // All tasks in earlier phases must be done or permanently settled
            const earlierPhaseTasks = this.state.tasks.filter(other => other.phase < t.phase);
            const allEarlierSettled = earlierPhaseTasks.every(other => other.status === 'done' || other.status === 'rejected' || other.status === 'blocked' || (other.status === 'failed' && other.attempts >= Factory.MAX_TASK_ATTEMPTS));
            return allEarlierSettled;
        });
        return eligible;
    }
    static readonly MAX_PROJECT_CONTEXT_CHARS = 2000;
    /**
     * This lands verbatim in the worker's system prompt, which compaction is not
     * allowed to shrink. A bare `git ls-files` put 648 paths / 25,712 chars there
     * — twice a 4096-token window on its own — so the model could never retain a
     * file it had just read and looped on read_file until the iteration cap.
     * Send the neighbourhood of the task's own files, hard-capped.
     */
    async getProjectContext(worktreePath, task?: { files_hint?: string[]; creates_files?: string[] }) {
        const parts: string[] = [];
        let tracked: string[] = [];
        try {
            const { stdout } = await execa('git', ['ls-files'], { cwd: worktreePath });
            tracked = stdout.split('\n').filter(Boolean);
        }
        catch { }
        if (tracked.length) {
            const targets = [...(task?.files_hint || []), ...(task?.creates_files || [])];
            const dirs = new Set(targets.map(f => path.dirname(f)));
            const relevant = dirs.size > 0
                ? tracked.filter(f => dirs.has(path.dirname(f)))
                : tracked;
            const shown = relevant.slice(0, 60);
            const omitted = tracked.length - shown.length;
            parts.push(`Files near this task (${shown.length} of ${tracked.length} tracked${omitted > 0 ? `; ${omitted} not listed — use read_file on any path you need` : ''}):\n${shown.join('\n')}`);
        }
        try {
            const pkg = await fs.readFile(path.join(worktreePath, 'package.json'), 'utf-8');
            parts.push(`package.json:\n${pkg.slice(0, 800)}`);
        }
        catch { }
        const context = parts.join('\n\n');
        return context.length > Factory.MAX_PROJECT_CONTEXT_CHARS
            ? `${context.slice(0, Factory.MAX_PROJECT_CONTEXT_CHARS)}\n...[project context truncated]`
            : context;
    }
    async getRepositoryFiles(): Promise<string[]> {
        const { stdout } = await execa('git', ['ls-files'], { cwd: this.baseDir });
        return stdout.split('\n').filter(Boolean);
    }
    async getRepoContext(requirement = '') {
        const trackedFiles = await this.getRepositoryFiles();
        const files = trackedFiles.join('\n');
        let readme = '';
        try {
            readme = await fs.readFile(path.join(this.baseDir, 'README.md'), 'utf-8');
        }
        catch { }
        const explicitPaths = [...requirement.matchAll(/`([^`]+\/[A-Za-z0-9._/-]+)`/g)].map(match => match[1]);
        const requirementWords = new Set(requirement.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || []);
        const scored = trackedFiles
            .filter(file => /\.(tsx?|jsx?|json|md|ya?ml)$/.test(file))
            .map(file => ({
                file,
                score: explicitPaths.includes(file) ? 1000 : file.toLowerCase().split(/[^a-z0-9]+/).filter(word => requirementWords.has(word)).length,
            }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
            .slice(0, 16);
        const snippets: string[] = [];
        for (const { file } of scored) {
            try {
                const content = await fs.readFile(path.join(this.baseDir, file), 'utf8');
                snippets.push(`--- ${file} ---\n${content.slice(0, 5000)}`);
            }
            catch { }
        }
        return `Tracked Files:\n${files}\n\nREADME:\n${readme.slice(0, 12000)}\n\nRelevant File Contents:\n${snippets.join('\n\n')}`;
    }
    async getMemoryPatterns() {
        // FACTORY_MEMORY.md was written after every build and read by nothing.
        // Planning is the one place it was meant to inform, so send it there.
        const lessons = await this.lessons.getForPlanning();
        let memory = '';
        try {
            memory = (await fs.readFile(this.memoryPath, 'utf-8')).slice(-6000);
        }
        catch { /* no memory file yet */ }
        return memory.trim()
            ? `${lessons}\n\nArchitectural memory from previous builds:\n${memory.trim()}`
            : lessons;
    }
    async getDiff(branch) {
        const { stdout } = await execa('git', ['diff', `${this.defaultBranch}...${branch}`], { cwd: this.baseDir });
        return stdout;
    }
    async saveState() {
        this.saveLock = this.saveLock.then(async () => {
            this.state.last_updated = new Date().toISOString();
            const tmpPath = this.statePath + '.tmp';
            await fs.writeFile(tmpPath, JSON.stringify(this.state, null, 2));
            await fs.rename(tmpPath, this.statePath);
            this.emitEvent({ type: 'state:update', state: this.state });
        });
        await this.saveLock;
    }
    hasUnfinishedTasks() {
        return this.state.tasks.some(t => t.status === 'pending' || t.status === 'active' || (t.status === 'failed' && t.attempts < Factory.MAX_TASK_ATTEMPTS));
    }
    async exists(p) {
        try {
            await fs.access(p);
            return true;
        }
        catch {
            return false;
        }
    }
    emitEvent(event) {
        this.emit(event.type, event);
    }
    log(msg) {
        this.emit('log', msg);
        if (this.streamToTerminal) {
            console.log(`[SoftFactory] ${msg}`);
        }
    }
}
