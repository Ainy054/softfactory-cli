import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { extractJson } from './extractJson.js';
import { AgyTextModel, DeepSeekTextModel, OllamaTextModel, type ITextModel } from './TextModel.js';
import { commandPolicyViolation } from './commandPolicy.js';
import type { Task } from './types.js';

export type PlannerProvider = 'openai' | 'agy' | 'local' | 'deepseek';

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
  complexity: z.enum(['simple', 'moderate', 'complex']).optional(),
  allocation_reason: z.string().optional(),
  executor: z.enum(['agent', 'orchestrator', 'user']).default('agent'),
  review_questions: z.array(z.string()).default([]),
});

export const BlueprintSchema = z.object({
  feature: z.string().min(4),
  requirements_covered: z.array(z.string()).default([]),
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
  generateBlueprint(input: PlanningInput): Promise<Blueprint>;
  /** A mid-flight change to an in-progress plan; done tasks must come back unchanged. */
  refineBlueprint(input: RefinementInput): Promise<Blueprint>;
}

export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['feature', 'requirements_covered', 'tasks'],
  properties: {
    feature: { type: 'string' },
    requirements_covered: { type: 'array', items: { type: 'string' } },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'description', 'agent_role', 'phase', 'dependencies', 'blockedBy', 'files_hint', 'creates_files', 'acceptance_criteria', 'verification', 'production_targets', 'test_targets', 'behavior_tags', 'verification_command', 'complexity', 'allocation_reason', 'executor', 'review_questions'],
        properties: {
          executor: { type: 'string', enum: ['agent', 'orchestrator', 'user'] },
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
${workerCapability === 'local' ? `
LOCAL WORKER CONSTRAINT — these tasks will be executed by a 7B/14B model, not a frontier model:
- At most 2 files in files_hint per task, counting creates_files. Split anything larger.
- One concern per task. Do not bundle unrelated changes (a config split, a new lint config and dependency metadata are three tasks, not one).
- At most 3 acceptance_criteria per task, each checkable by running one command.
- Keep description under 250 characters. A long brief is a task that should have been split.
- Sequencing is cheap; a large task is not. Prefer more, smaller, dependency-ordered tasks.
` : ''}
- Put tests before dependent implementation where useful. Put the final cross-cutting quality gate in the last phase.
- Use dependencies for actual ordering. Same-phase tasks must not claim the same file.
- acceptance_criteria must be observable outcomes. verification must contain concrete commands or inspection checks.
- For every test_writer task, declare test_targets and production_targets. If the criterion requires behavior that is not already present, add a dependency on the implementation task first.
- requirements_covered must copy every markdown requirement section title (## or ###) from the user requirement.
- The "feature" name must describe THIS requirement. Feature History is prior work for context only; never reuse a name from it.
- Do not add DevOps work unless the requirement or repository evidence calls for it.
- executor routes WHO performs a task, and it is a safety boundary. "agent" (the default) is repository-contained work a worker can verify inside its worktree. "orchestrator" is anything that touches the host or a live system: secret values and .env contents, crontab, host config, deploys, container restarts, git push, migrations against a live database. "user" is a decision only the product owner can make. Workers never receive orchestrator or user tasks, so never fold such work into an agent task; split it out.
- verification_command is ONE command the orchestrator executes verbatim in the task's worktree as the merge gate. No shell operators (no &&, ;, redirects, cd). The executable must be one of npm, pnpm, yarn, node, go, pytest, python3, cargo, git, tsc, eslint, vitest, make, or a read-only tool (grep, rg, ls, cat, head, tail, wc), optionally piped into another read-only tool. npx is not allowed: write "npm test -- --run src/x.test.ts", not "npx vitest run src/x.test.ts". Choose the narrowest command that proves the acceptance criteria.
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

function repairPrompt(error: Error, requirement: string, draft: unknown): string {
  return `Your previous plan was rejected. Repair this SoftFactory blueprint and return the complete corrected blueprint using the required output schema.

Validation errors:
${error.message}

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
    for (let round = 0; round <= REPAIR_ROUNDS; round++) {
      try {
        return validateBlueprint(draft, validationInput);
      } catch (error: any) {
        if (round === REPAIR_ROUNDS) throw error;
        draft = await this.run(repairPrompt(error, requirement, draft));
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

function requirementHeadings(requirement: string): string[] {
  return [...requirement.matchAll(/^#{2,3}\s+(.+?)\s*$/gm)].map(match => match[1].trim());
}

function isSafeRelativeFile(file: string): boolean {
  return Boolean(file) && !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..');
}

export function validateBlueprint(raw: unknown, input: PlanningInput): Blueprint {
  const blueprint = BlueprintSchema.parse(raw);
  const errors: string[] = [];
  const ids = new Set<string>();

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
    if (task.agent_role === 'test_writer' && task.production_targets.length === 0 && /(?:service|router|navigation|loading|keyboard|async|implement|create|add )/i.test(`${task.description} ${task.acceptance_criteria.join(' ')}`)) {
      errors.push(`${task.id} requires production_targets or an explicit implementation dependency before tests`);
    }
    for (const check of task.verification) {
      if (/\bvitest\s+list\b/.test(check)) errors.push(`${task.id} uses unsupported Vitest command "vitest list"; use "vitest run --reporter=json" instead`);
      if (/\bvitest\b.*\s--repeat(?:=|\s)/.test(check)) errors.push(`${task.id} uses unsupported Vitest option --repeat; run the deterministic command twice explicitly`);
    }
    // The acceptance command is executed verbatim under the command policy.
    // A command the policy refuses could never gate a merge, so it is a
    // planning error here rather than a silent pass later.
    if (task.verification_command?.trim()) {
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

  const covered = new Set(blueprint.requirements_covered.map(item => item.toLowerCase()));
  for (const heading of requirementHeadings(input.requirement)) {
    if (!covered.has(heading.toLowerCase())) errors.push(`missing requirement coverage: ${heading}`);
  }

  if (errors.length) throw new Error(`Planner produced an unsafe or incomplete blueprint:\n- ${[...new Set(errors)].join('\n- ')}`);
  return blueprint;
}
