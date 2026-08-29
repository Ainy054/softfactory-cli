import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Factory } from './Factory.js';
import { Task } from './types.js';

function task(over: Partial<Task> = {}): Task {
  return { id: 'T1', title: 't', description: 'd', agent_role: 'coder', phase: 1,
    dependencies: [], blockedBy: [], files_hint: ['a.ts', 'b.ts', 'c.ts'], creates_files: [],
    acceptance_criteria: [], verification: [], status: 'pending', attempts: 0,
    escalation_level: 0, error_history: [], worker_type: 'auto', ...over } as Task;
}

const registryFor = (localModel: string) =>
  (new Factory('/tmp', '', { strategy: 'local', localModel }) as any).workerRegistry;

describe('--local-model pins every local tier', () => {
  it('is honoured on a retry, not just the first attempt', async () => {
    // The bug: a run started with --local-model=gemma4:12b was observed
    // serving qwen2.5-coder:14b, because escalation > 0 took heavyLocalModel,
    // which Factory left on its hardcoded default.
    const r = registryFor('gemma4:12b');
    for (const attempts of [0, 1, 2, 3, 5]) {
      const { model } = await r.resolveWorker(task({ attempts }));
      assert.equal(model, 'gemma4:12b', `attempt ${attempts} must stay on the chosen model`);
    }
  });

  it('pins the light tier too, so a small task does not fall back to 7b', async () => {
    const r = registryFor('gemma4:12b');
    const { model } = await r.resolveWorker(task({ files_hint: ['a.ts'], agent_role: 'devops' }));
    assert.equal(model, 'gemma4:12b');
  });

  it('leaves the default tiering alone when no model is pinned', async () => {
    const r = registryFor('auto');
    const light = await r.resolveWorker(task({ files_hint: ['a.ts'], phase: 1 }));
    const heavy = await r.resolveWorker(task({ attempts: 2 }));
    assert.equal(light.model, 'qwen2.5-coder:7b');
    assert.equal(heavy.model, 'qwen2.5-coder:14b');
  });

  it('treats "tiered" as a request for the default ladder', async () => {
    const r = registryFor('tiered');
    assert.equal((await r.resolveWorker(task({ attempts: 2 }))).model, 'qwen2.5-coder:14b');
  });
});
