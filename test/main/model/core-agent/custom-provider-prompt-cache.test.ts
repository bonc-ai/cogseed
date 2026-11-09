import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'cache-policy-user';
let root: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-cache-policy-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  vi.doUnmock('#core-agent');
  vi.doUnmock('../../../../src/main/model/model_id_recognition');
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('custom provider prompt cache policy', () => {
  it.each([
    ['openai', undefined, { key: false, affinity: false }],
    ['openai', ['prompt_cache_key'], { key: true, affinity: false }],
    ['openai-responses', ['session_affinity'], { key: false, affinity: true }],
    ['openai', ['prompt_cache_key', 'session_affinity', 'prompt_cache_retention_24h'],
      { key: true, affinity: true, retention: '24h' }],
    ['anthropic', ['prompt_cache_key', 'session_affinity'], { key: false, affinity: false }],
    ['gemini', ['prompt_cache_key', 'session_affinity'], { key: false, affinity: false }],
  ] as const)('passes explicit policy for %s / %j without changing auth routing', async (protocol, capabilities, policy) => {
    const createPiProvider = vi.fn(() => ({ marker: 'provider' }));
    vi.doMock('#core-agent', () => ({ createPiProvider }));
    vi.doMock('../../../../src/main/model/model_id_recognition', () => ({
      recognizeModelByIdReady: vi.fn(async () => ({ reasoning: true })),
    }));
    const providers = await import('../../../../src/main/features/custom_providers');
    const added = providers.addCustomProvider(UID, {
      name: 'Cache relay', protocol, baseUrl: 'https://relay.example/v1', apiKey: 'test-key',
      models: [{ id: 'deepseek-flash', ...(capabilities ? { capabilities } : {}) }],
    });
    if (!added.ok) throw new Error(added.error);
    const runtime = await import('../../../../src/main/model/core-agent/custom_provider_runtime');
    await runtime.createCustomProvider(UID, `cp:${added.id}`, 'test-key', 'deepseek-flash');
    expect(createPiProvider).toHaveBeenCalledWith(expect.objectContaining({
      cacheNamespace: UID,
      promptCachePolicy: policy,
      customModel: expect.objectContaining({ headers: { 'x-opencode-session': `cogseed-${added.id}` } }),
    }));
  });
});

describe('pure prompt cache translation', () => {
  const sessionId = 'already-scoped-safe-session';
  const none = { payload: {}, headers: {} };

  it.each(['openai-completions', 'openai-responses'])('gates each hint independently for %s', async (api) => {
    const { translatePromptCachePolicy: translate } = await import('../../../../src/core-agent/src/providers/prompt-cache-policy');
    expect(translate({ api, sessionId })).toEqual(none);
    expect(translate({ api, sessionId, cacheRetention: 'long', policy: { key: false, affinity: false } })).toEqual(none);
    const key = translate({ api, sessionId, cacheRetention: 'short', policy: { key: true, affinity: false } });
    expect(key).toEqual({ payload: { prompt_cache_key: sessionId }, headers: {} });
    expect(translate({ api, sessionId, cacheRetention: 'long', policy: { key: true, affinity: false } })).toEqual(key);
    expect(translate({ api, sessionId, policy: { key: false, affinity: true } })).toEqual({
      payload: {}, headers: { session_id: sessionId, 'x-client-request-id': sessionId, 'x-session-affinity': sessionId },
    });
  });

  it('requires explicit retention and lets none override every hint', async () => {
    const { translatePromptCachePolicy: translate } = await import('../../../../src/core-agent/src/providers/prompt-cache-policy');
    const policy = { key: true, affinity: true, retention: '24h' } as const;
    for (const retention of ['in-memory', '24h'] as const) {
      expect(translate({ api: 'openai-completions', sessionId, cacheRetention: 'short', policy: { ...policy, retention } }).payload)
        .toEqual({ prompt_cache_key: sessionId, prompt_cache_retention: retention });
    }
    expect(translate({ api: 'openai-completions', sessionId, cacheRetention: 'none', policy })).toEqual(none);
    expect(translate({ api: 'openai-completions', sessionId, policy: { key: false, affinity: false, retention: '24h' } })).toEqual(none);
    expect(translate({ api: 'openai-completions', sessionId: '', policy })).toEqual(none);
    expect(translate({ api: 'anthropic-messages', sessionId, policy })).toEqual(none);
    expect(translate({ api: 'google-generative-ai', sessionId, policy })).toEqual(none);
  });

  it('preserves the scoped key across rounds and separates different scoped sessions', async () => {
    const { translatePromptCachePolicy: translate } = await import('../../../../src/core-agent/src/providers/prompt-cache-policy');
    const input = { api: 'openai-completions', sessionId, policy: { key: true, affinity: true } };
    expect(translate(input)).toEqual(translate(input));
    const other = translate({ ...input, sessionId: 'other-user-scoped-session' });
    expect(other.payload.prompt_cache_key).not.toBe(translate(input).payload.prompt_cache_key);
    expect(other.headers.session_id).toBe('other-user-scoped-session');
  });
});
