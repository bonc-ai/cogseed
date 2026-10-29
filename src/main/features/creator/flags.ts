import type { UserPreferences } from '../config';
import { readPreferencesForUser } from '../config';
import type { CreatorFeatureFlags } from './types';

function preferenceEnabled(value: unknown): boolean {
  return value === true;
}

function envEnabled(name: string): boolean {
  return process.env[name] !== '0';
}

/** Pure flag resolution used by tests and by the runtime reader. */
export function resolveCreatorFeatureFlags(preferences: Partial<UserPreferences>): CreatorFeatureFlags {
  const creatorMode = preferenceEnabled(preferences.creator_mode_enabled)
    && envEnabled('COGSEED_CREATOR_MODE');
  const publish = creatorMode
    && preferenceEnabled(preferences.creator_mode_publish_enabled)
    && envEnabled('COGSEED_CREATOR_PUBLISH');

  return { creatorMode, publish };
}

export function readCreatorFeatureFlags(userId: string): CreatorFeatureFlags {
  return resolveCreatorFeatureFlags(readPreferencesForUser(userId));
}
