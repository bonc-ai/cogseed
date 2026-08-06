import { describe, expect, it } from 'vitest';

import {
  createRuntimeModelAdapter,
  normalizeRuntimeModelError,
  type RuntimeModelEvent,
  type RuntimeModelProvider,
  type RuntimeModelRequest,
} from '../../../../../src/main/features/mate_agent_runtime/kernel/model-adapter';

const baseRequest: RuntimeModelRequest = {
  userId: 'u1',
  requestId: 'req-model',
  runtimeSessionId: 'mruntime-model',
  message: 'Summarize the explicit input.',
  systemPrompt: 'Use only explicit Runtime context.',
  readOnlyRoots: [],
  tools: [],
};

async function collect(iterable: AsyncIterable<RuntimeModelEvent>): Promise<RuntimeModelEvent[]> {
  const events: RuntimeModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('native Runtime model adapter', () => {
  it('streams fake provider deltas, tool calls, usage, and a terminal done event', async () => {
    const seen: RuntimeModelRequest[] = [];
    const provider: RuntimeModelProvider = async function* (request) {
      seen.push(request);
      yield { type: 'delta', text: 'Hel' };
      yield { type: 'tool_call', call: { id: 'call-1', name: 'stat_file', arguments: { path: '/tmp/a.txt' } } };
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } };
      yield { type: 'delta', text: 'lo' };
    };

    const events = await collect(createRuntimeModelAdapter({ provider }).stream(baseRequest));

    expect(seen[0]).toEqual(expect.objectContaining({
      userId: 'u1',
      requestId: 'req-model',
      runtimeSessionId: 'mruntime-model',
      message: 'Summarize the explicit input.',
      systemPrompt: 'Use only explicit Runtime context.',
    }));
    expect(events).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'tool_call', call: { id: 'call-1', name: 'stat_file', arguments: { path: '/tmp/a.txt' } } },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
      { type: 'delta', text: 'lo' },
      { type: 'done' },
    ]);
  });

  it('aborts a stream without yielding later provider deltas', async () => {
    const controller = new AbortController();
    const provider: RuntimeModelProvider = async function* () {
      yield { type: 'delta', text: 'first' };
      await delay(50);
      yield { type: 'delta', text: 'leaked-after-abort' };
    };
    const iterator = createRuntimeModelAdapter({ provider }).stream(baseRequest, { signal: controller.signal });

    await expect(iterator.next()).resolves.toEqual({ value: { type: 'delta', text: 'first' }, done: false });
    controller.abort();

    const remaining: RuntimeModelEvent[] = [];
    for await (const event of iterator) remaining.push(event);

    expect(remaining).toEqual([
      { type: 'error', code: 'cancelled', message: 'runtime model request aborted' },
      { type: 'done' },
    ]);
    expect(remaining).not.toContainEqual({ type: 'delta', text: 'leaked-after-abort' });
  });

  it('maps provider 5xx, auth, and rate-limit failures to stable error codes', async () => {
    expect(normalizeRuntimeModelError(Object.assign(new Error('provider unavailable'), { status: 503 }))).toEqual({
      code: 'provider_server_error',
      message: 'provider unavailable',
    });
    expect(normalizeRuntimeModelError(Object.assign(new Error('invalid API key'), { statusCode: 401 }))).toEqual({
      code: 'provider_auth',
      message: 'invalid API key',
    });
    expect(normalizeRuntimeModelError(Object.assign(new Error('rate limit exceeded'), { status: 429 }))).toEqual({
      code: 'provider_rate_limit',
      message: 'rate limit exceeded',
    });
  });

  it('converts thrown provider errors into error plus done events', async () => {
    const provider: RuntimeModelProvider = async function* () {
      yield { type: 'delta', text: 'partial' };
      throw Object.assign(new Error('upstream busy'), { status: 502 });
    };

    const events = await collect(createRuntimeModelAdapter({ provider }).stream(baseRequest));

    expect(events).toEqual([
      { type: 'delta', text: 'partial' },
      { type: 'error', code: 'provider_server_error', message: 'upstream busy' },
      { type: 'done' },
    ]);
  });
});
