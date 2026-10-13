import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateBlueprint, OUTPUT_SCHEMA, type PlanningInput } from './Planner.js';

const input: PlanningInput = {
  requirement: '## Command Palette\nFix it.\n## Quality gates\nRun tests.',
  codebaseContext: '', memoryPatterns: '', featureHistory: '',
  repositoryFiles: new Set(['src/App.tsx', 'src/App.test.tsx']),
};

const valid = {
  feature: 'Palette repair',
  requirements_covered: ['Command Palette', 'Quality gates'],
  tasks: [{
    id: 'T001', title: 'Repair palette', description: 'Repair the palette integration safely.',
    agent_role: 'coder', phase: 1, dependencies: [], blockedBy: [],
    files_hint: ['src/App.tsx'], creates_files: [],
    acceptance_criteria: ['Ctrl+K opens the palette'], verification: ['npm test -- --run'],
  }],
};

describe('planner semantic validation', () => {
  it('accepts a grounded plan with complete coverage', () => {
    assert.equal(validateBlueprint(valid, input).tasks.length, 1);
  });

  it('rejects invented files that are not declared new', () => {
    const plan = structuredClone(valid);
    plan.tasks[0].files_hint = ['src/useInvented.ts'];
    assert.throws(() => validateBlueprint(plan, input), /nonexistent file/);
  });

  it('accepts an existing directory as a scoped file hint', () => {
    const plan = structuredClone(valid);
    plan.tasks[0].files_hint = ['src'];
    assert.equal(validateBlueprint(plan, input).tasks[0].files_hint[0], 'src');
  });

  it('rejects omitted requirement areas', () => {
    const plan = structuredClone(valid);
    plan.requirements_covered = ['Command Palette'];
    assert.throws(() => validateBlueprint(plan, input), /Quality gates/);
  });

  it('rejects dependency cycles and same-phase file conflicts', () => {
    const plan = structuredClone(valid);
    plan.tasks.push({ ...structuredClone(plan.tasks[0]), id: 'T002', dependencies: ['T001'] });
    plan.tasks[0].dependencies = ['T002'];
    assert.throws(() => validateBlueprint(plan, input), /dependency cycle|file conflict/);
  });

  it('rejects unsupported Vitest discovery and repeat commands', () => {
    for (const verification of [
      ['npx vitest list'],
      ['npx vitest run src/App.test.tsx --repeat=2'],
    ]) {
      const plan = structuredClone(valid);
      plan.tasks[0].verification = verification;
      assert.throws(() => validateBlueprint(plan, input), /unsupported Vitest/);
    }
  });
});

describe('planner repair rounds are visible', () => {
  it('carries every earlier rejection into later repair prompts, so a fix does not reintroduce an old error', async () => {
    const { TextModelPlanner } = await import('./Planner.js');
    const npx = { ...valid, tasks: [{ ...valid.tasks[0], verification_command: 'npx vitest run src/App.test.tsx' }] };
    const piped = { ...valid, tasks: [{ ...valid.tasks[0], verification_command: 'npm test && echo ok' }] };
    const replies = [JSON.stringify(npx), JSON.stringify(piped), JSON.stringify(valid)];
    const prompts: string[] = [];
    const planner = new TextModelPlanner('deepseek', { provider: 'deepseek', model: 'm', isAvailable: async () => true, complete: async (prompt: string) => { prompts.push(prompt); return replies.shift()!; } } as any);
    await planner.generateBlueprint(input);
    assert.equal(prompts.length, 3);
    assert.doesNotMatch(prompts[1], /Earlier drafts were rejected/, 'the first repair has no history yet');
    assert.match(prompts[2], /Earlier drafts were rejected for these reasons too; do not reintroduce any of them:\n- T001 verification_command cannot run under the command policy \(npx/);
  });

  it('logs each rejected draft with the validator reasons, then accepts the repaired one', async () => {
    const { TextModelPlanner } = await import('./Planner.js');
    const invalid = { ...valid, tasks: [{ ...valid.tasks[0], files_hint: ['src/Nope.ts'], verification_command: 'node -r ./evil.js x.js' }] };
    const replies = [JSON.stringify(invalid), JSON.stringify(valid)];
    const lines: string[] = [];
    const planner = new TextModelPlanner('deepseek', { provider: 'deepseek', model: 'm', isAvailable: async () => true, complete: async () => replies.shift()! } as any);
    planner.log = line => lines.push(line);
    const blueprint = await planner.generateBlueprint(input);
    assert.equal(blueprint.tasks[0].files_hint[0], 'src/App.tsx');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /repair round 1 of 2/);
    assert.match(lines[0], /src\/Nope\.ts/);
    assert.match(lines[0], /preload flags may name an installed package/);
  });
});

