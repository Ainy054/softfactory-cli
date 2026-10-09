import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { Factory } from './Factory.js';

/** Issue #18: queued plans with --queue and --next. */

async function project() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-queue-'));
  const git = (...args: string[]) => execa('git', args, { cwd: dir });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'f@example.test');
  await git('config', 'user.name', 'f');
  await fs.writeFile(path.join(dir, 'app.ts'), "export const greet = () => 'hello';\n");
  await git('add', '.');
  await git('commit', '-q', '-m', 'init');
  return dir;
}

const plan = (feature: string) => ({
  feature, requirements_covered: [],
  tasks: [{ id: 'T1', title: `Do ${feature}`, description: `Implement ${feature} in app.ts.`, agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [], files_hint: ['app.ts'], creates_files: [], acceptance_criteria: ['it works'], verification: ['grep greet app.ts'], verification_command: 'grep greet app.ts', production_targets: [], test_targets: [], behavior_tags: [], executor: 'agent', review_questions: [] }],
});

async function factoryOn(dir: string) {
  const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none', useDocker: false, plannerProvider: 'local' });
  const logs: string[] = [];
  factory.on('log', (line: string) => logs.push(line));
  factory.planner = { provider: 'local', generateBlueprint: async (input: any) => plan(input.requirement.split('\n')[0]), refineBlueprint: async () => plan('x') };
  await factory.init();
  const started: string[] = [];
  factory.resume = async () => { started.push(factory.state.feature); };
  return { factory, logs, started };
}

describe('queued plans', () => {
  it('queue() parks a planned state under .softfactory/queue and leaves factory.json alone', async () => {
    const dir = await project();
    const { factory, logs } = await factoryOn(dir);
    await factory.queue('First feature');
    const files = await fs.readdir(path.join(dir, '.softfactory', 'queue'));
    assert.equal(files.length, 1);
    const queued = JSON.parse(await fs.readFile(path.join(dir, '.softfactory', 'queue', files[0]), 'utf8'));
    assert.equal(queued.status, 'planned');
    assert.equal(queued.feature, 'First feature');
    await assert.rejects(fs.access(path.join(dir, '.softfactory', 'factory.json')), 'nothing current was written');
    assert.ok(logs.some(l => /^QUEUED: First feature as f-\S+ \(1 tasks\); run --next to start it\.$/.test(l)), logs.join('\n'));
  });

  it('next() starts queued plans oldest first, one per call', async () => {
    const dir = await project();
    const { factory, started } = await factoryOn(dir);
    await factory.queue('First feature');
    await factory.queue('Second feature');
    assert.equal((await fs.readdir(path.join(dir, '.softfactory', 'queue'))).length, 2, 'same-second plans do not overwrite each other');
    await factory.next();
    assert.deepEqual(started, ['First feature']);
    factory.state.status = 'completed';
    await factory.next();
    assert.deepEqual(started, ['First feature', 'Second feature']);
    assert.deepEqual(await fs.readdir(path.join(dir, '.softfactory', 'queue')), []);
  });

  it('next() refuses while a feature is in progress, and says when the queue is empty', async () => {
    const dir = await project();
    const { factory, logs, started } = await factoryOn(dir);
    await factory.next();
    assert.ok(logs.includes('Queue is empty.'));
    await factory.queue('Waiting feature');
    factory.state = { feature: 'Busy feature', feature_id: 'f-busy', status: 'active', tasks: [], created_at: new Date().toISOString() };
    await factory.next();
    assert.deepEqual(started, []);
    assert.ok(logs.some(l => /A feature is in progress: Busy feature; finish it or --abandon it first/.test(l)));
  });
});
