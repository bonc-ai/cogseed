import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Usage } from '../src/shared/types.js';

// The module does not exist on the first (red) run. Resolve it in a test so
// the first failure reports the missing public contract, not a collection error.
let OpenAIWireCapture: typeof import('../src/providers/openai-wire-usage.js').OpenAIWireCapture;
const originalFetch = globalThis.fetch;
let installedFetch: typeof fetch;
let transport: typeof fetch;
const proxyFetch = vi.fn(function (this: unknown, ...args: Parameters<typeof fetch>) {
  return Reflect.apply(transport, this, args);
});
const url = 'https://wire.invalid/v1/chat/completions';
const sdk: Usage = { inputTokens: 91, outputTokens: 7, totalTokens: 107, cacheReadTokens: 0, cacheWriteTokens: 0 };
const required = { inputTokens: 91, outputTokens: 7, totalTokens: 107 };
const encoder = new TextEncoder();
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const block = (usage: unknown, id = 'chatcmpl-a', model = 'reported-model') => frame({ id, model, usage });
const done = 'data: [DONE]\n\n';
const counts = (read: unknown, write: unknown = 0, prompt = 100) => ({
  prompt_tokens: prompt, completion_tokens: 7,
  prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write },
});
function response(text: string, step = 8192) {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset += step));
    },
  }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'x-pass-through': 'yes' } });
}
async function observed(text: string, fallback = sdk, step?: number) {
  transport = vi.fn(async () => response(text, step));
  const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
  const returned = await capture.run(async () => {
    await Promise.resolve(); // SDK work can start after its factory returns.
    return fetch(url);
  });
  expect(new Uint8Array(await returned.arrayBuffer())).toEqual(encoder.encode(text));
  return capture.finish(fallback);
}

beforeAll(async () => {
  globalThis.fetch = proxyFetch as typeof fetch;
  try {
    ({ OpenAIWireCapture } = await import('../src/providers/openai-wire-usage.js'));
  } catch { /* Assert the absent contract in the red run below. */ }
});
beforeEach(() => {
  proxyFetch.mockClear();
  transport = vi.fn(async () => response(done));
  if (installedFetch) globalThis.fetch = installedFetch;
});
afterEach(() => {
  if (!installedFetch && OpenAIWireCapture) installedFetch = globalThis.fetch;
  if (installedFetch) globalThis.fetch = installedFetch;
});
afterAll(() => { globalThis.fetch = originalFetch; });

