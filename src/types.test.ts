import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TaskSchema, FactoryStateSchema, HandoffSchema, FeatureHistoryEntrySchema } from './types.js';

describe('TaskSchema', () => {
  it('should parse a valid task', () => {
    const result = TaskSchema.parse({
      id: 'T001',
      title: 'Test task',
      description: 'A test task',
      agent_role: 'coder',
      phase: 1,
    });
    assert.equal(result.id, 'T001');
    assert.equal(result.status, 'pending');
    assert.equal(result.attempts, 0);
    assert.deepEqual(result.dependencies, []);
    assert.deepEqual(result.blockedBy, []);
    assert.deepEqual(result.files_hint, []);
  });

  it('should reject missing required fields', () => {
    assert.throws(() => {
      TaskSchema.parse({ id: 'T001' });
    });
  });

  it('should reject invalid agent_role', () => {
    assert.throws(() => {
      TaskSchema.parse({
        id: 'T001',
        title: 'Test',
        description: 'Test',
        agent_role: 'invalid_role',
        phase: 1,
      });
    });
  });

  it('should accept all valid agent roles', () => {
    const roles = ['coder', 'test_writer', 'docs', 'devops', 'architect', 'builder'] as const;
    for (const role of roles) {
      const result = TaskSchema.parse({
        id: 'T001',
        title: 'Test',
        description: 'Test',
        agent_role: role,
        phase: 1,
      });
      assert.equal(result.agent_role, role);
    }
  });

  it('should accept all valid statuses', () => {
    const statuses = ['pending', 'active', 'done', 'failed', 'rejected'] as const;
    for (const status of statuses) {
      const result = TaskSchema.parse({
        id: 'T001',
        title: 'Test',
        description: 'Test',
        agent_role: 'coder',
        phase: 1,
        status,
      });
      assert.equal(result.status, status);
    }
  });

  it('should preserve explicit values over defaults', () => {
    const result = TaskSchema.parse({
      id: 'T002',
      title: 'Retry task',
      description: 'A retried task',
      agent_role: 'builder',
      phase: 2,
      status: 'failed',
      attempts: 2,
      dependencies: ['T001'],
      files_hint: ['src/foo.ts'],
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.dependencies, ['T001']);
  });
});

describe('FactoryStateSchema', () => {
  it('should parse a valid state', () => {
    const result = FactoryStateSchema.parse({
      feature: 'Test Feature',
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
      last_updated: '2026-01-01T00:00:00Z',
      tasks: [{
        id: 'T001',
        title: 'Task',
        description: 'Desc',
        agent_role: 'coder',
        phase: 1,
      }],
    });
    assert.equal(result.feature, 'Test Feature');
    assert.equal(result.tasks.length, 1);
    assert.deepEqual(result.memory_patterns, []);
  });

  it('should reject invalid status', () => {
    assert.throws(() => {
      FactoryStateSchema.parse({
        feature: 'Test',
        status: 'running',
        created_at: '2026-01-01T00:00:00Z',
        last_updated: '2026-01-01T00:00:00Z',
        tasks: [],
      });
    });
  });

  it('should default feature_id to empty string for backward compat', () => {
    const result = FactoryStateSchema.parse({
      feature: 'Old Feature',
      status: 'completed',
      created_at: '2026-01-01T00:00:00Z',
      last_updated: '2026-01-01T00:00:00Z',
      tasks: [],
    });
    assert.equal(result.feature_id, '');
  });

  it('should preserve explicit feature_id', () => {
    const result = FactoryStateSchema.parse({
      feature_id: 'f-20260603120000',
      feature: 'New Feature',
      status: 'active',
      created_at: '2026-06-03T12:00:00Z',
      last_updated: '2026-06-03T12:00:00Z',
      tasks: [],
    });
    assert.equal(result.feature_id, 'f-20260603120000');
  });
});

describe('FeatureHistoryEntrySchema', () => {
  it('should parse a valid history entry', () => {
    const result = FeatureHistoryEntrySchema.parse({
      feature_id: 'f-20260603120000',
      feature: 'Test Feature',
      status: 'completed',
      created_at: '2026-06-03T12:00:00Z',
      completed_at: '2026-06-03T13:00:00Z',
      task_count: 5,
      tasks_done: 5,
    });
    assert.equal(result.feature_id, 'f-20260603120000');
    assert.equal(result.tasks_done, 5);
  });

  it('should allow optional completed_at', () => {
    const result = FeatureHistoryEntrySchema.parse({
      feature_id: 'f-20260603120000',
      feature: 'In Progress',
      status: 'active',
      created_at: '2026-06-03T12:00:00Z',
      task_count: 3,
      tasks_done: 1,
    });
    assert.equal(result.completed_at, undefined);
  });
});

describe('HandoffSchema', () => {
  it('should parse a valid handoff', () => {
    const result = HandoffSchema.parse({
      task_id: 'T001',
      status: 'success',
      files_changed: ['src/index.ts'],
      summary: 'Added index file',
    });
    assert.equal(result.task_id, 'T001');
    assert.equal(result.status, 'success');
    assert.equal(result.test_summary, undefined);
  });

  it('should accept optional fields', () => {
    const result = HandoffSchema.parse({
      task_id: 'T001',
      status: 'failure',
      files_changed: [],
      summary: 'Failed to complete',
      test_summary: 'Tests failed',
      unresolved_issues: 'Missing dependency',
    });
    assert.equal(result.test_summary, 'Tests failed');
    assert.equal(result.unresolved_issues, 'Missing dependency');
  });

  it('should reject invalid status', () => {
    assert.throws(() => {
      HandoffSchema.parse({
        task_id: 'T001',
        status: 'partial',
        files_changed: [],
        summary: 'Test',
      });
    });
  });
});
