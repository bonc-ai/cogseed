/**
 * Version comparison for the updates server.
 *
 * MUST stay semantically identical to the client-side comparator in
 * `src/main/util/app-version-compat.ts::compareVersions` (token-based: numeric
 * segments compare numerically, mixed segments fall back to numeric-aware
 * string comparison; missing tokens default to 0). Keeping both sides on the
 * same comparator guarantees the server and the client agree on what "newer"
 * means — e.g. `0.0.6-beta.1` sorts above `0.0.6` here exactly as it does in
 * the client.
 *
 * This file is a standalone copy because `updates-server/` must be deployable
 * without importing the application tree. If the client comparator changes,
 * mirror the change here and extend `test/catalog.test.cjs`.
 */

function versionTokens(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return [];
  return text
    .replace(/^v/i, '')
    .split(/[.+_-]/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
}

/** Returns 1 when a > b, -1 when a < b, 0 when equal. */
function compareVersions(a, b) {
  const aa = versionTokens(a);
  const bb = versionTokens(b);
  if (!aa.length || !bb.length) return 0;
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
  }
  return 0;
}

module.exports = { compareVersions, versionTokens };
