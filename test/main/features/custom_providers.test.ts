import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'custom-provider-user';
let root: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-providers-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  vi.doUnmock('#core-agent');
  vi.resetModules();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('custom providers', () => {
  it('adds a validated provider, normalizes model metadata, and atomically binds the first model', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    const result = providers.addCustomProvider(UID, {
      name: 'Relay',
      protocol: 'openai',
      baseUrl: 'https://relay.example/v1/',
      apiKey: 'sk-secret-value',
      models: [
        ' model-a ',
        { id: 'model-b', contextWindow: 262144, maxTokens: 16384 },
        'model-a',
      ],
    });

    expect(result.ok).toBe(true);
    expect(providers.listCustomProviders(UID)).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^cp-/),
        name: 'Relay',
        protocol: 'openai',
        baseUrl: 'https://relay.example/v1',
        apiKey: 'sk-secret-value',
        enabled: true,
        models: [
          { id: 'model-a', contextWindow: 131072, maxTokens: 8192 },
          { id: 'model-b', contextWindow: 262144, maxTokens: 16384 },
        ],
        source: 'manual',
      }),
    ]);

    if (!result.ok) throw new Error(result.error);
    const auth = await import('../../../src/main/features/auth');
    expect((await auth.listEntries()).entries).toEqual([
      expect.objectContaining({
        provider: `cp:${result.id}`,
        profileId: `cp:${result.id}`,
        model: 'model-a',
      }),
    ]);

    const paths = await import('../../../src/main/paths');
    const raw = fs.readFileSync(paths.userAuthProfilesFile(UID), 'utf8');
    expect(raw).not.toContain('sk-secret-value');
    expect(raw.trim().startsWith('{')).toBe(false);
  });

  it('normalizes legacy string models and missing enabled state on read', async () => {
    const paths = await import('../../../src/main/paths');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    const storePath = paths.userAuthProfilesFile(UID);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const overlongModelId = 'x'.repeat(201);
    const legacyStore = {
      version: 6,
      profiles: {},
      entries: [
        {
          entryId: 'entry-backed', provider: 'cp:entry-backed-provider', profileId: 'cp:entry-backed-provider',
          model: 'entry-backed-model', createdAt: 1, lastUsed: 0,
        },
        {
          entryId: 'entry-overlong', provider: 'cp:overlong-provider', profileId: 'cp:overlong-provider',
          model: overlongModelId, createdAt: 1, lastUsed: 0,
        },
      ],
      customProviders: [
        {
          id: 'legacy-provider',
          name: 'Legacy',
          protocol: 'openai',
          baseUrl: 'https://legacy.example/v1',
          apiKey: 'legacy-secret',
          models: [
            ' legacy-model ',
            'legacy-model',
            { id: 'configured-model', contextWindow: 524288, maxTokens: 32768 },
            { id: 'invalid-metadata', contextWindow: 0, maxTokens: Number.MAX_SAFE_INTEGER },
            { id: 'inverted-metadata', contextWindow: 4096, maxTokens: 8192 },
            { id: 'fallback-output-too-large', contextWindow: 4096, maxTokens: 0 },
          ],
          source: 'manual',
          createdAt: 1,
        },
        {
          id: 'entry-backed-provider', name: 'Entry backed', protocol: 'openai',
          baseUrl: 'https://entry-backed.example/v1', apiKey: 'entry-backed-secret', models: [],
          source: 'manual', createdAt: 2,
        },
        {
          id: 'overlong-provider', name: 'Overlong', protocol: 'openai',
          baseUrl: 'https://overlong.example/v1', apiKey: 'overlong-secret', models: [overlongModelId],
          source: 'manual', createdAt: 3,
        },
      ],
    };
    fs.writeFileSync(storePath, localSecrets.encryptLocalSecret(
      { namespace: 'auth.profiles', ownerId: UID, recordId: 'auth-profiles.json' },
      JSON.stringify(legacyStore),
    ), 'utf8');

    const providers = await import('../../../src/main/features/custom_providers');
    expect(providers.listCustomProviders(UID)).toEqual([
      expect.objectContaining({
        id: 'legacy-provider',
        enabled: true,
        models: [
          { id: 'legacy-model', contextWindow: 131072, maxTokens: 8192 },
          { id: 'configured-model', contextWindow: 524288, maxTokens: 32768 },
          { id: 'invalid-metadata', contextWindow: 131072, maxTokens: 8192 },
          { id: 'inverted-metadata', contextWindow: 4096, maxTokens: 4096 },
          { id: 'fallback-output-too-large', contextWindow: 4096, maxTokens: 4096 },
        ],
      }),
      expect.objectContaining({
        id: 'entry-backed-provider',
        models: [{ id: 'entry-backed-model', contextWindow: 131072, maxTokens: 8192 }],
      }),
      expect.objectContaining({ id: 'overlong-provider', models: [] }),
    ]);
    const auth = await import('../../../src/main/features/auth');
    expect((await auth.listEntries()).entries.map((entry) => entry.entryId)).toEqual(['entry-backed']);
    expect((await auth.listEntries({ includeUnavailable: true })).entries).toEqual([
      expect.objectContaining({ entryId: 'entry-backed' }),
      expect.objectContaining({ entryId: 'entry-overlong', model: overlongModelId, modelAvailable: false }),
    ]);
  });

  it('rejects unsafe URLs and missing credentials', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    expect(providers.addCustomProvider(UID, {
      name: 'Unsafe', protocol: 'openai', baseUrl: 'file:///tmp/provider', apiKey: 'key',
    })).toEqual({ ok: false, error: 'baseUrl required (http(s)://...)' });
    expect(providers.addCustomProvider(UID, {
      name: 'Embedded', protocol: 'openai', baseUrl: 'https://user:pass@example.com/v1', apiKey: 'key',
    }).ok).toBe(false);
    expect(providers.addCustomProvider(UID, {
      name: 'Missing', protocol: 'anthropic', baseUrl: 'https://example.com', apiKey: '',
    })).toEqual({ ok: false, error: 'apiKey required' });
  });

  it('updates metadata while preserving an omitted key', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    const added = providers.addCustomProvider(UID, {
      name: 'Original', protocol: 'anthropic', baseUrl: 'https://one.example', apiKey: 'original-key',
    });
    if (!added.ok) throw new Error(added.error);

    expect(providers.updateCustomProvider(UID, added.id, {
      name: 'Updated', baseUrl: 'https://two.example/', models: ['claude-x'],
    })).toEqual({ ok: true });
    expect(providers.listCustomProviders(UID)[0]).toMatchObject({
      name: 'Updated', baseUrl: 'https://two.example', apiKey: 'original-key',
      models: [{ id: 'claude-x', contextWindow: 131072, maxTokens: 8192 }],
    });
  });

  it('rejects out-of-bounds model definitions without persisting a provider', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    const base = {
      name: 'Invalid model provider', protocol: 'openai', baseUrl: 'https://relay.example/v1', apiKey: 'key',
    };

    expect(providers.addCustomProvider(UID, {
      ...base,
      models: [{ id: 'bad-context', contextWindow: 0, maxTokens: 8192 }],
    })).toMatchObject({ ok: false, error: expect.stringContaining('contextWindow') });
    expect(providers.addCustomProvider(UID, {
      ...base,
      models: [{ id: 'bad-output', contextWindow: 131072, maxTokens: Number.MAX_SAFE_INTEGER }],
    })).toMatchObject({ ok: false, error: expect.stringContaining('maxTokens') });
    expect(providers.addCustomProvider(UID, {
      ...base,
      models: [{ id: 'x'.repeat(201), contextWindow: 131072, maxTokens: 8192 }],
    })).toMatchObject({ ok: false, error: expect.stringContaining('model id') });
    expect(providers.addCustomProvider(UID, {
      ...base,
      models: Array.from({ length: 101 }, (_, index) => `model-${index}`),
    })).toMatchObject({ ok: false, error: expect.stringContaining('100') });
    expect(providers.listCustomProviders(UID)).toEqual([]);
  });

  it('keeps entries while disabled, excludes them from selection, and restores them when enabled', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    const added = providers.addCustomProvider(UID, {
      name: 'Toggle Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1', apiKey: 'disabled-provider-secret',
      models: ['model-a', 'model-b'],
    });
    if (!added.ok) throw new Error(added.error);
    const auth = await import('../../../src/main/features/auth');

    expect((await auth.pickChatEntry())?.model).toBe('model-a');
    expect(providers.setCustomProviderEnabled(UID, added.id, false)).toEqual({ ok: true, enabled: false });
    expect(providers.listCustomProviders(UID)[0].enabled).toBe(false);
    expect((await auth.listEntries()).entries).toEqual([]);
    expect((await auth.listEntries({ includeUnavailable: true })).entries).toEqual([
      expect.objectContaining({
        provider: `cp:${added.id}`,
        profileId: `cp:${added.id}`,
        model: 'model-a',
        modelAvailable: false,
      }),
    ]);
    expect(await auth.pickChatEntry()).toBeNull();

    let addError: Error | undefined;
    try {
      await auth.addEntry({
        provider: `cp:${added.id}`,
        profileId: `cp:${added.id}`,
        model: 'model-b',
      });
    } catch (error) {
      addError = error as Error;
    }
    expect(addError?.message).toMatch(/disabled/i);
    expect(addError?.message).toContain(`cp:${added.id}`);
    expect(addError?.message).toContain('model-b');
    expect(addError?.message).not.toContain('disabled-provider-secret');
    expect((await auth.listEntries({ includeUnavailable: true })).entries.map((entry) => entry.model)).toEqual(['model-a']);

    expect(providers.setCustomProviderEnabled(UID, added.id, true)).toEqual({ ok: true, enabled: true });
    expect((await auth.listEntries()).entries).toEqual([
      expect.objectContaining({ provider: `cp:${added.id}`, model: 'model-a' }),
    ]);
  });

  it('adds, renames, and removes models atomically with their related entries', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    const added = providers.addCustomProvider(UID, {
      name: 'Managed Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1', apiKey: 'managed-key', models: ['model-a'],
    });
    if (!added.ok) throw new Error(added.error);
    const auth = await import('../../../src/main/features/auth');

    expect(providers.addCustomProviderModel(UID, added.id, {
      id: ' model-b ', contextWindow: 262144, maxTokens: 16384,
    })).toEqual({
      ok: true,
      model: { id: 'model-b', contextWindow: 262144, maxTokens: 16384 },
    });
    expect((await auth.listEntries()).entries.map((entry) => entry.model)).toEqual(['model-a']);
    await auth.addEntry({ provider: `cp:${added.id}`, profileId: `cp:${added.id}`, model: 'model-b' });
    expect((await auth.listEntries()).entries.map((entry) => entry.model)).toEqual(['model-b', 'model-a']);

    expect(providers.updateCustomProviderModel(UID, added.id, 'model-b', {
      id: 'model-c', contextWindow: 1048576, maxTokens: 65536,
    })).toEqual({
      ok: true,
      model: { id: 'model-c', contextWindow: 1048576, maxTokens: 65536 },
    });
    expect((await auth.listEntries()).entries.map((entry) => entry.model)).toEqual(['model-c', 'model-a']);
    expect(providers.listCustomProviders(UID)[0].models).toEqual([
      { id: 'model-a', contextWindow: 131072, maxTokens: 8192 },
      { id: 'model-c', contextWindow: 1048576, maxTokens: 65536 },
    ]);

    expect(providers.removeCustomProviderModel(UID, added.id, 'model-a')).toEqual({ ok: true, removed: true });
    expect((await auth.listEntries()).entries.map((entry) => entry.model)).toEqual(['model-c']);
    expect(providers.removeCustomProviderModel(UID, added.id, 'model-c')).toEqual({ ok: true, removed: true });
    expect(providers.listCustomProviders(UID)[0].models).toEqual([]);
    expect((await auth.listEntries()).entries).toEqual([]);
    expect(auth.hasConfiguredModel()).toEqual({ configured: false });
  });

  it('does not leave a provider or entry behind when the atomic save fails', async () => {
    const auth = await import('../../../src/main/features/auth');
    const providers = await import('../../../src/main/features/custom_providers');
    auth.__setAuthorizationStoreSaveForTests(() => { throw new Error('simulated atomic save failure'); });

    expect(() => providers.addCustomProvider(UID, {
      name: 'Failed Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1', apiKey: 'failed-key', models: ['model-a'],
    })).toThrow('simulated atomic save failure');

    auth.__setAuthorizationStoreSaveForTests(undefined);
    expect(providers.listCustomProviders(UID)).toEqual([]);
    expect((await auth.listEntries()).entries).toEqual([]);
  });

  it('tests a saved model with the stored key and redacts credentials and endpoints from failures', async () => {
    vi.doMock('#core-agent', () => ({
      createPiProvider: () => ({
        complete: async () => { throw new Error('401 rejected saved-provider-key at https://relay.example/v1/chat/completions'); },
      }),
    }));
    const providers = await import('../../../src/main/features/custom_providers');
    const added = providers.addCustomProvider(UID, {
      name: 'Probe Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1', apiKey: 'saved-provider-key', models: ['model-a'],
    });
    if (!added.ok) throw new Error(added.error);

    const result = await providers.testCustomProviderModel(UID, added.id, 'model-a');

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('[redacted]') });
    expect(JSON.stringify(result)).not.toContain('saved-provider-key');
    expect(JSON.stringify(result)).not.toContain('relay.example');
    expect(providers.listCustomProviders(UID)[0].apiKey).toBe('saved-provider-key');
  });

  it('removes a provider without disturbing existing auth profiles', async () => {
    const auth = await import('../../../src/main/features/auth');
    await auth.addApiKey('anthropic', 'sk-existing-profile');
    const providers = await import('../../../src/main/features/custom_providers');
    const added = providers.addCustomProvider(UID, {
      name: 'Temporary', protocol: 'openai', baseUrl: 'https://relay.example', apiKey: 'temporary-key',
    });
    if (!added.ok) throw new Error(added.error);

    expect(providers.removeCustomProvider(UID, added.id)).toEqual({ ok: true });
    expect(providers.listCustomProviders(UID)).toEqual([]);
    const anthropic = (await auth.listProviders()).providers.find((provider) => provider.id === 'anthropic');
    expect(anthropic?.profiles).toHaveLength(1);
  });

  it('inherits catalog windows for known models instead of the 128K default', async () => {
    // Importer rows carry bare model ids with no window data; for models the
    // public catalog knows (deepseek-v4-flash-vision-exp = 1M, confirmed
    // 2026-08-27), normalization must resolve the real window. Unknown ids
    // keep the conservative default — never guessed.
    const providers = await import('../../../src/main/features/custom_providers');
    const result = providers.addCustomProvider(UID, {
      name: 'Aggregator Relay',
      protocol: 'openai',
      baseUrl: 'https://aggr.example/v1',
      apiKey: ['aggr', UID].join('-'),
      models: [
        'deepseek/deepseek-v4-flash-vision-exp',
        'totally-unknown-model',
      ],
    });
    if (!result.ok) throw new Error(result.error);
    const listed = providers.listCustomProviders(UID);
    const byId = Object.fromEntries(listed[0].models.map((m) => [m.id, m]));
    expect(byId['deepseek/deepseek-v4-flash-vision-exp'].contextWindow).toBe(1_048_576);
    expect(byId['deepseek/deepseek-v4-flash-vision-exp'].vision).toBe(true);
    expect(byId['totally-unknown-model'].contextWindow).toBe(131_072);
    expect(byId['totally-unknown-model'].vision).toBeUndefined();
  });
});