describe('an unparsable planner reply is retried, not fatal', () => {
  it('asks once more for the complete object when a reply is cut off mid-description', async () => {
    const { TextModelPlanner } = await import('./Planner.js');
    const cutOff = JSON.stringify(valid).slice(0, 120);
    const replies = [cutOff, JSON.stringify(valid)];
    const prompts: string[] = [];
    const lines: string[] = [];
    const planner = new TextModelPlanner('deepseek', { provider: 'deepseek', model: 'm', isAvailable: async () => true, complete: async (prompt: string) => { prompts.push(prompt); return replies.shift()!; } } as any);
    planner.log = line => lines.push(line);
    const blueprint = await planner.generateBlueprint(input);
    assert.equal(blueprint.tasks.length, valid.tasks.length);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /YOUR PREVIOUS REPLY WAS NOT VALID JSON/);
    assert.match(lines[0], /not valid JSON/);
  });

  it('still fails when the retry is not JSON either', async () => {
    const { TextModelPlanner } = await import('./Planner.js');
    const planner = new TextModelPlanner('deepseek', { provider: 'deepseek', model: 'm', isAvailable: async () => true, complete: async () => '{"feature": "x", "tasks": [' } as any);
    await assert.rejects(() => planner.generateBlueprint(input), /Failed to parse JSON/);
  });

  it('DeepSeek reports a reply cut off at the output limit', async () => {
    const { DeepSeekTextModel } = await import('./TextModel.js');
    const saved = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'test-key';
    try {
      const model = new DeepSeekTextModel('deepseek-v4-pro', (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"feature": "x"' }, finish_reason: 'length' }] }), { status: 200 })) as any);
      await assert.rejects(() => model.complete('plan', { json: true }), /cut off at the output limit/);
    } finally {
      if (saved === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved;
    }
  });
});

describe('a task that changes no files is not worker work', () => {
  it('rejects "run the test suite" tasks and tells the planner where the command belongs', () => {
    const runOnly = { ...valid, tasks: [valid.tasks[0], { ...valid.tasks[0], id: 'T002', title: 'Run full test suite', dependencies: ['T001'], phase: 2, files_hint: [], creates_files: [], verification_command: 'npm test' }] };
    assert.throws(() => validateBlueprint(runOnly, input), /T002 changes no files.*verification_command/);
    const manual = { ...runOnly, tasks: [runOnly.tasks[0], { ...runOnly.tasks[1], executor: 'orchestrator' }] };
    assert.doesNotThrow(() => validateBlueprint(manual, input), 'operator work legitimately changes no repository files');
  });
});

describe('OUTPUT_SCHEMA', () => {
  // Codex --output-schema uses OpenAI strict mode, which rejects a schema whose
  // `required` omits any property ("Missing 'brief'", 2026-10-10).
  it('lists every property as required, at the top level and per task', () => {
    const task = OUTPUT_SCHEMA.properties.tasks.items;
    assert.deepEqual([...OUTPUT_SCHEMA.required].sort(), Object.keys(OUTPUT_SCHEMA.properties).sort());
    assert.deepEqual([...task.required].sort(), Object.keys(task.properties).sort());
    const source = OUTPUT_SCHEMA.properties.external_sources.items;
    assert.deepEqual([...source.required].sort(), Object.keys(source.properties).sort());
  });
});

describe('external sources in a blueprint', () => {
  it('defaults to none, and normalises method and expect', () => {
    assert.deepEqual(validateBlueprint(structuredClone(valid), input).external_sources, []);
    const plan = { ...structuredClone(valid), external_sources: [{ name: 'bom-rates', url: 'https://www.mongolbank.mn/en/currency-rates/data?startDate=2026-10-01&endDate=2026-10-12', method: 'post', expect: 'yaml', purpose: 'daily rates' }] };
    const [source] = validateBlueprint(plan, input).external_sources;
    assert.equal(source.method, 'POST');
    assert.equal(source.expect, 'any');
  });

  it('rejects a source without a usable url', () => {
    const plan = { ...structuredClone(valid), external_sources: [{ name: 'rates', url: 'mongolbank rates page', method: 'GET', expect: 'html', purpose: '' }] };
    assert.throws(() => validateBlueprint(plan, input));
  });
});

describe('a test writer may only be given test files', () => {
  it('rejects a test_writer whose files include source, as the runtime would on every attempt', () => {
    const plan = structuredClone(valid);
    plan.tasks.push({ ...structuredClone(plan.tasks[0]), id: 'T009', agent_role: 'test_writer', dependencies: ['T001'], files_hint: ['src/Uat.ts'], creates_files: ['src/UatSuites.test.ts'], production_targets: ['src/Uat.ts'], test_targets: ['src/UatSuites.test.ts'] });
    assert.throws(() => validateBlueprint(plan, input), /T009 is a test_writer but lists source files it may not change: src\/Uat\.ts/);
    plan.tasks[plan.tasks.length - 1].files_hint = ['src/UatSuites.test.ts'];
    assert.doesNotThrow(() => validateBlueprint(plan, input));
  });
});

describe('the planner proposes the live check (uat)', () => {
  it('parses a blueprint carrying uat and keeps its probes and setup', () => {
    const plan = {
      ...structuredClone(valid),
      uat: {
        setup: ['npm run build', 'PORT=4123 node dist/server.js >/tmp/server.log 2>&1 & sleep 2'],
        probes: [{ name: 'latest rates', run: "curl -fsS 'http://localhost:4123/rates/latest'", expect: '\\[\\s*\\{[^\\]]*"currency"' }],
      },
    };
    const blueprint = validateBlueprint(plan, input);
    assert.equal(blueprint.uat?.setup.length, 2);
    assert.equal(blueprint.uat?.probes.length, 1);
    assert.equal(blueprint.uat?.probes[0].name, 'latest rates');
    assert.equal(blueprint.uat?.probes[0].run, "curl -fsS 'http://localhost:4123/rates/latest'");
    assert.equal(blueprint.uat?.probes[0].expect, '\\[\\s*\\{[^\\]]*"currency"');
  });

  it('leaves uat undefined when a library has nothing to run', () => {
    assert.equal(validateBlueprint(structuredClone(valid), input).uat, undefined);
  });

  it('rejects a probe without run', () => {
    const plan = {
      ...structuredClone(valid),
      uat: { setup: ['npm start'], probes: [{ name: 'latest rates' }] },
    };
    assert.throws(() => validateBlueprint(plan, input));
  });

  it('lists uat in the structured-output schema, with every probe property required', () => {
    const uat = OUTPUT_SCHEMA.properties.uat;
    assert.ok(uat, 'the structured-output schema must carry uat');
    assert.ok(OUTPUT_SCHEMA.required.includes('uat'));
    const probe = uat.properties.probes.items;
    assert.deepEqual([...probe.required].sort(), Object.keys(probe.properties).sort());
    assert.deepEqual([...uat.required].sort(), Object.keys(uat.properties).sort());
  });

  it('tells the planner how to write the live check', async () => {
    const { TextModelPlanner } = await import('./Planner.js');
    const prompts: string[] = [];
    const planner = new TextModelPlanner('deepseek', { provider: 'deepseek', model: 'm', isAvailable: async () => true, complete: async (prompt: string) => { prompts.push(prompt); return JSON.stringify(valid); } } as any);
    await planner.generateBlueprint(input);
    assert.match(prompts[0], /uat: when the feature is a service, CLI or job/);
    assert.match(prompts[0], /Background the server in setup and wait for its port/);
    assert.match(prompts[0], /REAL data/);
    assert.match(prompts[0], /Leave uat out only for a library/);
  });
});

