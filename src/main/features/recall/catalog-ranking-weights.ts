/**
 * 目录推荐排序的因子权重（specs/012 US-202 FR-005，data-model §4/§6.3）。
 *
 * 形状先例：capture-settings.ts（固定集合 + 固定 id 的单记录设置）。载体
 * `records/catalog-ranking-weights/weights.json`（经 recallJsonRecordPath）。
 *
 * 硬口径：
 * - 因子名闭集来自 asset-ranking 的 RANKING_FACTORS（唯一处，反漂移 II5）；
 * - 写入校验：未知因子名 / 非有限数 / <0 / >10 / 合并后全零 → **抛错拒绝**，
 *   原值保持（spec Edge Case：不静默回退）；
 * - 读取三态：文件不存在 = `default`（首次未配置，不是"回退"）；盘上非法 =
 *   `invalid-fallback`（**用默认但明确告知"你的配置没生效"**，渲染层必须
 *   可见提示）；合法 = `configured`；
 * - **每次构建读一次**：getRankingWeights 直接读盘，无进程内长缓存——
 *   改配置下一轮目录即生效（SC-004）。
 */

import { RANKING_FACTORS, type RankingFactor, type RankingWeights } from './asset-ranking';
import { readRecallJsonRecord, updateRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';

const WEIGHTS_COLLECTION = 'catalog-ranking-weights';
const WEIGHTS_ID = 'weights';

/** 内置默认权重（data-model §4；数值不做验收，人工走查为准）。 */
export const DEFAULT_RANKING_WEIGHTS: Readonly<RankingWeights> = Object.freeze({
  relevance: 2.0,
  adoption: 0.3,
  scene: 0.5,
  maturity: 0.2,
});

export type RankingWeightsSource = 'configured' | 'default' | 'invalid-fallback';

export interface RankingWeightsSnapshot {
  weights: RankingWeights;
  defaults: RankingWeights;
  source: RankingWeightsSource;
  /** source='invalid-fallback' 时的原因（人话短语；渲染层原样展示"没生效"的依据）。 */
  invalidReason?: string;
}

export interface RankingWeightsRecord extends RecallJsonRecord {
  id: typeof WEIGHTS_ID;
  weights: RankingWeights;
  updatedAt: string;
}

export type RankingWeightsUpdate = Partial<Record<RankingFactor, number>>;

interface WeightsValidation {
  ok: true;
  weights: RankingWeights;
}

interface WeightsRejection {
  ok: false;
  reason: string;
}

function isFiniteNumberInRange(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10;
}

/**
 * 完整权重对象的校验（读盘与写盘合并后共用）：未知因子名拒绝（防拼错导致
 * "改了没用"）；缺省因子按默认补齐（部分配置合法）；全零拒绝（排序会退化成
 * 随机顺序，比报错更难排查）。
 */
function validateWeights(value: unknown): WeightsValidation | WeightsRejection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'weights must be an object' };
  }
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!(RANKING_FACTORS as readonly string[]).includes(key)) {
      return { ok: false, reason: `unknown ranking factor: ${key}` };
    }
  }
  const weights = { ...DEFAULT_RANKING_WEIGHTS } as Record<RankingFactor, number>;
  for (const factor of RANKING_FACTORS) {
    if (source[factor] === undefined) continue;
    if (!isFiniteNumberInRange(source[factor])) {
      return { ok: false, reason: `ranking factor ${factor} must be a finite number within 0..10` };
    }
    weights[factor] = source[factor];
  }
  const sum = RANKING_FACTORS.reduce((total, factor) => total + weights[factor], 0);
  if (sum <= 0) return { ok: false, reason: 'ranking weights must not be all zero' };
  return { ok: true, weights: weights as RankingWeights };
}

/** 部分更新的入参校验：只查给出的因子（未给的保持现值，由调用方合并）。 */
function validatePartialWeights(value: unknown): RankingWeightsUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid catalog ranking weights: expected an object');
  }
  const source = value as Record<string, unknown>;
  const partial: RankingWeightsUpdate = {};
  for (const key of Object.keys(source)) {
    if (!(RANKING_FACTORS as readonly string[]).includes(key)) {
      throw new Error(`invalid catalog ranking weights: unknown ranking factor ${key}`);
    }
    const factor = key as RankingFactor;
    if (!isFiniteNumberInRange(source[key])) {
      throw new Error(`invalid catalog ranking weights: ${factor} must be a finite number within 0..10`);
    }
    partial[factor] = source[key];
  }
  return partial;
}

/**
 * 读当前生效权重（每次直接读盘，不缓存）。三态语义见文件头。
 * **只读、零写入**——盘上非法时也不顺手"修好"它：用户的配置没生效这件事
 * 必须保持可见，静默改盘等于销毁"配置无效"的证据。
 */
export async function getRankingWeights(userId: string): Promise<RankingWeightsSnapshot> {
  const raw = await readRecallJsonRecord(userId, WEIGHTS_COLLECTION, WEIGHTS_ID);
  const defaults: RankingWeights = { ...DEFAULT_RANKING_WEIGHTS };
  if (!raw) return { weights: defaults, defaults, source: 'default' };
  const validated = validateWeights(raw.weights);
  if (validated.ok === false) {
    return { weights: defaults, defaults, source: 'invalid-fallback', invalidReason: validated.reason };
  }
  return { weights: validated.weights, defaults, source: 'configured' };
}

/**
 * 部分更新权重（未给的因子保持现值）。非法 → 抛错拒绝，盘上原值保持。
 * 盘上当前非法时按默认值合并（一次合法写入本身就是修复），但 reasons 交给
 * 调用方如实呈现——不静默。
 */
export async function setRankingWeights(userId: string, update: RankingWeightsUpdate): Promise<RankingWeights> {
  const partial = validatePartialWeights(update);
  const current = await getRankingWeights(userId);
  const merged = validateWeights({ ...current.weights, ...partial });
  if (merged.ok === false) {
    throw new Error(`invalid catalog ranking weights: ${merged.reason}`);
  }
  await updateRecallJsonRecord(userId, WEIGHTS_COLLECTION, WEIGHTS_ID, (existing) => ({
    ...(existing || {}),
    schemaVersion: 1,
    ownerId: userId,
    id: WEIGHTS_ID,
    weights: merged.weights,
    updatedAt: new Date().toISOString(),
  } as RecallJsonRecord));
  return merged.weights;
}
