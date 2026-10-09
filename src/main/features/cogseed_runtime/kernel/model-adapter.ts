export interface RuntimeModelToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RuntimeModelRequest {
  userId: string;
  requestId: string;
  runtimeSessionId: string;
  message: string;
  systemPrompt?: string;
  modelProfile?: string;
  workingDir?: string;
  readOnlyRoots: readonly string[];
  tools: readonly RuntimeModelToolDefinition[];
}

export interface RuntimeModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface RuntimeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type RuntimeModelProviderChunk =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; call: RuntimeModelToolCall }
  | { type: 'usage'; usage: RuntimeModelUsage };

export type RuntimeModelEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; call: RuntimeModelToolCall }
  | { type: 'usage'; usage: RuntimeModelUsage }
  | { type: 'error'; code: RuntimeModelErrorCode; message: string }
  | { type: 'done' };

export type RuntimeModelErrorCode =
  | 'cancelled'
  | 'provider_auth'
  | 'provider_rate_limit'
  | 'provider_server_error'
  | 'provider_network'
  | 'provider_error';

export interface RuntimeModelProviderInput extends RuntimeModelRequest {
  signal?: AbortSignal | null;
}

export type RuntimeModelProvider = (input: RuntimeModelProviderInput) => AsyncIterable<RuntimeModelProviderChunk>;

export interface RuntimeModelRunOptions {
  signal?: AbortSignal | null;
}

export interface RuntimeModelAdapter {
  stream(request: RuntimeModelRequest, options?: RuntimeModelRunOptions): AsyncGenerator<RuntimeModelEvent, void, unknown>;
}

export interface RuntimeModelAdapterDeps {
  provider: RuntimeModelProvider;
}

const ABORT_ERROR = Symbol('runtime-model-abort');

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readNumber(record: Record<string, unknown> | null, keys: readonly string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  }
  return undefined;
}

function readString(record: Record<string, unknown> | null, keys: readonly string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function nestedRecord(record: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  return asRecord(record?.[key]);
}

function statusFromError(error: unknown): number | undefined {
  const record = asRecord(error);
  return readNumber(record, ['status', 'statusCode', 'httpStatus', 'http_status'])
    ?? readNumber(nestedRecord(record, 'response'), ['status', 'statusCode', 'httpStatus'])
    ?? readNumber(nestedRecord(record, 'cause'), ['status', 'statusCode', 'httpStatus']);
}

function messageFromError(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const record = asRecord(error);
  return readString(record, ['message', 'error', 'error_message', 'detail'])
    ?? readString(nestedRecord(record, 'response'), ['message', 'error', 'error_message', 'statusText'])
    ?? readString(nestedRecord(record, 'cause'), ['message', 'error', 'error_message'])
    ?? 'runtime model provider failed';
}

function codeTextFromError(error: unknown): string {
  const record = asRecord(error);
  const parts = [
    readString(record, ['code', 'error_code', 'type', 'name']),
    readString(nestedRecord(record, 'response'), ['code', 'error_code', 'type', 'name']),
    readString(nestedRecord(record, 'cause'), ['code', 'error_code', 'type', 'name']),
  ].filter(Boolean);
  return parts.join(' ');
}

export function normalizeRuntimeModelError(error: unknown): { code: RuntimeModelErrorCode; message: string } {
  if (error === ABORT_ERROR) {
    return { code: 'cancelled', message: 'runtime model request aborted' };
  }

  const status = statusFromError(error);
  const message = messageFromError(error);
  const haystack = `${status ?? ''} ${codeTextFromError(error)} ${message}`.toLowerCase();

  if (haystack.includes('abort') || haystack.includes('cancel')) {
    return { code: 'cancelled', message };
  }
  if (status === 401 || status === 403 || /\b(auth|unauthori[sz]ed|forbidden|permission denied)\b/.test(haystack)) {
    return { code: 'provider_auth', message };
  }
  if (status === 429 || /\b(rate.?limit|too many requests|throttl(?:e|ed|ing)|quota)\b/.test(haystack)) {
    return { code: 'provider_rate_limit', message };
  }
  if ((status !== undefined && status >= 500 && status <= 599)
    || /\b(5\d\d|service unavailable|internal server error|bad gateway|gateway timeout|upstream|server busy)\b/.test(haystack)) {
    return { code: 'provider_server_error', message };
  }
  if (/\b(network|fetch failed|econnreset|econnrefused|etimedout|eai_again|enotfound|socket hang up|timed out|timeout)\b/.test(haystack)) {
    return { code: 'provider_network', message };
  }
  return { code: 'provider_error', message };
}

async function nextProviderChunk<T>(iterator: AsyncIterator<T>, signal?: AbortSignal | null): Promise<IteratorResult<T>> {
  if (!signal) return iterator.next();
  if (signal.aborted) throw ABORT_ERROR;

  return new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => settle(() => reject(ABORT_ERROR));

    signal.addEventListener('abort', onAbort, { once: true });
    iterator.next().then(
      (result) => settle(() => resolve(result)),
      (error) => settle(() => reject(error)),
    );
  });
}

async function closeIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  if (!iterator.return) return;
  try {
    await iterator.return();
  } catch {
    // Ignore provider cleanup failures after the adapter has emitted a stable
    // terminal event. The cleanup error is not actionable for callers.
  }
}

export function createRuntimeModelAdapter(deps: RuntimeModelAdapterDeps): RuntimeModelAdapter {
  return {
    async *stream(request: RuntimeModelRequest, options: RuntimeModelRunOptions = {}): AsyncGenerator<RuntimeModelEvent, void, unknown> {
      const signal = options.signal ?? null;
      let iterator: AsyncIterator<RuntimeModelProviderChunk> | null = null;
      try {
        const iterable = deps.provider({ ...request, signal });
        iterator = iterable[Symbol.asyncIterator]();
        while (true) {
          const next = await nextProviderChunk(iterator, signal);
          if (next.done) break;
          const chunk = next.value;
          if (signal?.aborted) throw ABORT_ERROR;

          if (chunk.type === 'delta') {
            yield { type: 'delta', text: chunk.text };
          } else if (chunk.type === 'tool_call') {
            yield { type: 'tool_call', call: chunk.call };
          } else if (chunk.type === 'usage') {
            yield { type: 'usage', usage: chunk.usage };
          }
        }
      } catch (error) {
        const normalized = normalizeRuntimeModelError(error);
        yield { type: 'error', code: normalized.code, message: normalized.message };
      } finally {
        if (iterator) await closeIterator(iterator);
      }

      yield { type: 'done' };
    },
  };
}
