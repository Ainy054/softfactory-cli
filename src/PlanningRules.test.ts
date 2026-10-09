import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateBlueprint, type PlanningInput } from './Planner.js';

/** A minimal blueprint task that already satisfies the schema's required fields. */
function task(overrides: Record<string, unknown>) {
  return {
    id: 'T1',
    title: 'Change a file',
    description: 'Change the file to deliver this feature.',
    agent_role: 'coder',
    phase: 1,
    dependencies: [],
    blockedBy: [],
    files_hint: [],
    creates_files: [],
    acceptance_criteria: ['The change is observable'],
    verification: ['npm test -- --run'],
    ...overrides,
  };
}

function blueprint(tasks: unknown[]) {
  return { feature: 'Planning rules', requirements_covered: [], tasks };
}

function input(repositoryFiles: string[]): PlanningInput {
  return {
    requirement: 'Add the requested behaviour.',
    codebaseContext: '',
    memoryPatterns: '',
    featureHistory: '',
    repositoryFiles: new Set(repositoryFiles),
  };
}

describe('blueprint validator: migrations form a linear chain', () => {
  it('rejects two migration tasks that are unordered', () => {
    const plan = blueprint([
      task({ id: 'T1', title: 'Add first migration', creates_files: ['db/migrations/001_init.sql'] }),
      task({ id: 'T2', title: 'Add second migration', phase: 2, creates_files: ['migrations/002_more.sql'] }),
    ]);
    assert.throws(
      () => validateBlueprint(plan, input([])),
      /T1 and T2 both add database migrations but neither depends on the other; migrations form a linear chain/,
    );
  });

  it('accepts migrations once one depends on the other', () => {
    const plan = blueprint([
      task({ id: 'T1', title: 'Add first migration', creates_files: ['db/migrations/001_init.sql'] }),
      task({ id: 'T2', title: 'Add second migration', phase: 2, dependencies: ['T1'], creates_files: ['migrations/002_more.sql'] }),
    ]);
    assert.doesNotThrow(() => validateBlueprint(plan, input([])));
  });

  it('accepts a transitive chain of migration tasks', () => {
    const plan = blueprint([
      task({ id: 'T1', title: 'Add first migration', creates_files: ['db/migrations/001_init.sql'] }),
      task({ id: 'T2', title: 'Add second migration', phase: 2, dependencies: ['T1'], creates_files: ['db/migrations/002_more.sql'] }),
      task({ id: 'T3', title: 'Add third migration', phase: 3, dependencies: ['T2'], creates_files: ['db/migrations/003_more.sql'] }),
    ]);
    assert.doesNotThrow(() => validateBlueprint(plan, input([])));
  });

  it('treats a .sql file under a db directory as a migration', () => {
    const plan = blueprint([
      task({ id: 'T1', title: 'Add schema change', creates_files: ['db/schema.sql'] }),
      task({ id: 'T2', title: 'Add orders table', phase: 2, creates_files: ['db/orders.sql'] }),
    ]);
    assert.throws(
      () => validateBlueprint(plan, input([])),
      /T1 and T2 both add database migrations but neither depends on the other; migrations form a linear chain/,
    );
  });
});

describe('blueprint validator: one dependency install per run', () => {
  it('rejects two tasks that each change a dependency manifest', () => {
    const plan = blueprint([
      task({ id: 'T1', title: 'Update npm manifests', creates_files: ['package-lock.json'] }),
      task({ id: 'T2', title: 'Update yarn manifests', phase: 2, creates_files: ['yarn.lock'] }),
    ]);
    assert.throws(
      () => validateBlueprint(plan, input([])),
      /T1 and T2 both change dependency manifests \(package-lock\.json, yarn\.lock\); keep dependency changes in one task so lockfiles cannot conflict/,
    );
  });

  it('accepts dependency manifests kept in a single task', () => {
    const plan = blueprint([
      task({ id: 'T1', title: 'Update dependency manifests', creates_files: ['package-lock.json', 'yarn.lock'] }),
    ]);
    assert.doesNotThrow(() => validateBlueprint(plan, input([])));
  });

  it('lists every dependency manifest the two tasks touch', () => {
    const plan = blueprint([
      task({ id: 'T1', title: 'Update node manifests', creates_files: ['package.json', 'package-lock.json'] }),
      task({ id: 'T2', title: 'Update node manifests again', phase: 2, creates_files: ['yarn.lock'] }),
    ]);
    assert.throws(
      () => validateBlueprint(plan, input([])),
      /T1 and T2 both change dependency manifests \(package-lock\.json, package\.json, yarn\.lock\); keep dependency changes in one task so lockfiles cannot conflict/,
    );
  });
});

describe('blueprint validator: translations follow new strings', () => {
  it('rejects user-facing text when no task updates the locale files', () => {
    const plan = blueprint([
      task({ id: 'T1', title: 'Add welcome banner', description: 'Show a new welcome message in the header.', files_hint: ['src/App.tsx'] }),
    ]);
    assert.throws(
      () => validateBlueprint(plan, input(['src/App.tsx', 'src/locales/en.json'])),
      /T1 adds user-facing text but no task updates the locale files \(src\/locales\/en\.json\)/,
    );
  });

  it('rejects user-facing text named in acceptance criteria', () => {
    const plan = blueprint([
      task({ id: 'T1', title: 'Add welcome banner', files_hint: ['src/App.tsx'], acceptance_criteria: ['The button label reads "Continue"'] }),
    ]);
    assert.throws(
      () => validateBlueprint(plan, input(['src/App.tsx', 'src/i18n/en.json'])),
      /T1 adds user-facing text but no task updates the locale files \(src\/i18n\/en\.json\)/,
    );
  });

  it('accepts a plan with a task that updates the locale files', () => {
    const plan = blueprint([
      task({ id: 'T1', title: 'Add welcome banner', description: 'Show a new welcome message in the header.', files_hint: ['src/App.tsx'] }),
      task({ id: 'T2', title: 'Update translation strings', phase: 2, files_hint: ['src/locales/en.json'] }),
    ]);
    assert.doesNotThrow(() => validateBlueprint(plan, input(['src/App.tsx', 'src/locales/en.json'])));
  });

  it('does not apply when the repository has no locale files', () => {
    const plan = blueprint([
      task({ id: 'T1', title: 'Add welcome banner', description: 'Show a new welcome message in the header.', files_hint: ['src/App.tsx'] }),
    ]);
    assert.doesNotThrow(() => validateBlueprint(plan, input(['src/App.tsx'])));
  });
});
