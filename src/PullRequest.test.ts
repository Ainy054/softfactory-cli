import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitHub, buildPullRequestBody, requirementFromIssue, stripHtmlComments, type Exec } from './PullRequest.js';
import type { FactoryState } from './types.js';

/** Records every command and answers from a script keyed by "file arg0 arg1". */
function fakeExec(answers: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>) {
  const calls: Array<{ file: string; args: string[]; input?: string }> = [];
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args, input: options?.input });
    const key = [file, ...args.slice(0, 2)].join(' ');
    const answer = answers[key] || answers[`${file} ${args[0]}`] || answers[file];
    if (!answer) throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    return { stdout: answer.stdout || '', stderr: answer.stderr || '', exitCode: answer.exitCode ?? 0 };
  };
  return { exec, calls };
}

describe('the issue becomes the requirement', () => {
  it('reads title, body and url through gh and drops template comments', async () => {
    const { exec, calls } = fakeExec({ 'gh issue view': { stdout: JSON.stringify({ number: 7, title: 'Add farewell', body: '<!-- describe -->\nUsers want a goodbye.\n<!-- end -->', url: 'https://github.com/o/r/issues/7' }) } });
    const issue = await new GitHub('/repo', exec).readIssue(7);
    assert.deepEqual(issue, { number: 7, title: 'Add farewell', body: 'Users want a goodbye.', url: 'https://github.com/o/r/issues/7' });
    assert.deepEqual(calls[0].args, ['issue', 'view', '7', '--json', 'number,title,body,url']);
    assert.equal(requirementFromIssue(issue, 'keep it small'), 'Add farewell\n\nUsers want a goodbye.\n\nAdditional instructions from the operator:\nkeep it small');
    assert.equal(stripHtmlComments('a<!-- x\ny -->b'), 'ab');
  });

  it('fails plainly when the issue cannot be read', async () => {
    const { exec } = fakeExec({ 'gh issue view': { stderr: 'GraphQL: Could not resolve to an Issue', exitCode: 1 } });
    await assert.rejects(() => new GitHub('/repo', exec).readIssue(99), /Could not read issue #99: GraphQL/);
  });

  it('distinguishes a missing gh from a logged-out one', async () => {
    const loggedOut = fakeExec({ 'gh auth status': { stderr: 'You are not logged into any GitHub hosts.', exitCode: 1 } });
    assert.match((await new GitHub('/repo', loggedOut.exec).availability()).reason!, /not logged in/);
    const missing: Exec = async () => { throw new Error('spawn gh ENOENT'); };
    assert.match((await new GitHub('/repo', missing).availability()).reason!, /not installed/);
  });
});

describe('opening and updating the pull request', () => {
  it('creates a draft with the body on stdin and parses the number from the url', async () => {
    const { exec, calls } = fakeExec({ 'gh pr create': { stdout: 'https://github.com/o/r/pull/42\n' } });
    const pr = await new GitHub('/repo', exec).createPullRequest({ base: 'main', head: 'softfactory/f-1', title: 'T', body: 'B', draft: true });
    assert.deepEqual(pr, { number: 42, url: 'https://github.com/o/r/pull/42', isDraft: true });
    assert.deepEqual(calls[0].args, ['pr', 'create', '--base', 'main', '--head', 'softfactory/f-1', '--title', 'T', '--body-file', '-', '--draft']);
    assert.equal(calls[0].input, 'B');
  });

  it('finds an open pull request for the branch and edits it', async () => {
    const { exec, calls } = fakeExec({
      'gh pr list': { stdout: JSON.stringify([{ number: 42, url: 'https://github.com/o/r/pull/42', isDraft: true }]) },
      'gh pr edit': {}, 'gh pr ready': {},
    });
    const github = new GitHub('/repo', exec);
    assert.deepEqual(await github.findOpenPullRequest('softfactory/f-1'), { number: 42, url: 'https://github.com/o/r/pull/42', isDraft: true });
    await github.updatePullRequest(42, { title: 'T2', body: 'B2' });
    await github.markReady(42);
    assert.deepEqual(calls.map(c => c.args.slice(0, 2).join(' ')), ['pr list', 'pr edit', 'pr ready']);
    assert.equal(calls[1].input, 'B2');
  });

  it('reports a failed push with git\'s last words', async () => {
    const { exec } = fakeExec({ 'git push': { stderr: 'fatal: no remote\nerror: failed to push', exitCode: 1 } });
    await assert.rejects(() => new GitHub('/repo', exec).pushBranch('softfactory/f-1'), /git push of softfactory\/f-1 failed: fatal: no remote error: failed to push/);
  });
});

describe('reading a pull request state', () => {
  for (const state of ['OPEN', 'MERGED', 'CLOSED'] as const) {
    it(`returns ${state} from gh pr view`, async () => {
      const { exec, calls } = fakeExec({ 'gh pr view': { stdout: `${state}\n` } });
      assert.equal(await new GitHub('/repo', exec).prState(12), state);
      assert.deepEqual(calls[0].args, ['pr', 'view', '12', '--json', 'state', '-q', '.state']);
    });
  }

  it('fails plainly when gh exits non-zero', async () => {
    const { exec } = fakeExec({ 'gh pr view': { stderr: 'no pull requests found for branch', exitCode: 1 } });
    await assert.rejects(() => new GitHub('/repo', exec).prState(12), /Could not read PR #12: no pull requests found for branch/);
  });

  it('fails plainly on an unexpected state', async () => {
    const { exec } = fakeExec({ 'gh pr view': { stdout: 'DRAFT\n' } });
    await assert.rejects(() => new GitHub('/repo', exec).prState(12), /Unexpected state for PR #12: DRAFT/);
  });
});

describe('the pull request body', () => {
  it('states what was asked, what merged, how each task was checked, and where the record is', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-prbody-'));
    await fs.mkdir(path.join(dir, '.softfactory', 'evidence', 'f-1'), { recursive: true });
    await fs.writeFile(path.join(dir, '.softfactory', 'evidence', 'f-1', 'T1-attempt1.log'), 'COMMAND: grep farewell app.ts\nexport const farewell\nRESULT: PASS\n');
    const state = {
      schema_version: 2, feature_id: 'f-1', feature: 'Farewell greeting', status: 'paused', strategy: 'hybrid', cloud_provider: 'anthropic', planner_provider: 'anthropic',
      created_at: '', last_updated: '', state_revision: 0, memory_patterns: [], usage: { input_tokens: 10, output_tokens: 5 },
      source: { kind: 'issue', number: 7, url: 'https://github.com/o/r/issues/7', title: 'Add farewell' },
      integration_branch: 'softfactory/f-1', base_branch: 'main',
      tasks: [
        { id: 'T1', title: 'Add farewell | export', status: 'done', attempts: 1, executor: 'agent', inspection: 'model', inspector_model: 'anthropic/claude', verification_command: 'grep farewell app.ts', evidence: '.softfactory/evidence/f-1/T1-attempt1.log' },
        { id: 'T2', title: 'Rotate the key', status: 'manual', attempts: 0, executor: 'orchestrator' },
      ],
    } as unknown as FactoryState;
    const body = await buildPullRequestBody({
      state, baseDir: dir, baseBranch: 'main', sandbox: 'docker container per command',
      journal: { ok: true, entries: 12, head: 'abc123', problems: [] },
      metrics: { first_attempt_rate: 0, rejected_by_category: { acceptance: 1 }, tokens: { input: 10, output: 5 } },
      generator: 'softfactory 4.4.0',
    });
    assert.match(body, /^## Farewell greeting/m);
    assert.match(body, /Closes #7 \(https:\/\/github.com\/o\/r\/issues\/7\)/);
    assert.match(body, /\*\*Run status:\*\* paused\. 1 of 2 tasks merged into `softfactory\/f-1` on top of `main`/);
    assert.match(body, /Unfinished: T2 \(manual, orchestrator\)/);
    assert.match(body, /\| T1 \| Add farewell \\\| export \| done \| 1 \| model \(anthropic\/claude\) \| `grep farewell app\.ts` PASS \|/);
    assert.match(body, /\| T2 \| Rotate the key \| manual \| 0 \|  \| none declared \|/);
    assert.match(body, /<details><summary>T1: <code>grep farewell app\.ts<\/code><\/summary>[\s\S]*RESULT: PASS[\s\S]*<\/details>/);
    assert.match(body, /Run journal: 12 hash-chained entries, head `abc123`, verified/);
    assert.match(body, /rejections: acceptance ×1; tokens 15/);
    assert.match(body, /Sandbox: docker container per command/);
    assert.match(body, /Generated by softfactory 4\.4\.0\.$/);
  });
});
