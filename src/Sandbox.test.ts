import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { assertAllowedCommand } from './commandPolicy.js';
import { DockerRunner, SandboxManager, type CommandRunner } from './Sandbox.js';
import { TaskVerifier } from './TaskVerifier.js';
import { Factory } from './Factory.js';

describe('path arguments must stay inside the worktree', () => {
  const scope = { root: '/w', cwd: '/w' };

  it('refuses absolute, home and climbing paths without a scope', () => {
    for (const c of ['cat /etc/passwd', 'cat ~/.ssh/id_rsa', 'grep -r x ../../', 'git -C / log', 'ls --color=auto /', 'find / -name id_rsa']) {
      assert.throws(() => assertAllowedCommand(c), /escapes the worktree/, c);
    }
    for (const c of ['grep -r foo src', 'cat package.json', 'ls -la', 'find . -name "*.ts"']) {
      assert.doesNotThrow(() => assertAllowedCommand(c), c);
    }
  });

  it('allows absolute paths that resolve inside the worktree, and nothing that resolves outside', () => {
    assert.doesNotThrow(() => assertAllowedCommand('cat /w/src/a.ts', scope));
    assert.doesNotThrow(() => assertAllowedCommand('ls src/../package.json', scope));
    assert.throws(() => assertAllowedCommand('cat /w/../x', scope), /escapes/);
    assert.throws(() => assertAllowedCommand('ls ../', scope), /escapes/);
    assert.throws(() => assertAllowedCommand('cat /etc/hosts', scope), /escapes/);
    assert.throws(() => assertAllowedCommand('grep x src', { root: '/w', cwd: '/w/sub' }) || assertAllowedCommand('cat ../../x', { root: '/w', cwd: '/w/sub' }), /escapes/);
  });

  it('closes the interpreter, git and install escapes the allowlist left open', () => {
    for (const c of ['node -r ./evil.js x.js', 'node --import ./evil.mjs x.js', 'node --import=/w/evil.mjs x.js', 'node -r ../x.js y.js', 'git push origin main', 'git fetch', 'git pull', 'git clone x', 'git remote add x y', 'git submodule update', 'npm install lodash', 'npm ci']) {
      assert.throws(() => assertAllowedCommand(c, scope), c);
    }
    for (const c of ['node ./scripts/check.js', 'node --import tsx --test src/x.test.ts', 'node -r ts-node/register x.js', 'node --import=@swc-node/register/esm-register x.ts', 'git status', 'git diff', 'git log --oneline', 'npm install --ignore-scripts', 'npm ci --ignore-scripts', 'make test']) {
      assert.doesNotThrow(() => assertAllowedCommand(c, scope), c);
    }
  });
});

describe('the docker runner', () => {
  it('builds a network-less, capability-dropped container with the worktree writable at its own path', () => {
    const args = DockerRunner.buildArgs(
      { image: 'node:20-bookworm-slim', mounts: [{ host: '/repo', container: '/repo', readOnly: true }, { host: '/repo/.git/softfactory-worktrees/T1', container: '/repo/.git/softfactory-worktrees/T1' }], env: { FOO: 'bar' } },
      'npm', ['test'], { cwd: '/repo/.git/softfactory-worktrees/T1/frontend' });
    const joined = args.join(' ');
    assert.match(joined, /^run --rm --network none/);
    assert.match(joined, /--cap-drop ALL/);
    assert.match(joined, /-w \/repo\/\.git\/softfactory-worktrees\/T1\/frontend/);
    assert.match(joined, /-v \/repo:\/repo:ro/);
    assert.match(joined, /-v \/repo\/\.git\/softfactory-worktrees\/T1:\/repo\/\.git\/softfactory-worktrees\/T1(?: |$)/);
    assert.match(joined, /-e FOO=bar/);
    assert.ok(joined.endsWith('--entrypoint npm node:20-bookworm-slim test'), joined);
    assert.ok(!args.includes('-i'), 'stdin is attached only when there is input to pipe');
  });

  it('mounts the main repo read-only and the worktree gitdir writable for a worktree root', () => {
    const mounts = SandboxManager.mountsFor('/repo/.git/softfactory-worktrees/T7');
    assert.deepEqual(mounts, [
      { host: '/repo', container: '/repo', readOnly: true },
      { host: '/repo/.git/worktrees/T7', container: '/repo/.git/worktrees/T7' },
      { host: '/repo/.git/softfactory-worktrees/T7', container: '/repo/.git/softfactory-worktrees/T7' },
    ]);
    assert.deepEqual(SandboxManager.mountsFor('/proj'), [{ host: '/proj', container: '/proj' }]);
  });

  it('picks the image from the project manifests, the command, and overrides', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-img-'));
    const sandbox = new SandboxManager('docker');
    assert.match(await sandbox.imageFor(dir), /^debian/);
    await fs.writeFile(path.join(dir, 'package.json'), '{}');
    assert.match(await sandbox.imageFor(dir), /^node:/);
    await fs.mkdir(path.join(dir, 'backend'));
    await fs.writeFile(path.join(dir, 'backend', 'go.mod'), 'module x');
    assert.match(await sandbox.imageFor(dir, 'go'), /^golang:/);
    assert.match(await sandbox.imageFor(dir, 'npm'), /^node:/);
    await fs.mkdir(path.join(dir, '.softfactory'));
    await fs.writeFile(path.join(dir, '.softfactory', 'config.json'), JSON.stringify({ sandboxImage: 'my/toolchain:1' }));
    assert.equal(await sandbox.imageFor(dir, 'go'), 'my/toolchain:1');
  });
});

