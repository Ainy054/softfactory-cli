import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateBlueprint, OUTPUT_SCHEMA, type PlanningInput } from './Planner.js';

const input: PlanningInput = {
  requirement: '## Command Palette\nFix it.\n## Quality gates\nRun tests.',
  codebaseContext: '', memoryPatterns: '', featureHistory: '',
  repositoryFiles: new Set(['src/App.tsx', 'src/App.test.tsx']),
};

const valid = {
  feature: 'Palette repair',
  requirements_covered: ['Command Palette', 'Quality gates'],
  tasks: [{
    id: 'T001', title: 'Repair palette', description: 'Repair the palette integration safely.',
    agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
    files_hint: ['src/App.tsx'], creates_files: [],
    acceptance_criteria: ['Ctrl+K opens the palette'], verification: ['npm test -- --run'],
  }],
};

describe('planner semantic validation', () => {
  it('accepts a grounded plan with complete coverage', () => {
    assert.equal(validateBlueprint(valid, input).tasks.length, 1);
  });

  it('rejects invented files that are not declared new', () => {
    const plan = structuredClone(valid);
    plan.tasks[0].files_hint = ['src/useInvented.ts'];
    assert.throws(() => validateBlueprint(plan, input), /nonexistent file/);
  });

  it('accepts an existing directory as a scoped file hint', () => {
    const plan = structuredClone(valid);
    plan.tasks[0].files_hint = ['src'];
    assert.equal(validateBlueprint(plan, input).tasks[0].files_hint[0], 'src');
  });

  it('rejects omitted requirement areas', () => {
    const plan = structuredClone(valid);
    plan.requirements_covered = ['Command Palette'];
    assert.throws(() => validateBlueprint(plan, input), /Quality gates/);
  });

  it('rejects dependency cycles and same-phase file conflicts', () => {
    const plan = structuredClone(valid);
    plan.tasks.push({ ...structuredClone(plan.tasks[0]), id: 'T002', dependencies: ['T001'] });
    plan.tasks[0].dependencies = ['T002'];
    assert.throws(() => validateBlueprint(plan, input), /dependency cycle|file conflict/);
  });

  it('rejects unsupported Vitest discovery and repeat commands', () => {
    for (const verification of [
      ['npx vitest list'],
      ['npx vitest run src/App.test.tsx --repeat=2'],
    ]) {
      const plan = structuredClone(valid);
      plan.tasks[0].verification = verification;
      assert.throws(() => validateBlueprint(plan, input), /unsupported Vitest/);
    }
  });
});

describe('planner repair rounds are visible', () => {
  it('carries every earlier rejection into later repair prompts, so a fix does not reintroduce an old error', async () => {
    const { TextModelPlanner } = await import('./Planner.js');
    const npx = { ...valid, tasks: [{ ...valid.tasks[0], verification_command: 'npx vitest run src/App.test.tsx' }] };
    const piped = { ...valid, tasks: [{ ...valid.tasks[0], verification_command: 'npm test && echo ok' }] };
    const replies = [JSON.stringify(npx), JSON.stringify(piped), JSON.stringify(valid)];
    const prompts: string[] = [];
    const planner = new TextModelPlanner('deepseek', { provider: 'deepseek', model: 'm', isAvailable: async () => true, complete: async (prompt: string) => { prompts.push(prompt); return replies.shift()!; } } as any);
    await planner.generateBlueprint(input);
    assert.equal(prompts.length, 3);
    assert.doesNotMatch(prompts[1], /Earlier drafts were rejected/, 'the first repair has no history yet');
    assert.match(prompts[2], /Earlier drafts were rejected for these reasons too; do not reintroduce any of them:\n- T001 verification_command cannot run under the command policy \(npx/);
  });

  it('logs each rejected draft with the validator reasons, then accepts the repaired one', async () => {
    const { TextModelPlanner } = await import('./Planner.js');
    const invalid = { ...valid, tasks: [{ ...valid.tasks[0], files_hint: ['src/Nope.ts'], verification_command: 'node -r ./evil.js x.js' }] };
    const replies = [JSON.stringify(invalid), JSON.stringify(valid)];
    const lines: string[] = [];
    const planner = new TextModelPlanner('deepseek', { provider: 'deepseek', model: 'm', isAvailable: async () => true, complete: async () => replies.shift()! } as any);
    planner.log = line => lines.push(line);
    const blueprint = await planner.generateBlueprint(input);
    assert.equal(blueprint.tasks[0].files_hint[0], 'src/App.tsx');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /repair round 1 of 2/);
    assert.match(lines[0], /src\/Nope\.ts/);
    assert.match(lines[0], /preload flags may name an installed package/);
  });
});

describe('a task that changes no files is not worker work', () => {
  it('rejects "run the test suite" tasks and tells the planner where the command belongs', () => {
    const runOnly = { ...valid, tasks: [valid.tasks[0], { ...valid.tasks[0], id: 'T002', title: 'Run full test suite', dependencies: ['T001'], phase: 2, files_hint: [], creates_files: [], verification_command: 'npm test' }] };
    assert.throws(() => validateBlueprint(runOnly, input), /T002 changes no files.*verification_command/);
    const manual = { ...runOnly, tasks: [runOnly.tasks[0], { ...runOnly.tasks[1], executor: 'orchestrator' }] };
    assert.doesNotThrow(() => validateBlueprint(manual, input), 'operator work legitimately changes no repository files');
  });
});

describe('OUTPUT_SCHEMA', () => {
  // Codex --output-schema uses OpenAI strict mode, which rejects a schema whose
  // `required` omits any property ("Missing 'brief'", 2026-10-10).
  it('lists every property as required, at the top level and per task', () => {
    const task = OUTPUT_SCHEMA.properties.tasks.items;
    assert.deepEqual([...OUTPUT_SCHEMA.required].sort(), Object.keys(OUTPUT_SCHEMA.properties).sort());
    assert.deepEqual([...task.required].sort(), Object.keys(task.properties).sort());
  });
});
