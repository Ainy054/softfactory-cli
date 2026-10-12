import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { ProtectedPaths } from './ProtectedPaths.js';

/**
 * The 6.3 program driver's file: `.softfactory/program.json`. A goal too big
 * for one plan is recorded as a list of bounded contexts plus the order
 * between them (`depends_on`), what each context has produced so far, and an
 * append-only history of stop/resume decisions.
 *
 * The schema is strict: an unknown key is rejected so a typo in a hand-edited
 * file cannot be silently ignored. Cross-context checks (duplicate ids,
 * unknown/cyclic dependencies) run in a `superRefine` and name the offending
 * field.
 */
export const PROGRAM_FILE = path.join('.softfactory', 'program.json');
/** Written by `program stop`, removed by `program resume`. */
export const STOPPED_FILE = path.join('.softfactory', 'STOPPED');

export const SizeSchema = z.enum(['s', 'm', 'l', 'xl']);
export const ContextStatusSchema = z.enum(['pending', 'active', 'done', 'parked']);

/** Gate classes that always wait for a person (see .softfactory/gates.md). */
export const DEFAULT_ALWAYS_STOP = ['cutover', 'contract', 'regulatory', 'activation'];

export const ContextSchema = z.strictObject({
  /** Stable handle used by `depends_on` and the history. */
  id: z.string().min(1, 'context.id must not be empty'),
  goal: z.string().default(''),
  /** Glob-ish path prefixes the context owns; never empty. */
  scope: z.array(z.string()).min(1, 'scope must not be empty'),
  depends_on: z.array(z.string()).default([]),
  size: SizeSchema.default('m'),
  /** Requirement text for each slice of a context too big for one plan. */
  slices: z.array(z.string()).default([]),
  status: ContextStatusSchema.default('pending'),
  feature_id: z.string().nullable().default(null),
  pr: z.number().int().positive().nullable().default(null),
  parked_reason: z.string().nullable().default(null),
  slice_index: z.number().int().nonnegative().default(0),
});

export const BudgetWindowSchema = z.strictObject({
  tokens: z.number().int().nonnegative().default(6_000_000),
  hours: z.number().positive().default(24),
});

export const PolicySchema = z.strictObject({
  always_stop: z.array(z.string()).default([...DEFAULT_ALWAYS_STOP]),
  size_threshold: SizeSchema.default('l'),
  budget_window: BudgetWindowSchema.default({ tokens: 6_000_000, hours: 24 }),
  pr: z.boolean().default(true),
});

/** Strict so a typo in an append-only log is caught, not dropped. */
export const HistoryEntrySchema = z.strictObject({
  at: z.string(),
  context: z.string(),
  action: z.string(),
  feature_id: z.string().optional(),
  result: z.string(),
  commits: z.number().int().nonnegative().optional(),
  tokens: z.number().int().nonnegative().optional(),
});

/** A fully populated default policy; used for the skeleton and as a base. */
export function defaultPolicy(): Policy {
  return {
    always_stop: [...DEFAULT_ALWAYS_STOP],
    size_threshold: 'l',
    budget_window: { tokens: 6_000_000, hours: 24 },
    pr: true,
  };
}

export const ProgramSchema = z
  .strictObject({
    goal: z.string().default(''),
    contexts: z.array(ContextSchema).default([]),
    policy: PolicySchema.default(defaultPolicy()),
    history: z.array(HistoryEntrySchema).default([]),
  })
  .superRefine((program, ctx) => {
    // Duplicate context ids.
    const ids = new Set<string>();
    program.contexts.forEach((context, index) => {
      if (ids.has(context.id)) {
        ctx.addIssue({ code: 'custom', path: ['contexts', index, 'id'], message: `duplicate context id "${context.id}"` });
      }
      ids.add(context.id);
    });

    // depends_on pointing at an id that does not exist.
    program.contexts.forEach((context, index) => {
      context.depends_on.forEach(dependency => {
        if (!ids.has(dependency)) {
          ctx.addIssue({
            code: 'custom',
            path: ['contexts', index, 'depends_on'],
            message: `unknown depends_on id "${dependency}"`,
          });
        }
      });
    });

    // A depends_on cycle means no context can ever become ready.
    const byId = new Map(program.contexts.map(context => [context.id, context]));
    const visited = new Set<string>();
    const onStack = new Set<string>();
    let cycleReported = false;
    const visit = (id: string, trail: string[]): void => {
      if (visited.has(id)) return;
      if (onStack.has(id)) {
        if (!cycleReported) {
          cycleReported = true;
          const cycle = [...trail.slice(trail.indexOf(id)), id].join(' -> ');
          ctx.addIssue({ code: 'custom', path: ['contexts'], message: `dependency cycle in depends_on: ${cycle}` });
        }
        return;
      }
      onStack.add(id);
      for (const dependency of byId.get(id)?.depends_on ?? []) {
        if (byId.has(dependency)) visit(dependency, [...trail, id]);
      }
      onStack.delete(id);
      visited.add(id);
    };
    for (const context of program.contexts) visit(context.id, []);
  });

