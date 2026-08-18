import type {
  RuntimeModelProvider,
  RuntimeModelProviderChunk,
  RuntimeModelRequest,
  RuntimeModelToolCall,
} from '../cogseed_runtime/kernel/model-adapter';
import { resolveMateApiKeyProfile, type MateProviderProfile } from './provider-profiles';

export type MateFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface MateOpenAICompatibleProviderOptions {
  resolveProfile?: (userId: string, profileId?: string) => Promise<MateProviderProfile>;
  fetchImpl?: MateFetch;
}

interface PendingToolCall {
  id?: string;
  name?: string;
  argumentsText: string;
}

function endpointFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function safeProviderMessage(value: string, apiKey: string): string {
  const redacted = String(value || '').replaceAll(apiKey, '[redacted]').replace(/\s+/g, ' ').trim();
  return redacted.slice(0, 500);
}

function providerHttpError(status: number, body: string, apiKey: string): Error {
  const detail = safeProviderMessage(body, apiKey);
  const error = Object.assign(
    new Error(detail ? `CogSeed model provider request failed (${status}): ${detail}` : `CogSeed model provider request failed (${status})`),
    { status },
  );
  return error;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function usageChunk(value: unknown): RuntimeModelProviderChunk | null {
  const record = asRecord(value);
  if (!record) return null;
  const inputTokens = typeof record.prompt_tokens === 'number' ? record.prompt_tokens : undefined;
  const outputTokens = typeof record.completion_tokens === 'number' ? record.completion_tokens : undefined;
  const totalTokens = typeof record.total_tokens === 'number' ? record.total_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return null;
  return { type: 'usage', usage: { inputTokens, outputTokens, totalTokens } };
}

function mergeToolCalls(delta: Record<string, unknown>, pending: Map<number, PendingToolCall>): void {
  for (const rawCall of asArray(delta.tool_calls)) {
    const call = asRecord(rawCall);
    const index = typeof call?.index === 'number' && Number.isInteger(call.index) && call.index >= 0
      ? call.index
      : 0;
    const target = pending.get(index) ?? { argumentsText: '' };
    const id = readString(call, 'id');
    if (id) target.id = id;
    const fn = asRecord(call?.function);
    const name = readString(fn, 'name');
    if (name) target.name = name;
    const argumentsFragment = readString(fn, 'arguments');
    if (argumentsFragment) target.argumentsText += argumentsFragment;
    pending.set(index, target);
  }
}

function finalizeToolCalls(pending: Map<unknown, PendingToolCall>): RuntimeModelProviderChunk[] {
  const calls: RuntimeModelProviderChunk[] = [];
  // Map preserves insertion order: index-keyed (completions/anthropic) and
  // call-id-keyed (responses) accumulators both arrive in stream order.
  for (const [, value] of pending.entries()) {
    if (!value.id || !value.name) throw new Error('CogSeed model provider returned incomplete tool call');
    let parsed: unknown;
    try {
      parsed = JSON.parse(value.argumentsText || '{}') as unknown;
    } catch {
      throw new Error('CogSeed model provider returned invalid tool arguments');
    }
    const argumentsRecord = asRecord(parsed);
    if (!argumentsRecord) throw new Error('CogSeed model provider returned invalid tool arguments');
    const call: RuntimeModelToolCall = { id: value.id, name: value.name, arguments: argumentsRecord };
    calls.push({ type: 'tool_call', call });
  }
  pending.clear();
  return calls;
}

async function* sseDataFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      while (true) {
        const separator = buffer.match(/\r?\n\r?\n/);
        if (!separator || separator.index === undefined) break;
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
      }
    }
    buffer += decoder.decode();
    const data = buffer
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data) yield data;
  } finally {
    reader.releaseLock();
  }
}

