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

describe('Mate Agent provider profiles', () => {
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
});
