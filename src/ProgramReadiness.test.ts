import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  readiness,
  nextRequirement,
  loadProgram,
  saveProgram,
  defaultProgram,
  ProgramSchema,
  type Program,
  type Context,
  type Deps,
  type Policy,
} from './Program.js';

/** Every temporary directory this file creates, removed once the suite ends. */
const tempDirs: string[] = [];
async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-readiness-'));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** The injectable side effects readiness needs; every field defaults to "nothing happened". */
function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    archived: async () => null,
    prState: async () => 'OPEN',
    openGates: async () => [],
    ...overrides,
  };
}

/** A context input with the fields the schema would default; only id and scope are required here. */
type ContextInput = Pick<Context, 'id' | 'scope'> & Partial<Omit<Context, 'id' | 'scope'>>;

/** Build a validated program so every context carries the schema's defaults. */
function makeProgram(goal: string, contexts: ContextInput[], policy: Partial<Policy> = {}): Program {
  return ProgramSchema.parse({
    goal,
    contexts,
    policy: { ...defaultProgram().policy, ...policy },
    history: [],
  });
}

/** The readiness entry for one context, asserting it exists so callers can read `.ready`/`.reason`. */
async function entryFor(program: Program, id: string, deps: Deps) {
  const results = await readiness(program, deps);
  assert.equal(results.length, program.contexts.length, 'readiness reports one entry per context');
  const entry = results.find(candidate => candidate.id === id);
  assert.ok(entry, `readiness has an entry for "${id}"`);
  return entry;
}

describe('program readiness waits for dependency PRs', () => {
  it('waits while a dependency PR is open and is ready once it merges', async () => {
    const baseDir = await makeDir();
    await saveProgram(baseDir, makeProgram('Ship the rates service', [
      { id: 'api', goal: 'FastAPI app with /rates', scope: ['app/**', 'tests/**'], pr: 12 },
      { id: 'web', goal: 'Dashboard for the rates', scope: ['web/**'], depends_on: ['api'] },
    ]));
    const program = await loadProgram(baseDir);

    let state: 'OPEN' | 'MERGED' = 'OPEN';
    const seen: number[] = [];
    const deps = fakeDeps({ prState: async number => { seen.push(number); return state; } });

    const open = await entryFor(program, 'web', deps);
    assert.equal(open.ready, false);
    assert.equal(open.reason, 'waits on api (PR #12 open)');

    state = 'MERGED';
    const merged = await entryFor(program, 'web', deps);
    assert.equal(merged.ready, true);
    assert.equal(merged.reason, 'ready');
    assert.deepEqual(seen, [12, 12], 'the dependency PR number is what is looked up');

    // The dependency itself has no unmet dependencies, so it is ready throughout.
    const api = await entryFor(program, 'api', deps);
    assert.equal(api.ready, true);
  });
});

describe('program readiness and archived dependencies', () => {
  it('counts an archived completed dependency when policy.pr is false', async () => {
    const baseDir = await makeDir();
    await saveProgram(baseDir, makeProgram('Ship the rates service', [
      { id: 'api', goal: 'FastAPI app with /rates', scope: ['app/**'], feature_id: 'f-1' },
      { id: 'web', goal: 'Dashboard for the rates', scope: ['web/**'], depends_on: ['api'] },
    ], { pr: false }));
    const program = await loadProgram(baseDir);

    const asked: string[] = [];
    const archivedCompleted = await entryFor(program, 'web', fakeDeps({
      archived: async featureId => { asked.push(featureId); return { status: 'completed', pr: null }; },
    }));
    assert.equal(archivedCompleted.ready, true);
    assert.equal(archivedCompleted.reason, 'ready');
    assert.deepEqual(asked, ['f-1'], 'the context feature_id is what the archive is looked up by');
  });

  it('does not count a failed archive as done', async () => {
    const baseDir = await makeDir();
    await saveProgram(baseDir, makeProgram('Ship the rates service', [
      { id: 'api', goal: 'FastAPI app with /rates', scope: ['app/**'], feature_id: 'f-1' },
      { id: 'web', goal: 'Dashboard for the rates', scope: ['web/**'], depends_on: ['api'] },
    ], { pr: false }));
    const program = await loadProgram(baseDir);

    const failed = await entryFor(program, 'web', fakeDeps({
      archived: async () => ({ status: 'failed' }),
    }));
    assert.equal(failed.ready, false);
    assert.equal(failed.reason, 'waits on api');

    const missing = await entryFor(program, 'web', fakeDeps({ archived: async () => null }));
    assert.equal(missing.ready, false);
    assert.equal(missing.reason, 'waits on api');
  });

  it('ignores the archive when policy.pr is true', async () => {
    const baseDir = await makeDir();
    await saveProgram(baseDir, makeProgram('Ship the rates service', [
      { id: 'api', goal: 'FastAPI app with /rates', scope: ['app/**'], feature_id: 'f-1' },
      { id: 'web', goal: 'Dashboard for the rates', scope: ['web/**'], depends_on: ['api'] },
    ], { pr: true }));
    const program = await loadProgram(baseDir);

    const archived = await entryFor(program, 'web', fakeDeps({
      archived: async () => ({ status: 'completed', pr: null }),
    }));
    assert.equal(archived.ready, false);
    assert.equal(archived.reason, 'waits on api');
  });
});

