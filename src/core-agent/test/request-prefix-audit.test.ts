import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  payload: {} as any,
  sent: undefined as any,
  options: undefined as any,
}));

vi.mock('@earendil-works/pi-ai', () => {
  const result = {
    content: [], stopReason: 'stop', model: 'fixture-model',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  };
  const send = async (model: any, _context: any, options: any) => {
    sdk.options = options;
    const replacement = await options.onPayload?.(sdk.payload, model);
    sdk.sent = replacement === undefined ? sdk.payload : replacement;
    return result;
  };
  const stream = async function* (model: any, context: any, options: any) {
    await send(model, context, options);
    yield { type: 'done', reason: 'stop', message: result };
  };
  return {
    getModel: () => undefined, getModels: () => [], getProviders: () => [],
    complete: send, completeSimple: send, stream, streamSimple: stream,
  };
});

import { buildPiContext, createPiProvider } from '../src/providers/pi-provider.js';

// A fresh instance gives every test its own HMAC key and bounded baseline store.
async function auditInstance() {
  const { createRequestPrefixAudit, REQUEST_PREFIX_AUDIT_LIMITS } =
    await import('../src/providers/request-prefix-audit.js');
  return { audit: createRequestPrefixAudit(), limits: REQUEST_PREFIX_AUDIT_LIMITS };
}

const identity = {
  api: 'openai-completions', provider: 'fixture-provider', model: 'fixture-model',
  baseUrl: 'https://fixture.invalid/v1', sessionId: 'private-session',
};
const tool = (name: string) => ({
  type: 'function', function: {
    name, description: 'private description',
    parameters: { type: 'object', properties: { secret: { type: 'string' } } },
  },
});
function fixture() {
  return {
    model: 'fixture-model', tools: [tool('private-tool'), tool('second-tool')],
    messages: [
      { role: 'system', content: 'private system 🧪' },
      { role: 'user', content: 'private user alice@example.invalid' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'private-call', type: 'function', function: { name: 'private-tool', arguments: '{"secret":"private argument"}' } },
      ] },
      { role: 'tool', tool_call_id: 'private-call', content: 'private result /private/path' },
    ],
  };
}

