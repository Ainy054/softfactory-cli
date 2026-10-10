import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { Factory } from './Factory.js';
import type { Task, Handoff } from './types.js';

/** Issues #58 and #59: the design gate, and the approved mockup as acceptance. */
const MOCKUP = 'softfactory-design/mockups/T1-dashboard.html';
const base = { description: 'd', dependencies: [] as string[], blockedBy: [] as string[], acceptance_criteria: ['done'], production_targets: [], test_targets: [], behavior_tags: [], executor: 'agent' as const, review_questions: [] };
const tasks = [
  { ...base, id: 'T1', title: 'Design the dashboard', agent_role: 'designer' as const, phase: 1, files_hint: [MOCKUP], creates_files: [MOCKUP], verification: [`ls ${MOCKUP}`], verification_command: `ls ${MOCKUP}` },
  { ...base, id: 'T2', title: 'Build the dashboard', agent_role: 'coder' as const, phase: 2, dependencies: ['T1'], files_hint: ['dashboard.ts'], creates_files: ['dashboard.ts'], verification: ['ls dashboard.ts'], verification_command: 'ls dashboard.ts' },
  { ...base, id: 'T3', title: 'Unrelated settings', agent_role: 'coder' as const, phase: 2, files_hint: ['settings.ts'], creates_files: ['settings.ts'], verification: ['ls settings.ts'], verification_command: 'ls settings.ts' },
];

async function run() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-design-'));
  const git = (...args: string[]) => execa('git', args, { cwd: dir });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'f@example.test');
  await git('config', 'user.name', 'f');
  await fs.writeFile(path.join(dir, '.gitignore'), '.softfactory/\n');
  await fs.writeFile(path.join(dir, 'README.md'), 'demo\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'init');
  const blueprint = { feature: 'Dashboard', requirements_covered: ['dashboard'], tasks };
  const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none', useDocker: false, plannerProvider: 'local' });
  const logs: string[] = [];
  factory.on('log', (line: string) => logs.push(line));
  factory.planner = { provider: 'local', generateBlueprint: async () => blueprint, refineBlueprint: async () => blueprint };
  await factory.init();
  const ran: string[] = [];
  const worker = {
    id: 'fake', name: 'Fake',
    execute: async (t: Task, cwd: string): Promise<Handoff> => {
      ran.push(t.id);
      const file = t.files_hint[0];
      await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
      await fs.writeFile(path.join(cwd, file), t.agent_role === 'designer' ? `<html><section>default</section><section>empty</section><!-- ${ran.length} --></html>\n` : `export const x = ${ran.length};\n`);
      return { task_id: t.id, status: 'success', files_changed: [file], summary: 'done' };
    },
  };
  factory.workerRegistry.preflight = async () => ({ local: true, cloud: false, localModel: 'fake', cloudModel: '' });
  factory.workerRegistry.resolveWorker = async () => ({ worker, model: 'fake', provider: 'fake' });
  factory.inspector.synthesizeMemory = async () => '';
  await factory.build('build a dashboard');
  return { factory, logs, ran, dir };
}

const status = (factory: any) => Object.fromEntries(factory.state.tasks.map((t: any) => [t.id, t.status]));

describe('the design gate', () => {
  it('holds only the work that depends on a design; unrelated tasks keep merging', async () => {
    const { factory, logs, ran } = await run();
    assert.deepEqual(status(factory), { T1: 'done', T2: 'pending', T3: 'done' }, logs.join('\n'));
    assert.ok(!ran.includes('T2'));
    assert.equal(factory.state.tasks[0].design_status, 'awaiting');
    assert.deepEqual(factory.state.tasks[0].mockups, [MOCKUP]);
    assert.equal(factory.state.status, 'paused');
    assert.ok(logs.some(l => /DESIGN GATE: T1's mockups wait for approval .*; T2 wait, other work continues/.test(l)), logs.join('\n'));
    assert.ok(logs.some(l => /PAUSED: design approval needed for T1/.test(l)));
  });

  it('on approval, the dependent task gets the mockup as its target and reviewers get it as evidence', async () => {
    const { factory, dir } = await run();
    await factory.approveDesign('T1', 'approve');
    const t2 = factory.state.tasks[1];
    assert.ok(t2.notes_to_executor.some((n: string) => n.includes(`Implement to match the approved mockup(s): ${MOCKUP}`)));
    assert.match(await factory.mockupEvidence(t2, dir), /APPROVED MOCKUP softfactory-design\/mockups\/T1-dashboard\.html \(from T1\)[\s\S]*<section>empty<\/section>/);
    assert.equal(await factory.mockupEvidence(factory.state.tasks[2], dir), '', 'unrelated work gets no mockup');
    await factory.runWorkshopLoop();
    assert.deepEqual(status(factory), { T1: 'done', T2: 'done', T3: 'done' });
    assert.equal(factory.state.status, 'completed');
  });

  it('gives a design one revision with the notes, then insists on approve or skip', async () => {
    const { factory, ran } = await run();
    await assert.rejects(factory.approveDesign('T1', 'revise'), /needs notes/);
    await factory.approveDesign('T1', 'revise', 'show the error state');
    assert.equal(factory.state.tasks[0].status, 'pending');
    assert.match(factory.state.tasks[0].last_feedback, /Revise the mockups .*show the error state/);
    await factory.runWorkshopLoop();
    assert.equal(ran.filter(id => id === 'T1').length, 2, 'the designer ran again');
    assert.equal(factory.state.tasks[0].design_status, 'awaiting');
    await assert.rejects(factory.approveDesign('T1', 'revise', 'again'), /had its one revision/);
    await factory.approveDesign('T1', 'skip', 'deadline');
    assert.ok(factory.state.tasks[1].notes_to_executor.some((n: string) => /Design skipped for T1 \(deadline\)/.test(n)));
    await assert.rejects(factory.approveDesign('T2', 'approve'), /not a designer task/);
  });
});
