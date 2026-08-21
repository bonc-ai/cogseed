/**
 * CogSeed business API base resolution (marketplace / updates / server-bridge).
 *
 * Precedence — same pattern as `features/hub_account/client.ts`:
 *   1. explicit `COGSEED_API_BASE_URL` env override (must be a clean HTTPS
 *      origin/path; used for local integration and deployment overrides),
 *   2. build-channel default: release and packaged-dev builds default to the
 *      production origin `https://cogseed-open.bonc.com.cn` (env keeps working
 *      for deployment overrides), dev/unknown default to the local backend
 *      `http://localhost:3000`.
 *
 * Without this, packaged builds had no API base at all: the update checker
 * (features/updater) and marketplace silently failed with "COGSEED_API_BASE_URL
 * is required" because packaged apps do not run run.sh and never inherit its
 * environment.
 */

import { resolveBuildIdentity } from '../util/build-identity';

/** Local backend for dev runs (`npm start` / run.sh sets channel=dev). */
export const DEFAULT_API_BASE = 'http://localhost:3000';
/** Packaged builds (release + packaged-dev) point at the production origin. */
export const PACKAGED_DEV_API_BASE = 'https://cogseed-open.bonc.com.cn';
export const RELEASE_API_BASE = 'https://cogseed-open.bonc.com.cn';

function _validate(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('COGSEED_API_BASE_URL must be an HTTPS origin/path without credentials, query, or fragment');
  }
  if (
    url.protocol !== 'https:'
    || !!url.username
    || !!url.password
    || !!url.search
    || !!url.hash
  ) {
    throw new Error('COGSEED_API_BASE_URL must be an HTTPS origin/path without credentials, query, or fragment');
  }
  return url.toString().replace(/\/$/, '');
}

/** Pure resolution — injectable env override + channel for tests. */
export function resolveCogSeedApiBase(envOverride: string | undefined, channel: string): string {
  const raw = String(envOverride || '').trim();
  if (raw) return _validate(raw);
  if (channel === 'release') return RELEASE_API_BASE;
  if (channel === 'packaged-dev') return PACKAGED_DEV_API_BASE;
  return DEFAULT_API_BASE;
}

export function requireCogSeedApiBase(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const { channel } = resolveBuildIdentity({ env });
  return resolveCogSeedApiBase(env.COGSEED_API_BASE_URL, channel);
}
