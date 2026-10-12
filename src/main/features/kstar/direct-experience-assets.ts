import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { classifyAbilityAssetWriteFailure } from '../recall/asset-service';
import { alignUpdateCandidateType, autoApplyRecallCandidate, saveRecallCandidate } from '../recall/candidate-service';
import { createExperience, type ExperienceRecord } from '../recall/experience-service';
import { normalizeCognitionSourceRefs, type CognitionSourceRef } from '../recall/source-service';
import { recallFieldsForKstarProposal } from './candidate-contract';
import { experienceTypeOf, scopeForTask } from './extraction-service';
import { recordKstarFailure } from './failure-service';
import {
  admitKstarProposals,
  type KstarAdmissionContext,
  type KstarAdmissionSource,
} from './improvement-admission';
import { recordKstarImprovementOutcome } from './improvement-outcome';
import { readKstarReview } from './review-service';
import { userFacingSummary } from './task-level-precipitation';
import type {
  KstarCandidateProposal,
  KstarEpisodeRecord,
  KstarLearningProvenance,
} from './types';

/**
 * direct-experience-assets.ts — KStar experience line (candidate-pool path).
 *
 * Design (2026-08-15-kstar-candidate-pool-unification.md §3.2.1):
 * KStar lessons that passed the closure evidence gate are precipitated into
 * the UNIFIED candidate pool (saveRecallCandidate) instead of directly into
 * ability assets. The unified promotion exit (autoApplyRecallCandidate with
 * semantic dedup + quality fusion)
 * applies semantic dedup + quality fusion, so KStar lessons and the capture
 * line share one dedup domain (no duplicate assets, no content duplication).
 *
 * The candidate record carries learningProvenance (projectionId/forecastId/
 * episodeId/attribution) marking the KStar source. forecastId is omitted only
 * when advisory Forecast generation degraded; the ExtractionRun records that
 * condition explicitly instead of fabricating an id.
 *
 * 采用门（specs/015 T007/T010/T011）：本模块是**两条沉淀线唯一的候选出口**——
 * `saveRecallCandidate` 之前一律先过 `admitKstarProposals`（`improvement-outcome.ts`
 * 之外的唯一准入处）：更新型提案（`update`/`limit_scope`/`pause` 且带 `targetAssetId`）
 * 必须证明「任务里真的用过这一版」（usage 回执 `applied` + `boundary='real'`），
 * **被拦的提案不落候选**。各线只负责提供自己的准入上下文
 * （`kstarPrecipitationAdmission`：哪条线 + 该线相关 run id + 回指复盘/episode）。
 * 结论落点也在这里收口：`no_update`（闸门不达阈）/ `submit_failed`（写失败）
 * 与准入门自己落的 `insufficient_evidence` / `analysis_failed` 互不冒充。
 *
 * 沉淀分流（specs/016 T013 / research D2，2026-09）：create 型提案（解析后无
 * `targetAssetId` 且 action 为 `create`）在准入通过后**改道写经验条目**
 * （`experience-service.createExperience`，独立 `experiences` 集合），不再
 * `saveRecallCandidate`/`autoApplyRecallCandidate`——「这次任务学到的一条知识」
 * 是经验，不该经候选池晋升为资产。mutating（带 target）、`keep_current`/`reject`
 * 与 `preference_scan` 的 personal 候选**原路不动**（Epic 7 主链与「关于我」
 * 资产域不受分流影响）；经验写入失败仍走 `recordKstarFailure(stage:'precipitation')`。
 */

const log = createLogger('kstar.direct-experience-assets');

