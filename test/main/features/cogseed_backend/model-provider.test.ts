import { describe, expect, it } from 'vitest';

import { createRuntimeModelAdapter, type RuntimeModelRequest } from '../../../../src/main/features/cogseed_runtime/kernel/model-adapter';
import type { MateProviderProfile } from '../../../../src/main/features/cogseed_backend/provider-profiles';
import {
  createMateAnthropicProvider,
  createMateGeminiProvider,
  createMateOpenAICompatibleProvider,
  createMateRuntimeProvider,
} from '../../../../src/main/features/cogseed_backend/model-provider';

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

describe('CogSeed OpenAI-compatible Model Provider', () => {
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

// ── Anthropic / Gemini providers ─────────────────────────────────────────

function anthropicProfile(overrides: Partial<MateProviderProfile> = {}): MateProviderProfile {
  return {
    profileId: 'anthropic:default',
    provider: 'anthropic',
    protocol: 'anthropic',
    model: 'claude-opus-4-8',
    apiKey: 'sk-ant-api03-secret-value',
    baseUrl: 'https://api.anthropic.com',
    maxOutputTokens: 8192,
    ...overrides,
  };
}

function geminiProfile(overrides: Partial<MateProviderProfile> = {}): MateProviderProfile {
  return {
    profileId: 'google:default',
    provider: 'google',
    protocol: 'gemini',
    model: 'gemini-3.5-flash',
    apiKey: 'google-secret-key',
    baseUrl: 'https://generativelanguage.googleapis.com',
    maxOutputTokens: 8192,
    ...overrides,
  };
}

describe('CogSeed Anthropic Model Provider', () => {
  it('posts a Messages request and streams text + usage from SSE events', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = createMateAnthropicProvider({
      resolveProfile: async () => anthropicProfile(),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return sseResponse([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]);
      },
    });

    const events = await collect(provider(REQUEST));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].init?.headers).toMatchObject({
      'x-api-key': anthropicProfile().apiKey,
      'anthropic-version': '2023-06-01',
    });
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      model: 'claude-opus-4-8',
      stream: true,
      max_tokens: 8192,
      system: REQUEST.systemPrompt,
      messages: [{ role: 'user', content: REQUEST.message }],
      tools: [{
        name: 'read_file',
        description: 'Read a visible file.',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      }],
    });
    expect(events).toEqual([
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'world' },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 } },
    ]);
  });

  it('authenticates Claude Pro/Max OAuth tokens with Bearer + Claude Code headers', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = createMateAnthropicProvider({
      resolveProfile: async () => anthropicProfile({ apiKey: 'sk-ant-oat-oauth-token' }),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return sseResponse([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]);
      },
    });

    await collect(provider(REQUEST));

    expect(calls[0].init?.headers).toMatchObject({
      Authorization: 'Bearer sk-ant-oat-oauth-token',
      'anthropic-beta': expect.stringContaining('claude-code-20250219'),
      'x-app': 'cli',
    });
    expect(calls[0].init?.headers).not.toHaveProperty('x-api-key');
  });

  it('aggregates tool-use input_json_delta fragments into a tool call', async () => {
    const provider = createMateAnthropicProvider({
      resolveProfile: async () => anthropicProfile(),
      fetchImpl: async () => sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\\"path\\\":\\\"notes"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":".txt\\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    });

    const events = await collect(createRuntimeModelAdapter({ provider }).stream(REQUEST));

    expect(events).toEqual([
      { type: 'tool_call', call: { id: 'toolu_1', name: 'read_file', arguments: { path: 'notes.txt' } } },
      { type: 'done' },
    ]);
  });

  it('fails with a provider auth error when the endpoint rejects the key, without leaking it', async () => {
    const provider = createMateAnthropicProvider({
      resolveProfile: async () => anthropicProfile(),
      fetchImpl: async () => new Response('invalid key sk-ant-api03-secret-value', { status: 401 }),
    });

    const events = await collect(createRuntimeModelAdapter({ provider }).stream(REQUEST));

    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'provider_auth' }),
      { type: 'done' },
    ]);
    expect(JSON.stringify(events)).not.toContain('sk-ant-api03-secret-value');
  });

  it('rejects a stream that never reaches message_stop', async () => {
    const provider = createMateAnthropicProvider({
      resolveProfile: async () => anthropicProfile(),
      fetchImpl: async () => sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
      ]),
    });

    await expect(collect(createRuntimeModelAdapter({ provider }).stream(REQUEST))).resolves.toEqual([
      expect.objectContaining({ type: 'error', message: expect.stringMatching(/message_stop/i) }),
      { type: 'done' },
    ]);
  });
});

