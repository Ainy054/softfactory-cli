import { ProtectedPaths } from './ProtectedPaths.js';
import { decideGate, openGates } from './Gates.js';
import { gateCovers, loadProgram, type Program } from './Program.js';
import type { PlanApprover } from './PlanApproval.js';
import type { FactoryState, Task } from './types.js';

/**
 * The plan checklist, borrowed from Softhouse: when nobody is at the terminal
 * (a program advancing on a schedule), seven deterministic checks stand in
 * for the person who would approve the plan. A plan that passes all of them
 * runs; any miss saves the plan as `planned` and opens a `plan` gate in
 * `.softfactory/gates.md` for a person.
 */
export interface ChecklistContext {
  /** The program context this plan is for. */
  contextId: string;
  /** The context's scope globs; every file the plan touches must match one. */
  scope: string[];
  /** Gate classes that always wait for a person (`policy.always_stop`). */
  alwaysStop: string[];
  /** Open always-stop gates; one covering the scope is a miss. */
  openGates: Array<{ id?: string; class: string; scope: string[] }>;
  /** Tokens left in the program's budget window. */
  budgetTokensLeft: number;
  /** An explicit --max-tokens for the run, which replaces the plan's estimate. */
  maxTokens?: number;
}

export interface ChecklistResult {
  ok: boolean;
  misses: string[];
}

/** Words that put a task in an always-stop class: a person decides those. */
export const ALWAYS_STOP_SUBJECTS: Record<string, RegExp> = {
  cutover: /\b(?:cut ?over|switch(?:es|ing)? (?:production )?traffic|go[- ]live|deploy(?:s|ing)? to production|production deploy\w*|dns (?:change|switch|record))\b/i,
  contract: /\b(?:breaking change|api contract|public api|response (?:format|shape|schema)|request (?:format|shape|schema)|openapi|versioned? (?:the )?api|wire format)\b/i,
  regulatory: /\b(?:gdpr|hipaa|pci(?:[- ]dss)?|sox|compliance|regulat(?:ory|ion|ed)|retention polic\w*|personal data|kyc|aml)\b/i,
  activation: /\b(?:enable (?:it |the feature )?(?:in|for) production|turn(?:s|ing)? on for (?:all )?users|activate[sd]? (?:the )?(?:feature|flag)|feature flag on|roll(?:s|ing)? out to (?:all )?users)\b/i,
};

/** A review question that asks nothing specific. */
const GENERIC_QUESTION = /^(?:please )?(?:review|check|look at|verify)(?: the)? (?:code|changes?|diff|implementation)\.?$/i;

