import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { requestJson, HttpStatusError, isTransient } from './HttpRetry.js';

/** DeepSeek dropped connections mid-response twice during issue #17's run; each drop halted the run. */

const sleep = async () => {};
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('a model request survives a dropped connection', () => {
  it('retries a connection the server terminated mid-body, and succeeds', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return { ok: true, status: 200, json: async () => { throw new TypeError('terminated'); } } as unknown as Response;
      return ok({ answer: 42 });
    }) as typeof fetch;
    assert.deepEqual(await requestJson(fetchImpl, 'https://x/v1', {}, { label: 'DeepSeek', sleep }), { answer: 42 });
    assert.equal(calls, 2);
  });

  it('retries 429 and 503, then gives up with the status after three attempts', async () => {
    const statuses: number[] = [];
    const fetchImpl = (async () => { statuses.push(503); return new Response('overloaded', { status: 503, statusText: 'Service Unavailable' }); }) as typeof fetch;
    await assert.rejects(requestJson(fetchImpl, 'https://x', {}, { label: 'Qwen', sleep }), (e: any) => e instanceof HttpStatusError && e.status === 503 && /Qwen request failed: 503/.test(e.message));
    assert.equal(statuses.length, 3);
  });

  it('does not retry a 4xx, a caller abort, or an unknown error', async () => {
    let calls = 0;
    const unauthorized = (async () => { calls++; return new Response('bad key', { status: 401, statusText: 'Unauthorized' }); }) as typeof fetch;
    await assert.rejects(requestJson(unauthorized, 'https://x', {}, { label: 'X', sleep }), /401/);
    assert.equal(calls, 1);
    const controller = new AbortController();
    controller.abort();
    let aborted = 0;
    const dropping = (async () => { aborted++; throw new TypeError('terminated'); }) as typeof fetch;
    await assert.rejects(requestJson(dropping, 'https://x', {}, { label: 'X', sleep, signal: controller.signal }));
    assert.equal(aborted, 1, 'the caller stopped; no retry');
    let odd = 0;
    await assert.rejects(requestJson((async () => { odd++; throw new Error('JSON parse exploded'); }) as typeof fetch, 'https://x', {}, { label: 'X', sleep }));
    assert.equal(odd, 1);
  });

  it('knows a transient failure by its message or cause', () => {
    assert.equal(isTransient(new TypeError('terminated')), true);
    assert.equal(isTransient(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), true);
    assert.equal(isTransient(new Error('Unexpected token < in JSON')), false);
  });
});
