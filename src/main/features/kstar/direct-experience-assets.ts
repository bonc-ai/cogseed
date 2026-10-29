import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { classifyAbilityAssetWriteFailure } from '../recall/asset-service';
import {
  type KstarAdmissionContext,
  type KstarAdmissionSource,
} from './improvement-admission';
import { recordKstarImprovementOutcome } from './improvement-outcome';
import { readKstarReview } from './review-service';
import type {
  KstarCandidateProposal,
  KstarEpisodeRecord,
} from './types';

/** Historical KSTAR precipitation adapters. Task reviews and outcome records
 * remain available, while these adapters never write Recall candidates,
 * ability assets, or experience entries. */

const log = createLogger('kstar.direct-experience-assets');

export interface PrecipitateDirectExperienceResult {
  createdAssetIds: string[];
  candidateIds: string[];
  /** Historical result shape; new adapters leave every collection empty. */
  experienceIds: string[];
  /** Candidates that were merged into an existing candidate/asset (dedup). */
  mergedIntoIds: string[];
  /** Candidates that became update proposals (quality-fusion, need user). */
  updateCandidateIds: string[];
  /** Persistent failure ids for proposals that could not be written. */
  failureIds: string[];
}

/** 分流的路由上下文（specs/016 D2/T013）：经验条目的 `source` 需要任务口径的
 *  字段（任务目标 → taskType、终态 → taskStatus），它们在两条沉淀线的调用方
 *  手里（直通线 = episode；需求级聚合线 = requirement + 锚 episode），提案
 *  身上没有——由调用线如实提供，不在这里编造。 */
export interface DirectExperienceRouting {
  taskGoal: string;
  taskStatus: string;
}

/** Lightweight source reference for requirement-level precipitation. */
export interface DirectExperienceSource {
  id: string;
  conversationId?: string;
  requirementId?: string;
  workspaceId?: string;
}

/** 沉淀线的准入上下文（两条线共用，只有这一处定义）。 */
export async function kstarPrecipitationAdmission(
  userId: string,
  input: {
    source: KstarAdmissionSource;
    /** 本线覆盖的 episode（需求级 = 该需求全部 episode；直通线 = 该 episode）。 */
    episodes: readonly KstarEpisodeRecord[];
    /** 锚 episode：结论 id 由它派生（`kio-<episodeId>`），也由它回指复盘。 */
    episodeId: string;
    requirementId?: string;
  },
): Promise<KstarAdmissionContext> {
  if (!safeId(userId) || !safeId(input.episodeId)) {
    throw new Error('invalid kstar precipitation admission reference');
  }
  // 「该线相关 taskRunIds」= episode 自身 run id + 权威归属的逐回合 run id
  // （与 `task-closure.ts::receiptRunIds`、`run-evidence.ts` 同口径）。采用回执
  // 可能挂在其中任一 id 上——少取会误把"用过"判成"没有采用证据"。
  const taskRunIds = new Set<string>();
  for (const episode of input.episodes) {
    if (episode.taskRunId && safeId(episode.taskRunId)) taskRunIds.add(episode.taskRunId);
    for (const runId of episode.reuseTurnIds || []) {
      if (safeId(runId)) taskRunIds.add(runId);
    }
  }
  return {
    source: input.source,
    appliedAdoption: { taskRunIds: [...taskRunIds] },
    reviewId: await kstarReviewIdForEpisode(userId, input.episodeId),
    episodeId: input.episodeId,
    ...(input.requirementId ? { requirementId: input.requirementId } : {}),
  };
}

/** 结论回指的复盘 id：读不到（或读失败）时派生 `ksr-<episodeId>` —— 与
 *  `task-level-precipitation.ts::updateExtractionRuns` 的兜底同口径；读取失败不
 *  阻断沉淀（复盘侧的问题由失败面记录，结论只负责回指）。 */
async function kstarReviewIdForEpisode(userId: string, episodeId: string): Promise<string> {
  try {
    const review = await readKstarReview(userId, episodeId);
    if (review?.id && safeId(review.id)) return review.id;
  } catch (error) {
    log.warn('kstar review lookup degraded', {
      userId,
      episodeId,
      error: (error as Error).message,
    });
  }
  return `ksr-${episodeId}`;
}

