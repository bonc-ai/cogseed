import { listAbilityAssets } from './asset-service';
import { readContextProjection, type ContextProjectionRecord, type OmittedAssetRef, type RecallAssetMatchMethod } from './context-projection';
import type { RecallAbilityAssetRecord } from './candidate-service';
import type { CognitionSourceRef } from './source-service';

export type ProjectionCardAction = 'confirm' | 'add_asset' | 'modify_scope' | 'defer' | 'reject';

export interface ProjectionCardAssetSummary {
  assetId: string;
  title: string;
  type: RecallAbilityAssetRecord['type'];
  status: RecallAbilityAssetRecord['status'];
  maturity: RecallAbilityAssetRecord['maturity'];
  scope: string;
  version: string;
  sourceRefCount: number;
  matchScore?: number;
  matchMethod?: RecallAssetMatchMethod;
}

export interface ProjectionCardSummary {
  includedCount: number;
  omittedCount: number;
  sourceRefCount: number;
  text: string;
}

export interface ProjectionCardPreview {
  sourceRefs: CognitionSourceRef[];
  omittedAssetRefs: OmittedAssetRef[];
}

export interface RecallProjectionCard {
  kind: 'recall_projection_card';
  projectionId: string;
  taskRunId: string;
  workspaceId?: string;
  purpose: string;
  status: ContextProjectionRecord['status'];
  authorization: ContextProjectionRecord['authorization'];
  summary: ProjectionCardSummary;
  assetSummaries: ProjectionCardAssetSummary[];
  projectionPreview: ProjectionCardPreview;
  includedAssetIds: string[];
  omittedAssetRefs: OmittedAssetRef[];
  sourceRefs: CognitionSourceRef[];
  availableActions: ProjectionCardAction[];
  createdAt: string;
  expiresAt?: string;
  confirmedAt?: string;
  decidedAt?: string;
  decisionNote?: string;
  draftState: 'preview' | 'deferred' | 'terminal';
}

function actionsFor(status: ContextProjectionRecord['status']): ProjectionCardAction[] {
  if (status === 'preview') return ['confirm', 'add_asset', 'modify_scope', 'defer', 'reject'];
  if (status === 'deferred') return ['modify_scope', 'reject'];
  return [];
}

function draftStateFor(status: ContextProjectionRecord['status']): RecallProjectionCard['draftState'] {
  if (status === 'preview') return 'preview';
  if (status === 'deferred') return 'deferred';
  return 'terminal';
}

function summarize(projection: ContextProjectionRecord): ProjectionCardSummary {
  const includedCount = projection.assetIds.length;
  const omittedCount = projection.omittedRefs.length;
  const sourceRefCount = projection.sourceRefs.length;
  return {
    includedCount,
    omittedCount,
    sourceRefCount,
    text: `Preload candidates: ${includedCount}; add or remove as needed.`,
  };
}

function toSummary(asset: RecallAbilityAssetRecord, match?: { matchScore: number; matchMethod: RecallAssetMatchMethod }): ProjectionCardAssetSummary {
  return {
    assetId: asset.id,
    title: asset.title,
    type: asset.type,
    status: asset.status,
    maturity: asset.maturity,
    scope: asset.scope,
    version: asset.version,
    sourceRefCount: asset.evidenceRefs.length,
    ...(match ? { matchScore: match.matchScore, matchMethod: match.matchMethod } : {}),
  };
}

export async function buildProjectionCard(userId: string, projectionId: string): Promise<RecallProjectionCard> {
  const projection = await readContextProjection(userId, projectionId);
  const assets = await listAbilityAssets(userId);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const matchesByAsset = new Map((projection.assetMatches || []).map((match) => [match.assetId, match]));
  const assetSummaries = projection.assetIds
    .map((assetId) => assetById.get(assetId))
    .filter((asset): asset is RecallAbilityAssetRecord => Boolean(asset))
    .map((asset) => toSummary(asset, matchesByAsset.get(asset.id)));

  return {
    kind: 'recall_projection_card',
    projectionId: projection.id,
    taskRunId: projection.taskRunId,
    ...(projection.workspaceId ? { workspaceId: projection.workspaceId } : {}),
    purpose: projection.purpose,
    status: projection.status,
    authorization: projection.authorization,
    summary: summarize(projection),
    assetSummaries,
    projectionPreview: {
      sourceRefs: projection.sourceRefs,
      omittedAssetRefs: projection.omittedRefs,
    },
    includedAssetIds: [...projection.assetIds],
    omittedAssetRefs: projection.omittedRefs,
    sourceRefs: projection.sourceRefs,
    availableActions: actionsFor(projection.status),
    createdAt: projection.createdAt,
    ...(projection.expiresAt ? { expiresAt: projection.expiresAt } : {}),
    ...(projection.confirmedAt ? { confirmedAt: projection.confirmedAt } : {}),
    ...(projection.decidedAt ? { decidedAt: projection.decidedAt } : {}),
    ...(projection.decisionNote ? { decisionNote: projection.decisionNote } : {}),
    draftState: draftStateFor(projection.status),
  };
}
