import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { Factory } from './Factory.js';
import { CURRENT_SCHEMA_VERSION } from './types.js';

/** Issue #31: opt-in committed run records. */
async function repo(config?: Record<string, unknown>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-records-'));
  const git = (...args: string[]) => execa('git', args, { cwd: dir });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 't@example.com');
  await git('config', 'user.name', 'T');
  await fs.writeFile(path.join(dir, '.gitignore'), '.softfactory/\n');
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'base');
  await git('checkout', '-q', '-b', 'softfactory/f-1');
  const state = path.join(dir, '.softfactory');
  await fs.mkdir(path.join(state, 'evidence', 'f-1'), { recursive: true });
  await fs.mkdir(path.join(state, 'runs', 'f-1', 'prompts'), { recursive: true });
  if (config) await fs.writeFile(path.join(state, 'config.json'), JSON.stringify(config));
  await fs.writeFile(path.join(state, 'evidence', 'f-1', 'T1-attempt1.log'), 'tests passed\nDEEPSEEK_API_KEY=sk-live-abcdef123456\n');
  await fs.writeFile(path.join(state, 'runs', 'f-1', 'journal.jsonl'), '{"seq":1}\n');
  await fs.writeFile(path.join(state, 'runs', 'f-1', 'prompts', 'T1-attempt1.md'), 'You are a worker.\n');
  await fs.writeFile(path.join(state, 'handoff-index.tsv'), 'date\tfeature_id\ttask_id\n2026-10-08\tf-0\tT9\n2026-10-09\tf-1\tT1\n');

  const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none' });
  factory.state = {
    schema_version: CURRENT_SCHEMA_VERSION, feature_id: 'f-1', feature: 'records', status: 'completed', strategy: 'local',
    cloud_provider: 'agy', planner_provider: 'local', created_at: '', last_updated: '', memory_patterns: [],
    usage: { input_tokens: 0, output_tokens: 0 }, integration_branch: 'softfactory/f-1', base_branch: 'main',
    tasks: [{ id: 'T1', status: 'done', executor: 'agent' }],
  };
  factory.lastMetrics = { run_id: 'f-1', done: 1 };
  const logs: string[] = [];
  factory.on('log', (l: string) => logs.push(l));
  const tree = async (ref: string) => (await git('ls-tree', '-r', '--name-only', ref)).stdout.split('\n').filter(Boolean);
  return { dir, factory, logs, git, tree };
}

describe('issue #31: committed run records are opt-in', () => {
  it('commits nothing by default', async () => {
    const { factory, tree, git } = await repo();
    const before = (await git('rev-parse', 'HEAD')).stdout;
    await factory.commitRunRecords();
    assert.equal((await git('rev-parse', 'HEAD')).stdout, before);
    assert.ok(!(await tree('HEAD')).some(f => f.startsWith('softfactory-records/')));
  });

  it('with commitRecords, the PR branch carries the run evidence, redacted, and the base is untouched', async () => {
    const { factory, tree, dir, logs } = await repo({ commitRecords: true });
    await factory.commitRunRecords();
    const files = await tree('softfactory/f-1');
    for (const expected of ['evidence/T1-attempt1.log', 'journal.jsonl', 'prompts/T1-attempt1.md', 'handoffs.tsv', 'metrics.json']) {
      assert.ok(files.includes(`softfactory-records/f-1/${expected}`), `${expected} missing from ${files.join(', ')}; ${logs.join(' | ')}`);
    }
    assert.ok(!(await tree('main')).some(f => f.startsWith('softfactory-records/')), 'the base branch gets the records only through the PR');
    const log = await fs.readFile(path.join(dir, 'softfactory-records', 'f-1', 'evidence', 'T1-attempt1.log'), 'utf8');
    assert.match(log, /tests passed/);
    assert.doesNotMatch(log, /sk-live-abcdef123456/, 'secrets are redacted before they are committed');
    const handoffs = await fs.readFile(path.join(dir, 'softfactory-records', 'f-1', 'handoffs.tsv'), 'utf8');
    assert.match(handoffs, /f-1\tT1/);
    assert.doesNotMatch(handoffs, /f-0/, 'only this run\'s handoff rows');
  });

  it('does not commit onto a branch the work did not merge into', async () => {
    const { factory, git, tree, logs } = await repo({ commitRecords: true });
    await git('checkout', '-q', 'main');
    await factory.commitRunRecords();
    assert.ok(!(await tree('main')).some(f => f.startsWith('softfactory-records/')));
    assert.ok(logs.some(l => /Records: not committed; the checkout is on main/.test(l)), logs.join('\n'));
  });

  it('does not commit when nothing merged', async () => {
    const { factory, tree } = await repo({ commitRecords: true });
    factory.state.tasks = [{ id: 'T1', status: 'failed', executor: 'agent' }];
    await factory.commitRunRecords();
    assert.ok(!(await tree('HEAD')).some(f => f.startsWith('softfactory-records/')));
  });

  it('keeps committed records out of planning\'s view of the repository', async () => {
    const { factory } = await repo({ commitRecords: true });
    await factory.commitRunRecords();
    const files: string[] = await factory.getRepositoryFiles();
    assert.ok(files.includes('a.ts'));
    assert.ok(!files.some(f => f.startsWith('softfactory-records/')));
  });
});
