import type { AbilityAssetRelationKind } from './asset-relations';
import type { RecallAbilityAssetRecord } from './candidate-service';
import {
  mergeHybridMatches,
  type HybridRouteMatch,
} from './hybrid-retrieval';
import type {
  OntologyAssetQueryDirection,
  OntologyAssetQueryEvidenceEdge,
  OntologyAssetQueryIntent,
  OntologyAssetQueryMatch,
  OntologyAssetQueryResult,
} from './ontology-asset-query';

/** Metadata that is safe to carry across the recall boundary.  The asset
 * statement and evidence source contents deliberately stay out of this
 * phase; content retrieval remains a later governed operation. */
export type GovernedRecallAsset = Pick<
  RecallAbilityAssetRecord,
  'id' | 'title' | 'type' | 'scope' | 'maturity' | 'version' | 'activeVersion'
>;

export interface OntologySemanticRouteMatch extends HybridRouteMatch {
  distance?: number;
  entryAssetId?: string;
  relationKind?: AbilityAssetRelationKind;
  evidencePath?: OntologyAssetQueryEvidenceEdge[];
}

export interface OntologySemanticIntent {
  relationKind?: AbilityAssetRelationKind;
  direction?: OntologyAssetQueryDirection;
  maxHops?: number;
}

export interface OntologySemanticOrchestratorInput<T extends GovernedRecallAsset = GovernedRecallAsset> {
  /** Assets must already be the current turn's directory-v2 admitted set. */
  assets: readonly T[];
  semanticMatches?: readonly HybridRouteMatch[];
  ontologyMatches?: readonly OntologySemanticRouteMatch[];
  /** Convenience input for the governed ontology_query result. */
  ontologyQuery?: OntologyAssetQueryResult;
  ontologyIntent?: OntologySemanticIntent;
  limit?: number;
  semanticDegraded?: boolean;
  ontologyDegraded?: boolean;
}

export interface UnifiedRecallCandidate {
  asset: GovernedRecallAsset;
  assetId: string;
  matchScore: number;
  source: 'ontology' | 'semantic' | 'semantic_ontology';
  semanticScore?: number;
  ontologyScore?: number;
  entryAssetId?: string;
  distance?: number;
  relationKind?: AbilityAssetRelationKind;
  direction?: OntologyAssetQueryDirection;
  maxHops?: number;
  evidencePath?: OntologyAssetQueryEvidenceEdge[];
}

export interface UnifiedRecallResult {
  candidates: UnifiedRecallCandidate[];
  truncated: boolean;
  degraded: {
    semantic: boolean;
    ontology: boolean;
  };
}

function boundedScore(value: unknown): number {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}

function queryIntent(result: OntologyAssetQueryResult | undefined): OntologySemanticIntent | undefined {
  if (!result || result.status !== 'ok') return undefined;
  const intent: OntologyAssetQueryIntent = result.intent;
  return {
    ...(intent.relationKind ? { relationKind: intent.relationKind } : {}),
    direction: intent.direction,
    maxHops: intent.maxHops,
  };
}

function queryMatches(result: OntologyAssetQueryResult | undefined): OntologySemanticRouteMatch[] {
  if (!result || result.status !== 'ok') return [];
  return result.matches.map((match: OntologyAssetQueryMatch) => ({
    assetId: match.asset.id,
    // A direct relation is strongest; bounded multi-hop evidence decays
    // deterministically without pretending that it is semantic relevance.
    matchScore: Number((1 / Math.max(1, match.distance)).toFixed(6)),
    distance: match.distance,
    evidencePath: match.evidencePath,
  }));
}