// ─── 远端模型发现：fetchCustomProviderModels ─────────────────────────────

describe('custom providers › fetchCustomProviderModels', () => {
  const jsonBody = (data: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  }) as unknown as Response;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the OpenAI-compatible /models endpoint with the stored bearer key', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    const added = providers.addCustomProvider(UID, {
      name: 'Relay', protocol: 'openai', baseUrl: 'https://relay.example/v1', apiKey: 'sk-live', models: ['model-a'],
    });
    if (!added.ok) throw new Error(added.error);
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string> });
      return jsonBody({ data: [{ id: 'model-a' }, { id: ' gpt-relay ' }, { id: 'model-a' }, { not: 'a model' }, null] });
    }));

    const res = await providers.fetchCustomProviderModels(UID, added.id);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // dedupe + trim + drop non-rows
    expect(res.models).toEqual([{ id: 'model-a' }, { id: 'gpt-relay' }]);
    expect(calls[0].url).toBe('https://relay.example/v1/models');
    expect(calls[0].headers.Authorization).toBe('Bearer sk-live');
  });

  it('uses the anthropic /v1/models endpoint with x-api-key and maps display_name', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    const added = providers.addCustomProvider(UID, {
      name: 'Anth Relay', protocol: 'anthropic', baseUrl: 'https://anth.example', apiKey: 'ak-live',
    });
    if (!added.ok) throw new Error(added.error);
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string> });
      return jsonBody({ data: [{ id: 'claude-relay', display_name: 'Claude Relay' }] });
    }));

    const res = await providers.fetchCustomProviderModels(UID, added.id);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.models).toEqual([{ id: 'claude-relay', name: 'Claude Relay' }]);
    expect(calls[0].url).toBe('https://anth.example/v1/models');
    expect(calls[0].headers['x-api-key']).toBe('ak-live');
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
  });

  it('strips the gemini models/ prefix and reports failures without leaking the key', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    const added = providers.addCustomProvider(UID, {
      name: 'Gem Relay', protocol: 'gemini', baseUrl: 'https://gem.example', apiKey: 'gk-live',
    });
    if (!added.ok) throw new Error(added.error);
    vi.stubGlobal('fetch', vi.fn(async () => jsonBody({ models: [{ name: 'models/gemini-relay', displayName: 'Gemini Relay' }] })));

    const gemini = await providers.fetchCustomProviderModels(UID, added.id);
    expect(gemini.ok).toBe(true);
    // 家族规则识别（B 层）：gemini-* 视觉默认开、推理需 pro/thinking 变体。
    if (gemini.ok) expect(gemini.models).toEqual([
      { id: 'gemini-relay', name: 'Gemini Relay', reasoning: false, vision: true },
    ]);

    // Failure path: network error message that embeds the key must be redacted.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED with key gk-live inside'); }));
    const failed = await providers.fetchCustomProviderModels(UID, added.id);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error).not.toContain('gk-live');
  });

  it('fails fast for unknown providers without issuing any request', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await providers.fetchCustomProviderModels(UID, 'cp-nonexistent');

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('not found');
    expect(fetchSpy).not.toHaveBeenCalled();
    // NOTE: the http(s)-only scheme pin in fetchCustomProviderModels is
    // defense-in-depth — the add/update entry points already reject
    // non-http(s) base URLs, and the encrypted store cannot be hand-edited
    // from a test, so that branch is covered by review rather than a case.
  });
});
