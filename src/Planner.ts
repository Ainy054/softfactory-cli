import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { extractJson } from './extractJson.js';
import { AgyTextModel, DeepSeekTextModel, OllamaTextModel, createTextModel, type ITextModel } from './TextModel.js';
import { commandPolicyViolation } from './commandPolicy.js';
import type { Task } from './types.js';

export type PlannerProvider = 'openai' | 'agy' | 'local' | 'deepseek' | 'anthropic' | 'openai-api' | 'qwen' | 'openai-compat' | 'claude-code' | 'gemini-cli' | 'muse';

const BlueprintTaskSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  title: z.string().min(4),
  description: z.string().min(12),
  agent_role: z.enum(['coder', 'test_writer', 'docs', 'devops', 'architect', 'builder']),
  phase: z.number().int().positive(),
  dependencies: z.array(z.string()).default([]),
  blockedBy: z.array(z.string()).default([]),
  files_hint: z.array(z.string()).default([]),
  creates_files: z.array(z.string()).default([]),
  acceptance_criteria: z.array(z.string()).default([]),
  verification: z.array(z.string()).default([]),
  production_targets: z.array(z.string()).default([]),
  test_targets: z.array(z.string()).default([]),
  behavior_tags: z.array(z.string()).default([]),
  verification_command: z.string().optional(),
  // Advisory only; an unknown value is dropped rather than costing a repair round (issue #7's plan said "medium").
  complexity: z.preprocess(v => (['simple', 'moderate', 'complex'].includes(v as string) ? v : undefined), z.enum(['simple', 'moderate', 'complex']).optional()),
  allocation_reason: z.string().optional(),
  executor: z.enum(['agent', 'orchestrator', 'user', 'agent+orchestrator']).default('agent'),
  /** What the operator does on the live system once an agent+orchestrator change is merged. */
  apply_steps: z.string().optional(),
  promotion: z.enum(['prod', 'test']).default('prod'),
  review_questions: z.array(z.string()).default([]),
  /** A pointer into a shared spec, such as "docs/api.md §3". */
  spec: z.string().optional(),
  /** Things the worker must not touch, even if they seem related. */
  out_of_scope: z.array(z.string()).default([]),
  /** Invariants and hints the planner does not want to lose in the task description. */
  notes_to_executor: z.array(z.string()).default([]),
});

export const BlueprintSchema = z.object({
  feature: z.string().min(4),
  requirements_covered: z.array(z.string()).default([]),
  /** A spec, value table or rename map shared by several tasks, written once. */
  brief: z.string().max(6000).optional(),
  tasks: z.array(BlueprintTaskSchema).min(1),
});

export type Blueprint = z.infer<typeof BlueprintSchema>;

export interface PlanningInput {
  requirement: string;
  codebaseContext: string;
  memoryPatterns: string;
  featureHistory: string;
  repositoryFiles: Set<string>;
  /** Who will execute these tasks. A 7B/14B needs far smaller units than a frontier model. */
  workerCapability?: 'local' | 'cloud';
  /** Failure categories seen in 2 of the last 3 runs; the plan must change its approach for them. */
  recurringFailures?: string[];
}

export interface RefinementInput {
  refinement: string;
  currentTasks: Task[];
  codebaseContext: string;
  repositoryFiles: Set<string>;
  workerCapability?: 'local' | 'cloud';
}

export interface IPlanner {
  provider: PlannerProvider;
  /** Where the planner reports rejected drafts and repair rounds; the factory wires its own log. */
  log?: (line: string) => void;
  generateBlueprint(input: PlanningInput): Promise<Blueprint>;
  /** A mid-flight change to an in-progress plan; done tasks must come back unchanged. */
  refineBlueprint(input: RefinementInput): Promise<Blueprint>;
}

