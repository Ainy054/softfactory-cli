import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readPin, writePin, pinCheck } from './VersionPin.js';

async function tempBase(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sf-versionpin-'));
}

describe('pinCheck', () => {
  it('passes when only the minor version differs', () => {
    assert.deepEqual(pinCheck('5.6.1', '5.7.0'), { ok: true });
  });

  it('fails across a major version and names both versions', () => {
    const result = pinCheck('5.7.0', '6.0.0');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /5\.7\.0/);
    assert.match(result.message, /6\.0\.0/);
    assert.match(result.message, /softfactory --adopt/);
  });
});

describe('writePin', () => {
  it('keeps an existing coverageCommand key and 2-space formatting', async () => {
    const baseDir = await tempBase();
    const file = path.join(baseDir, '.softfactory', 'config.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ coverageCommand: 'npm run cov', commitRecords: true }, null, 2)}\n`, 'utf8');

    await writePin(baseDir, '5.7.0');

    const raw = await fs.readFile(file, 'utf8');
    const config = JSON.parse(raw);
    assert.equal(config.coverageCommand, 'npm run cov');
    assert.equal(config.commitRecords, true);
    assert.equal(config.softfactory_version, '5.7.0');
    assert.equal(raw, `${JSON.stringify({ coverageCommand: 'npm run cov', commitRecords: true, softfactory_version: '5.7.0' }, null, 2)}\n`);
  });

  it('creates the file when none exists', async () => {
    const baseDir = await tempBase();
    await writePin(baseDir, '5.7.0');
    assert.equal(await readPin(baseDir), '5.7.0');
  });
});

describe('readPin', () => {
  it('is undefined on a missing file', async () => {
    const baseDir = await tempBase();
    assert.equal(await readPin(baseDir), undefined);
  });

  it('is undefined when the field is absent', async () => {
    const baseDir = await tempBase();
    const file = path.join(baseDir, '.softfactory', 'config.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ coverageCommand: 'npm run cov' }, null, 2)}\n`, 'utf8');
    assert.equal(await readPin(baseDir), undefined);
  });
});

describe('writePin on a config it cannot read', () => {
  it('refuses rather than replacing the project\'s settings', async () => {
    const baseDir = await tempBase();
    const file = path.join(baseDir, '.softfactory', 'config.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ "commitRecords": true, ', 'utf8');
    await assert.rejects(writePin(baseDir, '5.7.0'), /not valid JSON/);
    assert.equal(await fs.readFile(file, 'utf8'), '{ "commitRecords": true, ', 'the file is untouched');
  });
});
