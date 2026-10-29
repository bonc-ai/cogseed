import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiProvider } from '../src/providers/pi-provider.js';
import { AgentRunner } from '../src/agent/runner.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { createConfig } from '../src/config/loader.js';
import { classifyRetryableError, ProviderError } from '../src/shared/errors.js';

const fixture = vi.hoisted(() => ({ message: '', status: undefined as number | undefined, calls: 0 }));
vi.mock('@earendil-works/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai')>();
  const errorResult = () => ({
    role: 'assistant', content: [], stopReason: 'error', errorMessage: fixture.message,
    ...(fixture.status ? { status: fixture.status } : {}),
  });
  return {
    ...actual,
    complete: async () => errorResult(),
    completeSimple: async () => errorResult(),
    stream: () => (async function* () { fixture.calls++; yield { type: 'error', error: errorResult() }; })(),
    streamSimple: () => (async function* () { fixture.calls++; yield { type: 'error', error: errorResult() }; })(),
  };
});

function provider(id = 'relay') {
  return createPiProvider({ provider: id, apiKey: 'test-key', customModel: {
    id: 'test-model', name: 'Test model', api: 'openai-responses', provider: id,
    baseUrl: 'https://relay.example/v1', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 8192,
  } });
}

afterEach(() => { fixture.status = undefined; fixture.calls = 0; });

describe('provider error retry contract', () => {
  it.each(['cp:aihubmix', 'openai', 'anthropic', 'google'])('does not retry wrapped 400 parameter errors for %s', async (id) => {
    fixture.message = 'OpenAI API error (400): 400 The request is invalid: rejected by an internal MaaS component. (tid: 2026101501591549172487966298183)';
    const providers = new ProviderRegistry();
    providers.registerFactory(id, () => provider(id));
    const runner = new AgentRunner({ config: createConfig({ agent: {
      defaultProvider: id, defaultModel: 'test-model', maxRetries: 1,
    } }), providers, tools: [] });
    const result = await runner.run({ message: 'test' });
    expect(result.meta.error).toBeDefined();
    expect(fixture.calls).toBe(1);
  });

  it.each([
    [undefined, 'OpenAI API error (400): invalid request', 400, null],
    [400, 'The request is invalid', 400, null],
    [422, 'Invalid payload', 422, null],
    [undefined, '429 Too Many Requests', 429, 'rate_limit'],
    [undefined, 'OpenAI API error (503): Service is too busy', 503, 'service_unavailable'],
    [undefined, 'terminated', undefined, 'connection_dropped'],
    [undefined, 'unknown failure (tid: 400503)', undefined, 'network'],
    [undefined, 'OpenAI API error (999): unknown error', undefined, 'network'],
  ] as const)('preserves status and retry policy for %s / %s', async (status, message, expectedStatus, retryKind) => {
    fixture.status = status; fixture.message = message;
    const p = provider();
    const events = [];
    for await (const event of p.stream({ model: 'test-model', messages: [] })) events.push(event);
    const error = events.find((event) => event.type === 'error');
    expect(error?.type).toBe('error');
    if (error?.type !== 'error') throw new Error('expected provider error');
    expect(error.error).toBeInstanceOf(ProviderError);
    expect((error.error as ProviderError).statusCode).toBe(expectedStatus);
    expect(classifyRetryableError(error.error)).toBe(retryKind);
    await expect(p.complete({ model: 'test-model', messages: [] })).rejects.toMatchObject({ statusCode: expectedStatus });
  });
});
