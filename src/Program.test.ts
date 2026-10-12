import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  loadProgram,
  saveProgram,
  stopProgram,
  resumeProgram,
  defaultProgram,
  ProgramSchema,
  PROGRAM_FILE,
  STOPPED_FILE,
  type Program,
} from './Program.js';

/** Every temporary directory this file creates, removed once the suite ends. */
const tempDirs: string[] = [];
async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-program-'));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** A fully populated program with one ready and one blocked context. */
function sampleProgram(goal = 'Ship the rates service'): Program {
  return {
    goal,
    contexts: [
      {
        id: 'api',
        goal: 'FastAPI app with /rates',
        scope: ['app/**', 'tests/**'],
        depends_on: [],
        size: 'm',
        slices: [],
        status: 'pending',
        feature_id: null,
        pr: null,
        parked_reason: null,
        slice_index: 0,
      },
      {
        id: 'web',
        goal: 'Dashboard for the rates',
        scope: ['web/**'],
        depends_on: ['api'],
        size: 'l',
        slices: [],
        status: 'pending',
        feature_id: null,
        pr: null,
        parked_reason: null,
        slice_index: 0,
      },
    ],
    policy: defaultProgram().policy,
    history: [],
  };
}

describe('Program save/load round trip', () => {
  it('writes program.json and loads an equal program', async () => {
    const baseDir = await makeDir();
    const program = sampleProgram();

    await saveProgram(baseDir, program);

    assert.deepEqual(await loadProgram(baseDir), program);
    const onDisk = JSON.parse(await fs.readFile(path.join(baseDir, PROGRAM_FILE), 'utf8'));
    assert.deepEqual(onDisk, program);
  });

  it('keeps the advance fields of a history entry (commits, tokens) and slice text', async () => {
    const baseDir = await makeDir();
    const program = sampleProgram();
    program.contexts[0].slices = ['models and storage', 'routes'];
    program.history.push({ at: '2026-10-12T00:00:00.000Z', context: program.contexts[0].id, action: 'started', feature_id: 'f-1', result: 'completed', commits: 3, tokens: 812000 });

    await saveProgram(baseDir, program);

    assert.deepEqual(await loadProgram(baseDir), program);
  });

  it('returns the default skeleton when program.json is missing', async () => {
    const baseDir = await makeDir();

    assert.deepEqual(await loadProgram(baseDir), defaultProgram());
  });
});

/** Parse a raw program and assert it fails with exactly one named issue. */
function expectProgramError(raw: unknown, message: string, path: (string | number)[]): void {
  assert.throws(
    () => ProgramSchema.parse(raw),
    (error: any) => {
      assert.ok(Array.isArray(error?.issues), `expected a ZodError, got ${error}`);
      assert.equal(error.issues.length, 1, JSON.stringify(error.issues));
      assert.equal(error.issues[0].message, message);
      assert.deepEqual(error.issues[0].path, path);
      return true;
    },
  );
}

describe('Program validation errors', () => {
  it('names an unknown depends_on id', () => {
    expectProgramError(
      {
        goal: '',
        contexts: [{ id: 'api', scope: ['app/**'], depends_on: ['ghost'] }],
        policy: defaultProgram().policy,
        history: [],
      },
      'unknown depends_on id "ghost"',
      ['contexts', 0, 'depends_on'],
    );
  });

  it('names a dependency cycle in depends_on', () => {
    expectProgramError(
      {
        goal: '',
        contexts: [
          { id: 'a', scope: ['a/**'], depends_on: ['b'] },
          { id: 'b', scope: ['b/**'], depends_on: ['a'] },
        ],
        policy: defaultProgram().policy,
        history: [],
      },
      'dependency cycle in depends_on: a -> b -> a',
      ['contexts'],
    );
  });

  it('names a duplicate context id', () => {
    expectProgramError(
      {
        goal: '',
        contexts: [
          { id: 'api', scope: ['app/**'] },
          { id: 'api', scope: ['lib/**'] },
        ],
        policy: defaultProgram().policy,
        history: [],
      },
      'duplicate context id "api"',
      ['contexts', 1, 'id'],
    );
  });

  it('names an empty scope', () => {
    expectProgramError(
      {
        goal: '',
        contexts: [{ id: 'api', scope: [] }],
        policy: defaultProgram().policy,
        history: [],
      },
      'scope must not be empty',
      ['contexts', 0, 'scope'],
    );
  });
});

describe('Program stop/resume', () => {
  it('stopProgram writes STOPPED and appends a stop history entry', async () => {
    const baseDir = await makeDir();
    await saveProgram(baseDir, defaultProgram('Ship the rates service'));

    const stopped = await stopProgram(baseDir, 'contract in cutover');

    const stoppedRaw = JSON.parse(await fs.readFile(path.join(baseDir, STOPPED_FILE), 'utf8'));
    assert.equal(stoppedRaw.reason, 'contract in cutover');
    assert.ok(stoppedRaw.at, 'STOPPED records the stop time');
    assert.equal(stopped.history.length, 1);
    assert.equal(stopped.history[0].context, 'program');
    assert.equal(stopped.history[0].action, 'stop');
    assert.equal(stopped.history[0].result, 'contract in cutover');
    assert.ok(stopped.history[0].at, 'history records the stop time');
    assert.equal((await loadProgram(baseDir)).history.length, 1);
  });

  it('resumeProgram removes STOPPED and appends a resume history entry', async () => {
    const baseDir = await makeDir();
    await stopProgram(baseDir, 'regulatory review');

    const resumed = await resumeProgram(baseDir);

    await assert.rejects(fs.access(path.join(baseDir, STOPPED_FILE)), /ENOENT/);
    assert.equal(resumed.history.length, 2);
    assert.equal(resumed.history[1].context, 'program');
    assert.equal(resumed.history[1].action, 'resume');
    assert.equal(resumed.history[1].result, 'resumed');
    assert.equal((await loadProgram(baseDir)).history.length, 2);
  });

  it('stopProgram without a reason stores null and "stopped"', async () => {
    const baseDir = await makeDir();

    const stopped = await stopProgram(baseDir);

    const stoppedRaw = JSON.parse(await fs.readFile(path.join(baseDir, STOPPED_FILE), 'utf8'));
    assert.equal(stoppedRaw.reason, null);
    assert.equal(stopped.history[0].result, 'stopped');
  });
});
