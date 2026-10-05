import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { CURRENT_SCHEMA_VERSION, FactoryStateSchema, TaskSchema, type FactoryEvent, type FactoryState, type FeatureHistoryEntry, type Task } from './types.js';
import { WorktreeManager } from './WorktreeManager.js';
import { WorkerRegistry, type CloudProvider, type WorkerStrategy } from './WorkerRegistry.js';
import { isEnvironmentFailure } from './IWorker.js';
import { TaskVerifier } from './TaskVerifier.js';
import { DockerVerifier } from './DockerVerifier.js';
import { LessonManager } from './LessonManager.js';
import { execa } from 'execa';
import { AgyPlanner, CodexPlanner, LocalPlanner, DeepSeekPlanner, type IPlanner, type PlannerProvider } from './Planner.js';
import { shouldRecommendSplit } from './FailurePolicy.js';
import { TrainingDataManager } from './TrainingDataManager.js';
import { Inspector } from './Inspector.js';
import { createTextModel, OllamaTextModel } from './TextModel.js';
import { ProtectedPaths } from './ProtectedPaths.js';
import { appendRunMetrics, computeRunMetrics, readRecentMetrics, recurringFailures } from './Metrics.js';
import { redactSecrets } from './redact.js';
import { SandboxManager, type SandboxMode } from './Sandbox.js';

export interface FactoryOptions {
    streamToTerminal?: boolean;
    useDocker?: boolean;
    /** Where model-chosen commands run: a Docker container (auto/docker) or the host allowlist (none). */
    sandbox?: SandboxMode;
    strategy?: WorkerStrategy;
    localModel?: string;
    cloudModel?: string;
    frontierModel?: string;
    cloudProvider?: CloudProvider;
    plannerProvider?: PlannerProvider;
    plannerModel?: string;
}

