/**
 * Planning-time reachability for external sources. In the mongolbank-rates
 * run the planner invented `https://www.mongolbank.mn/en/rates`; the site
 * answered HTTP 200 with a "404 - Page Not Found" page, seven tasks were
 * built and merged against it, and the run still reported success. A plan is
 * only as good as the addresses it depends on, so before any worker starts
 * every outside URL a task will call is fetched once and checked: the status,
 * a soft 404 hidden in the HTML, the shape the source promised, and whether
 * the JSON itself says it failed. Nothing here is trusted; a wrong answer
 * rejects the plan instead of the run.
 */

export type SourceExpect = 'json' | 'html' | 'xml' | 'csv' | 'any';

/** One outside address a plan depends on, as the planner promised it. */
export interface SourceSpec {
  name: string;
  url: string;
  /** Defaults to GET. */
  method?: 'GET' | 'POST';
  /** Query parameters for GET, form fields for POST. */
  params?: Record<string, string>;
  /** Defaults to "any". */
  expect?: SourceExpect;
  purpose?: string;
}

/**
 * What `probeSource` accepts: the same shape, but `method` and `expect` may
 * arrive as plain strings (a caller building a spec at runtime is not typed),
 * so they are normalised before use.
 */
export type SourceProbeInput = Omit<SourceSpec, 'method' | 'expect'> & { method?: string; expect?: string };

export interface SourceProbeResult {
  name: string;
  url: string;
  ok: boolean;
  /** HTTP status, or 0 when no response arrived (timeout, DNS, connection). */
  status: number;
  contentType: string;
  /** Bytes kept; never more than the 256 KB ceiling. */
  bytes: number;
  /** Why it is not ok; absent when ok. */
  problem?: string;
  /** The kept body, decoded as UTF-8. */
  body: string;
}

export interface ProbeOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 256 * 1024;
/** An HTML page smaller than this is not a document anyone can build on. */
const HTML_MIN_BYTES = 200;
const SOFT_404 = /\b404\b|not found|page not found/i;

/**
 * Fetch one source once and classify it. Never throws on a bad source: the
 * result carries `ok: false` and a `problem` the planner can be handed back.
 */
export async function probeSource(src: SourceProbeInput, fetchImpl: typeof fetch = fetch, options: ProbeOptions = {}): Promise<SourceProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const expect = normalizeExpect(src.expect);
  const method = String(src.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const base: SourceProbeResult = { name: src.name, url: src.url, ok: false, status: 0, contentType: '', bytes: 0, body: '' };

  const target = targetUrl(src, method);
  if (!target) return { ...base, problem: `not a usable URL: ${src.url}` };

  const controller = new AbortController();
  let timedOut = false;
  let fireTimeout!: (error: Error) => void;
  const timeout = new Promise<never>((_resolve, reject) => { fireTimeout = reject; });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); fireTimeout(new Error('timeout')); }, timeoutMs);
  timer.unref?.();
  try {
    const init: RequestInit = { method, signal: controller.signal, redirect: 'follow' };
    if (method === 'POST' && src.params) {
      init.body = new URLSearchParams(src.params).toString();
      init.headers = { 'content-type': 'application/x-www-form-urlencoded' };
    }
    // Racing the timer keeps the 20s ceiling even for a fetch implementation
    // that ignores the abort signal; a real fetch is also cancelled by it.
    const response = await Promise.race([fetchImpl(target, init), timeout]);
    const contentType = response.headers?.get?.('content-type')?.trim() ?? '';
    const buffer = await Promise.race([readBody(response, maxBytes), timeout]);
    const result: SourceProbeResult = { ...base, status: Number(response.status) || 0, contentType, bytes: buffer.length, body: buffer.toString('utf8') };
    const problem = classify(result, expect);
    return problem ? { ...result, problem } : { ...result, ok: true };
  } catch (error: any) {
    // Our own timer sets `timedOut`; a fetch implementation may instead throw
    // its own abort or timeout error (DOMException "TimeoutError"), which is
    // the same story and reads the same way to the planner.
    const timedOutNow = timedOut || error?.name === 'TimeoutError' || /tim(?:e|ed)[ -]?out|abort/i.test(String(error?.message ?? ''));
    const problem = timedOutNow
      ? `request timed out after ${Math.round(timeoutMs / 1000)}s (timeout: no response from the source)`
      : `request failed: ${String(error?.message ?? error).slice(0, 200)}`;
    return { ...base, problem };
  } finally {
    clearTimeout(timer);
  }
}

