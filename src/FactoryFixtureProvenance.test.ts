import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Factory } from './Factory.js';
import type { Task, Handoff } from './types.js';

// #83: in the mongolbank-rates run a test writer invented
// tests/fixtures/bom_latest.html, and 127 tests agreed with nothing real.

async function harness(diff: string, externalSources: unknown[] | undefined) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-fixtures-'));
  const factory: any = new Factory(baseDir, '', { strategy: 'hybrid', cloudProvider: 'deepseek', cloudModel: 'deepseek-v4-flash' });
  factory.state = { feature_id: 'f-1', feature: 'test', status: 'active', strategy: 'hybrid',
    cloud_provider: 'deepseek', planner_provider: 'local', created_at: '', last_updated: '', tasks: [], memory_patterns: [],
    ...(externalSources ? { external_sources: externalSources } : {}) };
  factory.saveState = async () => {};
  factory.getProjectContext = async () => '';
  factory.getDiff = async () => diff;
  factory.lessons.getRelevant = async () => [];
  factory.taskVerifier.prepare = async () => ({ ok: true });
  factory.taskVerifier.verify = async () => ({ executed: true, passed: true, testSummary: 'ok', output: '' });
  factory.workerRegistry.resolveWorker = async () => ({
    worker: { id: 'stub', name: 'stub', isAvailable: async () => true,
      execute: async (): Promise<Handoff> => ({ task_id: 'T1', status: 'success', files_changed: ['tests/test_rates.py'], summary: 'done' }) },
    model: 'm', provider: 'p',
  });
  factory.worktreeManager.commitWorktree = async () => ({ committed: true, filesChanged: 2 });
  factory.inspector.inspect = async () => ({ verdict: 'PASS', feedback: 'ok', provider: 'deepseek', model: 'deepseek-v4-flash' });
  const notes: string[] = [];
  const realAddRunNote = factory.addRunNote.bind(factory);
  factory.addRunNote = (taskId: string, note: string) => { notes.push(note); realAddRunNote(taskId, note); };
  return { factory, notes, baseDir };
}

function testWriter(): Task {
  return { id: 'T1', title: 'Parser tests', description: 'Test the rates parser', agent_role: 'test_writer',
    phase: 1, dependencies: [], blockedBy: [], files_hint: ['tests/test_rates.py'], creates_files: [],
    acceptance_criteria: [], verification: [], status: 'pending', attempts: 0,
    escalation_level: 0, error_history: [], worker_type: 'auto' } as Task;
}

const INVENTED = [
  'diff --git a/tests/fixtures/fake.html b/tests/fixtures/fake.html',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/tests/fixtures/fake.html',
  '@@ -0,0 +1,2 @@',
  '+<html><body><table><tr><td>USD</td><td>3,450.50</td></tr></table></body></html>',
  '+<!-- saved from https://www.mongolbank.mn/en/rates -->',
  'diff --git a/tests/test_rates.py b/tests/test_rates.py',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/tests/test_rates.py',
  '@@ -0,0 +1,2 @@',
  '+def test_latest():',
  '+    assert parse(open("tests/fixtures/fake.html").read())',
].join('\n');

const PROBE = { name: 'bom-rates', url: 'https://www.mongolbank.mn/en/currency-rates/data', ok: true, status: 200, path: 'tests/fixtures/sources/bom-rates.json' };

describe('a worker may not invent fixtures that stand in for an external source', () => {
  it('rejects a test writer that adds fixture data in a run with a probed source', async () => {
    const { factory, baseDir } = await harness(INVENTED, [PROBE]);
    const task = testWriter();
    assert.equal(await factory.executeAndInspect(task, '/tmp/wt'), null);
    assert.match(task.last_feedback ?? '', /stand in for an external source but were not fetched from it: tests\/fixtures\/fake\.html/);
    assert.match(task.last_feedback ?? '', /tests\/fixtures\/sources\/bom-rates\.json/);
    const attempts = (await fs.readFile(path.join(baseDir, '.softfactory', 'attempts.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(attempts.at(-1).category, 'invented_fixture');
  });

  it('lets the same diff through in a run with no external source, with an "unprobed fixture" note', async () => {
    const { factory, notes } = await harness(INVENTED, undefined);
    const result = await factory.executeAndInspect(testWriter(), '/tmp/wt');
    assert.ok(result, 'merged');
    assert.ok(notes.includes('unprobed fixture: tests/fixtures/fake.html'), notes.join('\n'));
  });

  it('allows tests that read the saved probe response', async () => {
    const diff = INVENTED.split('\n').slice(7).join('\n').replace('tests/fixtures/fake.html', 'tests/fixtures/sources/bom-rates.json');
    const { factory } = await harness(diff, [PROBE]);
    assert.ok(await factory.executeAndInspect(testWriter(), '/tmp/wt'), 'merged');
  });
});
