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
  | {
    action: 'preserve_content';
    reason: 'older_version' | 'stale_freshness' | 'unparsable_version' | 'freshness_not_consulted';
  };

/** 内容来源。Hub 官方副本与其余来源在新鲜度这一步上的处置不同。 */
export type MarketplaceContentSource = 'hub' | 'other';

/**
 * 新鲜度分支的**显式决策点**（specs/010 FR-036）。
 *
 * ⚠️ 这里曾是一条隐式落入的路径：`if (localVersion !== serverVersion)` 为假时，
 * **整段 semver 比较被跳过**，直接落到新鲜度比较——而且落入的不只是「字符串完全相同」，
 * **语义等价但拼写不同**（`v1.0.4` 对 `1.0.4`）同样落入（`research.md` V-6）。
 *
 * **Q4 内部默认值 = 「Hub 的 `updated_at` 不会在版本不变时变化」**，因此对 Hub 来源
 * **不咨询新鲜度**：同版本即不替换。这是**实现假设，不是 Hub 的答复**；Q4 收口后
 * 只改本函数的返回值，调用方不动。
 */
export function shouldConsultFreshness(source: MarketplaceContentSource): boolean {
  return source !== 'hub';
}

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
  source: MarketplaceContentSource = 'other',
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
    // fall through to the freshness decision point below.
  }
  // 显式决策点：Hub 来源不咨询新鲜度（Q4 内部默认值）。两种落入方式——
  // 版本字符串完全相同、以及语义等价但拼写不同——在这里汇合，处置一致。
  if (!shouldConsultFreshness(source)) {
    return { action: 'preserve_content', reason: 'freshness_not_consulted' };
  }
  if (freshnessAt(server) > freshnessAt(local)) {
    return { action: 'replace_content', reason: 'newer_freshness' };
  }
  return { action: 'preserve_content', reason: 'stale_freshness' };
}
