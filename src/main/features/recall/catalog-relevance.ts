/** Retrieval evidence for the model-facing asset catalog and explicit search. */
import type { RecallAbilityAssetRecord } from './candidate-service';
import { catalogVectors } from './catalog-vector-cache';
import { CATALOG_RETRIEVAL } from './catalog-params';
import { cosineScore } from './similarity';

export type CatalogSearchAsset = Pick<RecallAbilityAssetRecord, 'id' | 'title' | 'statement'>
  & Partial<Pick<RecallAbilityAssetRecord, 'type' | 'applicableWhen' | 'forbiddenWhen'>>;

export interface CatalogMatch {
  score: number;
  lexical: number;
  semantic?: number;
  exact: number;
  /** True when evidence is strong enough to mark the asset as worth opening. */
  strong: boolean;
}

const HAN = /[\p{Script=Han}]+|[a-z0-9_./:-]+/giu;

function bounded(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function tokens(text: string): Set<string> {
  const result = new Set<string>();
  for (const match of text.toLocaleLowerCase().matchAll(HAN)) {
    const word = match[0];
    if (/\p{Script=Han}/u.test(word)) {
      if (word.length >= 2 && word.length <= 12) result.add(word);
      for (let index = 0; index < word.length - 1; index += 1) result.add(word.slice(index, index + 2));
    } else if (word.length > 1) {
      result.add(word);
    }
  }
  return result;
}

/** Tags deliberately stay out of this profile so relabeling cannot change recommendations. */
export function catalogAssetProfile(asset: CatalogSearchAsset): string {
  return [
    asset.title,
    asset.statement.slice(0, 1_000),
    asset.type || '',
    ...(asset.applicableWhen || []).slice(0, 3),
    ...(asset.forbiddenWhen || []).slice(0, 2),
  ].filter(Boolean).join('\n');
}

function exactTerms(query: string): string[] {
  const quoted = [...query.matchAll(/[「“"'`](.{2,48}?)[」”"'`]/gu)].map((match) => match[1]);
  const identifiers = [...query.matchAll(/[A-Za-z_][A-Za-z0-9_./:-]{2,}/g)].map((match) => match[0]);
  const compact = query.trim();
  if (compact.length >= 3 && compact.length <= 20 && !/[，。！？,!?\n]/u.test(compact)) quoted.push(compact);
  return [...new Set([...quoted, ...identifiers].map((value) => value.toLocaleLowerCase()))];
}

function rankChannel(rows: readonly { id: string; value: number }[]): Map<string, number> {
  const ranked = rows.filter((row) => row.value > 0)
    .sort((left, right) => right.value - left.value || left.id.localeCompare(right.id));
  return new Map(ranked.map((row, index) => [row.id, (CATALOG_RETRIEVAL.rrfK + 1) / (CATALOG_RETRIEVAL.rrfK + index + 1)]));
}

/**
 * Find candidates through lexical, exact-name and semantic channels, then fuse
 * their ranks. Channel ranks avoid pretending cosine and lexical coverage share
 * a calibrated 0..1 probability scale. Every input asset remains in the result.
 */
export async function catalogMatches(
  userId: string,
  queryText: string,
  assets: readonly CatalogSearchAsset[],
): Promise<Map<string, CatalogMatch>> {
  const query = queryText.trim().slice(0, 2_000);
  if (!query) return new Map();
  const profiles = assets.map((asset) => ({ id: asset.id, text: catalogAssetProfile(asset) }));
  const profileById = new Map(profiles.map((item) => [item.id, item.text]));
  const queryTokens = tokens(query);
  const assetTokens = new Map(profiles.map((item) => [item.id, tokens(item.text)]));
  const documentFrequency = new Map<string, number>();
  for (const corpus of assetTokens.values()) {
    for (const token of queryTokens) {
      if (corpus.has(token)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }
  const tokenWeight = (token: string): number => Math.log(1 + (assets.length + 1) / ((documentFrequency.get(token) || 0) + 1));
  const queryWeight = [...queryTokens].reduce((sum, token) => sum + tokenWeight(token), 0);
  const names = exactTerms(query);
  const lexical = new Map<string, number>();
  const exact = new Map<string, number>();
  for (const asset of assets) {
    const found = assetTokens.get(asset.id) || new Set<string>();
    const covered = [...queryTokens].reduce((sum, token) => sum + (found.has(token) ? tokenWeight(token) : 0), 0);
    lexical.set(asset.id, queryWeight > 0 ? bounded(covered / queryWeight) : 0);
    const title = asset.title.toLocaleLowerCase();
    const profile = profileById.get(asset.id)?.toLocaleLowerCase() || '';
    exact.set(asset.id, names.length ? bounded(Math.max(...names.map((name) => title.includes(name) ? 1 : profile.includes(name) ? 0.7 : 0))) : 0);
  }

  const semantic = new Map<string, number>();
  try {
    const vectors = await catalogVectors(userId, query, profiles);
    if (vectors.query) {
      for (const asset of assets) {
        const vector = vectors.byId.get(asset.id);
        if (vector) semantic.set(asset.id, bounded(cosineScore(vectors.query, vector)));
      }
    }
  } catch {
    // Search stays usable through its lexical and exact-name channels.
  }

  const lexicalRanks = rankChannel(assets.map((asset) => ({ id: asset.id, value: (lexical.get(asset.id) || 0) >= CATALOG_RETRIEVAL.lexicalRankFloor ? lexical.get(asset.id)! : 0 })));
  const exactRanks = rankChannel(assets.map((asset) => ({ id: asset.id, value: exact.get(asset.id) || 0 })));
  const semanticRanks = rankChannel(assets.map((asset) => ({ id: asset.id, value: (semantic.get(asset.id) || 0) >= CATALOG_RETRIEVAL.semanticRankFloor ? semantic.get(asset.id)! : 0 })));
  const channelCount = Number(lexicalRanks.size > 0) + Number(exactRanks.size > 0) + Number(semanticRanks.size > 0);
  const result = new Map<string, CatalogMatch>();
  for (const asset of assets) {
    const channels = [lexicalRanks.get(asset.id) || 0, exactRanks.get(asset.id) || 0, semanticRanks.get(asset.id) || 0];
    const strongest = Math.max(...channels);
    const consensus = channelCount ? channels.filter((value) => value > 0).length / channelCount : 0;
    const lexicalValue = lexical.get(asset.id) || 0;
    const exactValue = exact.get(asset.id) || 0;
    const semanticValue = semantic.get(asset.id);
    result.set(asset.id, {
      score: bounded(strongest * (0.85 + 0.15 * consensus)),
      lexical: lexicalValue,
      ...(semanticValue === undefined ? {} : { semantic: semanticValue }),
      exact: exactValue,
      strong: exactValue >= CATALOG_RETRIEVAL.strongExactMatch
        || lexicalValue >= CATALOG_RETRIEVAL.strongLexicalCoverage
        || (semanticValue || 0) >= CATALOG_RETRIEVAL.strongSemanticCosine,
    });
  }
  return result;
}
