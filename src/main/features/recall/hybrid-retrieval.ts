import type { RecallAbilityAssetRecord } from './candidate-service';
import type { RecallTaskContract } from './task-contract';

export type HybridMatchMethod = 'semantic' | 'ontology' | 'semantic_ontology' | 'recency_fallback' | 'manual';

export interface HybridRouteMatch {
  assetId: string;
  matchScore: number;
}

export interface HybridAssetMatch {
  assetId: string;
  matchScore: number;
  matchMethod: HybridMatchMethod;
  /** Per-route scores are kept internally so relevance gates do not mistake
   * a combined dual-route score for the semantic score. */
  semanticScore?: number;
  ontologyScore?: number;
}

export interface HybridSelection<T extends { id: string }> {
  assets: T[];
  /** `matches` is the object-form API used by projection selection. */
  matches: HybridAssetMatch[];
  /** Compatibility spelling for direct consumers. */
  assetMatches: HybridAssetMatch[];
}

const MAX_ASSET_MATCH_SCORE = 1;
const MIN_ASSET_MATCH_SCORE = 0;

function boundedScore(value: unknown): number {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return Math.max(MIN_ASSET_MATCH_SCORE, Math.min(MAX_ASSET_MATCH_SCORE, score));
}

function bestRouteScores(matches: readonly HybridRouteMatch[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const match of matches) {
    if (!match || typeof match.assetId !== 'string' || !match.assetId) continue;
    const score = boundedScore(match.matchScore);
    if (score > (scores.get(match.assetId) || 0)) scores.set(match.assetId, score);
  }
  return scores;
}

/**
 * Return deterministic ontology evidence for formal assets.  An asset only
 * enters this route through its persisted ontologyRefs; a task token by
 * itself never turns an unrelated asset into an ontology candidate.  The
 * eligibility/runtime gates remain in context-projection.ts before this
 * function is called.
 */
export function rankOntologyMatches(
  assets: readonly Pick<RecallAbilityAssetRecord, 'id' | 'ontologyRefs'>[],
  contract: Pick<RecallTaskContract, 'ontologyAnchors'>,
): HybridRouteMatch[] {
  const anchorScores = new Map<string, number>();
  for (const anchor of contract.ontologyAnchors || []) {
    if (!anchor || typeof anchor.groupId !== 'string' || !anchor.groupId) continue;
    const field = typeof anchor.field === 'string' ? anchor.field : '';
    const key = `${anchor.groupId}\0${field}`;
    const score = boundedScore(anchor.score);
    anchorScores.set(key, Math.max(score, anchorScores.get(key) || 0));
  }

  const matches: HybridRouteMatch[] = [];
  for (const asset of assets) {
    let best = 0;
    for (const ref of asset.ontologyRefs || []) {
      const exact = anchorScores.get(`${ref.groupId}\0${ref.field || ''}`) || 0;
      const group = anchorScores.get(`${ref.groupId}\0`) || 0;
      best = Math.max(best, exact, group);
    }
    // Do not emit a weak ontology-only candidate.  TaskContract already
    // applies the same deterministic anchor threshold used for its public
    // anchor list, but keeping this guard at the route boundary protects
    // callers that construct a contract themselves.
    if (best >= 0.7) matches.push({ assetId: asset.id, matchScore: Number(best.toFixed(6)) });
  }
  return matches;
}

/** Projection-facing spelling retained separately from the lower-level ranker. */
export function matchAssetsByOntology(
  assets: readonly Pick<RecallAbilityAssetRecord, 'id' | 'ontologyRefs'>[],
  contract: Pick<RecallTaskContract, 'ontologyAnchors'>,
): HybridRouteMatch[] {
  return rankOntologyMatches(assets, contract);
}

/**
 * Merge route evidence into one auditable match per asset.  Dual-route
 * matches sort before single-route matches; within a route, the score and
 * original asset order provide stable ordering.  This function intentionally
 * does not inspect lifecycle, scope, workspace, or source availability.
 */
