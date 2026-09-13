import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';

import { readCreatorFeatureFlags, resolveCreatorFeatureFlags } from '../../../../src/main/features/creator/flags';
import { userPreferencesFile } from '../../../../src/main/paths';
import { writeJson } from '../../../../src/main/storage';

const originalCreatorMode = process.env.COGSEED_CREATOR_MODE;
const originalCreatorPublish = process.env.COGSEED_CREATOR_PUBLISH;
const scopedUserIds = ['creator-flags-a', 'creator-flags-b'];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(async () => {
  delete process.env.COGSEED_CREATOR_MODE;
  delete process.env.COGSEED_CREATOR_PUBLISH;
  await Promise.all(scopedUserIds.map((userId) => fs.rm(userPreferencesFile(userId), { force: true })));
});

afterEach(async () => {
  restoreEnv('COGSEED_CREATOR_MODE', originalCreatorMode);
  restoreEnv('COGSEED_CREATOR_PUBLISH', originalCreatorPublish);
  await Promise.all(scopedUserIds.map((userId) => fs.rm(userPreferencesFile(userId), { force: true })));
});

describe('Creator feature flags', () => {
  it('does not expose preference injection on the user-scoped reader', () => {
    expect(readCreatorFeatureFlags.length).toBe(1);
  });

  it('defaults every new capability to disabled', () => {
    expect(resolveCreatorFeatureFlags({})).toEqual({
      creatorMode: false,
      publish: false,
    });
  });

  it('keeps publish subordinate only to Creator Mode', () => {
    expect(resolveCreatorFeatureFlags({
      creator_mode_enabled: false,
      creator_mode_publish_enabled: true,
    })).toEqual({ creatorMode: false, publish: false });

    expect(resolveCreatorFeatureFlags({
      creator_mode_enabled: true,
      creator_mode_publish_enabled: true,
    })).toEqual({ creatorMode: true, publish: true });
  });

  it('applies environment kill switches with higher priority', () => {
    process.env.COGSEED_CREATOR_MODE = '0';
    process.env.COGSEED_CREATOR_PUBLISH = '0';

    expect(resolveCreatorFeatureFlags({
      creator_mode_enabled: true,
      creator_mode_publish_enabled: true,
    })).toEqual({ creatorMode: false, publish: false });
  });

  it('reads flags from the requested user instead of the mutable active user', async () => {
    await writeJson(userPreferencesFile(scopedUserIds[0]), {
      creator_mode_enabled: true,
      creator_mode_publish_enabled: true,
    });
    await writeJson(userPreferencesFile(scopedUserIds[1]), {
      creator_mode_enabled: false,
      creator_mode_publish_enabled: true,
    });

    expect(readCreatorFeatureFlags(scopedUserIds[0])).toEqual({ creatorMode: true, publish: true });
    expect(readCreatorFeatureFlags(scopedUserIds[1])).toEqual({ creatorMode: false, publish: false });
  });

  it('exports only the Creator modules implemented in this task', async () => {
    const creator = await import('../../../../src/main/features/creator');
    expect(creator).toMatchObject({
      readCreatorFeatureFlags: expect.any(Function),
      validateCreatorPresetManifest: expect.any(Function),
      saveCreatorDraft: expect.any(Function),
    });
  });
});