describe('program readiness and slicing', () => {
  it('refuses an xl context without slices and accepts one with slices', async () => {
    const baseDir = await makeDir();
    await saveProgram(baseDir, makeProgram('Ship the rates service', [
      { id: 'migrate', goal: 'Move the database', scope: ['db/**', 'app/models/**'], size: 'xl' },
    ]));
    const program = await loadProgram(baseDir);

    const withoutSlices = await entryFor(program, 'migrate', fakeDeps());
    assert.equal(withoutSlices.ready, false);
    assert.equal(withoutSlices.reason, 'needs slices (size xl ≥ threshold l)');

    program.contexts[0].slices = ['models and storage', 'routes', 'reports', 'cutover'];
    program.contexts[0].slice_index = 1;
    await saveProgram(baseDir, program);
    const sliced = await loadProgram(baseDir);

    const withSlices = await entryFor(sliced, 'migrate', fakeDeps());
    assert.equal(withSlices.ready, true);
    assert.equal(withSlices.reason, 'ready');
  });

  it('nextRequirement names the current slice of N and the scope paths', async () => {
    const baseDir = await makeDir();
    await saveProgram(baseDir, makeProgram('Ship the rates service', [
      {
        id: 'migrate',
        goal: 'Move the database',
        scope: ['db/**', 'app/models/**'],
        size: 'xl',
        slices: ['models and storage', 'routes', 'reports', 'cutover'],
        slice_index: 1,
      },
    ]));
    const program = await loadProgram(baseDir);

    const requirement = nextRequirement(program, 'migrate');

    assert.match(requirement, /this is slice 2 of 4; earlier slices are merged/);
    assert.match(requirement, /change only files under: db\/\*\*, app\/models\/\*\*/);
    assert.match(requirement, /routes/, 'the current slice text is included');
    assert.match(requirement, /Move the database/);
    assert.match(requirement, /Ship the rates service/);

    // The first slice reports itself as 1 of N.
    program.contexts[0].slice_index = 0;
    assert.match(nextRequirement(program, 'migrate'), /this is slice 1 of 4/);
  });
});

describe('program readiness and always-stop gates', () => {
  it('is not ready when an open always-stop gate covers its scope', async () => {
    const baseDir = await makeDir();
    await saveProgram(baseDir, makeProgram('Ship the rates service', [
      { id: 'cutover', goal: 'Switch traffic', scope: ['ops/**'] },
    ]));
    const program = await loadProgram(baseDir);

    const blocked = await entryFor(program, 'cutover', fakeDeps({
      openGates: async () => [{ class: 'cutover', scope: ['ops/**'] }],
    }));
    assert.equal(blocked.ready, false);
    assert.equal(blocked.reason, 'open gate cutover covers scope');
  });

  it('is ready when the open gate class is not in always_stop', async () => {
    const baseDir = await makeDir();
    await saveProgram(baseDir, makeProgram('Ship the rates service', [
      { id: 'cutover', goal: 'Switch traffic', scope: ['ops/**'] },
    ]));
    const program = await loadProgram(baseDir);

    const ready = await entryFor(program, 'cutover', fakeDeps({
      openGates: async () => [{ class: 'lint', scope: ['ops/**'] }],
    }));
    assert.equal(ready.ready, true);
    assert.equal(ready.reason, 'ready');
  });

  it('is ready when a stopping gate is open but does not cover the scope', async () => {
    const baseDir = await makeDir();
    await saveProgram(baseDir, makeProgram('Ship the rates service', [
      { id: 'web', goal: 'Dashboard for the rates', scope: ['web/**'] },
    ]));
    const program = await loadProgram(baseDir);

    const ready = await entryFor(program, 'web', fakeDeps({
      openGates: async () => [{ class: 'regulatory', scope: ['ops/**'] }],
    }));
    assert.equal(ready.ready, true);
    assert.equal(ready.reason, 'ready');
  });
});
