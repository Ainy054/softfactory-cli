import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { LessonManager } from './LessonManager.js';

const lesson = (n: number) => ({
  lesson: `Always check the thing number ${n} before proceeding`,
  tags: ['x'], scope: 'project' as const, confidence: 0.9,
  evidence: { taskId: `T${n}`, failure: 'it broke', resolution: 'it was fixed' },
});

describe('concurrent lesson writes do not race', () => {
  it('survives four workers writing at once', async () => {
    // Phase 3 of the godo plan runs four tasks in parallel; a shared .tmp name
    // produced: worker_error ENOENT: rename '.softfactory/lessons.json.tmp'
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-lessons-'));
    await fs.mkdir(path.join(base, '.softfactory'), { recursive: true });
    const managers = Array.from({ length: 4 }, () => new LessonManager(base));

    const results = await Promise.all(managers.map((m, i) => m.add(lesson(i))));
    assert.ok(results.every(r => r === true), 'no writer may fail');

    const saved = JSON.parse(await fs.readFile(path.join(base, '.softfactory', 'lessons.json'), 'utf-8'));
    assert.ok(Array.isArray(saved.lessons) && saved.lessons.length >= 1, 'the file must stay valid JSON');
  });

  it('leaves no temp files behind', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-lessons2-'));
    await fs.mkdir(path.join(base, '.softfactory'), { recursive: true });
    await Promise.all(Array.from({ length: 6 }, (_, i) => new LessonManager(base).add(lesson(i))));
    const left = (await fs.readdir(path.join(base, '.softfactory'))).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(left, []);
  });

  it('a failed lesson write never breaks the caller', async () => {
    const m: any = new LessonManager('/nonexistent-path-xyz');
    await assert.doesNotReject(() => m.write([]));
  });
});
