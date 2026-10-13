import { Task, Handoff } from './types.js';
import type { Environment } from './Environment.js';
import type { SandboxManager } from './Sandbox.js';

export interface WorkerOptions {
  onOutput?: (line: string) => void;
  streamToTerminal?: boolean;
  projectContext?: string;
  memoryPatterns?: string[];
  model?: string;
  diagnosticsDir?: string;
  /** Where the worker's run_command calls execute; host allowlist only when absent. */
  sandbox?: SandboxManager;
  /** Aborted when the attempt's wall-clock budget is spent; the worker stops at its next step. */
  signal?: AbortSignal;
  /** Token counts per model turn, when the backend reports them. */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  /**
   * The user's requirement, verbatim. The planner's task description is a
   * paraphrase; the first dogfood run lost the sample data the requirement
   * carried, and the worker went searching the repository for it.
   */
  requirement?: string;
  /**
   * A spec, value table or rename map shared by every task in this run,
   * written once so each task's description carries only its delta.
   */
  brief?: string;
  /** Role guidance for a designer or CX reviewer task (see roleSection). */
  roleBrief?: string;
  /** Globs of files only the orchestrator edits (environment.json); changes to them travel as the handoff's wiring_patch. */
  orchestratorFiles?: string[];
  /**
   * From the second attempt: exact signatures of the task's files and what
   * not to do again. Softhouse: a retry is a different prompt, not only a
   * bigger model; one that differs only in feedback repeats the failure.
   */
  retryBrief?: string;
  /**
   * Receives the full assembled worker prompt, called exactly once per execute
   * attempt before the backend runs. Softhouse saves it so a retry can be
   * compared with the attempt before it and a rerun is reproducible.
   */
  onPrompt?: (prompt: string) => void;
  /**
   * The safety block every worker prompt must carry as its very first text,
   * built once per run from environment.json. See safetyPreamble.
   */
  preamble?: string;
}

/**
 * The safety block every worker prompt starts with. It is assembled from the
 * run's environment.json facts, but is a pure function of `env`, so two calls
 * with the same environment produce byte-identical text. Workers cannot run
 * deploy scripts, reach the live stack, or edit the orchestrator's files, and
 * each attempt must affirm that the live stack was left untouched.
 */
/**
 * The safety block ends by asking the worker to affirm "live stack untouched".
 * Only a line that is exactly that phrase counts: an agent's output can echo
 * its prompt, which contains the phrase inside the request itself.
 */
/**
 * A prompt that travels as a command-line argument. The OS rejects NUL bytes in
 * argv ("Arguments cannot contain null bytes"), and one binary file read into
 * the context once ended planning before it started.
 */
export function argvText(text: string): string {
  return text.includes('\0') ? text.replace(/\0/g, '') : text;
}

