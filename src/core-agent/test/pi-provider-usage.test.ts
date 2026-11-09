import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createPiProvider } from '../src/providers/pi-provider.js';

const fixture = vi.hoisted(() => ({ usage: {} as AssistantMessage['usage'] }));
vi.mock('@earendil-works/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai')>();
  const message = () => ({
    role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop',
    model: 'usage-fixture', usage: fixture.usage,
  });
  return {
    ...actual,
    complete: async () => message(),
    completeSimple: async () => message(),
    stream: () => (async function* () { yield { type: 'done', reason: 'stop', message: message() }; })(),
    streamSimple: () => (async function* () { yield { type: 'done', reason: 'stop', message: message() }; })(),
  };
});

const provider = createPiProvider({ provider: 'fixture', apiKey: 'unused', customModel: {
  id: 'usage-fixture', name: 'Usage fixture', api: 'openai-completions', provider: 'fixture',
  baseUrl: 'https://unused.invalid', reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 8192,
} });

// These are pi-ai-normalized values, not raw HTTP usage. In pi-ai input is
// already uncached; for OpenAI the adapter has subtracted cache reads/writes.
describe('pi-provider cache accounting', () => {
  it.each([
    { name: 'explicit zero', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    { name: 'cache read and write', input: 20, output: 5, cacheRead: 100, cacheWrite: 30, totalTokens: 155 },
    { name: 'all input cached', input: 0, output: 5, cacheRead: 100, cacheWrite: 0, totalTokens: 105 },
    { name: 'missing cache fields', input: 20, output: 5, totalTokens: 25 },
    { name: 'one missing cache field', input: 20, output: 5, cacheRead: 0, totalTokens: 25 },
  ])('preserves $name in both completion paths and both stream paths', async ({ name: _name, ...raw }) => {
    // Deliberately exercise incomplete third-party output as well as pi-ai's
    // required numeric shape; absence must not be replaced with reported zero.
    fixture.usage = raw as AssistantMessage['usage'];
    const expected = {
      inputTokens: raw.input, outputTokens: raw.output, totalTokens: raw.totalTokens,
      ...('cacheRead' in raw ? { cacheReadTokens: raw.cacheRead } : {}),
      ...('cacheWrite' in raw ? { cacheWriteTokens: raw.cacheWrite } : {}),
    };
    for (const reasoning of ['off', 'low'] as const) {
      const params = { model: 'usage-fixture', messages: [], reasoning };
      expect((await provider.complete(params)).usage).toStrictEqual(expected);
      const events = [];
      for await (const event of provider.stream(params)) events.push(event);
      const end = events.find((event) => event.type === 'message_end');
      expect(end?.type === 'message_end' ? end.usage : undefined).toStrictEqual(expected);
    }
  });
});

describe('cache count validity at the pi-provider boundary', () => {
  it.each([-1, 0.5, NaN, Infinity, -Infinity, '0', '100', Number.MAX_SAFE_INTEGER + 1])('omits invalid cache counts as unknown: %s', async (invalid) => {
    fixture.usage = { input: 20, output: 5, totalTokens: 25, cacheRead: invalid, cacheWrite: invalid } as unknown as AssistantMessage['usage'];
    for (const reasoning of ['off', 'low'] as const) {
      const params = { model: 'usage-fixture', messages: [], reasoning };
      expect((await provider.complete(params)).usage).toStrictEqual({ inputTokens: 20, outputTokens: 5, totalTokens: 25 });
      const events = [];
      for await (const event of provider.stream(params)) events.push(event);
      const end = events.find((event) => event.type === 'message_end');
      expect(end?.type === 'message_end' ? end.usage : undefined).toStrictEqual({ inputTokens: 20, outputTokens: 5, totalTokens: 25 });
    }
  });
});
