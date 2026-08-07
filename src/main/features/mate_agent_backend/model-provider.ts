import type {
  RuntimeModelProvider,
  RuntimeModelProviderChunk,
  RuntimeModelRequest,
  RuntimeModelToolCall,
} from '../mate_agent_runtime/kernel/model-adapter';
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
    new Error(detail ? `Mate model provider request failed (${status}): ${detail}` : `Mate model provider request failed (${status})`),
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

function finalizeToolCalls(pending: Map<number, PendingToolCall>): RuntimeModelProviderChunk[] {
  const calls: RuntimeModelProviderChunk[] = [];
  for (const [, value] of [...pending.entries()].sort(([a], [b]) => a - b)) {
    if (!value.id || !value.name) throw new Error('Mate model provider returned incomplete tool call');
    let parsed: unknown;
    try {
      parsed = JSON.parse(value.argumentsText || '{}') as unknown;
    } catch {
      throw new Error('Mate model provider returned invalid tool arguments');
    }
    const argumentsRecord = asRecord(parsed);
    if (!argumentsRecord) throw new Error('Mate model provider returned invalid tool arguments');
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
    if (!response.body) throw new Error('Mate model provider returned an empty stream');

    const pendingToolCalls = new Map<number, PendingToolCall>();
    for await (const frame of sseDataFrames(response.body)) {
      if (frame === '[DONE]') break;
      let payloadRecord: Record<string, unknown> | null;
      try {
        payloadRecord = asRecord(JSON.parse(frame));
      } catch {
        throw new Error('Mate model provider returned malformed SSE JSON');
      }
      if (!payloadRecord) throw new Error('Mate model provider returned malformed SSE JSON');

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