export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // OpenAI strict structured output (Codex --output-schema) requires every
  // property to be listed in `required`; the model returns '' / [] when unused.
  required: ['feature', 'requirements_covered', 'brief', 'tasks'],
  properties: {
    feature: { type: 'string' },
    requirements_covered: { type: 'array', items: { type: 'string' } },
    brief: { type: 'string', maxLength: 6000 },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'description', 'agent_role', 'phase', 'dependencies', 'blockedBy', 'files_hint', 'creates_files', 'acceptance_criteria', 'verification', 'production_targets', 'test_targets', 'behavior_tags', 'verification_command', 'complexity', 'allocation_reason', 'executor', 'apply_steps', 'promotion', 'review_questions', 'spec', 'out_of_scope', 'notes_to_executor'],
        properties: {
          executor: { type: 'string', enum: ['agent', 'orchestrator', 'user', 'agent+orchestrator'] },
          apply_steps: { type: 'string' },
          promotion: { type: 'string', enum: ['prod', 'test'] },
          review_questions: { type: 'array', items: { type: 'string' } },
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          agent_role: { type: 'string', enum: ['coder', 'test_writer', 'docs', 'devops', 'architect', 'builder'] },
          phase: { type: 'integer', minimum: 1 },
          dependencies: { type: 'array', items: { type: 'string' } },
          blockedBy: { type: 'array', items: { type: 'string' } },
          files_hint: { type: 'array', items: { type: 'string' } },
          creates_files: { type: 'array', items: { type: 'string' } },
          acceptance_criteria: { type: 'array', minItems: 1, items: { type: 'string' } },
          verification: { type: 'array', minItems: 1, items: { type: 'string' } },
          production_targets: { type: 'array', items: { type: 'string' } },
          test_targets: { type: 'array', items: { type: 'string' } },
          behavior_tags: { type: 'array', items: { type: 'string' } },
          verification_command: { type: 'string' },
          complexity: { type: 'string', enum: ['simple', 'moderate', 'complex'] },
          allocation_reason: { type: 'string' },
          spec: { type: 'string' },
          out_of_scope: { type: 'array', items: { type: 'string' } },
          notes_to_executor: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

const PLANNING_RULES = (workerCapability?: 'local' | 'cloud') => `Planning rules:
- Preserve working functionality and map every explicit requirement area exactly once or explain intentional overlap.
- Never transfer behavior from one component or domain to another.
- Reference an existing path only when it appears in Repository Context. Put justified new paths in both files_hint and creates_files.
- Prefer cohesive tasks over many sequential tasks editing the same file. Keep each task under roughly 300 changed lines.
- A spec shared by 3+ tasks goes once in \`brief\`; descriptions keep only their delta.
${workerCapability === 'local' ? `
LOCAL WORKER CONSTRAINT — these tasks will be executed by a 7B/14B model, not a frontier model:
- At most 2 files in files_hint per task, counting creates_files. Split anything larger.
- One concern per task. Do not bundle unrelated changes (a config split, a new lint config and dependency metadata are three tasks, not one).
- At most 3 acceptance_criteria per task, each checkable by running one command.
- Keep description under 250 characters. A long brief is a task that should have been split.
- Sequencing is cheap; a large task is not. Prefer more, smaller, dependency-ordered tasks.
` : ''}
- Put tests before dependent implementation where useful. Put the final cross-cutting quality gate in the last phase.
- Every agent task changes files; "run the tests" is the verification_command of the task it checks, never a task.
- Use dependencies for actual ordering. Same-phase tasks must not claim the same file.
- acceptance_criteria are observable outcomes; verification lists concrete commands or checks.
- Use agent+orchestrator with apply_steps for a change that is tested in the repository and then applied on a live system.
- A test_writer declares test_targets and production_targets, and depends on the implementation task when the behaviour does not exist yet.
- requirements_covered must copy every markdown requirement section title (## or ###) from the user requirement.
- The "feature" name must describe THIS requirement. Feature History is prior work for context only; never reuse a name from it.
- Do not add DevOps work unless the requirement or repository evidence calls for it.
- executor is a safety boundary: "agent" (default) is repository work a worker verifies in its worktree; "orchestrator" touches the host or a live system (secrets, .env, host config, deploys, restarts, git push, live migrations); "user" is a product decision. Split such work out of agent tasks. promotion "test" stops user-facing or money-moving work at TEST until a person promotes it.
- verification_command: ONE command, run verbatim as the merge gate, testing only this task's own file (never the whole suite). No shell operators. Executable: npm, pnpm, yarn, node, go, pytest, python3, cargo, git, tsc, eslint, vitest, make, or a read-only tool (grep, rg, ls, cat, head, tail, wc), optionally piped into another. No npx ("npm test -- --run src/x.test.ts"); a preload may name a package, never a file. A check needing the running system is "orchestrator: <command>".
- review_questions: for a task that touches authentication, authorization, tenancy, payments, ledgers, cryptography or secrets, give 3 to 6 questions an independent reviewer will verify against the diff ("where is the tenant checked before the query, and which test proves the fail-closed path?"). Otherwise an empty list.`;

function escalationBlock(recurring?: string[]): string {
  if (!recurring?.length) return '';
  return `
ESCALATION — these failure categories recurred in 2 of the last 3 runs: ${recurring.join(', ')}.
Change the approach for tasks prone to them (smaller scope, exact file lists, explicit prohibitions, tests before implementation) and state what changed in each affected task's allocation_reason. A stronger model alone is not a change.
`;
}

function buildPlanningPrompt(input: PlanningInput): string {
  return `You are the SoftFactory Blueprint Architect. Produce a repository-grounded implementation plan, not code.

${PLANNING_RULES(input.workerCapability)}
${escalationBlock(input.recurringFailures)}
Repository Context:
${input.codebaseContext}

Verified Project Memory:
${input.memoryPatterns || 'None'}

Feature History:
${input.featureHistory || 'None'}

User Requirement:
${input.requirement}`;
}

function buildRefinementPrompt(input: RefinementInput): string {
  const current = input.currentTasks.map(task => ({
    id: task.id, status: task.status, phase: task.phase, title: task.title,
    description: task.description, agent_role: task.agent_role,
    dependencies: task.dependencies, blockedBy: task.blockedBy,
    files_hint: task.files_hint, creates_files: task.creates_files,
    acceptance_criteria: task.acceptance_criteria, verification: task.verification,
  }));
  return `You are the SoftFactory Blueprint Architect performing a MID-FLIGHT REFINEMENT of an in-progress plan.

Refinement rules:
- Tasks with status "done" are already merged. Return each of them UNCHANGED: same id, title, description, phase, dependencies, files_hint. Never remove one.
- Tasks with any other status may be modified, removed, or replaced.
- New tasks get new ids that continue the existing numbering.
- Return the COMPLETE plan (done tasks included) in the blueprint schema; every task carries acceptance_criteria and verification.

${PLANNING_RULES(input.workerCapability)}

Current Tasks:
${JSON.stringify(current, null, 2)}

Repository Context:
${input.codebaseContext}

Refinement Request:
${input.refinement}`;
}

/**
 * CodexPlanner gets the shape from --output-schema. Every other planner must
 * be told, or `format: "json"` just guarantees well-formed JSON of the wrong
 * shape.
 */
export const SCHEMA_INSTRUCTION = `
Return ONLY a JSON object with exactly these keys:
{
  "feature": "short feature name",
  "requirements_covered": ["each ## or ### heading from the requirement, copied verbatim"],
  "tasks": [
    {
      "id": "T1",
      "title": "short title",
      "description": "what the worker must do",
      "agent_role": "coder" | "test_writer" | "docs" | "devops" | "architect" | "builder",
      "phase": 1,
      "dependencies": [],
      "blockedBy": [],
      "files_hint": ["path/to/file.ts"],
      "creates_files": ["path/to/new-file.ts"],
      "acceptance_criteria": ["at least one observable outcome"],
      "verification": ["at least one concrete command or check"],
      "production_targets": ["path/to/production-file.ts"],
      "test_targets": ["path/to/test-file.test.ts"],
      "behavior_tags": ["keyboard"],
      "verification_command": "npm test -- path/to/test-file.test.ts",
      "complexity": "simple",
      "allocation_reason": "single-file bounded change",
      "executor": "agent" | "orchestrator" | "user",
      "review_questions": []
    }
  ]
}
Every field is required on every task. Do not wrap the object in any other key.`;

const REPAIR_ROUNDS = 2;

function repairPrompt(error: Error, requirement: string, draft: unknown, earlier: string[] = []): string {
  return `Your previous plan was rejected. Repair this SoftFactory blueprint and return the complete corrected blueprint using the required output schema.

Validation errors:
${error.message}
${earlier.length ? `\nEarlier drafts were rejected for these reasons too; do not reintroduce any of them:\n${earlier.join('\n')}\n` : ''}
Mandatory rule: requirements_covered must contain these section titles exactly:
${requirementHeadings(requirement).map(heading => `- ${heading}`).join('\n') || '(none)'}

Do not invent or transfer requirements. Preserve valid task details, but correct omissions, unsafe paths, dependencies, phase conflicts, acceptance criteria, and verification.

User requirement:
${requirement}

Draft blueprint:
${JSON.stringify(draft, null, 2)}`;
}

/**
 * Shared by every planner: one attempt, then up to two repair rounds that feed
 * the validator's own error list back to the model. Before this each planner
 * had its own copy of the loop, and the Antigravity planner had none, so a
 * single missing field failed the whole build.
 */
abstract class BasePlanner implements IPlanner {
  abstract provider: PlannerProvider;
  log?: (line: string) => void;
  protected abstract run(prompt: string): Promise<unknown>;

  async generateBlueprint(input: PlanningInput): Promise<Blueprint> {
    const fitted = { ...input, codebaseContext: this.fitContext(buildPlanningPrompt({ ...input, codebaseContext: '' }), input.codebaseContext) };
    return this.planWithRepair(buildPlanningPrompt(fitted), input.requirement, fitted);
  }

  async refineBlueprint(input: RefinementInput): Promise<Blueprint> {
    const fitted = { ...input, codebaseContext: this.fitContext(buildRefinementPrompt({ ...input, codebaseContext: '' }), input.codebaseContext) };
    const validationInput: PlanningInput = {
      requirement: input.refinement, codebaseContext: fitted.codebaseContext,
      memoryPatterns: '', featureHistory: '', repositoryFiles: input.repositoryFiles,
      workerCapability: input.workerCapability,
    };
    return this.planWithRepair(buildRefinementPrompt(fitted), input.refinement, validationInput);
  }

  private async planWithRepair(prompt: string, requirement: string, validationInput: PlanningInput): Promise<Blueprint> {
    let draft = await this.run(prompt);
    // Each round used to see only its own errors, so a repair fixed one rule
    // and broke another: coverage, then a shell operator, then npx (#41's run).
    const earlier: string[] = [];
    for (let round = 0; round <= REPAIR_ROUNDS; round++) {
      try {
        return validateBlueprint(draft, validationInput);
      } catch (error: any) {
        const reasons = String(error?.message ?? error).split('\n').filter(l => l.startsWith('- '));
        this.log?.(`Planner draft rejected${round < REPAIR_ROUNDS ? ` (repair round ${round + 1} of ${REPAIR_ROUNDS})` : ' (no repair rounds left)'}:${reasons.length ? '\n  ' + reasons.join('\n  ') : ' ' + String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 300)}`);
        if (round === REPAIR_ROUNDS) throw error;
        draft = await this.run(repairPrompt(error, requirement, draft, earlier));
        for (const reason of reasons) if (!earlier.includes(reason)) earlier.push(reason);
      }
    }
    throw new Error('Planner repair loop ended unexpectedly.');
  }

  /** Characters of repository context the backend can take; undefined means no hard limit. */
  protected contextCharBudget(): number | undefined { return undefined; }

  /**
   * Trim repository context to the model's window. Ollama drops the FRONT of
   * an oversized prompt, which is where the planning rules live, so an
   * unbounded context silently removed the rules rather than the context.
   */
  private fitContext(fixedPrompt: string, codebaseContext: string): string {
    const budget = this.contextCharBudget();
    if (!budget) return codebaseContext;
    const allowance = budget - fixedPrompt.length - SCHEMA_INSTRUCTION.length - 400;
    if (codebaseContext.length <= allowance) return codebaseContext;
    if (allowance <= 200) return '[repository context omitted: the model window is too small to carry it]';
    return `${codebaseContext.slice(0, allowance)}\n...[repository context truncated to fit the model window; rely on the file list above]`;
  }
}

/** Any ITextModel can plan: the prompt states the shape and the loop repairs it. */
export class TextModelPlanner extends BasePlanner {
  constructor(readonly provider: PlannerProvider, private readonly textModel: ITextModel) { super(); }

  protected async run(prompt: string): Promise<unknown> {
    return extractJson(await this.textModel.complete(`${prompt}\n${SCHEMA_INSTRUCTION}`, { json: true, temperature: 0.1 }));
  }

  protected contextCharBudget(): number | undefined {
    // ~2.5 chars per token for paths and English, conservative on purpose.
    return this.textModel.contextWindow ? Math.floor(this.textModel.contextWindow * 2.5) : undefined;
  }
}

/** Codex CLI, read-only, with the schema enforced by --output-schema. */
export class CodexPlanner extends BasePlanner {
  provider: PlannerProvider = 'openai';
  constructor(private model = '', private cwd: string = process.cwd()) { super(); }

  protected async run(prompt: string): Promise<unknown> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-plan-'));
    const schemaPath = path.join(tempDir, 'blueprint.schema.json');
    const outputPath = path.join(tempDir, 'blueprint.json');
    try {
      await fs.writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA));
      await execa('codex', [
        'exec', '--sandbox', 'read-only', '--ephemeral',
        '--output-schema', schemaPath,
        '--output-last-message', outputPath,
        ...(this.model ? ['--model', this.model] : []),
        prompt,
      ], { cwd: this.cwd, stdin: 'ignore', timeout: 300000, all: true });
      return JSON.parse(await fs.readFile(outputPath, 'utf8'));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

export class AgyPlanner extends TextModelPlanner {
  constructor(model = 'Gemini 3.1 Pro (High)') { super('agy', new AgyTextModel(model)); }
}

/** Offline planner backed directly by Ollama. */
export class LocalPlanner extends TextModelPlanner {
  constructor(model = 'qwen2.5-coder:14b', host = 'http://127.0.0.1:11434') { super('local', new OllamaTextModel(model, host)); }
}

export class DeepSeekPlanner extends TextModelPlanner {
  constructor(model = 'deepseek-v4-pro') { super('deepseek', new DeepSeekTextModel(model)); }
}

/** Planning through an installed coding agent's print mode, so its login is the only credential needed. */
export class CliPlanner extends TextModelPlanner {
  constructor(provider: 'claude-code' | 'gemini-cli' | 'muse', model = '', cwd: string = process.cwd()) {
    super(provider, createTextModel(provider, model, { cwd }));
  }
}

/** Planning on the Anthropic or OpenAI API directly, so a run needs no CLI besides git. */
export class ApiPlanner extends TextModelPlanner {
  constructor(provider: 'anthropic' | 'openai-api' | 'qwen' | 'openai-compat', model = '') {
    const defaults: Record<string, string> = { anthropic: 'claude-sonnet-4', 'openai-api': 'gpt-5.4', qwen: 'qwen3-coder-plus', 'openai-compat': '' };
    super(provider, createTextModel(provider, model || defaults[provider]));
  }
}

/**
 * Headings that structure a ticket rather than name a requirement area. An
 * issue written "## Change / ## Acceptance" cost a repair round on every run,
 * the planner being told to cover sections that are not features.
 */
const STRUCTURAL_HEADINGS = /^(?:changes?|acceptance(?: criteria)?|done when|context|background|summary|problem|motivation|notes?|details|description|out of scope|why)$/i;

function requirementHeadings(requirement: string): string[] {
  return [...requirement.matchAll(/^#{2,3}\s+(.+?)\s*$/gm)].map(match => match[1].trim()).filter(heading => !STRUCTURAL_HEADINGS.test(heading.replace(/[:.]$/, '')));
}

function isSafeRelativeFile(file: string): boolean {
  return Boolean(file) && !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..');
}

const DEPENDENCY_MANIFESTS = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.mod', 'go.sum', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'Cargo.lock']);

function fileSegments(file: string): string[] {
  return file.split(/[\\/]/).filter(Boolean);
}

/** A migration is a path under a migrations/migrate directory, or a .sql file under a db directory. */
function isMigrationFile(file: string): boolean {
  const segments = fileSegments(file);
  const base = segments[segments.length - 1] ?? '';
  const dirs = segments.slice(0, -1);
  if (dirs.includes('migrations') || dirs.includes('migrate')) return true;
  return base.endsWith('.sql') && dirs.includes('db');
}

/** A dependency manifest is a manifest filename at any depth (package.json, go.mod, ...). */
function isDependencyManifest(file: string): boolean {
  const segments = fileSegments(file);
  return DEPENDENCY_MANIFESTS.has(segments[segments.length - 1] ?? '');
}

const LOCALE_DIRS = new Set(['locale', 'locales', 'i18n', 'lang']);
const USER_FACING_TEXT = /(message|label|text shown|translation|copy)/i;

/**
 * A locale file lives under a locale/locales/i18n/lang directory segment.
 * Matching path segments (rather than a bare substring regex) keeps names like
 * "localization", "ci18n" or "mylang" from being treated as locale paths.
 */
function isLocaleFile(file: string): boolean {
  const segments = fileSegments(file);
  return segments.slice(0, -1).some(segment => LOCALE_DIRS.has(segment));
}

/** True for a path that is a test file by language convention. */
export function isTestFilePath(file: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
    || /_test\.go$/.test(file)
    || /(^|\/)(__tests__|test|tests)\//.test(file)
    || /(^|\/)test_[^/]+\.py$|_test\.py$/.test(file);
}

export function validateBlueprint(raw: unknown, input: PlanningInput): Blueprint {
  const blueprint = BlueprintSchema.parse(raw);
  const errors: string[] = [];
  const ids = new Set<string>();

  // Release 6.0 "Split executor": an "agent+orchestrator" task is repository
  // work an agent edits and tests plus live work an operator applies. Expand it
  // before the other checks so both halves are validated as ordinary tasks.
  const splits = new Map<string, string>();
  const applyIds = new Set<string>();
  const expandedTasks: Blueprint['tasks'] = [];
  for (const task of blueprint.tasks) {
    if (task.executor !== 'agent+orchestrator') { expandedTasks.push(task); continue; }
    const applySteps = task.apply_steps?.trim();
    if (!applySteps) {
      errors.push(`${task.id} uses executor "agent+orchestrator" but has no apply_steps; state what the operator does on the live system once the change is merged, or route the whole task to the orchestrator`);
      expandedTasks.push(task);
      continue;
    }
    const applyId = `${task.id}-apply`;
    task.executor = 'agent';
    expandedTasks.push(task, {
      ...task,
      id: applyId,
      title: `Apply: ${task.title}`,
      description: applySteps,
      phase: task.phase + 1,
      dependencies: [task.id],
      files_hint: [],
      creates_files: [],
      executor: 'orchestrator',
      verification_command: undefined,
    });
    splits.set(task.id, applyId);
    applyIds.add(applyId);
  }
  // Any task that depended on Tn now waits for the live apply instead.
  for (const task of expandedTasks) {
    if (applyIds.has(task.id)) continue;
    task.dependencies = task.dependencies.map(dependency => splits.get(dependency) ?? dependency);
    task.blockedBy = task.blockedBy.map(dependency => splits.get(dependency) ?? dependency);
  }
  blueprint.tasks = expandedTasks;

  // `dependencies` and `blockedBy` have the same scheduling effect. Avoid
  // redundant edges when a model emits the same prerequisite in both arrays.
  for (const task of blueprint.tasks) {
    const dependencies = new Set(task.dependencies);
    task.blockedBy = task.blockedBy.filter(dependency => !dependencies.has(dependency));
  }

  for (const task of blueprint.tasks) {
    if (ids.has(task.id)) errors.push(`duplicate task id ${task.id}`);
    ids.add(task.id);
    if (task.acceptance_criteria.length === 0) errors.push(`${task.id} has no acceptance criteria`);
    if (task.verification.length === 0) errors.push(`${task.id} has no verification`);
    if (task.executor === 'agent' && task.files_hint.length === 0 && task.creates_files.length === 0) {
      errors.push(`${task.id} changes no files; a command-only task ("run the tests", "run the build") is not worker work, so fold its command into the verification_command of the task it checks`);
    }
    // The message always offered "or an implementation dependency", but the
    // check never looked at dependencies, so a planner that added one was
    // rejected again and the run died in planning (dogfood issue #5).
    const implementedBy = [...task.dependencies, ...task.blockedBy].filter(dep => blueprint.tasks.some(other => other.id === dep && other.agent_role !== 'test_writer'));
    if (task.agent_role === 'test_writer' && task.production_targets.length === 0 && implementedBy.length === 0 && /(?:service|router|navigation|loading|keyboard|async|implement|create|add )/i.test(`${task.description} ${task.acceptance_criteria.join(' ')}`)) {
      errors.push(`${task.id} is a test_writer for behaviour that is not built yet: set its production_targets to the implementation files the tests exercise (for example ["src/x.ts"]), or add the id of the task that implements them to its dependencies`);
    }
    for (const check of task.verification) {
      if (/\bvitest\s+list\b/.test(check)) errors.push(`${task.id} uses unsupported Vitest command "vitest list"; use "vitest run --reporter=json" instead`);
      if (/\bvitest\b.*\s--repeat(?:=|\s)/.test(check)) errors.push(`${task.id} uses unsupported Vitest option --repeat; run the deterministic command twice explicitly`);
    }
    // The acceptance command is executed verbatim under the command policy.
    // A command the policy refuses could never gate a merge, so it is a
    // planning error here rather than a silent pass later.
    if (task.verification_command?.trim() && !/^\s*orchestrator:/i.test(task.verification_command)) {
      const violation = commandPolicyViolation(task.verification_command.trim());
      if (violation) errors.push(`${task.id} verification_command cannot run under the command policy (${violation}); use one allowlisted command with no shell operators`);
    }
    if (task.executor !== 'agent' && task.agent_role === 'test_writer') {
      errors.push(`${task.id} is a test_writer task but routed to ${task.executor}; tests are agent work`);
    }
    const created = new Set(task.creates_files);
    for (const file of [...task.files_hint, ...task.creates_files]) {
      if (!isSafeRelativeFile(file)) errors.push(`${task.id} has unsafe file path ${file}`);
    }
    for (const file of task.files_hint) {
      const isExistingDirectory = [...input.repositoryFiles].some(existing => existing.startsWith(`${file.replace(/\/$/, '')}/`));
      if (!input.repositoryFiles.has(file) && !isExistingDirectory && !created.has(file)) {
        errors.push(`${task.id} references nonexistent file ${file} without declaring it in creates_files`);
      }
    }
  }

  for (const task of blueprint.tasks) {
    for (const dependency of [...task.dependencies, ...task.blockedBy]) {
      if (!ids.has(dependency)) errors.push(`${task.id} references missing dependency ${dependency}`);
      if (dependency === task.id) errors.push(`${task.id} depends on itself`);
    }
  }

  // The runtime rejects a test writer that changes source; a plan that gives
  // one a source file to write can only fail (#41's T1 burned its attempts on
  // src/Uat.ts). Production files belong in production_targets.
  for (const task of blueprint.tasks.filter(t => t.agent_role === 'test_writer')) {
    const source = [...task.files_hint, ...task.creates_files].filter(file => !isTestFilePath(file));
    if (source.length) errors.push(`${task.id} is a test_writer but lists source files it may not change: ${source.join(', ')}; list only test files, put the code under test in production_targets, and depend on the task that implements it`);
  }

  const taskById = new Map(blueprint.tasks.map(task => [task.id, task]));
  // A behavior-creating test task must depend on a production task. This
  // prevents sending a test writer to invent behavior that the repository does
  // not provide yet (the recurring T03 failure pattern).
  for (const task of blueprint.tasks.filter(t => t.agent_role === 'test_writer')) {
    const deps = [...task.dependencies, ...task.blockedBy].map(id => taskById.get(id));
    const needsImplementation = /(?:service|router|navigation|loading|keyboard|async|implement|create|add )/i.test(`${task.description} ${task.acceptance_criteria.join(' ')}`);
    if (needsImplementation && task.production_targets.length === 0 && !deps.some(dep => dep && dep.agent_role !== 'test_writer')) {
      errors.push(`${task.id} behavior tests have no non-test implementation dependency; split implementation before tests`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) { errors.push(`dependency cycle includes ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    const task = taskById.get(id);
    for (const dep of task ? [...task.dependencies, ...task.blockedBy] : []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);

  const claims = new Map<string, string>();
  for (const task of blueprint.tasks) {
    for (const file of task.files_hint) {
      const key = `${task.phase}:${file}`;
      const previous = claims.get(key);
      if (previous) errors.push(`same-phase file conflict: ${previous} and ${task.id} both claim ${file}`);
      claims.set(key, task.id);
    }
  }

  // 5.6 domain planning rules. Softhouse's planner enforces these; a plain
  // error string lets the planner's repair loop fix the draft.

  // A task transitively reaches another when it (directly or indirectly)
  // depends on it through dependencies or blockedBy.
  const reaches = (from: string, to: string): boolean => {
    const source = taskById.get(from);
    const stack = source ? [...source.dependencies, ...source.blockedBy] : [];
    const seen = new Set<string>();
    while (stack.length) {
      const next = stack.pop()!;
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      const task = taskById.get(next);
      if (task) stack.push(...task.dependencies, ...task.blockedBy);
    }
    return false;
  };

  const taskFiles = (task: Blueprint['tasks'][number]) => [...task.files_hint, ...task.creates_files];

  // Rule 1: migrations must form a linear chain; two migration tasks must be ordered.
  const migrationTasks = blueprint.tasks.filter(task => taskFiles(task).some(isMigrationFile));
  for (let i = 0; i < migrationTasks.length; i += 1) {
    for (let j = i + 1; j < migrationTasks.length; j += 1) {
      const a = migrationTasks[i];
      const b = migrationTasks[j];
      if (!reaches(a.id, b.id) && !reaches(b.id, a.id)) {
        errors.push(`${a.id} and ${b.id} both add database migrations but neither depends on the other; migrations form a linear chain`);
      }
    }
  }

  // Rule 2: at most one task may change dependency manifests.
  const manifestTasks = blueprint.tasks.filter(task => taskFiles(task).some(isDependencyManifest));
  for (let i = 0; i < manifestTasks.length; i += 1) {
    for (let j = i + 1; j < manifestTasks.length; j += 1) {
      const a = manifestTasks[i];
      const b = manifestTasks[j];
      const shared = [...new Set([...taskFiles(a), ...taskFiles(b)].filter(isDependencyManifest))].sort();
      errors.push(`${a.id} and ${b.id} both change dependency manifests (${shared.join(', ')}); keep dependency changes in one task so lockfiles cannot conflict`);
    }
  }

  // Rule 3: when the repository has locale files, user-facing text needs a locale task.
  const localeFiles = [...input.repositoryFiles].filter(isLocaleFile).sort();
  if (localeFiles.length > 0) {
    const planUpdatesLocale = blueprint.tasks.some(task => taskFiles(task).some(isLocaleFile));
    if (!planUpdatesLocale) {
      for (const task of blueprint.tasks) {
        if (USER_FACING_TEXT.test(`${task.description} ${task.acceptance_criteria.join(' ')}`)) {
          errors.push(`${task.id} adds user-facing text but no task updates the locale files (${localeFiles[0]})`);
        }
      }
    }
  }

  const covered = new Set(blueprint.requirements_covered.map(item => item.toLowerCase()));
  for (const heading of requirementHeadings(input.requirement)) {
    if (!covered.has(heading.toLowerCase())) errors.push(`missing requirement coverage: ${heading}`);
  }

  if (errors.length) throw new Error(`Planner produced an unsafe or incomplete blueprint:\n- ${[...new Set(errors)].join('\n- ')}`);
  return blueprint;
}
