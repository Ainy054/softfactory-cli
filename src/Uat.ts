import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { changedRoutes, type Environment } from './Environment.js';

/**
 * Live verification, borrowed from Softhouse's STEP 5.5 and its 2.8 "binary
 * proof". The suite, the acceptance commands and the reviewers all judge the
 * tree; none of them proves that the thing a user would run was rebuilt from
 * it and answers on its real route. Softhouse found five defects in one run
 * that only this caught, and every suite in that run had first passed against
 * the pre-merge image because the project's start command omitted --build.
 *
 * The definition lives in .softfactory/uat.json of the main checkout. Workers
 * never see or write that path (it is read from the base directory, and
 * .softfactory/ is ignored in every worktree), so a task cannot weaken the
 * check that judges it. UAT is orchestrator work: it runs on the host, with
 * the network, because it exists to reach the live stack.
 */
export const UatSchema = z.object({
  /** Rebuilds what the probes reach. SOFTFACTORY_RUN_ID is in its environment so the build can embed it. */
  build: z.string().optional(),
  /** Binary proof: each artifact must be written by this build and contain each string ($SOFTFACTORY_RUN_ID allowed). */
  artifacts: z.array(z.object({ path: z.string(), contains: z.array(z.string()).default([]) })).default([]),
  /** Brings the stack up, or anything else that must happen before the probes. */
  setup: z.array(z.string()).default([]),
  /** Reachability: commands through the real route with the real auth; non-zero exit or an unmatched `expect` is a FAIL. */
  probes: z.array(z.object({ name: z.string(), run: z.string(), expect: z.string().optional() })).default([]),
  /** Ordered suites of commands, each through the same runner as the probes. Non-gating suites run first (file order), then gating ones; only a gating failure fails the run. */
  suites: z.array(z.object({ name: z.string(), commands: z.array(z.string()).min(1), gating: z.boolean().default(true) })).default([]),
  /** With a `build` command, re-run it (step `rebuild before <name>`) before every suite after the first; a failed rebuild fails UAT. */
  rebuild_between: z.boolean().default(false),
  /** Always run at the end, pass or fail (stopping the stack). */
  teardown: z.array(z.string()).default([]),
  timeout_seconds: z.number().int().positive().max(3600).default(600),
});
export type UatConfig = z.infer<typeof UatSchema>;

export interface UatStep { name: string; command?: string; passed: boolean; detail: string }
export interface UatResult { configured: boolean; passed: boolean; steps: UatStep[]; evidencePath?: string; problem?: string }

export const UAT_FILE = path.join('.softfactory', 'uat.json');

