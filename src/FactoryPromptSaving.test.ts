import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Factory } from './Factory.js';
import { RunJournal } from './RunJournal.js';
import type { Task, Handoff } from './types.js';

/**
 * 5.5: save every worker prompt and journal its hash. The orchestrator hands
 * `onPrompt` to the worker it is about to run and, in the same callback, writes
 * the file under the run's `prompts/` directory and appends a `task:prompt`
 * journal entry. These tests drive a task through the real worker execution
 * path (`executeAndInspect`) with a stubbed worker that calls `onPrompt`, then
 * inspect the prompt file and the journal on disk.
 */

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: 't', description: 'd', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
    files_hint: ['app.ts'], creates_files: [], acceptance_criteria: [], verification: [], status: 'pending',
    attempts: 0, escalation_level: 0, error_history: [], worker_type: 'auto', executor: 'agent',
    protected: false, review_questions: [], production_targets: [], test_targets: [], behavior_tags: [],
    ...over,
  } as Task;
}

async function worktree() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-prompt-wt-'));
  await fs.writeFile(path.join(dir, 'app.ts'), 'export const farewell = () => "bye";\n');
  return dir;
}

const PROMPT = 'You are SoftFactory.\n\nTitle: Add farewell\nTask ID: T1\nDescription: Add a farewell helper.';

const handoff: Handoff = { task_id: 'T1', status: 'success', files_changed: ['app.ts'], summary: 'done' };

/**
 * A real Factory with stubbed collaborators, following the gate harness in
 * Acceptance.test.ts. The only worker is a stub whose `execute` calls the
 * `onPrompt` the Factory passed it, exactly as a real worker would.
 */
async function promptHarness(promptText = PROMPT) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-prompt-factory-'));
  const factory: any = new Factory(baseDir, '', { strategy: 'local' });
  factory.state = { feature_id: 'f-1', feature: 'test', status: 'active', strategy: 'local',
    cloud_provider: 'agy', planner_provider: 'local', created_at: '', last_updated: '', tasks: [], memory_patterns: [] };
  factory.saveState = async () => {};
  factory.getProjectContext = async () => '';
  factory.getDiff = async () => 'diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n+farewell';
  factory.lessons.getRelevant = async () => [];
  factory.taskVerifier.prepare = async () => ({ ok: true });
  factory.taskVerifier.verify = async () => ({ executed: true, passed: true, testSummary: 'ok', output: '' });
  factory.workerRegistry.resolveWorker = async () => ({
    worker: {
      id: 'stub', name: 'stub', isAvailable: async () => true,
      execute: async (_task: Task, _worktreePath: string, options?: { onPrompt?: (prompt: string) => void }) => {
        options?.onPrompt?.(promptText);
        return handoff;
      },
    },
    model: 'm', provider: 'p',
  });
  factory.worktreeManager.commitWorktree = async () => ({ committed: true, filesChanged: 1 });
  return { factory, baseDir };
}

describe('the Factory saves every worker prompt and journals it', () => {
  it('writes the prompt on the worker execution path and journals a task:prompt event', async () => {
    const { factory, baseDir } = await promptHarness();
    const t = task({ id: 'T1' });
    const result = await factory.executeAndInspect(t, await worktree());
    assert.ok(result, 'the task completed its worker execution path');

    const relative = path.join('.softfactory', 'runs', 'f-1', 'prompts', 'T1-attempt1.md');
    const promptPath = path.join(baseDir, relative);
    assert.equal(await fs.readFile(promptPath, 'utf8'), PROMPT, 'the exact prompt is saved under the run directory');

    const entries = await RunJournal.read(path.join(baseDir, '.softfactory', 'runs', 'f-1', 'journal.jsonl'));
    const journaled = entries.filter(e => e.event === 'task:prompt');
    assert.equal(journaled.length, 1, 'exactly one task:prompt event was appended');
    assert.equal(journaled[0].data.task_id, 'T1');
    assert.equal(journaled[0].data.attempt, 1);
    assert.equal(journaled[0].data.path, relative);
    assert.equal(
      journaled[0].files?.[relative],
      createHash('sha256').update(PROMPT).digest('hex'),
      'the journal hashes the saved prompt file',
    );

    const verified = await RunJournal.verify(baseDir, 'f-1');
    assert.equal(verified.ok, true, verified.problems.join('; '));
  });

  it('numbers the file from the attempt and never overwrites an earlier save', async () => {
    const { factory, baseDir } = await promptHarness();
    const t = task({ id: 'T1', attempts: 1 });
    const first = await factory.savePrompt(t, 'the first prompt');
    const second = await factory.savePrompt(t, 'a rerun prompt');
    assert.equal(first, path.join('.softfactory', 'runs', 'f-1', 'prompts', 'T1-attempt2.md'));
    assert.equal(second, path.join('.softfactory', 'runs', 'f-1', 'prompts', 'T1-attempt2-2.md'));
    assert.equal(await fs.readFile(path.join(baseDir, first!), 'utf8'), 'the first prompt');
    assert.equal(await fs.readFile(path.join(baseDir, second!), 'utf8'), 'a rerun prompt');

    const entries = await RunJournal.read(path.join(baseDir, '.softfactory', 'runs', 'f-1', 'journal.jsonl'));
    const paths = entries.filter(e => e.event === 'task:prompt').map(e => e.data.path);
    assert.deepEqual(paths, [first, second], 'each saved file is journaled at its own path');
  });

  it('does not save a prompt when the run has no feature id', async () => {
    const { factory } = await promptHarness();
    factory.state.feature_id = undefined;
    assert.equal(await factory.savePrompt(task({ id: 'T1' }), 'x'), undefined);
  });
});
