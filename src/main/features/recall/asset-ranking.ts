/**
 * 资产目录推荐排序的**唯一处**（specs/012 US-202，data-model §5；反漂移 II2）。
 *
 * catalog-engine 对提示词与工具目录只排序一次，按 turnId 留同一份快照。
 * 显式 query 检索只看本次查询的匹配分，使用 catalog-relevance 的同一召回通道。
 *
 * 硬口径（specs/012 统筹台已钉死，不重议）：
 * - 因子闭集 `relevance|adoption|scene|maturity`——**没有 `tags`**。标签只
 *   影响筛选不影响排序（I2：仅改 tags → 排序逐位相同；输入类型故意不含
 *   tags 字段，编译期就进不了因子计算）。
 * - **因子缺席 = 不进分子也不进分母（≠ 0 分）**：score 是「在场因子的加权
 *   平均」Σ(w·f)/Σw。无项目归属 → scene 整体缺席，分数不会被压低，行为
 *   接近现状（spec US-202 AC3）；这与"scene 算 0 分"（进分母稀释其余因子）
 *   是两种结果。数学上"缺席"与"该因子权重为 0"等价（data-model §9.9）。
 * - **只排不裁**（I6）：输入多少条输出多少条，条目集合不变；暂停/过期/无权/
 *   范围不符由消费准入独立判断，不在排序层降权（I7）。
 * - 采用信号只收实际采用与明确 contradicted 回执；目录曝光、搜索结果、
 *   agent_read 和「本轮不用」不折成负采用次数。本模块只吃聚合后的统计。
 * - 确定性兜底序（data-model §5.3）：同分依次比 relevance 原始分 →
 *   appliedCount → 最近采用时间 → updatedAt → id 字典序（绝对兜底，可复现）。
 */
import { CATALOG_FEEDBACK } from './catalog-params';

export const RANKING_FACTORS = ['relevance', 'adoption', 'scene', 'maturity'] as const;

export type RankingFactor = (typeof RANKING_FACTORS)[number];
export type SceneExcludedReason = 'no_scene_context' | 'no_matching_association';

export type RankingWeights = Record<RankingFactor, number>;

/** 排序输入的资产形状：**故意不含 tags**（标签不进推荐分的编译期保证）。 */
export interface RankingAssetInput {
  id: string;
  maturity: 'seed' | 'bud' | 'transfer_validated' | 'effectiveness_validated';
  spaceId?: string;
  scopePolicy?: { projectIds?: string[]; workspaceIds?: string[] };
  updatedAt: string;
}

/** 实际采用与明确否定统计（读时派生自 usage 回执，不落盘）。 */
export interface RankingAdoptionStat {
  appliedCount: number;
  /** 最近一条 applied 回执的时间（平滑近度；可缺省）。 */
  lastAppliedAt?: string;
  /** Only an explicit contradicted usage receipt counts as negative quality evidence. */
  contradictedCount?: number;
  lastContradictedAt?: string;
}

/** 会话场景。两者都缺省 = scene 因子整体缺席（不是 0 分）。 */
export interface RankingSceneContext {
  turnProjectId?: string;
  turnSpaceId?: string;
}

export interface RankingFactorBreakdown {
  name: RankingFactor;
  /** 归一后的因子原始分（0~1）。 */
  raw: number;
  weight: number;
  /** raw × weight（未除分母的原始贡献）。 */
  contribution: number;
}

export interface RankedAsset {
  assetId: string;
  /** 在场因子的加权平均（缺席因子不进分子也不进分母）。 */
  score: number;
  /** 在场因子拆解（缺席的不出现——不是 0）。 */
  factors: RankingFactorBreakdown[];
  /** 本条缺席的因子（如：会话无项目归属 → ['scene']）。 */
  excluded: RankingFactor[];
  sceneExcludedReason?: SceneExcludedReason;
  weightsSource?: 'configured' | 'default' | 'invalid-fallback';
}

