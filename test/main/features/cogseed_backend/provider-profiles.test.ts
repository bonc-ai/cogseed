import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER_A = 'mate-profile-user-a';
const USER_B = 'mate-profile-user-b';
const USER_C = 'mate-profile-user-c';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-provider-profiles-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function activateAndAddApiKey(userId: string, provider: string, key: string, baseUrl?: string): Promise<void> {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(userId);
  const auth = await import('../../../../src/main/features/auth');
  const { profileId } = await auth.addApiKey(provider, key, undefined, baseUrl ? { baseUrl } : undefined);
  await auth.addEntry({ provider, model: 'mate-test-model', profileId });
}

async function activateAndAddCustomProvider(
  userId: string,
  input: { name: string; protocol: 'openai' | 'anthropic'; baseUrl: string; apiKey: string; model: string },
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
    const { resolveMateApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');

    await expect(resolveMateApiKeyProfile(USER_A)).resolves.toMatchObject({
      profileId: 'openai-compatible:default',
      provider: 'openai-compatible',
      model: expect.any(String),
      apiKey: 'sk-user-a-only-key',
      baseUrl: 'https://provider-a.test/v1',
    });
  });

  it('rejects a missing profile and an OAuth-only/non-OpenAI-compatible profile', async () => {
    const { resolveMateApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');

    await expect(resolveMateApiKeyProfile(USER_A)).rejects.toThrow(/profile/i);

    await activateAndAddApiKey(USER_C, 'anthropic', 'sk-anthropic-only-key');
    await expect(resolveMateApiKeyProfile(USER_C)).rejects.toThrow(/openai-compatible/i);
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
    const { resolveMateApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');

    await expect(resolveMateApiKeyProfile(USER_A)).resolves.toMatchObject({
      profileId: providerId,
      provider: 'openai-compatible',
      model: 'relay-model-1',
      apiKey: 'cp-secret-key',
      baseUrl: 'https://relay.example/v1',
    });
  });

  it('skips non-OpenAI custom providers and rejects with an OpenAI-compatible error', async () => {
    await activateAndAddCustomProvider(USER_A, {
      name: 'Claude Relay',
      protocol: 'anthropic',
      baseUrl: 'https://anthropic-relay.example',
      apiKey: 'anthropic-relay-key',
      model: 'claude-relay-1',
    });

    const users = await import('../../../../src/main/features/users');
    users.activateUser(USER_B);
    const { resolveMateApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');

    await expect(resolveMateApiKeyProfile(USER_A)).rejects.toThrow(/openai-compatible/i);
  });

  it('skips OAuth-backed entries, which expose no OpenAI-compatible endpoint to reuse', async () => {
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
          access: 'access-token',
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

    const { resolveMateApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');
    await expect(resolveMateApiKeyProfile(USER_A)).rejects.toThrow(/profile/i);
  });

  it('falls back past non-OpenAI-compatible entries to a later usable API-key entry', async () => {
    // Add the OpenAI-compatible entry first, then the anthropic one, so the
    // anthropic entry ends up first in the priority list and must be skipped.
    await activateAndAddApiKey(USER_A, 'openai-compatible', 'sk-openai-fallback-key', 'https://fallback.test/v1');
    await activateAndAddApiKey(USER_A, 'anthropic', 'sk-anthropic-only-key');

    const users = await import('../../../../src/main/features/users');
    users.activateUser(USER_B);
    const { resolveMateApiKeyProfile } = await import('../../../../src/main/features/cogseed_backend/provider-profiles');

    await expect(resolveMateApiKeyProfile(USER_A)).resolves.toMatchObject({
      apiKey: 'sk-openai-fallback-key',
      baseUrl: 'https://fallback.test/v1',
      model: 'mate-test-model',
    });
  });
});
