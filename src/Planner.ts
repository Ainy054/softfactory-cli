import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { AgyClient } from './GeminiClient.js';
import { extractJson } from './GeminiClient.js';

export type PlannerProvider = 'openai' | 'agy' | 'local';

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
}

export interface IPlanner {
  provider: PlannerProvider;
  generateBlueprint(input: PlanningInput): Promise<Blueprint>;
}

const OUTPUT_SCHEMA = {
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
        required: ['id', 'title', 'description', 'agent_role', 'phase', 'dependencies', 'blockedBy', 'files_hint', 'creates_files', 'acceptance_criteria', 'verification'],
        properties: {
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
        },
      },
    },
  },
};

function buildPlanningPrompt(input: PlanningInput): string {
  return `You are the SoftFactory Blueprint Architect. Produce a repository-grounded implementation plan, not code.

Planning rules:
- Preserve working functionality and map every explicit requirement area exactly once or explain intentional overlap.
- Never transfer behavior from one component or domain to another.
- Reference an existing path only when it appears in Repository Context. Put justified new paths in both files_hint and creates_files.
- Prefer cohesive tasks over many sequential tasks editing the same file. Keep each task under roughly 300 changed lines.
${input.workerCapability === 'local' ? `
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
- requirements_covered must copy every markdown requirement section title (## or ###) from the user requirement.
- The "feature" name must describe THIS requirement. Feature History is prior work for context only; never reuse a name from it.
- Do not add DevOps work unless the requirement or repository evidence calls for it.

Repository Context:
${input.codebaseContext}

Verified Project Memory:
${input.memoryPatterns || 'None'}

Feature History:
${input.featureHistory || 'None'}

User Requirement:
${input.requirement}`;
}

/**
 * CodexPlanner gets the shape from --output-schema and AgyPlanner states it in
 * its own prompt. A planner with neither must be told, or `format: "json"` just
 * guarantees well-formed JSON of the wrong shape.
 */
const SCHEMA_INSTRUCTION = `
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
      "verification": ["at least one concrete command or check"]
    }
  ]
}
Every field is required on every task. Do not wrap the object in any other key.`;

export class CodexPlanner implements IPlanner {
  provider: PlannerProvider = 'openai';
  constructor(private model = '') {}

  async generateBlueprint(input: PlanningInput): Promise<Blueprint> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-plan-'));
    const schemaPath = path.join(tempDir, 'blueprint.schema.json');
    const outputPath = path.join(tempDir, 'blueprint.json');
    await fs.writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA));
    try {
      const run = async (prompt: string) => {
        const args = [
          'exec', '--sandbox', 'read-only', '--ephemeral',
          '--output-schema', schemaPath,
          '--output-last-message', outputPath,
          ...(this.model ? ['--model', this.model] : []),
          prompt,
        ];
        await execa('codex', args, { cwd: process.cwd(), stdin: 'ignore', timeout: 300000, all: true });
        return JSON.parse(await fs.readFile(outputPath, 'utf8'));
      };

      let draft = await run(buildPlanningPrompt(input));
      for (let repairAttempt = 0; repairAttempt <= 2; repairAttempt++) {
        try {
          return validateBlueprint(draft, input);
        } catch (error: any) {
          if (repairAttempt === 2) throw error;
          const repairPrompt = `Repair this SoftFactory blueprint. Return the complete corrected blueprint using the required output schema.

Validation errors:
${error.message}

Mandatory rule: requirements_covered must contain these section titles exactly:
${requirementHeadings(input.requirement).map(heading => `- ${heading}`).join('\n')}

Do not invent or transfer requirements. Preserve valid task details, but correct omissions, unsafe paths, dependencies, phase conflicts, acceptance criteria, and verification.

User requirement:
${input.requirement}

Draft blueprint:
${JSON.stringify(draft, null, 2)}`;
          draft = await run(repairPrompt);
        }
      }
      throw new Error('Planner repair loop ended unexpectedly.');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

export class AgyPlanner implements IPlanner {
  provider: PlannerProvider = 'agy';
  constructor(private client: AgyClient) {}

  async generateBlueprint(input: PlanningInput): Promise<Blueprint> {
    const raw = await this.client.generateBlueprint(
      input.requirement,
      input.codebaseContext,
      input.memoryPatterns,
      input.featureHistory,
    );
    return validateBlueprint(raw, input);
  }
}

/** Offline planner backed directly by Ollama. */
export class LocalPlanner implements IPlanner {
  provider: PlannerProvider = 'local';
  constructor(private model = 'qwen2.5-coder:14b', private host = 'http://127.0.0.1:11434') {}

  async generateBlueprint(input: PlanningInput): Promise<Blueprint> {
    const run = async (prompt: string): Promise<unknown> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8 * 60_000);
      try {
        const response = await fetch(`${this.host}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model: this.model,
            prompt,
            format: 'json',
            stream: false,
            options: { temperature: 0.1, num_ctx: 8192 },
          }),
        });
        if (!response.ok) throw new Error(`Local planner Ollama error: ${response.status} ${response.statusText}`);
        const data = await response.json() as { response?: string };
        if (!data.response) throw new Error('Local planner returned an empty response.');
        return extractJson(data.response);
      } finally {
        clearTimeout(timer);
      }
    };

    let draft = await run(`${buildPlanningPrompt(input)}\n${SCHEMA_INSTRUCTION}`);
    // A local model rarely gets the whole shape right first time; give it the
    // same repair budget the Codex planner has instead of failing the build.
    for (let repair = 0; repair <= 2; repair++) {
      try {
        return validateBlueprint(draft, input);
      } catch (error: any) {
        if (repair === 2) throw error;
        draft = await run(`Your previous plan was rejected.\n\nErrors:\n${error.message}\n\nRequirement:\n${input.requirement}\n${SCHEMA_INSTRUCTION}`);
      }
    }
    throw new Error('Local planner repair loop ended unexpectedly.');
  }
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

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const taskById = new Map(blueprint.tasks.map(task => [task.id, task]));
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
