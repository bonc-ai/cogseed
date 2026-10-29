/** Test-only pre-existing records. This deliberately seeds historical data;
 * it is never an alternative production creation or confirmation path. */
import type { RecallAbilityAssetRecord } from '../../src/main/features/recall/candidate-service';
import type { AbilityAssetActor } from '../../src/main/features/recall/asset-service';

export async function seedStoredAbilityAsset(
  userId: string,
  input: RecallAbilityAssetRecord,
  metadata: { reason?: string; actor?: AbilityAssetActor } | string = {},
): Promise<RecallAbilityAssetRecord> {
  const [{ writeRecallJsonRecord }, assets] = await Promise.all([
    import('../../src/main/features/recall/store'),
    import('../../src/main/features/recall/asset-service'),
  ]);
  const { resolveExecutionEvidenceRefs } = await import('../../src/main/features/recall/evidence-resolution');
  const normalized = { ...input, evidenceRefs: await resolveExecutionEvidenceRefs(userId, input.evidenceRefs) || [] };
  await writeRecallJsonRecord(userId, 'ability-assets', input.id, normalized);
  const stored = await assets.readAbilityAsset(userId, input.id);
  await assets.initializeAbilityAsset(userId, stored, typeof metadata === 'string'
    ? { actor: 'system', reason: metadata } : metadata);
  return stored;
}
