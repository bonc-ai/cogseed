import { createLogger } from '../../logger';
import { createHash } from 'node:crypto';
import { embedQuery, embedTexts } from '../kb_embed';

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
/** Tracked per owner so a model/dimension change cannot reuse vectors from the
 * previous embedding space under the unchanged text hash. */
const embedDimensions = new Map<string, number>();

function embedCacheKey(userId: string, text: string, dimensions = embedDimensions.get(userId) || 0): string {
  return `${userId}\n${dimensions}\n${createHash('sha256').update(text).digest('hex')}`;
}

function cacheGet(key: string): number[] | undefined {
  const hit = embedCache.get(key);
  if (!hit) return undefined;
  hit.at = Date.now();
  return hit.vector;
}

function cacheSet(userId: string, text: string, vector: number[]): void {
  if (embedCache.size >= EMBED_CACHE_MAX) {
    const oldest = [...embedCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) embedCache.delete(oldest[0]);
  }
  embedDimensions.set(userId, vector.length);
  embedCache.set(embedCacheKey(userId, text, vector.length), { vector, at: Date.now() });
}

/** Cosine similarity between two equal-length vectors (unit-safe).
 * Different dimensions mean the embeddings cannot be compared at all; a value
 * computed over the shorter prefix would invent similarity between unrelated
 * models, so the result is NaN and callers must treat it as unmeasured. */
export function cosineScore(left: number[], right: number[]): number {
  if (left.length !== right.length) return Number.NaN;
  let dot = 0; let leftMag = 0; let rightMag = 0;
  const len = left.length;
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
    // The installed BGE tokenizer truncates at 512 tokens. Reuse the KB's
    // established 400-character, overlapping chunks instead of sending one
    // silently truncated document. Short texts keep their original embedding.
    // One batched request covers the whole long body, including its last clause.
    let vector: number[];
    if (text.length <= 400) vector = await embedQuery(text);
    else {
      const { chunkPlainText } = await import('../../util/file_to_chunks');
      const chunks = chunkPlainText(text).map(chunk => chunk.content);
      const vectors = await embedTexts(chunks);
      const dimensions = vectors[0]?.length;
      if (!dimensions || vectors.length !== chunks.length || vectors.some(value => value.length !== dimensions
        || value.some(component => !Number.isFinite(component)))) throw new Error('incomplete dedup embedding');
      const combined = new Array<number>(dimensions).fill(0);
      for (const [index, value] of vectors.entries()) {
        const norm = Math.sqrt(value.reduce((sum, component) => sum + component * component, 0));
        if (!norm) throw new Error('empty dedup embedding');
        const weight = chunks[index].length;
        for (let i = 0; i < dimensions; i++) combined[i] += value[i] / norm * weight;
      }
      const norm = Math.sqrt(combined.reduce((sum, component) => sum + component * component, 0));
      if (!norm) throw new Error('empty combined dedup embedding');
      vector = combined.map(component => component / norm);
    }
    cacheSet(userId, text, vector);
    return vector;
  } catch (error) {
    log.warn('recall dedup embed degraded', { error: (error as Error).message });
    return null;
  }
}

/** Clear the LRU (mainly for tests / app shutdown). */
export function clearEmbedCacheForTest(): void {
  embedCache.clear();
  embedDimensions.clear();
}

/** Test-only: inject a vector for a judgment text. */
export function _injectEmbeddingForTest(userId: string, text: string, vector: number[]): void {
  cacheSet(userId, text, vector);
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

/** 质量评分（权重未校准——命名常量便于统一调参）。 */
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
 *  结果就是无声地产出两条讲同一件事的正式资产。
 *  `related`：相关层命中（0.70 ≤ score < 0.85，最佳一条）——不是重复、不
 *  触发合并，供入库金字塔的 L2（质量差分档）与 L3（归族）判定取用。match
 *  时同样可能存在 related（另一条相关但未到重复线的资产）。 */
export type SemanticDuplicateOutcome =
  | { status: 'match'; match: SemanticDuplicateMatch; related?: SemanticDuplicateMatch }
  | { status: 'no_match'; related?: SemanticDuplicateMatch }
  | { status: 'degraded'; reason: 'embedding_unavailable' };

export async function findSemanticDuplicate(
  userId: string,
  input: FindSemanticDuplicateInput,
): Promise<SemanticDuplicateOutcome> {
  const comparableCandidates = input.candidateTexts.filter((item) => !input.excludeIds?.has(item.id));
  const comparableAssets = input.assetTexts.filter((item) => !input.excludeIds?.has(item.id));
  // An empty comparison set is a complete check, not an embedding failure.
  // This also lets a user's first automatically captured asset be promoted
  // when the optional embedding runtime is unavailable.
  if (comparableCandidates.length === 0 && comparableAssets.length === 0) {
    return { status: 'no_match' };
  }
  const query = await embedForDedup(userId, input.text);
  if (!query) return { status: 'degraded', reason: 'embedding_unavailable' };
  let best: SemanticDuplicateMatch | null = null;
  let bestRelated: SemanticDuplicateMatch | null = null;
  // 逐条比对时如果某条 embed 失败，只是这条比不了，不代表整次查重不可信；
  // 但一条都没比成时，这次查重等于没做。
  let compared = 0;
  let skipped = 0;
  const consider = (kind: SemanticDuplicateMatch['kind'], id: string, vector: number[] | null): void => {
    if (!vector) { skipped += 1; return; }
    const score = cosineScore(query, vector);
    // Vectors from another embedding space are unmeasured, not unrelated.
    if (!Number.isFinite(score)) { skipped += 1; return; }
    compared += 1;
    if (score >= SEMANTIC_DUP_THRESHOLD && (!best || score > best.score)) {
      best = { kind, id, score };
    } else if (score >= SEMANTIC_RELATED_THRESHOLD && (!bestRelated || score > bestRelated.score)) {
      bestRelated = { kind, id, score };
    }
  };
  for (const c of comparableCandidates) {
    consider('candidate', c.id, await embedForDedup(userId, c.text));
  }
  for (const a of comparableAssets) {
    consider('asset', a.id, await embedForDedup(userId, a.text));
  }
  if (best) return { status: 'match', match: best, ...(bestRelated ? { related: bestRelated } : {}) };
  if (compared === 0 && skipped > 0) return { status: 'degraded', reason: 'embedding_unavailable' };
  return { status: 'no_match', ...(bestRelated ? { related: bestRelated } : {}) };
}
