import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { LocalAgentWorker } from './ToolLoopWorker.js';

describe('run_command can reach a subproject', () => {
  const w: any = new LocalAgentWorker();

  it('resolves a subdirectory inside the worktree', () => {
    assert.equal(w.resolveWorkingDir('/wt', 'frontend'), path.resolve('/wt/frontend'));
    assert.equal(w.resolveWorkingDir('/wt', 'a/b'), path.resolve('/wt/a/b'));
  });

  it('defaults to the worktree root', () => {
    for (const v of [undefined, null, '']) {
      assert.equal(w.resolveWorkingDir('/wt', v), path.resolve('/wt'));
    }
  });

  it('refuses to escape the worktree', () => {
    for (const bad of ['..', '../..', '/etc', 'frontend/../../..']) {
      assert.throws(() => w.resolveWorkingDir('/wt', bad), `must reject ${bad}`);
    }
  });

  it('reports package roots so the model knows where to run things', async () => {
    // godo's shape: no manifest at the root, one in frontend/, one in backend/.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-roots-'));
    await fs.mkdir(path.join(dir, 'frontend'), { recursive: true });
    await fs.mkdir(path.join(dir, 'backend'), { recursive: true });
    await fs.writeFile(path.join(dir, 'frontend', 'package.json'), '{}');
    await fs.writeFile(path.join(dir, 'backend', 'go.mod'), 'module x');

    const roots = await w.projectRoots(dir);
    assert.deepEqual(roots, ['frontend -> package.json', 'backend -> go.mod']);
    assert.ok(!roots.some((r: string) => r.startsWith('(root)')),
      'godo has no manifest at the root; `npm test` there is the ENOENT that blocked T1');
  });

  it('the system prompt tells the model to use working_dir, not cd', async () => {
    const prompt = w.buildSystemPrompt({ id: 'T1' } as any, '', ['frontend -> package.json']);
    assert.match(prompt, /working_dir/);
    assert.match(prompt, /frontend -> package\.json/);
    assert.match(prompt, /NOT available/);
  });
});