/** Undefined when the project has no UAT definition; throws on a malformed one, which is a configuration error, not a pass. */
export async function loadUat(baseDir: string): Promise<UatConfig | undefined> {
  let raw: string;
  try { raw = await fs.readFile(path.join(baseDir, UAT_FILE), 'utf8'); }
  catch { return undefined; }
  const parsed = UatSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`${UAT_FILE} is invalid: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

/** A URL single-quoted for `sh`, or undefined when it contains a quote and cannot be quoted safely. */
function quoteUrl(url: string): string | undefined {
  return url.includes("'") ? undefined : `'${url}'`;
}

/**
 * The live check a project gets from its environment.json when it has no
 * uat.json: bring up and tear down the isolated test stack, then curl every
 * health URL and every route whose serving files this run changed. Undefined
 * when there is nothing to reach, never an empty pass.
 */
export function fallbackUat(env: Environment, changedFiles: string[]): UatConfig | undefined {
  const probes: UatConfig['probes'] = [];
  for (const url of env.health) {
    const quoted = quoteUrl(url);
    if (quoted) probes.push({ name: `health ${url}`, run: `curl -fsS --max-time 20 ${quoted}` });
  }
  for (const route of changedRoutes(env, changedFiles)) {
    const quoted = quoteUrl(route.url);
    if (!quoted) continue;
    const probe: UatConfig['probes'][number] = { name: `route ${route.url}`, run: `curl -fsS --max-time 20 ${quoted}` };
    if (route.expect !== undefined) probe.expect = route.expect;
    probes.push(probe);
  }
  if (!probes.length) return undefined;
  const config = UatSchema.parse({});
  config.setup = env.test_stack ? [env.test_stack.up] : [];
  config.probes = probes;
  config.teardown = env.test_stack?.down ? [env.test_stack.down] : [];
  return config;
}

export type ShellRunner = (command: string, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ exitCode: number; output: string; pid?: number }>;

const hostShell: ShellRunner = async (command, { cwd, env, timeoutMs }) => {
  // Output goes to a file, never to a pipe. A runner that waits for the output
  // pipes to close (as `execa` does) hangs until its timeout when a command
  // backgrounds a server (`uvicorn app.main:app &`), because the child inherits
  // the pipes; a file is inherited too, but nobody waits for it to close.
  const outputFile = path.join(os.tmpdir(), `softfactory-uat-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  const handle = await fs.open(outputFile, 'w+');
  try {
    // Each command gets its own process group. A non-interactive `sh` has no
    // job control, so a child started with `&` stays in this group, and the
    // group id (the shell's pid) lets `runUat` stop everything setup left.
    const child = spawn('sh', ['-c', command], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', handle.fd, handle.fd], detached: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; signalGroup(child.pid, 'SIGTERM'); }, timeoutMs);
    const exitCode = await new Promise<number>(resolve => {
      child.once('error', () => resolve(127));
      child.once('exit', code => resolve(code ?? 1));
    }).finally(() => clearTimeout(timer));
    return { exitCode: timedOut ? 124 : exitCode, output: await fs.readFile(outputFile, 'utf8'), pid: child.pid };
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(outputFile, { force: true }).catch(() => {});
  }
};

const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * A Python project's live check runs in its own virtual environment. The host
 * python3 is often managed (uv, Homebrew, the OS) and refuses installs, and a
 * `uvicorn` on PATH may belong to another tool's environment, so the
 * mongolbank-rates check would have failed on `No module named 'requests'`
 * with correct code. Returns the command that creates the environment and
 * installs the project's dependencies (uv when present, else venv + pip), and
 * the variables that put it first on PATH; undefined for a non-Python project.
 */
export async function pythonEnvironment(projectDir: string, venvDir: string): Promise<{ command: string; env: Record<string, string> } | undefined> {
  const has = (file: string) => fs.access(path.join(projectDir, file)).then(() => true, () => false);
  const requirements = await has('requirements.txt');
  const pyproject = !requirements && await has('pyproject.toml');
  if (!requirements && !pyproject) return undefined;
  const venv = shellQuote(venvDir);
  const python = shellQuote(path.join(venvDir, 'bin', 'python'));
  const uvSource = requirements ? '-r requirements.txt' : '-r pyproject.toml';
  const pipSource = requirements ? '-r requirements.txt' : '-e .';
  const command = [
    `if [ ! -x ${python} ]; then if command -v uv >/dev/null 2>&1; then uv venv --quiet ${venv}; else python3 -m venv ${venv}; fi; fi`,
    `printf '*\\n' > ${shellQuote(path.join(venvDir, '.gitignore'))}`,
    `if command -v uv >/dev/null 2>&1; then uv pip install --quiet --python ${python} ${uvSource}; else ${python} -m pip install --quiet ${pipSource}; fi`,
  ].join(' && ');
  return { command, env: { PATH: `${path.join(venvDir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`, VIRTUAL_ENV: venvDir } };
}

export async function runUat(
  baseDir: string,
  config: UatConfig,
  options: { runId: string; featureId: string; evidenceDir?: string; log?: (line: string) => void; shell?: ShellRunner; env?: Record<string, string>; venvDir?: string },
): Promise<UatResult> {
  const shell = options.shell ?? hostShell;
  const log = options.log ?? (() => {});
  const env = { ...options.env, SOFTFACTORY_RUN_ID: options.runId, SOFTFACTORY_FEATURE_ID: options.featureId };
  const timeoutMs = config.timeout_seconds * 1000;
  const steps: UatStep[] = [];
  const transcript: string[] = [];
  /** Process groups the setup steps started, by shell pid; stopped in the finally below. */
  const setupGroups: number[] = [];
  const run = async (name: string, command: string) => {
    const { exitCode, output, pid } = await shell(command, { cwd: baseDir, env, timeoutMs });
    transcript.push(`$ ${command}  # ${name}`, output.trimEnd(), `exit_code: ${exitCode}`, '');
    return { exitCode, output, pid };
  };
  const substitute = (text: string) => text.replace(/\$SOFTFACTORY_RUN_ID|\$\{SOFTFACTORY_RUN_ID\}/g, options.runId);

  let failed = false;
  try {
    const python = await pythonEnvironment(baseDir, options.venvDir ?? path.join(baseDir, '.softfactory', 'uat-venv'));
    if (python) {
      const { exitCode, output } = await run('python environment', python.command);
      steps.push({ name: 'python environment', command: python.command, passed: exitCode === 0, detail: exitCode === 0 ? `dependencies installed in ${python.env.VIRTUAL_ENV}` : `exit ${exitCode}: ${tail(output)}` });
      if (exitCode === 0) Object.assign(env, python.env);
      else failed = true;
    }
    if (!failed && config.build) {
      const started = Date.now();
      const { exitCode, output } = await run('build', config.build);
      steps.push({ name: 'build', command: config.build, passed: exitCode === 0, detail: exitCode === 0 ? 'built' : `exit ${exitCode}: ${tail(output)}` });
      failed ||= exitCode !== 0;
      for (const artifact of failed ? [] : config.artifacts) {
        const file = path.resolve(baseDir, artifact.path);
        const step: UatStep = { name: `binary proof: ${artifact.path}`, passed: false, detail: '' };
        try {
          const stat = await fs.stat(file);
          // A second of slack for filesystems that round mtimes.
          if (stat.mtimeMs + 1000 < started) {
            step.detail = `not rebuilt: last written ${new Date(stat.mtimeMs).toISOString()}, before this build started`;
          } else {
            const content = (artifact.contains.length ? await fs.readFile(file) : Buffer.alloc(0)).toString('latin1');
            const missing = artifact.contains.map(substitute).filter(needle => !content.includes(needle));
            step.passed = missing.length === 0;
            step.detail = step.passed ? `rebuilt${artifact.contains.length ? `, contains ${artifact.contains.length} marker(s)` : ''}` : `rebuilt but missing: ${missing.join(', ')}`;
          }
        } catch {
          step.detail = 'not found after the build';
        }
        steps.push(step);
        failed ||= !step.passed;
      }
    } else if (!failed && config.artifacts.length) {
      steps.push({ name: 'binary proof', passed: false, detail: 'artifacts are listed but there is no build command, so nothing proves they are fresh' });
      failed = true;
    }
    for (const [index, command] of (failed ? [] : config.setup).entries()) {
      const { exitCode, output, pid } = await run(`setup ${index + 1}`, command);
      // Remember every setup step that ran: mongolbank-rates' `uvicorn app.main:app
      // --port 8000 &` was still holding port 8000 three hours after the run.
      if (pid !== undefined) setupGroups.push(pid);
      steps.push({ name: `setup ${index + 1}`, command, passed: exitCode === 0, detail: exitCode === 0 ? 'ok' : `exit ${exitCode}: ${tail(output)}` });
      if (exitCode !== 0) { failed = true; break; }
    }
    for (const probe of failed ? [] : config.probes) {
      const command = substitute(probe.run);
      const { exitCode, output } = await run(`probe ${probe.name}`, command);
      const matched = probe.expect ? new RegExp(probe.expect, 'm').test(output) : true;
      const passed = exitCode === 0 && matched;
      steps.push({ name: `probe: ${probe.name}`, command, passed, detail: passed ? 'reachable' : exitCode !== 0 ? `exit ${exitCode}: ${tail(output)}` : `output did not match /${probe.expect}/: ${tail(output)}` });
      failed ||= !passed;
    }
    // Legacy suites that are allowed to fail must not wedge a gating one: non-gating first, then gating, each in file order.
    const orderedSuites = [...config.suites.filter(s => !s.gating), ...config.suites.filter(s => s.gating)];
    for (const [index, suite] of (failed ? [] : orderedSuites).entries()) {
      if (index > 0 && config.rebuild_between && config.build) {
        const { exitCode, output } = await run(`rebuild before ${suite.name}`, config.build);
        steps.push({ name: `rebuild before ${suite.name}`, command: config.build, passed: exitCode === 0, detail: exitCode === 0 ? 'rebuilt' : `exit ${exitCode}: ${tail(output)}` });
        if (exitCode !== 0) { failed = true; break; }
      }
      for (const command of suite.commands) {
        const { exitCode, output } = await run(`suite ${suite.name}: ${command}`, command);
        const passed = exitCode === 0;
        if (suite.gating) {
          steps.push({ name: `suite ${suite.name}: ${command}`, command, passed, detail: passed ? 'ok' : `exit ${exitCode}: ${tail(output)}` });
          if (!passed) { failed = true; break; }
        } else {
          steps.push({ name: `suite ${suite.name}: ${command}`, command, passed: true, detail: passed ? 'ok' : `non-gating suite failed: exit ${exitCode}: ${tail(output)}` });
        }
      }
      if (failed && suite.gating) break;
    }
    if (!config.build && !config.setup.length && !config.probes.length && !config.suites.length) {
      steps.push({ name: 'definition', passed: false, detail: `${UAT_FILE} defines no build, setup, probe or suite` });
      failed = true;
    }
  } finally {
    for (const [index, command] of config.teardown.entries()) {
      const { exitCode } = await run(`teardown ${index + 1}`, command).catch(() => ({ exitCode: 1 }));
      if (exitCode !== 0) log(`UAT teardown ${index + 1} exited ${exitCode}: ${command}`);
    }
    // mongolbank-rates (f-20261013073810): setup ended with `uvicorn app.main:app
    // --port 8000 &` and there was no teardown, so the server outlived the run and
    // held port 8000. Whatever setup started and nothing stopped is stopped here.
    const stopped = await stopProcessGroups(setupGroups);
    if (stopped) log(`UAT: stopped ${stopped} background process group(s) left by setup`);
  }

  let evidencePath: string | undefined;
  if (options.evidenceDir) {
    await fs.mkdir(options.evidenceDir, { recursive: true });
    evidencePath = path.join(options.evidenceDir, 'uat.log');
    for (let n = 2; await fs.access(evidencePath).then(() => true, () => false); n++) evidencePath = path.join(options.evidenceDir, `uat-${n}.log`);
    await fs.writeFile(evidencePath, [
      '# softfactory UAT evidence',
      `run_id: ${options.runId}`,
      `timestamp: ${new Date().toISOString()}`,
      '',
      ...steps.map(s => `${s.passed ? 'PASS' : 'FAIL'}  ${s.name}: ${s.detail}`),
      '',
      ...transcript,
      `RESULT: ${failed ? 'FAIL' : 'PASS'}`,
      '',
    ].join('\n'), 'utf8');
  }
  return { configured: true, passed: !failed, steps, evidencePath };
}

/**
 * Stops the process groups setup left running, on POSIX. Each id is the pid of
 * the shell that ran the step (its own group, see `hostShell`), which is also
 * the group a backgrounded child inherited. SIGTERM first, five seconds for the
 * group to go, then SIGKILL for the survivors. A group that is already gone
 * (teardown stopped it, or it exited on its own) does not count. Never throws:
 * it runs in `runUat`'s finally, and cleanup must not turn a result into a crash.
 * Returns how many groups actually had to be stopped.
 */
async function stopProcessGroups(pids: number[]): Promise<number> {
  let stopped = 0;
  for (const pid of pids) {
    if (!signalGroup(pid, 'SIGTERM')) continue;
    stopped++;
    if (await groupGone(pid, 5_000)) continue;
    signalGroup(pid, 'SIGKILL');
    await groupGone(pid, 2_000);
  }
  return stopped;
}

/** Signals a process group; false when it no longer exists or cannot be signalled. Windows has no groups to signal. */
function signalGroup(pid: number | undefined, signal: NodeJS.Signals | 0): boolean {
  if (!pid || process.platform === 'win32') return false;
  try { process.kill(-pid, signal); return true; } catch { return false; }
}

async function groupGone(pid: number, withinMs: number): Promise<boolean> {
  for (const deadline = Date.now() + withinMs; Date.now() < deadline;) {
    if (!signalGroup(pid, 0)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !signalGroup(pid, 0);
}

function tail(output: string, chars = 240): string {
  const text = output.trim().replace(/\s+/g, ' ');
  return text.length > chars ? `…${text.slice(-chars)}` : text || '(no output)';
}
