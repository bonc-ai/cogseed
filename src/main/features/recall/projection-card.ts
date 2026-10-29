import { listAbilityAssets } from './asset-service';
import { readContextProjection, type ContextProjectionRecord, type OmittedAssetRef, type RecallAssetMatchMethod } from './context-projection';
import type { RecallAbilityAssetRecord } from './candidate-service';
import type { CognitionSourceRef } from './source-service';

export interface ProjectionCardAssetSummary {
  assetId: string;
  title: string;
  type: RecallAbilityAssetRecord['type'];
  status: RecallAbilityAssetRecord['status'];
  maturity: RecallAbilityAssetRecord['maturity'];
  scope: string;
  /** 资产当前的版本（live）。 */
  version: string;
  /** 用户确认这条投影时钉住的版本。注入用的是它，不是 `version`。 */
  confirmedVersion?: string;
  /** 已确认投影钉住的版本 ≠ 资产当前版本：修订过但还没进这次注入。 */
  stale?: boolean;
  sourceRefCount: number;
  /** Deterministic route provenance: semantic, ontology, or both. Legacy
   * projections may still expose recency_fallback/manual values. */
  matchScore?: number;
  matchMethod?: RecallAssetMatchMethod;
}

export interface RecallProjectionCard {
  kind: 'recall_projection_card';
  projectionId: string;
  taskRunId: string;
  workspaceId?: string;
  purpose: string;
  status: ContextProjectionRecord['status'];
  authorization: ContextProjectionRecord['authorization'];
  assetSummaries: ProjectionCardAssetSummary[];
  modelSelectedAssetIds?: string[];
  modelSelectedCount?: number;
  totalAssetCount: number;
  includedAssetIds: string[];
  sourceRefs: CognitionSourceRef[];
  createdAt: string;
  expiresAt?: string;
  confirmedAt?: string;
  decidedAt?: string;
  decisionNote?: string;
  draftState: 'preview' | 'deferred' | 'terminal';
}

function draftStateFor(status: ContextProjectionRecord['status']): RecallProjectionCard['draftState'] {
  if (status === 'preview') return 'preview';
  if (status === 'deferred') return 'deferred';
  return 'terminal';
}

function toSummary(
  asset: RecallAbilityAssetRecord,
  match?: { matchScore: number; matchMethod: RecallAssetMatchMethod },
  confirmedVersion?: string,
): ProjectionCardAssetSummary {
  return {
    assetId: asset.id,
    title: asset.title,
    type: asset.type,
    status: asset.status,
    maturity: asset.maturity,
    scope: asset.scope,
    version: asset.version,
    ...(confirmedVersion ? { confirmedVersion } : {}),
    ...(confirmedVersion && confirmedVersion !== asset.version ? { stale: true } : {}),
    sourceRefCount: asset.evidenceRefs.length,
    ...(match ? { matchScore: match.matchScore, matchMethod: match.matchMethod } : {}),
  };
}

export async function buildProjectionCard(userId: string, projectionId: string): Promise<RecallProjectionCard> {
  const projection = await readContextProjection(userId, projectionId);
  const assets = await listAbilityAssets(userId);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const matchesByAsset = new Map((projection.assetMatches || []).map((match) => [match.assetId, match]));
  // 版本漂移只对**已确认**投影有意义：preview 在确认那一刻才钉版本，
  // 此前显示 live 版本就是对的。
  const confirmedVersions = projection.status === 'confirmed' ? projection.assetVersions : undefined;
  const assetSummaries = projection.assetIds
    .map((assetId) => assetById.get(assetId))
    .filter((asset): asset is RecallAbilityAssetRecord => Boolean(asset))
    .map((asset) => toSummary(asset, matchesByAsset.get(asset.id), confirmedVersions?.[asset.id]));

  return {
    kind: 'recall_projection_card',
    projectionId: projection.id,
    taskRunId: projection.taskRunId,
    ...(projection.workspaceId ? { workspaceId: projection.workspaceId } : {}),
    purpose: projection.purpose,
    status: projection.status,
    authorization: projection.authorization,
    assetSummaries,
    ...(Array.isArray(projection.modelSelectedAssetIds)
      ? {
          modelSelectedAssetIds: [...projection.modelSelectedAssetIds],
          modelSelectedCount: projection.modelSelectedAssetIds.length,
        }
      : {}),
    totalAssetCount: projection.assetIds.length,
    includedAssetIds: [...projection.assetIds],
    sourceRefs: projection.sourceRefs,
    createdAt: projection.createdAt,
    ...(projection.expiresAt ? { expiresAt: projection.expiresAt } : {}),
    ...(projection.confirmedAt ? { confirmedAt: projection.confirmedAt } : {}),
    ...(projection.decidedAt ? { decidedAt: projection.decidedAt } : {}),
    ...(projection.decisionNote ? { decisionNote: projection.decisionNote } : {}),
    draftState: draftStateFor(projection.status),
  };
}
