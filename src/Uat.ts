import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';

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

export type ShellRunner = (command: string, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ exitCode: number; output: string }>;

const hostShell: ShellRunner = async (command, { cwd, env, timeoutMs }) => {
  const result = await execa('sh', ['-c', command], { cwd, env: { ...process.env, ...env }, timeout: timeoutMs, reject: false, all: true });
  return { exitCode: result.exitCode ?? (result.timedOut ? 124 : 1), output: String(result.all ?? '') };
};

export async function runUat(
  baseDir: string,
  config: UatConfig,
  options: { runId: string; featureId: string; evidenceDir?: string; log?: (line: string) => void; shell?: ShellRunner },
): Promise<UatResult> {
  const shell = options.shell ?? hostShell;
  const log = options.log ?? (() => {});
  const env = { SOFTFACTORY_RUN_ID: options.runId, SOFTFACTORY_FEATURE_ID: options.featureId };
  const timeoutMs = config.timeout_seconds * 1000;
  const steps: UatStep[] = [];
  const transcript: string[] = [];
  const run = async (name: string, command: string) => {
    const { exitCode, output } = await shell(command, { cwd: baseDir, env, timeoutMs });
    transcript.push(`$ ${command}  # ${name}`, output.trimEnd(), `exit_code: ${exitCode}`, '');
    return { exitCode, output };
  };
  const substitute = (text: string) => text.replace(/\$SOFTFACTORY_RUN_ID|\$\{SOFTFACTORY_RUN_ID\}/g, options.runId);

  let failed = false;
  try {
    if (config.build) {
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
    } else if (config.artifacts.length) {
      steps.push({ name: 'binary proof', passed: false, detail: 'artifacts are listed but there is no build command, so nothing proves they are fresh' });
      failed = true;
    }
    for (const [index, command] of (failed ? [] : config.setup).entries()) {
      const { exitCode, output } = await run(`setup ${index + 1}`, command);
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
    if (!config.build && !config.setup.length && !config.probes.length) {
      steps.push({ name: 'definition', passed: false, detail: `${UAT_FILE} defines no build, setup or probe` });
      failed = true;
    }
  } finally {
    for (const [index, command] of config.teardown.entries()) {
      const { exitCode } = await run(`teardown ${index + 1}`, command).catch(() => ({ exitCode: 1 }));
      if (exitCode !== 0) log(`UAT teardown ${index + 1} exited ${exitCode}: ${command}`);
    }
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

function tail(output: string, chars = 240): string {
  const text = output.trim().replace(/\s+/g, ' ');
  return text.length > chars ? `…${text.slice(-chars)}` : text || '(no output)';
}