/** Tokens of a command that look like file paths. */
function commandPaths(command: string): string[] {
  return command.split(/\s+/)
    .map(token => token.replace(/^['"]|['"]$/g, ''))
    .filter(token => !token.startsWith('-') && !/^[a-z]+:\/\//i.test(token))
    .filter(token => token.includes('/') || /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|json|ya?ml|toml|sh|sql|md)$/i.test(token));
}

function inScope(file: string, matchers: RegExp[]): boolean {
  return matchers.some(regex => regex.test(file));
}

/** Every task id reachable through dependencies and blockedBy. */
function ancestors(task: Task, byId: Map<string, Task>): Set<string> {
  const seen = new Set<string>();
  const stack = [...task.dependencies, ...task.blockedBy];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const parent = byId.get(id);
    if (parent) stack.push(...parent.dependencies, ...parent.blockedBy);
  }
  return seen;
}

/** The seven checks. Each miss is one line naming the task and what to fix. */
export function checkPlan(state: Pick<FactoryState, 'tasks' | 'token_estimate'>, ctx: ChecklistContext): ChecklistResult {
  const misses: string[] = [];
  const tasks = state.tasks;
  const byId = new Map(tasks.map(task => [task.id, task]));
  const scope = ctx.scope.map(glob => ProtectedPaths.toRegex(glob));
  const created = new Set(tasks.flatMap(task => task.creates_files));

  for (const task of tasks) {
    if (task.executor !== 'agent') continue;
    // 1. Runnable acceptance, red at planning time.
    const summary = task.acceptance_baseline?.summary ?? '';
    if (!task.verification_command) misses.push(`1 acceptance: ${task.id} has no verification_command`);
    else if (!task.acceptance_baseline) misses.push(`1 acceptance: ${task.id} was not probed at planning time`);
    else if (!summary.startsWith('red')) misses.push(`1 acceptance: ${task.id} \`${task.verification_command}\` is not red at planning time (${summary})`);

    // 7. Acceptance names only files inside scope or files the plan creates.
    for (const file of task.verification_command ? commandPaths(task.verification_command) : []) {
      if (!inScope(file, scope) && !created.has(file)) misses.push(`7 acceptance scope: ${task.id} \`${task.verification_command}\` names ${file}, outside ${ctx.scope.join(', ')}`);
    }

    // 4. Protected tasks carry specific review questions.
    if (task.protected) {
      const questions = task.review_questions.map(q => q.trim()).filter(Boolean);
      if (questions.length === 0 || questions.every(q => GENERIC_QUESTION.test(q))) {
        misses.push(`4 review questions: protected ${task.id} has no specific question for the blind reviewer`);
      }
    }
  }

  // 2. Every file the plan touches is inside the context's scope.
  for (const task of tasks) {
    const outside = [...task.files_hint, ...task.creates_files].filter(file => !inScope(file, scope));
    if (outside.length) misses.push(`2 scope: ${task.id} touches ${[...new Set(outside)].join(', ')}, outside ${ctx.scope.join(', ')}`);
  }

  // 3. No always-stop subject: person-run steps, live windows, TEST promotion,
  //    an open always-stop gate on the scope, or a task about an always-stop class.
  for (const task of tasks) {
    if (task.executor === 'user') misses.push(`3 always-stop: ${task.id} is a step a person performs`);
    else if (task.window) misses.push(`3 always-stop: ${task.id} is part of live window "${task.window}"`);
    if (task.promotion === 'test') misses.push(`3 always-stop: ${task.id} is promoted through TEST, which a person decides`);
    const text = `${task.title}\n${task.description}`;
    for (const klass of ctx.alwaysStop) {
      const subject = ALWAYS_STOP_SUBJECTS[klass.toLowerCase()];
      const hit = subject?.exec(text);
      if (hit) misses.push(`3 always-stop: ${task.id} is about ${klass} ("${hit[0]}")`);
    }
  }
  for (const gate of ctx.openGates) {
    if (ctx.alwaysStop.includes(gate.class) && gateCovers(gate.scope, ctx.scope)) {
      misses.push(`3 always-stop: open ${gate.class} gate${gate.id ? ` ${gate.id}` : ''} covers ${ctx.scope.join(', ')}`);
    }
  }

  // 5. The budget fits what is left in the window.
  const planned = ctx.maxTokens ?? state.token_estimate?.tokens;
  if (planned !== undefined && planned > ctx.budgetTokensLeft) {
    misses.push(`5 budget: the plan needs about ${planned} tokens; ${Math.max(0, ctx.budgetTokensLeft)} are left in the window`);
  }

  // 6. Same-phase tasks that share a file are ordered by a dependency.
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i], b = tasks[j];
      if (a.phase !== b.phase) continue;
      const aFiles = new Set([...a.files_hint, ...a.creates_files]);
      const shared = [...new Set([...b.files_hint, ...b.creates_files])].filter(file => aFiles.has(file));
      if (shared.length === 0) continue;
      if (ancestors(a, byId).has(b.id) || ancestors(b, byId).has(a.id)) continue;
      misses.push(`6 shared files: ${a.id} and ${b.id} both change ${shared.join(', ')} in phase ${a.phase} with no dependency between them`);
    }
  }

  return { ok: misses.length === 0, misses };
}

/**
 * The approver an unattended program run uses instead of a person: approve
 * a plan that passes the checklist; otherwise log each miss, open a `plan`
 * gate with the misses as its question, and decline, which saves the plan
 * as `planned` for a person.
 */
export function checklistApprover(baseDir: string, ctx: ChecklistContext, log: (line: string) => void = console.log): PlanApprover {
  return async state => {
    const result = checkPlan(state, ctx);
    if (result.ok) {
      log(`[SoftFactory] PLAN CHECKLIST: all 7 checks passed for ${ctx.contextId}; approving.`);
      return 'approve';
    }
    log(`[SoftFactory] PLAN CHECKLIST: ${result.misses.length} miss(es) for ${ctx.contextId}; the plan waits for a person.`);
    for (const miss of result.misses) log(`  - ${miss}`);
    const gate = await decideGate(baseDir, {
      class: 'plan',
      scope: ctx.scope.join(', '),
      question: `Plan ${state.feature_id} for ${ctx.contextId} missed the checklist: ${result.misses.join('; ')}`,
      choice: '',
      reason: '',
    }, [...ctx.alwaysStop, 'plan']);
    log(`[SoftFactory] Opened gate ${gate.gate.id} in .softfactory/gates.md.`);
    return 'abort';
  };
}

/** Tokens the program's advances recorded in history within its budget window. */
export function tokensInWindow(program: Program, now = Date.now()): number {
  const since = now - program.policy.budget_window.hours * 3_600_000;
  return program.history
    .filter(entry => Date.parse(entry.at) >= since)
    .reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
}

/** The checklist context for one program context, from program.json and gates.md. */
export async function programChecklistContext(baseDir: string, contextId: string, maxTokens?: number): Promise<ChecklistContext> {
  const program = await loadProgram(baseDir);
  const context = program.contexts.find(candidate => candidate.id === contextId);
  if (!context) throw new Error(`--checklist: no context "${contextId}" in .softfactory/program.json (contexts: ${program.contexts.map(c => c.id).join(', ') || 'none'}).`);
  return {
    contextId,
    scope: context.scope,
    alwaysStop: program.policy.always_stop,
    openGates: await openGates(baseDir, program.policy.always_stop),
    budgetTokensLeft: program.policy.budget_window.tokens - tokensInWindow(program),
    maxTokens,
  };
}