export interface RankAssetsInput {
  assets: readonly RankingAssetInput[];
  /** 内容相关度（★ 余弦 0~1）。map 缺席或缺该 id = 因子缺席（embedding 不可用的既有降级口径）。 */
  relevance?: ReadonlyMap<string, number>;
  /** 实际采用与明确否定统计。缺省 = 中性先验，不视为坏资产。 */
  adoptionStats?: ReadonlyMap<string, RankingAdoptionStat>;
  /** 会话场景上下文。缺省 = scene 整体缺席。 */
  scene?: RankingSceneContext;
  weights: RankingWeights;
  weightsSource?: 'configured' | 'default' | 'invalid-fallback';
  /** 近度窗口的基准时间（默认 Date.now()；测试注入固定值保证可复现）。 */
  now?: number;
}

/** 「为什么排前」的解释载荷（随注入回执留痕；只存因子名与数值，不含正文）。 */
export interface RankingExplanation {
  score: number;
  factors: RankingFactorBreakdown[];
  excluded: RankingFactor[];
  sceneExcludedReason?: SceneExcludedReason;
  weightsSource?: 'configured' | 'default' | 'invalid-fallback';
}

/** 成熟度归一（data-model §5.2，对齐 asset-catalog 的两态显示口径）。 */
const MATURITY_RAW: Record<RankingAssetInput['maturity'], number> = {
  transfer_validated: 1.0,
  effectiveness_validated: 1.0,
  bud: 0.5,
  seed: 0.3,
};

/** A small prior keeps untried assets neutral while explicit corrections can demote. */
const ADOPTION_SATURATION = CATALOG_FEEDBACK.appliedCountCap;
const ADOPTION_RECENCY_BONUS = CATALOG_FEEDBACK.recentApplicationBonus;
const ADOPTION_RECENCY_HALF_LIFE_MS = CATALOG_FEEDBACK.halfLifeDays * 86_400_000;

/** 输出精度：分数与贡献截到 1e-6，避免浮点噪音把"同分"拆成假差异。 */
const SCORE_PRECISION = 1_000_000;

function round6(value: number): number {
  return Math.round(value * SCORE_PRECISION) / SCORE_PRECISION;
}

