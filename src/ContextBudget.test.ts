import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import { LocalAgentWorker } from './LocalAgentWorker.js';
import { Factory } from './Factory.js';

const CTX = 4096;                       // a 14B on a 16 GB host
const BUDGET = Math.max(5000, Math.floor(CTX * 1.8));

describe('compactMessages keeps the whole conversation inside the window', () => {
  const compact = (m: any[]) => (new LocalAgentWorker() as any).compactMessages(m, CTX);
  const size = (m: any[]) => m.reduce((n, x) => n + (x.content || '').length, 0);

  it('truncates an oversized system prompt instead of exempting it', () => {
    // godo's real shape: 25,712 chars of `git ls-files` in messages[0], which
    // compaction used to preserve verbatim — 3.5x the entire budget.
    const messages = [
      { role: 'system', content: 'S'.repeat(25712) },
      { role: 'user', content: 'do the task' },
      { role: 'assistant', content: '' },
      { role: 'tool', content: 'T'.repeat(4682) },
    ];
    const out = compact(messages);
    assert.ok(out[0].content.length < 25712, 'the head must be compactable');
    assert.ok(size(out) <= BUDGET * 1.2, `compacted to ${size(out)} chars, budget ${BUDGET}`);
  });

  it('preserves the newest tool result — the model must see what it just asked for', () => {
    const fileBody = 'X'.repeat(4682);
    const messages = [
      { role: 'system', content: 'S'.repeat(9000) },
      { role: 'user', content: 'u' },
      ...Array.from({ length: 6 }, () => [
        { role: 'assistant', content: 'a'.repeat(1500) },
        { role: 'tool', content: 'old'.repeat(500) },
      ]).flat(),
      { role: 'assistant', content: '' },
      { role: 'tool', content: fileBody },
    ];
    const out = compact(messages);
    const last = out[out.length - 1];
    assert.equal(last.role, 'tool');
    assert.ok(last.content.length > 1000,
      `newest tool result was squeezed to ${last.content.length} chars; that is the read_file livelock`);
  });

  it('never returns more messages than it was given', () => {
    const messages = [
      { role: 'system', content: 'S'.repeat(9000) },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: '' },
      { role: 'tool', content: 'T'.repeat(9000) },
    ];
    assert.ok(compact(messages).length <= messages.length + 1);
  });
});

describe('projectContext is bounded', () => {
  it('does not dump the whole file listing into the system prompt', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-ctx-'));
    await execa('git', ['init', '-q'], { cwd: dir });
    await execa('git', ['config', 'user.email', 't@t'], { cwd: dir });
    await execa('git', ['config', 'user.name', 't'], { cwd: dir });
    // 648 tracked files, godo's actual count.
    // Put them in the task's own directory, so the directory filter cannot be
    // what saves us — the cap has to.
    await fs.mkdir(path.join(dir, 'frontend'), { recursive: true });
    for (let i = 0; i < 648; i++) {
      await fs.writeFile(path.join(dir, 'frontend', `Component${i}WithAVeryLongFileName.tsx`), 'x');
    }
    await fs.writeFile(path.join(dir, 'frontend', 'vitest.config.ts'), 'x');
    await execa('git', ['add', '-A'], { cwd: dir });

    const factory: any = new Factory(dir, '', { strategy: 'local' });
    const ctx = await factory.getProjectContext(dir, { files_hint: ['frontend/vitest.config.ts'], creates_files: [] });
    assert.ok(ctx.length <= Factory.MAX_PROJECT_CONTEXT_CHARS + 60,
      `projectContext was ${ctx.length} chars; it lands in the un-shrinkable system prompt`);
    assert.ok(ctx.length / 3.1 < CTX, 'must fit well inside a 4096-token window');
  });
});

describe('repeated tool calls are stopped, not repeated 30 times', () => {
  it('warns then aborts on identical calls', () => {
    assert.ok(LocalAgentWorker.REPEAT_WARN < LocalAgentWorker.REPEAT_ABORT);
    assert.ok(LocalAgentWorker.REPEAT_ABORT <= 8, 'must abort well before the 30-iteration cap');
  });
});
