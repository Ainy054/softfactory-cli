import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackUat } from './Uat.js';
import { EnvironmentSchema, type Environment } from './Environment.js';

/** A valid environment with the given overrides; defaults fill the rest. */
function env(overrides: Partial<Environment> = {}): Environment {
  return EnvironmentSchema.parse({ live: 'there is no production; this host is dev', ...overrides });
}

describe('fallbackUat', () => {
  it('builds setup and teardown from test_stack when set', () => {
    const config = fallbackUat(env({
      test_stack: { up: 'docker compose up -d', down: 'docker compose down' },
      health: ['http://localhost:8080/health'],
    }), []);
    assert.ok(config);
    assert.deepEqual(config.setup, ['docker compose up -d']);
    assert.deepEqual(config.teardown, ['docker compose down']);
  });

  it('leaves setup and teardown empty when there is no test_stack', () => {
    const config = fallbackUat(env({ health: ['http://localhost:8080/health'] }), []);
    assert.ok(config);
    assert.deepEqual(config.setup, []);
    assert.deepEqual(config.teardown, []);
  });

  it('builds one probe per health URL', () => {
    const config = fallbackUat(env({
      health: ['http://localhost:8080/health', 'http://localhost:9090/ready'],
    }), []);
    assert.ok(config);
    assert.deepEqual(config.probes, [
      { name: 'health http://localhost:8080/health', run: "curl -fsS --max-time 20 'http://localhost:8080/health'" },
      { name: 'health http://localhost:9090/ready', run: "curl -fsS --max-time 20 'http://localhost:9090/ready'" },
    ]);
  });

  it('builds a probe for a changed route, carrying its expect', () => {
    const config = fallbackUat(env({
      routes: [
        { files: ['src/routes/users/**'], url: 'http://localhost:8080/api/users', expect: '"ok":true' },
        { files: ['src/routes/billing.ts'], url: 'http://localhost:8080/api/billing' },
      ],
    }), ['src/routes/users/list.ts']);
    assert.ok(config);
    assert.deepEqual(config.probes, [
      { name: 'route http://localhost:8080/api/users', run: "curl -fsS --max-time 20 'http://localhost:8080/api/users'", expect: '"ok":true' },
    ]);
  });

  it('omits an unchanged route', () => {
    const config = fallbackUat(env({
      health: ['http://localhost:8080/health'],
      routes: [
        { files: ['src/routes/users/**'], url: 'http://localhost:8080/api/users' },
        { files: ['src/routes/billing.ts'], url: 'http://localhost:8080/api/billing' },
      ],
    }), ['src/routes/users/list.ts']);
    assert.ok(config);
    assert.deepEqual(config.probes.map(p => p.name), [
      'health http://localhost:8080/health',
      'route http://localhost:8080/api/users',
    ]);
  });

  it('returns undefined when there are no health URLs and no changed routes', () => {
    assert.equal(fallbackUat(env(), []), undefined);
    assert.equal(
      fallbackUat(env({ live: 'prod', routes: [{ files: ['src/routes/users/**'], url: 'http://localhost:8080/api/users' }] }), ['src/other.ts']),
      undefined,
    );
  });

  it('omits a health URL containing a single quote, without error', () => {
    const config = fallbackUat(env({ health: ["http://localhost:8080/a'b", 'http://localhost:8080/health'] }), []);
    assert.ok(config);
    assert.deepEqual(config.probes.map(p => p.name), ['health http://localhost:8080/health']);
    assert.equal(fallbackUat(env({ health: ["http://localhost:8080/a'b"] }), []), undefined);
  });

  it('omits a changed route whose URL contains a single quote, without error', () => {
    const config = fallbackUat(env({
      routes: [
        { files: ['src/routes/bad/**'], url: "http://localhost:8080/a'b", expect: 'ok' },
        { files: ['src/routes/good/**'], url: 'http://localhost:8080/api/good' },
      ],
    }), ['src/routes/bad/x.ts', 'src/routes/good/x.ts']);
    assert.ok(config);
    assert.deepEqual(config.probes, [
      { name: 'route http://localhost:8080/api/good', run: "curl -fsS --max-time 20 'http://localhost:8080/api/good'" },
    ]);
  });

  it('quotes a URL so shell metacharacters are inert', () => {
    const config = fallbackUat(env({ health: ['http://localhost:8080/health?(x=1)'] }), []);
    assert.ok(config);
    assert.equal(config.probes[0].run, "curl -fsS --max-time 20 'http://localhost:8080/health?(x=1)'");
  });
});