export type Context = z.infer<typeof ContextSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type Program = z.infer<typeof ProgramSchema>;

/**
 * Injectable side effects for {@link readiness}. Tests can supply stubs so
 * deciding what to work on next never needs GitHub or the archive directory.
 */
export type Deps = {
  /** The archived feature record for a context's feature, or null/undefined when absent. */
  archived(featureId: string): Promise<{ status?: string; pr?: number | null } | null | undefined>;
  /** The GitHub state of a context's pull request. */
  prState(number: number): Promise<'OPEN' | 'MERGED' | 'CLOSED'>;
  /** Open gates from `.softfactory/gates.md`; stubbed to `[]` until that lands. */
  openGates(): Promise<Array<{ class: string; scope: string[] }>>;
};

/** The empty skeleton `program init` and a missing file both produce. */
export function defaultProgram(goal = ''): Program {
  return { goal, contexts: [], policy: defaultPolicy(), history: [] };
}

function programPath(baseDir: string): string {
  return path.join(baseDir, PROGRAM_FILE);
}

function stoppedPath(baseDir: string): string {
  return path.join(baseDir, STOPPED_FILE);
}

/** Reads a validated program, never throwing if the JSON has not been written. */
async function readProgram(baseDir: string): Promise<Program> {
  let raw: string;
  try {
    raw = await fs.readFile(programPath(baseDir), 'utf8');
  } catch {
    return defaultProgram();
  }
  const parsed: unknown = JSON.parse(raw);
  return ProgramSchema.parse(parsed);
}

/**
 * Reads `.softfactory/program.json` relative to `baseDir`. A missing file is
 * not an error: it returns the default skeleton (empty goal, no contexts,
 * default policy, empty history). Invalid content throws a `ZodError` naming
 * the field.
 */
export function loadProgram(baseDir: string): Promise<Program> {
  return readProgram(baseDir);
}

