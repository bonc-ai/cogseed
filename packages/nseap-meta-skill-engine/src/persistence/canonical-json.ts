/**
 * Canonical JSON serialization for stable hashing
 * Ensures deterministic snapshot_hash computation
 */

/**
 * Serialize object to canonical JSON string
 * - Keys sorted alphabetically
 * - No whitespace
 * - Deterministic array ordering
 */
export function canonicalStringify(obj: unknown): string {
  if (obj === null) return 'null';
  if (obj === undefined) return 'undefined';
  if (typeof obj !== 'object') return JSON.stringify(obj);

  if (Array.isArray(obj)) {
    const items = obj.map(canonicalStringify);
    return `[${items.join(',')}]`;
  }

  const keys = Object.keys(obj).sort();
  const pairs = keys.map(key => {
    const value = canonicalStringify((obj as Record<string, unknown>)[key]);
    return `"${key}":${value}`;
  });

  return `{${pairs.join(',')}}`;
}

/**
 * Compute stable hash from canonical JSON
 */
export function stableHash(obj: unknown): string {
  const canonical = canonicalStringify(obj);
  // Simple hash for now (production would use crypto.createHash)
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) {
    const char = canonical.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36).padStart(8, '0');
}