export interface PrecipitateDirectExperienceResult {
  createdAssetIds: string[];
  candidateIds: string[];
  /** 经验条目（specs/016 T013 分流）：create 线提案改道写入 experiences 集合，
   *  不再进候选池——`candidateIds`/`createdAssetIds` 对 create 线恒为空。 */
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

/** 沉淀分支 → 经验类型轴的输入（specs/016 D3）：`suggestedType` 是候选类型
 *  （rule/skill_method/personal/template…），经验类型是 lesson/workflow/gap。
 *  判定只用提案自带的既有信号，不新增判据：归因为四类 *_gap 之一 → gap
 *  （复盘命名了认知缺口）；skill_method → workflow（已验证工作流程）；
 *  其余（rule 等）→ lesson（判断/教训）。判不出的情形交给
 *  `experienceTypeOf` 兜底 uncategorized，不抛错。 */
function experienceKindFor(proposal: KstarCandidateProposal): 'lesson' | 'workflow' | 'gap' {
  const attribution = proposal.learningProvenance?.attribution;
  if (
    attribution === 'knowledge_gap' || attribution === 'rule_gap'
    || attribution === 'template_gap' || attribution === 'skill_gap'
  ) return 'gap';
  return proposal.suggestedType === 'skill_method' ? 'workflow' : 'lesson';
}

/** 分流判定（specs/016 D2，唯一分叉点，两条沉淀线共用）：
 *  `create`（解析后无 targetAssetId）且非 preference_scan → 写经验条目；
 *  其余（mutating 带 target / keep_current / reject / preference_scan 的
 *  personal 候选）→ 原路走候选池。preference_scan 必须排除——「关于我」
 *  偏好陈述属于资产域（D5 迁移判据的反例），分流误伤它会断掉 personal
 *  资产主链；判据用 `learningSignal.source` 这个既有来源徽章字段。 */
function routesToExperience(
  proposal: KstarCandidateProposal,
  action: ReturnType<typeof recallFieldsForKstarProposal>,
): boolean {
  return action.suggestedAction === 'create'
    && !action.targetAssetId
    && proposal.learningSignal?.source !== 'preference_scan';
}

/** 把一条 create 提案写成经验条目（specs/016 T013 字段映射）。
 *
 *  映射口径（data-model §1）：
 *  - title 走 `userFacingSummary` 既有口径（内容核心本身，无模板前后缀）；
 *  - experienceType 走 `experienceTypeOf(experienceKindFor(proposal))`；
 *  - body = judgment（与候选 value 同款清洗 + 4000 上限）；
 *  - verification 从 review 映射（state/outcome/deltaR/confidence），review
 *    读不到时用提案的 learningSignal 兜底（outcome/deltaR/confidence 本就
 *    来自 review 快照，state 退化为 unknown 如实表达"没读到"）；
 *  - learningProvenance 原样保留；缺失时（存量直通线/聚合线投影缺失）构造
 *    降级版：episodeId 锚到提案自己的溯源 episode（无则锚 episode），其余
 *    字段留空/unclear——空值是"没有回指"的如实表达，不编造投影 id。
 *  - id：`exp-<source.id>-<index>`，与候选 captureKey `kstar-<source.id>-<index>`
 *    同一先例（稳定指纹）——同 episode 同提案重试得到同 id，
 *    `createExperience` 幂等返回既有记录，不产生第二条。
 */
async function writeExperienceForProposal(
  userId: string,
  source: DirectExperienceSource,
  proposal: KstarCandidateProposal,
  index: number,
  admission: KstarAdmissionContext,
  routing: DirectExperienceRouting,
  evidenceRefs: CognitionSourceRef[],
): Promise<ExperienceRecord> {
  const kind = experienceKindFor(proposal);
  const scope = String(proposal.suggestedScope || 'general').slice(0, 500);
  const body = String(proposal.judgment || '').replace(/\s+/g, ' ').trim().slice(0, 4_000);
  // 溯源 episode：优先提案自带的 provenance（聚合线 gap 提案锚自己的 episode），
  // 缺失时锚 admission 的锚 episode（与 `ksr-<episodeId>` 兜底同口径）。
  const episodeId = proposal.learningProvenance?.episodeId || admission.episodeId;
  let verification: ExperienceRecord['verification'];
  try {
    const review = await readKstarReview(userId, episodeId);
    verification = {
      state: review?.reviewState || 'unknown',
      outcome: review?.outcome ?? proposal.learningSignal?.outcome ?? 'unclear',
      deltaR: review?.deltaR ?? proposal.learningSignal?.deltaR ?? 'unknown',
      confidence: review?.confidence ?? proposal.learningSignal?.confidence ?? 0,
    };
  } catch {
    // review 读失败不阻断沉淀（best-effort，与 kstarReviewIdForEpisode 同语义）；
    // 验证状态退化为 learningSignal 快照 + state unknown，不假装读过。
    verification = {
      state: 'unknown',
      outcome: proposal.learningSignal?.outcome ?? 'unclear',
      deltaR: proposal.learningSignal?.deltaR ?? 'unknown',
      confidence: proposal.learningSignal?.confidence ?? 0,
    };
  }
  const learningProvenance: KstarLearningProvenance = proposal.learningProvenance ?? {
    // 降级 provenance：projectionId 空串 = 该提案没有投影回指（存量直通线
    // 从不带 provenance、聚合线在投影缺失时也省略）——asExperience 只硬性
    // 要求 episodeId 与 source 一致，这里不编造不存在的投影/Forecast id。
    projectionId: '',
    episodeId,
    ruleRefs: [],
    attribution: 'unclear',
  };
  return createExperience(userId, {
    id: `exp-${source.id}-${index}`,
    source: {
      episodeId,
      ...(source.requirementId ? { requirementId: source.requirementId } : {}),
      ...(source.conversationId ? { conversationId: source.conversationId } : {}),
      taskGoal: routing.taskGoal,
      taskType: scopeForTask(routing.taskGoal) as ExperienceRecord['source']['taskType'],
      taskStatus: routing.taskStatus,
    },
    experienceType: experienceTypeOf(kind),
    title: userFacingSummary(kind, scope, body),
    body,
    ...(proposal.learningSignal?.expectedResult ? { expected: proposal.learningSignal.expectedResult } : {}),
    ...(proposal.learningSignal?.actualResult ? { actual: proposal.learningSignal.actualResult } : {}),
    ...(proposal.applicableWhen ? { applicableWhen: proposal.applicableWhen } : {}),
    ...(proposal.forbiddenWhen ? { forbiddenWhen: proposal.forbiddenWhen } : {}),
    scope,
    verification,
    evidenceRefs,
    ...(proposal.learningSignal ? { learningSignal: proposal.learningSignal } : {}),
    learningProvenance,
    status: 'active',
    // 空间归属：经验与资产同语义（挂空间会话的沉淀只在该空间可见）。
    ...(source.workspaceId && safeId(source.workspaceId) ? { spaceId: source.workspaceId } : {}),
  });
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

async function proposalToCandidateInput(
  userId: string,
  source: DirectExperienceSource,
  proposal: KstarCandidateProposal,
  index: number,
): Promise<import('../recall/candidate-service').SaveRecallCandidateInput> {
  const evidenceRefs = normalizeCognitionSourceRefs(proposal.sourceRefs);
  const action = recallFieldsForKstarProposal(proposal);
  return {
    judgment: String(proposal.judgment || '').replace(/\s+/g, ' ').trim().slice(0, 4_000),
    // value = judgment：与 recall-bridge（drain 路径）一致——两条沉淀路径
    // 的候选指纹（含 value）相同，saveRecallCandidate 指纹去重让第二次
    // 沉淀返回 existing（不产生 confirmed+superseded 双候选，也不让
    // summary 标题残片进 statement）。promote 时 value!==judgment 检查
    // 保证 statement 纯净。
    value: String(proposal.judgment || '').replace(/\s+/g, ' ').trim().slice(0, 1_000),
    summary: String(proposal.summary || '').replace(/\s+/g, ' ').trim().slice(0, 1_000),
    ...(proposal.uncertainty ? { uncertainty: String(proposal.uncertainty).slice(0, 1_000) } : {}),
    // 更新型提案的类型取自目标资产：类型在抽取阶段是按"缺口类型"推的
    // （gapType 认不出 execution_gap 时会退化成新建线的 skill_method），
    // 与它要改的那条资产无关；不一致会在确认守卫处硬拒绝。
    suggestedType: await alignUpdateCandidateType(userId, {
      suggestedType: proposal.suggestedType,
      suggestedAction: action.suggestedAction,
      ...(action.targetAssetId ? { targetAssetId: action.targetAssetId } : {}),
    }),
    suggestedScope: String(proposal.suggestedScope || 'general').slice(0, 500),
    suggestedAction: action.suggestedAction,
    ...(action.targetAssetId ? { targetAssetId: action.targetAssetId } : {}),
    // 版本组契约（specs/015 T011 ②，与 recall-bridge.ts:41 同口径）：任务当时
    // 用的版本必须一起进候选——缺了它，确认时与"当前在用版"核对无从谈起，
    // 依据链也说不清改的是哪一版。缺省 = 存量 episode 没记版本（老数据分支：
    // 不拦截、不阻断，如实提示无法核对）。
    ...(proposal.targetVersionUsed ? { targetVersionUsed: proposal.targetVersionUsed } : {}),
    sourceRefs: evidenceRefs,
    evidenceRefs,
    ...(proposal.applicableWhen ? { applicableWhen: proposal.applicableWhen } : {}),
    ...(proposal.forbiddenWhen ? { forbiddenWhen: proposal.forbiddenWhen } : {}),
    ...(proposal.learningSignal ? { learningSignal: proposal.learningSignal } : {}),
    ...(proposal.learningProvenance ? { learningProvenance: proposal.learningProvenance } : {}),
    captureKey: `kstar-${source.id}-${index}`,
    // 空间归属：KStar 会话挂空间时 workspaceId 即空间 id（bus.ts 以
    // turnSpaceId 填充）。带上后资产落 spaceId，空间资产 tab 才能显示
    // KStar 沉淀的资产（否则全局可见但空间过滤不到）。
    ...(source.workspaceId && safeId(source.workspaceId) ? { spaceId: source.workspaceId } : {}),
  };
}

/**
 * Episode（直通）线入口：单 episode 的沉淀。
 *
 * 沉淀闸门不达阈（上游 `proposeKstarCandidates` 按 ΔR/置信度判完没有提案）→
 * 如实回一条 `no_update` 结论，不让"确实没什么可沉淀"静默无声。
 * `timed_out` 的 episode 由 `proposeKstarCandidates` 直接返回空——那不是
 * "没什么可沉淀"，而是"这次不算数"，**不写成 `no_update`**（不得掩盖失败）。
 */
export async function precipitateDirectExperienceAssets(
  userId: string,
  episode: KstarEpisodeRecord,
  proposals: KstarCandidateProposal[],
): Promise<PrecipitateDirectExperienceResult> {
  if (!safeId(userId) || !safeId(episode.id)) throw new Error('invalid direct experience reference');
  const admission = await kstarPrecipitationAdmission(userId, {
    source: 'direct_experience',
    episodes: [episode],
    episodeId: episode.id,
  });
  if (!proposals.length) {
    if (episode.r.status !== 'timed_out') await recordKstarNoUpdateOutcome(userId, admission);
    return {
      createdAssetIds: [], candidateIds: [], experienceIds: [], mergedIntoIds: [], updateCandidateIds: [], failureIds: [],
    };
  }
  // 直通线的 routing 上下文来自 episode 本身（任务目标 + 终态）。
  return precipitateDirectExperienceFromSource(
    userId,
    { id: episode.id, workspaceId: episode.s?.workspaceId },
    proposals,
    admission,
    { taskGoal: episode.t.userGoal, taskStatus: episode.r.status },
  );
}

/**
 * 两条沉淀线**唯一**的候选提交出口：先过采用门，再进候选池。
 *
 * `admission` 由调用线提供（需求级 / 直通线各自的上下文），本函数只做两件事：
 *  ① 把提案交给 `admitKstarProposals`，**只有 `admitted` 的提案**才会走到
 *     `saveRecallCandidate`（被拦提案不落候选，拦下的原因与结论由准入门落档）；
 *  ② 写入失败时保留既有 `recordKstarFailure(stage='precipitation')`（best-effort
 *     语义不变），并补一条 `submit_failed` 结论与归因。
 */
export async function precipitateDirectExperienceFromSource(
  userId: string,
  source: DirectExperienceSource,
  proposals: KstarCandidateProposal[],
  admission: KstarAdmissionContext,
  routing: DirectExperienceRouting,
): Promise<PrecipitateDirectExperienceResult> {
  if (!safeId(userId) || !safeId(source.id)) throw new Error('invalid direct experience reference');
  // 提交前取采用证据 + 准入（T007/T010/T011）：门在写入之前**只走一次**，
  // 两条线共用同一判定，不存在绕过它的第二出口。分流在准入**之后**——
  // 被准入拦下的提案既不落候选也不写经验（specs/016：分流的分流点在准入
  // 之后的提案处理处，准入逻辑本身不动）。
  const submitted = proposals.slice(0, 3);
  const gate = await admitKstarProposals(userId, submitted, admission);
  const allowed = new Set(gate.admitted);
  const result: PrecipitateDirectExperienceResult = {
    createdAssetIds: [],
    candidateIds: [],
    experienceIds: [],
    mergedIntoIds: [],
    updateCandidateIds: [],
    failureIds: [],
  };
  for (const [index, proposal] of submitted.entries()) {
    // 被拦提案不落候选：唯一的提交出口就是这里。index 用原序（不因被拦而
    // 重排）——captureKey 是候选的稳定指纹，漂移会造出第二个候选；经验 id
    // `exp-<source.id>-<index>` 同理复用这个原序。
    if (!allowed.has(proposal)) continue;
    try {
      const evidenceRefs = normalizeCognitionSourceRefs(proposal.sourceRefs);
      if (!evidenceRefs.length) continue;
      const action = recallFieldsForKstarProposal(proposal);
      // 分流（specs/016 D2 / T013）：create 型（无目标资产）改道写经验条目，
      // 不进候选池、不调 autoApplyRecallCandidate——经验与资产的晋升主链
      // 从这里物理分开（经验没有"候选→晋升"这扇门，D1）。
      if (routesToExperience(proposal, action)) {
        const experience = await writeExperienceForProposal(
          userId, source, proposal, index, admission, routing, evidenceRefs,
        );
        result.experienceIds.push(experience.id);
        continue;
      }
      // 1. Enter the unified candidate pool (exact-fingerprint dedup inside).
      //    saveRecallCandidate returns the EXISTING candidate when the exact
      //    fingerprint matched (merged evidence), or a fresh one otherwise.
      const candidate = await saveRecallCandidate(userId, await proposalToCandidateInput(userId, source, proposal, index));
      result.candidateIds.push(candidate.id);

      // 2. Unified promotion exit: semantic dedup + quality fusion against
      //    the asset library, then promote (or generate an update candidate).
      //    `provenance: 'kstar'` 仅作审计提示（出身收敛后不再产生行为差异）。
      const outcome = await autoApplyRecallCandidate(userId, candidate.id, { provenance: 'kstar' });
      if (outcome.asset) {
        result.createdAssetIds.push(outcome.asset.id);
        const workspaceId = source.workspaceId;
        if (workspaceId && safeId(workspaceId)) {
          try {
            const { addWorkspaceAssetReference } = await import('../recall/workspace-refs');
            await addWorkspaceAssetReference(userId, {
              assetId: outcome.asset.id,
              workspaceId,
              scope: proposal.suggestedScope,
            });
          } catch (error) {
            log.warn('direct experience workspace reference degraded', {
              userId,
              assetId: outcome.asset.id,
              error: (error as Error).message,
            });
          }
        }
      }
      if (outcome.mergedIntoAssetId) result.mergedIntoIds.push(outcome.mergedIntoAssetId);
      if (outcome.updateCandidate) result.updateCandidateIds.push(outcome.updateCandidate.id);
    } catch (error) {
      // Direct precipitation is best-effort: a failure must never break the
      // closure itself.
      log.warn('direct experience precipitation degraded', {
        userId,
        sourceId: source.id,
        error: (error as Error).message,
      });
      const failure = await recordKstarFailure(userId, {
        stage: 'precipitation', errorCode: 'asset_write_failed',
        errorMessage: (error as Error).message, operationKey: `precipitation-${source.id}-${index}`,
        ...(source.conversationId ? { conversationId: source.conversationId } : {}),
        ...(source.requirementId ? { requirementId: source.requirementId } : {}),
        episodeId: source.id.startsWith('kse-') ? source.id : undefined,
      }).catch(() => null);
      if (failure) result.failureIds.push(failure.id);
      // 提交失败如实反馈（T013）：同一失败重试时失败记录 id 与结论 id 都由
      // 派生保证只有一条（不产生第二条成功对象，也不产生第二条结论）。
      await recordKstarSubmitFailedOutcome(userId, admission, {
        error,
        ...(failure ? { failureId: failure.id } : {}),
      });
    }
  }
  return result;
}
