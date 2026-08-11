import { describe, expect, it } from 'vitest';

import { createRuntimeModelAdapter, type RuntimeModelRequest } from '../../../../src/main/features/cogseed_runtime/kernel/model-adapter';
import type { MateProviderProfile } from '../../../../src/main/features/cogseed_backend/provider-profiles';
import { createMateOpenAICompatibleProvider } from '../../../../src/main/features/cogseed_backend/model-provider';

const PROFILE: MateProviderProfile = {
  profileId: 'openai-compatible:mate',
  provider: 'openai-compatible',
  model: 'mate-test-model',
  apiKey: 'sk-secret-value-must-not-leak',
  baseUrl: 'https://provider.test/v1',
  maxOutputTokens: 2048,
};

const REQUEST: RuntimeModelRequest = {
  userId: 'mate-provider-user',
  requestId: 'req-provider',
  runtimeSessionId: 'mruntime-provider',
  message: 'Read the explicit file and summarize it.',
  systemPrompt: 'Use only explicit Runtime context.',
  readOnlyRoots: [],
  tools: [{
    name: 'read_file',
    description: 'Read a visible file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  }],
};

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('Mate OpenAI-compatible Model Provider', () => {
  it('posts a scoped streaming request and aggregates fragmented tool calls', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = createMateOpenAICompatibleProvider({
      resolveProfile: async () => PROFILE,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return sseResponse([
          'data: {"choices":[{"delta":{"content":"Checking. "}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\\"path\\\":\\\""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"notes.txt\\\"}"}}]}}]}\n\n',
          'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
          'data: [DONE]\n\n',
        ]);
      },
    });

    const events = await collect(provider(REQUEST));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://provider.test/v1/chat/completions');
    expect(calls[0].init?.headers).toMatchObject({ Authorization: `Bearer ${PROFILE.apiKey}` });
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      stream: true,
      model: PROFILE.model,
      max_tokens: 2048,
      messages: [
        { role: 'system', content: REQUEST.systemPrompt },
        { role: 'user', content: REQUEST.message },
      ],
      tools: [{
        type: 'function',
        function: { name: 'read_file', description: 'Read a visible file.' },
      }],
    });
    expect(events).toEqual([
      { type: 'delta', text: 'Checking. ' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      { type: 'tool_call', call: { id: 'call_1', name: 'read_file', arguments: { path: 'notes.txt' } } },
    ]);
  });

  it('parses an SSE event split across arbitrary byte chunks', async () => {
    const provider = createMateOpenAICompatibleProvider({
      resolveProfile: async () => PROFILE,
      fetchImpl: async () => sseResponse([
        'data: {\"choices\":[{',
        '\"delta\":{\"content\":\"split frame\"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    });

    await expect(collect(provider(REQUEST))).resolves.toEqual([
      { type: 'delta', text: 'split frame' },
    ]);
  });

  it('maps a provider response failure without exposing the API key', async () => {
    const provider = createMateOpenAICompatibleProvider({
      resolveProfile: async () => PROFILE,
      fetchImpl: async () => new Response(`bad key ${PROFILE.apiKey}`, { status: 401 }),
    });

    const events = await collect(createRuntimeModelAdapter({ provider }).stream(REQUEST));

    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'provider_auth' }),
      { type: 'done' },
    ]);
    expect(JSON.stringify(events)).not.toContain(PROFILE.apiKey);
  });

  it('rejects malformed tool arguments as a stable provider error', async () => {
    const provider = createMateOpenAICompatibleProvider({
      resolveProfile: async () => PROFILE,
      fetchImpl: async () => sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","type":"function","function":{"name":"read_file","arguments":"not-json"}}]}}]}\n\n',
        'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    });

    const events = await collect(createRuntimeModelAdapter({ provider }).stream(REQUEST));

    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'provider_error', message: expect.stringMatching(/tool arguments/i) }),
      { type: 'done' },
    ]);
  });
});
