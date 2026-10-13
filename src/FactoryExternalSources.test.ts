import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import { Factory } from './Factory.js';

// #82: the mongolbank-rates run planned against https://www.mongolbank.mn/en/rates,
// which answers HTTP 200 with a "404 - Page Not Found" page. These tests pin
// that a plan's external sources are fetched before any task runs.

const SOFT_404 = '<!DOCTYPE html><html><head><title>404 - Page Not Found</title></head><body>' + 'x'.repeat(300) + '</body></html>';
const RATES = JSON.stringify({ success: true, data: [{ RATE_DATE: '2026-10-12', USD: '3,595.47' }] });

function fakeFetch(routes: Record<string, { status?: number; type: string; body: string }>): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1];
    if (!route) throw new Error(`no route for ${url}`);
    return new Response(route.body, { status: route.status ?? 200, headers: { 'content-type': route.type } });
  }) as typeof fetch;
}

async function repo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-sources-'));
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execa('git', ['config', 'user.email', 't@t'], { cwd: dir });
  await execa('git', ['config', 'user.name', 't'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), '# x\n');
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function factoryOn(dir: string): any {
  const f: any = new Factory(dir, '', { strategy: 'cloud', cloudProvider: 'deepseek', cloudModel: 'd', sandbox: 'none' });
  f.logs = [];
  f.on('log', (l: string) => f.logs.push(l));
  f.taskVerifier.runAcceptance = async (_dir: string, t: any) => ({ ran: true, passed: false, exitCode: 1, output: '', command: t.verification_command, unrunnable: false });
  return f;
}

const blueprint = (url: string, description = 'Parse the bom-rates response in src/rates.ts') => ({
  feature: 'Rates', requirements_covered: [],
  external_sources: [{ name: 'bom-rates', url, method: 'POST', expect: 'json', purpose: 'daily rates' }],
  tasks: [
    { id: 'T1', title: 'Parse rates', description, agent_role: 'coder', phase: 1, files_hint: ['src/rates.ts', 'src/rates.test.ts'], creates_files: ['src/rates.ts', 'src/rates.test.ts'], verification_command: 'node --test src/rates.test.ts' },
    { id: 'T2', title: 'Write docs', description: 'Document the CLI flags in the readme', agent_role: 'docs', phase: 1, files_hint: ['README.md'], verification_command: 'grep -q flags README.md' },
  ],
});

const planningInput = (requirement = 'Serve Bank of Mongolia rates') => ({ requirement, codebaseContext: '', memoryPatterns: '', featureHistory: '', repositoryFiles: new Set(['README.md']) });

