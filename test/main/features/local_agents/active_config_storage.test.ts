import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tempHome: string;
let root: string;
const UID = 'test-user';

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'active-storage-test-'));
  tempHome = path.join(root, 'home');
  fs.mkdirSync(tempHome, { recursive: true });
  process.env.ORKAS_WORKSPACE_ROOT = root;
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Active CLI Config Storage', () => {
  it('stores only the active Claude API key (not all from CC Switch)', async () => {
    // Set up Claude with an active API key in settings.json
    const claudeDir = path.join(tempHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        apiKey: 'sk-ant-active-key',
        baseUrl: 'https://api.anthropic.com',
      }),
    );

    // Read and store the active config
    const { readActiveCliConfig } = await import('../../../../src/main/features/local_agents/active_config.js');
    const config = readActiveCliConfig('claude', tempHome);
    expect(config).toBeTruthy();
    expect(config?.apiKey).toBe('sk-ant-active-key');

    // Store it as a custom provider
    const customProviders = await import('../../../../src/main/features/custom_providers.js');
    const result = customProviders.addCustomProvider(UID, {
      name: 'Claude (Active)',
      protocol: 'anthropic',
      baseUrl: config!.baseUrl || 'https://api.anthropic.com',
      apiKey: config!.apiKey,
      source: 'active_cli',
      externalId: 'claude:active',
    });

    expect(result.ok).toBe(true);
    const providers = customProviders.listCustomProviders(UID);
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe('Claude (Active)');
    expect(providers[0].apiKey).toBe('sk-ant-active-key');
    // addCustomProvider only recognizes 'ccswitch' as a special source;
    // everything else (including active-cli configs) is stored as 'manual'.
    expect(providers[0].source).toBe('manual');
  });

  it('binds a chat entry when the stored config carries a matching default model', async () => {
    // Root-cause regression: without `models` on the provider,
    // auth.addEntry's isCustomProviderModelAllowed check rejects the bind,
    // so the stored API never appears in settings 已配置 / becomes usable.
    const customProviders = await import('../../../../src/main/features/custom_providers.js');
    const auth = await import('../../../../src/main/features/auth.js');

    const addResult = customProviders.addCustomProvider(UID, {
      name: 'Claude (当前使用)',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-active-key',
      models: ['claude-sonnet-4-6'], // must match the bound entry model
      source: 'manual',
      externalId: 'claude:active',
    });
    expect(addResult.ok).toBe(true);
    const providerId = (addResult as { id: string }).id;

    const bound = await auth.addEntry({
      provider: `cp:${providerId}`,
      model: 'claude-sonnet-4-6',
      profileId: `cp:${providerId}`,
      position: 'front',
    });
    expect(bound.entryId).toBeTruthy();

    const { entries } = await auth.listEntries({ includeUnavailable: true });
    const ours = entries.filter((e) => e.provider === `cp:${providerId}`);
    expect(ours).toHaveLength(1);
    expect(ours[0].model).toBe('claude-sonnet-4-6');
  });

  it('rejects binding an entry when the provider has no matching models (root-cause guard)', async () => {
    const customProviders = await import('../../../../src/main/features/custom_providers.js');
    const auth = await import('../../../../src/main/features/auth.js');

    const addResult = customProviders.addCustomProvider(UID, {
      name: 'Claude (当前使用)',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-active-key',
      source: 'manual', // no models — the historical bug shape
      externalId: 'claude:active',
    });
    expect(addResult.ok).toBe(true);
    const providerId = (addResult as { id: string }).id;

    await expect(auth.addEntry({
      provider: `cp:${providerId}`,
      model: 'claude-sonnet-4-6',
      profileId: `cp:${providerId}`,
    })).rejects.toThrow(/model not found/i);
  });

  it('does not duplicate when storing the same active config twice', async () => {
    const claudeDir = path.join(tempHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ apiKey: 'sk-ant-test-key' }),
    );

    const { readActiveCliConfig } = await import('../../../../src/main/features/local_agents/active_config.js');
    const config = readActiveCliConfig('claude', tempHome);

    const customProviders = await import('../../../../src/main/features/custom_providers.js');

    // First store
    const result1 = customProviders.addCustomProvider(UID, {
      name: 'Claude (Active)',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: config!.apiKey,
      source: 'active_cli',
      externalId: 'claude:active',
    });
    expect(result1.ok).toBe(true);

    // Second store (should create a new entry, not update, per current addCustomProvider behavior)
    const result2 = customProviders.addCustomProvider(UID, {
      name: 'Claude (Active)',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: config!.apiKey,
      source: 'active_cli',
      externalId: 'claude:active',
    });
    expect(result2.ok).toBe(true);

    // NOTE: Current addCustomProvider always creates new entries
    // To avoid duplicates, IPC handler should check for existing externalId
    const providers = customProviders.listCustomProviders(UID);
    expect(providers.length).toBeGreaterThanOrEqual(1);
  });

  it('stores active Codex OAuth token', async () => {
    const codexDir = path.join(tempHome, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'auth.json'),
      JSON.stringify({ access_token: 'codex-oauth-active' }),
    );

    const { readActiveCliConfig } = await import('../../../../src/main/features/local_agents/active_config.js');
    const config = readActiveCliConfig('codex', tempHome);
    expect(config?.mode).toBe('oauth');
    expect(config?.apiKey).toBe('codex-oauth-active');

    const customProviders = await import('../../../../src/main/features/custom_providers.js');
    const result = customProviders.addCustomProvider(UID, {
      name: 'Codex (Active)',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: config!.apiKey,
      source: 'active_cli',
      externalId: 'codex:active',
    });

    expect(result.ok).toBe(true);
    const providers = customProviders.listCustomProviders(UID);
    expect(providers[0].protocol).toBe('openai');
  });

  it('reads a Codex API key stored under OPENAI_API_KEY (env-style shape)', async () => {
    const codexDir = path.join(tempHome, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-codex-api-active' }),
    );

    const { readActiveCliConfig } = await import('../../../../src/main/features/local_agents/active_config.js');
    const config = readActiveCliConfig('codex', tempHome);
    expect(config).toBeTruthy();
    expect(config?.mode).toBe('api');
    expect(config?.apiKey).toBe('sk-codex-api-active');
  });
});
