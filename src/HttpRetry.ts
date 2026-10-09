/**
 * One HTTP JSON request with retries for transient failures: a connection
 * the server drops mid-response ("terminated"), a reset, 429, or a 5xx.
 * DeepSeek dropped connections twice in a row during issue #17's run, and
 * each drop halted the whole run although the next request would have
 * worked. A timeout, the caller's own abort, or a 4xx is not retried.
 */
export class HttpStatusError extends Error {
  constructor(readonly status: number, readonly statusText: string, readonly body: string, label: string) {
    super(`${label} request failed: ${status} ${statusText} ${body.slice(0, 300)}`.trim());
    this.name = 'HttpStatusError';
  }
}

export interface RetryOptions {
  label: string;
  timeoutMs?: number;
  /** The caller's own signal; aborting it stops at once, never retried. */
  signal?: AbortSignal;
  attempts?: number;
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
const TRANSIENT = /terminated|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket hang up|other side closed|fetch failed|UND_ERR_SOCKET|UND_ERR_CLOSED|network error/i;

export function isTransient(error: unknown): boolean {
  const e = error as any;
  return TRANSIENT.test(`${e?.message || ''} ${e?.cause?.message || ''} ${e?.cause?.code || ''} ${e?.code || ''}`);
}

export async function requestJson<T = any>(fetchImpl: typeof fetch, url: string, init: RequestInit, options: RetryOptions): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delays = options.delaysMs ?? [2000, 5000];
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const timeout = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
    const signals = [options.signal, timeout].filter(Boolean) as AbortSignal[];
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    try {
      const response = await fetchImpl(url, { ...init, ...(signal ? { signal } : {}) });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const error = new HttpStatusError(response.status, response.statusText, body, options.label);
        if (!RETRY_STATUS.has(response.status) || attempt === attempts) throw error;
        lastError = error;
      } else {
        return await response.json() as T;
      }
    } catch (error) {
      if (error instanceof HttpStatusError) throw error;
      if (options.signal?.aborted || timeout?.aborted) throw error;
      if (!isTransient(error) || attempt === attempts) throw error;
      lastError = error;
    }
    await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 2000);
  }
  throw lastError;
}
