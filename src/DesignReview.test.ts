import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import { execa } from 'execa';
import { listMockups, serveMockups } from './DesignReview.js';
import { buildPullRequestBody } from './PullRequest.js';
import { MOCKUP_DIR } from './IWorker.js';

async function git(root: string, args: string[]): Promise<string> {
  const result = await execa('git', args, { cwd: root, reject: false });
  assert.equal(result.exitCode, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

/**
 * A temporary git repository carrying the committed mockups a designer would
 * push: two screens of T1, one of T2, a non-html note, and a root
 * package.json for the traversal attempt. No network is used anywhere.
 */
async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-design-'));
  await git(root, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'Test']);
  await fs.mkdir(path.join(root, MOCKUP_DIR), { recursive: true });
  await fs.writeFile(path.join(root, MOCKUP_DIR, 'T1-login.html'), '<!doctype html>\n<h1>Login</h1>\n');
  await fs.writeFile(path.join(root, MOCKUP_DIR, 'T1-signup.html'), '<!doctype html>\n<h1>Sign up</h1>\n');
  await fs.writeFile(path.join(root, MOCKUP_DIR, 'T2-checkout.html'), '<!doctype html>\n<h1>Checkout</h1>\n');
  await fs.writeFile(path.join(root, MOCKUP_DIR, 'T1-notes.md'), '# not a mockup\n');
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"not-a-mockup"}\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', 'mockups']);
  return root;
}

/** A raw GET, so the traversal path reaches the server unnormalised. */
function request(port: number, rawPath: string): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body, type: String(res.headers['content-type'] || '') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('listMockups reads the mockups a branch carries', () => {
  let root: string;
  before(async () => { root = await makeRepo(); });
  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('finds the two mockups of one task and ignores a non-html file', async () => {
    const mockups = await listMockups(root, 'HEAD');
    const t1 = mockups.filter(m => m.task === 'T1');
    assert.deepEqual(t1.map(m => m.file), ['T1-login.html', 'T1-signup.html']);
    assert.deepEqual(t1.map(m => m.screen), ['login', 'signup']);
    assert.ok(mockups.every(m => m.file.endsWith('.html')), 'only html files are mockups');
    assert.ok(!mockups.some(m => m.file === 'T1-notes.md'), 'the markdown note is not a mockup');
  });

  it('sorts by task then screen', async () => {
    const mockups = await listMockups(root, 'HEAD');
    assert.deepEqual(mockups.map(m => m.file), ['T1-login.html', 'T1-signup.html', 'T2-checkout.html']);
  });

  it('returns nothing for a name that is not a commit', async () => {
    assert.deepEqual(await listMockups(root, 'no-such-ref'), []);
  });
});

describe('serveMockups renders a local review surface', () => {
  let root: string;
  let server: { url: string; close: () => Promise<void> };
  let port: number;
  before(async () => {
    root = await makeRepo();
    server = await serveMockups(root, 'HEAD', 0);
    port = Number(new URL(server.url).port);
  });
  after(async () => {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('binds 127.0.0.1 only', () => {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it('the index links both mockups of the task, grouped by task', async () => {
    const index = await request(port, '/');
    assert.equal(index.status, 200);
    assert.match(index.type, /^text\/html; charset=utf-8$/);
    assert.ok(index.body.includes('href="/m/T1-login.html"'), 'login is linked');
    assert.ok(index.body.includes('href="/m/T1-signup.html"'), 'signup is linked');
    assert.match(index.body, /<h2>T1<\/h2>/);
    assert.match(index.body, /<h2>T2<\/h2>/);
    assert.ok(!index.body.includes('T1-notes.md'), 'the non-html file is never offered');
  });

  it('serves a mockup with its committed HTML', async () => {
    const response = await request(port, '/m/T1-login.html');
    assert.equal(response.status, 200);
    assert.match(response.type, /^text\/html; charset=utf-8$/);
    assert.ok(response.body.includes('<h1>Login</h1>'), 'the committed bytes are returned');
  });

  it('404s a traversal path instead of reading the working tree', async () => {
    const response = await request(port, '/m/../package.json');
    assert.equal(response.status, 404);
    assert.ok(!response.body.includes('not-a-mockup'), 'package.json was not read');
  });

  it('404s an unknown mockup name', async () => {
    const response = await request(port, '/m/T1-missing.html');
    assert.equal(response.status, 404);
  });
});

describe('buildPullRequestBody links the mockups', () => {
  it('adds the design mockups section and the links', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-pr-'));
    try {
      const body = await buildPullRequestBody({
        state: {
          feature: 'Design gate', feature_id: 'f-design', status: 'completed', strategy: 'hybrid',
          cloud_provider: 'agy', planner_provider: 'local', integration_branch: 'softfactory/design-gate',
          created_at: '', last_updated: '', tasks: [], memory_patterns: [],
        } as any,
        baseDir: root,
        baseBranch: 'main',
        sandbox: 'none',
        generator: 'test',
        mockups: [
          { file: 'T1-login.html', url: 'https://github.com/o/r/blob/softfactory/design-gate/softfactory-design/mockups/T1-login.html' },
          { file: 'T1-signup.html', url: 'https://github.com/o/r/blob/softfactory/design-gate/softfactory-design/mockups/T1-signup.html' },
        ],
      });
      assert.match(body, /^### Design mockups$/m);
      assert.ok(body.includes('[T1-login.html](https://github.com/o/r/blob/softfactory/design-gate/softfactory-design/mockups/T1-login.html)'), 'login is linked');
      assert.ok(body.includes('[T1-signup.html](https://github.com/o/r/blob/softfactory/design-gate/softfactory-design/mockups/T1-signup.html)'), 'signup is linked');
      assert.ok(body.includes('Run softfactory --design-review f-design to view them rendered.'), 'the local review command is named');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('has no mockups section when no mockups changed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-pr-'));
    try {
      const body = await buildPullRequestBody({
        state: {
          feature: 'Design gate', feature_id: 'f-design', status: 'completed', strategy: 'local',
          cloud_provider: 'agy', planner_provider: 'local', integration_branch: 'softfactory/design-gate',
          created_at: '', last_updated: '', tasks: [], memory_patterns: [],
        } as any,
        baseDir: root,
        baseBranch: 'main',
        sandbox: 'none',
        generator: 'test',
      });
      assert.ok(!body.includes('Design mockups'), 'no section without mockups');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
