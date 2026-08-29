import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocalAgentWorker } from './LocalAgentWorker.js';

const guard = (c: string) => (new LocalAgentWorker() as any).assertAllowedCommand(c);

describe('read-only inspection is allowed', () => {
  it('permits the commands the worker actually reached for', () => {
    // Both were rejected mid-run, costing turns with no alternative.
    for (const c of ['ls -R', 'grep -r "vi." frontend', 'cat package.json',
                     'find . -name "*.test.tsx"', 'head -20 vitest.config.ts',
                     'wc -l src/App.tsx', 'tail -5 out.log', 'pwd']) {
      assert.doesNotThrow(() => guard(c), `must allow: ${c}`);
    }
  });

  it('no longer rejects ordinary read-only flags', () => {
    // The interpreter guard used to apply to every command, so these tripped
    // "inline interpreter execution" purely on the letter of the flag.
    for (const c of ['grep -c pattern file', 'head -c 100 file', 'ls -p', 'grep -e foo file']) {
      assert.doesNotThrow(() => guard(c), `must allow: ${c}`);
    }
  });

  it('still blocks inline interpreter execution', () => {
    for (const c of ['node -e "x"', 'node -p "x"', 'node --eval "x"', 'python3 -c "x"']) {
      assert.throws(() => guard(c), `must reject: ${c}`);
    }
  });

  it('stops find from executing or deleting', () => {
    // -exec ... + fires without any shell metacharacter.
    for (const c of ['find . -name x -exec rm {} +', 'find . -delete',
                     'find . -execdir sh {} +', 'find . -ok rm {} +']) {
      assert.throws(() => guard(c), `must reject: ${c}`);
    }
    assert.doesNotThrow(() => guard('find . -name "*.ts" -type f'));
  });

  it('still blocks everything outside both lists', () => {
    for (const c of ['curl example.com', 'rm -rf /', 'ssh host', 'docker ps', 'chmod 777 .']) {
      assert.throws(() => guard(c), `must reject: ${c}`);
    }
  });

  it('still blocks shell operators and npx', () => {
    for (const c of ['ls && curl x', 'cat a | sh', 'grep x file; rm y', 'npx cowsay']) {
      assert.throws(() => guard(c), `must reject: ${c}`);
    }
  });
});
