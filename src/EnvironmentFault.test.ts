import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { LocalAgentWorker } from './ToolLoopWorker.js';
import { WorkerEnvironmentError, isEnvironmentFailure } from './IWorker.js';
import { Factory } from './Factory.js';
import { Task } from './types.js';

function makeTask(): Task {
  return {
    id: 'T1', title: 'x', description: 'x', agent_role: 'coder', phase: 1,
    dependencies: [], blockedBy: [], files_hint: [], creates_files: [],
    acceptance_criteria: [], verification: [], status: 'pending', attempts: 0,
    escalation_level: 0, error_history: [], worker_type: 'auto',
  };
}

/** Stands in for Ollama so the test never depends on a live daemon. */
async function fakeOllama(models: string[]): Promise<{ host: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: models.map(name => ({ name })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as any;
  return { host: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) };
}

describe('LocalAgentWorker distinguishes a dead daemon from a missing model', () => {
  it('reports an unreachable host as an environment fault, not a missing model', async () => {
    // Port 1 is reserved and never listening.
    const worker = new LocalAgentWorker('qwen2.5-coder:7b', 'http://127.0.0.1:1');
    await assert.rejects(
      () => worker.execute(makeTask(), os.tmpdir(), {}),
      (error: Error) => {
        assert.ok(error instanceof WorkerEnvironmentError, 'must be a WorkerEnvironmentError');
        assert.ok(isEnvironmentFailure(error));
        assert.match(error.message, /not reachable/);
        assert.doesNotMatch(error.message, /ollama pull/, 'must not tell the user to pull a model that is present');
        return true;
      });
  });

  it('reports a genuinely absent model as a normal, non-environment failure', async () => {
    const ollama = await fakeOllama(['qwen2.5-coder:7b']);
    try {
      const worker = new LocalAgentWorker('qwen2.5-coder:70b', ollama.host);
      await assert.rejects(
        () => worker.execute(makeTask(), os.tmpdir(), {}),
        (error: Error) => {
          assert.ok(!isEnvironmentFailure(error), 'a missing model is the task/config fault, not the environment');
          assert.match(error.message, /is not installed/);
          assert.match(error.message, /ollama pull qwen2\.5-coder:70b/);
          assert.match(error.message, /qwen2\.5-coder:7b/, 'should list what is installed');
          return true;
        });
    } finally { await ollama.close(); }
  });

  it('treats a reachable host with the model present as available', async () => {
    const ollama = await fakeOllama(['qwen2.5-coder:7b']);
    try {
      const worker = new LocalAgentWorker('qwen2.5-coder:7b', ollama.host);
      assert.equal(await worker.isAvailable('qwen2.5-coder:7b'), true);
      assert.equal(await worker.isAvailable('qwen2.5-coder:14b'), false);
    } finally { await ollama.close(); }
  });
});

describe('Factory: an environment fault must not consume a retry', () => {
  it('leaves attempts and error_history untouched and rethrows', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-env-'));
    const factory: any = new Factory(baseDir, '', { strategy: 'local' });
    factory.state = { feature_id: 'f-1', feature: 't', status: 'active', strategy: 'local',
      cloud_provider: 'agy', planner_provider: 'local', created_at: '', last_updated: '',
      tasks: [], memory_patterns: [] };
    factory.saveState = async () => {};
    factory.getProjectContext = async () => '';
    factory.lessons.getRelevant = async () => [];
    factory.taskVerifier.prepare = async () => ({ ok: true });
    factory.workerRegistry.resolveWorker = async () => ({
      worker: {
        id: 'stub', name: 'stub', isAvailable: async () => true,
        execute: async () => { throw new WorkerEnvironmentError('Ollama is not reachable at http://127.0.0.1:11434.'); },
      },
      model: 'qwen2.5-coder:7b', provider: 'ollama',
    });

    const task = makeTask();
    await assert.rejects(() => factory.executeAndInspect(task, '/tmp/wt'), isEnvironmentFailure);
    assert.equal(task.attempts, 0, 'an outage must not burn a retry');
    assert.equal(task.escalation_level, 0, 'an outage must not escalate');
    assert.deepEqual(task.error_history, [], 'an outage must not poison error history');
    assert.equal(task.status, 'pending', 'the task must stay runnable');
  });
});
