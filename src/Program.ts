import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

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

/** Words in a context goal that always stop the driver for a person. */
export const DEFAULT_ALWAYS_STOP = ['cutover', 'contract', 'regulatory', 'activation'];

export const ContextSchema = z.strictObject({
  /** Stable handle used by `depends_on` and the history. */
  id: z.string().min(1, 'context.id must not be empty'),
  goal: z.string().default(''),
  /** Glob-ish path prefixes the context owns; never empty. */
  scope: z.array(z.string()).min(1, 'scope must not be empty'),
  depends_on: z.array(z.string()).default([]),
  size: SizeSchema.default('m'),
  slices: z.array(z.unknown()).default([]),
  status: ContextStatusSchema.default('pending'),
  feature_id: z.string().nullable().default(null),
  pr: z.union([z.string(), z.number()]).nullable().default(null),
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
  commits: z.array(z.string()).optional(),
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

function readinessReason(program: Program, context: Context): string {
  if (context.status === 'done') return 'done';
  if (context.status === 'active') return 'active';
  if (context.status === 'parked') return `parked: ${context.parked_reason ?? ''}`.trim();
  const byId = new Map(program.contexts.map(candidate => [candidate.id, candidate]));
  const waiting = context.depends_on.filter(id => byId.get(id)?.status !== 'done');
  if (waiting.length) return `waits on ${waiting.join(', ')}`;
  return 'pending';
}

/**
 * One line per context: id, status, size, depends_on and the readiness reason
 * (`pending`, `waits on <id>`, `done`, `parked: <reason>` or `active`).
 */
export function formatStatus(program: Program): string[] {
  return program.contexts.map(context => {
    const deps = context.depends_on.length ? context.depends_on.join(', ') : '-';
    return `${context.id}  ${context.status}  ${context.size}  [${deps}]  ${readinessReason(program, context)}`;
  });
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
