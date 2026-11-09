/**
 * Scoped, bounded observation of OpenAI-compatible SSE usage. Install lazily at
 * SDK creation time, retaining the current fetch (including proxy routing) as a
 * stable delegate. Replacements are wrapped on the next run; nested wrappers
 * delegate without observing twice. No request bodies or headers are inspected.
 *
 * Bodies are read only on downstream pull, one chunk at a time, without teeing.
 * SSE text is transient: combined line/event storage is <=64K UTF-16 code units
 * (128 KiB), decoding uses 4 KiB slices, and only the latest numeric usage and
 * bounded identifiers survive parsing. Malformed/limited/failed observations
 * disable cache recovery without changing transport bytes or failure behavior.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Usage } from '../shared/types.js';

export type OpenAIWireDiagnostics = {
  rawPromptTokens?: number;
  usageBlocks: number;
  /** Presence in the latest raw usage block, independent of validity/recovery. */
  cacheReadPresent: boolean;
  cacheWritePresent: boolean;
  cacheReadKnown: boolean;
  cacheWriteKnown: boolean;
  trailerRecovered: boolean;
  status: 'unobserved' | 'observing' | 'complete' | 'malformed' | 'limit' | 'error' | 'cancelled';
  reportedModel?: string;
  peakBufferedChars: number;
};

type FetchArgs = Parameters<typeof fetch>;
type Scope = { matches(input: FetchArgs[0]): boolean; observe(delegate: typeof fetch, receiver: unknown, args: FetchArgs): Promise<Response> };
const captures = new AsyncLocalStorage<Scope>();
const delegating = new AsyncLocalStorage<boolean>();
const wrappers = new WeakSet<typeof fetch>();
const delegates = new WeakMap<typeof fetch, typeof fetch>();

