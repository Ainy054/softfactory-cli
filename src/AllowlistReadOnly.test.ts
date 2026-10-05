import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocalAgentWorker } from './ToolLoopWorker.js';

const guard = (c: string) => (new LocalAgentWorker() as any).assertAllowedCommand(c);

describe('read-only inspection is allowed', () => {
  it('can temporarily disable command blocking for an explicit experiment', async () => {
    const previous = process.env.SOFTFACTORY_DISABLE_TOOL_BLOCKING;
    process.env.SOFTFACTORY_DISABLE_TOOL_BLOCKING = '1';
    try {
      assert.doesNotThrow(() => guard('printf first && printf second'));
      const result = await (new LocalAgentWorker() as any).runSafeCommand(
        'printf first && printf second', process.cwd());
      assert.equal(result.stdout, 'firstsecond');
    } finally {
      if (previous === undefined) delete process.env.SOFTFACTORY_DISABLE_TOOL_BLOCKING;
      else process.env.SOFTFACTORY_DISABLE_TOOL_BLOCKING = previous;
    }
  });

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

  it('allows safe read-only pipelines but blocks unsafe shell operators and npx', () => {
    assert.doesNotThrow(() => guard('rg TODO src | head -20'));
    for (const c of ['ls && curl x', 'cat a | sh', 'grep x file; rm y', 'npx cowsay']) {
      assert.throws(() => guard(c), `must reject: ${c}`);
    }
  });
});