describe('an unsandboxed run is a choice, never a default', () => {
  it('blocks auto and docker modes without Docker, and names the opt-out', () => {
    const auto = new SandboxManager('auto');
    assert.match(auto.blockingReason()!, /--sandbox=none/);
    assert.equal(auto.active, false);
    const docker = new SandboxManager('docker');
    assert.match(docker.blockingReason()!, /Docker is not running/);
    const none = new SandboxManager('none');
    assert.equal(none.blockingReason(), null);
    assert.match(none.describe(), /UNSANDBOXED/);
  });

  it('halts the factory at preflight in auto mode without Docker', async () => {
    const factory: any = new Factory(await fs.mkdtemp(path.join(os.tmpdir(), 'sf-sbx-')), '', { strategy: 'local', sandbox: 'auto' });
    factory.sandbox.available = false;
    factory.workerRegistry.preflight = async () => { throw new Error('must not be reached'); };
    await factory.logBackendPreflight();
    assert.match(factory.environmentFault, /No sandbox: Docker is not available/);
  });

  it('runs, loudly, when the user chose --sandbox=none', async () => {
    const factory: any = new Factory(await fs.mkdtemp(path.join(os.tmpdir(), 'sf-sbx-')), '', { strategy: 'local', sandbox: 'none' });
    const lines: string[] = [];
    factory.on('log', (line: string) => lines.push(line));
    factory.workerRegistry.preflight = async () => ({ local: true, cloud: false, localModel: 'q', cloudModel: '' });
    await factory.logBackendPreflight();
    assert.equal(factory.environmentFault, undefined);
    assert.ok(lines.some(l => /UNSANDBOXED/.test(l)), lines.join('\n'));
  });
});

describe('the verifier and the acceptance runner execute through the sandbox', () => {
  function recordingSandbox() {
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const runner: CommandRunner = {
      kind: 'docker', describe: () => 'fake',
      exec: async (file, args, options) => { calls.push({ file, args, cwd: options.cwd }); return { stdout: 'ok', stderr: '', exitCode: 0 }; },
    };
    const sandbox: any = { runnerFor: async () => runner, active: true };
    return { calls, sandbox: sandbox as SandboxManager };
  }

  it('sends the test run to the runner, not to the host', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-vrun-'));
    await fs.writeFile(path.join(dir, 'Makefile'), 'test:\n\t@echo never-on-host && exit 1\n');
    const { calls, sandbox } = recordingSandbox();
    const result = await new TaskVerifier(sandbox).verify(dir);
    assert.equal(result.passed, true, 'the fake runner said ok, so the host Makefile never ran');
    assert.deepEqual(calls.map(c => [c.file, c.args.join(' ')]), [['make', 'test']]);
  });

  it('sends the acceptance command to the runner', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-arun-'));
    const { calls, sandbox } = recordingSandbox();
    const result = await new TaskVerifier(sandbox).runAcceptance(dir, { id: 'T1', verification_command: 'grep farewell app.ts', attempts: 0 });
    assert.equal(result.passed, true);
    assert.deepEqual(calls.map(c => [c.file, c.args.join(' '), c.cwd]), [['grep', 'farewell app.ts', dir]]);
  });

  it('still refuses a path escape before anything reaches the runner', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-arun-'));
    const { calls, sandbox } = recordingSandbox();
    const result = await new TaskVerifier(sandbox).runAcceptance(dir, { id: 'T1', verification_command: 'cat /etc/passwd', attempts: 0 });
    assert.equal(result.unrunnable, true);
    assert.equal(calls.length, 0);
  });
});

