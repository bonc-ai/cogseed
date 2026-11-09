import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPiProvider } from '../src/providers/pi-provider.js';
import { AgentRunner } from '../src/agent/runner.js';
import { createConfig } from '../src/config/loader.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { messageMetricsLine, foldSessionMetrics } from '../../renderer/modules/conversation-metrics.js';

// Keep one offline transport installed for the file: the production observer
// wraps it once, just as it wraps the application's configured proxy router.
let usageBlocks: unknown[];
let responsesUsage: Record<string, unknown> | undefined;
const sent: Array<Record<string, unknown>> = [];
const sentHeaders: Headers[] = [];
const model = {
  id: 'requested-cache-alias', name: 'requested-cache-alias', api: 'openai-completions' as const,
  provider: 'cp:wire-fixture', baseUrl: 'https://wire-usage.invalid/v1',
  reasoning: false, input: ['text' as const], contextWindow: 100000, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    expect(new URL(typeof input === 'string' ? input : input.url).hostname).toBe('wire-usage.invalid');
    const body = typeof init?.body === 'string' ? init.body : await input.clone().text();
    sent.push(JSON.parse(body));
    sentHeaders.push(new Headers(init?.headers || input?.headers));
    if (new URL(typeof input === 'string' ? input : input.url).pathname.endsWith('/responses')) {
      const item = { type: 'message', id: 'msg-fixture', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'done', annotations: [] }] };
      const events = [
        { type: 'response.created', response: { id: 'resp-fixture', status: 'in_progress', model: 'reported-wire-model' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'done' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp-fixture', status: 'completed',
          model: 'reported-wire-model', output: [item], ...(responsesUsage !== undefined ? { usage: responsesUsage } : {}) } },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    const base = { id: 'same-response', object: 'chat.completion.chunk', created: 1, model: 'reported-wire-model' };
    const chunks = [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ...usageBlocks.map(usage => ({ ...base, choices: [], usage })),
    ];
    return new Response(chunks.map(x => `data: ${JSON.stringify(x)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  }));
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  sent.length = 0;
  sentHeaders.length = 0;
  usageBlocks = [{ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } }];
  responsesUsage = { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 80 } };
});
async function result(mode: 'complete' | 'stream', api: 'openai-completions' | 'openai-responses' = 'openai-completions', reasoning: 'off' | 'low' = 'off') {
  const p = createPiProvider({ provider: model.provider, customModel: { ...model, api }, apiKey: 'offline-only' });
  const params = { model: model.id, sessionId: 'fixture-session', messages: [], reasoning };
  if (mode === 'complete') return p.complete(params);
  const events = [];
  for await (const e of p.stream(params)) events.push(e);
  return events.find(e => e.type === 'message_end') as any;
}

describe('per-request usage diagnostics at normal log level', () => {
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.stubEnv('COGSEED_LOG_LEVEL', 'info');
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const summaries = () => info.mock.calls.filter(c => c[1] === 'request_usage_summary').map(c => c[2] as any);

  it.each(['complete', 'stream'] as const)('reports authoritative cache counts once per %s request', async mode => {
    await result(mode);
    await result(mode);
    const logs = summaries();
    expect(logs).toHaveLength(2);
    for (const row of logs) {
      expect(row).toMatchObject({ outcome: 'completed', cacheStatus: 'known',
        totalInputTokens: 100, cacheReadTokens: 80, uncachedInputTokens: 20, cacheReadRatio: 0.8 });
      expect(row.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(row.durationMs)).toBe(true);
      expect(Number.isSafeInteger(row.requestId)).toBe(true);
    }
    expect(logs[1].requestId).toBeGreaterThan(logs[0].requestId);
    expect(JSON.stringify(logs)).not.toMatch(/fixture-session|offline-only|wire-usage\.invalid/);
    expect(info.mock.calls.some(c => c[1] === 'request_prefix_audit')).toBe(false);
  });

  it.each([
    [],
    [{ prompt_tokens: 100, completion_tokens: 5 }],
    [{ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 120 } }],
  ].map(blocks => ({ blocks })))('keeps absent or invalid cache usage unknown: $blocks', async ({ blocks }) => {
    usageBlocks = blocks;
    await result('complete');
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toMatchObject({ cacheStatus: 'unknown' });
    for (const field of ['cacheReadTokens', 'uncachedInputTokens', 'cacheReadRatio'])
      expect(summaries()[0]).not.toHaveProperty(field);
  });

  it('distinguishes explicit zero and avoids a ratio for a zero input total', async () => {
    usageBlocks = [{ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } }];
    await result('stream');
    expect(summaries()[0]).toMatchObject({ cacheStatus: 'known', uncachedInputTokens: 100, cacheReadRatio: 0 });
    usageBlocks = [{ prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }];
    await result('complete');
    expect(summaries()[1]).toMatchObject({ cacheStatus: 'known', totalInputTokens: 0, cacheReadTokens: 0 });
    expect(summaries()[1]).not.toHaveProperty('cacheReadRatio');
  });

  it('reports Responses raw input and cache-read presence without SDK default cache-write zeros', async () => {
    const p = createPiProvider({ provider: model.provider,
      customModel: { ...model, api: 'openai-responses' }, apiKey: 'offline-only' });
    await p.complete({ model: model.id, messages: [] });
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toMatchObject({ cacheStatus: 'known', totalInputTokens: 100, cacheReadTokens: 80 });
    expect(summaries()[0]).not.toHaveProperty('cacheWriteTokens');
  });

  it.each(['complete', 'stream'] as const)('records failure once without logging hook error contents in %s', async mode => {
    const p = createPiProvider({ provider: model.provider, customModel: model, apiKey: 'offline-only',
      onPayload: () => { throw new Error('private hook text'); } });
    const params = { model: model.id, sessionId: 'private-session-id', messages: [] };
    if (mode === 'complete') await expect(p.complete(params)).rejects.toThrow();
    else {
      const events = [];
      for await (const event of p.stream(params)) events.push(event);
      expect(events.some(e => e.type === 'error')).toBe(true);
    }
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toMatchObject({ outcome: 'error', cacheStatus: 'unknown' });
    expect(JSON.stringify(summaries())).not.toMatch(/private hook text|private-session-id|offline-only/);
  });
});
describe('wire presence and model identity through the real SDK adapter', () => {
  for (const api of ['openai-completions', 'openai-responses'] as const) {
    it.each([
      { name: 'input only', input: 100, expected: { inputTokens: 100, totalInputTokens: 100 } },
      { name: 'output only', output: 5, expected: { outputTokens: 5 } },
      { name: 'explicit output zero only', output: 0, expected: { outputTokens: 0 } },
      { name: 'empty usage object', expected: {} },
      { name: 'invalid input', input: -1, output: 5, expected: { outputTokens: 5 } },
      { name: 'invalid output', input: 100, output: -1, expected: { inputTokens: 100, totalInputTokens: 100 } },
      { name: 'explicit total zero only', total: 0, expected: { totalTokens: 0 } },
      { name: 'complete counts without total', input: 100, output: 5, expected: { inputTokens: 100, totalInputTokens: 100, outputTokens: 5, totalTokens: 105 } },
      { name: 'invalid explicit total', input: 100, output: 5, total: -1, expected: { inputTokens: 100, totalInputTokens: 100, outputTokens: 5 } },
    ])(`${api} keeps each raw usage field independently known: $name`, async ({ input, output, total, expected }) => {
      usageBlocks = [{ ...(input !== undefined ? { prompt_tokens: input } : {}),
        ...(output !== undefined ? { completion_tokens: output } : {}), ...(total !== undefined ? { total_tokens: total } : {}) }];
      responsesUsage = { ...(input !== undefined ? { input_tokens: input } : {}),
        ...(output !== undefined ? { output_tokens: output } : {}), ...(total !== undefined ? { total_tokens: total } : {}) };
      for (const mode of ['complete', 'stream'] as const) expect((await result(mode, api)).usage).toStrictEqual(expected);
    });
  }
  it.each(['openai-completions', 'openai-responses'] as const)('preserves usage-less %s wire through real SDK, runner, JSON and renderer', async api => {
    usageBlocks = [];
    responsesUsage = undefined;
    const p = createPiProvider({ provider: model.provider, customModel: { ...model, api }, apiKey: 'offline-only' });
    const providers = new ProviderRegistry();
    providers.registerFactory(p.id, () => p);
    const runner = new AgentRunner({ providers, config: createConfig({
      agent: { defaultProvider: p.id, defaultModel: model.id, maxRetries: 0 },
    }) });
    const result = await runner.run({ message: 'Offline usage fixture.' });
    expect(result.meta.error).toBeUndefined();
    expect(result.text).toBe('done');
    expect(result.meta.usage).toStrictEqual({});
    expect(result.meta.lastCallUsage).toStrictEqual({});
    const metric = JSON.parse(JSON.stringify({ startedAt: 0, firstTokenAt: 1, completedAt: 10,
      usage: { ...result.meta.usage, lastCallUsage: result.meta.lastCallUsage } }));
    expect(messageMetricsLine(metric)).toMatchObject({ inText: null, outText: null, cacheHitText: null, titleLines: [] });
    expect(foldSessionMetrics([metric], { contextWindow: 1000, price: { in: 1, out: 1 } })).toMatchObject({
      inText: '—', outText: '—', cacheHitText: null, ctxText: null, costText: null,
    });
  });
  for (const api of ['openai-completions', 'openai-responses'] as const) {
    for (const reasoning of ['off', 'low'] as const) {
      it.each(['complete', 'stream'] as const)(`${api} (${reasoning}) keeps successful usage-less %s unknown`, async mode => {
        usageBlocks = [];
        responsesUsage = undefined;
        const r = await result(mode, api, reasoning);
        expect(r.content).toEqual([expect.objectContaining({ type: 'text', text: 'done' })]);
        expect(r.stopReason).toBe('end_turn');
        expect(r.usage).toStrictEqual({});
      });
      it.each(['complete', 'stream'] as const)(`${api} (${reasoning}) preserves explicitly reported zero in %s`, async mode => {
        usageBlocks = [{ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }];
        responsesUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } };
        const r = await result(mode, api, reasoning);
        expect(r.usage).toStrictEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, totalInputTokens: 0, cacheReadTokens: 0 });
      });
    }
  }
  it.each([
    { name: 'missing details', usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 }, read: undefined },
    { name: 'empty details', usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: {} }, read: undefined },
    { name: 'explicit zero', usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 0 } }, read: 0 },
    { name: 'positive read', usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 80 } }, read: 80 },
  ])('preserves Responses $name through SDK completion and streaming', async ({ usage, read }) => {
    responsesUsage = usage;
    for (const mode of ['complete', 'stream'] as const) {
      const r = await result(mode, 'openai-responses');
      expect(r.usage).toStrictEqual({ inputTokens: 100 - (read ?? 0), outputTokens: 5, totalTokens: 105,
        totalInputTokens: 100, ...(read !== undefined ? { cacheReadTokens: read } : {}) });
      expect(r.reportedModel).toBe('reported-wire-model');
    }
  });
  it.each(['complete', 'stream'] as const)('preserves raw input total, absent write count and reported identity in %s', async mode => {
    const r = await result(mode);
    expect(r.model).toBe('requested-cache-alias');
    expect(r.reportedModel).toBe('reported-wire-model');
    expect(r.usage).toMatchObject({ totalInputTokens: 100, cacheReadTokens: 80, outputTokens: 5 });
    expect(r.usage).not.toHaveProperty('cacheWriteTokens');
    expect(sent).toHaveLength(1);
  });
  it('keeps a known cache count across a same-scope incomplete cumulative trailer', async () => {
    usageBlocks.push({ prompt_tokens: 100, completion_tokens: 5 });
    expect((await result('complete')).usage).toMatchObject({ totalInputTokens: 100, cacheReadTokens: 80 });
  });
  it('honors a later explicit zero and does not maximize cache counts', async () => {
    usageBlocks.push({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } });
    expect((await result('complete')).usage).toMatchObject({ inputTokens: 100, totalInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
  it('does not transfer cache counts to a trailer with a different prompt scope', async () => {
    usageBlocks.push({ prompt_tokens: 120, completion_tokens: 5 });
    const r = await result('complete');
    expect(r.usage.totalInputTokens).toBe(120);
    expect(r.usage).not.toHaveProperty('cacheReadTokens');
    expect(r.usage).not.toHaveProperty('cacheWriteTokens');
  });
  it('does not turn missing wire usage into known zero cache buckets', async () => {
    usageBlocks = [];
    const r = await result('complete');
    expect(r.usage).not.toHaveProperty('cacheReadTokens');
    expect(r.usage).not.toHaveProperty('cacheWriteTokens');
    expect(r.usage).not.toHaveProperty('totalInputTokens');
  });
  it('rejects cache counters beyond the authoritative prompt total', async () => {
    usageBlocks = [{ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 120 } }];
    const r = await result('complete');
    expect(r.usage.totalInputTokens).toBe(100);
    expect(r.usage).not.toHaveProperty('cacheReadTokens');
  });
});

describe('explicit cache capabilities through the real SDK', () => {
  async function call(policy: any, retention: 'none' | 'short' | 'long' = 'short', sessionId = 'private-user-session') {
    const p = createPiProvider({ provider: model.provider,
      customModel: { ...model, headers: { 'x-opencode-session': 'vendor-routing', 'X-Session-Affinity': 'legacy-private-value' } },
      apiKey: 'offline-only', promptCachePolicy: policy,
      onPayload: payload => ({ ...(payload as object), prompt_cache_key: 'hook-unsupported', prompt_cache_retention: '24h' }),
    });
    await p.complete({ model: model.id, messages: [], sessionId, cacheRetention: retention });
    return { body: sent.at(-1)!, headers: sentHeaders.at(-1)! };
  }
  it('omits unsupported SDK and host-hook hints while preserving vendor routing', async () => {
    const { body, headers } = await call({ key: false, affinity: false });
    expect(body).not.toHaveProperty('prompt_cache_key');
    expect(body).not.toHaveProperty('prompt_cache_retention');
    expect(headers.has('x-session-affinity')).toBe(false);
    expect(headers.get('x-opencode-session')).toBe('vendor-routing');
  });
  it('uses a stable private session key only for declared features', async () => {
    const first = await call({ key: true, affinity: true });
    const second = await call({ key: true, affinity: true });
    const other = await call({ key: true, affinity: true }, 'short', 'other-user-session');
    expect(first.body.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/);
    expect(second.body.prompt_cache_key).toBe(first.body.prompt_cache_key);
    expect(other.body.prompt_cache_key).not.toBe(first.body.prompt_cache_key);
    for (const name of ['session_id', 'x-client-request-id', 'x-session-affinity'])
      expect(first.headers.get(name)).toBe(first.body.prompt_cache_key);
    expect(first.body).not.toHaveProperty('prompt_cache_retention');
  });
  it('does not infer extended retention from long', async () => {
    expect((await call({ key: true, affinity: false }, 'long')).body).not.toHaveProperty('prompt_cache_retention');
    expect((await call({ key: true, affinity: false, retention: '24h' }, 'long')).body.prompt_cache_retention).toBe('24h');
  });
  it('none disables optional hints even when the endpoint supports them', async () => {
    const { body, headers } = await call({ key: true, affinity: true, retention: '24h' }, 'none');
    expect(body).not.toHaveProperty('prompt_cache_key');
    expect(body).not.toHaveProperty('prompt_cache_retention');
    expect(headers.has('session_id')).toBe(false);
  });
});

describe('cache gating across SDK dialects and identities', () => {
  it.each(['openai-completions', 'openai-responses'] as const)('gates complete and stream headers for %s', async api => {
    for (const mode of ['complete', 'stream'] as const) {
      for (const affinity of [false, true]) {
        const p = createPiProvider({ provider: model.provider,
          customModel: { ...model, api, headers: { 'x-opencode-session': 'vendor', session_id: 'old',
            'x-client-request-id': 'old', 'x-session-affinity': 'old' } },
          apiKey: 'offline-only', cacheNamespace: 'user-one', promptCachePolicy: { key: false, affinity },
        });
        const params = { model: model.id, sessionId: 'shared-session-name', messages: [] };
        if (mode === 'complete') await p.complete(params);
        else for await (const _event of p.stream(params)) { /* consume */ }
        const headers = sentHeaders.at(-1)!;
        for (const name of ['session_id', 'x-client-request-id', 'x-session-affinity']) {
          if (affinity) expect(headers.get(name)).toMatch(/^[a-f0-9]{64}$/);
          else expect(headers.has(name)).toBe(false);
        }
        expect(headers.get('x-opencode-session')).toBe('vendor');
        expect(sent.at(-1)).not.toHaveProperty('prompt_cache_key');
      }
    }
  });
  it('isolates identical session names belonging to different users', async () => {
    const keys = [];
    for (const cacheNamespace of ['user-one', 'user-one', 'user-two']) {
      const p = createPiProvider({ provider: model.provider, customModel: model,
        apiKey: 'offline-only', cacheNamespace, promptCachePolicy: { key: true, affinity: false } });
      await p.complete({ model: model.id, sessionId: 'same-name', messages: [] });
      keys.push(sent.at(-1)!.prompt_cache_key);
    }
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});
