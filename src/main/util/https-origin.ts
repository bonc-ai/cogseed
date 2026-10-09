/**
 * Clean-HTTPS-origin normalization for packaged service bases.
 *
 * Both the business API base (`features/api_base.ts`) and the Hub account base
 * (`features/hub_account/client.ts`) accept a value that either came from an
 * env override or was baked into `.build/build-info.json` at packaging time.
 * They must agree on what counts as acceptable, so the rule lives here once.
 *
 * Accepted: `https:` with no credentials, query, or fragment. A trailing slash
 * is dropped so callers can append paths without producing `//`.
 *
 * Rejected (returns null) rather than thrown: a malformed value injected at
 * build time must degrade to the channel default instead of crashing the app
 * at boot. `scripts/write-build-info.cjs` performs the same check and fails the
 * build, so a bad value can never reach a shipped artifact in the first place.
 */

/** Normalize `raw` to a clean HTTPS origin, or return null when unusable. */
export function normalizeHttpsOrigin(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:'
    || !!url.username
    || !!url.password
    || !!url.search
    || !!url.hash
  ) {
    return null;
  }
  return url.toString().replace(/\/$/, '');
}
