/**
 * Planning-time reachability for outside sources. The mongolbank-rates run
 * invented `https://www.mongolbank.mn/en/rates`; the site answered HTTP 200
 * with a "404 - Page Not Found" page and seven tasks were built against it.
 * Every case here injects a fetch implementation, so the tests never touch
 * the network: they only decide whether a plan may stand on a given address.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { probeSource, sourcesFromRequirement } from './SourceProbe.js';

/** A response with a real body stream, the same shape `probeSource` reads. */
function response(body: string, status = 200, contentType = ''): Response {
  return new Response(body, { status, ...(contentType ? { headers: { 'content-type': contentType } } : {}) });
}

const jsonResponse = (value: unknown, status = 200) => response(JSON.stringify(value), status, 'application/json');

describe('probeSource classifies an outside source before the plan is built', () => {
  it('accepts an ok JSON source and keeps what it answered', async () => {
    const payload = { success: true, rates: [{ currency: 'USD', rate: 3421.5 }] };
    let seenUrl = '';
    const fetchImpl = (async (url: any) => { seenUrl = String(url); return jsonResponse(payload); }) as typeof fetch;
    const result = await probeSource({ name: 'mongolbank-rates', url: 'https://www.mongolbank.mn/en/rates', expect: 'json' }, fetchImpl);
    assert.equal(result.ok, true, result.problem);
    assert.equal(result.status, 200);
    assert.equal(result.contentType, 'application/json');
    assert.equal(result.problem, undefined);
    assert.ok(result.bytes > 0, 'the kept body is measured in bytes');
    assert.deepEqual(JSON.parse(result.body), payload);
    assert.equal(seenUrl, 'https://www.mongolbank.mn/en/rates', 'the exact URL is fetched once');
  });

  it('rejects a 404', async () => {
    const fetchImpl = (async () => response('Not Found', 404, 'text/html')) as typeof fetch;
    const result = await probeSource({ name: 'rates', url: 'https://example.com/missing', expect: 'json' }, fetchImpl);
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.match(result.problem ?? '', /HTTP 404/);
  });

  it('rejects a soft 404: HTTP 200 whose own title says page not found', async () => {
    // The real mongolbank shape: the status is 200, the document is not.
    const html = '<!doctype html><html><head><title>404 - Page Not Found</title></head>'
      + '<body><h1>404 - Page Not Found</h1></body></html>';
    const fetchImpl = (async () => response(html, 200, 'text/html')) as typeof fetch;
    const result = await probeSource({ name: 'mongolbank-rates', url: 'https://www.mongolbank.mn/en/rates', expect: 'html' }, fetchImpl);
    assert.equal(result.ok, false);
    assert.equal(result.status, 200, 'the status is a lie the probe must see through');
    assert.match(result.problem ?? '', /soft 404/);
  });

  it('rejects a JSON body that reports success:false', async () => {
    const fetchImpl = (async () => jsonResponse({ success: false, error: 'no such series' })) as typeof fetch;
    const result = await probeSource({ name: 'rates', url: 'https://api.example.com/rates', expect: 'json' }, fetchImpl);
    assert.equal(result.ok, false);
    assert.equal(result.status, 200);
    assert.match(result.problem ?? '', /success: false/);
  });

  it('rejects HTML when JSON was expected', async () => {
    const html = '<!doctype html><html><body>' + 'welcome '.repeat(60) + '</body></html>';
    const fetchImpl = (async () => response(html, 200, 'text/html')) as typeof fetch;
    const result = await probeSource({ name: 'rates', url: 'https://api.example.com/rates', expect: 'json' }, fetchImpl);
    assert.equal(result.ok, false);
    assert.match(result.problem ?? '', /expected json, got HTML/i);
  });

  it('reports a timeout as a problem instead of hanging the plan', async () => {
    // The probe's own timer is unref'd, so a fake fetch that never settles
    // leaves the loop with nothing to do; this ref'd timer keeps it alive
    // until the probe aborts, and is cleared once the probe has returned.
    let keepAlive: ReturnType<typeof setTimeout> | undefined;
    const never = (async () => {
      const pending = new Promise<Response>(() => { /* never settles on its own */ });
      keepAlive = setTimeout(() => {}, 60_000);
      return pending;
    }) as typeof fetch;
    try {
      const result = await probeSource({ name: 'slow', url: 'https://example.com/slow', expect: 'any' }, never, { timeoutMs: 25 });
      assert.equal(result.ok, false);
      assert.equal(result.status, 0, 'no response arrived, so there is no status');
      assert.match(result.problem ?? '', /timed out/);
    } finally {
      if (keepAlive) clearTimeout(keepAlive);
    }
  });
});

describe('sourcesFromRequirement finds the outside addresses a requirement names', () => {
  it('extracts the two URLs written in prose, in order', () => {
    const requirement = 'Build a rates dashboard. Pull the daily rates from https://www.mongolbank.mn/en/rates '
      + 'and the currency list from https://api.example.com/v1/currencies.json, then join them.';
    assert.deepEqual(sourcesFromRequirement(requirement), [
      'https://www.mongolbank.mn/en/rates',
      'https://api.example.com/v1/currencies.json',
    ]);
  });
});
