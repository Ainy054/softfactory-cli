import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProtectedPaths } from './ProtectedPaths.js';

/**
 * `.softfactory/environment.json`: the facts about the running system that
 * 6.0's live-system safety is built on, borrowed from Softhouse's STEP 0
 * environment-safety facts. Where the live system is (so no worker touches
 * it), the isolated test stack, the TEST environment and its deploy, the
 * production deploy (only a person promotes to it), health URLs, which
 * routes serve which files, and files only the orchestrator may edit.
 *
 * Like uat.json it is read from the main checkout's .softfactory/, which no
 * worktree can see or write, so a task cannot weaken the rules that judge it.
 */
export const EnvironmentSchema = z.object({
  /** One line: where the live system is, or "there is no production; this host is dev". */
  live: z.string().min(1),
  /** Brings up and tears down a stack isolated from the live one, for UAT. */
  test_stack: z.object({ up: z.string().min(1), down: z.string().optional() }).optional(),
  /** A TEST environment distinct from production; promotion-marked work stops here. */
  test_env: z.object({ name: z.string().default('TEST'), deploy: z.string().min(1), url: z.string().optional() }).optional(),
  /** How production is deployed. Only `--promote` runs it, never a worker or an unattended run. */
  production: z.object({ deploy: z.string().min(1) }).optional(),
  /** URLs that answer 2xx when the system under test is healthy. */
  health: z.array(z.string()).default([]),
  /** Routes to fetch when a run changes the files that serve them (globs, `**` crosses directories). */
  routes: z.array(z.object({ files: z.array(z.string()).min(1), url: z.string().min(1), expect: z.string().optional() })).default([]),
  /** Globs of files only the orchestrator edits (bootstrap, route registration, compose); workers send a patch instead. */
  orchestrator_files: z.array(z.string()).default([]),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

export const ENVIRONMENT_FILE = path.join('.softfactory', 'environment.json');

/** Undefined when the project has none; throws on a malformed one, which is a configuration error. */
export async function loadEnvironment(baseDir: string): Promise<Environment | undefined> {
  let raw: string;
  try { raw = await fs.readFile(path.join(baseDir, ENVIRONMENT_FILE), 'utf8'); }
  catch { return undefined; }
  let json: unknown;
  try { json = JSON.parse(raw); }
  catch (error: any) { throw new Error(`${ENVIRONMENT_FILE} is not valid JSON: ${error.message}`); }
  const parsed = EnvironmentSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${ENVIRONMENT_FILE} is invalid: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

const matcher = (globs: string[]) => {
  const regexes = globs.map(glob => ProtectedPaths.toRegex(glob.trim())).filter(Boolean);
  return (file: string) => regexes.some(regex => regex.test(file));
};

/** The routes whose serving files a change touched, each once. */
export function changedRoutes(env: Environment, changedFiles: string[]): Environment['routes'] {
  return env.routes.filter(route => changedFiles.some(matcher(route.files)));
}

/** Files of a change that only the orchestrator may edit. */
export function orchestratorOwned(env: Environment | undefined, files: string[]): string[] {
  if (!env?.orchestrator_files.length) return [];
  const owned = matcher(env.orchestrator_files);
  return files.filter(owned);
}