describe('CogSeed Gemini Model Provider', () => {
  it('posts a generateContent request and streams text, tool calls and usage', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = createMateGeminiProvider({
      resolveProfile: async () => geminiProfile(),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return sseResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"Gemini says "}]}}],"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":0,"totalTokenCount":20}}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"notes.txt"}}}]}}],"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":6,"totalTokenCount":26}}\n\n',
          'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
        ]);
      },
    });

    const events = await collect(provider(REQUEST));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse');
    expect(calls[0].init?.headers).toMatchObject({ 'x-goog-api-key': geminiProfile().apiKey });
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: REQUEST.message }] }],
      systemInstruction: { role: 'system', parts: [{ text: REQUEST.systemPrompt }] },
      tools: [{
        functionDeclarations: [{
          name: 'read_file',
          description: 'Read a visible file.',
          parametersJsonSchema: { type: 'object' },
        }],
      }],
      generationConfig: { maxOutputTokens: 8192 },
    });
    expect(events).toEqual([
      { type: 'delta', text: 'Gemini says ' },
      { type: 'usage', usage: { inputTokens: 20, outputTokens: 0, totalTokens: 20 } },
      { type: 'delta', text: 'hi' },
      { type: 'tool_call', call: { id: expect.stringMatching(/^read_file_/), name: 'read_file', arguments: { path: 'notes.txt' } } },
      { type: 'usage', usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26 } },
    ]);
  });

  it('does not duplicate the v1beta path segment for versioned custom base URLs', async () => {
    const calls: string[] = [];
    const provider = createMateGeminiProvider({
      resolveProfile: async () => geminiProfile({ baseUrl: 'https://gemini-relay.example/v1beta' }),
      fetchImpl: async (url) => {
        calls.push(String(url));
        return sseResponse(['data: {}\n\n']);
      },
    });

    await collect(provider(REQUEST));

    expect(calls[0]).toBe('https://gemini-relay.example/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse');
  });
});

describe('CogSeed multi-protocol Runtime Provider', () => {
  it('dispatches to the anthropic adapter for anthropic profiles', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = createMateRuntimeProvider({
      resolveProfile: async () => anthropicProfile(),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return sseResponse(['event: message_stop\ndata: {"type":"message_stop"}\n\n']);
      },
    });

    await collect(provider(REQUEST));

    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].init?.headers).toMatchObject({ 'x-api-key': anthropicProfile().apiKey });
  });

  it('dispatches to the gemini adapter for gemini profiles', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = createMateRuntimeProvider({
      resolveProfile: async () => geminiProfile(),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return sseResponse(['data: {}\n\n']);
      },
    });

    await collect(provider(REQUEST));

    expect(calls[0].url).toContain(':streamGenerateContent?alt=sse');
    expect(calls[0].init?.headers).toMatchObject({ 'x-goog-api-key': geminiProfile().apiKey });
  });

  it('dispatches to the openai-completions adapter for openai-compatible profiles', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = createMateRuntimeProvider({
      resolveProfile: async () => PROFILE,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return sseResponse(['data: [DONE]\n\n']);
      },
    });

    await collect(provider(REQUEST));

    expect(calls[0].url).toBe('https://provider.test/v1/chat/completions');
    expect(calls[0].init?.headers).toMatchObject({ Authorization: 'Bearer sk-secret-value-must-not-leak' });
  });
});
