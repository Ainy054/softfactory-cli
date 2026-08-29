import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { LocalPlanner } from './Planner.js';

async function capturePrompt(): Promise<{ host: string; prompts: string[]; close: () => Promise<void> }> {
  const prompts: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      prompts.push(JSON.parse(body).prompt);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ response: JSON.stringify({ feature: 'A small feature', requirements_covered: [], tasks: [{
        id: 'T1', title: 'Do it', description: 'Do the thing described',
        agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
        files_hint: ['a.ts'], creates_files: [], acceptance_criteria: ['it works'], verification: ['npm test'],
      }] }) }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as any;
  return { host: `http://127.0.0.1:${port}`, prompts, close: () => new Promise<void>(r => server.close(() => r())) };
}

const base = {
  requirement: 'Do a thing', codebaseContext: '', memoryPatterns: '', featureHistory: '',
  repositoryFiles: new Set(['a.ts']),
};

describe('the planner is told who will execute the tasks', () => {
  it('adds the small-task constraint when workers are local', async () => {
    const o = await capturePrompt();
    try {
      await new LocalPlanner('m', o.host).generateBlueprint({ ...base, workerCapability: 'local' } as any);
      const p = o.prompts[0];
      // The plan that failed six times had a 6-file, 5-criterion, 486-char task.
      assert.match(p, /LOCAL WORKER CONSTRAINT/);
      assert.match(p, /At most 2 files/);
      assert.match(p, /One concern per task/);
      assert.match(p, /under 250 characters/);
    } finally { await o.close(); }
  });

  it('omits it for cloud workers, which do not need it', async () => {
    const o = await capturePrompt();
    try {
      await new LocalPlanner('m', o.host).generateBlueprint({ ...base, workerCapability: 'cloud' } as any);
      assert.doesNotMatch(o.prompts[0], /LOCAL WORKER CONSTRAINT/);
    } finally { await o.close(); }
  });

  it('omits it when capability is unknown', async () => {
    const o = await capturePrompt();
    try {
      await new LocalPlanner('m', o.host).generateBlueprint(base as any);
      assert.doesNotMatch(o.prompts[0], /LOCAL WORKER CONSTRAINT/);
    } finally { await o.close(); }
  });
});
