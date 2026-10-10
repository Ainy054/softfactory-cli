import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Factory, cxScoreProblem, cxScorePercentage, CX_CHECKLIST_NOTE_PREFIX } from './Factory.js';
import { CX_CHECKLIST } from './IWorker.js';
import { computeRunMetrics } from './Metrics.js';
import { CURRENT_SCHEMA_VERSION, type Task, type Handoff } from './types.js';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: 't', description: 'd', agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
    files_hint: [], creates_files: [], acceptance_criteria: [], verification: [], status: 'pending',
    attempts: 0, escalation_level: 0, error_history: [], worker_type: 'auto', executor: 'agent',
    protected: false, review_questions: [], production_targets: [], test_targets: [], behavior_tags: [],
    notes_to_executor: [], out_of_scope: [],
    ...over,
  } as Task;
}

/** A CX score with `applicable` items, `passed` of them green, and `na` justified. */
function score(applicable: number, passed: number, na: Array<{ item: string; why: string }> = []): NonNullable<Handoff['cx_score']> {
  return { applicable, passed, na };
}

/** `n` N/A items, each carrying the given reason (blank to leave one unjustified). */
function naItems(n: number, why = 'not applicable to this screen'): Array<{ item: string; why: string }> {
  return Array.from({ length: n }, (_, i) => ({ item: `Checklist item ${i + 1}`, why }));
}

describe('cxScoreProblem gates a CX reviewer verdict', () => {
  const reviewer = { id: 'T1', agent_role: 'cx_reviewer' };

  it('passes 7 of 10 applicable items: exactly the 70% bar', () => {
    assert.equal(cxScoreProblem(reviewer, { cx_score: score(10, 7) }), null);
  });

  it('fails 6 of 10 with a message naming the count and the 70% bar', () => {
    const problem = cxScoreProblem(reviewer, { cx_score: score(10, 6) });
    assert.ok(problem, '6 of 10 is below the bar and must be rejected');
    assert.match(problem, /passes 6 of 10 applicable items/);
    assert.match(problem, /70%/);
  });

  it('fails a missing score, naming the ten items and the bar', () => {
    const problem = cxScoreProblem(reviewer, {});
    assert.ok(problem);
    assert.match(problem, /no cx_score/);
    assert.match(problem, /10 checklist items/);
    assert.match(problem, /70%/);
  });

  it('fails a score that does not account for all ten checklist items', () => {
    const problem = cxScoreProblem(reviewer, { cx_score: score(8, 8, naItems(1)) });
    assert.ok(problem);
    assert.match(problem, /accounts for 9 of the 10 checklist items/);
    assert.match(problem, /8 applicable \+ 1 N\/A/);
    assert.match(problem, /70%/);
  });

  it('fails an N/A item with no reason, naming the item', () => {
    const na = [{ item: 'Keyboard navigation', why: 'covered by the design system' }, { item: 'Empty state', why: '   ' }];
    const problem = cxScoreProblem(reviewer, { cx_score: score(8, 8, na) });
    assert.ok(problem);
    assert.match(problem, /"Empty state" N\/A without a reason/);
    assert.match(problem, /70%/);
  });

  it('fails more passes than applicable items', () => {
    const problem = cxScoreProblem(reviewer, { cx_score: score(5, 6, naItems(5)) });
    assert.ok(problem);
    assert.match(problem, /more passes than items/);
    assert.match(problem, /70%/);
  });

  it('allows zero applicable items only when all ten are justified N/A', () => {
    assert.equal(cxScoreProblem(reviewer, { cx_score: score(0, 0, naItems(10)) }), null);
    // Zero applicable but only five justified is still a total that is not 10.
    assert.ok(cxScoreProblem(reviewer, { cx_score: score(0, 0, naItems(5)) }));
  });

  it('ignores tasks that are not CX reviewers, score or no score', () => {
    assert.equal(cxScoreProblem({ id: 'T2', agent_role: 'coder' }, {}), null);
    assert.equal(cxScoreProblem({ id: 'T3', agent_role: 'test_writer' }, {}), null);
    assert.equal(cxScoreProblem({ id: 'T4' }, { cx_score: score(10, 1) }), null, 'a missing role is not a CX review');
  });

  it('turns the score into the recorded percentage, treating nothing applicable as 100%', () => {
    assert.equal(cxScorePercentage(score(10, 7)), 70);
    assert.equal(cxScorePercentage(score(3, 2)), 67);
    assert.equal(cxScorePercentage(score(0, 0, naItems(10))), 100);
  });
});

