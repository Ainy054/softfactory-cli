import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { LocalAgentWorker } from './ToolLoopWorker.js';
import { runSafeCommand, selectHostShell } from './commandPolicy.js';
import type { CommandRunner } from './Sandbox.js';

const guard = (c: string) => (new LocalAgentWorker() as any).assertAllowedCommand(c);

describe('host experiment shell selection', () => {
  it('selects a shell that exists on this machine', () => {
    assert.ok(existsSync(selectHostShell().shell));
  });

  it('prefers an existing configured shell and uses the appropriate flag', () => {
    for (const [shell, flag] of [['/custom/zsh', '-lc'], ['/custom/bash', '-lc'],
                                 ['/bin/sh', '-c'], ['/custom/fish', '-c']]) {
      assert.deepEqual(selectHostShell({ SHELL: shell }, () => true), { shell, flag });
    }
  });

  it('falls back in order for missing, empty, or nonexistent SHELL', () => {
    const candidates = ['/bin/zsh', '/bin/bash', '/bin/sh'];
    for (const configured of [undefined, '', '/missing/shell']) {
      for (let index = 0; index < candidates.length; index++) {
        const existing = candidates.slice(index);
        assert.deepEqual(selectHostShell({ SHELL: configured }, file => existing.includes(file)), {
          shell: candidates[index], flag: index < 2 ? '-lc' : '-c',
        });
      }
    }
  });

  it('reports clearly when no shell exists', () => {
    assert.throws(() => selectHostShell({ SHELL: '/missing/shell' }, () => false), /No host shell found/);
  });

  it('uses shell selection only for host overrides and keeps Docker sh -c', async () => {
    const previous = process.env.SOFTFACTORY_DISABLE_TOOL_BLOCKING;
    const previousShell = process.env.SHELL;
    const calls: Array<[string, string[]]> = [];
    const runner = (kind: CommandRunner['kind']): CommandRunner => ({
      kind, describe: () => 'recording runner',
      exec: async (file, args) => {
        calls.push([file, args]);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    try {
      process.env.SHELL = '/missing/shell';
      process.env.SOFTFACTORY_DISABLE_TOOL_BLOCKING = '1';
      const command = 'printf first && printf second';
      const { shell, flag } = selectHostShell();
      await runSafeCommand(command, process.cwd(), 30000, { runner: runner('host') });
      await runSafeCommand(command, process.cwd(), 30000, { runner: runner('docker') });
      assert.deepEqual(calls, [[shell, [flag, command]], ['sh', ['-c', command]]]);

      delete process.env.SOFTFACTORY_DISABLE_TOOL_BLOCKING;
      calls.length = 0;
      for (const kind of ['host', 'docker'] as const) {
        await runSafeCommand('pwd', process.cwd(), 30000, { runner: runner(kind) });
        await assert.rejects(runSafeCommand('curl example.com', process.cwd(), 30000,
          { runner: runner(kind) }), /not allowlisted/);
      }
      assert.deepEqual(calls, [['pwd', []], ['pwd', []]]);
    } finally {
      if (previous === undefined) delete process.env.SOFTFACTORY_DISABLE_TOOL_BLOCKING;
      else process.env.SOFTFACTORY_DISABLE_TOOL_BLOCKING = previous;
      if (previousShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = previousShell;
    }
  });
});

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