export class Factory extends EventEmitter {
    static readonly MAX_TASK_ATTEMPTS = 5;
    baseDir: string;
    state!: FactoryState;
    statePath: string;
    historyPath: string;
    archiveDir: string;
    memoryPath: string;
    worktreeManager: WorktreeManager;
    /** Reviews diffs on the configured provider's model; the merge gate for hybrid and cloud runs. */
    inspector: Inspector;
    /** The frontier-tier reviewer for protected diffs; it never sees the worker's summary. */
    frontierInspector: Inspector;
    protectedPaths = new ProtectedPaths([]);
    sandbox: SandboxManager;
    workerRegistry: WorkerRegistry;
    taskVerifier: TaskVerifier;
    lessons: LessonManager;
    planner: IPlanner;
    dockerVerifier: DockerVerifier | null = null;
    defaultBranch = 'master';
    streamToTerminal: boolean;
    useDocker: boolean;
    strategy: WorkerStrategy;
    buildStartCommit: string | undefined;
    saveLock = Promise.resolve();
    environmentFault: string | undefined;
    /** Suite health on the base branch, so a task can be judged against it. */
    baseline: import('./TaskVerifier.js').SuiteCounts | undefined;
    /** Per-ecosystem baselines; task results must only be compared like-for-like. */
    baselines: Partial<Record<string, import('./TaskVerifier.js').SuiteCounts>> = {};
    /** Last verifier-rejected diff per task, used to stop blind identical retries. */
    rejectedDiffs = new Map<string, string>();
    /** Last failure fingerprint per task, used to stop identical retries. */
    failureFingerprints = new Map<string, string>();
    autoReplanCounts = new Map<string, number>();
    trainingData: TrainingDataManager;
    trainingCaptureEnabled: boolean;
    private runtimeConfig: { strategy: 'hybrid' | 'local' | 'cloud'; local_model?: string; cloud_provider?: string; cloud_model?: string; frontier_model?: string };
    constructor(baseDir: string, _apiKey: string, options: FactoryOptions = {}) {
        super();
        this.baseDir = baseDir;
        const { streamToTerminal = false, useDocker = true, sandbox = 'auto', strategy = 'hybrid', localModel = 'auto', cloudModel = 'Gemini 3.7 Flash (High)', frontierModel = 'Gemini 3.1 Pro (High)', cloudProvider = 'agy', plannerProvider = 'openai', plannerModel = '' } = options;
        this.useDocker = useDocker;
        this.strategy = strategy;
        this.sandbox = new SandboxManager(sandbox, line => this.log(line));
        this.statePath = path.join(baseDir, '.softfactory', 'factory.json');
        this.historyPath = path.join(baseDir, '.softfactory', 'history.json');
        this.archiveDir = path.join(baseDir, '.softfactory', 'archive');
        this.memoryPath = path.join(baseDir, '.softfactory', 'FACTORY_MEMORY.md');
        this.worktreeManager = new WorktreeManager(baseDir);
        // An explicit --local-model must pin every local tier. Passing undefined
        // left the light/heavy tiers on their hardcoded qwen defaults, so the
        // chosen model was honoured on a task's first attempt and silently
        // replaced by qwen2.5-coder:14b on every retry.
        const pinnedLocal = localModel && localModel !== 'auto' && localModel !== 'tiered' ? localModel : undefined;
        const heavyLocal = pinnedLocal || 'qwen2.5-coder:14b';
        this.planner = plannerProvider === 'openai'
            ? new CodexPlanner(plannerModel, baseDir)
            : plannerProvider === 'deepseek'
                ? new DeepSeekPlanner(plannerModel || 'deepseek-v4-pro')
            : plannerProvider === 'local'
                ? new LocalPlanner(plannerModel || heavyLocal)
                : new AgyPlanner(plannerModel || 'Gemini 3.1 Pro (High)');
        // The reviewer is the configured cloud provider's model, and nothing
        // else. It used to be the Antigravity CLI regardless of provider, with
        // a silent fallback to a local 7B when that failed, so a DeepSeek run
        // could be approved by a model nobody chose. A local run has no cloud
        // reviewer; its local model serves only the non-gating syntheses.
        this.inspector = new Inspector(strategy === 'local'
            ? new OllamaTextModel(heavyLocal)
            : createTextModel(cloudProvider, cloudModel, { cwd: baseDir }));
        // Protected diffs get the strongest model configured. A local run has
        // only its heavy local model, which still beats no review at all.
        this.frontierInspector = new Inspector(strategy === 'local'
            ? new OllamaTextModel(heavyLocal)
            : createTextModel(cloudProvider, frontierModel || cloudModel, { cwd: baseDir }));
        this.workerRegistry = new WorkerRegistry(strategy, localModel, cloudModel, frontierModel, pinnedLocal, pinnedLocal, cloudProvider);
        this.runtimeConfig = { strategy: strategy as 'hybrid' | 'local' | 'cloud', local_model: localModel, cloud_provider: cloudProvider, cloud_model: cloudModel, frontier_model: frontierModel };
        this.taskVerifier = new TaskVerifier(this.sandbox);
        this.lessons = new LessonManager(baseDir);
        this.trainingData = new TrainingDataManager(baseDir);
        // Capture is enabled by default so verified trajectories are not lost.
        // Set SOFTFACTORY_TRAINING_CAPTURE=0 for an explicit opt-out (useful
        // for sensitive repositories or dry-run investigations).
        this.trainingCaptureEnabled = process.env.SOFTFACTORY_TRAINING_CAPTURE !== '0';
        this.streamToTerminal = streamToTerminal;
    }
    async init() {
        await fs.mkdir(path.join(this.baseDir, '.softfactory'), { recursive: true });
        await fs.mkdir(this.archiveDir, { recursive: true });
        this.protectedPaths = await ProtectedPaths.load(this.baseDir);
        if (this.protectedPaths.size > 0) this.log(`Protected paths: ${this.protectedPaths.size} pattern(s) from ${ProtectedPaths.FILE}`);
        await this.sandbox.detect();
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
            this.state = this.loadState(content);
            // The command-line configuration is authoritative for the
            // process that is resuming the run. Older state files recorded
            // the original provider (often OpenAI) even when the resumed
            // process was explicitly started with DeepSeek, making status
            // reports and future retries disagree with reality.
            this.state.strategy = this.strategy;
            this.state.cloud_provider = this.workerRegistry.getCloudProvider();
            this.state.planner_provider = this.planner.provider;
            if (!this.state.feature_id) {
                this.state.feature_id = this.generateFeatureId();
            }
            for (const task of this.state.tasks) {
                if (task.status === 'active') {
                    task.status = 'pending';
                }
            }
            await this.saveState();
            await this.reconcileTaskAssignments();
        }
    }
    getState() {
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
        const codebaseContext = await this.getRepoContext(refinement);
        // The same planner and the same validator as the original plan. The
        // refinement used to go straight to the Antigravity client with no
        // validation, so refined tasks arrived with no acceptance criteria and
        // unchecked paths.
        const refined = await this.planner.refineBlueprint({
            refinement, currentTasks: this.state.tasks, codebaseContext,
            repositoryFiles: new Set(await this.getRepositoryFiles()),
            workerCapability: this.strategy === 'cloud' ? 'cloud' : 'local',
        });
        const newTasks: Task[] = this.annotateTasks(refined.tasks.map((t) => TaskSchema.parse({ ...t, status: 'pending', attempts: 0 })));
        // Done tasks are merged code; whatever the planner returned for them,
        // the original record stands.
        for (const done of doneTasks) {
            const idx = newTasks.findIndex((t) => t.id === done.id);
            const returned = idx >= 0 ? newTasks[idx] : undefined;
            if (!returned) {
                this.log(`WARNING: planner dropped done task ${done.id} — restoring original`);
                newTasks.push({ ...done });
            } else {
                if (returned.title !== done.title || returned.description !== done.description) {
                    this.log(`WARNING: planner tried to modify done task ${done.id} — restoring original`);
                }
                newTasks[idx] = { ...done };
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
    async resume(featureId?: string, retryBlocked = false) {
        if (featureId) {
            const archivePath = path.join(this.archiveDir, `${featureId}.json`);
            if (await this.exists(archivePath)) {
                const content = await fs.readFile(archivePath, 'utf-8');
                this.state = this.loadState(content);
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
        const awaitingHuman = this.state.tasks.filter(t => t.status === 'manual');

        if (failed.length === 0 && pending.length === 0 && awaitingHuman.length > 0) {
            this.log(`Still waiting on ${awaitingHuman.length} manual task(s): ${awaitingHuman.map(t => `${t.id} (${t.executor})`).join(', ')}.`);
            this.log(`Finish each one, then: softfactory --mark-done <task-id> "<what was done>" --resume`);
            this.state.status = 'paused';
            await this.saveState();
            await this.updateHistory('paused');
            this.emitEvent({ type: 'build:complete', status: 'paused', feature: this.state.feature });
            return;
        }
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
            task.replan_reason = undefined;
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
            // A manual task is completed by a person, not a merge.
            if (task.executor !== 'agent')
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
    async mergeExistsInHistory(taskId: string) {
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
    async plan(requirement: string) {
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
        const blueprint = await this.planner.generateBlueprint({ requirement, codebaseContext, memoryPatterns, featureHistory, repositoryFiles, workerCapability: this.strategy === 'cloud' ? 'cloud' : 'local', recurringFailures: await this.recurringFailureCategories() });
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
            tasks: await this.prepareTasks(blueprint.tasks),
            memory_patterns: [],
            state_revision: 0,
            schema_version: CURRENT_SCHEMA_VERSION,
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
        const blueprint = await this.planner.generateBlueprint({ requirement, codebaseContext, memoryPatterns, featureHistory, repositoryFiles, workerCapability: this.strategy === 'cloud' ? 'cloud' : 'local', recurringFailures: await this.recurringFailureCategories() });
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
            tasks: await this.prepareTasks(blueprint.tasks),
            memory_patterns: [],
            state_revision: 0,
            schema_version: CURRENT_SCHEMA_VERSION,
        };
        await this.saveState();
        await this.updateHistory('active');
        this.emitEvent({ type: 'state:update', state: this.state });
        await this.runWorkshopLoop();
    }
    async runWorkshopLoop() {
        await this.logBackendPreflight();
        if (this.environmentFault) {
            this.log(`HALTED: ${this.environmentFault}`);
            this.log('No task state was changed. Fix the backend configuration and run --resume.');
            return;
        }
        if (!this.baseline) await this.captureBaseline();
        while (this.hasUnfinishedTasks()) {
            await this.autoReplanBlockedTasks();
            const allReady = this.getReadyTasks();
            // Orchestrator and user tasks never reach a worker. They are
            // parked for a person, and the run pauses once nothing else can
            // proceed without them.
            for (const task of allReady.filter(t => t.executor !== 'agent')) await this.parkManualTask(task);
            const readyCandidates = allReady.filter(t => t.executor === 'agent');
            if (readyCandidates.length === 0) {
                if (this.state.tasks.some(t => t.status === 'manual')) break;
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
        const awaitingHuman = this.state.tasks.filter(t => t.status === 'manual');
        if (awaitingHuman.length > 0) {
            // Not a failure: the plan reached work only a person may do.
            this.state.status = 'paused';
            await this.saveState();
            await this.updateHistory('paused');
            this.log(`PAUSED: ${awaitingHuman.length} task(s) need a person: ${awaitingHuman.map(t => `${t.id} (${t.executor})`).join(', ')}`);
            this.log(`Finish each one, then: softfactory --mark-done <task-id> "<what was done>" --resume`);
            if (failedTasks.length > 0) this.log(`Also unresolved: ${failedTasks.map(t => `${t.id}:${t.status}`).join(', ')}`);
            this.emitEvent({ type: 'build:complete', status: 'paused', feature: this.state.feature });
            return;
        }
        this.state.status = failedTasks.length > 0 || this.state.tasks.some(t => t.status !== 'done') ? 'failed' : 'completed';
        await this.saveState();
        await this.updateHistory(this.state.status);
        if (this.state.status === 'completed') {
            const finalChecks = await this.taskVerifier.verifyAll(this.baseDir);
            const executed = finalChecks.filter(check => check.executed);
            // Only failures this build is responsible for. A suite that was
            // already red — a database that is not running, a pre-existing
            // panic — is not this feature's doing and must not mark it failed.
            const blocking = executed.filter(check => !check.passed && !this.wasAlreadyFailing(check));
            for (const check of executed) {
                this.log(`Final gate: ${check.passed ? 'PASS' : 'FAIL'} — ${check.testSummary}`);
            }
            if (blocking.length > 0) {
                this.log(`FINAL GATE FAILED on ${this.defaultBranch}: ${blocking.map(c => c.testSummary).join('; ')}`);
                this.log(blocking[0].output.slice(0, 1000));
                this.state.status = 'failed';
                await this.saveState();
                await this.updateHistory('failed');
            } else if (executed.some(check => !check.passed)) {
                this.log('Final gate: pre-existing failures only, not attributed to this build.');
            }
        }
        if (this.state.status === 'completed') {
            await this.runDockerVerification();
            if (this.state.status === 'completed') await this.synthesizeMemory();
        }
        await this.writeRunMetrics();
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
    async executeAndInspect(task: Task, preCreatedWorktree?: string): Promise<{ task: Task; branchName: string } | null> {
        task.error_history = task.error_history || [];
        task.escalation_level = task.escalation_level || 0;
        const processFailure = (feedback: string) => {
            const currentError = feedback.trim().substring(0, 500);
            const lastError = task.error_history.length > 0 ? task.error_history[task.error_history.length - 1] : '';
            const sameError = lastError && lastError.length > 50 && currentError.includes(lastError.substring(0, 50));
            const fingerprint = createHash('sha256').update(currentError).digest('hex');
            const repeatedFailure = this.failureFingerprints.get(task.id) === fingerprint;
            this.failureFingerprints.set(task.id, fingerprint);
            if (sameError) {
                task.escalation_level++;
            }
            task.error_history.push(currentError);
            task.attempts++;
            // Keep retries actionable without recursively embedding entire failed
            // command lines and earlier prompts into every subsequent prompt.
            task.last_feedback = feedback.trim().substring(0, 4000);
            const splitRecommended = shouldRecommendSplit(task, currentError);
            if (repeatedFailure && splitRecommended) {
                task.status = 'blocked';
                task.replan_reason = 'repeated_fit_failure';
                task.last_feedback = `${task.last_feedback}\nThe same failure repeated. This task appears too broad for one worker; decompose it into independent subtasks with non-overlapping files and separate verification before retrying.`.slice(0, 4000);
                this.log(`DECOMPOSITION RECOMMENDED: ${task.id} — repeated scope failure; blind retry stopped.`);
            } else if (task.attempts >= Factory.MAX_TASK_ATTEMPTS) {
                task.status = 'blocked';
                if (splitRecommended) {
                    task.replan_reason = 'terminal_fit_failure';
                    task.last_feedback = `${task.last_feedback}\nAutomatic re-plan is required: repeated implementation/test-fit failure reached the attempt limit; decompose into smaller independently verifiable tasks.`.slice(0, 4000);
                }
                this.log(`BLOCKED: ${task.id} — maximum ${Factory.MAX_TASK_ATTEMPTS} attempts reached.`);
            } else if (task.escalation_level > 2 && sameError) {
                task.status = 'blocked';
                if (splitRecommended) task.replan_reason = 'escalation_fit_failure';
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
            await this.recordTaskAssignment(task);
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
                sandbox: this.sandbox,
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

            // In local strategy there is no semantic reviewer, so the only thing
            // standing between a task and a merge is what can be checked
            // mechanically. A declared new file that was never written is exactly
            // that: godo's T1 merged without its eslint.config.js because nothing
            // ever looked.
            const missing = await this.missingDeclaredFiles(worktreePath, task);
            if (missing.length > 0) {
                this.log(`INCOMPLETE: ${task.id} — declared but never created: ${missing.join(', ')}`);
                processFailure(`These files are declared in creates_files but do not exist: ${missing.join(', ')}. Create them, or they were not part of this task.`);
                await this.recordAttempt(task, 'missing_declared_files', missing.join(', '));
                return null;
            }

            // Automated in-worktree verification (Scoped UAT Gate)
            this.emitEvent({ type: 'verifier:start', taskId: task.id });
            this.emitEvent({ type: 'worker:output', taskId: task.id, line: `Running verification tests...` });
            // A 'builder' task is the plan's quality gate; scoping it to its own
            // files_hint is what let a broken suite ship as 12/12 completed.
            // Check for a disabled gate before running the gate. Otherwise a task
            // that deleted the test script is told "no test script configured",
            // which reads like a project misconfiguration rather than something
            // it just did.
            const earlyDiff = await this.getDiff(branchName);
            const sabotage = this.detectVerificationSabotage(earlyDiff);
            if (sabotage) {
                this.log(`REJECTED: ${task.id} — ${sabotage}`);
                processFailure(`This change disables the project's own verification: ${sabotage}. Restore it and fix the underlying problem instead.`);
                await this.recordAttempt(task, 'verification_sabotage', sabotage);
                return null;
            }
            const verifierResult = await this.taskVerifier.verify(worktreePath, task, task.agent_role === 'builder');
            // "Passing" is the wrong question for an already-red project. Ask
            // instead whether this change made it worse: three merges here took
            // the suite from 21 failures to 68 while every gate stayed green,
            // because failing-before and failing-after look identical.
            // Task verification is intentionally scoped for ordinary workers.
            // Its counts cannot be compared with a full-suite baseline: a task
            // may run one test file while the baseline covers the whole project.
            // Full-suite regression checking happens for builder tasks and in
            // the final gate below.
            const regression = this.detectRegression(verifierResult);
            if (regression) {
                const fingerprint = createHash('sha256').update(earlyDiff).digest('hex');
                const repeated = this.rejectedDiffs.get(task.id) === fingerprint;
                this.rejectedDiffs.set(task.id, fingerprint);
                const tail = verifierResult.output
                    ? `\nVerifier output tail:\n${verifierResult.output.slice(-1200)}`
                    : '';
                const duplicate = repeated
                    ? '\nThis diff is identical to the previous rejected attempt. Do not submit it again; change the implementation or report a concrete blocker.'
                    : '';
                const feedback = `${regression}${tail}${duplicate}`;
                this.log(`REGRESSION: ${task.id} — ${regression}${repeated ? ' (identical rejected diff)' : ''}`);
                processFailure(`This change makes the test suite worse: ${feedback}`);
                await this.recordAttempt(task, repeated ? 'duplicate_regression' : 'regression', feedback);
                return null;
            }
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
                // The old "Hint:" here read a field the verifier never set, so
                // every retry prompt carried an empty hint. The output tail is
                // what the worker can act on.
                processFailure(`Automated verification failed:\n${verifierResult.testSummary}${verifierResult.output ? `\n\nVerifier output tail:\n${verifierResult.output.slice(-1200)}` : ''}`);
                await this.recordAttempt(task, 'verification', verifierResult.testSummary);
                return null;
            }
            this.emitEvent({ type: 'worker:output', taskId: task.id, line: expectedTddFailure ? `Verifier expected TDD failure: ${verifierResult.testSummary}` : `Verifier PASSED: ${verifierResult.testSummary}` });

            // The task's own acceptance command, executed and logged. Without
            // this the planner's verification_command was emitted on every
            // task and never run by anything.
            let reviewEvidence = verifierResult.output || '';
            const acceptance = await this.taskVerifier.runAcceptance(worktreePath, task, {
                evidenceDir: path.join(this.baseDir, '.softfactory', 'evidence', this.state.feature_id),
                note: task.agent_role === 'test_writer' ? 'test_writer: a red acceptance is expected before implementation' : undefined,
            });
            if (acceptance.ran) {
                task.evidence = acceptance.evidencePath ? path.relative(this.baseDir, acceptance.evidencePath) : undefined;
                const tolerated = !acceptance.passed && task.agent_role === 'test_writer' && !acceptance.unrunnable;
                reviewEvidence += `\n\nAcceptance command: ${acceptance.command} (exit ${acceptance.exitCode ?? 'n/a'}, ${acceptance.passed ? 'PASS' : tolerated ? 'expected red for test_writer' : 'FAIL'})\n${acceptance.output.slice(-2000)}`;
                if (!acceptance.passed && !tolerated) {
                    this.log(`ACCEPTANCE FAILED: ${task.id} — ${acceptance.command} exited ${acceptance.exitCode ?? 'without running'} (evidence: ${task.evidence})`);
                    this.emitEvent({ type: 'worker:output', taskId: task.id, line: `Acceptance FAILED: ${acceptance.command}` });
                    processFailure(`The task's acceptance command failed (exit ${acceptance.exitCode ?? 'n/a'}): ${acceptance.command}\n${acceptance.unrunnable ? 'The command could not run at all; it was not a test failure.\n' : ''}${acceptance.output.slice(-1200)}`);
                    await this.recordAttempt(task, acceptance.unrunnable ? 'acceptance_unrunnable' : 'acceptance', acceptance.output.slice(-1200));
                    return null;
                }
                this.log(`ACCEPTANCE ${acceptance.passed ? 'PASS' : 'expected red (test_writer)'}: ${task.id} — ${acceptance.command} (evidence: ${task.evidence})`);
                this.emitEvent({ type: 'worker:output', taskId: task.id, line: `Acceptance ${acceptance.passed ? 'PASSED' : 'red as expected'}: ${acceptance.command}` });
            }

            const diff = await this.getDiff(branchName);
            if (!diff.trim()) {
                this.log(`EMPTY DIFF: ${task.id} — commit succeeded but diff is empty (possible git state issue)`);
                processFailure('Changes were committed but diff against target branch is empty. This is likely a git state desync.');
                return null;
            }
            const testEvidence = this.validateTestWriterEvidence(task, diff);
            if (testEvidence) {
                this.log(`INCOMPLETE: ${task.id} — ${testEvidence}`);
                processFailure(testEvidence);
                await this.recordAttempt(task, 'missing_test_evidence', testEvidence);
                return null;
            }
            // A task must not be able to pass by removing the thing that checks
            // it. godo's T1 renamed the `test` script to `test:unit`, which made
            // verification report "no test script configured -> pass", and it
            // merged with its acceptance criteria unmet.
            this.log(`Inspection: Reviewing ${task.id}`);
            this.emitEvent({ type: 'worker:output', taskId: task.id, line: `Quality Inspector reviewing diff...` });
            // Protection is decided by what the diff touched, not only by what
            // the plan expected it to touch.
            const protectedHits = this.protectedPaths.touched(this.filesInDiff(diff));
            if (protectedHits.length > 0 && !task.protected) {
                task.protected = true;
                this.log(`PROTECTED: ${task.id} diff touches ${[...new Set(protectedHits.map(h => h.file))].join(', ')}`);
            }
            // Three kinds of merge decision, each recorded as what it was:
            // a blind review of protected code on the frontier model, a
            // model review of ordinary code, or, offline, mechanical gates only.
            const blind = task.protected;
            const mechanicalOnly = !blind && this.strategy === 'local';
            if (blind) this.emitEvent({ type: 'worker:output', taskId: task.id, line: `Independent review (${this.frontierInspector.provider}/${this.frontierInspector.model}) of protected diff...` });
            const review = blind
                ? await this.frontierInspector.inspectBlind(task, diff, reviewEvidence, handoff.review_answers)
                : mechanicalOnly
                    ? { verdict: 'PASS' as const, feedback: 'Mechanical gates only: automated verification and diff checks passed; no model reviewed this diff.', provider: 'none', model: 'mechanical-only' }
                    : await this.inspector.inspect(task, diff, handoff.summary, reviewEvidence);
            task.inspection = blind ? 'blind-review' : mechanicalOnly ? 'mechanical-only' : 'model';
            task.inspector_model = mechanicalOnly ? undefined : `${review.provider}/${review.model}`;
            await this.recordTaskEvent({ event: 'task:inspected', task_id: task.id, attempt: task.attempts, verdict: review.verdict, inspection: task.inspection, provider: review.provider, model: review.model, protected: task.protected });
            if (review.verdict === 'PASS') {
                this.log(mechanicalOnly ? `PASSED (mechanical gates only, no reviewer): ${task.id}` : `PASSED (${blind ? 'independent review' : 'inspector'} ${task.inspector_model}): ${task.id}`);
                this.emitEvent({ type: 'worker:output', taskId: task.id, line: mechanicalOnly ? `Mechanical gates passed; no model reviewed this diff` : `${blind ? 'Independent reviewer' : 'Quality Inspector'} (${task.inspector_model}): PASSED` });

                // Epiphany Hook: Extract generalized learnings from fixed bugs
                if (!mechanicalOnly && task.error_history && task.error_history.length > 0) {
                    this.emitEvent({ type: 'worker:output', taskId: task.id, line: `Synthesizing Epiphany from ${task.error_history.length} failures...` });
                    try {
                        const epiphany = await this.inspector.synthesizeEpiphany(task, diff);
                        if (epiphany?.should_save && await this.lessons.add({ lesson: epiphany.lesson, tags: epiphany.tags || [], scope: epiphany.scope || 'project', confidence: epiphany.confidence || 0, evidence: { taskId: task.id, failure: task.error_history.join('\n').slice(0, 500), resolution: handoff.summary } })) {
                            this.state.memory_patterns = this.state.memory_patterns || [];
                            this.state.memory_patterns.push(epiphany.lesson);
                            this.emitEvent({ type: 'worker:output', taskId: task.id, line: `💡 Epiphany Saved: ${epiphany.lesson}` });
                        }
                    } catch (e: any) {
                        this.log(`Epiphany synthesis failed: ${e.message}`);
                    }
                }

                if (this.trainingCaptureEnabled) {
                    const captured = await this.trainingData.addVerified({ task, diff, verification: verifierResult.testSummary, resolution: handoff.summary });
                    if (captured) this.emitEvent({ type: 'worker:output', taskId: task.id, line: `Training candidate saved (sanitized, verified)` });
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
    /**
     * Non-null when a diff removes a project's ability to verify itself:
     * deleting the `test` script, or emptying a test file.
     */
    /** Paths the task said it would create that are not on disk. */
    async missingDeclaredFiles(worktreePath: string, task: { creates_files?: string[] }): Promise<string[]> {
        const declared = task.creates_files || [];
        const missing: string[] = [];
        for (const relative of declared) {
            if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) continue;
            if (!await this.exists(path.join(worktreePath, relative))) missing.push(relative);
        }
        return missing;
    }

    /** Prevent a test-writer task from passing with an empty/placeholder test file. */
    validateTestWriterEvidence(task: { agent_role?: string }, diff: string): string | null {
        if (task.agent_role !== 'test_writer') return null;
        const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');
        const looksLikeTest = /(?:\b(?:describe|it|test|pytest|unittest)\s*\(|\bfunc\s+Test[A-Z]|\bTest\s*\()/m.test(added);
        return looksLikeTest ? null : 'Test-writer changes contain no test cases. Add executable assertions instead of a placeholder file.';
    }

    /**
     * True when a suite failed for reasons that pre-date this build: an
     * unreachable service, or a suite where the failures are assertions rather
     * than anything that stopped it compiling or collecting.
     */
    wasAlreadyFailing(check: { output: string; testSummary: string }): boolean {
        const text = `${check.testSummary}\n${check.output}`;
        // A suite that cannot start is never "pre-existing": T01 merged a
        // vitest.config.ts that failed to load, and this heuristic read the
        // resulting output as an ordinary red suite.
        if (/Failed to load|Transform failed|esbuild|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|SyntaxError|Unexpected token|error TS\d+|build failed|undefined:/i.test(text)) {
            return false;
        }
        if (/connection refused|no such host|ECONNREFUSED|dial tcp|could not connect/i.test(text)) return true;
        return /--- PASS:|\bok\s+\S+\s+[\d.]+s|\d+ passed/.test(text);
    }

    /**
     * Non-null when this task's run is measurably worse than the baseline.
     * More failures, or fewer passes, or a suite that suddenly collects far
     * more files than the branch it started from.
     */
    detectRegression(result: { counts?: import('./TaskVerifier.js').SuiteCounts; scope?: string; output?: string; fullSuite?: boolean }): string | null {
        // A scoped task result is not comparable to a project/ecosystem
        // baseline. The final/builder full-suite gate remains responsible for
        // detecting regressions across the complete test suite.
        if (result.fullSuite === false) return null;
        const before = result.scope ? this.baselines[result.scope] : this.baseline;
        const after = result.counts;
        if (!before || !after) return null;
        const context = ` [scope=${result.scope || 'legacy'}; before=${before.filesFailed}F/${before.filesPassed}P files, ${before.testsFailed}F/${before.testsPassed}P tests; after=${after.filesFailed}F/${after.filesPassed}P files, ${after.testsFailed}F/${after.testsPassed}P tests]`;
        if (after.testsFailed > before.testsFailed) {
            return `failing tests went from ${before.testsFailed} to ${after.testsFailed}${context}`;
        }
        if (after.filesFailed > before.filesFailed) {
            return `failing test files went from ${before.filesFailed} to ${after.filesFailed}${context}`;
        }
        if (before.testsPassed > 0 && after.testsPassed < before.testsPassed) {
            return `passing tests dropped from ${before.testsPassed} to ${after.testsPassed}${context}`;
        }
        const beforeTotal = before.filesFailed + before.filesPassed;
        const afterTotal = after.filesFailed + after.filesPassed;
        if (beforeTotal > 0 && afterTotal > beforeTotal * 1.5) {
            return `the suite now collects ${afterTotal} files where the baseline collected ${beforeTotal}${context}`;
        }
        return null;
    }

    async captureBaseline() {
        try {
            const results = await this.taskVerifier.verifyAll(this.baseDir);
            const counted = results.filter(r => r.counts);
            if (counted.length === 0) return;
            this.baselines = {};
            for (const result of counted) {
                if (result.scope) this.baselines[result.scope] = result.counts!;
            }
            const totals = counted.reduce((acc, r) => ({
                filesFailed: acc.filesFailed + r.counts!.filesFailed,
                filesPassed: acc.filesPassed + r.counts!.filesPassed,
                testsFailed: acc.testsFailed + r.counts!.testsFailed,
                testsPassed: acc.testsPassed + r.counts!.testsPassed,
            }), { filesFailed: 0, filesPassed: 0, testsFailed: 0, testsPassed: 0 });
            this.baseline = totals;
            this.log(`Baseline on ${this.defaultBranch}: ${totals.testsFailed} failing / ${totals.testsPassed} passing tests, ${totals.filesFailed} failing files`);
        } catch { /* no baseline: the gate simply does not fire */ }
    }

    detectVerificationSabotage(diff: string): string | null {
        // Only a package.json hunk can remove the test script. Matched against
        // the whole diff, any JSON fixture or config that dropped a "test" key
        // tripped this and rejected an honest task.
        const sections = diff.split(/^(?=--- a\/)/m);
        const hasHeaders = sections.some(section => /^--- a\//.test(section));
        const manifestHunks = hasHeaders
            ? sections.filter(section => /^--- a\/(?:.*\/)?package\.json/.test(section)).join('\n')
            : diff;
        const removedTestScript = /^-\s*"test"\s*:/m.test(manifestHunks);
        const addedTestScript = /^\+\s*"test"\s*:/m.test(manifestHunks);
        if (removedTestScript && !addedTestScript) {
            return 'the "test" script was removed from package.json';
        }
        const deletedTestFiles = [...diff.matchAll(/^deleted file mode .*\n(?:.*\n)*?^--- a\/(\S+)/gm)]
            .map(match => match[1])
            .filter(file => /(\.|_)(test|spec)\.[a-z]+$|_test\.go$/i.test(file));
        if (deletedTestFiles.length > 0) {
            return `test files were deleted: ${deletedTestFiles.slice(0, 5).join(', ')}`;
        }
        return null;
    }
    async recordAttempt(task: Task, category: string, detail: string) {
        try {
            const journalPath = path.join(this.baseDir, '.softfactory', 'attempts.jsonl');
            await fs.appendFile(journalPath, JSON.stringify({
                timestamp: new Date().toISOString(), task_id: task.id, attempt: task.attempts,
                escalation_level: task.escalation_level || 0, model: task.model, provider: task.provider,
                category, detail: redactSecrets(String(detail)).slice(0, 2000),
            }) + '\n');
        } catch { /* diagnostics must never fail a build */ }
        if (this.trainingCaptureEnabled) {
            await this.trainingData.addFailureLesson({ task, category, detail: redactSecrets(String(detail)) });
        }
    }
    async recordTaskAssignment(task: Task) {
        try {
            const journalPath = path.join(this.baseDir, '.softfactory', 'task-events.jsonl');
            await fs.appendFile(journalPath, JSON.stringify({
                timestamp: new Date().toISOString(), event: 'task:assigned', task_id: task.id,
                attempt: task.attempts, escalation_level: task.escalation_level || 0,
                model: task.model, provider: task.provider,
            }) + '\n');
        } catch { /* diagnostics must never fail a build */ }
    }
    private async recordTaskEvent(event: Record<string, unknown>) {
        try {
            const journalPath = path.join(this.baseDir, '.softfactory', 'task-events.jsonl');
            await fs.appendFile(journalPath, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n');
        } catch { /* diagnostics must never fail a build */ }
    }
    private async autoReplanBlockedTasks() {
        const candidates = this.state.tasks.filter(task => task.status === 'blocked' && (task.replan_reason || shouldRecommendSplit(task, task.last_feedback || '') || /decompose|rewrite the last valid|no progress/i.test(task.last_feedback || '')));
        for (const task of candidates) {
            const count = this.autoReplanCounts.get(task.id) || 0;
            if (count >= 2) continue;
            this.autoReplanCounts.set(task.id, count + 1);
            try {
                this.log(`AUTO-REPLAN: ${task.id} — requesting smaller tasks after repeated fit/progress failure`);
                const context = await this.getRepoContext(`${task.title}\n${task.description}`);
                const memoryPatterns = await this.lessons.getForPlanning();
                const blueprint = await this.planner.generateBlueprint({
                    requirement: `Re-plan blocked task ${task.id}: ${task.title}\n${task.description}\nFailure: ${task.last_feedback || ''}`,
                    codebaseContext: context,
                    memoryPatterns,
                    featureHistory: '',
                    repositoryFiles: new Set(await this.getRepositoryFiles()),
                    workerCapability: 'local',
                });
                const replacements = blueprint.tasks.map((replacement, index) => TaskSchema.parse({
                    ...replacement,
                    id: `${task.id}.${index + 1}`,
                    dependencies: [...new Set([...(task.dependencies || []), ...(replacement.dependencies || [])])].filter(id => id !== task.id),
                    blockedBy: [], status: 'pending', attempts: 0, escalation_level: 0, error_history: [],
                }));
                if (replacements.length === 0 || replacements.length >= 8) throw new Error('planner returned an unusable replacement set');
                this.validateAutoReplanScope(task, replacements);
                this.annotateTasks(replacements);
                this.state.tasks = this.state.tasks.filter(existing => existing.id !== task.id).concat(replacements);
                await this.saveState();
                this.emitEvent({ type: 'state:update', state: this.state });
                this.emitEvent({ type: 'task:auto-replan', task_id: task.id, reason: task.replan_reason || 'fit_failure', replacements: replacements.map(item => item.id) });
                await this.recordTaskEvent({ event: 'task:auto-replan', task_id: task.id, reason: task.replan_reason || 'fit_failure', replacements: replacements.map(item => item.id) });
                this.log(`AUTO-REPLAN: replaced ${task.id} with ${replacements.map(item => item.id).join(', ')}`);
            } catch (error: any) {
                task.last_feedback = `${task.last_feedback || ''}\nAutomatic re-plan failed: ${error?.message || 'unknown planner error'}`.slice(-4000);
                this.log(`AUTO-REPLAN FAILED: ${task.id} — ${error?.message || 'unknown planner error'}`);
                this.emitEvent({ type: 'task:auto-replan-failed', task_id: task.id, reason: task.replan_reason || 'fit_failure', error: error?.message || 'unknown planner error' });
                await this.recordTaskEvent({ event: 'task:auto-replan-failed', task_id: task.id, reason: task.replan_reason || 'fit_failure', error: error?.message || 'unknown planner error' });
            }
        }
    }
    validateAutoReplanScope(parent: Task, replacements: Task[]) {
        const allowed = new Set([...(parent.files_hint || []), ...(parent.creates_files || [])]);
        const expanded = replacements.flatMap(replacement =>
            [...(replacement.files_hint || []), ...(replacement.creates_files || [])]
                .filter(file => !allowed.has(file)));
        if (expanded.length > 0) {
            throw new Error(`automatic re-plan expanded task scope outside ${parent.id}: ${[...new Set(expanded)].join(', ')}`);
        }
    }
    private async reconcileTaskAssignments() {
        try {
            const journalPath = path.join(this.baseDir, '.softfactory', 'task-events.jsonl');
            const rows = (await fs.readFile(journalPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
            const cutoff = Date.parse(this.state.last_updated);
            const latest = new Map<string, any>();
            for (const row of rows) {
                if (row.event !== 'task:assigned' || Date.parse(row.timestamp) <= cutoff) continue;
                const previous = latest.get(row.task_id);
                if (!previous || row.timestamp > previous.timestamp) latest.set(row.task_id, row);
            }
            let changed = false;
            for (const task of this.state.tasks) {
                const assignment = latest.get(task.id);
                if (!assignment) continue;
                task.attempts = Math.max(task.attempts, Number(assignment.attempt) || 0);
                task.escalation_level = Math.max(task.escalation_level || 0, Number(assignment.escalation_level) || 0);
                task.model = assignment.model || task.model;
                task.provider = assignment.provider || task.provider;
                changed = true;
            }
            if (changed) await this.saveState();
        } catch { /* missing or malformed event journal is non-fatal */ }
    }
    /** Parses a persisted state and refuses one written by a newer softfactory. */
    loadState(content: string): FactoryState {
        const parsed = FactoryStateSchema.parse(JSON.parse(content));
        if (parsed.schema_version > CURRENT_SCHEMA_VERSION) {
            throw new Error(`.softfactory/factory.json was written by a newer softfactory (state schema ${parsed.schema_version}; this build reads ${CURRENT_SCHEMA_VERSION}). Upgrade softfactory before resuming.`);
        }
        if (parsed.schema_version < CURRENT_SCHEMA_VERSION) {
            // 1 → 2: every added field has a default, so parsing is the migration.
            this.log(`Migrating state schema ${parsed.schema_version} → ${CURRENT_SCHEMA_VERSION}`);
            parsed.schema_version = CURRENT_SCHEMA_VERSION;
        }
        return parsed;
    }

    /** Marks protected tasks; every new or replaced task passes through here. */
    annotateTasks(tasks: Task[]): Task[] {
        for (const task of tasks) {
            const hits = this.protectedPaths.touched([...task.files_hint, ...task.creates_files]);
            if (hits.length > 0 && !task.protected) {
                task.protected = true;
                this.log(`PROTECTED: ${task.id} touches ${[...new Set(hits.map(h => h.file))].join(', ')}`);
            }
        }
        return tasks;
    }

    /**
     * New tasks from a blueprint: annotated, and each acceptance command run
     * once against the base branch. Red is the expected result; a command
     * that cannot run here at all could never gate a merge, so it rejects
     * the plan now rather than passing silently later.
     */
    async prepareTasks(blueprintTasks: Array<Record<string, unknown>>): Promise<Task[]> {
        const tasks = this.annotateTasks(blueprintTasks.map(t => TaskSchema.parse({ ...t, status: 'pending', attempts: 0 })));
        const unrunnable: string[] = [];
        for (const task of tasks) {
            if (!task.verification_command || task.executor !== 'agent') continue;
            const probe = await this.taskVerifier.runAcceptance(this.baseDir, task, { timeoutMs: 90000 });
            const summary = probe.unrunnable
                ? `unrunnable: ${probe.output.split('\n')[0].slice(0, 160)}`
                : probe.passed ? 'already passing on the base branch' : `red (exit ${probe.exitCode})`;
            task.acceptance_baseline = { exit_code: probe.exitCode, summary };
            this.log(`Planning-time acceptance ${task.id}: ${task.verification_command} → ${summary}`);
            if (probe.unrunnable) unrunnable.push(`${task.id}: ${task.verification_command} (${summary})`);
        }
        if (unrunnable.length > 0) {
            throw new Error(`Plan rejected: these acceptance commands cannot run in this environment, so they could never gate a merge:\n- ${unrunnable.join('\n- ')}\nInstall the missing tool, or re-plan with a runnable verification_command.`);
        }
        return tasks;
    }

    /** Hands an orchestrator or user task to a person and records that nothing automated will run it. */
    async parkManualTask(task: Task) {
        task.status = 'manual';
        const who = task.executor === 'user' ? 'a decision for the product owner' : 'host or live-system work for the operator';
        this.log(`MANUAL (${task.executor}): ${task.id} — ${task.title}: ${who}; no worker will run it.`);
        this.log(`  ${task.description}`);
        if (task.files_hint.length) this.log(`  files: ${task.files_hint.join(', ')}`);
        if (task.acceptance_criteria.length) this.log(`  done when: ${task.acceptance_criteria.join('; ')}`);
        if (task.verification.length) this.log(`  verify with: ${task.verification.join('; ')}`);
        this.log(`  then: softfactory --mark-done ${task.id} "<what was done>" --resume`);
        this.emitEvent({ type: 'task:manual', task });
        this.emitEvent({ type: 'worker:output', taskId: task.id, line: `Waiting on ${task.executor}: ${task.title}. Finish it, then --mark-done ${task.id} --resume` });
        await this.recordTaskEvent({ event: 'task:manual', task_id: task.id, executor: task.executor });
    }

    /** Records that a person completed an orchestrator or user task. */
    async markManualDone(taskId: string, note?: string) {
        if (!this.state) throw new Error('No build state to update.');
        const task = this.state.tasks.find(t => t.id === taskId);
        if (!task) throw new Error(`No task ${taskId} in the current build.`);
        if (task.executor === 'agent') throw new Error(`${taskId} is an agent task; a worker completes it, not --mark-done.`);
        if (task.status === 'done') {
            this.log(`${taskId} is already done.`);
            return;
        }
        task.status = 'done';
        task.last_feedback = note ? `Completed manually: ${note}` : 'Completed manually.';
        if (this.state.status === 'paused') this.state.status = 'active';
        await this.saveState();
        await this.recordTaskEvent({ event: 'task:manual-done', task_id: taskId, executor: task.executor, note: note || '' });
        this.log(`DONE (manual): ${taskId} — ${task.title}`);
    }

    filesInDiff(diff: string): string[] {
        return [...new Set([...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1].trim()))];
    }

    private async recurringFailureCategories(): Promise<string[]> {
        const recurring = recurringFailures(await readRecentMetrics(this.baseDir));
        if (recurring.length) this.log(`ESCALATION: ${recurring.join(', ')} recurred in 2 of the last 3 runs; the planner must change its approach for them.`);
        return recurring;
    }

    private async writeRunMetrics() {
        try {
            const metrics = await computeRunMetrics(this.baseDir, this.state);
            await appendRunMetrics(this.baseDir, metrics);
            this.log(`Metrics: ${metrics.done}/${metrics.tasks} done, first-attempt rate ${metrics.first_attempt_rate}, rejections ${JSON.stringify(metrics.rejected_by_category)}`);
        } catch (e: any) {
            this.log(`Metrics not written: ${e.message}`);
        }
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
    async updateHistory(status: string) {
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
            this.log(`Synthesizing memory from completed build (${this.inspector.provider}/${this.inspector.model})...`);
            const memory = await this.inspector.synthesizeMemory(this.state.feature, diff);
            if (!memory.trim()) {
                this.log('Memory synthesis skipped: the model returned nothing or was unreachable.');
                return;
            }
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
    async getProjectContext(worktreePath: string, task?: { files_hint?: string[]; creates_files?: string[] }) {
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
    async getDiff(branch: string) {
        const { stdout } = await execa('git', ['diff', `${this.defaultBranch}...${branch}`], { cwd: this.baseDir });
        return stdout;
    }
    async saveState() {
        this.saveLock = this.saveLock.then(async () => {
            this.state.state_revision = (this.state.state_revision || 0) + 1;
            this.state.last_updated = new Date().toISOString();
            this.state.runtime = this.runtimeConfig;
            const tmpPath = this.statePath + '.tmp';
            await fs.writeFile(tmpPath, JSON.stringify(this.state, null, 2));
            await fs.rename(tmpPath, this.statePath);
            this.emitEvent({ type: 'state:update', state: this.state });
        });
        await this.saveLock;
    }

    private async logBackendPreflight() {
        // The sandbox is checked first: without one, nothing a model chooses
        // to run should start, whatever the model backends look like.
        const unsandboxed = this.sandbox.blockingReason();
        if (unsandboxed) {
            this.environmentFault = unsandboxed;
            return;
        }
        this.log(`Sandbox: ${this.sandbox.describe()}`);
        try {
            const health = await this.workerRegistry.preflight();
            this.log(`Backend preflight: local ${health.local ? 'ready' : 'unavailable'} (${health.localModel}), cloud ${health.cloud ? 'ready' : 'unavailable'} (${this.workerRegistry.getCloudProvider()}/${health.cloudModel || 'configured default'})`);
            if (this.strategy === 'local' && !health.local) {
                this.environmentFault = `Configured local model "${health.localModel}" is unavailable.`;
            } else if (this.strategy === 'cloud' && !health.cloud) {
                this.environmentFault = `Configured cloud provider "${this.workerRegistry.getCloudProvider()}" is unavailable.`;
            } else if (this.strategy === 'hybrid' && !health.local && !health.cloud) {
                this.environmentFault = 'Neither the configured local nor cloud worker is available.';
            } else if (this.strategy !== 'local' && !await this.inspector.isAvailable()) {
                // Without a reviewer no task can merge, so a hybrid run with a
                // dead cloud provider halts here instead of after the workers
                // have spent their effort.
                this.environmentFault = `Quality inspector (${this.inspector.provider}/${this.inspector.model}) is unavailable; no task can be merged without review. Use --strategy=local for an offline run.`;
            }
        } catch (error: any) {
            this.log(`Backend preflight could not complete: ${error?.message || 'unknown error'}`);
        }
    }
    hasUnfinishedTasks() {
        return this.state.tasks.some(t => t.status === 'pending' || t.status === 'active' || (t.status === 'failed' && t.attempts < Factory.MAX_TASK_ATTEMPTS));
    }
    async exists(p: string) {
        try {
            await fs.access(p);
            return true;
        }
        catch {
            return false;
        }
    }
    emitEvent(event: FactoryEvent) {
        this.emit(event.type, event);
    }
    log(msg: string) {
        this.emit('log', msg);
        if (this.streamToTerminal) {
            console.log(`[SoftFactory] ${msg}`);
        }
    }
}
