#!/usr/bin/env node
import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Factory, type FactoryOptions } from './Factory.js';
import { RunJournal } from './RunJournal.js';
import { GitHub, requirementFromIssue } from './PullRequest.js';
import { loadDotEnv } from './dotenv.js';
import { WorkerStrategy, CloudProvider, CLOUD_PROVIDERS, AGENT_PROVIDERS } from './WorkerRegistry.js';
import type { PlannerProvider } from './Planner.js';
import type { SandboxMode } from './Sandbox.js';
import { startFactoryRun } from './runMode.js';
import { readPin, writePin, pinCheck } from './VersionPin.js';
import { SOFTFACTORY_VERSION } from './version.js';
import { loadProgram, saveProgram, readiness, nextRequirement, stopProgram, resumeProgram, PROGRAM_FILE, type Context } from './Program.js';
import { execa } from 'execa';

const KNOWN_FLAGS = [
  '--no-tui', '--resume', '--retry-blocked', '--history', '--refine', '--no-docker', '--plan', '--no-uat', '--init', '--abandon', '--yes', '--adopt',
  '--strategy', '--local-model', '--cloud-model', '--frontier-model', '--cloud-provider',
  '--planner-provider', '--planner-model', '--mark-done', '--sandbox',
  '--second-reviewer', '--attempt-timeout', '--run-budget', '--max-tokens', '--verify-run', '--issue', '--pr',
  '--queue', '--next', '--backlog', '--promote', '--isolation', '--approve-design', '--design-review'
];
const VALUE_FLAGS = ['--strategy', '--local-model', '--cloud-model', '--frontier-model', '--cloud-provider', '--planner-provider', '--planner-model', '--mark-done', '--sandbox', '--second-reviewer', '--attempt-timeout', '--run-budget', '--max-tokens', '--verify-run', '--issue', '--backlog', '--promote', '--isolation', '--approve-design'];

const USAGE = 'Usage: softfactory [--strategy=hybrid|local|cloud] [--sandbox=auto|docker|none] [--isolation=worktree|shared] [--cloud-provider=agy|openai|openai-api|anthropic|deepseek|qwen|openai-compat|claude-code|gemini-cli|muse] [--planner-provider=openai|agy|local|deepseek|anthropic|openai-api|qwen|openai-compat|claude-code|gemini-cli|muse] [--planner-model=model] [--local-model=model] [--cloud-model=model] [--frontier-model=model] [--no-tui] [--no-docker] [--no-uat] [--init] [--adopt] [--abandon] [--yes] [--plan] [--resume [feature-id]] [--retry-blocked] [--refine] [--mark-done <task-id[,task-id...]> ["note"]] [--second-reviewer provider/model] [--attempt-timeout minutes] [--run-budget minutes] [--max-tokens n] [--verify-run [feature-id]] [--issue <n>] [--pr] [--history] [--queue <requirement>] [--next] [--backlog [<id> keep|drop|promote]] [--promote <feature-id> now|later|no ["note"]] [--approve-design <task-id> approve|revise|skip ["notes"]] [--design-review [feature-id] <requirement>] | program init "<goal>" | program status | program next | program stop ["reason"] | program resume';

let globalFactory: Factory | null = null;

let shuttingDown = false;
const handleExit = async (signal: string, code: number) => {
  if (shuttingDown) process.exit(code);   // a second Ctrl-C exits immediately
  shuttingDown = true;
  console.log(`\n[SoftFactory] Caught ${signal} — reconciling tasks and pruning worktrees...`);
  if (globalFactory) {
    try {
      const { reset } = await globalFactory.shutdown();
      console.log(`[SoftFactory] Reset ${reset} in-flight task(s) to pending and cleaned up their worktrees. Run --resume to continue.`);
    } catch (err: any) {
      console.error(`[SoftFactory] Shutdown cleanup failed: ${err?.message}`);
    }
  }
  process.exit(code);
};

process.on('SIGINT', () => handleExit('SIGINT', 130));
process.on('SIGTERM', () => handleExit('SIGTERM', 143));

function getFlagValue(args: string[], flag: string): string | undefined {
  const exact = args.find(a => a.startsWith(`${flag}=`));
  if (exact) return exact.split('=')[1];
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  return undefined;
}