describe('the sandbox image carries the tools the allowlist promises', () => {
  it('derives a local image from each stock base, and leaves an override image alone', async () => {
    const { derivedImageName, sandboxDockerfile } = await import('./Sandbox.js');
    assert.equal(derivedImageName('node:20-bookworm-slim'), 'softfactory-sandbox-node:latest');
    assert.equal(derivedImageName('debian:bookworm-slim'), 'softfactory-sandbox-generic:latest');
    assert.equal(derivedImageName('my/toolchain:1'), undefined);
    const dockerfile = sandboxDockerfile('node:20-bookworm-slim');
    assert.match(dockerfile, /^FROM node:20-bookworm-slim\n/);
    for (const tool of ['git', 'ripgrep', 'make']) assert.match(dockerfile, new RegExp(`\\b${tool}\\b`), tool);
    assert.match(dockerfile, /rm -rf \/var\/lib\/apt\/lists/);
  });
});

describe('Node dependencies are installed for the sandbox platform, not copied from the host', () => {
  it('plans one volume per lockfile and package manager, and none without a lockfile', async () => {
    const { nodeDependencyPlan } = await import('./Sandbox.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-deps-'));
    assert.equal(await nodeDependencyPlan(dir), undefined, 'no package.json');
    await fs.writeFile(path.join(dir, 'package.json'), '{}');
    assert.equal(await nodeDependencyPlan(dir), undefined, 'no lockfile: nothing reproducible to install');
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
    const npm = (await nodeDependencyPlan(dir))!;
    assert.equal(npm.manager, 'npm');
    assert.equal(npm.pkgDir, dir);
    assert.match(npm.volume, /^softfactory-deps-[0-9a-f]{12}$/);
    assert.match(npm.install, /^npm ci --ignore-scripts/);
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
    assert.notEqual((await nodeDependencyPlan(dir))!.volume, npm.volume, 'a changed lockfile is a new volume');
    const front = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-deps-front-'));
    await fs.mkdir(path.join(front, 'frontend'));
    await fs.writeFile(path.join(front, 'frontend', 'package.json'), '{}');
    await fs.writeFile(path.join(front, 'frontend', 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    const pnpm = (await nodeDependencyPlan(front))!;
    assert.equal(pnpm.pkgDir, path.join(front, 'frontend'));
    assert.equal(pnpm.manager, 'pnpm');
    assert.match(pnpm.install, /pnpm install --frozen-lockfile --ignore-scripts/);
  });

  it('mounts the volume over the package directory\'s node_modules, and nothing when the install failed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-deps-mount-'));
    await fs.writeFile(path.join(dir, 'package.json'), '{}');
    await fs.writeFile(path.join(dir, 'yarn.lock'), '# yarn');
    const sandbox: any = new SandboxManager('docker');
    const installs: string[] = [];
    sandbox.installDependencyVolume = async (plan: any) => { installs.push(plan.volume); return true; };
    const mounts = await sandbox.nodeDependencyMounts(dir);
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].container, path.join(dir, 'node_modules'));
    assert.match(mounts[0].host, /^softfactory-deps-/);
    assert.equal(mounts[0].readOnly, undefined, 'tools write their caches under node_modules');
    await sandbox.nodeDependencyMounts(dir);
    assert.equal(installs.length, 1, 'ensured once per run');
    const failing: any = new SandboxManager('docker');
    failing.installDependencyVolume = async () => false;
    assert.deepEqual(await failing.nodeDependencyMounts(dir), []);
  });

  it('opens the network only for the install container, never for a command', () => {
    const base = { image: 'x', mounts: [] as any[] };
    assert.match(DockerRunner.buildArgs(base, 'npm', ['test'], { cwd: '/w' }).join(' '), /--network none/);
    assert.match(DockerRunner.buildArgs({ ...base, network: 'bridge' }, 'npm', ['ci'], { cwd: '/w' }).join(' '), /--network bridge/);
  });

  it('prepare() leaves the host alone when the sandbox is on, and reports a missing lockfile', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-prep-'));
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { leftpad: '1.0.0' } }));
    const sandbox: any = { active: true, nodeDependencyMounts: async () => [] };
    const refused = await new TaskVerifier(sandbox as SandboxManager).prepare(dir, { files_hint: ['src/a.ts'] } as any);
    assert.equal(refused.ok, false);
    assert.match(refused.message!, /no lockfile|install failed/);
    sandbox.nodeDependencyMounts = async () => [{ host: 'softfactory-deps-abc', container: path.join(dir, 'node_modules') }];
    assert.deepEqual(await new TaskVerifier(sandbox as SandboxManager).prepare(dir, { files_hint: ['src/a.ts'] } as any), { ok: true });
    await assert.rejects(fs.access(path.join(dir, 'node_modules')), 'no host npm ci ran');
  });
});
