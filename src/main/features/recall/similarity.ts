import { createLogger } from '../../logger';
import { embedQuery } from '../kb_embed';

/**
 * similarity.ts — shared semantic-similarity utilities for recall dedup
 * (design: 2026-08-15-kstar-candidate-pool-unification.md §4).
 *
 * Three layers of dedup:
 *   1. exact fingerprint (existing in candidate-service)
 *   2. semantic similarity (embedding cosine, this module)
 *   3. quality-based fusion (assetQualityScore, this module)
 *
 * All thresholds are named constants pending calibration (OQ-2/OQ-10).
 */

const log = createLogger('recall.similarity');

/** Semantic duplicate threshold: ≥ this → same rule, merge/fuse. */
export const SEMANTIC_DUP_THRESHOLD = 0.85;
/** Highly-related threshold: 0.70–0.85 → relatedTo marker / user review. */
export const SEMANTIC_RELATED_THRESHOLD = 0.70;
/** Quality gap required for "incoming is clearly better". */
export const QUALITY_GAP = 0.10;

/** LRU for judgment → embedding, keyed by userId (bounded). */
const EMBED_CACHE_MAX = 500;
const embedCache = new Map<string, { vector: number[]; at: number }>();

function embedCacheKey(userId: string, text: string): string {
  return `${userId}\n${text.slice(0, 2_000)}`;
}

function cacheGet(key: string): number[] | undefined {
  const hit = embedCache.get(key);
  if (!hit) return undefined;
  hit.at = Date.now();
  return hit.vector;
}

function cacheSet(key: string, vector: number[]): void {
  if (embedCache.size >= EMBED_CACHE_MAX) {
    const oldest = [...embedCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) embedCache.delete(oldest[0]);
  }
  embedCache.set(key, { vector, at: Date.now() });
}

/** Cosine similarity between two equal-length vectors (unit-safe). */
export function cosineScore(left: number[], right: number[]): number {
  let dot = 0; let leftMag = 0; let rightMag = 0;
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const a = Number(left[i]) || 0;
    const b = Number(right[i]) || 0;
    dot += a * b;
    leftMag += a * a;
    rightMag += b * b;
  }
  if (leftMag === 0 || rightMag === 0) return 0;
  return dot / (Math.sqrt(leftMag) * Math.sqrt(rightMag));
}

/** Embed a judgment text with LRU cache. Returns null on embed failure. */
export async function embedForDedup(userId: string, text: string): Promise<number[] | null> {
  const key = embedCacheKey(userId, text);
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const vector = await embedQuery(text.slice(0, 2_000));
    cacheSet(key, vector);
    return vector;
  } catch (error) {
    log.warn('recall dedup embed degraded', { error: (error as Error).message });
    return null;
  }
}

/** Clear the LRU (mainly for tests / app shutdown). */
export function clearEmbedCacheForTest(): void {
  embedCache.clear();
}

/** Test-only: inject a vector for a judgment text. */
export function _injectEmbeddingForTest(userId: string, text: string, vector: number[]): void {
  cacheSet(embedCacheKey(userId, text), vector);
}

/** Payloads comparable for semantic dedup. */
export interface SemanticDedupCandidate {
  /** Candidate judgment or asset statement. */
  text: string;
  id: string;
  /** 'candidate' | 'asset' — determines merge target semantics. */
  kind: 'candidate' | 'asset';
  /** Evidence strength (evidenceRefs length) for quality scoring. */
  evidenceCount: number;
  /** Source-kind coverage (五类来源) for quality scoring. */
  sourceKinds: Set<string>;
  /** Update recency in ms (now - updatedAt) for quality scoring. */
  ageMs: number;
  /** Maturity for assets; candidates treated as seed(1). */
  maturity?: string;
  /** Risk for candidates; assets treated as low(1.0). */
  risk?: string;
  /** Content structure bonus: has 何时适用/例外/步骤 markers. */
  structureBonus?: boolean;
}

/** 质量评分（设计 §4.9，权重未校准——命名常量便于统一调参）。 */
export const QUALITY_WEIGHTS = Object.freeze({
  maturity: 0.30,
  completeness: 0.25,
  evidence: 0.25,
  recency: 0.10,
  risk: 0.10,
} as const);

