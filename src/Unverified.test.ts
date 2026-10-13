import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { unverifiedAssumptions } from './Unverified.js';
import { Factory } from './Factory.js';
import { buildPullRequestBody } from './PullRequest.js';
import type { Task } from './types.js';

const diffAdding = (file: string, ...lines: string[]) =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -1,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`)].join('\n');

const MONGOLBANK = diffAdding('app/parser.py', '    response = requests.get("https://www.mongolbank.mn/en/rates", timeout=5)');

describe('what a run assumed but never verified', () => {
  it('names an outside URL the shipped code calls that no probe fetched', () => {
    const lines = unverifiedAssumptions({ state: {}, runNotes: [], mergedDiff: MONGOLBANK });
    assert.deepEqual(lines, ['calls https://www.mongolbank.mn/en/rates, never fetched during planning']);
  });

  it('says nothing about a host an ok probe covered', () => {
    const state = { external_sources: [{ name: 'bom', url: 'https://www.mongolbank.mn/en/currency-rates/data', ok: true, status: 200 }] };
    assert.deepEqual(unverifiedAssumptions({ state, runNotes: [], mergedDiff: MONGOLBANK }), []);
  });

  it('ignores URLs in tests, docs, comments, lock files and local servers', () => {
    const diff = [
      diffAdding('tests/test_parser.py', 'URL = "https://www.mongolbank.mn/en/rates"'),
      diffAdding('README.md', 'See https://www.mongolbank.mn/en/currency-rates'),
      diffAdding('app/main.py', '# docs: https://fastapi.tiangolo.com/', 'BASE = "http://localhost:8000"'),
      diffAdding('package-lock.json', '"resolved": "https://registry.npmjs.org/x/-/x-1.0.0.tgz",'),
    ].join('\n');
    assert.deepEqual(unverifiedAssumptions({ state: {}, runNotes: [], mergedDiff: diff }), []);
  });

  it('reports a missing live check', () => {
    assert.deepEqual(unverifiedAssumptions({ state: { uat_result: 'none', verified: false }, runNotes: [], mergedDiff: '' }), ['no live check ran (uat: none)']);
    assert.deepEqual(unverifiedAssumptions({ state: { uat_result: 'passed', verified: true }, runNotes: [], mergedDiff: '' }), []);
  });

  it('lists unverified claims, unprobed fixtures and swallowed errors once each, after the URL and live-check lines', () => {
    const runNotes = [
      { taskId: 'T1', note: 'unverified claim: the page lists every currency' },
      { taskId: 'T2', note: 'unverified claim: the page lists every currency' },
      { taskId: 'T3', note: 'unprobed fixture: tests/fixtures/bom_latest.html' },
      { taskId: 'T5', note: 'swallowed error: app/main.py:72 — except Exception:' },
      { taskId: 'T5', note: 'From T1 earlier in this run: something else' },
    ];
    const lines = unverifiedAssumptions({ state: { uat_result: 'none' }, runNotes, mergedDiff: MONGOLBANK });
    assert.deepEqual(lines, [
      'calls https://www.mongolbank.mn/en/rates, never fetched during planning',
      'no live check ran (uat: none)',
      'unverified claim: the page lists every currency',
      'unprobed fixture: tests/fixtures/bom_latest.html',
      'swallowed error: app/main.py:72 — except Exception:',
    ]);
  });

  it('caps the list at 15 lines', () => {
    const runNotes = Array.from({ length: 20 }, (_, i) => ({ taskId: 'T1', note: `unverified claim: number ${i}` }));
    const lines = unverifiedAssumptions({ state: {}, runNotes, mergedDiff: '' });
    assert.equal(lines.length, 16);
    assert.equal(lines[15], '… and 5 more');
  });
});

describe('a completed run reports what it never verified', () => {
  it('logs the block, stores state.unverified and counts it in the history', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-unverified-'));
    await fs.mkdir(path.join(baseDir, '.softfactory'), { recursive: true });
    const factory: any = new Factory(baseDir, '', { strategy: 'local', sandbox: 'none' });
    factory.state = { feature_id: 'f-1', feature: 'rates', status: 'completed', strategy: 'local', cloud_provider: 'agy', planner_provider: 'local',
      created_at: '', last_updated: '', tasks: [] as Task[], memory_patterns: [], uat_result: 'none', verified: false };
    factory.addRunNote('T3', 'unprobed fixture: tests/fixtures/bom_latest.html');
    const logs: string[] = [];
    factory.on('log', (l: string) => logs.push(l));
    await factory.recordUnverified();
    factory.logUnverified();
    assert.deepEqual(factory.state.unverified, ['no live check ran (uat: none)', 'unprobed fixture: tests/fixtures/bom_latest.html']);
    assert.ok(logs.includes('UNVERIFIED ASSUMPTIONS (2):'), logs.join('\n'));
    assert.ok(logs.includes('  - no live check ran (uat: none)'));
    const history = JSON.parse(await fs.readFile(path.join(baseDir, '.softfactory', 'history.json'), 'utf8'));
    assert.equal(history.features[0].unverified, 2);
  });

  it('puts the list in the pull request body', async () => {
    const state: any = { feature: 'rates', status: 'completed', tasks: [], integration_branch: 'softfactory/f-1', unverified: ['no live check ran (uat: none)'] };
    const body = await buildPullRequestBody({ state, baseDir: os.tmpdir(), baseBranch: 'main', sandbox: 'none', generator: 'test' } as any);
    assert.match(body, /### Unverified assumptions\n\n- no live check ran \(uat: none\)/);
  });
});
