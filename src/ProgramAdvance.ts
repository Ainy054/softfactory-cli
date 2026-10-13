import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadProgram, saveProgram, readiness, nextRequirement, STOPPED_FILE, type Deps, type Program, type HistoryEntry } from './Program.js';
import { tokensInWindow } from './PlanChecklist.js';

/**
 * One advance of a program: `softfactory program`, run by hand or by launchd.
 * Stop conditions and a lock first, then resume the run in flight or start
 * the first ready context, and record what happened. Workers never run in
 * here; `runContext` does that, so the advance is testable on its own.
 */
export const LOCK_FILE = path.join('.softfactory', 'program.lock');
/** A lock older than this is stale even if its pid is alive (pid reuse, a hung run). */
export const LOCK_STALE_MS = 6 * 3_600_000;
/** Runs in a row with nothing merged before the driver stops itself. */
export const FRUITLESS_LIMIT = 3;

export interface RunOutcome {
  feature_id: string;
  /** `halted`: the run stopped part-way (budget, interruption) and stays in flight. */
  status: 'completed' | 'failed' | 'planned' | 'partial' | 'halted';
  pr?: number;
  /** Tasks merged by this run; zero means the advance was fruitless. */
  commits: number;
  tokens: number;
  /** False when the run completed with no live check (UAT); the history entry notes it as unverified. */
  verified?: boolean;
  blocked_reason?: string;
}

export interface AdvanceDeps extends Deps {
  /** Runs (or, with `resume`, continues) one context's feature. */
  runContext(contextId: string, requirement: string, options: { resume: boolean }): Promise<RunOutcome>;
  /** The feature in .softfactory/factory.json when it is still active or paused. */
  inFlight(): Promise<{ feature_id: string; status: string } | null>;
  now(): number;
  pidAlive(pid: number): boolean;
  log(line: string): void;
}

export type AdvanceResult =
  | { action: 'locked' | 'stopped' | 'idle'; message: string }
  | { action: 'started' | 'resumed' | 'parked' | 'done'; context: string; message: string };

const RUN_ACTIONS = new Set(['started', 'resumed', 'parked', 'done']);

/**
 * The last FRUITLESS_LIMIT run entries since the last `program resume` all
 * merged nothing. Idle and stop entries are not runs.
 */
export function fruitless(program: Program): boolean {
  const lastResume = program.history.map(entry => entry.action).lastIndexOf('resume');
  const runs = program.history.slice(lastResume + 1).filter(entry => RUN_ACTIONS.has(entry.action));
  if (runs.length < FRUITLESS_LIMIT) return false;
  return runs.slice(-FRUITLESS_LIMIT).every(entry => (entry.commits ?? 0) === 0);
}

/** Takes `.softfactory/program.lock`, replacing a stale one. Returns a release function, or the holder's pid. */
export async function acquireLock(baseDir: string, deps: Pick<AdvanceDeps, 'now' | 'pidAlive'>): Promise<{ release: () => Promise<void> } | { heldBy: number }> {
  const file = path.join(baseDir, LOCK_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const token = crypto.randomBytes(6).toString('hex');
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), started_at: new Date(deps.now()).toISOString(), token }) + '\n';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(file, body, { flag: 'wx' });
      return {
        release: async () => {
          // Remove only our own lock: a stale-lock takeover may have replaced it.
          const current = await fs.readFile(file, 'utf8').catch(() => '');
          if (current.includes(token)) await fs.rm(file, { force: true });
        },
      };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      let holder: { pid?: number; started_at?: string } = {};
      try { holder = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* torn or empty: stale */ }
      const age = deps.now() - Date.parse(holder.started_at ?? '');
      const live = typeof holder.pid === 'number' && deps.pidAlive(holder.pid) && Number.isFinite(age) && age < LOCK_STALE_MS;
      if (live) return { heldBy: holder.pid! };
      await fs.rm(file, { force: true });
    }
  }
  throw new Error(`could not take ${LOCK_FILE}`);
}

/** One advance. */
export async function advance(baseDir: string, deps: AdvanceDeps): Promise<AdvanceResult> {
  const lock = await acquireLock(baseDir, deps);
  if ('heldBy' in lock) {
    const message = `program: another advance is running (pid ${lock.heldBy})`;
    deps.log(message);
    return { action: 'locked', message };
  }
  try {
    return await advanceLocked(baseDir, deps);
  } finally {
    await lock.release();
  }
}