/** Validates then writes through a uniquely named temp file and renames it into place. */
export async function saveProgram(baseDir: string, program: Program): Promise<void> {
  const parsed = ProgramSchema.parse(program);
  const file = programPath(baseDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

const SIZE_RANK: Record<Context['size'], number> = { s: 0, m: 1, l: 2, xl: 3 };

function isLarge(program: Program, context: Context): boolean {
  return SIZE_RANK[context.size] >= SIZE_RANK[program.policy.size_threshold];
}

/** True when an always-stop gate's scope glob overlaps the context's scope glob. */
function gateCovers(gateScope: string[], contextScope: string[]): boolean {
  const gates = gateScope.map(scope => scope.trim()).filter(scope => scope.length > 0);
  const contexts = contextScope.map(scope => scope.trim()).filter(scope => scope.length > 0);
  return gates.some(gate => contexts.some(context => scopesOverlap(gate, context)));
}

/** True when two path globs can match the same file path. */
function scopesOverlap(a: string, b: string): boolean {
  const aRegex = ProtectedPaths.toRegex(a);
  const bRegex = ProtectedPaths.toRegex(b);
  return expandGlob(a).some(candidate => bRegex.test(candidate))
    || expandGlob(b).some(candidate => aRegex.test(candidate));
}

/**
 * Concrete paths a scope glob matches. `**` expands to a few directory depths
 * (including zero), `*` to an empty or single segment character, and `?` to one
 * character, so overlap between two globs can be checked with
 * {@link ProtectedPaths.toRegex} on each candidate.
 */
function expandGlob(glob: string): string[] {
  return expandGlobAt(glob, 0);
}

function expandGlobAt(glob: string, index: number): string[] {
  if (index >= glob.length) return [''];
  const ch = glob[index];
  if (ch === '*') {
    if (glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        const rest = expandGlobAt(glob, index + 3);
        return rest.flatMap(suffix => [
          suffix,
          `x/${suffix}`,
          `x/y/${suffix}`,
        ]);
      }
      const rest = expandGlobAt(glob, index + 2);
      return rest.flatMap(suffix => [
        suffix,
        `x/${suffix}`,
        `x${suffix}`,
      ]);
    }
    const rest = expandGlobAt(glob, index + 1);
    return rest.flatMap(suffix => [suffix, `x${suffix}`]);
  }
  if (ch === '?') {
    return expandGlobAt(glob, index + 1).map(suffix => `x${suffix}`);
  }
  return expandGlobAt(glob, index + 1).map(suffix => ch + suffix);
}

/** Returns a blocker reason for one dependency, or null when it is done. */
async function dependencyReason(program: Program, dependency: Context, deps: Deps): Promise<string | null> {
  if (dependency.pr != null) {
    let state: string;
    try {
      state = await deps.prState(dependency.pr);
    } catch (error: any) {
      // Offline or gh not signed in: the dependency is not known to be done.
      return `waits on ${dependency.id} (PR #${dependency.pr} state unknown: ${String(error?.message ?? error).split('\n')[0].slice(0, 120)})`;
    }
    if (state === 'MERGED') return null;
    if (state === 'OPEN') return `waits on ${dependency.id} (PR #${dependency.pr} open)`;
    if (state === 'CLOSED') return `waits on ${dependency.id} (PR #${dependency.pr} closed)`;
    return `waits on ${dependency.id}`;
  }
  // Marked done by hand (or by a non-PR advance): done.
  if (dependency.status === 'done') return null;
  if (program.policy.pr === false && dependency.feature_id != null) {
    const archived = await deps.archived(dependency.feature_id);
    if (archived?.status === 'completed' && archived.pr == null) return null;
  }
  return `waits on ${dependency.id}`;
}

/**
 * Which contexts the driver may work on next. A context is ready when its
 * status allows a run (`pending`, or `active` with no run in progress), every
 * dependency is done, no open always-stop gate covers its scope, and a large
 * context has at least one slice to plan.
 */
export function readiness(program: Program, deps: Deps): Promise<Array<{ id: string; ready: boolean; reason: string }>> {
  return computeReadiness(program, deps);
}

async function computeReadiness(program: Program, deps: Deps): Promise<Array<{ id: string; ready: boolean; reason: string }>> {
  const byId = new Map(program.contexts.map(context => [context.id, context]));
  const gates = await deps.openGates();
  const stoppingGates = gates.filter(gate => program.policy.always_stop.includes(gate.class));
  const results: Array<{ id: string; ready: boolean; reason: string }> = [];
  for (const context of program.contexts) {
    if (context.status === 'done') {
      results.push({ id: context.id, ready: false, reason: 'done' });
      continue;
    }
    if (context.status === 'parked') {
      results.push({ id: context.id, ready: false, reason: `parked: ${context.parked_reason ?? ''}`.trim() });
      continue;
    }
    if (context.status !== 'pending' && context.status !== 'active') {
      results.push({ id: context.id, ready: false, reason: context.status });
      continue;
    }

    const depReason: string | null = await (async () => {
      for (const id of context.depends_on) {
        const dependency = byId.get(id);
        if (!dependency) continue;
        const reason = await dependencyReason(program, dependency, deps);
        if (reason) return reason;
      }
      return null;
    })();
    if (depReason) {
      results.push({ id: context.id, ready: false, reason: depReason });
      continue;
    }

    const gate = stoppingGates.find(candidate => gateCovers(candidate.scope, context.scope));
    if (gate) {
      results.push({ id: context.id, ready: false, reason: `open gate ${gate.class} covers scope` });
      continue;
    }

    if (isLarge(program, context) && context.slices.length === 0) {
      results.push({
        id: context.id,
        ready: false,
        reason: `needs slices (size ${context.size} ≥ threshold ${program.policy.size_threshold})`,
      });
      continue;
    }

    results.push({ id: context.id, ready: true, reason: 'ready' });
  }
  return results;
}

/**
 * The requirement text for the next run of a context: the program goal, the
 * context goal, its scope paths, and (when sliced) the current slice with its
 * position and the note that earlier slices are already merged.
 */
export function nextRequirement(program: Program, contextId: string): string {
  const context = program.contexts.find(candidate => candidate.id === contextId);
  if (!context) return '';
  const lines = [
    program.goal,
    context.goal,
    `change only files under: ${context.scope.join(', ')}`,
  ];
  if (context.slices.length > 0) {
    lines.push(
      context.slices[context.slice_index] ?? '',
      `this is slice ${context.slice_index + 1} of ${context.slices.length}; earlier slices are merged`,
    );
  }
  return lines.join('\n\n');
}

async function appendHistory(baseDir: string, program: Program, entry: HistoryEntry): Promise<Program> {
  program.history.push(entry);
  await saveProgram(baseDir, program);
  return program;
}

/**
 * Writes `.softfactory/STOPPED` with the reason and an ISO timestamp, then
 * records the stop in `history`. The caller can resume later with
 * {@link resumeProgram}.
 */
export async function stopProgram(baseDir: string, reason?: string): Promise<Program> {
  const program = await loadProgram(baseDir);
  const at = new Date().toISOString();
  const file = stoppedPath(baseDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ at, reason: reason ?? null }) + '\n', 'utf8');
  return appendHistory(baseDir, program, {
    at,
    context: 'program',
    action: 'stop',
    result: reason ?? 'stopped',
  });
}

/** Removes `.softfactory/STOPPED` and records the resume in `history`. */
export async function resumeProgram(baseDir: string): Promise<Program> {
  const program = await loadProgram(baseDir);
  const at = new Date().toISOString();
  await fs.rm(stoppedPath(baseDir), { force: true });
  return appendHistory(baseDir, program, {
    at,
    context: 'program',
    action: 'resume',
    result: 'resumed',
  });
}
