/** Saving a source-backed standing preference authorizes future response
 * guidance within its boundaries; it does not verify effects or grant tools. */
import type { RecallAbilityAssetRecord } from './candidate-service';
import { normalizeAbilityAssetScopePolicy } from './scope-policy';
import { normalizeCognitionSourceRefsForWrite } from './source-service';
const terms = (values?: readonly string[]) => JSON.stringify([...new Set((values || []).map(value => value.trim().replace(/\s+/g, ' ')))].sort());
function permissions(value: RecallAbilityAssetRecord['scopePolicy']): string {
  const normalized = normalizeAbilityAssetScopePolicy(value);
  return JSON.stringify(Object.entries(normalized || {}).sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => [key, [...values].sort()]));
}
function sources(values: unknown[]): string {
  return JSON.stringify(normalizeCognitionSourceRefsForWrite(values).map(ref => [ref.kind, ref.id, ref.taxonomyVersion,
    ref.subtype, ref.scope, ref.sourceVersion]).map(ref => JSON.stringify(ref)).sort());
}
export function standingPreferenceFingerprint(asset: RecallAbilityAssetRecord): string {
  return JSON.stringify([asset.id, asset.ownerId, asset.status, asset.version, asset.activeVersion,
    asset.type, asset.contentCategory, asset.statement, asset.scope, permissions(asset.scopePolicy),
    terms(asset.applicableWhen), terms(asset.forbiddenWhen), sources(asset.evidenceRefs), asset.spaceId,
    asset.sensitivity, asset.crossScopeConfirmedAt, asset.lifecycleStatus, asset.maturity,
    asset.candidateId, asset.sourceCandidateIds, asset.reviewDecisionId, asset.standingPreferenceAuthority]);
}
export function isStandingPreferenceAsset(asset: RecallAbilityAssetRecord): boolean {
  return asset.type === 'cognition' && asset.contentCategory === 'preference';
}
export async function hasUserAuthorizedStandingPreference(userId: string, asset: RecallAbilityAssetRecord): Promise<boolean> {
  if (isStandingPreferenceAsset(asset) && asset.ownerId === userId && asset.status === 'active'
    && String(asset.activeVersion || asset.version) === asset.version) {
    const { hasCommittedStandingPreferenceAuthority } = await import('./standing-preference-authority');
    if (await hasCommittedStandingPreferenceAuthority(userId, asset)) {
      const { isCognitionSourceEnabled } = await import('./source-control');
      for (const ref of asset.evidenceRefs) if (!(await isCognitionSourceEnabled(userId, ref))) return false;
      const { readAbilityAsset } = await import('./asset-service');
      return standingPreferenceFingerprint(await readAbilityAsset(userId, asset.id)) === standingPreferenceFingerprint(asset);
    }
  }
  if (!isStandingPreferenceAsset(asset) || asset.ownerId !== userId || asset.status !== 'active'
    || asset.lifecycleStatus !== 'user_confirmed_unverified' || asset.maturity === 'seed'
    || !asset.candidateId || !asset.reviewDecisionId || String(asset.activeVersion || asset.version) !== asset.version) return false;
  try {
    const { hasOriginalHumanStandingPreferenceAuthority } = await import('./standing-preference-authority');
    if (!await hasOriginalHumanStandingPreferenceAuthority(userId, asset)) return false;
    const { readAbilityAsset } = await import('./asset-service');
    const { isCognitionSourceEnabled } = await import('./source-control');
    for (const ref of asset.evidenceRefs) if (!(await isCognitionSourceEnabled(userId, ref))) return false;
    // Decision and source reads yield; a concurrent pause, version switch or
    // scope change must not authorize the earlier in-memory record.
    return standingPreferenceFingerprint(await readAbilityAsset(userId, asset.id)) === standingPreferenceFingerprint(asset);
  } catch { return false; }
}
