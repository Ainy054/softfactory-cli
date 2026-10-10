import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnvironment, changedRoutes, orchestratorOwned, ENVIRONMENT_FILE } from './Environment.js';

async function project(content?: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-env-'));
  if (content !== undefined) {
    await fs.mkdir(path.join(dir, '.softfactory'));
    await fs.writeFile(path.join(dir, ENVIRONMENT_FILE), content);
  }
  return dir;
}

describe('environment.json', () => {
  it('is optional', async () => {
    assert.equal(await loadEnvironment(await project()), undefined);
  });

  it('loads with defaults', async () => {
    const env = await loadEnvironment(await project(JSON.stringify({ live: 'there is no production; this host is dev' })));
    assert.deepEqual(env, { live: 'there is no production; this host is dev', health: [], routes: [], orchestrator_files: [] });
  });

  it('refuses a malformed file rather than running without its rules', async () => {
    await assert.rejects(loadEnvironment(await project('{ "live": ')), /not valid JSON/);
    await assert.rejects(loadEnvironment(await project(JSON.stringify({ health: [] }))), /live/);
  });

  it('maps changed files to the routes they serve, and names orchestrator-owned files', async () => {
    const env = (await loadEnvironment(await project(JSON.stringify({
      live: 'prod at https://app.example.com',
      routes: [
        { files: ['src/routes/users/**'], url: 'http://localhost:8080/api/users' },
        { files: ['src/routes/billing.ts'], url: 'http://localhost:8080/api/billing', expect: 'ok' },
      ],
      orchestrator_files: ['docker-compose.yml', 'src/routes/index.ts'],
    }))))!;
    assert.deepEqual(changedRoutes(env, ['src/routes/users/list.ts', 'README.md']).map(r => r.url), ['http://localhost:8080/api/users']);
    assert.deepEqual(changedRoutes(env, ['src/other.ts']), []);
    assert.deepEqual(orchestratorOwned(env, ['src/routes/index.ts', 'src/routes/users/list.ts', 'docker-compose.yml']), ['src/routes/index.ts', 'docker-compose.yml']);
    assert.deepEqual(orchestratorOwned(undefined, ['docker-compose.yml']), []);
  });
});
