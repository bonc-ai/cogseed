/** Strict SemVer core comparison for Hub contribution version preflight. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

interface ParsedVersion { core: [number, number, number]; pre: string[] | null }

export function parseSemVer(value: unknown): ParsedVersion | null {
  if (typeof value !== 'string') return null;
  const match = SEMVER.exec(value);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : null };
}

function compareIdentifier(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareSemVer(left: string, right: string): number | null {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < length; i += 1) {
    if (a.pre[i] == null) return -1;
    if (b.pre[i] == null) return 1;
    const compared = compareIdentifier(a.pre[i], b.pre[i]);
    if (compared) return compared;
  }
  return 0;
}

export function isHigherSemVer(candidate: string, current: string): boolean {
  const compared = compareSemVer(candidate, current);
  return compared != null && compared > 0;
}
