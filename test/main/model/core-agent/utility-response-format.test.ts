import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertUtilityResponseFormat, composeUtilityResponseFormatOnPayload } from '../../../../src/main/model/core-agent/utility-response-format';

let root: string;
let previousRoot: string | undefined;
beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-json-utility-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});
const utility = { disableTools: true, ephemeralSession: true, responseFormat: 'json_object' as const };
describe('explicit utility JSON response format', () => {
  it.each([
    {}, { disableTools: true }, { ephemeralSession: true }, { disableTools: false, ephemeralSession: true },
    { disableTools: true, ephemeralSession: false },
  ])('refuses to constrain chat or durable sessions: %j', async flags => {
    const { buildRunner } = await import('../../../../src/main/model/core-agent/runner');
    const before = fs.readdirSync(root);
    await expect(buildRunner({ sessionId: 'json-invalid', ...flags, responseFormat: 'json_object' })).rejects.toThrow('tool-free ephemeral');
    expect(fs.readdirSync(root)).toEqual(before);
  });
  it('accepts the explicit utility boundary and leaves unspecified calls alone', () => {
    expect(() => assertUtilityResponseFormat(utility)).not.toThrow();
    expect(() => assertUtilityResponseFormat({})).not.toThrow();
    expect(() => assertUtilityResponseFormat({ ...utility, responseFormat: 'xml' as never })).toThrow('tool-free ephemeral');
  });
  it.each([
    ['openai', 'openai-completions', 'json_object'], ['zai', 'openai-responses', 'json_object'],
    ['custom-zai', 'openai-completions', 'json_object'], ['zai', 'openai-completions', undefined],
  ] as const)('does not guess capability or implicitly opt in: %s %s %s', async (provider, api, responseFormat) => {
    const payload = { messages: [], max_tokens: 256 };
    expect(await composeUtilityResponseFormatOnPayload(provider, responseFormat)(payload, { api })).toBe(payload);
    expect(payload).not.toHaveProperty('response_format');
  });
  it('composes the existing asynchronous hook, including SDK undefined-as-noop semantics, without mutating caller data', async () => {
    const payload = { messages: [], max_tokens: 256 };
    const prior = vi.fn(async () => ({ ...payload, temperature: 0.2 }));
    expect(await composeUtilityResponseFormatOnPayload('zai', 'json_object', prior)(payload, { api: 'openai-completions' }))
      .toEqual({ ...payload, temperature: 0.2, response_format: { type: 'json_object' } });
    expect(prior).toHaveBeenCalledOnce();
    expect(payload).not.toHaveProperty('response_format');
    expect(await composeUtilityResponseFormatOnPayload('zai', 'json_object', () => undefined)(payload, { api: 'openai-completions' }))
      .toEqual({ ...payload, response_format: { type: 'json_object' } });
  });
  it('emits JSON mode in the actual SDK payload after credential rotation to a configured Z.ai model fallback', async () => {
    const auth = await import('../../../../src/main/features/auth');
    const group = [
      { entryId: 'first-entry', profileId: 'first-profile', provider: 'openai', model: 'gpt-4o', apiKey: 'synthetic-first-key' },
      { entryId: 'zai-entry', profileId: 'zai-profile', provider: 'zai', model: 'glm-5.2', apiKey: 'synthetic-second-key' },
    ];
    vi.spyOn(auth, 'pickChatEntryGroupForUser').mockResolvedValue(group);
    vi.spyOn(auth, 'bumpEntryLastUsed').mockImplementation(() => undefined);
    const nativeInjected = vi.fn();
    const chosen = vi.fn();
    const requests: Array<{ url: string; payload: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const payload = JSON.parse(String(init?.body));
      requests.push({ url: String(url), payload });
      if (requests.length === 1) return new Response(JSON.stringify({ error: { message: 'invalid api key', type: 'authentication_error' } }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
      const chunks = [
        { id: 'synthetic-completion', object: 'chat.completion.chunk', model: 'glm-5.2', choices: [{ index: 0, delta: { role: 'assistant', content: '{"supported":true}' }, finish_reason: null }] },
        { id: 'synthetic-completion', object: 'chat.completion.chunk', model: 'glm-5.2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
      ];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    }));
    const core = await import('#core-agent');
    // Simulate a catalog version missing this configured model on the aliased
    // catalog provider (`zai` resolves through `zai-coding-cn`), while using
    // the real configured template resolver and SDK for the resulting call.
    const actualGetModel = core.getPiModel;
    vi.spyOn(core, 'getPiModel').mockImplementation((provider, model) => provider === 'zai-coding-cn' && model === 'glm-5.2'
      ? undefined : actualGetModel(provider, model));
    const catalog = await import('../../../../src/main/model/provider_catalog');
    expect(catalog.resolveConfiguredPiModel(core, 'zai', 'glm-5.2')).toMatchObject({ isConfiguredFallback: true, model: { api: 'openai-completions', id: 'glm-5.2' } });
    const users = await import('../../../../src/main/features/users');
    users.activateUser('json-user');
    const { buildRunner } = await import('../../../../src/main/model/core-agent/runner');
    const built = await buildRunner({ sessionId: 'memory-json-test', userId: 'json-user', systemPrompt: 'Return JSON.', skillList: [],
      ...utility, onNativeSearchInjected: nativeInjected, onCandidateChosen: chosen });
    const result = await built.runner.getProviders().get('openai').complete({ model: 'gpt-4o', messages: [{ role: 'user', content: [{ type: 'text', text: 'Return JSON.' }] }], maxTokens: 128 });
    expect(result.content).toEqual([{ type: 'text', text: '{"supported":true}' }]);
    expect(requests).toHaveLength(2);
    expect(requests[0].payload).not.toHaveProperty('response_format');
    expect(requests[0].payload.tools || []).toEqual([]);
    expect(requests[1].payload).toMatchObject({ model: 'glm-5.2', response_format: { type: 'json_object' } });
    expect(requests[1].payload.tools || []).toEqual([]);
    expect(nativeInjected).not.toHaveBeenCalled();
    expect(chosen).toHaveBeenLastCalledWith(expect.objectContaining({ providerId: 'zai', modelId: 'glm-5.2' }));
    expect(built.toolDefs).toEqual([]);
  });
  it('preserves the existing native-search payload hook for ordinary calls without JSON opt-in', async () => {
    const auth = await import('../../../../src/main/features/auth');
    vi.spyOn(auth, 'pickChatEntryGroupForUser').mockResolvedValue([
      { entryId: 'ordinary-entry', profileId: 'ordinary-profile', provider: 'openai', model: 'gpt-4o', apiKey: 'synthetic-key' },
    ]);
    const users = await import('../../../../src/main/features/users');
    users.activateUser('json-user');
    const payloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      // Stop at the real SDK request boundary; this test sends no network request.
      return new Response(JSON.stringify({ error: { message: 'invalid api key', type: 'authentication_error' } }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
    }));
    const injected = vi.fn();
    const { buildRunner } = await import('../../../../src/main/model/core-agent/runner');
    const built = await buildRunner({ sessionId: 'gconv-json-ordinary-test', userId: 'json-user', skillList: [], ephemeralSession: true,
      onNativeSearchInjected: injected });
    await expect(built.runner.getProviders().get('openai').complete({ model: 'gpt-4o', messages: [], tools: [] }))
      .rejects.toMatchObject({ code: 'PROVIDER_AUTH_EXHAUSTED' });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).not.toHaveProperty('response_format');
    expect(payloads[0].tools).toEqual([{ type: 'web_search' }]);
    expect(injected).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', api: 'openai-responses', tool: 'web_search' }));
  });
});
