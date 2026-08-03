import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'custom-provider-user';
let root: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-providers-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('custom providers', () => {
  it('adds a validated provider to the encrypted auth store', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    const result = providers.addCustomProvider(UID, {
      name: 'Relay',
      protocol: 'openai',
      baseUrl: 'https://relay.example/v1/',
      apiKey: 'sk-secret-value',
      models: [' model-a ', 'model-b'],
    });

    expect(result.ok).toBe(true);
    expect(providers.listCustomProviders(UID)).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^cp-/),
        name: 'Relay',
        protocol: 'openai',
        baseUrl: 'https://relay.example/v1',
        apiKey: 'sk-secret-value',
        models: ['model-a', 'model-b'],
        source: 'manual',
      }),
    ]);

    const paths = await import('../../../src/main/paths');
    const raw = fs.readFileSync(paths.userAuthProfilesFile(UID), 'utf8');
    expect(raw).not.toContain('sk-secret-value');
    expect(raw.trim().startsWith('{')).toBe(false);
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
      name: 'Updated', baseUrl: 'https://two.example', apiKey: 'original-key', models: ['claude-x'],
    });
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
});