describe('OpenAIWireCapture wire contract', () => {
  it('exports the scoped capture API', () => { expect(OpenAIWireCapture).toBeTypeOf('function'); });

  it('replaces SDK late zeros with independent wire counts and reported model', async () => {
    const result = await observed(block(counts(60, 10)) + done);
    expect(result.usage).toStrictEqual({ inputTokens: 30, outputTokens: 7, totalTokens: 107, totalInputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 10 });
    expect(result.reportedModel).toBe('reported-model');
    expect(result.diagnostics).toMatchObject({ rawPromptTokens: 100, usageBlocks: 1, cacheReadPresent: true, cacheWritePresent: true, cacheReadKnown: true, cacheWriteKnown: true, trailerRecovered: false, status: 'complete', reportedModel: 'reported-model' });
  });

  it('keeps absent cache fields unknown, including on the official OpenAI origin', async () => {
    transport = vi.fn(async () => response(block({ prompt_tokens: 100 }) + done));
    const capture = new OpenAIWireCapture({ baseUrl: 'https://api.openai.com/v1' });
    await (await capture.run(() => fetch('https://api.openai.com/v1/chat/completions'))).text();
    expect(capture.finish(sdk).usage).toStrictEqual({ inputTokens: 91, totalInputTokens: 100 });
    expect(capture.finish(sdk).diagnostics).toMatchObject({ cacheReadPresent: false, cacheWritePresent: false });
  });

  it('reports raw prompt total and known read without inventing a write bucket', async () => {
    const result = await observed(block({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } }) + done);
    expect(result.usage).toStrictEqual({ inputTokens: 91, totalInputTokens: 100, cacheReadTokens: 80 });
    expect(result.diagnostics).toMatchObject({ cacheReadPresent: true, cacheWritePresent: false, cacheReadKnown: true, cacheWriteKnown: false });
  });

  it('lets the latest explicit zero win, rather than selecting the maximum', async () => {
    const result = await observed(block(counts(90, 10)) + block(counts(0, 0)) + done);
    expect(result.usage).toStrictEqual({ inputTokens: 100, outputTokens: 7, totalTokens: 107, totalInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('recovers an incomplete cumulative trailer only with the same ID and explicit prompt total', async () => {
    const result = await observed(block(counts(60, 10)) + block({ prompt_tokens: 100, completion_tokens: 7 }) + done);
    expect(result.usage.cacheReadTokens).toBe(60);
    expect(result.usage.inputTokens).toBe(30);
    expect(result.diagnostics).toMatchObject({ usageBlocks: 2, cacheReadPresent: false, cacheWritePresent: false, cacheReadKnown: true, cacheWriteKnown: true, trailerRecovered: true });
  });

  it.each([
    ['changed prompt', block({ prompt_tokens: 200 })],
    ['changed response ID', block({ prompt_tokens: 100 }, 'chatcmpl-b')],
    ['missing response ID', frame({ usage: { prompt_tokens: 100 } })],
    ['missing prompt total', block({ completion_tokens: 7 })],
    ['invalid prompt total', block({ prompt_tokens: -1 })],
  ])('does not retain a previous cache hit across %s', async (_name, trailer) => {
    const result = await observed(block(counts(60, 10)) + trailer + done);
    expect(result.usage).not.toHaveProperty('cacheReadTokens');
    expect(result.usage).not.toHaveProperty('cacheWriteTokens');
    expect(result.diagnostics.trailerRecovered).toBe(false);
  });

  it('does not combine a changed response ID with earlier prompt or model fields', async () => {
    const result = await observed(block(counts(60, 10)) + frame({ id: 'chatcmpl-b', choices: [] }) + done);
    expect(result.usage).toStrictEqual({});
    expect(result.reportedModel).toBeUndefined();
  });

  it.each(['chatcmpl-b', 'invalid response id'])('suppresses a stale SDK model after response identity changes to %s', async (id) => {
    transport = vi.fn(async () => response(block(counts(60, 10), 'chatcmpl-a', 'model-a') + frame({ id, choices: [] }) + done));
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    await (await capture.run(() => fetch(url))).text();
    const result = capture.finish(sdk, 'model-a');
    expect(result).not.toHaveProperty('reportedModel');
    expect(result.diagnostics).not.toHaveProperty('reportedModel');
    expect(result.usage).toStrictEqual({});
  });

  it('uses a new explicit wire model after an identity conflict without inheriting prior cache evidence', async () => {
    transport = vi.fn(async () => response(block(counts(60, 10), 'chatcmpl-a', 'model-a') + block({ prompt_tokens: 100 }, 'chatcmpl-a', 'model-b') + done));
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    await (await capture.run(() => fetch(url))).text();
    const result = capture.finish(sdk, 'model-a');
    expect(result.reportedModel).toBe('model-b');
    expect(result.diagnostics.reportedModel).toBe('model-b');
    expect(result.usage).toStrictEqual({ inputTokens: 91, totalInputTokens: 100 });
    expect(result.diagnostics.trailerRecovered).toBe(false);
  });

  it('does not restore an SDK model after a same-ID model conflict loses a usable wire model', async () => {
    const text = block(counts(60, 10), 'chatcmpl-a', 'model-a') + frame({ id: 'chatcmpl-a', model: 'model-b' }) + frame({ id: 'chatcmpl-a', model: null }) + done;
    transport = vi.fn(async () => response(text));
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    await (await capture.run(() => fetch(url))).text();
    const result = capture.finish(sdk, 'model-a');
    expect(result).not.toHaveProperty('reportedModel');
    expect(result.diagnostics).not.toHaveProperty('reportedModel');
    expect(result.usage).toStrictEqual({});
    // A fresh HTTP request has its own model provenance and may use fallback.
    transport = vi.fn(async () => response(done));
    await (await capture.run(() => fetch(url))).text();
    expect(capture.finish(sdk, 'fresh-sdk-model').reportedModel).toBe('fresh-sdk-model');
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '60', null, {}, []])('rejects invalid cache counts while recording field presence: %s', async (value) => {
    const result = await observed(block(counts(value, value)) + done);
    expect(result.usage).toStrictEqual({ ...required, totalInputTokens: 100 });
    expect(result.diagnostics).toMatchObject({ cacheReadPresent: true, cacheWritePresent: true, cacheReadKnown: false, cacheWriteKnown: false });
  });

  it.each([[101, 0], [90, 11], [Number.MAX_SAFE_INTEGER, 1]])('rejects impossible cache sums %s + %s', async (read, write) => {
    const result = await observed(block(counts(read, write)) + done);
    expect(result.usage).toStrictEqual({ ...required, totalInputTokens: 100 });
  });

  it.each([-1, 0.5, '100', null])('treats explicit invalid raw prompt counts as unknown rather than endorsing their cache breakdown: %s', async (prompt) => {
    const result = await observed(block({ ...counts(60, 0), prompt_tokens: prompt }) + done);
    expect(result.usage).toStrictEqual({ outputTokens: 7 });
    expect(result.diagnostics).toMatchObject({ cacheReadPresent: true, cacheWritePresent: true, cacheReadKnown: false, cacheWriteKnown: false });
  });

  it('invalidates a carried bucket if a new explicit bucket makes its sum impossible', async () => {
    const result = await observed(block(counts(90, 10)) + block({ prompt_tokens: 100, prompt_tokens_details: { cache_write_tokens: 11 } }) + done);
    expect(result.usage).not.toHaveProperty('cacheReadTokens');
    expect(result.usage).not.toHaveProperty('cacheWriteTokens');
  });

  it('accepts zero raw prompt tokens and does not reuse SDK raw totals when wire is absent', async () => {
    expect((await observed(block(counts(0, 0, 0)) + done)).usage).toStrictEqual({ inputTokens: 0, outputTokens: 7, totalTokens: 7, totalInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect((await observed(done, { ...sdk, totalInputTokens: 999 })).usage).toStrictEqual({});
  });

  it('supports choices[0].usage and the compatible prompt_cache_hit_tokens alias', async () => {
    const result = await observed(frame({ id: 'chatcmpl-a', choices: [{ usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 70 } }] }) + done);
    expect(result.usage).toStrictEqual({ inputTokens: 91, totalInputTokens: 100, cacheReadTokens: 70 });
  });

  it('prefers top-level usage over choices and rejects conflicting hit aliases', async () => {
    const result = await observed(frame({ id: 'chatcmpl-a', usage: { ...counts(20, 0), prompt_cache_hit_tokens: 30 }, choices: [{ usage: counts(90, 0) }] }) + done);
    expect(result.usage.cacheReadTokens).toBeUndefined();
    expect(result.usage.cacheWriteTokens).toBe(0);
    expect(result.diagnostics.usageBlocks).toBe(1);
  });
});

describe('Responses wire presence', () => {
  const responseEvent = (usage?: unknown, id = 'resp-a') => frame({ type: 'response.completed', response: {
    id, model: 'responses-model', ...(usage !== undefined ? { usage } : {}),
  } });
  async function observeResponses(text: string, baseUrl = 'https://wire.invalid/v1') {
    transport = vi.fn(async () => response(text, 1));
    const capture = new OpenAIWireCapture({ baseUrl, api: 'openai-responses' });
    const returned = await capture.run(() => fetch('https://wire.invalid/v1/responses'));
    expect(new Uint8Array(await returned.arrayBuffer())).toEqual(encoder.encode(text));
    return capture.finish(sdk);
  }

  it.each(['https://wire.invalid/v1', 'https://wire.invalid/v1/responses'])('captures Responses at %s without requiring a [DONE] marker', async baseUrl => {
    const result = await observeResponses(responseEvent({ input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 60 } }), baseUrl);
    expect(result.usage).toStrictEqual({ ...required, totalInputTokens: 100, cacheReadTokens: 60 });
    expect(result.reportedModel).toBe('responses-model');
    expect(result.diagnostics).toMatchObject({ status: 'complete', cacheReadPresent: true, cacheWritePresent: false });
  });

  it.each([undefined, {}, { cached_tokens: null }, { cached_tokens: '0' }, { cached_tokens: -1 }, { cached_tokens: 0.5 }, { cached_tokens: 101 }])('keeps missing or invalid Responses cache details unknown: %s', async details => {
    const result = await observeResponses(responseEvent({ input_tokens: 100, output_tokens: 7, ...(details !== undefined ? { input_tokens_details: details } : {}) }));
    expect(result.usage).toStrictEqual({ ...required, totalInputTokens: 100 });
    expect(result.diagnostics).toMatchObject({ status: 'complete', cacheReadKnown: false, cacheWriteKnown: false });
  });

  it('does not treat a usage-less completed response as reported zero', async () => {
    expect((await observeResponses(responseEvent())).usage).toStrictEqual({});
  });

  it('invalidates cache evidence on a truncated Responses stream', async () => {
    const result = await observeResponses(responseEvent({ input_tokens: 100, input_tokens_details: { cached_tokens: 60 } }) + 'data: {"type":');
    expect(result.usage).not.toHaveProperty('cacheReadTokens');
    expect(result.diagnostics.status).toBe('malformed');
  });

  it('does not observe the completions endpoint inside a Responses capture', async () => {
    transport = vi.fn(async () => response(block(counts(60, 0)) + done));
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1', api: 'openai-responses' });
    await (await capture.run(() => fetch(url))).text();
    expect(capture.finish(sdk).usage).toStrictEqual(sdk);
    expect(capture.finish(sdk).diagnostics.status).toBe('unobserved');
  });
});

describe('bounded SSE parsing', () => {
  it('preserves every UTF8 byte across one-byte chunks, split CRLF, comments and multiline data', async () => {
    const text = ': heartbeat\r\n\r\ndata: {"id":"chatcmpl-a",\r\ndata: "model":"gpt-4.1", "choices":[{"delta":{"content":"秘密 🐣"}}],\r\ndata: "usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":60,"cache_write_tokens":0}}}\r\n\r\ndata: [DONE]\r\n\r\n';
    const result = await observed(text, sdk, 1);
    expect(result.usage.cacheReadTokens).toBe(60);
    expect(result.reportedModel).toBe('gpt-4.1');
    expect(JSON.stringify(result)).not.toContain('秘密');
  });

  it('supports bare CR delimiters and a UTF8 BOM', async () => {
    const result = await observed('\ufeff' + (block(counts(60, 0)) + done).replaceAll('\n', '\r'), sdk, 1);
    expect(result.usage.cacheReadTokens).toBe(60);
  });

  it.each([
    ['malformed', 'data: {broken}\n\n'],
    ['malformed', 'data: {"usage":'],
    ['limit', 'data: ' + 'x'.repeat(150 * 1024) + '\n\n'],
    ['limit', ('data: ' + 'x'.repeat(1024) + '\n').repeat(150) + '\n'],
  ])('passes through %s streams and invalidates earlier cache observations', async (status, bad) => {
    const result = await observed(block(counts(60, 10)) + bad + done);
    expect(result.usage).not.toHaveProperty('cacheReadTokens');
    expect(result.usage).not.toHaveProperty('cacheWriteTokens');
    expect(result.diagnostics.status).toBe(status);
    expect(result.diagnostics.peakBufferedChars).toBeLessThanOrEqual(64 * 1024);
  });

  it('does not retain arbitrary metadata or unsafe model identifiers', async () => {
    const result = await observed(frame({ id: 'secret id\ncredential', model: 'secret model\ncredential', headers: { Authorization: 'secret-token' }, choices: [{ delta: { content: 'secret-prompt' } }], usage: counts(60, 0) }) + done);
    expect(result.reportedModel).toBeUndefined();
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/secret|credential|Authorization/);
    for (const value of Object.values(result.diagnostics)) expect(['string', 'number', 'boolean']).toContain(typeof value);
  });

  it('uses a bounded sanitized SDK reported model fallback without inventing a wire model', async () => {
    transport = vi.fn(async () => response(done));
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    await (await capture.run(() => fetch(url))).text();
    expect(capture.finish(sdk, 'provider/model-v1:2026').reportedModel).toBe('provider/model-v1:2026');
    expect(capture.finish(sdk, 'x'.repeat(1000)).reportedModel).toBeUndefined();
    expect(capture.finish(sdk, 'secret\nmodel').reportedModel).toBeUndefined();
  });

  it('enforces the host 160-character identifier limit for both wire and SDK models', async () => {
    expect((await observed(block(counts(60, 0), 'chatcmpl-a', 'x'.repeat(160)) + done)).reportedModel).toHaveLength(160);
    expect((await observed(block(counts(60, 0), 'chatcmpl-a', 'x'.repeat(161)) + done)).reportedModel).toBeUndefined();
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    expect(capture.finish(sdk, 'x'.repeat(161)).reportedModel).toBeUndefined();
  });

  it('keeps only bounded latest usage through many events', async () => {
    const text = Array.from({ length: 2000 }, (_, i) => block(counts(i % 100, 0))).join('') + done;
    const result = await observed(text);
    expect(result.usage.cacheReadTokens).toBe(99);
    expect(result.diagnostics.usageBlocks).toBe(2000);
    expect(JSON.stringify(result.diagnostics).length).toBeLessThan(1024);
  });
});

describe('fetch scope and transport preservation', () => {
  it('preserves normalized SDK usage when no matching HTTP call occurred', () => {
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    expect(capture.run(() => 42)).toBe(42);
    expect(capture.finish(sdk).usage).toStrictEqual(sdk);
    expect(capture.finish(sdk).diagnostics.status).toBe('unobserved');
  });

  it('preserves callback identity, synchronous throws and nested async contexts', async () => {
    const outer = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    const inner = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    const marker = {};
    expect(outer.run(() => marker)).toBe(marker);
    const error = new Error('callback');
    expect(() => outer.run(() => { throw error; })).toThrow(error);
    transport = vi.fn(async () => response(block(counts(20, 0)) + done));
    const innerResponse = await outer.run(() => inner.run(() => fetch(url)));
    await innerResponse.text();
    expect(inner.finish(sdk).usage.cacheReadTokens).toBe(20);
    expect(outer.finish(sdk).diagnostics.usageBlocks).toBe(0);
  });

  it('isolates concurrent matching requests and excludes requests outside run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    transport = vi.fn(async (_input, init) => {
      const hit = Number(new Headers(init?.headers).get('x-test-hit') ?? 1);
      if (hit === 60) await gate;
      return response(block(counts(hit, 0)) + done);
    });
    const a = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    const b = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    const pa = a.run(async () => { await Promise.resolve(); return fetch(url, { headers: { 'x-test-hit': '60' } }); });
    const pb = b.run(() => fetch(url, { headers: { 'x-test-hit': '20' } }));
    await (await pb).text();
    await (await fetch(url)).text();
    release();
    await (await pa).text();
    expect(a.finish(sdk).usage.cacheReadTokens).toBe(60);
    expect(b.finish(sdk).usage.cacheReadTokens).toBe(20);
    expect(a.finish(sdk).diagnostics.usageBlocks).toBe(1);
    expect(b.finish(sdk).diagnostics.usageBlocks).toBe(1);
  });

  it.each(['https://elsewhere.invalid/v1/chat/completions', 'https://wire.invalid/other/chat/completions', 'https://wire.invalid/v1/responses', 'https://wire.invalid/v1/chat/completions/extra', 'http://wire.invalid/v1/chat/completions'])('does not observe mismatched URL %s', async (otherUrl) => {
    const raw = response(block(counts(60, 0)) + done);
    transport = vi.fn(async () => raw);
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    expect(await capture.run(() => fetch(otherUrl))).toBe(raw);
    expect(capture.finish(sdk).diagnostics.status).toBe('unobserved');
  });

  it('supports URL and Request inputs, queries, trailing base slash and safe response metadata', async () => {
    const raw = response(block(counts(60, 0)) + done);
    Object.defineProperties(raw, { url: { value: url }, redirected: { value: true } });
    transport = vi.fn(async () => raw);
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1/' });
    const returned = await capture.run(() => fetch(new Request(new URL(url + '?stream=true'))));
    expect(returned.url).toBe(url);
    expect(returned.redirected).toBe(true);
    expect(returned.type).toBe(raw.type);
    expect(returned.headers.get('x-pass-through')).toBe('yes');
    await returned.text();
    expect(capture.finish(sdk).usage.cacheReadTokens).toBe(60);
  });

  it.each([new Response('plain', { headers: { 'content-type': 'application/json' } }), new Response(null, { status: 204 })])('preserves non-SSE or bodyless responses by identity', async (raw) => {
    transport = vi.fn(async () => raw);
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    expect(await capture.run(() => fetch(url))).toBe(raw);
    expect(capture.finish(sdk).usage).toStrictEqual(required);
  });

  it('coexists with proxy wrappers before and after installation and preserves request args and receiver', async () => {
    const seam = globalThis.fetch;
    let proxyCalls = 0;
    globalThis.fetch = function (this: unknown, ...args) { proxyCalls++; return Reflect.apply(seam, this, args); };
    transport = vi.fn(async () => response(block(counts(60, 0)) + done));
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    const controller = new AbortController();
    const options = { method: 'POST', headers: { authorization: 'must-not-retain' }, body: 'prompt-must-not-retain', signal: controller.signal, dispatcher: {} };
    const receiver = {};
    const returned = await capture.run(() => Reflect.apply(globalThis.fetch, receiver, [url, options]));
    await returned.text();
    expect(proxyCalls).toBe(1);
    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(url, options);
    expect((transport as ReturnType<typeof vi.fn>).mock.contexts[0]).toBe(receiver);
    expect(capture.finish(sdk).usage.cacheReadTokens).toBe(60);
    expect(JSON.stringify(capture.finish(sdk))).not.toMatch(/must-not-retain/);
  });

  it('rewraps a replaced fetch without bypassing proxy routing or observing nested wrappers twice', async () => {
    const first = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    first.run(() => undefined);
    const previous = globalThis.fetch;
    let routed = 0;
    globalThis.fetch = function (this: unknown, ...args) {
      routed++;
      return Reflect.apply(previous, this, args);
    };
    transport = vi.fn(async () => response(block(counts(60, 0)) + done));
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    await (await capture.run(() => fetch(url))).text();
    const stable = globalThis.fetch;
    capture.run(() => undefined);
    expect(globalThis.fetch).toBe(stable);
    expect(routed).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(capture.finish(sdk).diagnostics.usageBlocks).toBe(1);
    expect(capture.finish(sdk).usage.cacheReadTokens).toBe(60);
    // Replacement routers can also route directly instead of chaining.
    const replacement = vi.fn(async () => response(block(counts(20, 0)) + done));
    globalThis.fetch = replacement;
    await (await capture.run(() => fetch(url))).text();
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(capture.finish(sdk).usage.cacheReadTokens).toBe(20);
  });

  it('does not carry evidence across matching HTTP requests even if IDs are reused', async () => {
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    transport = vi.fn(async () => response(block(counts(60, 0)) + done));
    await (await capture.run(() => fetch(url))).text();
    transport = vi.fn(async () => response(block({ prompt_tokens: 100 }) + done));
    await (await capture.run(() => fetch(url))).text();
    expect(capture.finish(sdk).usage).toStrictEqual({ inputTokens: 91, totalInputTokens: 100 });
  });

  it('ignores an older in-flight response after a later matching request starts', async () => {
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    transport = vi.fn(async () => response(block(counts(60, 0)) + done));
    const older = await capture.run(() => fetch(url));
    transport = vi.fn(async () => response(block(counts(20, 0)) + done));
    await (await capture.run(() => fetch(url))).text();
    await older.text();
    expect(capture.finish(sdk).usage.cacheReadTokens).toBe(20);
  });
});

