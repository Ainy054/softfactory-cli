import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateBlueprint, type PlanningInput } from './Planner.js';

/**
 * 5.6 domain planning rules enforced by validateBlueprint:
 *   1. migrations form a linear chain,
 *   2. at most one task per run changes dependency manifests,
 *   3. user-facing text needs a locale task when the repository has locale files.
 *
 * Each block crafts a plan that violates the rule, asserts the exact diagnostic
 * the repair loop is expected to feed back to the planner, and proves the
 * corrected plan validates.
 */

const baseInput: PlanningInput = {
  requirement: 'Implement the requested feature.',
  codebaseContext: '',
  memoryPatterns: '',
  featureHistory: '',
  repositoryFiles: new Set(['src/App.ts']),
};

interface TestTask {
  id: string;
  title: string;
  description: string;
  agent_role: string;
  phase: number;
  dependencies: string[];
  blockedBy: string[];
  files_hint: string[];
  creates_files: string[];
  acceptance_criteria: string[];
  verification: string[];
}

function task(overrides: Partial<TestTask> = {}): TestTask {
  return {
    id: 'T1',
    title: 'Implement feature',
    description: 'Implement the requested feature safely.',
    agent_role: 'coder',
    phase: 1,
    dependencies: [],
    blockedBy: [],
    files_hint: ['src/App.ts'],
    creates_files: [],
    acceptance_criteria: ['The feature works'],
    verification: ['npm test -- --run src/App.test.ts'],
    ...overrides,
  };
}

function plan(tasks: TestTask[]) {
  return { feature: 'Planning rules', requirements_covered: [], tasks };
}

describe('domain rule: migrations form a linear chain', () => {
  it('rejects two unordered migration tasks', () => {
    const crafted = plan([
      task({ id: 'T1', files_hint: [], creates_files: ['db/migrations/0001_users.sql'] }),
      task({ id: 'T2', files_hint: [], creates_files: ['db/migrations/0002_posts.sql'] }),
    ]);
    assert.throws(
      () => validateBlueprint(crafted, baseInput),
      /T1 and T2 both add database migrations but neither depends on the other; migrations form a linear chain/,
    );
  });

  it('accepts the plan once one migration depends on the other', () => {
    const corrected = plan([
      task({ id: 'T1', files_hint: [], creates_files: ['db/migrations/0001_users.sql'] }),
      task({ id: 'T2', phase: 2, dependencies: ['T1'], files_hint: [], creates_files: ['db/migrations/0002_posts.sql'] }),
    ]);
    const validated = validateBlueprint(corrected, baseInput);
    assert.equal(validated.tasks.length, 2);
    assert.deepEqual(validated.tasks[1].dependencies, ['T1']);
  });

  it('treats migrate/ directories and db/*.sql files as migrations', () => {
    const crafted = plan([
      task({ id: 'T1', files_hint: [], creates_files: ['db/migrate/0001_init.sql'] }),
      task({ id: 'T2', files_hint: [], creates_files: ['db/schema.sql'] }),
    ]);
    assert.throws(
      () => validateBlueprint(crafted, baseInput),
      /both add database migrations but neither depends on the other; migrations form a linear chain/,
    );
  });

  it('does not treat a .sql file outside db/ as a migration', () => {
    const unaffected = plan([
      task({ id: 'T1', files_hint: [], creates_files: ['src/seed.sql'] }),
      task({ id: 'T2', phase: 2, files_hint: [], creates_files: ['src/fixtures.sql'] }),
    ]);
    assert.doesNotThrow(() => validateBlueprint(unaffected, baseInput));
  });
});

describe('domain rule: one dependency manifest change per run', () => {
  const manifestInput: PlanningInput = {
    ...baseInput,
    repositoryFiles: new Set(['src/App.ts', 'package.json']),
  };

  it('rejects two tasks that both change dependency manifests', () => {
    const crafted = plan([
      task({ id: 'T1', files_hint: ['package.json'] }),
      task({ id: 'T2', phase: 2, files_hint: ['package.json'] }),
    ]);
    assert.throws(
      () => validateBlueprint(crafted, manifestInput),
      /T1 and T2 both change dependency manifests \(package\.json\); keep dependency changes in one task so lockfiles cannot conflict/,
    );
  });

  it('accepts the plan when the manifest change lives in a single task', () => {
    const corrected = plan([
      task({ id: 'T1', files_hint: ['package.json'] }),
      task({ id: 'T2', phase: 2, files_hint: ['src/App.ts'] }),
    ]);
    const validated = validateBlueprint(corrected, manifestInput);
    assert.equal(validated.tasks.length, 2);
  });

  it('recognizes manifests at any depth and names every shared manifest', () => {
    const crafted = plan([
      task({ id: 'T1', files_hint: [], creates_files: ['go.mod'] }),
      task({ id: 'T2', phase: 2, files_hint: [], creates_files: ['services/api/go.mod'] }),
    ]);
    assert.throws(
      () => validateBlueprint(crafted, baseInput),
      /T1 and T2 both change dependency manifests \(go\.mod, services\/api\/go\.mod\); keep dependency changes in one task so lockfiles cannot conflict/,
    );
  });
});

describe('domain rule: translations follow new strings', () => {
  const withLocales: PlanningInput = {
    ...baseInput,
    repositoryFiles: new Set(['src/App.ts', 'src/locales/en.json']),
  };
  const withoutLocales: PlanningInput = {
    ...baseInput,
    repositoryFiles: new Set(['src/App.ts']),
  };

  it('rejects user-facing text when no task updates the locale files', () => {
    const crafted = plan([
      task({ id: 'T1', description: 'Add a welcome message to the dashboard.' }),
    ]);
    assert.throws(
      () => validateBlueprint(crafted, withLocales),
      /T1 adds user-facing text but no task updates the locale files \(src\/locales\/en\.json\)/,
    );
  });

  it('accepts the plan once a task updates the locale files', () => {
    const corrected = plan([
      task({ id: 'T1', description: 'Add a welcome message to the dashboard.' }),
      task({ id: 'T2', phase: 2, description: 'Translate the new welcome copy.', files_hint: ['src/locales/en.json'] }),
    ]);
    const validated = validateBlueprint(corrected, withLocales);
    assert.equal(validated.tasks.length, 2);
    assert.deepEqual(validated.tasks[1].files_hint, ['src/locales/en.json']);
  });

  it('does not apply when the repository has no locale files', () => {
    const crafted = plan([
      task({ id: 'T1', description: 'Add a welcome message to the dashboard.' }),
    ]);
    assert.doesNotThrow(() => validateBlueprint(crafted, withoutLocales));
  });
});