/** The branch `--design-review` reads mockups from: the feature's integration
 * branch when the current or archived state has one, else the current branch. */
async function designReviewRef(root: string, featureId?: string): Promise<string> {
  const integrationBranch = (state: any): string | undefined =>
    state && typeof state.integration_branch === 'string' ? state.integration_branch : undefined;
  if (featureId) {
    try {
      const current = JSON.parse(await fs.readFile(path.join(root, '.softfactory', 'factory.json'), 'utf8'));
      if (current.feature_id === featureId) {
        const branch = integrationBranch(current);
        if (branch) return branch;
      }
    } catch { /* no current state */ }
    try {
      const archived = JSON.parse(await fs.readFile(path.join(root, '.softfactory', 'archive', `${featureId}.json`), 'utf8'));
      const branch = integrationBranch(archived);
      if (branch) return branch;
    } catch { /* not archived */ }
  } else {
    try {
      const current = JSON.parse(await fs.readFile(path.join(root, '.softfactory', 'factory.json'), 'utf8'));
      const branch = integrationBranch(current);
      if (branch) return branch;
    } catch { /* no current state */ }
  }
  const result = await execa('git', ['branch', '--show-current'], { cwd: root, reject: false });
  return result.stdout.trim() || 'HEAD';
}

/** The archived feature record for a context's `feature_id`, or null when none is archived. */
async function readArchived(baseDir: string, featureId: string): Promise<{ status?: string; pr?: number | null } | null> {
  try {
    const raw = await fs.readFile(path.join(baseDir, '.softfactory', 'archive', `${featureId}.json`), 'utf8');
    const data = JSON.parse(raw) as { status?: unknown; pr?: unknown };
    return { status: typeof data.status === 'string' ? data.status : undefined, pr: typeof data.pr === 'number' ? data.pr : null };
  } catch {
    return null;
  }
}

/** One status line: id, status, size, depends_on and the readiness verdict (check or reason). */
function statusLine(context: Context, verdict: { ready: boolean; reason: string } | undefined): string {
  const deps = context.depends_on.length ? context.depends_on.join(', ') : '-';
  const readinessText = verdict ? (verdict.ready ? '✓ ready' : verdict.reason) : 'unknown';
  return `${context.id}  ${context.status}  ${context.size}  [${deps}]  ${readinessText}`;
}

/** `softfactory program <subcommand>`: args start after the word "program". */
async function programCommand(baseDir: string, args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === 'init') {
    const goal = args.slice(1).join(' ').trim();
    if (!goal) {
      console.error('Error: program init requires a goal.');
      console.error('Example: softfactory program init "Ship the rates service"');
      process.exit(1);
    }
    const programFile = path.join(baseDir, PROGRAM_FILE);
    if (await fs.access(programFile).then(() => true).catch(() => false)) {
      console.error(`Error: ${PROGRAM_FILE} already exists; refusing to overwrite it.`);
      process.exit(1);
    }
    const program = await loadProgram(baseDir);
    program.goal = goal;
    await saveProgram(baseDir, program);
    console.log(`wrote   ${PROGRAM_FILE}`);
    process.exit(0);
  }

  if (subcommand === 'status' || subcommand === 'next') {
    if (!await fs.access(path.join(baseDir, PROGRAM_FILE)).then(() => true).catch(() => false)) {
      console.log(`No program: run 'softfactory program init "<goal>"' to start one.`);
      process.exit(0);
    }
    const program = await loadProgram(baseDir);
    // The reasons come from Program.readiness; GitHub supplies the PR state and
    // gates are stubbed to [] until .softfactory/gates.md lands (#66).
    const github = new GitHub(baseDir);
    const verdicts = await readiness(program, {
      archived: featureId => readArchived(baseDir, featureId),
      prState: number => github.prState(number),
      openGates: async () => [],
    });
    if (subcommand === 'next') {
      // What the next advance would run, without running it.
      const ready = verdicts.find(verdict => verdict.ready);
      if (!ready) {
        console.log('No context is ready:');
        for (const verdict of verdicts) console.log(`  ${verdict.id}: ${verdict.reason}`);
        process.exit(0);
      }
      console.log(`Next: ${ready.id}\n`);
      console.log(nextRequirement(program, ready.id));
      process.exit(0);
    }
    console.log(`Program: ${program.goal}`);
    if (program.contexts.length === 0) console.log(`No contexts yet: add them to ${PROGRAM_FILE}.`);
    const verdictById = new Map(verdicts.map(verdict => [verdict.id, verdict]));
    for (const context of program.contexts) console.log(`  ${statusLine(context, verdictById.get(context.id))}`);
    process.exit(0);
  }

  if (subcommand === 'stop') {
    const reason = args.slice(1).join(' ').trim() || undefined;
    await stopProgram(baseDir, reason);
    console.log(`[SoftFactory] Program stopped${reason ? `: ${reason}` : ''}. Run 'softfactory program resume' to continue.`);
    process.exit(0);
  }

  if (subcommand === 'resume') {
    await resumeProgram(baseDir);
    console.log('[SoftFactory] Program resumed.');
    process.exit(0);
  }

  console.log('not implemented yet');
  process.exit(0);
}

