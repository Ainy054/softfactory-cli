import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import { runUat, pythonEnvironment, UatSchema, type ShellRunner } from './Uat.js';

// mongolbank-rates: the planner's live check ran `python3 -m app.backfill` on
// a uv-managed host python that refuses installs and lacks `requests`.

const config = UatSchema.parse({ setup: ['python3 -m app.backfill'], probes: [{ name: 'latest', run: 'curl -fsS localhost:8000/rates/latest', expect: 'currency' }] });

async function project(files: Record<string, string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-uat-py-'));
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content);
  return dir;
}

describe('a Python live check runs in its own environment', () => {
  it('creates the environment first and puts it on PATH for setup and probes', async () => {
    const dir = await project({ 'requirements.txt': 'requests\n' });
    const seen: Array<{ command: string; path?: string }> = [];
    const shell: ShellRunner = async (command, { env }) => { seen.push({ command, path: env.PATH }); return { exitCode: 0, output: command.startsWith('curl') ? '[{"currency":"USD"}]' : '' }; };
    const venv = path.join(dir, '.softfactory', 'uat-venv');
    const result = await runUat(dir, config, { runId: 'r', featureId: 'f', shell, venvDir: venv });
    assert.equal(result.passed, true, JSON.stringify(result.steps));
    assert.equal(result.steps[0].name, 'python environment');
    assert.match(seen[0].command, /uv venv|python3 -m venv/);
    assert.match(seen[0].command, /-r requirements\.txt/);
    for (const later of seen.slice(1)) assert.ok(later.path?.startsWith(path.join(venv, 'bin')), later.command);
  });

  it('fails the live check, without running setup, when the environment cannot be built', async () => {
    const dir = await project({ 'requirements.txt': 'nonexistent-package\n' });
    const seen: string[] = [];
    const shell: ShellRunner = async command => { seen.push(command); return { exitCode: seen.length === 1 ? 1 : 0, output: 'No solution found' }; };
    const result = await runUat(dir, config, { runId: 'r', featureId: 'f', shell });
    assert.equal(result.passed, false);
    assert.equal(seen.length, 1, 'nothing ran after the failed environment');
    assert.match(result.steps[0].detail, /exit 1: .*No solution found/);
  });

  it('leaves a project without Python dependencies alone', async () => {
    assert.equal(await pythonEnvironment(await project({ 'package.json': '{}' }), '/tmp/v'), undefined);
    const pyproject = await pythonEnvironment(await project({ 'pyproject.toml': '[project]\nname="x"\n' }), '/tmp/v');
    assert.match(pyproject?.command ?? '', /-r pyproject\.toml|-e \./);
  });

  it('builds a real environment from an empty requirements file', async (t) => {
    if ((await execa('python3', ['--version'], { reject: false })).exitCode !== 0) return t.skip('no python3 here');
    const dir = await project({ 'requirements.txt': '' });
    const venv = path.join(dir, '.softfactory', 'uat-venv');
    const live = UatSchema.parse({ probes: [{ name: 'python is the environment\'s', run: 'python3 -c "import sys; print(sys.prefix)"', expect: 'uat-venv' }] });
    const result = await runUat(dir, live, { runId: 'r', featureId: 'f', venvDir: venv });
    assert.equal(result.passed, true, JSON.stringify(result.steps));
    assert.equal((await fs.readFile(path.join(venv, '.gitignore'), 'utf8')).trim(), '*');
  });
});