export function createMateOpenAICompatibleProvider(
  options: MateOpenAICompatibleProviderOptions = {},
): RuntimeModelProvider {
  const resolveProfile = options.resolveProfile ?? resolveMateApiKeyProfile;
  const fetchImpl = options.fetchImpl ?? fetch;

  return async function* streamMateOpenAICompatibleProvider(input) {
    const profile = await resolveProfile(input.userId, input.modelProfile);
    const payload = {
      model: profile.model,
      stream: true,
      messages: [
        ...(input.systemPrompt ? [{ role: 'system', content: input.systemPrompt }] : []),
        { role: 'user', content: input.message },
      ],
      ...(profile.maxOutputTokens ? { max_tokens: profile.maxOutputTokens } : {}),
      ...(input.tools.length ? {
        tools: input.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
      } : {}),
    };
    const response = await fetchImpl(endpointFor(profile.baseUrl), {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${profile.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: input.signal ?? undefined,
    });
    if (!response.ok) {
      throw providerHttpError(response.status, await response.text().catch(() => ''), profile.apiKey);
    }
    if (!response.body) throw new Error('CogSeed model provider returned an empty stream');

    const pendingToolCalls = new Map<number, PendingToolCall>();
    for await (const frame of sseDataFrames(response.body)) {
      if (frame === '[DONE]') break;
      let payloadRecord: Record<string, unknown> | null;
      try {
        payloadRecord = asRecord(JSON.parse(frame));
      } catch {
        throw new Error('CogSeed model provider returned malformed SSE JSON');
      }
      if (!payloadRecord) throw new Error('CogSeed model provider returned malformed SSE JSON');

      const usage = usageChunk(payloadRecord.usage);
      if (usage) yield usage;
      for (const rawChoice of asArray(payloadRecord.choices)) {
        const choice = asRecord(rawChoice);
        const delta = asRecord(choice?.delta);
        const content = readString(delta, 'content');
        if (content) yield { type: 'delta', text: content };
        if (delta) mergeToolCalls(delta, pendingToolCalls);
        if (readString(choice, 'finish_reason') === 'tool_calls') {
          for (const call of finalizeToolCalls(pendingToolCalls)) yield call;
        }
      }
    }
    for (const call of finalizeToolCalls(pendingToolCalls)) yield call;
  };
}

// ── Anthropic Messages provider ───────────────────────────────────────────

function endpointForAnthropic(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
}

function readNumberValue(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export interface MateAnthropicProviderOptions {
  resolveProfile?: (userId: string, profileId?: string) => Promise<MateProviderProfile>;
  fetchImpl?: MateFetch;
}

/**
 * Anthropic Messages API provider (SSE). Supports both API-key auth
 * (x-api-key) and Claude Pro/Max OAuth access tokens (sk-ant-oat* → Bearer
 * plus the Claude Code beta headers pi-ai sends).
 */
export function createMateAnthropicProvider(
  options: MateAnthropicProviderOptions = {},
): RuntimeModelProvider {
  const resolveProfile = options.resolveProfile ?? resolveMateApiKeyProfile;
  const fetchImpl = options.fetchImpl ?? fetch;

  return async function* streamMateAnthropicProvider(input) {
    const profile = await resolveProfile(input.userId, input.modelProfile);
    if (profile.protocol !== 'anthropic') {
      throw new Error('CogSeed Anthropic provider requires an anthropic-protocol profile');
    }
    const isOAuth = String(profile.apiKey || '').startsWith('sk-ant-oat');
    const payload = {
      model: profile.model,
      stream: true,
      max_tokens: profile.maxOutputTokens ?? 8192,
      ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
      messages: [{ role: 'user', content: input.message }],
      ...(input.tools.length ? {
        tools: input.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
      } : {}),
    };
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (isOAuth) {
      headers.Authorization = `Bearer ${profile.apiKey}`;
      headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20';
      headers['user-agent'] = 'claude-cli/2.0.0';
      headers['x-app'] = 'cli';
    } else {
      headers['x-api-key'] = profile.apiKey;
    }
    const response = await fetchImpl(endpointForAnthropic(profile.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: input.signal ?? undefined,
    });
    if (!response.ok) {
      throw providerHttpError(response.status, await response.text().catch(() => ''), profile.apiKey);
    }
    if (!response.body) throw new Error('CogSeed model provider returned an empty stream');

    const pendingToolCalls = new Map<number, PendingToolCall>();
    let currentToolIndex: number | null = null;
    let sawMessageStart = false;
    let sawMessageStop = false;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for await (const frame of sseDataFrames(response.body)) {
      let event: Record<string, unknown> | null;
      try {
        event = asRecord(JSON.parse(frame));
      } catch {
        throw new Error('CogSeed model provider returned malformed SSE JSON');
      }
      if (!event) throw new Error('CogSeed model provider returned malformed SSE JSON');
      const type = readString(event, 'type');
      if (type === 'error') {
        const detail = asRecord(event?.error);
        const message = readString(detail, 'message') || readString(detail, 'type') || 'unknown';
        throw new Error(`CogSeed Anthropic provider error: ${message}`);
      }
      if (type === 'message_start') {
        sawMessageStart = true;
        const usage = asRecord(asRecord(event?.message)?.usage);
        inputTokens = readNumberValue(usage, 'input_tokens') ?? inputTokens;
      } else if (type === 'content_block_start') {
        const block = asRecord(event?.content_block);
        if (readString(block, 'type') === 'tool_use') {
          const index = readNumberValue(event, 'index') ?? pendingToolCalls.size;
          currentToolIndex = index;
          const pending = pendingToolCalls.get(index) ?? { argumentsText: '' };
          const id = readString(block, 'id');
          const name = readString(block, 'name');
          if (id) pending.id = id;
          if (name) pending.name = name;
          pendingToolCalls.set(index, pending);
        }
      } else if (type === 'content_block_delta') {
        const delta = asRecord(event?.delta);
        const deltaType = readString(delta, 'type');
        if (deltaType === 'text_delta') {
          const text = readString(delta, 'text');
          if (text) yield { type: 'delta', text };
        } else if (deltaType === 'input_json_delta') {
          const fragment = readString(delta, 'partial_json');
          const index = currentToolIndex ?? pendingToolCalls.size;
          const pending = pendingToolCalls.get(index) ?? { argumentsText: '' };
          if (fragment) pending.argumentsText += fragment;
          pendingToolCalls.set(index, pending);
        }
      } else if (type === 'message_delta') {
        const usage = asRecord(event?.usage);
        outputTokens = readNumberValue(usage, 'output_tokens') ?? outputTokens;
        if (inputTokens !== undefined || outputTokens !== undefined) {
          yield {
            type: 'usage',
            usage: {
              inputTokens,
              outputTokens,
              totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
            },
          };
        }
      } else if (type === 'message_stop') {
        sawMessageStop = true;
        break;
      }
    }
    for (const call of finalizeToolCalls(pendingToolCalls)) yield call;
    if (sawMessageStart && !sawMessageStop) {
      throw new Error('CogSeed Anthropic stream ended before message_stop');
    }
  };
}

// ── Google Gemini provider ───────────────────────────────────────────────

function geminiStreamUrl(baseUrl: string, model: string): string {
  const clean = String(baseUrl || '').replace(/\/+$/, '');
  const versioned = /\/v1beta(?:\/|$)/.test(clean) ? clean : `${clean}/v1beta`;
  return `${versioned}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

export interface MateGeminiProviderOptions {
  resolveProfile?: (userId: string, profileId?: string) => Promise<MateProviderProfile>;
  fetchImpl?: MateFetch;
}

/**
 * Google Gemini generateContent provider (SSE). API-key auth via
 * x-goog-api-key; tool calls arrive as functionCall parts whose args are
 * already a JSON object (no partial accumulation needed).
 */
export function createMateGeminiProvider(
  options: MateGeminiProviderOptions = {},
): RuntimeModelProvider {
  const resolveProfile = options.resolveProfile ?? resolveMateApiKeyProfile;
  const fetchImpl = options.fetchImpl ?? fetch;

  return async function* streamMateGeminiProvider(input) {
    const profile = await resolveProfile(input.userId, input.modelProfile);
    if (profile.protocol !== 'gemini') {
      throw new Error('CogSeed Gemini provider requires a gemini-protocol profile');
    }
    const payload = {
      contents: [{ role: 'user', parts: [{ text: input.message }] }],
      ...(input.systemPrompt
        ? { systemInstruction: { role: 'system', parts: [{ text: input.systemPrompt }] } }
        : {}),
      ...(input.tools.length ? {
        tools: [{
          functionDeclarations: input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parametersJsonSchema: tool.parameters,
          })),
        }],
      } : {}),
      ...(profile.maxOutputTokens ? { generationConfig: { maxOutputTokens: profile.maxOutputTokens } } : {}),
    };
    const response = await fetchImpl(geminiStreamUrl(profile.baseUrl, profile.model), {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'x-goog-api-key': profile.apiKey,
      },
      body: JSON.stringify(payload),
      signal: input.signal ?? undefined,
    });
    if (!response.ok) {
      throw providerHttpError(response.status, await response.text().catch(() => ''), profile.apiKey);
    }
    if (!response.body) throw new Error('CogSeed model provider returned an empty stream');

    for await (const frame of sseDataFrames(response.body)) {
      let chunk: Record<string, unknown> | null;
      try {
        chunk = asRecord(JSON.parse(frame));
      } catch {
        throw new Error('CogSeed model provider returned malformed SSE JSON');
      }
      if (!chunk) throw new Error('CogSeed model provider returned malformed SSE JSON');

      const candidate = asRecord(asArray(chunk.candidates)[0]);
      const content = asRecord(candidate?.content);
      for (const rawPart of asArray(content?.parts)) {
        const part = asRecord(rawPart);
        const text = readString(part, 'text');
        if (text) yield { type: 'delta', text };
        const fn = asRecord(part?.functionCall);
        if (fn) {
          const name = readString(fn, 'name');
          if (!name) throw new Error('CogSeed model provider returned incomplete tool call');
          const call: RuntimeModelToolCall = {
            id: readString(fn, 'id') ?? `${name}_${Date.now()}`,
            name,
            arguments: asRecord(fn?.args) ?? {},
          };
          yield { type: 'tool_call', call };
        }
      }
      const usage = asRecord(chunk?.usageMetadata);
      if (usage) {
        const inputTokens = readNumberValue(usage, 'promptTokenCount');
        const outputTokens = readNumberValue(usage, 'candidatesTokenCount');
        const totalTokens = readNumberValue(usage, 'totalTokenCount');
        if (inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined) {
          yield { type: 'usage', usage: { inputTokens, outputTokens, totalTokens } };
        }
      }
    }
  };
}


// ── OpenAI Responses provider ─────────────────────────────────────────────

function endpointForResponses(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/responses`;
}

export interface MateOpenAIResponsesProviderOptions {
  resolveProfile?: (userId: string, profileId?: string) => Promise<MateProviderProfile>;
  fetchImpl?: MateFetch;
}

/**
 * OpenAI Responses API provider (SSE). Bearer auth; system prompt goes in
 * `instructions`, tools as function declarations with JSON-schema
 * `parameters`. Tool calls arrive as function_call items whose arguments
 * stream through response.function_call_arguments.delta and are finalized by
 * response.output_item.done; usage lands on response.completed (input_tokens
 * includes cached tokens — subtract them for the non-cached figure).
 */
export function createMateOpenAIResponsesProvider(
  options: MateOpenAIResponsesProviderOptions = {},
): RuntimeModelProvider {
  const resolveProfile = options.resolveProfile ?? resolveMateApiKeyProfile;
  const fetchImpl = options.fetchImpl ?? fetch;

  return async function* streamMateOpenAIResponsesProvider(input) {
    const profile = await resolveProfile(input.userId, input.modelProfile);
    if (profile.protocol !== 'openai-responses') {
      throw new Error('CogSeed OpenAI Responses provider requires an openai-responses-protocol profile');
    }
    const payload = {
      model: profile.model,
      stream: true,
      store: false,
      input: [{ role: 'user', content: input.message }],
      ...(input.systemPrompt ? { instructions: input.systemPrompt } : {}),
      ...(profile.maxOutputTokens ? { max_output_tokens: profile.maxOutputTokens } : {}),
      ...(input.tools.length ? {
        tools: input.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      } : {}),
    };
    const response = await fetchImpl(endpointForResponses(profile.baseUrl), {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${profile.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: input.signal ?? undefined,
    });
    if (!response.ok) {
      throw providerHttpError(response.status, await response.text().catch(() => ''), profile.apiKey);
    }
    if (!response.body) throw new Error('CogSeed model provider returned an empty stream');

    const pendingToolCalls = new Map<string, PendingToolCall>();
    let currentItemType: string | null = null;
    let currentCallId: string | null = null;
    let sawCompleted = false;
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;

    for await (const frame of sseDataFrames(response.body)) {
      let event: Record<string, unknown> | null;
      try {
        event = asRecord(JSON.parse(frame));
      } catch {
        throw new Error('CogSeed model provider returned malformed SSE JSON');
      }
      if (!event) throw new Error('CogSeed model provider returned malformed SSE JSON');
      const type = readString(event, 'type');
      if (type === 'error') {
        const detail = asRecord(event?.error);
        throw new Error(`CogSeed OpenAI Responses provider error: ${readString(detail, 'message') || readString(detail, 'code') || 'unknown'}`);
      }
      if (type === 'response.output_item.added') {
        const item = asRecord(event?.item);
        currentItemType = readString(item, 'type');
        if (currentItemType === 'function_call') {
          const callId = readString(item, 'call_id') ?? readString(item, 'id') ?? `call_${pendingToolCalls.size}`;
          currentCallId = callId;
          const pending = pendingToolCalls.get(callId) ?? { argumentsText: '' };
          const name = readString(item, 'name');
          if (name) pending.name = name;
          pendingToolCalls.set(callId, pending);
        } else {
          currentCallId = null;
        }
      } else if (type === 'response.output_text.delta') {
        const text = readString(event, 'delta');
        if (text && currentItemType === 'message') yield { type: 'delta', text };
      } else if (type === 'response.function_call_arguments.delta') {
        const fragment = readString(event, 'delta');
        if (currentCallId && fragment) {
          const pending = pendingToolCalls.get(currentCallId) ?? { argumentsText: '' };
          pending.argumentsText += fragment;
          pendingToolCalls.set(currentCallId, pending);
        }
      } else if (type === 'response.function_call_arguments.done') {
        const argumentsText = readString(event, 'arguments');
        if (currentCallId && argumentsText) {
          const pending = pendingToolCalls.get(currentCallId) ?? { argumentsText: '' };
          pending.argumentsText = argumentsText;
          pendingToolCalls.set(currentCallId, pending);
        }
      } else if (type === 'response.output_item.done') {
        const item = asRecord(event?.item);
        if (readString(item, 'type') === 'function_call') {
          const callId = readString(item, 'call_id') ?? readString(item, 'id');
          if (callId) {
            const pending = pendingToolCalls.get(callId) ?? { argumentsText: '' };
            const name = readString(item, 'name');
            const argumentsText = readString(item, 'arguments');
            if (name) pending.name = name;
            if (argumentsText) pending.argumentsText = argumentsText;
            pending.id = callId;
            pendingToolCalls.set(callId, pending);
          }
        }
      } else if (type === 'response.completed') {
        sawCompleted = true;
        const response = asRecord(event?.response);
        const usageRecord = asRecord(response?.usage);
        if (usageRecord) {
          const cached = readNumberValue(asRecord(usageRecord?.input_tokens_details), 'cached_tokens') ?? 0;
          const inputTokens = readNumberValue(usageRecord, 'input_tokens');
          const outputTokens = readNumberValue(usageRecord, 'output_tokens');
          const totalTokens = readNumberValue(usageRecord, 'total_tokens');
          if (inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined) {
            // Deferred until after tool calls are finalized so usage lands
            // after the tool_call chunks, matching the other providers.
            usage = {
              inputTokens: inputTokens === undefined ? undefined : Math.max(0, inputTokens - cached),
              outputTokens,
              totalTokens,
            };
          }
        }
        break;
      } else if (type === 'response.failed') {
        const detail = asRecord(event?.response);
        throw new Error(`CogSeed OpenAI Responses provider failed: ${readString(detail, 'status') || 'unknown'}`);
      }
    }
    for (const call of finalizeToolCalls(pendingToolCalls)) yield call;
    if (usage) yield { type: 'usage', usage };
    if (!sawCompleted) throw new Error('CogSeed OpenAI Responses stream ended before response.completed');
  };
}

// ── Multi-protocol dispatcher ────────────────────────────────────────────

export interface MateRuntimeProviderOptions {
  resolveProfile?: (userId: string, profileId?: string) => Promise<MateProviderProfile>;
  fetchImpl?: MateFetch;
}

/**
 * Default CogSeed runtime provider: resolve the profile once, then dispatch
 * to the wire-protocol implementation that matches it. Sub-providers share
 * the same resolveProfile/fetchImpl so injected test doubles apply uniformly.
 */
export function createMateRuntimeProvider(
  options: MateRuntimeProviderOptions = {},
): RuntimeModelProvider {
  const resolveProfile = options.resolveProfile ?? resolveMateApiKeyProfile;
  const shared = { resolveProfile, fetchImpl: options.fetchImpl };
  const openai = createMateOpenAICompatibleProvider(shared);
  const openaiResponses = createMateOpenAIResponsesProvider(shared);
  const anthropic = createMateAnthropicProvider(shared);
  const gemini = createMateGeminiProvider(shared);
  return async function* streamMateRuntimeProvider(input) {
    const profile = await resolveProfile(input.userId, input.modelProfile);
    if (profile.protocol === 'openai-responses') yield* openaiResponses(input);
    else if (profile.protocol === 'anthropic') yield* anthropic(input);
    else if (profile.protocol === 'gemini') yield* gemini(input);
    else yield* openai(input);
  };
}
