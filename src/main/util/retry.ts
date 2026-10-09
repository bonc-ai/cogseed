import { createLogger } from '../logger';
import { logErrorRef } from './log-redact';

const log = createLogger('retry');

export const DEFAULT_NETWORK_RETRY_ATTEMPTS = 3;
export const DEFAULT_NETWORK_RETRY_DELAYS_MS = [500, 1_000, 2_000];

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
interface RetryOptions {
  retries?: number;
  delaysMs?: number[];
}

export interface FetchRetryOptions extends RetryOptions {
  /** Per-attempt wall-clock timeout. Omitted by default so large downloads can opt in deliberately. */
  timeoutMs?: number;
  timeoutMessage?: string;
  isRetriable?: (err: unknown) => boolean;
}

let fetchImplementation: FetchImplementation | null = null;

export function setFetchImplementation(impl: FetchImplementation | null): void {
  fetchImplementation = impl;
}

/**
 * Server error envelope shape shared by the marketplace endpoints.
 * `error.retryable` is advisory only — see `RetriableHttpStatusError`.
 */
export interface ServerErrorEnvelope {
  code?: number;
  msg?: string;
  error?: { code?: string; message?: string; retryable?: boolean };
}

/** Cap the error body we parse; an error envelope is small, a stray HTML page is not. */
const MAX_ERROR_ENVELOPE_CHARS = 64 * 1024;

async function readServerErrorEnvelope(res: Response): Promise<ServerErrorEnvelope | null> {
  try {
    const parsed: unknown = JSON.parse((await res.text()).slice(0, MAX_ERROR_ENVELOPE_CHARS));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as ServerErrorEnvelope;
  } catch {
    // A non-JSON, truncated, or already-consumed body degrades to "no envelope";
    // it must never turn a retriable status into a different failure.
    return null;
  }
}

export class RetriableHttpStatusError extends Error {
  status: number;

  /**
   * Envelope captured before the throw so the reason code survives retry exhaustion (FR-006).
   * Null when the body was absent or not JSON.
   */
  envelope: ServerErrorEnvelope | null;

  constructor(status: number, label = 'request', envelope: ServerErrorEnvelope | null = null) {
    super(`${label} http ${status}`);
    this.name = 'RetriableHttpStatusError';
    this.status = status;
    this.envelope = envelope;
  }
}

/** Reason code lookup for callers normalizing failures after the retries are spent. */
export function serverErrorEnvelopeOf(err: unknown): ServerErrorEnvelope | null {
  return err instanceof RetriableHttpStatusError ? err.envelope : null;
}

export function isRetriableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryAsync<T>(
  label: string,
  fn: () => Promise<T>,
  opts: RetryOptions & {
    isRetriable?: (err: unknown) => boolean;
  } = {},
): Promise<T> {
  const retries = Math.max(0, opts.retries ?? DEFAULT_NETWORK_RETRY_ATTEMPTS);
  const delaysMs = opts.delaysMs ?? DEFAULT_NETWORK_RETRY_DELAYS_MS;
  const isRetriable = opts.isRetriable ?? (() => true);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isRetriable(err)) throw err;
      const nextDelay = delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 0;
      log.warn('request failed; retrying', {
        label,
        attempt: attempt + 1,
        retries,
        next_delay_ms: nextDelay,
        error: logErrorRef(err),
      });
      if (nextDelay > 0) await delay(nextDelay);
    }
  }
  throw lastErr;
}

function composeTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
  timeoutMessage: string,
): { signal?: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  if (!timeoutMs || timeoutMs <= 0) {
    return { signal: parent, cleanup: () => {}, timedOut: () => false };
  }
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error(timeoutMessage));
  }, timeoutMs);
  const onAbort = () => {
    const reason = (parent as (AbortSignal & { reason?: unknown }) | undefined)?.reason;
    controller.abort(reason || new Error('operation aborted'));
  };
  if (parent) {
    if (parent.aborted) onAbort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (parent) parent.removeEventListener?.('abort', onAbort);
    },
    timedOut: () => didTimeout,
  };
}

export async function fetchWithRetry(
  label: string,
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const { response } = await fetchAndReadWithRetry(
    label,
    input,
    init,
    async () => undefined,
    opts,
  );
  return response;
}

/** Keep the request timeout active until the caller has consumed the response body. */
export async function fetchAndReadWithRetry<T>(
  label: string,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  readBody: (response: Response, signal?: AbortSignal) => Promise<T>,
  opts: FetchRetryOptions = {},
): Promise<{ response: Response; body: T }> {
  return retryAsync(label, async () => {
    const timeoutMessage = opts.timeoutMessage || `${label} timed out after ${opts.timeoutMs}ms`;
    const composed = composeTimeoutSignal(init?.signal ?? undefined, opts.timeoutMs, timeoutMessage);
    try {
      const res = await (fetchImplementation || fetch)(input, { ...init, signal: composed.signal });
      if (isRetriableHttpStatus(res.status)) {
        // Retriability is decided by the HTTP status alone. The body is read only so the
        // server's reason code outlives retry exhaustion (FR-006); `error.retryable` is
        // never fed back into the retry decision.
        throw new RetriableHttpStatusError(res.status, label, await readServerErrorEnvelope(res));
      }
      return { response: res, body: await readBody(res, composed.signal) };
    } catch (err) {
      if (composed.timedOut()) throw new Error(timeoutMessage);
      throw err;
    } finally {
      composed.cleanup();
    }
  }, {
    retries: opts.retries,
    delaysMs: opts.delaysMs,
    isRetriable: opts.isRetriable,
  });
}
