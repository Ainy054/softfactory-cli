import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateBlueprint, type PlanningInput } from './Planner.js';

const input = (repositoryFiles: string[] = []): PlanningInput => ({
  requirement: 'Add the planned behaviour to the repository.',
  codebaseContext: '',
  memoryPatterns: '',
  featureHistory: '',
  repositoryFiles: new Set(repositoryFiles),
});

const task = (overrides: Record<string, unknown> = {}) => ({
  id: 'T001',
  title: 'Implement the planned change',
  description: 'Implement the planned change in the repository safely.',
  agent_role: 'coder',
  phase: 1,
  dependencies: [],
  blockedBy: [],
  files_hint: [],
  creates_files: ['src/planned.ts'],
  acceptance_criteria: ['The planned change is observable.'],
  verification: ['npm test -- --run'],
  ...overrides,
});

describe('blueprint domain planning rules', () => {
  describe('migrations serialized', () => {
    it('rejects two unordered migration tasks with the exact chain error', () => {
      const plan = {
        feature: 'Migration chain',
        requirements_covered: [],
        tasks: [
          task({ id: 'T001', creates_files: ['db/migrations/001_add_users.sql'] }),
          task({ id: 'T002', creates_files: ['db/migrations/002_add_orders.sql'] }),
        ],
      };

      assert.throws(
        () => validateBlueprint(plan, input()),
        /T001 and T002 both add database migrations but neither depends on the other; migrations form a linear chain/,
      );
    });

    it('accepts migration tasks once one depends on the other', () => {
      const plan = {
        feature: 'Migration chain',
        requirements_covered: [],
        tasks: [
          task({ id: 'T001', creates_files: ['db/migrations/001_add_users.sql'] }),
          task({ id: 'T002', creates_files: ['db/migrations/002_add_orders.sql'], dependencies: ['T001'] }),
        ],
      };

      assert.doesNotThrow(() => validateBlueprint(plan, input()));
    });
  });

  describe('one dependency install per run', () => {
    it('rejects two tasks that each change a dependency manifest', () => {
      const plan = {
        feature: 'Dependency install',
        requirements_covered: [],
        tasks: [
          task({ id: 'T001', creates_files: ['package.json'] }),
          task({ id: 'T002', creates_files: ['Cargo.toml'] }),
        ],
      };

      assert.throws(
        () => validateBlueprint(plan, input()),
        /T001 and T002 both change dependency manifests \(Cargo\.toml, package\.json\); keep dependency changes in one task so lockfiles cannot conflict/,
      );
    });

    it('accepts the plan when all manifests stay in one task', () => {
      const plan = {
        feature: 'Dependency install',
        requirements_covered: [],
        tasks: [
          task({ id: 'T001', creates_files: ['package.json', 'Cargo.toml'] }),
          task({ id: 'T002', creates_files: ['src/lib.rs'] }),
        ],
      };

      assert.doesNotThrow(() => validateBlueprint(plan, input()));
    });
  });

  describe('translations follow new strings', () => {
    const localeRepositoryFiles = ['src/App.tsx', 'src/locales/en.json'];

    it('rejects new user-facing text when no task updates the locale files', () => {
      const plan = {
        feature: 'User-facing label',
        requirements_covered: [],
        tasks: [
          task({
            id: 'T001',
            creates_files: ['src/ui.ts'],
            description: 'Add a welcome message to the account screen.',
            acceptance_criteria: ['The welcome message is visible on the account screen.'],
          }),
        ],
      };

      assert.throws(
        () => validateBlueprint(plan, input(localeRepositoryFiles)),
        /T001 adds user-facing text but no task updates the locale files \(src\/locales\/en\.json\)/,
      );
    });

    it('accepts the plan when a task lists a locale file', () => {
      const plan = {
        feature: 'User-facing label',
        requirements_covered: [],
        tasks: [
          task({
            id: 'T001',
            creates_files: ['src/ui.ts'],
            description: 'Add a welcome message to the account screen.',
            acceptance_criteria: ['The welcome message is visible on the account screen.'],
          }),
          task({
            id: 'T002',
            title: 'Update the locale files',
            description: 'Add the locale entries for the new account screen message.',
            files_hint: ['src/locales/en.json'],
            creates_files: [],
            acceptance_criteria: ['The locale file contains the new account screen message key.'],
            verification: ['npm test -- --run'],
          }),
        ],
      };

      assert.doesNotThrow(() => validateBlueprint(plan, input(localeRepositoryFiles)));
    });

    it('skips the locale rule when the repository has no locale files', () => {
      const plan = {
        feature: 'User-facing label',
        requirements_covered: [],
        tasks: [
          task({
            id: 'T001',
            creates_files: ['src/ui.ts'],
            description: 'Add a welcome message to the account screen.',
            acceptance_criteria: ['The welcome message is visible on the account screen.'],
          }),
        ],
      };

      assert.doesNotThrow(() => validateBlueprint(plan, input(['src/App.tsx'])));
    });
  });
});
