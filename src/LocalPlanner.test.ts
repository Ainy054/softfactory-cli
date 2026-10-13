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

  it('fits the repository context to the model window instead of letting the rules be truncated', async () => {
    const previous = process.env.SOFTFACTORY_LOCAL_NUM_CTX;
    // Large enough for the planning rules, small enough to force truncation.
    process.env.SOFTFACTORY_LOCAL_NUM_CTX = '3072';
    const ollama = await fakeOllama([goodPlan]);
    try {
      // Ollama drops the FRONT of an oversized prompt, where the rules are.
      const huge = { ...input, codebaseContext: `Tracked Files:\n${'src/file.ts\n'.repeat(5000)}` };
      await new LocalPlanner('m', ollama.host).generateBlueprint(huge as any);
      const p = ollama.prompts[0];
      assert.ok(p.length <= 3072 * 2.5 + 200, `prompt is ${p.length} chars for a 3072-token window`);
      assert.match(p, /Planning rules:/);
      assert.match(p, /User Requirement:\nAdd a formatCurrency helper/);
      assert.match(p, /repository context truncated/);
    } finally {
      await ollama.close();
      if (previous === undefined) delete process.env.SOFTFACTORY_LOCAL_NUM_CTX; else process.env.SOFTFACTORY_LOCAL_NUM_CTX = previous;
    }
  });
});

describe('every planner validates a refinement like a plan', () => {
  const doneTask: any = {
    id: 'T1', title: 'Add helper', description: 'Add formatCurrency to the utils module', agent_role: 'coder',
    phase: 1, dependencies: [], blockedBy: [], files_hint: ['frontend/src/utils/currency.ts'], creates_files: [],
    acceptance_criteria: ['formatCurrency returns a USD string'], verification: ['npm test --prefix frontend'],
    status: 'done', attempts: 1, escalation_level: 0, error_history: [], worker_type: 'auto',
  };
  const refinedPlan = JSON.stringify({
    feature: 'Currency helper', requirements_covered: [],
    tasks: [
      { ...doneTask, status: undefined },
      { id: 'T2', title: 'Add EUR support', description: 'Extend formatCurrency with a EUR branch', agent_role: 'coder',
        phase: 2, dependencies: ['T1'], blockedBy: [], files_hint: ['frontend/src/utils/currency.ts'], creates_files: [],
        acceptance_criteria: ['formatCurrency formats EUR'], verification: ['npm test --prefix frontend'] },
    ],
  });

  it('tells the model to keep done tasks and returns the validated full plan', async () => {
    const ollama = await fakeOllama([refinedPlan]);
    try {
      const plan = await new LocalPlanner('m', ollama.host).refineBlueprint({
        refinement: 'also support EUR', currentTasks: [doneTask], codebaseContext: '',
        repositoryFiles: new Set(['frontend/src/utils/currency.ts']),
      });
      assert.equal(plan.tasks.length, 2);
      assert.match(ollama.prompts[0], /status "done" are already merged/);
      assert.match(ollama.prompts[0], /"id": "T1"/);
    } finally { await ollama.close(); }
  });

  it('rejects a refinement that invents a file, through the same repair loop', async () => {
    const invented = JSON.parse(refinedPlan);
    invented.tasks[1].files_hint = ['frontend/src/utils/euro.ts'];
    const ollama = await fakeOllama([JSON.stringify(invented), refinedPlan]);
    try {
      const plan = await new LocalPlanner('m', ollama.host).refineBlueprint({
        refinement: 'also support EUR', currentTasks: [doneTask], codebaseContext: '',
        repositoryFiles: new Set(['frontend/src/utils/currency.ts']),
      });
      assert.equal(plan.tasks.length, 2);
      assert.equal(ollama.prompts.length, 2);
      assert.match(ollama.prompts[1], /nonexistent file frontend\/src\/utils\/euro\.ts/);
    } finally { await ollama.close(); }
  });
});

describe('the Antigravity planner uses the shared prompt and repair loop', () => {
  it('states the schema and repairs a wrong-shaped first answer', async () => {
    const { TextModelPlanner } = await import('./Planner.js');
    const prompts: string[] = [];
    const replies = [JSON.stringify({ plan: 'wrong shape' }), goodPlan];
    const planner = new TextModelPlanner('agy', {
      provider: 'agy', model: 'Gemini 3.1 Pro (High)', isAvailable: async () => true,
      complete: async (prompt: string) => { prompts.push(prompt); return replies[Math.min(prompts.length - 1, replies.length - 1)]; },
    });
    const plan = await planner.generateBlueprint(input as any);
    assert.equal(plan.tasks.length, 1);
    assert.equal(prompts.length, 2, 'one attempt plus one repair');
    // The old Antigravity prompt asked for a shape without acceptance
    // criteria, which the validator then rejected with no second chance.
    assert.match(prompts[0], /acceptance_criteria/);
    assert.match(prompts[0], /Planning rules:/);
    assert.doesNotMatch(prompts[0], /DEVOPS FIRST/);
  });
});

describe('planning calls get the planner timeout, not the worker turn default', () => {
  it('passes 15 minutes by default and honours SOFTFACTORY_PLANNER_TIMEOUT_MS', async () => {
    const { TextModelPlanner } = await import('./Planner.js');
    const timeouts: Array<number | undefined> = [];
    const planner = new TextModelPlanner('agy', {
      provider: 'agy', model: 'Gemini 3.1 Pro (High)', isAvailable: async () => true,
      complete: async (_prompt: string, options: any = {}) => { timeouts.push(options.timeoutMs); return goodPlan; },
    });
    const saved = process.env.SOFTFACTORY_PLANNER_TIMEOUT_MS;
    try {
      delete process.env.SOFTFACTORY_PLANNER_TIMEOUT_MS;
      await planner.generateBlueprint(input as any);
      process.env.SOFTFACTORY_PLANNER_TIMEOUT_MS = '1200000';
      await planner.generateBlueprint(input as any);
    } finally {
      if (saved === undefined) delete process.env.SOFTFACTORY_PLANNER_TIMEOUT_MS;
      else process.env.SOFTFACTORY_PLANNER_TIMEOUT_MS = saved;
    }
    assert.deepEqual(timeouts, [15 * 60_000, 1_200_000]);
  });
});
