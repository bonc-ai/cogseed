import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'model-authorization-user';
let root: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-authorizations-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(async () => {
  try {
    const auth = await import('../../../src/main/features/auth');
    auth.__setAuthorizationStoreSaveForTests(undefined);
  } catch { /* module may not have loaded */ }
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('model authorizations', () => {
  it('atomically creates one built-in API-key profile with multiple ordered models', async () => {
    const auth = await import('../../../src/main/features/auth');
    const result = await auth.completeAuthorization(UID, {
      requestId: 'req-built-in-1',
      authType: 'api_key',
      source: 'manual',
      providerKind: 'builtin',
      providerId: 'anthropic',
      label: 'work',
      apiKey: 'sk-test-authorization',
      selectedModels: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-opus-4-8'],
      defaultModel: 'claude-sonnet-4-6',
    });

    expect(result.authorization).toMatchObject({
      authorizationId: 'profile:anthropic:work',
      authType: 'api_key',
      providerId: 'anthropic',
      enabledModels: ['claude-sonnet-4-6', 'claude-opus-4-8'],
      defaultModel: 'claude-sonnet-4-6',
      unbound: false,
    });
    expect(JSON.stringify(result)).not.toContain('sk-test-authorization');

    const providers = await auth.listProviders();
    expect(providers.providers.find((p) => p.id === 'anthropic')?.profiles).toHaveLength(1);
    expect((await auth.listEntries()).entries.map((entry) => entry.model)).toEqual([
      'claude-sonnet-4-6',
      'claude-opus-4-8',
    ]);
  });

  it('creates a custom authorization whose models share the synthetic provider/profile id', async () => {
    const auth = await import('../../../src/main/features/auth');
    const result = await auth.completeAuthorization(UID, {
      requestId: 'req-custom-1',
      authType: 'api_key',
      source: 'ccswitch',
      providerKind: 'custom',
      customProvider: {
        name: 'Relay',
        protocol: 'openai',
        baseUrl: 'https://relay.example/v1/',
        apiKey: 'relay-secret-key',
        externalId: 'codex:relay',
      },
      selectedModels: ['model-a', 'model-b'],
      defaultModel: 'model-b',
    });

    expect(result.authorization).toMatchObject({
      authorizationId: expect.stringMatching(/^custom:cp-/),
      authType: 'api_key',
      source: 'ccswitch',
      enabledModels: ['model-b', 'model-a'],
      defaultModel: 'model-b',
      baseUrl: 'https://relay.example/v1',
    });
    const customId = result.authorization.authorizationId.slice('custom:'.length);
    const entries = (await auth.listEntries()).entries;
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.provider === `cp:${customId}` && entry.profileId === `cp:${customId}`)).toBe(true);
    expect(JSON.stringify(auth.listAuthorizationSummaries(UID))).not.toContain('relay-secret-key');
  });

  it('rejects empty selections and defaults outside the selection without persisting anything', async () => {
    const auth = await import('../../../src/main/features/auth');
    await expect(auth.completeAuthorization(UID, {
      requestId: 'req-empty', authType: 'api_key', source: 'manual', providerKind: 'builtin',
      providerId: 'anthropic', apiKey: 'secret-key', selectedModels: [], defaultModel: '',
    })).rejects.toThrow('selectedModels');
    await expect(auth.completeAuthorization(UID, {
      requestId: 'req-bad-default', authType: 'api_key', source: 'manual', providerKind: 'builtin',
      providerId: 'anthropic', apiKey: 'secret-key', selectedModels: ['claude-opus-4-8'], defaultModel: 'other',
    })).rejects.toThrow('defaultModel');
    expect(auth.listAuthorizationSummaries(UID).authorizations).toEqual([]);
  });

  it('is idempotent by request id and serializes concurrent completions', async () => {
    const auth = await import('../../../src/main/features/auth');
    const input = {
      requestId: 'req-repeat', authType: 'api_key' as const, source: 'manual' as const, providerKind: 'builtin' as const,
      providerId: 'anthropic', label: 'repeat', apiKey: 'repeat-secret',
      selectedModels: ['claude-opus-4-8'], defaultModel: 'claude-opus-4-8',
    };
    const first = await auth.completeAuthorization(UID, input);
    const repeated = await auth.completeAuthorization(UID, input);
    expect(repeated).toEqual(first);

    await Promise.all([
      auth.completeAuthorization(UID, {
        requestId: 'req-concurrent-a', authType: 'api_key', source: 'manual', providerKind: 'builtin',
        providerId: 'openai', label: 'one', apiKey: 'openai-secret-one', selectedModels: ['gpt-5.5'], defaultModel: 'gpt-5.5',
      }),
      auth.completeAuthorization(UID, {
        requestId: 'req-concurrent-b', authType: 'api_key', source: 'manual', providerKind: 'builtin',
        providerId: 'openai', label: 'two', apiKey: 'openai-secret-two', selectedModels: ['gpt-5.4'], defaultModel: 'gpt-5.4',
      }),
    ]);

    const summaries = auth.listAuthorizationSummaries(UID).authorizations;
    expect(summaries).toHaveLength(3);
    expect((await auth.listEntries()).entries).toHaveLength(3);
  });

  it('leaves the previous encrypted store unchanged when the authorization save fails', async () => {
    const auth = await import('../../../src/main/features/auth');
    await auth.completeAuthorization(UID, {
      requestId: 'req-existing', authType: 'api_key', source: 'manual', providerKind: 'builtin',
      providerId: 'anthropic', label: 'existing', apiKey: 'existing-secret',
      selectedModels: ['claude-opus-4-8'], defaultModel: 'claude-opus-4-8',
    });
    const paths = await import('../../../src/main/paths');
    const storePath = paths.userAuthProfilesFile(UID);
    const before = fs.readFileSync(storePath);
    auth.__setAuthorizationStoreSaveForTests(() => { throw new Error('simulated save failure'); });

    await expect(auth.completeAuthorization(UID, {
      requestId: 'req-fail', authType: 'api_key', source: 'manual', providerKind: 'builtin',
      providerId: 'openai', label: 'failed', apiKey: 'failed-secret',
      selectedModels: ['gpt-5.5'], defaultModel: 'gpt-5.5',
    })).rejects.toThrow('simulated save failure');

    expect(fs.readFileSync(storePath)).toEqual(before);
    auth.__setAuthorizationStoreSaveForTests(undefined);
    expect(auth.listAuthorizationSummaries(UID).authorizations).toHaveLength(1);
  });

  it('lists unbound profiles and removes models or whole authorizations atomically', async () => {
    const auth = await import('../../../src/main/features/auth');
    const unbound = await auth.addApiKey('openai', 'unbound-secret', 'unbound');
    expect(auth.listAuthorizationSummaries(UID).authorizations).toEqual(expect.arrayContaining([
      expect.objectContaining({ authorizationId: `profile:${unbound.profileId}`, unbound: true, enabledModels: [] }),
    ]));

    const completed = await auth.completeAuthorization(UID, {
      requestId: 'req-remove', authType: 'api_key', source: 'manual', providerKind: 'builtin',
      providerId: 'anthropic', label: 'remove', apiKey: 'remove-secret',
      selectedModels: ['claude-opus-4-8', 'claude-sonnet-4-6'], defaultModel: 'claude-opus-4-8',
    });
    const entryId = completed.authorization.models[0].entryId;
    const removedModel = await auth.removeAuthorizationModel(UID, completed.authorization.authorizationId, entryId);
    expect(removedModel.removed).toBe(true);
    expect(removedModel.authorization?.enabledModels).toEqual(['claude-sonnet-4-6']);
    expect(removedModel.authorization?.defaultModel).toBe('claude-sonnet-4-6');

    expect(await auth.removeAuthorization(UID, completed.authorization.authorizationId)).toEqual({ removed: true });
    expect(auth.listAuthorizationSummaries(UID).authorizations.map((row) => row.authorizationId)).toEqual([
      `profile:${unbound.profileId}`,
    ]);
  });
  it('reports legacy orphan and unbound warnings without repairing during list', async () => {
    const paths = await import('../../../src/main/paths');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    const auth = await import('../../../src/main/features/auth');
    const storePath = paths.userAuthProfilesFile(UID);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const legacyStore = {
      version: 6,
      profiles: {
        'openai:unbound': { type: 'api_key', provider: 'openai', label: 'unbound', key: 'sk-unbound', createdAt: 1, lastUsed: 0 },
        'anthropic:work': { type: 'api_key', provider: 'anthropic', label: 'work', key: 'sk-work', createdAt: 1, lastUsed: 0 },
      },
      entries: [
        { entryId: 'entry-ok', provider: 'anthropic', profileId: 'anthropic:work', model: 'claude-opus-4-8', createdAt: 1, lastUsed: 0 },
        { entryId: 'entry-orphan', provider: 'openai', profileId: 'openai:missing', model: 'gpt-5.5', createdAt: 1, lastUsed: 0 },
        { entryId: 'entry-missing-custom', provider: 'cp:missing', profileId: 'cp:missing', model: 'custom-chat', createdAt: 1, lastUsed: 0 },
      ],
      searchProfiles: [], imageProfiles: [], videoProfiles: [], ttsProfiles: [], customProviders: [], authorizationRequests: [],
    };
    const encrypted = localSecrets.encryptLocalSecret({ namespace: 'auth.profiles', ownerId: UID, recordId: 'auth-profiles.json' }, JSON.stringify(legacyStore));
    fs.writeFileSync(storePath, encrypted, 'utf8');
    const before = fs.readFileSync(storePath, 'utf8');

    const listed = auth.listAuthorizationSummaries(UID);

    expect(fs.readFileSync(storePath, 'utf8')).toBe(before);
    expect(listed.authorizations).toEqual(expect.arrayContaining([
      expect.objectContaining({ authorizationId: 'profile:openai:unbound', unbound: true, warningCode: 'unbound_authorization' }),
      expect.objectContaining({ authorizationId: 'profile:anthropic:work', enabledModels: ['claude-opus-4-8'] }),
    ]));
    expect(listed.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'orphan_entry', entryId: 'entry-orphan' }),
      expect.objectContaining({ code: 'missing_custom_provider', entryId: 'entry-missing-custom' }),
    ]));
    expect((await auth.listEntries()).entries.map((entry) => entry.entryId)).toEqual(['entry-ok']);
    expect((await auth.listEntries({ includeUnavailable: true })).entries).toEqual([
      expect.objectContaining({ entryId: 'entry-ok' }),
      expect.objectContaining({ entryId: 'entry-orphan', modelAvailable: false }),
      expect.objectContaining({ entryId: 'entry-missing-custom', modelAvailable: false }),
    ]);
  });

  it('reuses an existing CC Switch custom authorization only after explicit completion', async () => {
    const auth = await import('../../../src/main/features/auth');
    const providers = await import('../../../src/main/features/custom_providers');
    const first = await auth.completeAuthorization(UID, {
      requestId: 'req-cc-first', authType: 'api_key', source: 'ccswitch', providerKind: 'custom',
      customProvider: { name: 'Claude Desktop', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'first-secret', externalId: 'claude:desktop' },
      selectedModels: ['claude-opus-4-8'], defaultModel: 'claude-opus-4-8',
    });
    const providerId = first.authorization.authorizationId.slice('custom:'.length);
    expect(providers.updateCustomProviderModel(UID, providerId, 'claude-opus-4-8', {
      id: 'claude-opus-4-8', contextWindow: 524288, maxTokens: 32768,
    })).toEqual({
      ok: true,
      model: { id: 'claude-opus-4-8', contextWindow: 524288, maxTokens: 32768 },
    });
    expect(providers.setCustomProviderEnabled(UID, providerId, false)).toEqual({ ok: true, enabled: false });

    expect(auth.listAuthorizationSummaries(UID).authorizations.find((row) => row.authorizationId === first.authorization.authorizationId)?.enabledModels).toEqual(['claude-opus-4-8']);

    const second = await auth.completeAuthorization(UID, {
      requestId: 'req-cc-second', authType: 'api_key', source: 'ccswitch', providerKind: 'custom',
      customProvider: { name: 'Claude Desktop Updated', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'second-secret', externalId: 'claude:desktop' },
      selectedModels: ['claude-sonnet-4-6', 'claude-opus-4-8'], defaultModel: 'claude-sonnet-4-6',
    });

    expect(second.authorization.authorizationId).toBe(first.authorization.authorizationId);
    expect(second.authorization.enabledModels).toEqual(['claude-sonnet-4-6', 'claude-opus-4-8']);
    expect(auth.listAuthorizationSummaries(UID).authorizations.filter((row) => row.source === 'ccswitch')).toHaveLength(1);
    expect(providers.listCustomProviders(UID)).toEqual([
      expect.objectContaining({
        id: providerId,
        enabled: false,
        models: [
          { id: 'claude-sonnet-4-6', contextWindow: 131072, maxTokens: 8192 },
          { id: 'claude-opus-4-8', contextWindow: 524288, maxTokens: 32768 },
        ],
      }),
    ]);
  });

});