describe('bounded provider-facing request prefix audit', () => {
  it('counts unchanged logical prefix bytes separately from appended or rewritten suffix bytes', async () => {
    const { audit } = await auditInstance();
    const payload = fixture();
    const first = audit.observe(identity, payload);
    expect(first).not.toHaveProperty('commonPrefixBytes');
    const equal = audit.observe(identity, payload);
    expect(equal).toMatchObject({ commonPrefixBytes: first.current!.bytes, currentSuffixBytes: 0, previousSuffixBytes: 0 });
    payload.messages.push({ role: 'user', content: '下一轮 🧪' });
    const appended = audit.observe(identity, payload);
    expect(appended).toMatchObject({ commonPrefixBytes: first.current!.bytes, previousSuffixBytes: 0 });
    expect((appended as any).currentSuffixBytes).toBe(Buffer.byteLength(JSON.stringify(payload.messages.at(-1))));
    payload.messages[1].content = 'rewrite';
    const rewritten = audit.observe(identity, payload) as any;
    expect(rewritten.status).toBe('rewrite');
    expect(rewritten.commonPrefixBytes + rewritten.currentSuffixBytes).toBe(rewritten.current.bytes);
    expect(rewritten.commonPrefixBytes + rewritten.previousSuffixBytes).toBe(rewritten.previous.bytes);
    expect(rewritten.commonPrefixBytes).toBeLessThan(first.current!.bytes);
  });

  it('distinguishes equal, history append, rewrite and truncation without mutating the payload', async () => {
    const { audit } = await auditInstance();
    const payload = fixture();
    const original = structuredClone(payload);
    const first = audit.observe(identity, payload);
    expect(first.status).toBe('initial');
    expect(payload).toEqual(original);
    expect(first.current).toMatchObject({ blocks: 5, system: 1, tools: 2, history: 3 });
    expect(audit.observe(identity, structuredClone(payload))).toMatchObject({ status: 'equal', commonBlocks: 5 });
    payload.messages.push({ role: 'user', content: 'next request' });
    expect(audit.observe(identity, payload)).toMatchObject({
      status: 'append_only', commonBlocks: 5,
      firstChanged: { index: 5, kind: 'history', sectionIndex: 3, before: null },
    });
    payload.messages[1].content = 'rewritten user';
    expect(audit.observe(identity, payload)).toMatchObject({
      status: 'rewrite', commonBlocks: 2,
      firstChanged: { index: 2, kind: 'history', sectionIndex: 0 },
    });
    payload.messages.pop();
    expect(audit.observe(identity, payload)).toMatchObject({
      status: 'rewrite', firstChanged: { index: 5, after: null },
    });
    expect(original).toEqual(fixture());
  });

  it.each(['system', 'tool', 'history', 'tool-order', 'history-order', 'signature', 'late-system'])(
    'finds the first changed block for %s', async (change) => {
      const { audit } = await auditInstance();
      const previous = fixture();
      audit.observe(identity, previous);
      const next: any = structuredClone(previous);
      const expected = { index: 0, kind: 'system', sectionIndex: 0 };
      if (change === 'system') next.messages[0].content += '!';
      if (change === 'tool') next.tools[0].function.parameters.properties.secret.type = 'number';
      if (change === 'tool-order') next.tools.reverse();
      if (change === 'tool' || change === 'tool-order') Object.assign(expected, { index: 1, kind: 'tool' });
      if (change === 'history') next.messages[3].content += '!';
      if (change === 'history-order') [next.messages[2], next.messages[3]] = [next.messages[3], next.messages[2]];
      if (change === 'signature') next.messages[2].reasoning_content = 'private thinking signature';
      if (change === 'late-system') next.messages.push({ role: 'system', content: 'late instruction' });
      if (change === 'history') Object.assign(expected, { index: 4, kind: 'history', sectionIndex: 2 });
      if (change === 'history-order' || change === 'signature') Object.assign(expected, { index: 3, kind: 'history', sectionIndex: 1 });
      if (change === 'late-system') Object.assign(expected, { index: 5, kind: 'history', sectionIndex: 3 });
      // A late instruction is an appended provider message, not moved ahead of history.
      expect(audit.observe(identity, next)).toMatchObject({
        status: change === 'late-system' ? 'append_only' : 'rewrite', firstChanged: expected,
      });
    },
  );

  it.each([
    ['anthropic-messages', { system: [{ type: 'text', text: 's' }], tools: [{ name: 't', input_schema: {} }], messages: [{ role: 'user', content: 'u' }] }],
    ['openai-responses', { input: [{ role: 'developer', content: 's' }, { type: 'function_call_output', call_id: 'c', output: 'r' }], tools: [{ type: 'web_search_preview' }] }],
    ['openai-codex-responses', { instructions: 's', input: [{ role: 'user', content: 'u' }], tools: [] }],
    ['azure-openai-responses', { instructions: 's', input: 'u', tools: [] }],
    ['google-generative-ai', { config: { systemInstruction: 's', tools: [{ functionDeclarations: [{ name: 't' }] }] }, contents: [{ role: 'user', parts: [{ text: 'u' }] }] }],
    ['google-vertex', { config: { systemInstruction: 's', tools: [] }, contents: [{ role: 'user', parts: [{ inlineData: { data: 'PRIVATE_BASE64', mimeType: 'image/png' } }] }] }],
  ])('audits the actual %s payload layout', async (api, payload) => {
    const { audit } = await auditInstance();
    const route = { ...identity, api };
    const copy = structuredClone(payload);
    expect(audit.observe(route, payload).status).toBe('initial');
    expect(audit.observe(route, structuredClone(payload)).status).toBe('equal');
    expect(payload).toEqual(copy);
  });

  it('does not emit content, identifiers, property names, URLs, credentials or error text', async () => {
    const { audit } = await auditInstance();
    const payload: any = fixture();
    payload.messages[3].content = [{ type: 'image', data: 'PRIVATE_BASE64' }];
    payload.tools[0].function.parameters.properties.PRIVATE_PROPERTY = { const: 'PRIVATE_VALUE' };
    const reports = [audit.observe(identity, payload), audit.observe(identity, payload)];
    payload.messages[3].content = 'replacement';
    reports.push(audit.observe(identity, payload));
    const encoded = JSON.stringify(reports);
    for (const secret of ['private', 'alice@', 'fixture-provider', 'fixture-model', 'fixture.invalid', 'PRIVATE_', 'description', 'parameters']) {
      expect(encoded).not.toContain(secret);
    }
    expect(reports[0].scopeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(reports[0].current!.hash).toMatch(/^[a-f0-9]{64}$/);
    const { audit: otherProcess } = await auditInstance();
    expect(otherProcess.observe(identity, payload).scopeHash).not.toBe(reports[0].scopeHash);
  });

  it('isolates sessions and routes; never compares anonymous calls', async () => {
    const { audit } = await auditInstance();
    audit.observe(identity, fixture());
    for (const changed of [{ sessionId: 'other' }, { model: 'other' }, { baseUrl: 'https://other.invalid' }, { api: 'anthropic-messages' }]) {
      expect(audit.observe({ ...identity, ...changed }, fixture()).status).toBe('initial');
    }
    expect(audit.observe({ ...identity, sessionId: undefined }, fixture())).toMatchObject({ status: 'skipped', reason: 'missing_session' });
    expect(audit.observe(identity, fixture()).status).toBe('equal');
  });

  it.each(['openai-completions', 'openai-responses'] as const)('ignores SDK-only replay timestamps and usage through the real %s wire conversion', async (api) => {
    const { audit } = await auditInstance();
    const realSdk = await vi.importActual<typeof import('@earendil-works/pi-ai')>('@earendil-works/pi-ai');
    const model = { ...realSdk.getModel('openai', 'gpt-4o'), api };
    const statuses: string[] = [];
    for (const timestamp of [100, 200]) {
      const context = buildPiContext([
        { role: 'user', content: [{ type: 'text', text: 'u' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      ], 's', undefined, model);
      for (const message of context.messages) {
        message.timestamp = timestamp;
        if (message.role === 'assistant') message.usage.input = timestamp;
      }
      // The hook stops the real SDK before any fetch; no live model is called.
      await realSdk.complete(model, context, {
        apiKey: 'offline-fixture-key', transport: 'sse',
        onPayload(payload) {
          statuses.push(audit.observe({ ...identity, api }, payload).status);
          throw new Error('offline fixture captured');
        },
      });
    }
    expect(statuses).toEqual(['initial', 'equal']);
  });

  it('evicts least-recently-used baselines at a hard session bound', async () => {
    const { audit, limits } = await auditInstance();
    for (let i = 0; i < limits.sessions; i++) audit.observe({ ...identity, sessionId: `s-${i}` }, fixture());
    expect(audit.observe({ ...identity, sessionId: 's-0' }, fixture()).status).toBe('equal');
    audit.observe({ ...identity, sessionId: 'overflow' }, fixture());
    expect(audit.observe({ ...identity, sessionId: 's-0' }, fixture()).status).toBe('equal');
    expect(audit.observe({ ...identity, sessionId: 's-1' }, fixture()).status).toBe('initial');
  });

  it('fails closed at block/byte/depth/node bounds and clears the stale baseline', async () => {
    const { audit, limits } = await auditInstance();
    let deep: any = 'leaf';
    for (let i = 0; i < limits.depth + 1; i++) deep = { nested: deep };
    const cyclic: any = {}; cyclic.self = cyclic;
    for (const payload of [
      { messages: Array.from({ length: limits.blocks }, () => ({ role: 'user', content: 'x' })) },
      { messages: [{ role: 'user', content: 'x'.repeat(limits.bytes + 1) }] },
      { messages: [{ role: 'user', content: deep }] },
      { messages: [{ role: 'user', content: Array(limits.nodes + 1).fill(null) }] },
    ]) {
      audit.observe(identity, fixture());
      expect(audit.observe(identity, payload)).toMatchObject({ status: 'skipped', reason: 'limit' });
      expect(audit.observe(identity, fixture()).status).toBe('initial');
    }
    for (const payload of [{ messages: cyclic }, { input: [] }, { messages: [{ content: cyclic }] }]) {
      expect(audit.observe(identity, payload).status).toBe('skipped');
    }
    expect(audit.observe({ ...identity, api: 'unsupported-api' }, fixture())).toMatchObject({ status: 'skipped', reason: 'unsupported_payload' });
  });

  it('accepts the block ceiling, bounds report size and does not retain mutable report references', async () => {
    const { audit, limits } = await auditInstance();
    const payload = { messages: Array.from({ length: limits.blocks - 2 }, () => ({ role: 'user', content: 'bounded content' })) };
    const first = audit.observe(identity, payload);
    expect(first.current!.blocks).toBe(limits.blocks);
    first.current!.hash = 'tampered';
    const equal = audit.observe(identity, payload);
    expect(equal.status).toBe('equal');
    expect(equal.previous!.hash).not.toBe('tampered');
    payload.messages[0].content += '!';
    const changed = audit.observe(identity, payload);
    expect(changed).toMatchObject({ status: 'rewrite', firstChanged: { index: 2 } });
    expect(Buffer.byteLength(JSON.stringify(changed))).toBeLessThan(2048);
    changed.firstChanged!.after!.hash = 'tampered';
    expect(audit.observe(identity, payload).status).toBe('equal');
  });
});

describe('pi-provider audit hook integration', () => {
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.stubEnv('COGSEED_LOG_LEVEL', 'debug');
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    sdk.payload = fixture(); sdk.sent = undefined; sdk.options = undefined;
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const reports = () => info.mock.calls
    .filter((call) => call[1] === 'request_prefix_audit')
    .map((call) => call[2] as any);
  const model: any = { id: 'fixture-model', api: 'openai-completions', provider: 'fixture-provider', baseUrl: 'https://fixture.invalid', reasoning: true };
  const params: any = { model: model.id, sessionId: 'integration-session', messages: [{ role: 'user', content: [{ type: 'text', text: 'u' }] }] };

  it.each(['complete', 'stream', 'complete-reasoning', 'stream-reasoning'])('audits %s after async hook replacement and preserves its exact return value', async (mode) => {
    const replacement = fixture(); replacement.messages[0].content = 'modified system';
    const onPayload = vi.fn(async () => replacement);
    const provider = createPiProvider({ provider: model.provider, customModel: model, onPayload });
    const request = { ...params, sessionId: mode, reasoning: mode.includes('reasoning') ? 'low' : 'off' };
    if (mode.startsWith('stream')) { for await (const _ of provider.stream(request)) { /* drain */ } }
    else await provider.complete(request);
    expect(onPayload).toHaveBeenCalledTimes(1);
    expect(sdk.sent).toBe(replacement);
    expect(reports()).toHaveLength(1);
    sdk.payload = replacement;
    if (mode.startsWith('stream')) { for await (const _ of provider.stream(request)) { /* drain */ } }
    else await provider.complete(request);
    expect(reports()[1].status).toBe('equal');
    expect(JSON.stringify(reports())).not.toContain('modified system');
  });

  it('preserves mutation + undefined, and detects the final provider-facing change', async () => {
    const provider = createPiProvider({ provider: model.provider, customModel: model, onPayload(payload: any) { payload.messages[0].content += '!'; } });
    await provider.complete({ ...params, sessionId: 'mutation' });
    expect(sdk.sent).toBe(sdk.payload);
    await provider.complete({ ...params, sessionId: 'mutation' });
    expect(reports()[1]).toMatchObject({ status: 'rewrite', firstChanged: { kind: 'system' } });
  });

  it('preserves the SDK callback receiver', async () => {
    let receiver: unknown;
    const provider = createPiProvider({
      provider: model.provider, customModel: model,
      onPayload: function (this: unknown) { receiver = this; },
    });
    await provider.complete({ ...params, sessionId: 'receiver' });
    expect(receiver).toBe(sdk.options);
  });

  it('keeps a bounded baseline across host provider factory recreation', async () => {
    for (let i = 0; i < 2; i++) {
      await createPiProvider({ provider: model.provider, customModel: model })
        .complete({ ...params, sessionId: 'factory-recreation' });
    }
    expect(reports().map((report) => report.status)).toEqual(['initial', 'equal']);
  });

  it('installs no audit hook by default, and leaves existing hooks untouched', async () => {
    vi.stubEnv('COGSEED_LOG_LEVEL', 'info');
    await createPiProvider({ provider: model.provider, customModel: model }).complete(params);
    expect(sdk.options.onPayload).toBeUndefined();
    const onPayload = vi.fn(() => undefined);
    await createPiProvider({ provider: model.provider, customModel: model, onPayload }).complete(params);
    expect(sdk.options.onPayload).toBe(onPayload);
    expect(reports()).toHaveLength(0);
  });

  it('contains audit and logger failures while preserving existing hook errors', async () => {
    const provider = createPiProvider({ provider: model.provider, customModel: model });
    sdk.payload = { get messages() { throw new Error('PRIVATE_GETTER'); } };
    await expect(provider.complete(params)).resolves.toBeDefined();
    expect(JSON.stringify(reports())).not.toContain('PRIVATE_GETTER');
    info.mockImplementation(() => { throw new Error('PRIVATE_LOGGER'); });
    sdk.payload = fixture();
    await expect(provider.complete(params)).resolves.toBeDefined();
    const onPayload = vi.fn(() => { throw new Error('hook failure'); });
    await expect(createPiProvider({ provider: model.provider, customModel: model, onPayload }).complete(params)).rejects.toThrow('hook failure');
  });
});
