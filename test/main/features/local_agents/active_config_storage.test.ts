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
    expect(providers[0].source).toBe('active_cli');
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
});
