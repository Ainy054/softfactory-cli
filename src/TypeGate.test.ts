import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskVerifier } from './TaskVerifier.js';

/**
 * Observed 2026-10-09 (#33's run): a change that did not compile passed its
 * tests under tsx, merged, and every later task failed on the broken base.
 */
async function project(files: Record<string, string>, tsconfig = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-types-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', devDependencies: { typescript: '*' } }));
  if (tsconfig) await fs.writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ['src'] }));
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await fs.symlink(path.resolve('node_modules/typescript'), path.join(dir, 'node_modules', 'typescript'));
  await fs.mkdir(path.join(dir, 'src'));
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(dir, 'src', name), text);
  return dir;
}

describe('a task may not add a type error', () => {
  it('fails a change that does not compile, naming the error', async () => {
    const dir = await project({ 'a.ts': 'export const a: number = 1;\n' });
    const verifier: any = new TaskVerifier();
    assert.equal(await verifier.captureTypeBaseline(dir), 0);
    await fs.writeFile(path.join(dir, 'src', 'a.ts'), 'export const a: number = "one";\n');
    const result = await verifier.typeRegression(dir, dir);
    assert.equal(result?.passed, false);
    assert.equal(result?.isCompileError, true);
    assert.match(result.testSummary, /1 new type error/);
    assert.match(result.output, /src\/a\.ts: TS2322/);
  });

  it('does not blame a task for an error the base already had, even when its line moves', async () => {
    const dir = await project({ 'old.ts': 'export const b: string = 2;\n', 'a.ts': 'export const a = 1;\n' });
    const verifier: any = new TaskVerifier();
    assert.equal(await verifier.captureTypeBaseline(dir), 1);
    await fs.writeFile(path.join(dir, 'src', 'old.ts'), '// moved down\n\nexport const b: string = 2;\n');
    assert.equal(await verifier.typeRegression(dir, dir), null);
  });

  it('stays off without a tsconfig or a baseline', async () => {
    const bare = await project({ 'a.ts': 'export const a: number = "x";\n' }, false);
    const verifier: any = new TaskVerifier();
    assert.equal(await verifier.captureTypeBaseline(bare), undefined);
    assert.equal(await verifier.typeRegression(bare, bare), null);
    const fresh: any = new TaskVerifier();
    const dir = await project({ 'a.ts': 'export const a: number = "x";\n' });
    assert.equal(await fresh.typeRegression(dir, dir), null, 'no baseline taken: the gate is off');
  });
});
