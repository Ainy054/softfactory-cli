import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { scout } from './Scout.js';
import { argvText } from './IWorker.js';
import { buildCodexExecArgs } from './CodexWorker.js';

// mongolbank-rates tracked app/__pycache__/cache.cpython-312.pyc. Scout read it
// as text, its NUL bytes reached the planner prompt, and agy refused the
// argument: "Arguments cannot contain null bytes".

describe('binary files never reach a command-line prompt', () => {
  it('scout skips a tracked binary file that mentions the requirement', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-binary-'));
    await fs.mkdir(path.join(dir, 'app', '__pycache__'), { recursive: true });
    await fs.writeFile(path.join(dir, 'app', '__pycache__', 'cache.cpython-312.pyc'), Buffer.from('\u0000\u0001get_latest_rates\u0000upsert_rates\u0000'));
    await fs.writeFile(path.join(dir, 'app', 'cache.py'), 'def get_latest_rates():\n    return upsert_rates\n');
    const evidence = await scout(dir, 'Fix `get_latest_rates` and `upsert_rates` in the cache', ['app/__pycache__/cache.cpython-312.pyc', 'app/cache.py']);
    assert.ok(evidence.some(line => line.includes('app/cache.py')), evidence.join('\n'));
    assert.ok(!evidence.some(line => line.includes('.pyc')), evidence.join('\n'));
    assert.ok(!evidence.join('\n').includes('\u0000'));
  });

  it('strips NUL bytes from a prompt passed as an argument', () => {
    assert.equal(argvText('plan\u0000 this\u0000'), 'plan this');
    assert.equal(argvText('plain'), 'plain');
    assert.ok(!buildCodexExecArgs('a\u0000b').some(arg => arg.includes('\u0000')));
  });
});