describe('stream flow control and failure isolation', () => {
  it('does not pull until the consumer requests bytes, and forwards cancellation exactly', async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const bytes = encoder.encode(block(counts(60, 0)));
    const raw = new Response(new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(bytes); }, cancel }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    transport = vi.fn(async () => raw);
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    const returned = await capture.run(() => fetch(url));
    await Promise.resolve();
    expect(pulls).toBe(0);
    const reader = returned.body!.getReader();
    expect((await reader.read()).value).toBe(bytes);
    expect(pulls).toBe(1);
    const reason = new Error('consumer stopped');
    await reader.cancel(reason);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(capture.finish(sdk).diagnostics.status).toBe('cancelled');
    expect(capture.finish(sdk).usage.cacheReadTokens).toBeUndefined();
  });

  it('keeps successful evidence when the SDK cancels after the DONE marker', async () => {
    transport = vi.fn(async () => response(block(counts(60, 0)) + done));
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    const reader = (await capture.run(() => fetch(url))).body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(capture.finish(sdk).usage.cacheReadTokens).toBe(60);
  });

  it('forwards stream errors unchanged and invalidates earlier cache evidence', async () => {
    const failure = new Error('upstream stream failed');
    let pulls = 0;
    transport = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull(c) { if (pulls++ === 0) c.enqueue(encoder.encode(block(counts(60, 0)))); else c.error(failure); } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }));
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    await expect((await capture.run(() => fetch(url))).text()).rejects.toBe(failure);
    expect(capture.finish(sdk).diagnostics.status).toBe('error');
    expect(capture.finish(sdk).usage.cacheReadTokens).toBeUndefined();
  });

  it('preserves fetch abort rejection and signal while dropping cache evidence', async () => {
    const controller = new AbortController();
    const error = new DOMException('aborted', 'AbortError');
    transport = vi.fn((_input, options) => new Promise((_resolve, reject) => { options!.signal!.addEventListener('abort', () => reject(error), { once: true }); }));
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    const promise = capture.run(() => fetch(url, { signal: controller.signal }));
    controller.abort();
    await expect(promise).rejects.toBe(error);
    expect(capture.finish(sdk).diagnostics.status).toBe('error');
    expect(capture.finish(sdk).usage).toStrictEqual({});
  });

  it('passes malformed UTF8 bytes unchanged and treats their metadata as unknown', async () => {
    const bytes = new Uint8Array([...encoder.encode(block(counts(60, 0))), 0xff, 10, 10]);
    transport = vi.fn(async () => new Response(bytes, { headers: { 'content-type': 'text/event-stream' } }));
    const capture = new OpenAIWireCapture({ baseUrl: 'https://wire.invalid/v1' });
    const returned = await capture.run(() => fetch(url));
    expect(new Uint8Array(await returned.arrayBuffer())).toEqual(bytes);
    expect(capture.finish(sdk).diagnostics.status).toBe('malformed');
    expect(capture.finish(sdk).usage.cacheReadTokens).toBeUndefined();
  });
});
