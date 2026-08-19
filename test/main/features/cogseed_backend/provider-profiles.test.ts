import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER_A = 'cogseed-profile-user-a';
const USER_B = 'cogseed-profile-user-b';
const USER_C = 'cogseed-profile-user-c';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-provider-profiles-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function activateAndAddApiKey(userId: string, provider: string, key: string, baseUrl?: string): Promise<void> {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(userId);
  const auth = await import('../../../../src/main/features/auth');
  const { profileId } = await auth.addApiKey(provider, key, undefined, baseUrl ? { baseUrl } : undefined);
  await auth.addEntry({ provider, model: 'cogseed-test-model', profileId });
}

async function activateAndAddCustomProvider(
  userId: string,
  input: { name: string; protocol: 'openai' | 'openai-responses' | 'anthropic' | 'gemini'; baseUrl: string; apiKey: string; model: string },
): Promise<{ providerId: string }> {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(userId);
  const providers = await import('../../../../src/main/features/custom_providers');
  const result = providers.addCustomProvider(userId, {
    name: input.name,
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    models: [{ id: input.model }],
  });
  if (!result.ok) throw new Error('addCustomProvider failed: ' + result.error);
  return { providerId: `cp:${result.id}` };
}

describe('CogSeed provider profiles', () => {
  it('resolves an explicit user API-key profile without reading the active user profile', async () => {
    await activateAndAddApiKey(USER_A, 'openai-compatible', 'sk-user-a-only-key', 'https://provider-a.test/v1');
    await activateAndAddApiKey(USER_B, 'openai-compatible', 'sk-user-b-only-key', 'https://provider-b.test/v1');

    const users = await import('../../../../src/main/features/users');
    users.activateUser(USER_B);
    const { resolveCogSeedApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');

    await expect(resolveCogSeedApiKeyProfile(USER_A)).resolves.toMatchObject({
      profileId: 'openai-compatible:default',
      provider: 'openai-compatible',
      model: expect.any(String),
      apiKey: 'sk-user-a-only-key',
      baseUrl: 'https://provider-a.test/v1',
    });
  });

  it('rejects a missing profile', async () => {
    const { resolveCogSeedApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');

    await expect(resolveCogSeedApiKeyProfile(USER_A)).rejects.toThrow(/profile/i);
  });

  it('resolves an anthropic API-key profile to the anthropic wire protocol with the default endpoint', async () => {
    await activateAndAddApiKey(USER_A, 'anthropic', 'sk-ant-api03-anthropic-key');

    const users = await import('../../../../src/main/features/users');
    users.activateUser(USER_B);
    const { resolveCogSeedApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');

    await expect(resolveCogSeedApiKeyProfile(USER_A)).resolves.toMatchObject({
      profileId: 'anthropic:default',
      provider: 'anthropic',
      protocol: 'anthropic',
      model: 'cogseed-test-model',
      apiKey: 'sk-ant-api03-anthropic-key',
      baseUrl: 'https://api.anthropic.com',
      maxOutputTokens: 8192,
    });
  });

  it('resolves a google API-key profile to the gemini wire protocol', async () => {
    await activateAndAddApiKey(USER_A, 'google', 'google-api-key');

    const users = await import('../../../../src/main/features/users');
    users.activateUser(USER_B);
    const { resolveCogSeedApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');

    await expect(resolveCogSeedApiKeyProfile(USER_A)).resolves.toMatchObject({
      provider: 'google',
      protocol: 'gemini',
      apiKey: 'google-api-key',
      baseUrl: 'https://generativelanguage.googleapis.com',
      maxOutputTokens: 8192,
    });
  });

  it('resolves a moonshot API-key profile as an openai-completions entry with its default endpoint', async () => {
    await activateAndAddApiKey(USER_A, 'moonshot', 'sk-moonshot-key');

    const users = await import('../../../../src/main/features/users');
    users.activateUser(USER_B);
    const { resolveCogSeedApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');

    await expect(resolveCogSeedApiKeyProfile(USER_A)).resolves.toMatchObject({
      provider: 'moonshot',
      protocol: 'openai-completions',
      apiKey: 'sk-moonshot-key',
      baseUrl: 'https://api.moonshot.cn/v1',
    });
  });

  it('skips native-only profiles (zai) the runtime cannot reach', async () => {
    await activateAndAddApiKey(USER_A, 'zai', 'zai-key');

    const users = await import('../../../../src/main/features/users');
    users.activateUser(USER_B);
    const { resolveCogSeedApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');

    await expect(resolveCogSeedApiKeyProfile(USER_A)).rejects.toThrow(/profile/i);
  });

  it('reuses an OpenAI-protocol custom provider as the OpenAI-compatible profile', async () => {
    const { providerId } = await activateAndAddCustomProvider(USER_A, {
      name: 'Relay',
      protocol: 'openai',
      baseUrl: 'https://relay.example/v1/',
      apiKey: 'cp-secret-key',
      model: 'relay-model-1',
    });

    const users = await import('../../../../src/main/features/users');
    users.activateUser(USER_B);
    const { resolveCogSeedApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');

    await expect(resolveCogSeedApiKeyProfile(USER_A)).resolves.toMatchObject({
      profileId: providerId,
      provider: providerId,
      protocol: 'openai-completions',
      model: 'relay-model-1',
      apiKey: 'cp-secret-key',
      baseUrl: 'https://relay.example/v1',
    });
  });

  it('resolves an anthropic-protocol custom provider to the anthropic wire protocol', async () => {
    const { providerId } = await activateAndAddCustomProvider(USER_A, {
      name: 'Claude Relay',
      protocol: 'anthropic',
      baseUrl: 'https://anthropic-relay.example',
      apiKey: 'anthropic-relay-key',
      model: 'claude-relay-1',
    });

    const users = await import('../../../../src/main/features/users');
    users.activateUser(USER_B);
    const { resolveCogSeedApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');

    await expect(resolveCogSeedApiKeyProfile(USER_A)).resolves.toMatchObject({
      profileId: providerId,
      provider: providerId,
      protocol: 'anthropic',
      model: 'claude-relay-1',
      apiKey: 'anthropic-relay-key',
      baseUrl: 'https://anthropic-relay.example',
      maxOutputTokens: 8192,
    });
  });

  it('resolves a gemini-protocol custom provider to the gemini wire protocol', async () => {
    const { providerId } = await activateAndAddCustomProvider(USER_A, {
      name: 'Gemini Relay',
      protocol: 'gemini',
      baseUrl: 'https://gemini-relay.example/v1beta',
      apiKey: 'gemini-relay-key',
      model: 'gemini-relay-1',
    });

    const users = await import('../../../../src/main/features/users');
    users.activateUser(USER_B);
    const { resolveCogSeedApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');

    await expect(resolveCogSeedApiKeyProfile(USER_A)).resolves.toMatchObject({
      profileId: providerId,
      provider: providerId,
      protocol: 'gemini',
      model: 'gemini-relay-1',
      apiKey: 'gemini-relay-key',
      baseUrl: 'https://gemini-relay.example/v1beta',
      maxOutputTokens: 8192,
    });
  });

  it('reuses an unexpired anthropic OAuth profile with its access token', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser(USER_A);
    const auth = await import('../../../../src/main/features/auth');
    auth.saveProfilesForUser(USER_A, {
      version: 6,
      profiles: {
        'anthropic:default': {
          type: 'oauth',
          provider: 'anthropic',
          label: 'default',
          access: 'sk-ant-oat-access-token',
          refresh: 'refresh-token',
          expires: Date.now() + 60_000,
          createdAt: Date.now(),
          lastUsed: 0,
        },
      },
      entries: [{
        entryId: 'e-oauth-1',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        profileId: 'anthropic:default',
        lastUsed: 0,
        createdAt: Date.now(),
      }],
      searchProfiles: [],
      imageProfiles: [],
      videoProfiles: [],
      ttsProfiles: [],
      customProviders: [],
      authorizationRequests: [],
    });
    users.activateUser(USER_B);

    const { resolveCogSeedApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');
    await expect(resolveCogSeedApiKeyProfile(USER_A)).resolves.toMatchObject({
      profileId: 'anthropic:default',
      provider: 'anthropic',
      protocol: 'anthropic',
      apiKey: 'sk-ant-oat-access-token',
      baseUrl: 'https://api.anthropic.com',
    });
  });

  it('falls back past native-only entries to a later usable entry', async () => {
    // Add the OpenAI-compatible entry first, then the zai one, so the
    // zai entry ends up first in the priority list and must be skipped.
    await activateAndAddApiKey(USER_A, 'openai-compatible', 'sk-openai-fallback-key', 'https://fallback.test/v1');
    await activateAndAddApiKey(USER_A, 'zai', 'zai-key');

    const users = await import('../../../../src/main/features/users');
    users.activateUser(USER_B);
    const { resolveCogSeedApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');

    await expect(resolveCogSeedApiKeyProfile(USER_A)).resolves.toMatchObject({
      apiKey: 'sk-openai-fallback-key',
      baseUrl: 'https://fallback.test/v1',
      model: 'cogseed-test-model',
      protocol: 'openai-completions',
    });
  });

  it('resolves an openai API-key profile to the OpenAI Responses wire protocol', async () => {
    await activateAndAddApiKey(USER_A, 'openai', 'sk-openai-responses-key');

    const users = await import('../../../../src/main/features/users');
    users.activateUser(USER_B);
    const { resolveCogSeedApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');

    await expect(resolveCogSeedApiKeyProfile(USER_A)).resolves.toMatchObject({
      profileId: 'openai:default',
      provider: 'openai',
      protocol: 'openai-responses',
      model: 'cogseed-test-model',
      apiKey: 'sk-openai-responses-key',
      baseUrl: 'https://api.openai.com/v1',
      maxOutputTokens: 8192,
    });
  });

  it('resolves an openai-responses custom provider to the Responses wire protocol', async () => {
    const { providerId } = await activateAndAddCustomProvider(USER_A, {
      name: 'OpenAI Relay',
      protocol: 'openai-responses',
      baseUrl: 'https://openai-relay.example/v1',
      apiKey: 'responses-relay-key',
      model: 'gpt-5.6-sol',
    });

    const users = await import('../../../../src/main/features/users');
    users.activateUser(USER_B);
    const { resolveCogSeedApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');

    await expect(resolveCogSeedApiKeyProfile(USER_A)).resolves.toMatchObject({
      profileId: providerId,
      provider: providerId,
      protocol: 'openai-responses',
      model: 'gpt-5.6-sol',
      apiKey: 'responses-relay-key',
      baseUrl: 'https://openai-relay.example/v1',
      maxOutputTokens: 8192,
    });
  });
});