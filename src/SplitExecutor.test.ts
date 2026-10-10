import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateBlueprint, type PlanningInput } from './Planner.js';

// Release 6.0 "Split executor": a task that is repository work (an agent edits
// and tests it) plus live work (an operator applies it) is planned once with
// executor "agent+orchestrator" and expanded by validateBlueprint into an agent
// task and a dependent orchestrator "-apply" task.

/** A minimal repository: the hint "src" is a directory that exists, so no file has to be invented. */
const input: PlanningInput = {
  requirement: 'Rotate the API token used by the deployment.',
  codebaseContext: '', memoryPatterns: '', featureHistory: '',
  repositoryFiles: new Set(['src/App.tsx']),
};

const blueprint = (tasks: unknown[]) => ({
  feature: 'Rotate deploy token',
  requirements_covered: [],
  tasks,
});

const baseTask = {
  id: 'T1',
  title: 'Rotate the token in the config',
  description: 'Update the config file and keep its test in sync.',
  agent_role: 'coder' as const,
  phase: 1,
  dependencies: [] as string[],
  blockedBy: [] as string[],
  files_hint: ['src'],
  creates_files: [] as string[],
  acceptance_criteria: ['The config parses after the token change'],
  verification: ['npm test'],
  executor: 'agent+orchestrator' as const,
  apply_steps: 'Run softfactory rotate-token --host prod on the live host.',
};

describe('Split executor: agent+orchestrator expansion', () => {
  it('splits one agent+orchestrator task into an agent task and a dependent orchestrator -apply task', () => {
    const result = validateBlueprint(blueprint([{ ...baseTask }]), input);

    assert.equal(result.tasks.length, 2, 'one planned task becomes two executable tasks');

    const agent = result.tasks.find(task => task.id === 'T1');
    const apply = result.tasks.find(task => task.id === 'T1-apply');
    assert.ok(agent, 'the repository half keeps the original id');
    assert.ok(apply, 'the live half is added as T1-apply');

    assert.equal(agent.executor, 'agent');
    assert.equal(agent.apply_steps, baseTask.apply_steps, 'the original task keeps its apply_steps as context');

    assert.equal(apply.executor, 'orchestrator');
    assert.deepEqual(apply.dependencies, ['T1'], 'the apply task runs after the repository change');
    assert.equal(apply.phase, baseTask.phase + 1, 'the apply task moves one phase later');
    assert.equal(apply.title, `Apply: ${baseTask.title}`);
    assert.equal(apply.description, baseTask.apply_steps, 'the description is the apply_steps verbatim');
    assert.deepEqual(apply.files_hint, [], 'the operator changes no repository files');
    assert.deepEqual(apply.creates_files, []);
    assert.equal(apply.agent_role, 'coder');
    assert.equal(apply.verification_command, undefined, 'there is no merge-gate command for live work');
  });

  it('marks an empty or whitespace-only apply_steps as a validation error', () => {
    for (const applySteps of [undefined, '', '   ']) {
      assert.throws(
        () => validateBlueprint(blueprint([{ ...baseTask, apply_steps: applySteps }]), input),
        /T1 uses executor "agent\+orchestrator" but has no apply_steps/,
        `apply_steps ${JSON.stringify(applySteps)} must be rejected`,
      );
    }
  });
});

describe('Split executor: downstream rewiring', () => {
  it('rewires every task that depended on the split task to depend on its -apply task', () => {
    const downstream = {
      id: 'T2',
      title: 'Exercise the rotated token',
      description: 'Verify the rotated token is accepted end to end.',
      agent_role: 'coder' as const,
      phase: 2,
      dependencies: ['T1'],
      blockedBy: ['T1'],
      files_hint: ['src'],
      creates_files: [] as string[],
      acceptance_criteria: ['The rotated token is accepted'],
      verification: ['npm test'],
      executor: 'agent' as const,
    };
    const result = validateBlueprint(blueprint([{ ...baseTask }, downstream]), input);

    const t2 = result.tasks.find(task => task.id === 'T2');
    assert.ok(t2);
    assert.deepEqual(t2.dependencies, ['T1-apply'], 'a downstream dependency now waits for the live apply');
    assert.deepEqual(t2.blockedBy, [], 'blockedBy is rewired too, then deduped against dependencies');
    assert.ok(result.tasks.some(task => task.id === 'T1-apply'), 'the apply task the dependency points at exists');
    assert.ok(result.tasks.some(task => task.id === 'T1'));
  });
});