export function affirmsLiveStackUntouched(output: string | undefined): boolean {
  return String(output ?? '').split('\n').some(line => /^["'`*\s]*live stack untouched[."'`*\s]*$/i.test(line));
}

export function safetyPreamble(env: Environment | undefined): string {
  const bullets: string[] = [];
  bullets.push(env
    ? `- Live system (never touch it; work only in your isolated worktree): ${env.live}`
    : `- No environment.json: assume a live system may exist and touch nothing outside your worktree.`);
  const deploys: string[] = [];
  if (env?.test_env?.deploy) deploys.push(`${env.test_env.name || 'TEST'} deploy "${env.test_env.deploy}"`);
  if (env?.production?.deploy) deploys.push(`production deploy "${env.production.deploy}"`);
  bullets.push(deploys.length
    ? `- Never run deploy scripts (${deploys.join(', ')}), never ssh, and never touch .env or secrets.`
    : `- Never run deploy scripts, never ssh, and never touch .env or secrets.`);
  bullets.push(`- Do not run \`docker compose up/down/build/restart\`; the orchestrator owns the stacks.`);
  bullets.push(`- You are in an isolated worktree; never run git against another checkout.`);
  if (env?.orchestrator_files?.length) {
    bullets.push(`- Files only the orchestrator edits (never edit these; send the change as the handoff's wiring_patch): ${env.orchestrator_files.join(', ')}`);
  }
  bullets.push(`- When you finish, affirm "live stack untouched": set finish_task's live_stack_untouched, or end your final message with that phrase alone on its own line.`);
  return `CRITICAL SAFETY:\n${bullets.join('\n')}\n`;
}

/**
 * A backend that refused to work for reasons outside the task: a spent usage
 * limit, a rate limit, a billing stop. Codex answered "You've hit your usage
 * limit" four times in a row and each one was charged to the task as a crash.
 * Returns the line that says so, or null.
 */
export function backendRefusal(text: string): string | null {
  const pattern = /usage limit|rate[ _-]?limit|too many requests|(?:status|http|code|error)\D{0,12}\b(?:429|529)\b|insufficient[ _]quota|quota (?:exceeded|exhausted)|out of credits|purchase more credits|billing (?:hard )?limit|overloaded_error/i;
  const line = String(text || '').split('\n').find(l => pattern.test(l));
  return line ? line.trim().slice(0, 200) : null;
}

/**
 * Split acceptance (Softhouse): a check that needs the running stack is
 * written "orchestrator: <command>". Workers cannot run it and the per-task
 * gate skips it; the orchestrator runs it on the host after merge, with UAT.
 */
export function isDeferredAcceptance(command: string | undefined): boolean {
  return /^\s*orchestrator:/i.test(command || '');
}
export function deferredCommand(command: string): string {
  return command.replace(/^\s*orchestrator:\s*/i, '').trim();
}

/** The acceptance line every worker prompt carries. */
export function acceptanceLine(command: string | undefined): string {
  if (!command) return '';
  return isDeferredAcceptance(command)
    ? `Live check (the orchestrator runs this against the running system after merge; you cannot run it, so make sure your change satisfies it): ${deferredCommand(command)}`
    : `Acceptance command (run verbatim by the orchestrator after you finish; make it pass): ${command}`;
}

/** The shared brief, spec, out-of-scope and notes block every worker prompt carries, when present. */
export function briefSection(task: Pick<Task, 'spec' | 'out_of_scope' | 'notes_to_executor'>, brief?: string, roleBrief?: string): string {
  let section = roleBrief || '';
  const shared = brief?.trim();
  if (shared) section += `\nRUN BRIEF (shared by every task in this run):\n${shared}\n`;
  if (task.spec) section += `\nSpec: ${task.spec}\n`;
  if (task.out_of_scope?.length) section += `\nOut of scope (do not touch):\n${task.out_of_scope.map(o => `- ${o}`).join('\n')}\n`;
  if (task.notes_to_executor?.length) section += `\nNotes from the planner:\n${task.notes_to_executor.map(n => `- ${n}`).join('\n')}\n`;
  return section;
}

/**
 * Wire before review, borrowed from Softhouse: bootstrap, route registration
 * and compose files belong to the orchestrator. A worker that needs a change
 * there sends it as a unified diff, which is applied on its branch and built
 * before review.
 */
export function wiringSection(files: string[] | undefined): string {
  if (!files?.length) return '';
  return `\nORCHESTRATOR-OWNED FILES (never edit these; put the exact change in the handoff's wiring_patch as one unified diff, paths relative to the repository root, --- a/<path> and +++ b/<path>; it is applied on your branch before review):\n${files.map(f => `- ${f}`).join('\n')}\n`;
}

/** Where designers put mockups: tracked, so they travel with the branch and the pull request. */
export const MOCKUP_DIR = 'softfactory-design/mockups';

/** Softhouse's CX checklist: applicable items must pass, N/A items must be justified. */
export const CX_CHECKLIST = [
  'Loading state: shows a skeleton or spinner while data loads',
  'Empty state: a meaningful message when there is no data, not a blank screen',
  'Error state: a user-friendly message with a retry action, not a raw error dump',
  'Responsive: works at 375px (mobile), 768px (tablet) and 1280px+ (desktop)',
  'Keyboard navigation: every interactive element reachable with Tab and activated with Enter or Space',
  'Accessible: ARIA labels, semantic HTML (nav, main, button rather than div), contrast of 4.5:1 or more',
  'Feedback: user actions produce a visible confirmation (save shows "Saved")',
  'Form validation: inline errors on blur, submit disabled until valid',
  'No raw technical errors visible (no stack traces, "undefined" or "NaN")',
  'Consistent styling: the project\'s design tokens or theme, not arbitrary colors or sizes',
];

/**
 * Role guidance, borrowed from Softhouse's designer and CX reviewer role
 * texts. A designer designs before code: its approved mockup becomes the
 * coder's acceptance target. A CX reviewer scores and fixes UI quality.
 */
export function roleSection(task: Pick<Task, 'id' | 'agent_role'>, designSystem?: string): string {
  const system = designSystem?.trim() ? `\nPROJECT DESIGN SYSTEM (.softfactory/design/design.md; reuse what it declares):\n${designSystem.trim()}\n` : '';
  if (task.agent_role === 'designer') {
    return `\nROLE: DESIGNER. You design BEFORE code; the approved mockup becomes the coder's acceptance target.
- Write one self-contained HTML mockup per screen at ${MOCKUP_DIR}/${task.id}-<screen>.html: all CSS inline from the project's tokens, real domain data, and the empty, error and loading variants as labelled sections.
- Show the layout at 375px, 768px and 1280px; meet WCAG AA contrast; one primary action per view.
- Reuse the project's tokens and components; a new one needs a stated reason in your summary.
- Do NOT modify application code: only files under ${MOCKUP_DIR}/ may change.
- In your summary give the design spec: tokens used, components reused or new, responsive behaviour, accessibility notes, deliberate deviations.
${system}`;
  }
  if (task.agent_role === 'cx_reviewer') {
    return `\nROLE: CX REVIEWER. Review the UI files the upstream task changed against this checklist; fix failing applicable items in the code; justify every item you mark N/A.
${CX_CHECKLIST.map(item => `- ${item}`).join('\n')}
- If an approved mockup is named in the task, mockup fidelity (structure, tokens, states) is the first and highest-weight check; an undocumented deviation is a failure.
${system}`;
  }
  return '';
}

/** The requirement block every worker prompt carries, bounded so it cannot crowd out the task. */
export function requirementSection(requirement: string | undefined, limit = 6000): string {
  const text = requirement?.trim();
  if (!text) return '';
  const shown = text.length > limit ? `${text.slice(0, limit)}\n…(truncated; the task description above carries the rest)` : text;
  return `\nFEATURE REQUIREMENT (verbatim from the user; this task is one part of it, and any sample data, formats or exact names in it are authoritative):\n${shown}\n`;
}

export interface IWorker {
  id: string;
  name: string;
  isAvailable(model?: string): Promise<boolean>;
  execute(task: Task, worktreePath: string, options?: WorkerOptions): Promise<Handoff>;
}

/**
 * Raised when the worker's backend is unreachable (daemon down, network gone).
 * This is an environment fault, not a task fault: it must never consume a
 * task's retry budget, because no work was attempted.
 */
export class WorkerEnvironmentError extends Error {
  readonly isEnvironmentFailure = true;
  constructor(message: string) {
    super(message);
    this.name = 'WorkerEnvironmentError';
  }
}

export function isEnvironmentFailure(error: unknown): boolean {
  return Boolean(error && (error as any).isEnvironmentFailure === true);
}