describe('annotateTasks puts the CX checklist on UI coder tasks', () => {
  const expectedNote = `${CX_CHECKLIST_NOTE_PREFIX}${CX_CHECKLIST.join('; ')}`;

  it('adds the checklist note to a .tsx coder task exactly once', () => {
    const factory: any = new Factory('/tmp', '', { strategy: 'local' });
    const [tsx] = factory.annotateTasks([task({ id: 'T1', files_hint: ['web/src/App.tsx'] })]);
    assert.deepEqual(tsx.notes_to_executor, [expectedNote]);
    assert.equal(tsx.notes_to_executor.filter((n: string) => n.startsWith(CX_CHECKLIST_NOTE_PREFIX)).length, 1);
    assert.match(tsx.notes_to_executor[0], /^CX checklist: applicable items must pass, N\/A items must be justified: /);

    // Annotating again (a replacement task) must not duplicate the note.
    const [again] = factory.annotateTasks([tsx]);
    assert.equal(again.notes_to_executor.filter((n: string) => n.startsWith(CX_CHECKLIST_NOTE_PREFIX)).length, 1);
  });

  it('recognises UI files in creates_files, and every UI extension', () => {
    const factory: any = new Factory('/tmp', '', { strategy: 'local' });
    const [tsx, vue, html, ts] = factory.annotateTasks([
      task({ id: 'T1', creates_files: ['src/Button.tsx'] }),
      task({ id: 'T2', files_hint: ['app/App.vue'] }),
      task({ id: 'T3', files_hint: ['public/index.html'] }),
      task({ id: 'T4', files_hint: ['src/util.ts'] }),
    ]);
    for (const t of [tsx, vue, html]) {
      assert.equal(t.notes_to_executor?.filter((n: string) => n.startsWith(CX_CHECKLIST_NOTE_PREFIX)).length, 1, `${t.id} gets the checklist`);
    }
    assert.equal(ts.notes_to_executor?.length, 0, '.ts is not a UI file');
  });

  it('does not add the checklist to a .ts coder task or a non-coder UI task', () => {
    const factory: any = new Factory('/tmp', '', { strategy: 'local' });
    const [ts, css] = factory.annotateTasks([
      task({ id: 'T1', files_hint: ['src/service.ts'] }),
      task({ id: 'T2', files_hint: ['src/styles.css'], agent_role: 'designer' }),
    ]);
    assert.equal(ts.notes_to_executor?.some((n: string) => n.startsWith(CX_CHECKLIST_NOTE_PREFIX)), false);
    assert.equal(css.notes_to_executor?.some((n: string) => n.startsWith(CX_CHECKLIST_NOTE_PREFIX)), false);
  });
});

describe('run metrics carry the CX scores', () => {
  it('reports a cx_scores map for the tasks that were scored', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-cx-metrics-'));
    const state: any = {
      schema_version: CURRENT_SCHEMA_VERSION, feature_id: 'f-1', feature: 'cx', status: 'completed', created_at: new Date().toISOString(),
      tasks: [
        task({ id: 'T1', status: 'done' }),
        task({ id: 'T2', status: 'done', agent_role: 'cx_reviewer', cx_score: 70 }),
        task({ id: 'T3', status: 'done', agent_role: 'cx_reviewer', cx_score: 90 }),
      ],
    };
    const metrics = await computeRunMetrics(baseDir, state);
    assert.deepEqual(metrics.cx_scores, { T2: 70, T3: 90 });
    assert.equal('T1' in (metrics.cx_scores || {}), false, 'a task without a score is not counted');
  });

  it('omits cx_scores when no task was scored', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-cx-metrics-'));
    const state: any = {
      schema_version: CURRENT_SCHEMA_VERSION, feature_id: 'f-1', feature: 'cx', status: 'completed', created_at: new Date().toISOString(),
      tasks: [task({ id: 'T1', status: 'done' })],
    };
    const metrics = await computeRunMetrics(baseDir, state);
    assert.equal(metrics.cx_scores, undefined);
  });
});