function mergeOntologyRouteMatches(
  matches: readonly OntologySemanticRouteMatch[],
): OntologySemanticRouteMatch[] {
  const byId = new Map<string, OntologySemanticRouteMatch>();
  for (const match of matches) {
    if (!match || typeof match.assetId !== 'string' || !match.assetId) continue;
    const normalized = {
      assetId: match.assetId,
      matchScore: boundedScore(match.matchScore),
      ...(Number.isFinite(match.distance) ? { distance: Math.max(1, Math.floor(Number(match.distance))) } : {}),
      ...(match.entryAssetId ? { entryAssetId: match.entryAssetId } : {}),
      ...(match.relationKind ? { relationKind: match.relationKind } : {}),
      ...(match.evidencePath?.length ? { evidencePath: match.evidencePath } : {}),
    };
    const existing = byId.get(match.assetId);
    if (!existing || normalized.matchScore > boundedScore(existing.matchScore)) {
      byId.set(match.assetId, normalized);
      continue;
    }
    if (normalized.matchScore === boundedScore(existing.matchScore)
      && normalized.evidencePath?.length
      && !existing.evidencePath?.length) {
      byId.set(match.assetId, { ...existing, ...normalized });
    }
  }
  return [...byId.values()];
}

function metadata(asset: GovernedRecallAsset): GovernedRecallAsset {
  return {
    id: asset.id,
    title: asset.title,
    type: asset.type,
    scope: asset.scope,
    maturity: asset.maturity,
    version: asset.version,
    ...(asset.activeVersion !== undefined ? { activeVersion: asset.activeVersion } : {}),
  };
}

/**
 * Merge ontology and semantic recall inside one already-governed directory.
 * This is deliberately an orchestration boundary, not another asset pool or
 * a replacement for ontology traversal, directory admission, or content read.
 */
export function orchestrateOntologySemanticRecall<T extends GovernedRecallAsset = GovernedRecallAsset>(
  input: OntologySemanticOrchestratorInput<T>,
): UnifiedRecallResult {
  const eligibleById = new Map<string, T>();
  for (const asset of input.assets) {
    if (!asset || typeof asset.id !== 'string' || !asset.id || eligibleById.has(asset.id)) continue;
    eligibleById.set(asset.id, asset);
  }
  const eligibleAssets = [...eligibleById.values()];
  const queryOntologyMatches = queryMatches(input.ontologyQuery);
  const ontologyMatches = mergeOntologyRouteMatches([
    ...(input.ontologyMatches || []),
    ...queryOntologyMatches,
  ]).filter((match) => eligibleById.has(match.assetId));
  const semanticMatches = (input.semanticMatches || [])
    .filter((match) => match && typeof match.assetId === 'string' && eligibleById.has(match.assetId))
    .map((match) => ({ assetId: match.assetId, matchScore: boundedScore(match.matchScore) }));

  const merged = mergeHybridMatches({
    assets: eligibleAssets,
    semanticMatches,
    ontologyMatches,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
  const routeById = new Map(ontologyMatches.map((match) => [match.assetId, match]));
  const intent = input.ontologyIntent || queryIntent(input.ontologyQuery);
  const candidates = merged.assetMatches.map((match): UnifiedRecallCandidate => {
    const route = routeById.get(match.assetId);
    const asset = eligibleById.get(match.assetId)!;
    const source = match.matchMethod === 'semantic_ontology'
      ? 'semantic_ontology' as const
      : match.matchMethod === 'ontology'
        ? 'ontology' as const
        : 'semantic' as const;
    return {
      asset: metadata(asset),
      assetId: match.assetId,
      matchScore: match.matchScore,
      source,
      ...(match.semanticScore !== undefined ? { semanticScore: match.semanticScore } : {}),
      ...(match.ontologyScore !== undefined ? { ontologyScore: match.ontologyScore } : {}),
      ...(route?.distance !== undefined ? { distance: route.distance } : {}),
      ...(route?.entryAssetId ? { entryAssetId: route.entryAssetId } : {}),
      ...(route?.relationKind ? { relationKind: route.relationKind } : {}),
      ...(intent?.relationKind ? { relationKind: intent.relationKind } : {}),
      ...(intent?.direction ? { direction: intent.direction } : {}),
      ...(intent?.maxHops !== undefined ? { maxHops: intent.maxHops } : {}),
      ...(route?.evidencePath?.length ? { evidencePath: route.evidencePath } : {}),
    };
  });

  const allMatchedIds = new Set([...semanticMatches, ...ontologyMatches].map((match) => match.assetId));
  return {
    candidates,
    truncated: candidates.length < allMatchedIds.size,
    degraded: {
      semantic: input.semanticDegraded === true,
      ontology: input.ontologyDegraded === true,
    },
  };
}
