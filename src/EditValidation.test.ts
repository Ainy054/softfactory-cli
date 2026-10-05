import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { LocalAgentWorker } from './ToolLoopWorker.js';
import { AutoHeal } from './AutoHeal.js';

const GOOD = JSON.stringify({
  name: 'godo-frontend',
  scripts: { 'test:e2e': 'playwright test', 'test:ui': 'vitest --ui' },
}, null, 2);

// The exact shape the worker produced on godo: a dropped comma between two
// scripts entries. It was committed, and every later attempt then died in
// `npm ci` with EJSONPARSE before a model was ever invoked.
const BROKEN = GOOD.replace('"playwright test",', '"playwright test"');

async function scratch(content = GOOD) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-edit-'));
  const file = path.join(dir, 'package.json');
  await fs.writeFile(file, content);
  return { dir, file };
}

describe('edits that would corrupt a structured file are rejected', () => {
  const worker: any = new LocalAgentWorker();

  it('auto-heals a repairable JSON typo and reports it', async () => {
    const { file } = await scratch();
    const changed = new Set<string>();
    const result = await worker.writeChecked(file, 'package.json', BROKEN, GOOD, changed, 'ok');

    assert.match(result, /JSON auto-healed and revalidated/);
    JSON.parse(await fs.readFile(file, 'utf-8'));
    assert.equal(changed.size, 1, 'a healed edit counts as a validated change');
  });

  it('accepts a valid edit and records the change', async () => {
    const { file } = await scratch();
    const changed = new Set<string>();
    const next = GOOD.replace('godo-frontend', 'godo-ui');
    const result = await worker.writeChecked(file, 'package.json', next, GOOD, changed, 'ok');

    assert.equal(result, 'ok');
    assert.equal(await fs.readFile(file, 'utf-8'), next);
    assert.deepEqual([...changed], ['package.json']);
  });

  it('deletes a newly created file rather than leaving a broken one behind', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-edit-new-'));
    const file = path.join(dir, 'tsconfig.json');
    const changed = new Set<string>();
    const heal = AutoHeal.healJson;
    AutoHeal.healJson = () => '{ "a": }';
    try {
      await worker.writeChecked(file, 'tsconfig.json', '{ "a": }', null, changed, 'ok');
    } finally {
      AutoHeal.healJson = heal;
    }
    await assert.rejects(() => fs.readFile(file, 'utf-8'), 'a file that was never valid must not persist');
  });

  it('leaves non-structured files alone', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-edit-ts-'));
    const file = path.join(dir, 'vitest.config.ts');
    const changed = new Set<string>();
    const result = await worker.writeChecked(file, 'vitest.config.ts', 'this is not { valid ts', null, changed, 'ok');
    assert.equal(result, 'ok', 'only file types we can actually validate are checked');
    assert.deepEqual([...changed], ['vitest.config.ts']);
  });

  it('rejects an empty JSON file', async () => {
    const { file } = await scratch();
    const changed = new Set<string>();
    const result = await worker.writeChecked(file, 'package.json', '   ', GOOD, changed, 'ok');
    assert.match(result, /the file is empty/);
    assert.equal(await fs.readFile(file, 'utf-8'), GOOD);
  });
});