async function main() {
  // Keys in the repository's .env are read for names not already exported.
  // The file itself never reaches a worktree or a commit.
  const loadedFromDotEnv = await loadDotEnv(process.cwd());
  const apiKey = process.env.GEMINI_API_KEY || '';
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const historyMode = args.includes('--history');
  if (args.includes('--init')) {
    const { initProject } = await import('./Init.js');
    for (const { file, written } of await initProject(process.cwd())) console.log(`${written ? 'wrote  ' : 'exists '} ${file}`);
    console.log('Edit worker-context.md; rename uat.example.json to uat.json once its commands are real.');
    process.exit(0);
  }

  // The 6.3 program driver: a dispatch-only command, handled before any
  // provider or flag parsing so "program" can never be requirement text and a
  // bare checkout needs no Factory.
  if (args[0] === 'program') {
    const baseDir = process.cwd();
    try {
      await programCommand(baseDir, args.slice(1));
    } catch (error: any) {
      // A hand-edited program.json that fails validation names its fields, not a stack.
      const issues = error?.issues as Array<{ path: Array<string | number>; message: string }> | undefined;
      console.error(`[SoftFactory] ${PROGRAM_FILE}: ${issues ? issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') : error?.message}`);
      process.exit(1);
    }
  }

  if (args.includes('--adopt')) {
    try {
      await writePin(process.cwd(), SOFTFACTORY_VERSION);
    } catch (error: any) {
      console.error(`[SoftFactory] ${error.message}`);
      process.exit(1);
    }
    console.log(`[SoftFactory] Accepted softfactory ${SOFTFACTORY_VERSION}: pinned .softfactory/config.json to ${SOFTFACTORY_VERSION}.`);
    process.exit(0);
  }

  if (args.some(a => a === '--verify-run' || a.startsWith('--verify-run='))) {
    let runId = getFlagValue(args, '--verify-run');
    if (!runId) {
      try { runId = JSON.parse(await fs.readFile(path.join(process.cwd(), '.softfactory', 'factory.json'), 'utf8')).feature_id; } catch { /* no current build */ }
    }
    if (!runId) {
      console.error('No run to verify: pass --verify-run <feature-id> (see --history) or run it inside a repository with a current build.');
      process.exit(1);
    }
    const result = await RunJournal.verify(process.cwd(), runId);
    console.log(result.ok
      ? `OK ${runId}: ${result.entries} journal entries and ${result.filesChecked} cited evidence files verified; head ${result.head}`
      : `FAILED ${runId}: ${result.problems.length} problem(s)`);
    for (const problem of result.problems) console.log(`  - ${problem}`);
    process.exit(result.ok ? 0 : 1);
  }

  if (args.includes('--design-review')) {
    const { listMockups, serveMockups } = await import('./DesignReview.js');
    // Like --resume, a following `f-...` word is the optional feature id.
    const designReviewIdx = args.indexOf('--design-review');
    const designNextArg = args[designReviewIdx + 1];
    const designFeatureId = designNextArg && /^f-\d+$/.test(designNextArg) ? designNextArg : undefined;
    const ref = await designReviewRef(process.cwd(), designFeatureId);
    const mockups = await listMockups(process.cwd(), ref);
    if (mockups.length === 0) {
      console.log(`No design mockups on ${ref}.`);
      process.exit(0);
    }
    const { url, close } = await serveMockups(process.cwd(), ref);
    console.log(`Design review for ${ref}: ${url}`);
    for (const mockup of mockups) {
      console.log(`  ${mockup.task}  ${mockup.screen}  ${url}m/${encodeURIComponent(mockup.file)}`);
    }
    // Keep the index and mockups served until Ctrl-C.
    await new Promise<void>(resolve => process.on('SIGINT', () => resolve()));
    await close();
    process.exit(0);
  }

  const strategyArg = (getFlagValue(args, '--strategy') || 'hybrid') as WorkerStrategy;
  const localModelArg = getFlagValue(args, '--local-model') || 'qwen2.5-coder:7b';
  const cloudProviderArg = (getFlagValue(args, '--cloud-provider') || 'agy') as CloudProvider;
  if (!CLOUD_PROVIDERS.includes(cloudProviderArg)) {
    throw new Error(`Unsupported --cloud-provider "${cloudProviderArg}". Use one of ${CLOUD_PROVIDERS.join(', ')}.`);
  }
  // The planner follows the cloud provider unless told otherwise, so a run
  // configured with one API key needs nothing else.
  const defaultPlanner = strategyArg === 'local' ? 'local'
    : ['deepseek', 'anthropic', 'openai-api', 'qwen', 'openai-compat', ...AGENT_PROVIDERS].includes(cloudProviderArg) ? cloudProviderArg
    : 'openai';
  const plannerProviderArg = (getFlagValue(args, '--planner-provider') || defaultPlanner) as PlannerProvider;
  const PLANNERS = ['openai', 'agy', 'local', 'deepseek', 'anthropic', 'openai-api', 'qwen', 'openai-compat', 'claude-code', 'gemini-cli', 'muse'];
  if (!PLANNERS.includes(plannerProviderArg)) {
    throw new Error(`Unsupported --planner-provider "${plannerProviderArg}". Use one of ${PLANNERS.join(', ')}.`);
  }
  const plannerModelArg = getFlagValue(args, '--planner-model') || '';
  const sandboxArg = (getFlagValue(args, '--sandbox') || 'auto') as SandboxMode;
  const isolationArg = getFlagValue(args, '--isolation') || 'worktree';
  if (isolationArg !== 'worktree' && isolationArg !== 'shared') {
    console.error(`Error: --isolation must be worktree or shared; got "${isolationArg}".`);
    process.exit(1);
  }
  if (!['auto', 'docker', 'none'].includes(sandboxArg)) {
    throw new Error(`Unsupported --sandbox "${sandboxArg}". Use auto, docker, or none.`);
  }
  // The Codex CLI already has an authenticated, user-configured default model.
  // Do not accidentally pass Antigravity's Gemini defaults to it.  Supplying
  // either option remains useful for explicitly choosing fast/frontier tiers.
  const secondReviewerArg = getFlagValue(args, '--second-reviewer');
  const minutes = (flag: string): number | undefined => {
    const raw = getFlagValue(args, flag);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} expects a positive number of minutes; got "${raw}".`);
    return value;
  };
  const attemptTimeoutArg = minutes('--attempt-timeout');
  const runBudgetArg = minutes('--run-budget');
  const maxTokensRaw = getFlagValue(args, '--max-tokens');
  const maxTokensArg = maxTokensRaw === undefined ? undefined : Number(maxTokensRaw);
  if (maxTokensArg !== undefined && (!Number.isFinite(maxTokensArg) || maxTokensArg <= 0)) throw new Error(`--max-tokens expects a positive number; got "${maxTokensRaw}".`);
  // CLI agents (Codex, Claude Code, Gemini CLI) have their own configured default model.
  const agentDefault = cloudProviderArg === 'openai' || AGENT_PROVIDERS.includes(cloudProviderArg);
  const MODEL_DEFAULTS: Record<string, [string, string]> = { deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro'], qwen: ['qwen3-coder-plus', 'qwen3.8-max'], 'openai-compat': ['', ''] };
  const [defaultCloud, defaultFrontier] = agentDefault ? ['', ''] : MODEL_DEFAULTS[cloudProviderArg] || ['Gemini 3.7 Flash (High)', 'Gemini 3.1 Pro (High)'];
  const cloudModelArg = getFlagValue(args, '--cloud-model') || defaultCloud;
  const frontierModelArg = getFlagValue(args, '--frontier-model') || defaultFrontier || cloudModelArg;
  if (cloudProviderArg === 'openai-compat') {
    if (!process.env.SOFTFACTORY_COMPAT_BASE_URL) throw new Error('--cloud-provider=openai-compat needs SOFTFACTORY_COMPAT_BASE_URL (the endpoint\'s /v1 root) and SOFTFACTORY_COMPAT_API_KEY.');
    if (!cloudModelArg && strategyArg !== 'local') throw new Error('--cloud-provider=openai-compat needs --cloud-model.');
  }
  if (loadedFromDotEnv.length && !historyMode) console.error(`[SoftFactory] Loaded ${loadedFromDotEnv.join(', ')} from .env`);

  if (historyMode) {
    const factory = new Factory(process.cwd(), apiKey, {
      streamToTerminal: true,
      strategy: strategyArg,
      localModel: localModelArg,
      cloudModel: cloudModelArg,
      frontierModel: frontierModelArg,
      cloudProvider: cloudProviderArg,
      plannerProvider: plannerProviderArg,
      plannerModel: plannerModelArg,
    });
    globalFactory = factory;
    await factory.init();
    const features = await factory.getHistory();
    if (features.length === 0) {
      console.log('No features built yet.');
    } else {
      console.log('Feature History:');
      console.log('-'.repeat(80));
      for (const f of features) {
        const done = `${f.tasks_done}/${f.task_count}`;
        console.log(`  ${f.feature_id.padEnd(20)} ${f.status.padEnd(10)} ${done.padEnd(6)} ${f.feature}`);
      }
    }
    process.exit(0);
  }

  const resumeMode = args.includes('--resume');
  const retryBlocked = args.includes('--retry-blocked');
  const refineMode = args.includes('--refine');
  const planMode = args.includes('--plan');
  const queueMode = args.includes('--queue');
  const nextMode = args.includes('--next');
  // --backlog lists the follow-ups workers left behind, or triages one of them.
  // It is dispatch-only and never becomes requirement text.
  const backlogMode = args.some(a => a === '--backlog' || a.startsWith('--backlog='));
  // Queue/next are dispatch-only: they never need the plan-approval TUI, so
  // they always take the plain-stdout path.
  const noTui = args.includes('--no-tui') || queueMode || nextMode || !process.stdout.isTTY;
  const noDocker = args.includes('--no-docker');
  const markDoneId = getFlagValue(args, '--mark-done');
  const promoteId = getFlagValue(args, '--promote');
  const approveDesignId = getFlagValue(args, '--approve-design');

  let resumeFeatureId: string | undefined;
  if (resumeMode) {
    const resumeIdx = args.indexOf('--resume');
    const nextArg = args[resumeIdx + 1];
    if (nextArg && !nextArg.startsWith('--') && nextArg.startsWith('f-')) {
      resumeFeatureId = nextArg;
    }
  }

  // Filter out flag values from requirement
  let requirement = args.filter((a, idx) => {
    if (KNOWN_FLAGS.some(f => a === f || a.startsWith(`${f}=`))) return false;
    const prev = args[idx - 1];
    if (prev && VALUE_FLAGS.includes(prev)) return false;
    if (a === resumeFeatureId) return false;
    return true;
  }).join(' ');

  // A flag that is not one of ours is a mistake, not requirement text: an
  // unsplit "$FLAGS" string once ran a whole build with default providers.
  const strayFlags = args.filter((a, idx) => a.startsWith('--') && !KNOWN_FLAGS.some(f => a === f || a.startsWith(`${f}=`)) && !(idx > 0 && VALUE_FLAGS.includes(args[idx - 1])));
  if (strayFlags.length) {
    console.error(`Error: unknown flag${strayFlags.length > 1 ? 's' : ''}: ${strayFlags.map(f => JSON.stringify(f)).join(', ')}${strayFlags.some(f => /\s/.test(f)) ? ' (several flags arrived as one argument; a quoted variable is not split)' : ''}`);
    console.error(USAGE);
    process.exit(1);
  }

  // Ticket in, pull request out. The issue text becomes the requirement;
  // anything typed after the flags is appended as operator instructions.
  const prMode = args.includes('--pr');
  const issueRaw = getFlagValue(args, '--issue');
  let issue: { number: number; url: string; title: string } | undefined;
  if (issueRaw !== undefined && !resumeMode) {
    const number = Number(issueRaw);
    if (!Number.isInteger(number) || number <= 0) throw new Error(`--issue expects an issue number; got "${issueRaw}".`);
    const github = new GitHub(process.cwd());
    const availability = await github.availability();
    if (!availability.ok) throw new Error(`--issue needs the GitHub CLI: ${availability.reason}`);
    const loaded = await github.readIssue(number);
    requirement = requirementFromIssue(loaded, requirement);
    issue = { number: loaded.number, url: loaded.url, title: loaded.title };
  }

  if (!resumeMode && !nextMode && !markDoneId && !backlogMode && !promoteId && !approveDesignId && !requirement) {
    console.error(USAGE);
    process.exit(1);
  }

  if (queueMode && !requirement) {
    console.error('Error: --queue requires a requirement description.');
    console.error('Example: softfactory --queue "Add user authentication with JWT"');
    process.exit(1);
  }

  if (refineMode && !requirement) {
    console.error('Error: --refine requires a refinement description.');
    console.error('Example: softfactory --refine "use PostgreSQL instead of SQLite"');
    process.exit(1);
  }

  if (planMode && !requirement) {
    console.error('Error: --plan requires a requirement description.');
    console.error('Example: softfactory --plan "Add user authentication with JWT"');
    process.exit(1);
  }

  // A project pinned to a different major version must not silently move across
  // it. A missing pin means no check; the operator accepts a new major with
  // `softfactory --adopt`.
  const pinResult = pinCheck(await readPin(process.cwd()), SOFTFACTORY_VERSION);
  if (!pinResult.ok) {
    console.error(pinResult.message);
    process.exit(1);
  }

  const factoryOptions: FactoryOptions = {
    streamToTerminal: noTui,
    useDocker: !noDocker,
    sandbox: sandboxArg,
    isolation: isolationArg,
    strategy: strategyArg,
    localModel: localModelArg,
    cloudModel: cloudModelArg,
    frontierModel: frontierModelArg,
    cloudProvider: cloudProviderArg,
    plannerProvider: plannerProviderArg,
    plannerModel: plannerModelArg,
    secondReviewer: secondReviewerArg,
    attemptTimeoutMinutes: attemptTimeoutArg,
    runBudgetMinutes: runBudgetArg,
    maxTokens: maxTokensArg,
    prMode,
    skipUat: args.includes('--no-uat'),
    abandon: args.includes('--abandon'),
    issue,
  };

  // --backlog is dispatch-only: it never becomes requirement text and, for the
  // list and keep/drop cases, never needs a Factory (so it works from a bare
  // checkout, including a git worktree where `.git` is a file).
  if (backlogMode) {
    const { openBacklog, triage } = await import('./Backlog.js');
    // "softfactory --backlog <id> keep|drop|promote": the id is the flag's
    // value, the decision the word after it. Without an id, list and exit.
    const inline = args.find(a => a.startsWith('--backlog='));
    const flagIndex = args.indexOf('--backlog');
    const positional = flagIndex === -1 ? [] : args.slice(flagIndex + 1).filter(a => !a.startsWith('--'));
    const backlogId = inline ? inline.slice('--backlog='.length) : positional[0];
    const decision = inline ? positional[0] : positional[1];

    if (!backlogId) {
      const entries = await openBacklog(process.cwd());
      if (entries.length === 0) {
        console.log('Backlog is empty.');
      } else {
        console.log('Backlog (open and kept):');
        console.log('-'.repeat(80));
        for (const entry of entries) console.log(`  ${entry.id}  [${entry.status}]  ${entry.text}`);
      }
      process.exit(0);
    }

    if (decision !== 'keep' && decision !== 'drop' && decision !== 'promote') {
      console.error(`Error: --backlog <id> needs keep, drop or promote.`);
      console.error(USAGE);
      process.exit(1);
    }

    const entry = (await openBacklog(process.cwd())).find(e => e.id === backlogId);
    if (!entry) {
      console.error(`Error: no open backlog entry with id "${backlogId}".`);
      process.exit(1);
    }

    if (decision === 'promote') {
      // Same path --queue takes: plan the text and park it under .softfactory/queue/.
      // Queue first: a planning failure must leave the entry open, not lost as "promoted".
      const promoFactory = new Factory(process.cwd(), apiKey, factoryOptions);
      globalFactory = promoFactory;
      await promoFactory.init();
      await promoFactory.queue(entry.text);
      await triage(process.cwd(), backlogId, decision);
      console.log(`[SoftFactory] Promoted ${backlogId} and queued it; run --next to start it.`);
    } else {
      await triage(process.cwd(), backlogId, decision);
      console.log(`[SoftFactory] Marked ${backlogId} as ${decision === 'keep' ? 'kept' : 'dropped'}.`);
    }
    process.exit(0);
  }

  const factory = new Factory(process.cwd(), apiKey, factoryOptions);
  globalFactory = factory;
  await factory.init();


  if (promoteId) {
    // Production for work held at TEST is a person's decision, made here.
    const [decision, ...note] = requirement.trim().split(/\s+/);
    if (decision !== 'now' && decision !== 'later' && decision !== 'no') {
      console.error('Error: --promote <feature-id> needs now, later or no.');
      process.exit(1);
    }
    try {
      await factory.promote(promoteId, decision, note.join(' ') || undefined);
    } catch (error: any) {
      console.error(`[SoftFactory] ${error.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (approveDesignId) {
    // A person's decision on a design; the words after the flag are the decision and notes.
    const [decision, ...notes] = requirement.trim().split(/\s+/);
    if (decision !== 'approve' && decision !== 'revise' && decision !== 'skip') {
      console.error('Error: --approve-design <task-id> needs approve, revise "notes" or skip.');
      process.exit(1);
    }
    try {
      await factory.approveDesign(approveDesignId, decision, notes.join(' ') || undefined);
    } catch (error: any) {
      console.error(`[SoftFactory] ${error.message}`);
      process.exit(1);
    }
    requirement = '';
    if (!resumeMode) {
      console.log(`[SoftFactory] Recorded. Run --resume to continue the build.`);
      process.exit(0);
    }
  }

  if (markDoneId) {
    // The text after the flag is the operator's note, not a requirement.
    await factory.markManualDone(markDoneId, requirement || undefined);
    requirement = '';
    if (!resumeMode) {
      console.log(`[SoftFactory] Recorded ${markDoneId} as done. Run --resume to continue the build.`);
      process.exit(0);
    }
  }

  // Interactive runs stop for plan approval; CI, pipes and --yes run unattended.
  const { isInteractive, terminalApprover, terminalBudgetConfirm } = await import('./PlanApproval.js');
  const interactive = isInteractive(args);
  const askForApproval = interactive && !resumeMode && !planMode;
  if (noTui) {
    if (askForApproval) factory.approvePlan = terminalApprover();
    // Past 80% of the planned token budget a person is asked; unattended runs halt.
    if (interactive) factory.confirmOverBudget = terminalBudgetConfirm();
    factory.on('worker:output', (event: { taskId: string; line: string }) => console.log(`[${event.taskId}] ${String(event.line).slice(0, 240)}`));
    await startFactoryRun(factory, requirement, { resumeMode, resumeFeatureId, retryBlocked, refineMode, planMode, queueMode, nextMode });
  } else {
    const { render } = await import('ink');
    const React = await import('react');
    const { App } = await import('./components/App.js');

    const { waitUntilExit } = render(
      React.createElement(App, { factory, requirement, resumeMode, resumeFeatureId, retryBlocked, refineMode, planMode, askForApproval, interactive })
    );
    await waitUntilExit();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
