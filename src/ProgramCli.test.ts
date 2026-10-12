import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { saveProgram, defaultProgram, PROGRAM_FILE, type Context } from './Program.js';

/** The repository root, resolved from this file so the temp cwd does not matter. */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(repoRoot, 'src', 'index.ts');

/** Temporary repos live under the package root so `--import tsx` resolves like a real run. */
const tempDirs: string[] = [];
async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(repoRoot, '.program-cli-'));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** Spawn the CLI inside the temp repo the same way the acceptance command does. */
function softfactory(cwd: string, args: string[]) {
  return execa('node', ['--import', 'tsx', cli, ...args], { cwd, reject: false });
}

describe('softfactory program init', () => {
  it('writes the skeleton file and a second init refuses', async () => {
    const repo = await makeRepo();

    const first = await softfactory(repo, ['program', 'init', 'Ship the rates service']);

    assert.equal(first.exitCode, 0, first.stderr);
    assert.match(first.stdout, /wrote\s+\.softfactory\/program\.json/);
    const program = JSON.parse(await fs.readFile(path.join(repo, PROGRAM_FILE), 'utf8'));
    assert.equal(program.goal, 'Ship the rates service');
    assert.deepEqual(program.contexts, []);
    assert.deepEqual(program.history, []);

    const second = await softfactory(repo, ['program', 'init', 'Another goal']);

    assert.equal(second.exitCode, 1);
    assert.match(second.stderr, /already exists; refusing to overwrite it/);
    const after = JSON.parse(await fs.readFile(path.join(repo, PROGRAM_FILE), 'utf8'));
    assert.equal(after.goal, 'Ship the rates service', 'the first goal must not be overwritten');
  });
});

describe('softfactory program status', () => {
  it('prints one line per context with id, status, size, depends_on and readiness', async () => {
    const repo = await makeRepo();
    const program = defaultProgram('Ship the rates service');
    const contexts: Context[] = [
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
      {
        id: 'worker',
        goal: 'Background jobs',
        scope: ['jobs/**'],
        depends_on: ['api'],
        size: 's',
        slices: [],
        status: 'done',
        feature_id: 'f-1',
        pr: 42,
        parked_reason: null,
        slice_index: 0,
      },
      {
        id: 'cutover',
        goal: 'Switch traffic',
        scope: ['ops/**'],
        depends_on: ['web', 'worker'],
        size: 'xl',
        slices: [],
        status: 'parked',
        feature_id: null,
        pr: null,
        parked_reason: 'needs approval',
        slice_index: 0,
      },
    ];
    program.contexts = contexts;
    await saveProgram(repo, program);

    const result = await softfactory(repo, ['program', 'status']);

    assert.equal(result.exitCode, 0, result.stderr);
    const lines = result.stdout.split('\n').filter(Boolean);
    // A ready context prints the readiness check.
    assert.match(lines.find(line => line.startsWith('  api ')) ?? '', /✓ ready/);
    // A blocked dependency prints the exact reason from Program.readiness.
    assert.match(lines.find(line => line.startsWith('  web ')) ?? '', /waits on api/);
    assert.deepEqual(lines, [
      'Program: Ship the rates service',
      '  api  pending  m  [-]  ✓ ready',
      '  web  pending  l  [api]  waits on api',
      '  worker  done  s  [api]  done',
      '  cutover  parked  xl  [web, worker]  parked: needs approval',
    ]);
  });

  it('reads the archive to decide a dependency is done when policy.pr is false', async () => {
    const repo = await makeRepo();
    const program = defaultProgram('Ship the rates service');
    program.policy.pr = false;
    program.contexts = [
      {
        id: 'worker',
        goal: 'Background jobs',
        scope: ['jobs/**'],
        depends_on: [],
        size: 'm',
        slices: [],
        // Its run finished but the program was not updated yet: the archive decides.
        status: 'active',
        feature_id: 'f-1',
        pr: null,
        parked_reason: null,
        slice_index: 0,
      },
      {
        id: 'web',
        goal: 'Dashboard for the rates',
        scope: ['web/**'],
        depends_on: ['worker'],
        size: 'm',
        slices: [],
        status: 'pending',
        feature_id: null,
        pr: null,
        parked_reason: null,
        slice_index: 0,
      },
    ];
    await saveProgram(repo, program);
    const archive = path.join(repo, '.softfactory', 'archive');
    await fs.mkdir(archive, { recursive: true });

    // A failed archive is not done: the dependency still blocks with its reason.
    await fs.writeFile(path.join(archive, 'f-1.json'), JSON.stringify({ status: 'failed', pr: null }));
    const blocked = await softfactory(repo, ['program', 'status']);
    assert.equal(blocked.exitCode, 0, blocked.stderr);
    assert.match(blocked.stdout.split('\n').find(line => line.startsWith('  web ')) ?? '', /waits on worker/);

    // A completed archive with no PR is done: the dependent context is ready.
    await fs.writeFile(path.join(archive, 'f-1.json'), JSON.stringify({ status: 'completed', pr: null }));
    const ready = await softfactory(repo, ['program', 'status']);
    assert.equal(ready.exitCode, 0, ready.stderr);
    assert.match(ready.stdout.split('\n').find(line => line.startsWith('  web ')) ?? '', /✓ ready/);
  });

  it('says how to start when there is no program file', async () => {
    const repo = await makeRepo();
    const result = await softfactory(repo, ['program', 'status']);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /No program: run 'softfactory program init/);
  });

  it('names the invalid field of a hand-edited program.json instead of a stack trace', async () => {
    const repo = await makeRepo();
    await fs.mkdir(path.join(repo, '.softfactory'), { recursive: true });
    await fs.writeFile(path.join(repo, PROGRAM_FILE), JSON.stringify({
      goal: 'g',
      contexts: [{ id: 'web', scope: ['web/**'], depends_on: ['api'] }],
    }));
    const result = await softfactory(repo, ['program', 'status']);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /program\.json: contexts\.0\.depends_on: unknown depends_on id "api"/);
    assert.doesNotMatch(result.stderr, /at .*\.ts:\d+/);
  });
});
