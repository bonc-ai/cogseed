/**
 * marketplace-update-policy.ts — monotonic content update policy for
 * Marketplace Agent and Skill installs.
 *
 * Content (bundles/agent.json/SKILL.md) is replaced only when the server is
 * strictly newer by semantic version, or equal in version with a newer
 * freshness timestamp. A lower server version never overwrites local content
 * version/freshness; unparsable unequal versions preserve local content with
 * a bounded skip. Non-content metadata may still update independently.
 */

export type MarketplaceContentDecision =
  | { action: 'replace_content'; reason: 'newer_version' | 'newer_freshness' }
  | { action: 'preserve_content'; reason: 'older_version' | 'stale_freshness' | 'unparsable_version' };

export interface MarketplaceVersionedRow {
  version: string;
  published_at: number;
  updated_at?: number;
}

export interface ParsedMarketplaceSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Strict local semver parser (no undeclared dependency). */
export function parseMarketplaceSemver(version: string): ParsedMarketplaceSemver | null {
  const trimmed = version.trim();
  const match = SEMVER.exec(trimmed);
  if (!match) return null;
  const prerelease: Array<number | string> = match[4]
    ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

/** SemVer precedence: numeric core, release > prerelease, numeric identifiers
 *  < non-numeric identifiers, then identifier count. Returns 0 for inputs
 *  that do not both parse; callers treat that as unparsable. */
export function compareMarketplaceSemver(left: string, right: string): number {
  const a = parseMarketplaceSemver(left);
  const b = parseMarketplaceSemver(right);
  if (!a || !b) return 0;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return a.prerelease.length - b.prerelease.length;
}

function freshnessAt(row: MarketplaceVersionedRow): number {
  return typeof row.updated_at === 'number' ? row.updated_at : row.published_at;
}

export function decideMarketplaceContentUpdate(
  local: MarketplaceVersionedRow,
  server: MarketplaceVersionedRow,
): MarketplaceContentDecision {
  const localVersion = local.version.trim();
  const serverVersion = server.version.trim();
  if (localVersion !== serverVersion) {
    const comparison = compareMarketplaceSemver(localVersion, serverVersion);
    if (comparison < 0) return { action: 'replace_content', reason: 'newer_version' };
    if (comparison > 0) return { action: 'preserve_content', reason: 'older_version' };
    if (parseMarketplaceSemver(localVersion) === null || parseMarketplaceSemver(serverVersion) === null) {
      return { action: 'preserve_content', reason: 'unparsable_version' };
    }
    // Equal semver with different spellings (e.g. 'v1.0.4' vs '1.0.4'):
    // fall through to freshness comparison.
  }
  if (freshnessAt(server) > freshnessAt(local)) {
    return { action: 'replace_content', reason: 'newer_freshness' };
  }
  return { action: 'preserve_content', reason: 'stale_freshness' };
}
