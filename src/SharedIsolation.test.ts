import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { Factory } from './Factory.js';
import type { Task, Handoff } from './types.js';

/** Issue #50: --isolation=shared runs without worktrees, one task at a time in the main checkout. */
const task = (n: number) => ({
  id: `T${n}`, title: `Write t${n}.txt`, description: `Write t${n}.txt.`, agent_role: 'coder' as const, phase: 1,
  dependencies: [], blockedBy: [], files_hint: [`t${n}.txt`], creates_files: [`t${n}.txt`], acceptance_criteria: ['exists'],
  verification: [`ls t${n}.txt`], verification_command: `ls t${n}.txt`, production_targets: [], test_targets: [], behavior_tags: [],
  executor: 'agent' as const, review_questions: [],
});

async function run(options: { tamper?: string; dirty?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-shared-'));
  const git = (...args: string[]) => execa('git', args, { cwd: dir });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'f@example.test');
  await git('config', 'user.name', 'f');
  await fs.writeFile(path.join(dir, '.gitignore'), '.softfactory/\n');
  await fs.writeFile(path.join(dir, 'README.md'), 'demo\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'init');
  await fs.mkdir(path.join(dir, '.softfactory'));
  await fs.writeFile(path.join(dir, '.softfactory', 'uat.json'), JSON.stringify({ probes: [{ name: 'readme', run: 'test -f README.md' }] }));
  if (options.dirty) await fs.writeFile(path.join(dir, 'README.md'), 'edited by hand\n');
  const blueprint = { feature: 'Three files', requirements_covered: ['files'], tasks: [task(1), task(2), task(3)] };
  const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none', useDocker: false, plannerProvider: 'local', isolation: 'shared' });
  const logs: string[] = [];
  factory.on('log', (line: string) => logs.push(line));
  factory.planner = { provider: 'local', generateBlueprint: async () => blueprint, refineBlueprint: async () => blueprint };
  await factory.init();
  const seen: Array<{ id: string; cwd: string; worktrees: number }> = [];
  let tampered = false;
  const worker = {
    id: 'fake', name: 'Fake',
    execute: async (t: Task, cwd: string): Promise<Handoff> => {
      const { stdout } = await execa('git', ['worktree', 'list'], { cwd: dir });
      seen.push({ id: t.id, cwd, worktrees: stdout.split('\n').filter(Boolean).length });
      if (options.tamper === t.id && !tampered) {
        tampered = true;
        await fs.writeFile(path.join(cwd, '.softfactory', 'uat.json'), JSON.stringify({ probes: [] }));
      }
      await fs.writeFile(path.join(cwd, `${t.id.toLowerCase()}.txt`), `${t.id}\n`);
      return { task_id: t.id, status: 'success', files_changed: [`${t.id.toLowerCase()}.txt`], summary: 'wrote it' };
    },
  };
  factory.workerRegistry.preflight = async () => ({ local: true, cloud: false, localModel: 'fake', cloudModel: '' });
  factory.workerRegistry.resolveWorker = async () => ({ worker, model: 'fake', provider: 'fake' });
  factory.inspector.synthesizeMemory = async () => '';
  await factory.build('write three files');
  return { factory, logs, seen, dir, git };
}

describe('shared-sequential isolation', () => {
  it('runs every task in the main checkout, one at a time, with no worktree', async () => {
    const { factory, logs, seen, dir, git } = await run();
    assert.equal(factory.state.status, 'completed', logs.join('\n'));
    assert.deepEqual(seen.map(s => s.id), ['T1', 'T2', 'T3']);
    assert.ok(seen.every(s => s.cwd === dir), 'the worker works in the main checkout');
    assert.ok(seen.every(s => s.worktrees === 1), 'no worktree besides the checkout itself');
    assert.equal(logs.filter(l => /Running 1 task\(s\) in the shared checkout/.test(l)).length, 3);
    const { stdout: branch } = await git('rev-parse', '--abbrev-ref', 'HEAD');
    assert.equal(branch.trim(), 'main');
    const { stdout: subjects } = await git('log', '--format=%s', 'main');
    for (const id of ['T1', 'T2', 'T3']) assert.match(subjects, new RegExp(`softfactory: merge ${id}`));
  });

  it('restores a gate file a task changed and rejects that attempt', async () => {
    const { factory, logs, dir } = await run({ tamper: 'T2' });
    assert.ok(logs.some(l => /REJECTED: T2 — changed gate files \.softfactory\/uat\.json \(restored\)/.test(l)), logs.join('\n'));
    assert.match(await fs.readFile(path.join(dir, '.softfactory', 'uat.json'), 'utf8'), /readme/);
    assert.equal(factory.state.status, 'completed', 'T2 retried cleanly');
  });

  it('halts, charging nothing, when the checkout has uncommitted changes', async () => {
    const { factory, logs, seen } = await run({ dirty: true });
    assert.deepEqual(seen, []);
    assert.ok(logs.some(l => /HALTED: shared isolation works in the main checkout, which has uncommitted changes \(README\.md\)/.test(l)), logs.join('\n'));
    assert.equal(factory.state.status, 'active');
    assert.ok(factory.state.tasks.every((t: any) => t.attempts === 0));
  });
});
