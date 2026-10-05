import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentContainer } from './AgentContainer.js';
import { CLI_AGENTS } from './CliAgentWorker.js';

const claude = CLI_AGENTS['claude-code'];
const muse = CLI_AGENTS['muse'];

describe('the agent image and its egress', () => {
  it('builds the agent CLI onto the node base image', () => {
    const dockerfile = AgentContainer.dockerfileFor(claude);
    assert.match(dockerfile, /^FROM node:20-bookworm-slim\n/);
    assert.match(dockerfile, /npm install -g @anthropic-ai\/claude-code/);
    assert.match(dockerfile, /apt-get install .*git ca-certificates/);
    assert.equal(AgentContainer.imageNameFor(claude), 'softfactory-agent-claude-code:latest');
  });

  it('admits the agent API, a configured base URL, and project extras, nothing else', () => {
    assert.deepEqual(AgentContainer.egressFor(claude, {}), ['api.anthropic.com']);
    assert.deepEqual(AgentContainer.egressFor(claude, { ANTHROPIC_BASE_URL: 'https://gateway.corp.example/v1' }), ['api.anthropic.com', 'gateway.corp.example']);
    assert.deepEqual(AgentContainer.egressFor(claude, { SOFTFACTORY_EGRESS_ALLOW: 'registry.npmjs.org, pypi.org' }, ['files.pythonhosted.org']), ['api.anthropic.com', 'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org']);
    assert.deepEqual(AgentContainer.egressFor(CLI_AGENTS['gemini-cli'], {}), ['generativelanguage.googleapis.com']);
  });

  it('refuses to run an agent in the container without a key it can use there', async () => {
    assert.match((await AgentContainer.credentialProblem(claude, {}))!, /needs one of ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN/);
    assert.match((await AgentContainer.credentialProblem(claude, {}))!, /--sandbox=none/);
    assert.equal(await AgentContainer.credentialProblem(claude, { ANTHROPIC_API_KEY: 'k' }), null);
  });

  it('builds Muse from its launcher with the login as a build secret, and mounts the login file read-only', async () => {
    const dockerfile = AgentContainer.dockerfileFor(muse);
    assert.match(dockerfile, /^# syntax=docker\/dockerfile:1\n/, 'secret mounts need the BuildKit frontend');
    assert.match(dockerfile, /curl -fsSL https:\/\/api\.meta\.ai\/muse-launcher\.sh/);
    assert.match(dockerfile, /--mount=type=secret,id=muse-auth,target=\/root\/\.config\/muse\/auth\.json MUSE_LAUNCHER_INSTALL=1/);
    assert.match(dockerfile, /ENV MUSE_NO_AUTO_UPDATE=1/);
    assert.deepEqual(AgentContainer.egressFor(muse, {}), ['api.meta.ai']);

    // No key and no login file: refused. A login file alone: allowed, and mounted.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-muse-home-'));
    const spec = { ...muse, credentialFiles: [{ host: path.join(home, 'auth.json'), container: '/tmp/.config/muse/auth.json' }] };
    assert.match((await AgentContainer.credentialProblem(spec, {}))!, /needs one of META_API_KEY in the environment, or a login file at .*auth\.json/);
    await fs.writeFile(path.join(home, 'auth.json'), '{}');
    assert.equal(await AgentContainer.credentialProblem(spec, {}), null);
    const mounts = await AgentContainer.credentialMounts(spec);
    assert.deepEqual(mounts, [{ host: path.join(home, 'auth.json'), container: '/tmp/.config/muse/auth.json', readOnly: true }]);
    const args = AgentContainer.buildRunArgs(spec, 'img', { root: '/w', cwd: '/w', args: ['exec'] }, {}, mounts).join(' ');
    assert.match(args, new RegExp(`-v ${path.join(home, 'auth.json')}:/tmp/.config/muse/auth.json:ro `));
    assert.match(args, /-e MUSE_NO_AUTO_UPDATE=1/, 'runtime env from the spec');
  });
});

describe('the agent container run', () => {
  it('is on the internal network, read-only, proxied, with only the agent credential passed in', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-agent', OPENAI_API_KEY: 'sk-other', AWS_SECRET_ACCESS_KEY: 'aws', HOME: '/Users/me', PATH: '/bin' };
    const args = AgentContainer.buildRunArgs(claude, 'softfactory-agent-claude-code:latest',
      { root: '/repo/.git/softfactory-worktrees/T1', cwd: '/repo/.git/softfactory-worktrees/T1', args: ['-p', 'do it'] }, env);
    const joined = args.join(' ');
    assert.match(joined, /^run --rm --init --network softfactory-egress /);
    assert.match(joined, /--cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs \/tmp:rw,exec,size=4g/);
    assert.match(joined, /-v \/repo:\/repo:ro /, 'the main repository is read-only');
    assert.match(joined, /-v \/repo\/\.git\/softfactory-worktrees\/T1:\/repo\/\.git\/softfactory-worktrees\/T1 /, 'the worktree is writable');
    assert.match(joined, /-e HTTPS_PROXY=http:\/\/egress-proxy:3128/);
    assert.match(joined, /-e HOME=\/tmp/);
    assert.match(joined, /--user \d+:\d+ /, 'never root: Claude Code refuses bypassPermissions as root');
    assert.equal(AgentContainer.userFor('darwin'), '1000:1000');
    assert.match(joined, /-e ANTHROPIC_API_KEY=sk-agent/);
    assert.doesNotMatch(joined, /sk-other|AWS_SECRET|\/Users\/me|PATH=/, 'nothing else from the host environment leaks in');
    assert.ok(joined.endsWith('softfactory-agent-claude-code:latest claude -p do it'));
  });

  it('creates the internal network and a bridged proxy once, and rebuilds the image only when missing', async () => {
    const calls: string[][] = [];
    const docker = async (args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(' ');
      if (key === 'network inspect') return { stdout: '', stderr: 'no such network', exitCode: 1 };
      if (key === 'image inspect') return { stdout: '', stderr: 'no such image', exitCode: 1 };
      return { stdout: 'sha256:abc', stderr: '', exitCode: 0 };
    };
    const container = new AgentContainer(() => {}, docker);
    const image = await container.ensureImage(claude, '/nowhere');
    assert.equal(image, 'softfactory-agent-claude-code:latest');
    await container.ensureEgress(['api.anthropic.com']);
    await container.ensureEgress(['api.anthropic.com']);
    await container.ensureImage(claude, '/nowhere');
    const keys = calls.map(c => c.slice(0, 2).join(' '));
    assert.deepEqual(keys, ['image inspect', 'build -q', 'network inspect', 'network create', 'rm -f', 'run -d', 'network connect'], 'the second ensure calls are no-ops');
    const create = calls.find(c => c[0] === 'network' && c[1] === 'create')!;
    assert.deepEqual(create, ['network', 'create', '--internal', 'softfactory-egress']);
    const run = calls.find(c => c[0] === 'run')!;
    assert.ok(run.includes('--network') && run[run.indexOf('--network') + 1] === 'softfactory-egress');
    assert.ok(run.includes('EGRESS_ALLOW=api.anthropic.com'));
    assert.ok(run.some(a => /EgressProxy\.(js|ts):\/proxy\/egress-proxy\.mjs:ro$/.test(a)), run.join(' '));
    const build = calls.find(c => c[0] === 'build')!;
    assert.ok(!build.includes('--secret'), 'Claude Code has no build secret');
    assert.deepEqual(calls.find(c => c[0] === 'network' && c[1] === 'connect'), ['network', 'connect', 'bridge', 'softfactory-egress-proxy']);

    await container.ensureEgress(['api.anthropic.com', 'extra.example']);
    assert.equal(calls.filter(c => c[0] === 'run').length, 2, 'a changed allowlist restarts the proxy');
    await container.close();
    assert.deepEqual(calls[calls.length - 1], ['rm', '-f', 'softfactory-egress-proxy']);
  });
});
