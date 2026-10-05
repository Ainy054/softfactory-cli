import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TrainingDataManager, redactTrainingText } from './TrainingDataManager.js';

const task: any = { id: 'T1', title: 'Fix auth', description: 'Implement login', agent_role: 'coder', files_hint: ['src/auth.ts'], attempts: 1, model: 'small-local', provider: 'local', error_history: ['invalid JSON; retry'] };

describe('training candidate capture', () => {
  it('redacts credentials without exposing the value', () => {
    const result = redactTrainingText('Authorization: Bearer abc123 sk-12345678901234567890');
    assert.ok(!result.includes('abc123')); assert.ok(!result.includes('sk-12345678901234567890')); assert.match(result, /REDACTED_SECRET/);
  });
  it('stores only verified candidates and marks repaired trajectories', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-training-')); const manager = new TrainingDataManager(dir);
    assert.equal(await manager.addVerified({ task, diff: '', verification: 'pass', resolution: 'ok' }), false);
    assert.equal(await manager.addVerified({ task, diff: '+fixed', verification: 'pass', resolution: 'ok' }), true);
    const candidate = JSON.parse((await fs.readFile(path.join(dir, '.softfactory', 'training-candidates.jsonl'), 'utf8')).trim());
    assert.equal(candidate.repaired, true); assert.equal(candidate.verification, 'pass'); assert.equal(candidate.diff, '+fixed');
  });
  it('stores sanitized failures separately as lessons', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-failures-')); const manager = new TrainingDataManager(dir);
    assert.equal(await manager.addFailureLesson({ task, category: 'verification', detail: 'Authorization: Bearer abc123' }), true);
    const lesson = JSON.parse((await fs.readFile(path.join(dir, '.softfactory', 'training-failure-lessons.jsonl'), 'utf8')).trim());
    assert.equal(lesson.kind, 'failure_lesson'); assert.equal(lesson.category, 'verification');
    assert.ok(!lesson.error.includes('abc123')); assert.match(lesson.error, /REDACTED_SECRET/);
  });
});