/** Every distinct http(s) URL written in a requirement, in the order they appear. */
export function sourcesFromRequirement(text: string): string[] {
  const found = String(text ?? '').match(/\bhttps?:\/\/[^\s<>"'`]+/gi) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of found) {
    const url = raw.replace(/[.,;:!?)\]}>'"`]+$/, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** GET params become the query string; POST params become the form body. */
function targetUrl(src: SourceProbeInput, method: string): string {
  try {
    if (method === 'GET' && src.params && Object.keys(src.params).length > 0) {
      const url = new URL(src.url);
      for (const [key, value] of Object.entries(src.params)) url.searchParams.set(key, value);
      return url.toString();
    }
    new URL(src.url);
    return src.url;
  } catch {
    return '';
  }
}

/**
 * Read at most `limit` bytes. The response body is a stream, so a 5 GB page
 * stops the download at the ceiling instead of buffering it first.
 */
async function readBody(response: Response, limit: number): Promise<Buffer> {
  const stream = (response as any)?.body;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (total < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || !value.length) continue;
        const remaining = limit - total;
        const slice = value.length > remaining ? value.subarray(0, remaining) : value;
        chunks.push(Buffer.from(slice));
        total += slice.length;
      }
    } finally {
      try { await reader.cancel(); } catch { /* the stream is already closed */ }
    }
    return Buffer.concat(chunks, total);
  }
  if (typeof (response as any).arrayBuffer === 'function') {
    return Buffer.from(await (response as any).arrayBuffer()).subarray(0, limit);
  }
  const text = typeof (response as any).text === 'function' ? await (response as any).text() : '';
  return Buffer.from(String(text)).subarray(0, limit);
}

/** Returns the first reason the source is not ok, or undefined when it is. */
function classify(result: SourceProbeResult, expect: SourceExpect): string | undefined {
  if (!(result.status >= 200 && result.status < 300)) return `HTTP ${result.status}`;

  const body = result.body;
  const kind = detectKind(result.contentType, body);
  const looksHtml = kind === 'html' || /<html[\s>]|<!doctype html|<title[\s>]|<h1[\s>]/i.test(body);
  if (looksHtml) {
    const soft = softNotFound(body);
    if (soft) return soft;
    if (expect !== 'any' && expect !== 'html') return `expected ${expect}, got HTML (${result.contentType || 'no content type'})`;
    if (result.bytes < HTML_MIN_BYTES) return `HTML body is only ${result.bytes} bytes, under the ${HTML_MIN_BYTES}-byte minimum`;
    return undefined;
  }

  if (expect !== 'any' && !matchesExpect(expect, result.contentType, body)) {
    const got = result.contentType || 'no content type';
    return `expected ${expect}, got ${got}`;
  }

  if (expect === 'json' || kind === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error: any) {
      return expect === 'json' ? `expected JSON, but the body did not parse: ${String(error?.message).slice(0, 120)}` : undefined;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (record.success === false) return 'JSON body reports success: false';
      if (Object.prototype.hasOwnProperty.call(record, 'error')) return 'JSON body has a top-level "error" key';
    }
  }
  return undefined;
}

const EXPECTS: ReadonlySet<string> = new Set(['json', 'html', 'xml', 'csv', 'any']);

/** Anything unrecognised falls back to "any": the probe still checks status and soft 404s. */
function normalizeExpect(value: string | undefined): SourceExpect {
  const normalised = String(value ?? 'any').toLowerCase();
  return (EXPECTS.has(normalised) ? normalised : 'any') as SourceExpect;
}

type DetectedKind = 'json' | 'html' | 'xml' | 'csv' | 'text';

function detectKind(contentType: string, body: string): DetectedKind {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('html')) return 'html';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('csv')) return 'csv';
  const text = body.replace(/^\uFEFF/, '').trimStart();
  if (text.startsWith('{') || text.startsWith('[')) return 'json';
  if (/^<!doctype html/i.test(text) || /<html[\s>]/i.test(text)) return 'html';
  if (text.startsWith('<?xml') || text.startsWith('<')) return 'xml';
  return 'text';
}

function matchesExpect(expect: SourceExpect, contentType: string, body: string): boolean {
  const ct = (contentType || '').toLowerCase();
  if (expect === 'any') return true;
  if (expect === 'json') return ct.includes('json') || detectKind(contentType, body) === 'json';
  if (expect === 'html') return ct.includes('html') || detectKind(contentType, body) === 'html';
  if (expect === 'xml') return ct.includes('xml') || detectKind(contentType, body) === 'xml';
  if (expect === 'csv') return ct.includes('csv') || looksCsv(body);
  return true;
}

function looksCsv(body: string): boolean {
  const text = body.trim();
  if (!text || /^[<{[]/.test(text)) return false;
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.length >= 2 && lines[0].includes(',');
}

/** The mongolbank shape: a 200 whose own <title> or first <h1> says not found. */
function softNotFound(body: string): string | undefined {
  const candidates = [
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1],
    /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1],
  ];
  const hit = candidates.find(text => typeof text === 'string' && SOFT_404.test(text));
  if (!hit) return undefined;
  return `soft 404: the page says "${stripTags(hit).slice(0, 120)}"`;
}

function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
