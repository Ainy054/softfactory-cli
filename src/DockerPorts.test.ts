import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { DockerVerifier } from './DockerVerifier.js';

// godo's real compose shape, alongside fineract's postgres on 5432.
const COMPOSE = `services:
  postgres:
    image: postgres:16
    ports:
      - "5434:5432"
  redis:
    ports:
      - "6380:6379"
  backend:
    ports:
      - "8081:8080"
  postgres_test:
    ports:
      - "5433:5432"
`;

async function composeFile(body = COMPOSE) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-ports-'));
  const file = path.join(dir, 'docker-compose.yml');
  await fs.writeFile(file, body);
  return { dir, file };
}

function occupy(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as any;
      resolve({ port, close: () => new Promise<void>(r => server.close(() => r())) });
    });
  });
}

describe('docker verification will not fight another project for a port', () => {
  it('reads published host ports out of the compose file', async () => {
    const { dir, file } = await composeFile();
    const ports: number[] = await (new DockerVerifier() as any).publishedPorts(dir, file);
    assert.deepEqual(ports.sort((a, b) => a - b), [5433, 5434, 6380, 8081]);
    assert.ok(!ports.includes(5432), 'the container-side port is not what gets bound on the host');
  });

  it('reports nothing when the ports are free', async () => {
    const { dir, file } = await composeFile();
    assert.deepEqual(await new DockerVerifier().conflictingPorts(dir, file), []);
  });

  it('reports a port another process is already serving', async () => {
    const held = await occupy();
    try {
      const { dir, file } = await composeFile(`services:\n  db:\n    ports:\n      - "${held.port}:5432"\n`);
      assert.deepEqual(await new DockerVerifier().conflictingPorts(dir, file), [held.port]);
    } finally {
      await held.close();
    }
  });

  it('refuses to start the stack when a port is taken, and says why', async () => {
    const held = await occupy();
    try {
      const { dir, file } = await composeFile(`services:\n  db:\n    ports:\n      - "${held.port}:5432"\n`);
      await fs.rename(file, path.join(dir, 'docker-compose.yml'));
      const result = await new DockerVerifier().verify(dir);
      assert.equal(result.passed, false);
      assert.match(result.logs, /already in use/);
      assert.match(result.logs, /--no-docker/);
      assert.match(result.logs, new RegExp(String(held.port)));
    } finally {
      await held.close();
    }
  });

  it('ignores a compose file with no published ports', async () => {
    const { dir, file } = await composeFile('services:\n  worker:\n    image: busybox\n');
    assert.deepEqual(await new DockerVerifier().conflictingPorts(dir, file), []);
  });
});