async function advanceLocked(baseDir: string, deps: AdvanceDeps): Promise<AdvanceResult> {
  const program = await loadProgram(baseDir);
  const at = () => new Date(deps.now()).toISOString();
  const record = async (entry: Omit<HistoryEntry, 'at'>) => {
    program.history.push({ at: at(), ...entry });
    await saveProgram(baseDir, program);
  };

  // 1. Stop conditions.
  const stoppedFile = path.join(baseDir, STOPPED_FILE);
  const stopped = await fs.readFile(stoppedFile, 'utf8').catch(() => null);
  if (stopped !== null) {
    let reason = '';
    try { reason = JSON.parse(stopped).reason ?? ''; } catch { reason = stopped.trim(); }
    const message = `program: stopped${reason ? ` (${reason})` : ''}; run 'softfactory program resume' to continue`;
    deps.log(message);
    return { action: 'stopped', message };
  }
  if (fruitless(program)) {
    const report = `stopped after ${FRUITLESS_LIMIT} fruitless advances`;
    await fs.writeFile(stoppedFile, JSON.stringify({ at: at(), reason: report }) + '\n', 'utf8');
    await record({ context: 'program', action: 'stopped', result: report });
    const message = `program: ${report}; the last ${FRUITLESS_LIMIT} runs merged nothing. See 'softfactory program status', then 'softfactory program resume'.`;
    deps.log(message);
    return { action: 'stopped', message };
  }
  const spent = tokensInWindow(program, deps.now());
  if (spent >= program.policy.budget_window.tokens) {
    const message = `program: budget window spent (${spent} of ${program.policy.budget_window.tokens} tokens in ${program.policy.budget_window.hours}h); waiting`;
    deps.log(message);
    await record({ context: 'program', action: 'idle', result: 'budget window spent' });
    return { action: 'idle', message };
  }

  // 3. A run in flight is resumed, not doubled.
  const flight = await deps.inFlight();
  let contextId: string | undefined;
  let resume = false;
  if (flight) {
    const owner = program.contexts.find(context => context.feature_id === flight.feature_id);
    if (!owner) {
      const message = `program: ${flight.feature_id} is ${flight.status} and belongs to no context; finish it or --abandon it first`;
      deps.log(message);
      await record({ context: 'program', action: 'idle', feature_id: flight.feature_id, result: 'another feature in flight' });
      return { action: 'idle', message };
    }
    contextId = owner.id;
    resume = true;
  } else {
    // 4. Pick the first ready context.
    const verdicts = await readiness(program, deps);
    const ready = verdicts.find(verdict => verdict.ready);
    if (!ready) {
      deps.log('program: no context is ready');
      for (const verdict of verdicts) deps.log(`  ${verdict.id}: ${verdict.reason}`);
      await record({ context: 'program', action: 'idle', result: verdicts.map(v => `${v.id}: ${v.reason}`).join('; ') || 'no contexts' });
      return { action: 'idle', message: 'no context is ready' };
    }
    contextId = ready.id;
  }

  // 5. Run.
  const context = program.contexts.find(candidate => candidate.id === contextId)!;
  const requirement = nextRequirement(program, context.id);
  deps.log(`program: ${resume ? 'resuming' : 'starting'} ${context.id}${context.slices.length ? ` (slice ${context.slice_index + 1} of ${context.slices.length})` : ''}`);
  context.status = 'active';
  await saveProgram(baseDir, program);
  let outcome: RunOutcome;
  try {
    outcome = await deps.runContext(context.id, requirement, { resume });
  } catch (error: any) {
    // A run that throws (a provider outage, a broken config) parks the context with the reason.
    outcome = { feature_id: context.feature_id ?? '', status: 'failed', commits: 0, tokens: 0, blocked_reason: `run failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}` };
  }
  context.feature_id = outcome.feature_id || context.feature_id;
  if (outcome.pr) context.pr = outcome.pr;

  let action: 'started' | 'resumed' | 'parked' | 'done';
  if (outcome.status === 'completed') {
    if (context.slices.length > 0 && context.slice_index + 1 < context.slices.length) {
      context.slice_index += 1;
      context.status = 'pending';
      action = resume ? 'resumed' : 'started';
    } else {
      // In PR mode dependents still wait for the merge: readiness checks `pr` first.
      context.status = 'done';
      action = 'done';
    }
  } else if (outcome.status === 'halted') {
    action = resume ? 'resumed' : 'started';
  } else {
    // 6. Park: failed, partial (blocked tasks), or a plan the checklist declined.
    context.status = 'parked';
    context.parked_reason = outcome.blocked_reason
      || (outcome.status === 'planned' ? 'the plan checklist declined the plan; see .softfactory/gates.md' : `run ${outcome.status}`);
    action = 'parked';
  }

  // 7. History. An unverified completed run is still done, but the note says so.
  const note = outcome.status === 'completed' && outcome.verified === false ? `${outcome.status} (unverified)` : outcome.status;
  await record({ context: context.id, action, feature_id: outcome.feature_id || undefined, result: note, commits: outcome.commits, tokens: outcome.tokens });
  const message = `program: ${context.id} ${action}${action === 'parked' ? `: ${context.parked_reason}` : ''} (${outcome.commits} merged, ${outcome.tokens} tokens${outcome.pr ? `, PR #${outcome.pr}` : ''})`;
  deps.log(message);
  return { action, context: context.id, message };
}

/** The launchd label for a repository: stable per absolute path. */
export function launchdLabel(repoPath: string): string {
  return `dev.softfactory.${crypto.createHash('sha256').update(path.resolve(repoPath)).digest('hex').slice(0, 12)}`;
}

/** A launchd agent that runs one advance every `everyMinutes` in `repoPath`. */
export function launchdPlist(input: { repoPath: string; nodePath: string; cliPath: string; everyMinutes: number; args?: string[]; path?: string }): string {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const repo = path.resolve(input.repoPath);
  const log = path.join(repo, '.softfactory', 'program.log');
  const programArgs = [input.nodePath, input.cliPath, 'program', ...(input.args ?? [])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escape(launchdLabel(repo))}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs.map(arg => `    <string>${escape(arg)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${escape(repo)}</string>
  <key>StartInterval</key>
  <integer>${Math.max(1, Math.round(input.everyMinutes)) * 60}</integer>
  <key>StandardOutPath</key>
  <string>${escape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escape(input.path ?? '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin')}</string>
  </dict>
</dict>
</plist>
`;
}

/** Where the plist for a repository lives. */
export function launchdPlistPath(repoPath: string, home = os.homedir()): string {
  return path.join(home, 'Library', 'LaunchAgents', `${launchdLabel(repoPath)}.plist`);
}