function installObserver(): void {
  const previous = globalThis.fetch;
  if (wrappers.has(previous)) return;
  let wrapper = delegates.get(previous);
  if (!wrapper) {
    wrapper = function (this: unknown, ...args: FetchArgs): Promise<Response> {
      const scope = captures.getStore();
      if (delegating.getStore() || !scope || !scope.matches(args[0])) {
        return Reflect.apply(previous, this, args);
      }
      return scope.observe(previous, this, args);
    };
    wrappers.add(wrapper);
    delegates.set(previous, wrapper);
  }
  globalThis.fetch = wrapper;
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: RecordValue, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const identifier = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/.test(value) ? value : undefined;
const MAX_BUFFER_CHARS = 64 * 1024;

/** Minimal SSE framing, including split CRLF, bare CR, BOM and data folding. */
class BoundedSSE {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private line = '';
  private data = '';
  private dataSeen = false;
  private afterCR = false;
  private stopped = false;
  completed = false;

  constructor(
    private event: (value: RecordValue) => void,
    private complete: () => void,
    private fault: (status: 'malformed' | 'limit') => void,
    private peak: (chars: number) => void,
  ) {}

  private fail(status: 'malformed' | 'limit'): void {
    this.stopped = true;
    this.line = this.data = '';
    this.dataSeen = false;
    this.fault(status);
  }

  private newline(): void {
    const line = this.line;
    this.line = '';
    if (line === '') {
      if (!this.dataSeen) return;
      const text = this.data;
      this.data = '';
      this.dataSeen = false;
      if (text === '[DONE]') {
        this.completed = this.stopped = true;
        this.complete();
      } else if (text !== '') {
        try {
          const value: unknown = JSON.parse(text);
          if (!record(value)) this.fail('malformed');
          else this.event(value);
        } catch { this.fail('malformed'); }
      }
      return;
    }
    if (line !== 'data' && !line.startsWith('data:')) return;
    let value = line === 'data' ? '' : line.slice(5);
    if (value.startsWith(' ')) value = value.slice(1);
    const size = this.data.length + value.length + (this.dataSeen ? 1 : 0);
    if (size > MAX_BUFFER_CHARS) return this.fail('limit');
    this.data += (this.dataSeen ? '\n' : '') + value;
    this.dataSeen = true;
    this.peak(size);
  }

  private text(text: string): void {
    for (const char of text) {
      if (this.stopped) return;
      if (this.afterCR) {
        this.afterCR = false;
        if (char === '\n') continue;
      }
      if (char === '\r' || char === '\n') {
        this.newline();
        this.afterCR = char === '\r';
      } else {
        const size = this.line.length + this.data.length + char.length;
        if (size > MAX_BUFFER_CHARS) return this.fail('limit');
        this.line += char;
        this.peak(size);
      }
    }
  }

  bytes(bytes: Uint8Array): void {
    if (this.stopped) return;
    try {
      for (let offset = 0; offset < bytes.byteLength && !this.stopped; offset += 4096) {
        this.text(this.decoder.decode(bytes.subarray(offset, offset + 4096), { stream: true }));
      }
    } catch { this.fail('malformed'); }
  }

  end(): void {
    if (this.stopped) return;
    try { this.text(this.decoder.decode()); } catch { return this.fail('malformed'); }
    if (this.line !== '' || this.dataSeen) return this.fail('malformed');
    this.completed = this.stopped = true;
    this.complete();
  }
}

type Sample = {
  id?: string;
  prompt?: number;
  output?: number;
  total?: number;
  read?: number;
  write?: number;
  readPresent: boolean;
  writePresent: boolean;
  recovered: boolean;
};
const emptySample = (): Sample => ({ readPresent: false, writePresent: false, recovered: false });

export class OpenAIWireCapture {
  private origin?: string;
  private pathname?: string;
  private sequence = 0;
  private observed = false;
  private sample = emptySample();
  private responseId?: string;
  private model?: string;
  /** SDK model provenance cannot be recovered after a wire identity conflict. */
  private identityInvalidated = false;
  private usageBlocks = 0;
  private peakBufferedChars = 0;
  private status: OpenAIWireDiagnostics['status'] = 'unobserved';
  private readonly scope: Scope;
  private readonly api: 'openai-completions' | 'openai-responses';

  constructor({ baseUrl, api = 'openai-completions' }: { baseUrl: string; api?: 'openai-completions' | 'openai-responses' }) {
    this.api = api;
    try {
      const url = new URL(baseUrl);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        this.origin = url.origin;
        const path = url.pathname.replace(/\/+$/, '');
        const endpoint = api === 'openai-responses' ? '/responses' : '/chat/completions';
        this.pathname = path.endsWith(endpoint) ? path : `${path}${endpoint}`;
      }
    } catch { /* An invalid base disables observation, never the SDK request. */ }
    this.scope = {
      matches: (input) => this.matches(input),
      observe: (delegate, receiver, args) => this.observe(delegate, receiver, args),
    };
  }

  /** Wrap real SDK promise/stream creation; consumption may happen outside run. */
  run<T>(callback: () => T): T {
    installObserver();
    return captures.run(this.scope, callback);
  }

  private matches(input: FetchArgs[0]): boolean {
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return url.origin === this.origin && url.pathname === this.pathname;
    } catch { return false; }
  }

  private invalidate(status: OpenAIWireDiagnostics['status']): void {
    this.status = status;
    this.sample.read = this.sample.write = undefined;
    this.sample.recovered = false;
  }

  private accept(value: RecordValue): void {
    // Responses uses an event envelope; identity/usage belong to response,
    // while delta/output-item events carry no response-level accounting.
    if (this.api === 'openai-responses') {
      if (!record(value.response)) return;
      value = value.response;
    }
    const id = identifier(value.id);
    if (own(value, 'id')) {
      if (id === undefined || (this.responseId !== undefined && id !== this.responseId)) {
        this.identityInvalidated = true;
        this.sample = emptySample();
        this.model = undefined;
      }
      this.responseId = id;
    }
    if (own(value, 'model')) {
      const model = identifier(value.model);
      if (model === undefined || (this.model !== undefined && model !== this.model)) {
        this.identityInvalidated = true;
        this.sample = emptySample();
      }
      this.model = model;
    }
    const choice = Array.isArray(value.choices) && record(value.choices[0]) ? value.choices[0] : undefined;
    const raw = value.usage ?? choice?.usage;
    if (raw === undefined || raw === null) return;
    this.usageBlocks = Math.min(Number.MAX_SAFE_INTEGER, this.usageBlocks + 1);
    if (!record(raw)) { this.sample = emptySample(); this.invalidate('malformed'); return; }
    const promptKey = this.api === 'openai-responses' ? 'input_tokens' : 'prompt_tokens';
    const detailsKey = this.api === 'openai-responses' ? 'input_tokens_details' : 'prompt_tokens_details';
    const prompt = count(raw[promptKey]);
    const output = count(raw[this.api === 'openai-responses' ? 'output_tokens' : 'completion_tokens']);
    // SDKs synthesize zero totals too. Derive only from two known inclusive
    // counts; an explicitly invalid total must never fall back to that sum.
    const total = own(raw, 'total_tokens') ? count(raw.total_tokens)
      : prompt !== undefined && output !== undefined ? count(prompt + output) : undefined;
    const details = record(raw[detailsKey]) ? raw[detailsKey] : undefined;
    const detailsValid = !own(raw, detailsKey) || details !== undefined;
    const primaryRead = details !== undefined && own(details, 'cached_tokens');
    const aliasRead = this.api === 'openai-completions' && own(raw, 'prompt_cache_hit_tokens');
    const readPresent = primaryRead || aliasRead;
    const writePresent = details !== undefined && own(details, 'cache_write_tokens');
    const sameScope = id !== undefined && id === this.sample.id && prompt !== undefined && prompt === this.sample.prompt;
    const carry = sameScope && detailsValid;
    let read = primaryRead ? count(details!.cached_tokens) : aliasRead ? count(raw.prompt_cache_hit_tokens) : carry ? this.sample.read : undefined;
    let write = writePresent ? count(details!.cache_write_tokens) : carry ? this.sample.write : undefined;
    if (primaryRead && aliasRead && count(raw.prompt_cache_hit_tokens) !== read) read = undefined;
    let recovered = (!readPresent && read !== undefined) || (!writePresent && write !== undefined);
    if ((own(raw, promptKey) && prompt === undefined) || (prompt !== undefined && ((read !== undefined && read > prompt) || (write !== undefined && write > prompt) || (read !== undefined && write !== undefined && read > prompt - write)))) {
      read = write = undefined;
      recovered = false;
    }
    this.sample = { id, prompt, output, total, read, write, readPresent, writePresent, recovered };
  }

  private async observe(delegate: typeof fetch, receiver: unknown, args: FetchArgs): Promise<Response> {
    const sequence = ++this.sequence;
    this.observed = true;
    this.sample = emptySample();
    this.responseId = this.model = undefined;
    this.identityInvalidated = false;
    this.usageBlocks = this.peakBufferedChars = 0;
    this.status = 'observing';
    const active = () => sequence === this.sequence;
    let response: Response;
    try {
      response = await delegating.run(true, () => Reflect.apply(delegate, receiver, args));
    } catch (error) {
      if (active()) this.invalidate('error');
      throw error;
    }
    if (!active()) return response;
    if (!response.body || response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'text/event-stream') {
      this.status = 'unobserved';
      return response;
    }
    let failed = false;
    const parser = new BoundedSSE(
      (value) => { if (active() && !failed) { this.accept(value); if (this.status === 'malformed') failed = true; } },
      () => { if (active() && !failed) this.status = 'complete'; },
      (status) => { failed = true; if (active()) this.invalidate(status); },
      (chars) => { if (active()) this.peakBufferedChars = Math.max(this.peakBufferedChars, chars); },
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      reader = response.body.getReader();
      const source = reader;
      let closed = false;
      const body = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          try {
            const result = await source.read();
            if (closed) return;
            if (result.done) {
              closed = true;
              if (active() && !failed) parser.end();
              source.releaseLock();
              controller.close();
            } else {
              if (active() && !failed) parser.bytes(result.value);
              controller.enqueue(result.value);
            }
          } catch (error) {
            if (closed) return;
            closed = true;
            if (active()) this.invalidate('error');
            source.releaseLock();
            controller.error(error);
          }
        },
        cancel: async (reason) => {
          closed = true;
          if (active() && !parser.completed && !failed) this.invalidate('cancelled');
          try { await source.cancel(reason); } finally { source.releaseLock(); }
        },
      }, { highWaterMark: 0 });
      const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      Object.defineProperties(wrapped, {
        url: { value: response.url },
        redirected: { value: response.redirected },
        type: { value: response.type },
      });
      return wrapped;
    } catch {
      reader?.releaseLock();
      this.invalidate('error');
      return response;
    }
  }

  finish(sdkUsage: Usage, sdkReportedModel?: string): { usage: Partial<Usage>; reportedModel?: string; diagnostics: OpenAIWireDiagnostics } {
    const reportedModel = this.model ?? (this.identityInvalidated ? undefined : identifier(sdkReportedModel));
    const sample = this.sample;
    const complete = this.status === 'complete';
    const read = complete ? sample.read : undefined;
    const write = complete ? sample.write : undefined;
    // No matching HTTP call is a true bypass (e.g. a custom SDK transport).
    // Once HTTP was seen, SDK defaulted zeroes cannot prove wire presence.
    const normalizedInput = sample.prompt !== undefined && read !== undefined && write !== undefined
      ? sample.prompt - read - write : count(sdkUsage.inputTokens);
    // Independently gate every count on raw evidence. A present but empty or
    // malformed usage block must not expose any SDK defaulted numeric zero.
    const usage: Partial<Usage> = this.observed && this.status !== 'unobserved' ? {
      ...(sample.prompt !== undefined && normalizedInput !== undefined && normalizedInput <= sample.prompt ? { inputTokens: normalizedInput } : {}),
      ...(sample.output !== undefined ? { outputTokens: sample.output } : {}),
      ...(sample.total !== undefined ? { totalTokens: sample.total } : {}),
      ...(sample.prompt !== undefined ? { totalInputTokens: sample.prompt } : {}),
      ...(read !== undefined ? { cacheReadTokens: read } : {}),
      ...(write !== undefined ? { cacheWriteTokens: write } : {}),
    } : this.observed ? {
      inputTokens: sdkUsage.inputTokens, outputTokens: sdkUsage.outputTokens, totalTokens: sdkUsage.totalTokens,
    } : { ...sdkUsage };
    return {
      usage,
      ...(reportedModel !== undefined ? { reportedModel } : {}),
      diagnostics: {
        ...(sample.prompt !== undefined ? { rawPromptTokens: sample.prompt } : {}),
        usageBlocks: this.usageBlocks,
        cacheReadPresent: sample.readPresent,
        cacheWritePresent: sample.writePresent,
        cacheReadKnown: read !== undefined,
        cacheWriteKnown: write !== undefined,
        trailerRecovered: complete && sample.recovered,
        status: this.status,
        ...(reportedModel !== undefined ? { reportedModel } : {}),
        peakBufferedChars: this.peakBufferedChars,
      },
    };
  }
}