export function mergeHybridMatches<T extends { id: string }>(
  input: {
    assets: readonly T[];
    semanticMatches?: readonly HybridRouteMatch[];
    ontologyMatches?: readonly HybridRouteMatch[];
    limit?: number;
  },
): HybridSelection<T>;
export function mergeHybridMatches<T extends { id: string }>(
  assets: readonly T[],
  semanticMatches?: readonly HybridRouteMatch[],
  ontologyMatches?: readonly HybridRouteMatch[],
): HybridSelection<T>;
export function mergeHybridMatches<T extends { id: string }>(
  inputOrAssets: {
    assets: readonly T[];
    semanticMatches?: readonly HybridRouteMatch[];
    ontologyMatches?: readonly HybridRouteMatch[];
    limit?: number;
  } | readonly T[],
  positionalSemanticMatches: readonly HybridRouteMatch[] = [],
  positionalOntologyMatches: readonly HybridRouteMatch[] = [],
): HybridSelection<T> {
  const input: {
    assets: readonly T[];
    semanticMatches?: readonly HybridRouteMatch[];
    ontologyMatches?: readonly HybridRouteMatch[];
    limit?: number;
  } = Array.isArray(inputOrAssets)
    ? { assets: inputOrAssets, semanticMatches: positionalSemanticMatches, ontologyMatches: positionalOntologyMatches }
    : inputOrAssets as {
      assets: readonly T[];
      semanticMatches?: readonly HybridRouteMatch[];
      ontologyMatches?: readonly HybridRouteMatch[];
      limit?: number;
    };
  const assets = input.assets;
  const semanticMatches = input.semanticMatches || [];
  const ontologyMatches = input.ontologyMatches || [];
  const semantic = bestRouteScores(semanticMatches);
  const ontology = bestRouteScores(ontologyMatches);
  const firstIndex = new Map<string, number>();
  const uniqueAssets: T[] = [];
  assets.forEach((asset, index) => {
    if (firstIndex.has(asset.id)) return;
    firstIndex.set(asset.id, index);
    uniqueAssets.push(asset);
  });

  const selected = uniqueAssets.flatMap((asset) => {
    const semanticScore = semantic.get(asset.id);
    const ontologyScore = ontology.get(asset.id);
    if (semanticScore === undefined && ontologyScore === undefined) return [];
    const dual = semanticScore !== undefined && ontologyScore !== undefined;
    const matchScore = dual
      ? Number((semanticScore! * 0.7 + ontologyScore! * 0.3).toFixed(6))
      : semanticScore ?? ontologyScore!;
    return [{
      asset,
      index: firstIndex.get(asset.id) || 0,
      match: {
        assetId: asset.id,
        matchScore,
        matchMethod: dual ? 'semantic_ontology' as const : semanticScore !== undefined ? 'semantic' as const : 'ontology' as const,
        ...(semanticScore !== undefined ? { semanticScore } : {}),
        ...(ontologyScore !== undefined ? { ontologyScore } : {}),
      },
    }];
  });

  selected.sort((left, right) => {
    const methodRank = (method: HybridMatchMethod): number => method === 'semantic_ontology' ? 0 : method === 'ontology' ? 1 : 2;
    return methodRank(left.match.matchMethod) - methodRank(right.match.matchMethod)
      || right.match.matchScore - left.match.matchScore
      || left.index - right.index;
  });
  const matches = selected.map(({ match }) => match);
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.floor(Number(input.limit))) : undefined;
  let limited = selected;
  if (limit !== undefined && selected.length > limit) {
    const supportsTypeDiversity = selected.some(({ asset }) => typeof (asset as { type?: unknown }).type === 'string');
    if (supportsTypeDiversity) {
      const seenTypes = new Set<string>();
      limited = [];
      for (const item of selected) {
        const type = String((item.asset as { type?: unknown }).type || '');
        if (seenTypes.has(type)) continue;
        seenTypes.add(type);
        limited.push(item);
        if (limited.length >= limit) break;
      }
      if (limited.length < limit) {
        const picked = new Set(limited.map(({ asset }) => asset.id));
        for (const item of selected) {
          if (picked.has(item.asset.id)) continue;
          picked.add(item.asset.id);
          limited.push(item);
          if (limited.length >= limit) break;
        }
      }
    } else {
      limited = selected.slice(0, limit);
    }
  }
  const limitedMatches = limited.map(({ match }) => match);
  return {
    assets: limited.map(({ asset }) => asset),
    matches: limitedMatches,
    assetMatches: limitedMatches,
  };
}

/** Compatibility name for callers that describe the ontology route as a candidate finder. */
export const findOntologyMatches = rankOntologyMatches;
