import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskVerifier } from './TaskVerifier.js';

describe('TaskVerifier', () => {
  it('fails closed when Node dependencies are unavailable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-verifier-'));
    try {
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' }, devDependencies: { vitest: '^3.0.0' } }));
      const result = await new TaskVerifier().verify(dir);
      assert.equal(result.executed, false);
      assert.equal(result.passed, false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
