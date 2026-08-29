import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { LocalPlanner } from './Planner.js';

/** Stands in for Ollama; records prompts and replays scripted responses. */
async function fakeOllama(responses: string[]) {
  const prompts: string[] = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      prompts.push(JSON.parse(body).prompt);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ response: responses[Math.min(i++, responses.length - 1)] }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as any;
  return { host: `http://127.0.0.1:${port}`, prompts, close: () => new Promise<void>(r => server.close(() => r())) };
}

const input = {
  requirement: 'Add a formatCurrency helper',
  codebaseContext: '', memoryPatterns: '', featureHistory: '',
  repositoryFiles: new Set(['frontend/src/utils/currency.ts']),
};

const goodPlan = JSON.stringify({
  feature: 'Currency helper',
  requirements_covered: [],
  tasks: [{
    id: 'T1', title: 'Add helper', description: 'Add formatCurrency to the utils module',
    agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
    files_hint: ['frontend/src/utils/currency.ts'], creates_files: [],
    acceptance_criteria: ['formatCurrency returns a USD string'],
    verification: ['npm test --prefix frontend'],
  }],
});

describe('LocalPlanner', () => {
  it('states the required JSON shape — format:json alone only guarantees valid JSON', async () => {
    const ollama = await fakeOllama([goodPlan]);
    try {
      await new LocalPlanner('m', ollama.host).generateBlueprint(input as any);
      const p = ollama.prompts[0];
      assert.match(p, /"feature"/);
      assert.match(p, /"tasks"/);
      assert.match(p, /acceptance_criteria/);
    } finally { await ollama.close(); }
  });

  it('repairs a wrong-shaped plan instead of failing the build', async () => {
    // What the model actually returned: valid JSON, wrong keys.
    const wrong = JSON.stringify({ plan: 'do the thing', steps: [] });
    const ollama = await fakeOllama([wrong, goodPlan]);
    try {
      const plan = await new LocalPlanner('m', ollama.host).generateBlueprint(input as any);
      assert.equal(plan.tasks.length, 1);
      assert.equal(ollama.prompts.length, 2, 'must retry once');
      assert.match(ollama.prompts[1], /previous plan was rejected/);
    } finally { await ollama.close(); }
  });

  it('gives up after the repair budget rather than looping', async () => {
    const ollama = await fakeOllama([JSON.stringify({ nope: true })]);
    try {
      await assert.rejects(() => new LocalPlanner('m', ollama.host).generateBlueprint(input as any));
      assert.equal(ollama.prompts.length, 3, 'one attempt plus two repairs');
    } finally { await ollama.close(); }
  });
});
