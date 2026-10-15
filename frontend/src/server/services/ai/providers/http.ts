import { AiProviderError } from '../types';

// JSON POST with a per-attempt timeout and bounded retries, shared by the
// fetch-based adapters. Retries transient failures (network errors, 408, 409,
// 429 and 5xx) with exponential backoff and jitter, honouring Retry-After /
// retry-after-ms. A quota-exhausted 429 is not retried: it won't recover.

export const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 20_000; // beyond this, fail fast rather than hold the request open

export interface PostOptions {
  label: string;
  timeoutMs?: number | null;
  retries?: number;
}

export const sleep = { fn: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };

/** Delay requested by the server, in ms, or null. */
export function retryAfterMs(headers: { get(name: string): string | null } | undefined): number | null {
  if (!headers || typeof headers.get !== 'function') return null;
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.get('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function backoffMs(attempt: number): number {
  const base = Math.min(8_000, 500 * 2 ** attempt);
  return base * (0.75 + Math.random() * 0.5);
}

function errorMessage(body: any, status: number): string {
  const e = body?.error;
  if (typeof e === 'string') return e;
  return e?.message || body?.message || `HTTP ${status}`;
}

function isQuotaError(body: any): boolean {
  const code = body?.error?.code || body?.error?.type;
  return code === 'insufficient_quota';
}

/** Maps an HTTP failure to an AiProviderError with a status the API can return. */
export function providerHttpError(label: string, status: number, body: unknown): AiProviderError {
  const message = errorMessage(body, status);
  if (status === 401 || status === 403) return new AiProviderError(`${label} rejected the API key or its permissions: ${message}`, 400);
  if (status === 404) return new AiProviderError(`${label} could not find that model or deployment: ${message}`, 400);
  if (status === 429) {
    return isQuotaError(body)
      ? new AiProviderError(`${label} account is out of quota or credit: ${message}`, 429)
      : new AiProviderError(`${label} is rate limiting requests; try again shortly`, 429);
  }
  if (status >= 400 && status < 500) return new AiProviderError(`${label} rejected the request: ${message}`, 400);
  return new AiProviderError(`${label} API error ${status}: ${message}`, 502);
}

function isRetryable(status: number, body: unknown, headers: { get(name: string): string | null } | undefined): boolean {
  const hint = headers && typeof headers.get === 'function' ? headers.get('x-should-retry') : null;
  if (hint === 'true') return true;
  if (hint === 'false') return false;
  if (status === 429) return !isQuotaError(body);
  return status === 408 || status === 409 || status >= 500;
}

export async function postJson(url: string, headers: Record<string, string>, payload: unknown, options: PostOptions): Promise<any> {
  const { label } = options;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        // Not retried: the caller is a person waiting on an HTTP request.
        throw new AiProviderError(`${label} did not respond within ${Math.round(timeoutMs / 1000)}s`, 504);
      }
      if (attempt < retries) {
        await sleep.fn(backoffMs(attempt));
        continue;
      }
      throw new AiProviderError(`Could not reach ${label}: ${(error as Error)?.message || 'network error'}`, 502);
    }

    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;

    if (attempt < retries && isRetryable(res.status, body, res.headers)) {
      const delay = retryAfterMs(res.headers) ?? backoffMs(attempt);
      if (delay <= MAX_RETRY_DELAY_MS) {
        await sleep.fn(delay);
        continue;
      }
    }
    throw providerHttpError(label, res.status, body);
  }
}
