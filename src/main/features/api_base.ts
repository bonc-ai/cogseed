/**
 * CogSeed business API base resolution (marketplace / updates / server-bridge).
 *
 * Precedence — same pattern as `features/hub_account/client.ts`:
 *   1. explicit `COGSEED_API_BASE_URL` env override (must be a clean HTTPS
 *      origin/path; used for local integration and deployment overrides),
 *   2. the origin baked into the package at build time (`hubApiBase` in
 *      `.build/build-info.json`, written by `scripts/write-build-info.cjs` from
 *      the release pipeline's repository variable),
 *   3. build-channel default: release/packaged-dev fall back to the open-source
 *      placeholder `https://hub.example.com`, dev/unknown default to the local
 *      backend `http://localhost:3000`.
 *
 * Step 2 is what makes a packaged build usable. Packaged apps do not run
 * `run.sh`, so they inherit no environment: before it existed, release builds
 * resolved to the placeholder origin and account, marketplace, and update
 * checks all failed silently. The source tree cannot carry a real origin
 * (open-source publication removed non-owned domains — see the #5 blocker in
 * `docs/release-scan-remediation-20260923.md`), so the value must arrive at
 * package time.
 */

import { resolveBuildIdentity } from '../util/build-identity';
import { normalizeHttpsOrigin } from '../util/https-origin';

/** Local backend for dev runs (`npm start` / run.sh sets channel=dev). */
export const DEFAULT_API_BASE = 'http://localhost:3000';
/**
 * Open-source placeholder. A real deployment bakes its own origin into the
 * package (step 2 above); these constants are only the last-resort default so
 * the source tree stays free of non-owned domains.
 */
export const PACKAGED_DEV_API_BASE = 'https://hub.example.com';
export const RELEASE_API_BASE = 'https://hub.example.com';

function _validate(raw: string): string {
  const normalized = normalizeHttpsOrigin(raw);
  if (!normalized) {
    throw new Error('COGSEED_API_BASE_URL must be an HTTPS origin/path without credentials, query, or fragment');
  }
  return normalized;
}

/** Pure resolution — injectable env override, channel, and build-time origin. */
export function resolveCogSeedApiBase(
  envOverride: string | undefined,
  channel: string,
  packagedBase = '',
): string {
  const raw = String(envOverride || '').trim();
  if (raw) return _validate(raw);
  if (channel === 'release') return normalizeHttpsOrigin(packagedBase) || RELEASE_API_BASE;
  if (channel === 'packaged-dev') return PACKAGED_DEV_API_BASE;
  return DEFAULT_API_BASE;
}

export function requireCogSeedApiBase(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const { channel, hubApiBase } = resolveBuildIdentity({ env });
  return resolveCogSeedApiBase(env.COGSEED_API_BASE_URL, channel, hubApiBase);
}