describe('external sources are probed when the plan is prepared', () => {
  it('re-plans once with the reason when a source is a soft 404, then keeps the working source', async () => {
    const f = factoryOn(await repo());
    f.sourceFetch = fakeFetch({
      'https://www.mongolbank.mn/en/rates': { type: 'text/html', body: SOFT_404 },
      'https://www.mongolbank.mn/en/currency-rates/data': { type: 'application/json', body: RATES },
    });
    const requirements: string[] = [];
    f.planner = { provider: 'deepseek', generateBlueprint: async (input: any) => {
      requirements.push(input.requirement);
      return requirements.length === 1 ? blueprint('https://www.mongolbank.mn/en/rates') : blueprint('https://www.mongolbank.mn/en/currency-rates/data?startDate=2026-10-12&endDate=2026-10-12');
    } };
    const { tasks } = await f.planTasks(planningInput());
    assert.equal(requirements.length, 2);
    assert.match(requirements[1], /bom-rates https:\/\/www\.mongolbank\.mn\/en\/rates: .*404/i);
    assert.match(requirements[1], /Find the real endpoint the code calls; do not guess[\s\S]*only test data or an example is not a source/);
    assert.ok(tasks[0].notes_to_executor.some((n: string) => n.includes('tests/fixtures/sources/bom-rates.json')), 'the task that uses the source is told where its real response is');
    assert.ok(!tasks[1].notes_to_executor.some((n: string) => n.includes('bom-rates')), 'an unrelated task is not');
    const [summary] = f.plannedSourceSummaries();
    assert.deepEqual({ name: summary.name, ok: summary.ok, status: summary.status, path: summary.path, method: summary.method },
      { name: 'bom-rates', ok: true, status: 200, path: 'tests/fixtures/sources/bom-rates.json', method: 'POST' });
  });

  it('stops before any task when the second plan still depends on a source that does not answer', async () => {
    const f = factoryOn(await repo());
    f.sourceFetch = fakeFetch({ 'https://www.mongolbank.mn/en/rates': { type: 'text/html', body: SOFT_404 } });
    let calls = 0;
    f.planner = { provider: 'deepseek', generateBlueprint: async () => { calls++; return blueprint('https://www.mongolbank.mn/en/rates'); } };
    await assert.rejects(f.planTasks(planningInput()), /external sources do not answer[\s\S]*bom-rates https:\/\/www\.mongolbank\.mn\/en\/rates/);
    assert.equal(calls, 2);
  });

  it('reports a failing URL named in the requirement without rejecting, even when a task quotes it', async () => {
    const f = factoryOn(await repo());
    f.sourceFetch = fakeFetch({
      'https://claude.ai/code/session': { status: 403, type: 'text/html', body: 'forbidden' },
      'https://www.mongolbank.mn/en/currency-rates/data': { type: 'application/json', body: RATES },
    });
    const quoted = blueprint('https://www.mongolbank.mn/en/currency-rates/data', 'Read https://claude.ai/code/session_123 and parse it in src/rates.ts');
    f.planner = { provider: 'deepseek', generateBlueprint: async () => quoted };
    await f.planTasks(planningInput('Serve rates.\n\nhttps://claude.ai/code/session_123'));
    assert.ok(f.logs.some((l: string) => /requirement-1 GET https:\/\/claude\.ai\/code\/session_123 → NOT OK.*not gating/.test(l)), f.logs.join('\n'));
  });

  it('slugs a source name instead of rejecting the plan', async () => {
    const { validateBlueprint } = await import('./Planner.js');
    const plan = { feature: 'Rates', requirements_covered: [], external_sources: [{ name: 'mongolbank rates', url: 'https://www.mongolbank.mn/en/currency-rates/data', method: 'POST', expect: 'json', purpose: '' }],
      tasks: [{ id: 'T1', title: 'Parse rates', description: 'Parse the rates response', agent_role: 'coder', phase: 1, files_hint: ['README.md'], acceptance_criteria: ['parses'], verification: ['npm test'] }] };
    assert.equal(validateBlueprint(plan, planningInput() as any).external_sources[0].name, 'mongolbank-rates');
  });

  it('commits each ok source as a fixture on the merge target before the first task', async () => {
    const dir = await repo();
    const f = factoryOn(dir);
    f.sourceFetch = fakeFetch({ 'https://www.mongolbank.mn/en/currency-rates/data': { type: 'application/json', body: RATES } });
    f.planner = { provider: 'deepseek', generateBlueprint: async () => blueprint('https://www.mongolbank.mn/en/currency-rates/data') };
    await f.planTasks(planningInput());
    await f.commitSourceFixtures();
    assert.equal(await fs.readFile(path.join(dir, 'tests/fixtures/sources/bom-rates.json'), 'utf8'), RATES);
    const { stdout } = await execa('git', ['log', '--format=%s', '-1'], { cwd: dir });
    assert.equal(stdout, 'softfactory: probe bom-rates');
    await f.commitSourceFixtures();
    const count = await execa('git', ['rev-list', '--count', 'HEAD'], { cwd: dir });
    assert.equal(count.stdout.trim(), '2', 'committed once');
  });

  it('probes nothing for a plan with no outside sources', async () => {
    const f = factoryOn(await repo());
    f.sourceFetch = async () => { throw new Error('must not fetch'); };
    const plain = { ...blueprint('https://example.org'), external_sources: [] };
    f.planner = { provider: 'deepseek', generateBlueprint: async () => plain };
    await f.planTasks(planningInput());
    assert.equal(f.plannedSourceSummaries(), undefined);
  });

  it('does not gate on a requirement URL that only a test task quotes as test data', async () => {
    const f = factoryOn(await repo());
    f.sourceFetch = fakeFetch({ 'https://www.mongolbank.mn/en/rates': { type: 'text/html', body: SOFT_404 } });
    const plan = {
      feature: 'Report', requirements_covered: [], external_sources: [],
      tasks: [
        { id: 'T1', title: 'Report module', description: 'Add the unverified report to src/report.ts', agent_role: 'coder', phase: 1, files_hint: ['src/report.ts', 'src/report.test.ts'], creates_files: ['src/report.ts', 'src/report.test.ts'], verification_command: 'node --test src/report.test.ts' },
        { id: 'T2', title: 'Report tests', description: 'A diff adding requests.get("https://www.mongolbank.mn/en/rates") gives the never-fetched line', agent_role: 'test_writer', phase: 2, dependencies: ['T1'], files_hint: ['src/report.test.ts'], verification_command: 'node --test src/report.test.ts' },
      ],
    };
    f.planner = { provider: 'deepseek', generateBlueprint: async () => plan };
    await f.planTasks(planningInput('A diff adding requests.get("https://www.mongolbank.mn/en/rates") with no probes gives the line.'));
    assert.ok(f.logs.some((l: string) => /requirement-1 GET https:\/\/www\.mongolbank\.mn\/en\/rates → NOT OK.*not gating/.test(l)), f.logs.join('\n'));
  });
});
