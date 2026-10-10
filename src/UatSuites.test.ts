import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runUat, UatSchema, type ShellRunner } from './Uat.js';

/**
 * Release 6.0 "stack hygiene": in Softhouse's field runs a passing suite wedged
 * the stack for the next one, and legacy suites that are allowed to fail were
 * run after the gating ones. UAT suites are therefore ordered non-gating first,
 * and `rebuild_between` re-runs the build between them.
 */

describe('ordered UAT suites', () => {
  it('runs a non-gating suite listed after a gating one first, then the gating ones in file order', async () => {
    const calls: string[] = [];
    const shell: ShellRunner = async command => { calls.push(command); return { exitCode: 0, output: 'ok' }; };
    const config = UatSchema.parse({
      suites: [
        { name: 'gating-first', commands: ['gate-a'], gating: true },
        { name: 'legacy', commands: ['legacy-a'], gating: false },
        { name: 'gating-second', commands: ['gate-b'], gating: true },
      ],
    });
    const result = await runUat('/tmp', config, { runId: 'r', featureId: 'f', shell });
    assert.deepEqual(calls, ['legacy-a', 'gate-a', 'gate-b'], 'non-gating first, then gating in file order');
    assert.deepEqual(result.steps.map(s => s.name), ['suite legacy: legacy-a', 'suite gating-first: gate-a', 'suite gating-second: gate-b']);
    assert.equal(result.passed, true);
  });

  it('records a failing non-gating suite with a "non-gating suite failed:" detail but does not fail UAT', async () => {
    const shell: ShellRunner = async command => command === 'legacy-bad' ? { exitCode: 1, output: 'boom' } : { exitCode: 0, output: 'ok' };
    const config = UatSchema.parse({
      suites: [
        { name: 'gating', commands: ['gate-ok'] },
        { name: 'legacy', commands: ['legacy-bad'], gating: false },
      ],
    });
    const result = await runUat('/tmp', config, { runId: 'r', featureId: 'f', shell });
    const step = result.steps.find(s => s.name === 'suite legacy: legacy-bad');
    assert.ok(step, 'the failed legacy suite is still recorded as a step');
    assert.equal(step!.passed, true, 'a non-gating failure is visible but not a fail');
    assert.match(step!.detail, /^non-gating suite failed:/);
    assert.equal(result.passed, true);
  });

  it('fails UAT when a gating suite command exits non-zero', async () => {
    const shell: ShellRunner = async () => ({ exitCode: 1, output: 'broken' });
    const config = UatSchema.parse({
      suites: [
        { name: 'legacy', commands: ['legacy-ok'], gating: false },
        { name: 'gating', commands: ['gate-bad'] },
      ],
    });
    const result = await runUat('/tmp', config, { runId: 'r', featureId: 'f', shell });
    const step = result.steps.find(s => s.name === 'suite gating: gate-bad');
    assert.equal(step!.passed, false);
    assert.equal(result.passed, false);
  });
});

describe('rebuild_between', () => {
  it('re-runs build between suites but never before the first', async () => {
    const calls: string[] = [];
    const shell: ShellRunner = async command => { calls.push(command); return { exitCode: 0, output: 'ok' }; };
    const config = UatSchema.parse({
      build: 'build-cmd',
      rebuild_between: true,
      suites: [
        { name: 'a', commands: ['a-cmd'] },
        { name: 'b', commands: ['b-cmd'] },
        { name: 'c', commands: ['c-cmd'] },
      ],
    });
    const result = await runUat('/tmp', config, { runId: 'r', featureId: 'f', shell });
    assert.deepEqual(calls, ['build-cmd', 'a-cmd', 'build-cmd', 'b-cmd', 'build-cmd', 'c-cmd']);
    assert.equal(calls.filter(c => c === 'build-cmd').length, 3, 'the initial build plus one rebuild per later suite');
    assert.deepEqual(result.steps.map(s => s.name), ['build', 'suite a: a-cmd', 'rebuild before b', 'suite b: b-cmd', 'rebuild before c', 'suite c: c-cmd']);
    assert.equal(result.steps.some(s => s.name === 'rebuild before a'), false, 'nothing is rebuilt before the first suite');
    assert.equal(result.passed, true);
  });

  it('fails UAT when a rebuild exits non-zero and does not run the suite it guards', async () => {
    const calls: string[] = [];
    let buildCalls = 0;
    const shell: ShellRunner = async command => {
      calls.push(command);
      if (command !== 'build-cmd') return { exitCode: 0, output: 'ok' };
      return { exitCode: ++buildCalls === 1 ? 0 : 1, output: 'rebuild broke' };
    };
    const config = UatSchema.parse({
      build: 'build-cmd',
      rebuild_between: true,
      suites: [
        { name: 'a', commands: ['a-cmd'] },
        { name: 'b', commands: ['b-cmd'] },
      ],
    });
    const result = await runUat('/tmp', config, { runId: 'r', featureId: 'f', shell });
    const rebuild = result.steps.find(s => s.name === 'rebuild before b');
    assert.ok(rebuild, 'the rebuild is recorded as a step');
    assert.equal(rebuild!.passed, false);
    assert.equal(result.passed, false);
    assert.deepEqual(calls, ['build-cmd', 'a-cmd', 'build-cmd'], 'the guarded suite never runs after a failed rebuild');
  });
});
