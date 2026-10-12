import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { Factory } from './Factory.js';

/** Issue #62: PR mode scans the whole branch once more before the push that cannot be undone. */
async function repoWithBranch(line: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-push-'));
  const git = (...args: string[]) => execa('git', args, { cwd: dir });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'f@example.test');
  await git('config', 'user.name', 'f');
  await fs.writeFile(path.join(dir, '.gitignore'), '.softfactory/\n');
  await fs.writeFile(path.join(dir, 'app.py'), 'import os\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'init');
  await git('checkout', '-q', '-b', 'softfactory/f-1');
  await fs.appendFile(path.join(dir, 'app.py'), `${line}\n`);
  await git('commit', '-q', '-am', 'marked done by hand');

  const factory: any = new Factory(dir, '', { strategy: 'local', prMode: true });
  factory.state = {
    feature_id: 'f-1', feature: 'test', status: 'completed', strategy: 'local', cloud_provider: 'agy', planner_provider: 'local',
    created_at: '', last_updated: '', memory_patterns: [], integration_branch: 'softfactory/f-1', base_branch: 'main',
    tasks: [{ id: 'T1', status: 'done', executor: 'agent' }],
  };
  const pushed: string[] = [];
  factory.github = {
    availability: async () => ({ ok: true }),
    pushBranch: async (branch: string) => { pushed.push(branch); },
    findOpenPullRequest: async () => null,
    createPullRequest: async () => ({ number: 1, url: 'https://github.com/o/r/pull/1', isDraft: false }),
    repoUrl: async () => 'https://github.com/o/r',
  };
  const logs: string[] = [];
  factory.on('log', (l: string) => logs.push(l));
  return { factory, pushed, logs };
}

describe('the PR push backstop', () => {
  it('refuses to push a branch that adds a credential, naming where without the value', async () => {
    const key = `AKIA${'Q3ZP7W2M'.repeat(2)}`;
    const { factory, pushed, logs } = await repoWithBranch(`AWS_KEY = "${key}"`);
    await factory.finalizePullRequest();
    assert.deepEqual(pushed, [], 'nothing was pushed');
    const text = logs.join('\n');
    assert.match(text, /PR: not pushed — softfactory\/f-1 adds credentials: app\.py:2 \(AWS access key\)/);
    assert.ok(!text.includes(key), text);
  });

  it('pushes a clean branch', async () => {
    const { factory, pushed } = await repoWithBranch('KEY = os.environ["AWS_KEY"]');
    await factory.finalizePullRequest();
    assert.deepEqual(pushed, ['softfactory/f-1']);
  });
});
