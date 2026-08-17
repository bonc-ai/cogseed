import { safeId } from '../../storage';

export interface ParsedAbilityAssetReference {
  assetId: string;
  version?: string;
  reason?: string;
}

/**
 * Parse the asset references persisted in ContextReuseReceipt.
 *
 * Supported forms:
 *   aa-id
 *   asset:aa-id
 *   asset:aa-id@v2
 *   asset:aa-id@v2:omission_reason
 */
export function parseAbilityAssetReference(value: unknown): ParsedAbilityAssetReference | null {
  if (typeof value !== 'string') return null;
  const ref = value.trim();
  if (!ref) return null;
  if (safeId(ref)) return { assetId: ref };

  const match = /^asset:([A-Za-z0-9_-]+)(?:@v([^:]+))?(?::(.+))?$/.exec(ref);
  if (!match || !safeId(match[1])) return null;
  const version = match[2]?.trim();
  const reason = match[3]?.trim();
  if (match[2] !== undefined && !version) return null;
  return {
    assetId: match[1],
    ...(version ? { version } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function abilityAssetReferenceMatches(
  reference: unknown,
  expected: { assetId: string; version?: string },
): boolean {
  const parsed = parseAbilityAssetReference(reference);
  if (!parsed || parsed.assetId !== expected.assetId) return false;
  return !parsed.version || !expected.version || parsed.version === expected.version;
}

export function abilityAssetReferencesCover(
  references: readonly string[],
  assets: readonly { assetId: string; version?: string }[],
): boolean {
  return assets.length > 0 && assets.every((asset) => (
    references.some((reference) => abilityAssetReferenceMatches(reference, asset))
  ));
}