/** 结论是反馈，不是主链：写不进去也不能让沉淀/收口失败（best-effort），
 *  但必须留日志——否则"结论没出现"会被误读成"分析没跑"。 */
async function recordOutcomeSafely(
  userId: string,
  label: string,
  write: () => Promise<{ id: string }>,
): Promise<string | null> {
  try {
    return (await write()).id;
  } catch (error) {
    log.warn(label, { userId, error: (error as Error).message });
    return null;
  }
}

/**
 * 「无需更新」结论（T012 · quickstart S3.2）：**只**表示"分析过、确实没有达到
 * 沉淀门槛的内容"（闸门判定后无提案）。证据读取失败 / 写失败分别有
 * `analysis_failed` / `submit_failed` —— `no_update` **绝不**由失败退化而来
 * （data-model §2 不变量）。id 由 `kio-<episodeId>` 派生：同一 episode 反复分析
 * 仍只有一条（覆盖同一条，幂等）。
 */
export async function recordKstarNoUpdateOutcome(
  userId: string,
  admission: KstarAdmissionContext,
): Promise<string | null> {
  return recordOutcomeSafely(userId, 'kstar no-update outcome degraded', () => (
    recordKstarImprovementOutcome(userId, {
      episodeId: admission.episodeId,
      reviewId: admission.reviewId,
      conclusion: 'no_update',
      reason: '这次分析没有达到沉淀门槛的内容（度量差未达阈值，也没有高置信度的可复用增量），没有需要更新的内容。',
      evidenceRefs: [{ kind: 'execution', id: admission.episodeId }],
      ...(admission.requirementId ? { requirementId: admission.requirementId } : {}),
    })
  ));
}

/**
 * 「候选提交失败」结论（T013）：写候选/写资产失败时的用户可见反馈。
 * 与失败面（`recordKstarFailure(stage='precipitation')`）**并存、不替代**：
 * 结论给人话 + 归因，失败面给详情（`kstar.failures.list`）。
 * 归因复用资产写路径的分类器（specs/008 T032），认不出的落 `unknown`；
 * 错误消息原文**不进**结论（详情在失败记录里），避免受限正文落到记录。
 */
export async function recordKstarSubmitFailedOutcome(
  userId: string,
  admission: KstarAdmissionContext,
  options: { error: unknown; failureId?: string },
): Promise<string | null> {
  const failureCategory = classifyAbilityAssetWriteFailure(options.error);
  return recordOutcomeSafely(userId, 'kstar submit-failed outcome degraded', () => (
    recordKstarImprovementOutcome(userId, {
      episodeId: admission.episodeId,
      reviewId: admission.reviewId,
      conclusion: 'submit_failed',
      reason: `改进提议提交失败（归因：${failureCategory}），没有生成候选。`
        + (options.failureId ? `详情见失败记录「${options.failureId}」。` : '详情见失败记录。'),
      evidenceRefs: [{ kind: 'execution', id: admission.episodeId }],
      failureCategory,
      ...(admission.requirementId ? { requirementId: admission.requirementId } : {}),
    })
  ));
}

/** Compatibility entry for historical task-closure callers. */
export async function precipitateDirectExperienceAssets(
  userId: string,
  episode: KstarEpisodeRecord,
  _proposals: KstarCandidateProposal[],
): Promise<PrecipitateDirectExperienceResult> {
  if (!safeId(userId) || !safeId(episode.id)) throw new Error('invalid direct experience reference');
  return emptyPrecipitationResult();
}

/** Compatibility entry for requirement-level callers. There is no write path
 * behind a feature switch: task closure receives an explicit empty result. */
export async function precipitateDirectExperienceFromSource(
  userId: string,
  source: DirectExperienceSource,
  _proposals: KstarCandidateProposal[],
  _admission: KstarAdmissionContext,
  _routing: DirectExperienceRouting,
): Promise<PrecipitateDirectExperienceResult> {
  if (!safeId(userId) || !safeId(source.id)) throw new Error('invalid direct experience reference');
  return emptyPrecipitationResult();
}

function emptyPrecipitationResult(): PrecipitateDirectExperienceResult {
  return { createdAssetIds: [], candidateIds: [], experienceIds: [], mergedIntoIds: [], updateCandidateIds: [], failureIds: [] };
}