const MATURITY_SCORE: Record<string, number> = {
  seed: 1, bud: 2, transfer_validated: 3, effectiveness_validated: 4, stable: 5,
};
const RISK_SCORE: Record<string, number> = { low: 1.0, medium: 0.6, high: 0 };

/** 五维质量评分，输出 0..1。 */
export function assetQualityScore(input: SemanticDedupCandidate): number {
  const maturity = MATURITY_SCORE[String(input.maturity || 'seed')] ?? 1;
  const text = String(input.text || '').replace(/\s+/g, ' ').trim();
  const completeness = Math.min(1, text.length / 300) + (input.structureBonus ? 0.15 : 0);
  const evidence = Math.min(1, (input.evidenceCount || 0) / 5) * 0.7
    + Math.min(1, (input.sourceKinds?.size || 0) / 5) * 0.3;
  const recency = Math.max(0, 1 - (input.ageMs || 0) / (30 * 24 * 3600 * 1_000));
  const risk = RISK_SCORE[String(input.risk || 'low')] ?? 1;
  const raw = maturity / 5 * QUALITY_WEIGHTS.maturity
    + Math.min(1, completeness) * QUALITY_WEIGHTS.completeness
    + Math.min(1, evidence) * QUALITY_WEIGHTS.evidence
    + recency * QUALITY_WEIGHTS.recency
    + risk * QUALITY_WEIGHTS.risk;
  return Math.max(0, Math.min(1, raw));
}

/** 语义查重：遍历候选池 + 资产库，返回最高相似命中（≥ threshold 才算命中）。 */
export interface SemanticDuplicateMatch {
  kind: 'candidate' | 'asset';
  id: string;
  score: number;
}

export interface FindSemanticDuplicateInput {
  /** The incoming judgment/statement text. */
  text: string;
  /** Candidate pool to compare against (already loaded by caller). */
  candidateTexts: Array<{ id: string; text: string }>;
  /** Asset pool to compare against (already loaded by caller). */
  assetTexts: Array<{ id: string; text: string }>;
  /** Optional ids to exclude (e.g. the candidate itself). */
  excludeIds?: Set<string>;
}

/** 查重结论。`no_match` 与 `degraded` 必须分开：前者是"查过了，没有重复"，
 *  后者是"根本没查成"。把两者都表达成 null，会让 embedding 不可用时静默退回
 *  纯指纹去重——而两条沉淀线的 judgment 文本几乎从不逐字相同，指纹拦不住，
 *  结果就是无声地产出两条讲同一件事的正式资产。 */
export type SemanticDuplicateOutcome =
  | { status: 'match'; match: SemanticDuplicateMatch }
  | { status: 'no_match' }
  | { status: 'degraded'; reason: 'embedding_unavailable' };

export async function findSemanticDuplicate(
  userId: string,
  input: FindSemanticDuplicateInput,
): Promise<SemanticDuplicateOutcome> {
  const query = await embedForDedup(userId, input.text);
  if (!query) return { status: 'degraded', reason: 'embedding_unavailable' };
  let best: SemanticDuplicateMatch | null = null;
  // 逐条比对时如果某条 embed 失败，只是这条比不了，不代表整次查重不可信；
  // 但一条都没比成时，这次查重等于没做。
  let compared = 0;
  let skipped = 0;
  const consider = (kind: SemanticDuplicateMatch['kind'], id: string, vector: number[] | null): void => {
    if (!vector) { skipped += 1; return; }
    compared += 1;
    const score = cosineScore(query, vector);
    if (score >= SEMANTIC_DUP_THRESHOLD && (!best || score > best.score)) {
      best = { kind, id, score };
    }
  };
  for (const c of input.candidateTexts) {
    if (input.excludeIds?.has(c.id)) continue;
    consider('candidate', c.id, await embedForDedup(userId, c.text));
  }
  for (const a of input.assetTexts) {
    if (input.excludeIds?.has(a.id)) continue;
    consider('asset', a.id, await embedForDedup(userId, a.text));
  }
  if (best) return { status: 'match', match: best };
  if (compared === 0 && skipped > 0) return { status: 'degraded', reason: 'embedding_unavailable' };
  return { status: 'no_match' };
}
