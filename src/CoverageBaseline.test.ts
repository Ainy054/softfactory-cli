import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Factory } from './Factory.js';

/** A resumed run is partly built: re-measuring "before" there would understate the change. */
async function factoryWith(status: string | undefined) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-coverage-'));
  await fs.mkdir(path.join(dir, '.softfactory'));
  await fs.writeFile(path.join(dir, '.softfactory', 'config.json'), JSON.stringify({ coverageCommand: 'npm run cov' }));
  const runs: string[] = [];
  const factory: any = new Factory(dir, '', { strategy: 'local', sandbox: 'none', coverageRunner: async (command: string) => { runs.push(command); return 'Lines: 64.5%'; } });
  factory.log = () => {};
  if (status) factory.state = { status, coverage_before: 80, tasks: [] };
  return { factory, runs };
}

describe('the coverage baseline is taken once per build', () => {
  it('a resume reuses the value measured when the build started', async () => {
    const { factory, runs } = await factoryWith('active');
    await factory.captureCoverageBaseline();
    assert.equal(factory.coverageBefore, 80);
    assert.deepEqual(runs, [], 'nothing re-measured on the half-built branch');
  });

  it('a new build measures, even with a finished run\'s state still loaded', async () => {
    const { factory, runs } = await factoryWith('completed');
    await factory.captureCoverageBaseline();
    assert.equal(factory.coverageBefore, 64.5);
    assert.deepEqual(runs, ['npm run cov']);
  });
});