function weightOf(weights: RankingWeights, factor: RankingFactor): number {
  const value = Number(weights?.[factor]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function adoptionRaw(stat: RankingAdoptionStat | undefined, now: number): number {
  const count = Math.min(ADOPTION_SATURATION, Math.max(0, Math.floor(Number(stat?.appliedCount) || 0)));
  const lastAppliedAt = stat?.lastAppliedAt;
  let recency = 0;
  if (lastAppliedAt) {
    const at = Date.parse(lastAppliedAt);
    if (!Number.isNaN(at) && now >= at) recency = ADOPTION_RECENCY_BONUS * 2 ** (-(now - at) / ADOPTION_RECENCY_HALF_LIFE_MS);
  }
  const negativeAt = stat?.lastContradictedAt ? Date.parse(stat.lastContradictedAt) : NaN;
  const negativeCount = Math.max(0, Math.floor(Number(stat?.contradictedCount) || 0));
  const negative = negativeCount && Number.isFinite(negativeAt) && now >= negativeAt
    ? negativeCount * 2 ** (-(now - negativeAt) / ADOPTION_RECENCY_HALF_LIFE_MS)
    : 0;
  const quality = (1 + count) / (2 + count + 2 * negative);
  return Math.min(1, Math.max(0, quality + recency));
}

/** Missing association is no evidence of irrelevance; admission owns scope. */
function sceneRaw(
  asset: RankingAssetInput,
  scene: RankingSceneContext | undefined,
): number | undefined {
  if (!scene || (!scene.turnProjectId && !scene.turnSpaceId)) return undefined;
  if (scene.turnSpaceId && asset.spaceId === scene.turnSpaceId) return 1.0;
  if (scene.turnProjectId && asset.scopePolicy?.projectIds?.includes(scene.turnProjectId)) return 0.8;
  if (scene.turnSpaceId && asset.scopePolicy?.workspaceIds?.includes(scene.turnSpaceId)) return 0.8;
  return undefined;
}

/** relevance 原始分。map 缺该 id 或值非有限数 = 因子缺席（降级口径同现状）。 */
function relevanceRaw(
  assetId: string,
  relevance: ReadonlyMap<string, number> | undefined,
): number | undefined {
  if (!relevance || !relevance.has(assetId)) return undefined;
  const value = Number(relevance.get(assetId));
  if (!Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** 单因子原始分；undefined = 该因子缺席（不进分子也不进分母）。 */
function factorRaw(
  factor: RankingFactor,
  asset: RankingAssetInput,
  input: RankAssetsInput,
  adoption: RankingAdoptionStat | undefined,
  now: number,
): number | undefined {
  switch (factor) {
    case 'relevance':
      return relevanceRaw(asset.id, input.relevance);
    case 'adoption':
      // 无回执采用中性先验，仍是在场因子，不把冷启动当作质量差。
      return adoptionRaw(adoption, now);
    case 'scene':
      return sceneRaw(asset, input.scene);
    case 'maturity':
      return MATURITY_RAW[asset.maturity] ?? 0;
  }
}

/**
 * 排序唯一入口。**只排不裁**：输出条数与集合与输入完全一致，只决定顺序。
 * 同输入两次调用的输出逐位相同（确定性兜底序）。
 */
export function rankAssets(input: RankAssetsInput): RankedAsset[] {
  if (!input || !Array.isArray(input.assets)) throw new Error('invalid ranking input');
  const now = input.now === undefined ? Date.now() : input.now;
  const rows = input.assets.map((asset) => {
    const factors: RankingFactorBreakdown[] = [];
    const excluded: RankingFactor[] = [];
    let sceneExcludedReason: SceneExcludedReason | undefined;
    const adoption = input.adoptionStats?.get(asset.id);
    let relevanceScore = -1;
    for (const factor of RANKING_FACTORS) {
      const raw = factorRaw(factor, asset, input, adoption, now);
      if (raw === undefined) {
        excluded.push(factor);
        if (factor === 'scene') {
          const scene = input.scene;
          sceneExcludedReason = !scene || (!scene.turnProjectId && !scene.turnSpaceId)
            ? 'no_scene_context' : 'no_matching_association';
        }
        continue;
      }
      if (factor === 'relevance') relevanceScore = raw;
      const weight = weightOf(input.weights, factor);
      const normalizedRaw = round6(raw);
      factors.push({ name: factor, raw: normalizedRaw, weight, contribution: round6(normalizedRaw * weight) });
    }
    // score = 在场因子的加权平均：缺席因子不进分子（无贡献）也不进分母
    // （不稀释）。全在场时与朴素加权和单调等价；缺席时 ≠ "把该因子算 0 分"。
    const denominator = factors.reduce((sum, factor) => sum + factor.weight, 0);
    const numerator = factors.reduce((sum, factor) => sum + factor.weight * factor.raw, 0);
    const lastAppliedAt = adoption?.lastAppliedAt || '';
    return {
      assetId: asset.id,
      score: denominator > 0 ? round6(numerator / denominator) : 0,
      factors,
      excluded,
      ...(sceneExcludedReason ? { sceneExcludedReason } : {}),
      ...(input.weightsSource ? { weightsSource: input.weightsSource } : {}),
      // 确定性兜底序的比较键（data-model §5.3，不对外输出）。
      relevanceScore,
      appliedCount: Math.max(0, Math.floor(Number(adoption?.appliedCount) || 0)),
      lastAppliedAt,
      updatedAt: String(asset.updatedAt || ''),
    };
  });
  rows.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.relevanceScore !== right.relevanceScore) return right.relevanceScore - left.relevanceScore;
    if (left.appliedCount !== right.appliedCount) return right.appliedCount - left.appliedCount;
    if (left.lastAppliedAt !== right.lastAppliedAt) return left.lastAppliedAt < right.lastAppliedAt ? 1 : -1;
    if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1;
    return left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0;
  });
  return rows.map(({ assetId, score, factors, excluded, sceneExcludedReason, weightsSource }) => ({
    assetId,
    score,
    factors,
    excluded,
    ...(sceneExcludedReason ? { sceneExcludedReason } : {}),
    ...(weightsSource ? { weightsSource } : {}),
  }));
}

/** 「为什么排前」的唯一解释器（FR-004：注入回执与排序依据展示共用）。
 *  只透传因子名与数值——不含资产正文/任务文本/路径（隐私边界 III1）。 */
export function explainRanking(ranked: RankedAsset): RankingExplanation {
  return {
    score: ranked.score,
    factors: ranked.factors,
    excluded: ranked.excluded,
    ...(ranked.sceneExcludedReason ? { sceneExcludedReason: ranked.sceneExcludedReason } : {}),
    ...(ranked.weightsSource ? { weightsSource: ranked.weightsSource } : {}),
  };
}
