import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'cli-provider-user';
let root: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-provider-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('local agent custom provider env', () => {
  it('maps compatible providers to Claude and Codex env variables', async () => {
    const providers = await import('../../../../src/main/features/custom_providers');
    const anthropic = providers.addCustomProvider(UID, {
      name: 'Claude Relay', protocol: 'anthropic', baseUrl: 'https://claude.example', apiKey: 'claude-secret',
    });
    const openai = providers.addCustomProvider(UID, {
      name: 'Codex Relay', protocol: 'openai', baseUrl: 'https://codex.example/v1', apiKey: 'codex-secret',
    });
    if (!anthropic.ok || !openai.ok) throw new Error('fixture setup failed');
    const env = await import('../../../../src/main/features/local_agents/provider_env');

    expect(env.resolveCliProviderEnv(UID, 'claude', `cp:${anthropic.id}`)).toEqual({
      ANTHROPIC_BASE_URL: 'https://claude.example',
      ANTHROPIC_AUTH_TOKEN: 'claude-secret',
    });
    expect(env.resolveCliProviderEnv(UID, 'codex', `cp:${openai.id}`)).toEqual({
      OPENAI_BASE_URL: 'https://codex.example/v1',
      OPENAI_API_KEY: 'codex-secret',
    });
  });

  it('returns undefined for mismatches, missing providers, and unsupported CLIs', async () => {
    const providers = await import('../../../../src/main/features/custom_providers');
    const anthropic = providers.addCustomProvider(UID, {
      name: 'Claude Relay', protocol: 'anthropic', baseUrl: 'https://claude.example', apiKey: 'secret',
    });
    if (!anthropic.ok) throw new Error(anthropic.error);
    const env = await import('../../../../src/main/features/local_agents/provider_env');
    expect(env.resolveCliProviderEnv(UID, 'codex', `cp:${anthropic.id}`)).toBeUndefined();
    expect(env.resolveCliProviderEnv(UID, 'hermes', `cp:${anthropic.id}`)).toBeUndefined();
    expect(env.resolveCliProviderEnv(UID, 'claude', 'cp:missing')).toBeUndefined();
  });

  it('does not inject credentials for a disabled custom provider', async () => {
    const providers = await import('../../../../src/main/features/custom_providers');
    const created = providers.addCustomProvider(UID, {
      name: 'Disabled Relay', protocol: 'openai', baseUrl: 'https://disabled.example/v1', apiKey: 'disabled-secret',
    });
    if (!created.ok) throw new Error(created.error);
    expect(providers.setCustomProviderEnabled(UID, created.id, false)).toEqual({ ok: true, enabled: false });

    const env = await import('../../../../src/main/features/local_agents/provider_env');
    expect(env.resolveCliProviderEnv(UID, 'codex', `cp:${created.id}`)).toBeUndefined();
  });
});
