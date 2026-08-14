import { readAbilityAsset } from './asset-service';
import {
  readContextProjection,
  validateCommittedProjectionAssetVersions,
} from './context-projection';
import type {
  WorldModelAbilityAsset,
  WorldModelCausalRuleRef,
} from './world-model-types';

const MAX_ASSETS = 12;
const MAX_STATEMENT = 2_000;
const MAX_EVIDENCE_REFS = 20;

export interface CommittedProjectionKnowledge {
  projectionId: string;
  projectionConfirmedAt: string;
  workspaceId?: string;
  abilityAssetRefs: string[];
  abilityAssets: WorldModelAbilityAsset[];
  assetVersions: Record<string, string>;
  rules: WorldModelCausalRuleRef[];
}

export async function loadCommittedProjectionKnowledge(
  userId: string,
  projectionId: string,
): Promise<CommittedProjectionKnowledge> {
  const projection = await readContextProjection(userId, projectionId);
  const assetVersions = await validateCommittedProjectionAssetVersions(userId, projection);
  const assets = [];
  for (const assetId of projection.assetIds.slice(0, MAX_ASSETS)) {
    const asset = await readAbilityAsset(userId, assetId);
    assets.push(asset);
  }
  const abilityAssets: WorldModelAbilityAsset[] = assets.map((asset) => ({
    id: asset.id,
    version: asset.version,
    title: asset.title,
    type: asset.type,
    statement: asset.statement.slice(0, MAX_STATEMENT),
    scope: asset.scope,
    maturity: asset.maturity,
    ...(asset.learningSignal ? { learningSignal: asset.learningSignal } : {}),
    ...(asset.causalRule ? { causalRule: asset.causalRule } : {}),
    ontologyRefs: (asset.ontologyRefs || []).map((ref) => ({ ...ref })),
    evidenceRefs: asset.evidenceRefs.slice(0, MAX_EVIDENCE_REFS).map((ref) => ({ ...ref })),
  }));
  const rules: WorldModelCausalRuleRef[] = abilityAssets.flatMap((asset) => (
    asset.causalRule
      ? [{
          id: `rule:${asset.id}:${asset.version}`,
          assetId: asset.id,
          assetVersion: asset.version,
          rule: asset.causalRule,
        }]
      : []
  ));
  return {
    projectionId: projection.id,
    projectionConfirmedAt: projection.confirmedAt || projection.decidedAt || projection.createdAt,
    ...(projection.workspaceId ? { workspaceId: projection.workspaceId } : {}),
    abilityAssetRefs: abilityAssets.map((asset) => asset.id),
    abilityAssets,
    assetVersions: Object.fromEntries(abilityAssets.map((asset) => [asset.id, assetVersions[asset.id]])),
    rules,
  };
}
