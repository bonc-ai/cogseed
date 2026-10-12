import * as fs from 'node:fs/promises';
import { describeRoleTemplateFieldRef } from '../personal_ontology_contract';
import * as personalOntologyCandidates from '../personal_ontology_candidates';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { createLogger } from '../../logger';
import { evaluatePromotionPolicy } from './promotion-policy';

import { describePromotionBlock, validatePromotionByAssetType, type PromotionBlockReason } from './formal-assets/promotion';
import { appendJsonlAtomic, genId12, nowIso, safeId } from '../../storage';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
import { fileEditLock } from '../../util/locks';
import { recallJsonRecordPath } from './paths';
import { gateCandidateStatement } from './candidate-statement-gate';
import { notifyCognitionWrite } from './store-events';
import {
  readRecallJsonRecord,
  updateRecallJsonRecord,
  writeRecallJsonRecord,
} from './store';
import type { RecallJsonRecord } from './types';
import type { KstarLearningProvenance, KstarLearningSignal } from '../kstar/types';
import type { CausalRule } from './world-model-types';
import { normalizeCausalRule } from './world-model-types';
import { normalizeAbilityAssetOntologyRefs, type AbilityAssetOntologyRef } from './ontology-refs';
import {
  readAbilityAssetRelationContract,
  type AbilityAssetRelation,
  type AbilityAssetRelationContract,
} from './asset-relations';
import { normalizeAbilityAssetScopePolicy, type RecallAbilityAssetScopePolicy } from './scope-policy';
import {
  readAbilityAssetSemantics,
  type AbilityAssetSemantics,
  type AbilityAssetSensitivity,
} from './asset-semantics';
import {
  createAbilityAsset,
  listAbilityAssetVersions,
  pauseAbilityAsset,
  readAbilityAsset,
  updateAbilityAsset,
  type AbilityAssetActor,
} from './asset-service';
import { fuseStatements, makeDisplayTitle } from './statement-fusion';
import { recallTitleIssue } from './title-policy';
import { recallStatementIssues } from './statement-policy';
import { evaluateCandidate, isCandidateBlocked } from '../cognition/gate';
import { isCognitionSourceEnabled } from './source-control';
import {
  readReviewDecision,
  recordReviewDecisionOutcome,
  reviewDecisionLogPath,
  writeReviewDecision,
  type ReviewDecision,
  type ReviewDecisionActor,
} from '../cognition/review-decision';
import {
  cognitionSourceRefKey,
  normalizeCognitionSourceRefs,
  normalizeCognitionSourceRefsForWrite,
  type CognitionSourceRef,
  type CognitionSourceType,
} from './source-service';
import {
  getRecallCandidateCapabilities,
  recallCandidateError,
  RECALL_CANDIDATE_NOT_PROMOTABLE_ERROR_CODE,
  RECALL_CANDIDATE_TERMINAL_ERROR_CODE,
  RecallCandidateStateError,
} from './candidate-capabilities';
import type { PersonalProfileSyncResult, PersonalProfileTarget } from './personal-profile-sync';

export type RecallCandidateStatus =
  | 'observed'
  | 'weak_observation'
  | 'pending_review'
  | 'deferred'
  | 'confirmed'
  | 'rejected'
  | 'ignored'
  | 'expired'
  | 'failed'
  | 'superseded';
export type AbilityAssetType = 'personal' | 'rule' | 'template' | 'skill_method' | 'fact';
export type RecallCandidateAction = 'create' | 'update' | 'limit_scope' | 'pause' | 'keep_current' | 'reject';
export type RecallCandidateRisk = 'low' | 'medium' | 'high';
export type RecallAbilityAssetLifecycleStatus = 'user_confirmed_unverified' | 'automatically_extracted_unverified' | 'system_precipitated_unverified';

const DEFAULT_CANDIDATE_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_DEFER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1_000;
const CANDIDATE_CONTENT_FORMAT_MIGRATION_ID = 'candidate-content-v1';


export interface RecallCandidateRecord extends RecallJsonRecord {
  id: string;
  /** Canonical content fields below are stable across every candidate producer. */
  contentFormatVersion: 1;
  taxonomyVersion: 2;
  status: RecallCandidateStatus;
  judgment: string;
  /** Why retaining this cognition will be useful in later work. */
  value: string;
  /** Preserved only for legacy message captures that stored evidence prose in `value`. */
  evidenceSummary?: string;
  summary: string;
  uncertainty?: string;
  suggestedType: AbilityAssetType;
  suggestedScope: string;
  sourceRefs: CognitionSourceRef[];
  evidenceRefs: CognitionSourceRef[];
  suggestedAction: RecallCandidateAction;
  risk: RecallCandidateRisk;
  /** 规则候选提出的适用/禁止范围。缺失 = 没提出过，不是「无限制」。 */
  applicableWhen?: string[];
  forbiddenWhen?: string[];
  learningSignal?: KstarLearningSignal;
  learningProvenance?: KstarLearningProvenance;
  captureKey?: string;
  /** 统一来源标记（2026-09-19 候选归一化）：读取时由 learningProvenance/
   *  captureKey 前缀/教学信号引用惰性推导，不再靠调用方拿前缀猜——
   *  'kstar'（KStar 沉淀）/ 'teaching'（用户教学）/ 'capture'（复盘·整理·
   *  capture 等系统提取的统称）；'manual'（「记一条」手动新建，2026-09-28：
   *  保存时显式落盘，读回校验与晋升豁免都靠它识别，不由前缀推导）。 */
  origin?: 'kstar' | 'teaching' | 'capture' | 'manual';
  /** 正文规范警示（读时派生、不落盘，2026-09-29）：确认页展示，不拦截写入。 */
  statementIssues?: Array<'empty' | 'too_long' | 'session_debris' | 'local_path'>;
  promotedAssetId?: string;
  reviewDecisionId?: string;
  decisionNote?: string;
  /** 空间归属：候选来自哪个空间（空间绘画/任务产出的认知）。资产随 recall 全局存储，
   *  空间资产 tab 按此字段过滤显示；空间可读全局资产但显示只显示本空间产生的。 */
  spaceId?: string;
  /** 执行可见范围。与 spaceId 的来源归属不同，此字段是读取权限限制。 */
  scopePolicy?: RecallAbilityAssetScopePolicy;
  cooldownUntil?: string;
  expiresAt: string;
  taskRunId?: string;
  targetAssetId?: string;
  /** 版本组契约（2026-09-16）：任务实际使用的目标资产版本（KSTAR 改进
   *  提案锚定用）；确认时与资产当前在用版核对，避免改错对象。 */
  targetVersionUsed?: string;
  /** Automatic semantic deduplication provenance. These links are audit hints,
   *  not lifecycle states: the candidate still ends in a normal state. */
  mergedInto?: string;
  mergedIntoAssetId?: string;
  failureCode?: 'asset_write_failed' | 'source_unavailable' | 'candidate_expired' | 'evidence_insufficient';
  failureMessage?: string;
  failedAt?: string;
  /** Cross-task effectiveness evidence. Missing fields are legacy records. */
  validationCount?: number;
  lastValidatedAt?: string;
  consecutiveFailures?: number;
  /** Validation record ids already applied to this candidate. */
  appliedValidationIds?: string[];
  userModifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecallAbilityAssetRecord extends RecallJsonRecord {
  id: string;
  candidateId: string;
  sourceCandidateIds?: string[];
  appliedReviewDecisionIds?: string[];
  reviewDecisionId: string;
  type: AbilityAssetType;
  title: string;
  statement: string;
  evidenceRefs: CognitionSourceRef[];
  /** 手动新建资产的空证据豁免标记（「记一条」晋升时从候选透传，2026-09-28）。 */
  origin?: 'manual';
  learningSignal?: KstarLearningSignal;
  learningProvenance?: KstarLearningProvenance;
  /** R-Box causal rule frozen from a delta_r lesson (world-model ontology). */
  causalRule?: CausalRule;
  ontologyRefs?: AbilityAssetOntologyRef[];
  relations?: AbilityAssetRelation[];
  /** 大类名（2026-09-22 族可命名）：挂族时继承族内已有名，用户可改
   *  （recall.families.rename 批量写族内全部成员）；元数据，不 bump 内容版本。 */
  familyName?: string;
  /** 主题标签（specs/012 US-201，data-model.md §3）：标签名数组，指向标签库
   *  `ability-tags` 条目的 `name`（按名引用，不是 id）。
   *  规则（写入侧收口于 ability-tag-service 的规范化唯一处，读侧不再校验）：
   *  - 缺失 与 [] 都表示「未分类」（与 familyName/scopePolicy 的三态纪律故意不同）；
   *  - ≤12 条、每条 trim 后非空且 ≤20 字、大小写不敏感去重（保留首现原样）；
   *  - 单一字符串必须拒绝，不自动包成数组；
   *  - 元数据：不 bump 内容版本（对齐 familyName 先例）、不进 version-diff、
   *    不参与推荐分（标签只影响筛选，不影响排序）。 */
  tags?: string[];
  derivedFrom?: string[];
  /** 适用/禁用条件。缺失=没记录过，**不是**「无限制」。 */
  applicableWhen?: string[];
  forbiddenWhen?: string[];
  /** 缺失=没分过级，不等于 L0。 */
  sensitivity?: AbilityAssetSensitivity;
  /** 用户显式确认过「这条可以跨作用域使用」的时间。
   *
   *  规范 10.2 里跨作用域是 confirm 档——既然规范要求「确认」，系统就得有地方
   *  记下确认发生过，否则那一档永远停在等待里。缺失=没确认过，不是拒绝过。 */
  crossScopeConfirmedAt?: string;
  scope: string;
  scopePolicy?: RecallAbilityAssetScopePolicy;
  recommendedAction?: 'pause' | 'rework';
  recommendationReason?: string;
  recommendationAt?: string;
  status: 'active' | 'paused' | 'archived' | 'deleted' | 'purged' | 'revoked';
  /** Confirmation semantics (never fake "user confirmed"):
   *   - user_confirmed_unverified: a real user review/acceptance happened
   *     (candidate promote line) but effectiveness is unproven;
   *   - automatically_extracted_unverified: extracted by the automatic
   *     cognition line (system actor, no user confirmation);
   *   - system_precipitated_unverified: precipitated by the KStar
   *     self-evolution line (system actor, no user confirmation) — the
   *     asset is honest about NOT being user-confirmed. */
  lifecycleStatus: RecallAbilityAssetLifecycleStatus;
  maturity: 'seed' | 'bud' | 'transfer_validated' | 'effectiveness_validated';
  deletedAt?: string;
  purgedAt?: string;
  version: string;
  /** 在用版本指针（2026-09-16 版本组）：缺省=跟随最新（version）；
   *  selectAbilityAssetVersion 切换后指向所选历史版本；后续内容更新
   *  bump 时重置为最新版。注入默认取该版本的内容快照。 */
  activeVersion?: string;
  /** 归并去向（2026-09-16 存量治理）：本条已并入某条目后记录其 id；
   *  本条随之归档，历史引用不回写。 */
  mergedIntoAssetId?: string;
  /** 空间归属：资产由某空间的候选确认而来（随 recall 全局存储，不随空间删）。 */
  spaceId?: string;
  /** Provenance for assets learned from conversation sources. */
  sourceSessionIds?: string[];
  /** Independent cross-task effectiveness evidence. Legacy assets may omit these. */
  validationCount?: number;
  lastValidatedAt?: string;
  consecutiveFailures?: number;
  appliedValidationIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SaveRecallCandidateInput {
  judgment: string;
  value?: string;
  evidenceSummary?: string;
  summary?: string;
  uncertainty?: string;
  suggestedType: AbilityAssetType;
  suggestedScope: string;
  sourceRefs: unknown[];
  evidenceRefs?: unknown[];
  suggestedAction?: RecallCandidateAction;
  risk?: RecallCandidateRisk;
  expiresAt?: string;
  taskRunId?: string;
  targetAssetId?: string;
  /** 版本组契约（2026-09-16）：任务实际使用的目标资产版本（KSTAR 改进
   *  提案锚定用）；确认时与资产当前在用版核对，避免改错对象。 */
  targetVersionUsed?: string;
  learningSignal?: KstarLearningSignal;
  learningProvenance?: KstarLearningProvenance;
  captureKey?: string;
  /** 「记一条」手动新建标记（2026-09-28 拍板项豁免）：手动候选没有对话
   *  来源，sourceRefs 只能为空——证据闸防的是自动提炼线编造来源，对用户
   *  亲自输入不适用；manual=true 时跳过"空证据落 weak_observation"判定、
   *  直接 pending_review，读回与晋升的同款放行靠落盘的 origin='manual'
   *  识别。自动线（capture/teaching/KStar）行为零变化。 */
  manual?: boolean;
  /** 忠实搬运豁免（2026-09-29 入池正文闸门）：文本是用户亲写或历史原文
   *  （对话中当场记 / 旧记忆迁移 / 旧本体导入），跳过机器改写——调用方
   *  显式声明；机器生成线不声明，默认过闸。manual（记一条）天然豁免。 */
  rawStatement?: boolean;
  /** 空间归属（可选）：来源会话/任务的 space_id。 */
  spaceId?: string;
  /** 需原样保留到正式资产的读取范围限制。 */
  scopePolicy?: RecallAbilityAssetScopePolicy;
  /** 规则类候选的适用/禁止范围。PRD 3.1 把它们列为 RuleAsset 的最低准入门槛，
   *  所以必须在候选阶段就带着走——否则自动线永远拿不出边界，规则也就永远
   *  晋升不了。缺失 = 没提出过，**不是**「无限制」。 */
  applicableWhen?: string[];
  forbiddenWhen?: string[];
  /** Internal extraction gate: preserve evidence without creating user review work. */
  forceWeakObservation?: boolean;
}

export interface RecallAssetHandoffReceipt {
  assetId: string;
  assetType: AbilityAssetType;
  version: string;
  lifecycleStatus: RecallAbilityAssetLifecycleStatus;
  scope: string;
  sourceRefs: CognitionSourceRef[];
  reviewDecisionId: string;
}

export interface RecallCandidatePromotionResult {
  candidate: RecallCandidateRecord;
  asset: RecallAbilityAssetRecord;
  decision: ReviewDecision;
  receipt: RecallAssetHandoffReceipt;
  /** Projection is best-effort and only present for Personal assets. */
  profileProjection?: PersonalProfileSyncResult;
  /** 版本重检口径（specs/015 D6/D7）：本次确认**没能**核对"改进对象版本"
   *  ——存量候选没有 `targetVersionUsed` 可核对。缺省不出现（=核对过，或
   *  本来就是新建型，没有可核对的版本）。渲染层据此如实提示"无法核对改进
   *  对象"，而不是假装核对过。 */
  versionCheckSkipped?: true;
  /** 显式重锚的留痕（`contracts/ipc.md` §二「实现期补充」）：本次确认把比对
   *  基线从候选原锚（= 这个字段的值，即原 `targetVersionUsed`）换到了用户看
   *  过差异后的当前在用版。只在**确实换了**（原锚存在且与传入的
   *  `confirmBaselineVersion` 不同）且这次确认**已生效**时出现——冲突路径
   *  不带它（没生效就谈不上重锚）。 */
  rebasedFrom?: string;
}

/** 版本重检不一致的结构化冲突（specs/015 D6~D9）。
 *
 *  字段名与 specs/008 的 `asset-approval-service.ts` 的 `versionConflict`
 *  逐字一致（`baselineVersion` / `currentVersion`），只多一个本链路的
 *  `targetVersionUsed`（= 候选锚定的版本，渲染层要能说清"拿哪一版比"）。
 *
 *  比对本身**只有一处**：`updateAbilityAsset` 的锁内（`asset-service.ts` 的
 *  `expectedVersion` 分支）。这里只承接它的结论，绝不重算——两份判定迟早
 *  会漂成两个口径。 */
export interface RecallCandidateVersionConflict {
  /** 候选基于的版本（= 候选的 `targetVersionUsed`）。 */
  baselineVersion: string;
  /** 锁内比到的当前在用版。 */
  currentVersion: string;
  /** 期望候选基于的版本。 */
  targetVersionUsed: string;
}

export const RECALL_CANDIDATE_VERSION_CONFLICT_CODE = 'recall_candidate_version_conflict';

/** 版本重检冲突（抛出型）：候选**不落终态**、资产零改动，由 IPC 层转成
 *  `contracts/ipc.md` §二 的返回体。 */
export class RecallCandidateVersionConflictError extends Error {
  readonly code = RECALL_CANDIDATE_VERSION_CONFLICT_CODE;
  readonly versionConflict: RecallCandidateVersionConflict;
  constructor(versionConflict: RecallCandidateVersionConflict) {
    super(`ability asset version conflict: expected v${versionConflict.baselineVersion}, current v${versionConflict.currentVersion}`);
    this.name = 'RecallCandidateVersionConflictError';
    this.versionConflict = versionConflict;
  }
}

/** 从任意抛出物里取版本冲突（IPC 用）。
 *  按 `code` + 形状判而不是 `instanceof`：错误会跨模块实例/序列化边界传递，
 *  认类名会把"同一件事"判成两件事。 */
export function recallCandidateVersionConflictOf(error: unknown): RecallCandidateVersionConflict | undefined {
  const record = error as { code?: unknown; versionConflict?: unknown } | null | undefined;
  if (!record || record.code !== RECALL_CANDIDATE_VERSION_CONFLICT_CODE) return undefined;
  const conflict = record.versionConflict as Partial<RecallCandidateVersionConflict> | undefined;
  if (!conflict || typeof conflict !== 'object') return undefined;
  return {
    baselineVersion: String(conflict.baselineVersion ?? ''),
    currentVersion: String(conflict.currentVersion ?? ''),
    targetVersionUsed: String(conflict.targetVersionUsed ?? ''),
  };
}

/** 版本重检的传参口径（specs/015 D6/D7；显式重锚见 `contracts/ipc.md` §二
 *  「实现期补充」）：
 *  - 只有**更新型**候选（`update` / `limit_scope`）有"改进对象版本"可核对；
 *  - 默认比 `targetVersionUsed`（候选生成时的锚，是可核对面本身，不被改写）；
 *  - 传了 `confirmBaselineVersion`（用户看过"对当前版差异"后确认）时以它为准：
 *    它才是这次要核的基线。比对仍然**只有一处**——`updateAbilityAsset` 的锁内
 *    （本文件不重算）；
 *  - `targetVersionUsed` 缺省（存量候选）且没有显式重锚 → 不重检，如实标
 *    `versionCheckSkipped`；
 *  - 重锚留痕只在"换了一个基线"时产生：原锚存在且与显式值不同，才把原锚作为
 *    `rebasedFrom` 交给决定账本（重锚可以生效，但不许静默改基线）。
 *  `create` 没有可核对的对象，`pause` 走 `pauseAbilityAsset`（没有版本比对面）
 *  ——两者都不谎报"已重检"，也不借这个旗标说"无法核对改进对象"；显式重锚在
 *  这两种落点上同样没有比对面，故不参与判定。 */
function candidateVersionRecheckPlan(
  action: RecallCandidateAction,
  targetVersionUsed: string | undefined,
  confirmBaselineVersion?: string,
): { expectedVersion?: string; versionCheckSkipped: boolean; rebasedFrom?: string } {
  const updateType = action === 'update' || action === 'limit_scope';
  const target = updateType ? targetVersionUsed : undefined;
  const explicit = updateType ? confirmBaselineVersion : undefined;
  const expectedVersion = explicit || target;
  return {
    ...(expectedVersion ? { expectedVersion } : {}),
    versionCheckSkipped: updateType && !expectedVersion,
    ...(explicit && target && explicit !== target ? { rebasedFrom: target } : {}),
  };
}

/** 把 `updateAbilityAsset` 抛出的版本冲突转成结构化冲突；其它错误返回 undefined。
 *  冲突文案由 `asset-service` 单点产生，这里只读同一个事实（解析方式与
 *  specs/008 的 `asset-approval-service.ts` 同款），不另算一遍。
 *
 *  `expectedVersion` = 本次实际送去比对的版本（没有比对面就不可能产生结构化
 *  冲突）；`baselineVersion` = 报告给渲染层的"候选基于的版本"（= 候选原锚）。
 *  两者只在**显式重锚**时不同：那时 `expectedVersion` 是用户新选中的基线，但
 *  冲突里该说清的仍是"候选基于哪一版"——字段含义不因重锚而变形，渲染层按
 *  同一套字段名处理第二次冲突。 */
function abilityAssetVersionConflict(
  error: unknown,
  expectedVersion: string | undefined,
  baselineVersion: string | undefined = expectedVersion,
): RecallCandidateVersionConflict | undefined {
  if (!expectedVersion) return undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes('version conflict')) return undefined;
  const currentVersion = message.match(/current v(\d+)/)?.[1] || '';
  const baseline = baselineVersion || expectedVersion;
  return { baselineVersion: baseline, currentVersion, targetVersionUsed: baseline };
}

/** 重锚留痕（`contracts/ipc.md` §二「实现期补充」）：显式把候选的比对基线换到
 *  当前在用版时，候选审查决定账本必须留下原锚——重锚可以生效，但不许静默改
 *  基线，用户和审计都要能看出"这条资产从哪一版开始被改"。
 *
 *  写法沿用账本自身的 append-only 口径（`recordReviewDecisionOutcome` 同款：
 *  同一 `decision_id` 以最后一条为准），所以这里**追加**一条带 `rebasedFrom`
 *  的记录来承接已落账的终态，而不是回头改写已写下的那条：账本只增不改。
 *  `ReviewDecision` 契约里没有这个字段，所以用交叉类型标注它，避免为一个
 *  审计附加信息去改账本的公共类型（那会让所有读口都多一个可选字段）。 */
async function recordRebasedDecisionTrace(
  userId: string,
  targetRef: string,
  decision: ReviewDecision,
  rebasedFrom: string,
): Promise<ReviewDecision> {
  const traced: ReviewDecision & { rebasedFrom: string } = {
    ...decision,
    rebasedFrom,
    timestamp: nowIso(),
  };
  await appendJsonlAtomic(reviewDecisionLogPath(userId, targetRef), traced);
  notifyCognitionWrite(userId, 'candidates', 'append', traced.decision_id);
  return traced;
}

interface StoredRecallAssetHandoffReceipt extends RecallJsonRecord, RecallAssetHandoffReceipt {
  id: string;
  candidateId: string;
  createdAt: string;
}

/** 系统线的来源。actor 只区分"人还是系统"，但两条系统线的可信度不同：
 *  会话自动抽取是模型从对话里猜的，KStar 自进化是从冻结预期 vs 实际结果的
 *  复盘里推的。认知树和资产详情要能分辨，否则两者在界面上长一个样。 */
export type RecallPromotionProvenance = 'capture' | 'kstar';

export interface PromoteRecallCandidateOptions extends AbilityAssetSemantics {
  /** 评审决定的 actor：只有人与自动线两种。资产管家的 AI 工具**不能**晋升候选
   *  ——记忆的出生必须来自人确认或自动抽取线，所以这里不接受 'ai'
   *  （与 ReviewDecisionActor 同域，specs/008 未开这个口子）。 */
  actor?: ReviewDecisionActor;
  /** 仅在 actor === 'system' 时有意义；缺省按会话自动抽取线处理。 */
  provenance?: RecallPromotionProvenance;
  ontologyRefs?: AbilityAssetOntologyRef[];
  scopePolicy?: RecallAbilityAssetScopePolicy;
  decisionType?: 'accept' | 'modify';
  decisionId?: string;
  decisionReason?: string;
  riskAcknowledged?: boolean;
  /** 版本组防分裂（2026-09-16）：用户在相似资产提示后明确选择"仍保存为新
   *  条目"时置 true，跳过相似闸门。 */
  forceCreateSimilar?: boolean;
  /** R-Box causal rule; only activated when explicitly supplied by the user. */
  causalRule?: CausalRule;
  /** Optional explicit personal-template destination selected during review. */
  profileTarget?: PersonalProfileTarget;
  /** 版本冲突后的**显式重锚**（specs/015 US-702，`contracts/ipc.md` §二
   *  「实现期补充」）：调用方声明"我已看过候选判断**对版本 X 的差异**，按它
   *  重新确认"。与 `targetVersionUsed`（候选生成时冻下的锚，只读）不同，这个
   *  值来自用户看过差异之后，代表他这次认可哪一版。
   *
   *  主进程在 `updateAbilityAsset` **锁内**再核一次 `X === 当前在用版`（唯一
   *  一处比对）：不成立仍按结构化冲突返回（零改动），成立才用**当前正文**重新
   *  融合落库，并在决定账本记 `rebasedFrom`（原锚，与 X 不同才记）。
   *  缺省 = 老行为（比 `targetVersionUsed`），存量候选的语义一个字不变。
   *  只对更新型候选（`update` / `limit_scope`）有意义（见
   *  `candidateVersionRecheckPlan`）。 */
  confirmBaselineVersion?: string;
}

const log = createLogger('recall.candidates');

/** 判重用的可比文本：与 capture-service 的同名归一化保持一致（大小写、
 *  空白、标点都不参与比较）。 */
function comparableJudgmentText(value: string): string {
  return String(value || '').normalize('NFKC').replace(/[\p{P}\p{S}\s]/gu, '').toLocaleLowerCase();
}

/**
 * 候选池里「同一句话被分成两类」的冲突类型表：candidateId → 其它条目的类型。
 *
 * 这是**跨候选**判断，单条候选算不出来，所以能力判据
 * （candidate-capabilities.ts）没法自己算——必须由持有完整候选列表的读口
 * （`recall.candidates.list`、inbox adapter、tree）算好传进去。
 *
 * 判据与 `promoteRecallCandidate` 的晋升前置校验**逐字相同**（同文本、未被
 * 否决、类型不同）。两处如果分叉，就会重新长出"列表说能确认、晋升说不行"
 * 的老问题。
 */
export function recallCandidateConflictingTypes(
  candidates: readonly RecallCandidateRecord[],
): Map<string, string[]> {
  const byText = new Map<string, RecallCandidateRecord[]>();
  for (const candidate of candidates) {
    const text = comparableJudgmentText(candidate.judgment);
    if (!text) continue;
    if (candidate.status === 'rejected' || candidate.status === 'ignored'
      || candidate.status === 'expired' || candidate.status === 'failed') continue;
    byText.set(text, [...(byText.get(text) || []), candidate]);
  }
  const conflicts = new Map<string, string[]>();
  for (const group of byText.values()) {
    if (group.length < 2) continue;
    for (const candidate of group) {
      const others = [...new Set(group
        .filter((other) => other.id !== candidate.id && other.suggestedType !== candidate.suggestedType)
        .map((other) => other.suggestedType))];
      if (others.length) conflicts.set(candidate.id, others);
    }
  }
  return conflicts;
}

/** 候选未通过分类型准入门槛时抛出。调用方据此把候选留在池子里等补齐，
 *  而不是当作写入失败去重试——重试同样过不了闸。 */
export class PromotionBlockedError extends Error {
  readonly code = 'promotion_blocked';
  constructor(readonly reasons: PromotionBlockReason[]) {
    super(`candidate does not meet the formal asset bar: ${reasons.map(describePromotionBlock).join('; ')}`);
    this.name = 'PromotionBlockedError';
  }
}

/** 语义查重不可用时抛出。调用方据此把候选留在池子里等人工确认，而不是
 *  当作"查过且没有重复"继续自动晋升。 */
export class SemanticDedupUnavailableError extends Error {
  readonly code = 'semantic_dedup_unavailable';
  constructor(readonly reason: string) {
    super(`semantic duplicate check unavailable: ${reason}`);
    this.name = 'SemanticDedupUnavailableError';
  }
}

export class PromotionPausedError extends Error {
  readonly code = 'promotion_paused';
  constructor(readonly reason: string) {
    super(`automatic promotion paused: ${reason}`);
    this.name = 'PromotionPausedError';
  }
}

const MAX_SOURCE_SESSION_IDS = 50;

/**
 * 落点只有一个 opaque fieldRef。这里只做「是不是一个 PO 认得的写入句柄」，
 * 不解析、不重建其内部结构——分节/字段/装态/T-box 由 PO 在写入时判定。
 */
function normalizePersonalProfileTarget(value: PersonalProfileTarget | undefined): PersonalProfileTarget | undefined {
  if (value === undefined) return undefined;
  const fieldRef = value && typeof value.fieldRef === 'string' ? value.fieldRef.trim() : '';
  if (!fieldRef || !describeRoleTemplateFieldRef(fieldRef)) {
    throw new Error('invalid personal profile target');
  }
  return { fieldRef };
}

function sourceSessionIdsFrom(refs: CognitionSourceRef[]): string[] {
  const ids: string[] = [];
  for (const ref of refs) {
    if (ref.kind !== 'conversation' || ids.includes(ref.id)) continue;
    ids.push(ref.id);
    if (ids.length >= MAX_SOURCE_SESSION_IDS) break;
  }
  return ids;
}

function boundedText(value: unknown, field: string, max: number, required = false): string | undefined {
  if (typeof value !== 'string') {
    if (required) throw new Error(`missing ${field}`);
    return undefined;
  }
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) {
    if (required) throw new Error(`missing ${field}`);
    return undefined;
  }
  if (text.length > max) throw new Error(`${field} is too long`);
  return text;
}

function fallbackCandidateTitle(judgment: string): string {
  return makeDisplayTitle(judgment, /\p{Script=Han}/u.test(judgment) ? 16 : 60);
}

/**
 * 晋升线标题兜底（设计《认知资产-四病整改设计-20260928》3.2 六路径配套）：
 * 保留「summary 优先」的原有逻辑；summary 缺失（旧记录/直写数据）或对**将落盘
 * 的最终正文**不合规（首字与正文重复/超长/标点结尾——fallbackCandidateTitle
 * ＝正文首句截断，天然命中前缀重复）时，晋升链调 `suggestAbilityAssetTitle`
 * 让模型起一个过 3.1 判定的合规标题。老的 `judgment.slice(0, 120)` 机器截断
 * 兜底已删——机器编标题正是四病整改要堵的写入形态。模型不可用或多次输出
 * 不合规按设计口径**明示失败**（不静默降级），失败原样上抛，晋升不落半成品。
 * 动态 import 避免 candidate-service ↔ 模型链的静态环。
 */
async function resolvePromotionAssetTitle(
  userId: string,
  input: { preferredTitle: string; statement: string; type: AbilityAssetType },
): Promise<string> {
  const statement = String(input.statement || '');
  if (!recallTitleIssue(input.preferredTitle, statement)) return input.preferredTitle;
  const { suggestAbilityAssetTitle } = await import('./asset-title-suggestion');
  const suggested = await suggestAbilityAssetTitle(userId, {
    statement,
    type: input.type,
  });
  return suggested.title;
}

function requireAssetType(value: unknown): AbilityAssetType {
  if (value === 'personal' || value === 'rule' || value === 'template' || value === 'skill_method' || value === 'fact') return value;
  throw new Error('invalid suggested type');
}

function requireCandidateAction(value: unknown): RecallCandidateAction {
  if (value === undefined) return 'create';
  if (value === 'create' || value === 'update' || value === 'limit_scope' || value === 'pause' || value === 'keep_current' || value === 'reject') return value;
  throw new Error('invalid suggested action');
}

function requireCandidateRisk(value: unknown): RecallCandidateRisk {
  if (value === undefined) return 'low';
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw new Error('invalid candidate risk');
}

function requireAssetLifecycleStatus(value: unknown): RecallAbilityAssetLifecycleStatus {
  if (value === 'user_confirmed_unverified' || value === 'automatically_extracted_unverified' || value === 'system_precipitated_unverified') return value;
  throw new Error('malformed recall asset handoff receipt lifecycle');
}

function normalizeCandidateStatus(value: unknown): RecallCandidateStatus {
  if (value === 'pending') return 'pending_review';
  if (value === 'promoted') return 'confirmed';
  // 历史兼容：早期实现给语义重复候选写过未声明的 `superseded`。现在
  // semanticDedupBeforePromote 走的是 mergedInto + decideWithoutAsset('ignored')，
  // 全仓已无写入方，所以这里只做旧数据迁移——迁成 ignored 后它本来就是终态，
  // isTerminalCandidate 无需改动。落到下面的白名单里再放行一次 superseded
  // 是不可达分支，删掉，免得读回行为看起来有两套。
  if (value === 'superseded') return 'ignored';
  if (value === 'observed' || value === 'weak_observation' || value === 'pending_review'
    || value === 'deferred' || value === 'confirmed' || value === 'rejected'
    || value === 'ignored' || value === 'expired' || value === 'failed') return value;
  throw new Error('malformed recall candidate');
}

function isTerminalCandidate(status: RecallCandidateStatus): boolean {
  return status === 'confirmed' || status === 'rejected' || status === 'ignored' || status === 'expired';
}

function isSuppressedTerminalCandidate(status: RecallCandidateStatus): boolean {
  return status === 'rejected' || status === 'ignored' || status === 'expired';
}

/**
 * **系统自动沉淀**的准入门禁——不是"用户能不能处理"。
 *
 * 消费方全是自动路径（capture-service 的自动捕获、autoApplyRecallCandidate）。
 * 用户侧可操作面在 candidate-capabilities.ts；那边把 weak_observation 放开是
 * 产品要的，这里放开则等于让系统跳过用户确认自动晋升弱证据候选。两条线
 * 必须分开，不要因为 UI 收敛顺手合并。
 */
export type ImmediateIngestMode = 'created' | 'already-confirmed' | 'merged' | 'fused-update-pending' | 'pending-review';

export interface ImmediateIngestResult {
  mode: ImmediateIngestMode;
  /** created 或 already-confirmed 时可用的正式资产 id。 */
  assetId?: string;
  /** 候选 id（各模式都有——即时直投也留候选痕迹，可审计可撤销）。 */
  candidateId: string;
}

/** 即时模式直投（2026-09-19 方案甲·清单 #3）：模型对话中主动记的知识不再
 *  写记忆文件，直投第二段入库——存候选 → 统一晋升出口（autoApply 自带查重
 *  金字塔 L1/L2、判族挂族、正规 ReviewDecision），产出「模型记的·未验证」
 *  资产，入库即可用。
 *  类型约定：即时记忆是画像/偏好/身份类（原记忆 USER/共享档的语义），统一
 *  personal；rule/template/skill_method 留给批量线（提取器补边界）。
 *  embedding 不可用等异常不抛给对话——候选留在「待我处理」，返回
 *  pending-review。requireUserReview 用于调用方无法证明措辞逐字来自当前用户
 *  消息的场景：保留候选，但跳过自动晋升。 */
export async function ingestImmediateKnowledge(
  userId: string,
  input: {
    text: string;
    conversationId?: string;
    messageId?: string;
    requireUserReview?: boolean;
    spaceId?: string;
    scopePolicy?: RecallAbilityAssetScopePolicy;
  },
): Promise<ImmediateIngestResult> {
  const text = boundedText(String(input.text || '').trim(), 'immediate knowledge', 4_000, true);
  if (!text) throw new Error('immediate knowledge text is required');
  const { scanForInjection } = await import('../memory');
  const threat = scanForInjection(text);
  if (threat) throw new Error(`immediate knowledge blocked: suspicious content (${threat})`);
  const { makeDisplayTitle } = await import('./statement-fusion');
  // 来源引用直接用真实会话 id（来源目录会话级条目按裸 cid 命中）——此前拼
  // `immediate-` 前缀合成 id，目录永远查不到，候选被渲染层误标「来源已删」
  // （2026-09-20 修复）。证据粒度到会话：目录消息级条目用另一套 stableId
  // 编码，不在此拼。无会话场景保留内容哈希 id（无独立出处，由渲染层如实
  // 标注「对话中当场记」）。
  const refs = input.conversationId
    ? [{
      kind: 'conversation' as const,
      id: String(input.conversationId).slice(0, 160),
      scope: 'conversation' as const,
      subtype: 'session' as const,
    }]
    : [{
      kind: 'conversation' as const,
      id: `immediate-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`,
    }];
  // captureKey：候选池确定幂等 + 「对话中记」的身份标记（safeId 白名单不许
  // 冒号，统一 immediate- 连字符前缀；渲染层徽章与证据文案据此识别，并兼容
  // 存量 immediate- 引用 id）。
  const scopePolicy = normalizeAbilityAssetScopePolicy(input.scopePolicy);
  const scopeIdentity = scopePolicyIdentity(scopePolicy);
  const immediateCaptureKey = `immediate-${createHash('sha256')
    .update(scopeIdentity ? `${text}\0${scopeIdentity}` : text)
    .digest('hex').slice(0, 24)}`;
  const candidate = await saveRecallCandidate(userId, {
    judgment: text,
    // 用户当场口述原文：豁免入池正文闸门（机器改写用户亲写=篡改）。
    rawStatement: true,
    value: text,
    summary: makeDisplayTitle(text),
    suggestedType: 'personal',
    suggestedScope: 'general',
    suggestedAction: 'create',
    sourceRefs: refs,
    evidenceRefs: refs,
    captureKey: immediateCaptureKey,
    ...(input.spaceId && safeId(input.spaceId) ? { spaceId: input.spaceId } : {}),
    ...(scopePolicy ? { scopePolicy } : {}),
  });
  // Callers handling model-authored wording can force the ordinary user review
  // path. A new candidate is durable and visible, but it is not active until
  // the user confirms or edits it in To Review.
  // 去重可能命中早已确认的候选。不能再将它报告为“等待审核”，否则用户会
  // 看到一个不存在的待确认入口，并误以为正式资产尚未生效。
  if (candidate.status === 'confirmed') {
    return {
      mode: 'already-confirmed',
      candidateId: candidate.id,
      ...(candidate.promotedAssetId ? { assetId: candidate.promotedAssetId } : {}),
    };
  }
  if (input.requireUserReview) return { mode: 'pending-review', candidateId: candidate.id };
  try {
    const applied = await autoApplyRecallCandidate(userId, candidate.id, { provenance: 'capture' });
    if (applied.asset?.id) return { mode: 'created', assetId: applied.asset.id, candidateId: candidate.id };
    // 查重命中既有资产（L1/L2）→ 已改写为 update 候选，等你确认后融合出新版本。
    if (applied.updateCandidate?.targetAssetId) {
      return { mode: 'fused-update-pending', candidateId: candidate.id };
    }
    // When semantic dedup merges this new candidate into an existing candidate,
    // point callers at the surviving review item. The newly ingested candidate
    // is terminal (`ignored`) and cannot be the user's next review destination.
    return {
      mode: 'merged',
      candidateId: applied.mergedIntoCandidateId || applied.candidate.id,
    };
  } catch (error) {
    // 自动晋升受阻不等于候选写入失败：内容已经进入候选池，交给「待我处理」
    // 让用户补充边界/修改类型。项目事实误入个人档就是这类准入阻塞。
    if (error instanceof PromotionBlockedError
      || (error as { code?: string }).code === 'promotion_blocked'
      || error instanceof SemanticDedupUnavailableError
      || (error as { code?: string }).code === 'semantic_dedup_unavailable') {
      return { mode: 'pending-review', candidateId: candidate.id };
    }
    throw error;
  }
}

/** Import one user-selected legacy memory entry without inventing a conversation
 * source. The user has explicitly selected and confirmed this exact entry in
 * the migration review UI; preserve that history as a stable legacy-memory
 * evidence reference on the resulting asset. */
export async function ingestLegacyMemoryKnowledge(
  userId: string,
  input: {
    text: string;
    scope?: 'user' | 'shared';
    contentHash: string;
    target?: { kind: 'agent' | 'space' | 'project'; id: string; spaceId?: string };
    sourceRefs?: unknown[];
  },
): Promise<ImmediateIngestResult> {
  const text = boundedText(String(input.text || '').trim(), 'legacy memory entry', 4_000, true);
  if (!text) throw new Error('legacy memory entry is required');
  if (input.scope !== undefined && input.scope !== 'user' && input.scope !== 'shared') throw new Error('invalid legacy memory scope');
  if ((!input.scope && !input.target) || (input.scope && input.target)) throw new Error('legacy memory target is required');
  if (!/^[a-f0-9]{64}$/.test(String(input.contentHash || ''))) throw new Error('invalid legacy memory content hash');
  if (input.target && (!['agent', 'space', 'project'].includes(input.target.kind) || !safeId(input.target.id)
    || (input.target.spaceId !== undefined && !safeId(input.target.spaceId)))) {
    throw new Error('invalid legacy memory target');
  }

  const { scanForInjection } = await import('../memory');
  const threat = scanForInjection(text);
  if (threat) throw new Error(`legacy memory entry blocked: suspicious content (${threat})`);
  const { makeDisplayTitle } = await import('./statement-fusion');
  const fileLabel = input.target
    ? input.target.kind === 'agent' ? `旧 Agent 记忆 · ${input.target.id}`
      : input.target.kind === 'space' ? `旧 Space 记忆 · ${input.target.id}`
        : `旧 Project 记忆 · ${input.target.id}`
    : input.scope === 'user' ? '旧 USER.md 个人记忆' : '旧 MEMORY.md 共享记忆';
  const sourceRef = input.sourceRefs?.length
    ? undefined
    : {
      kind: 'memory' as const,
      id: `legacy-${input.scope || input.target?.kind}-${input.contentHash.slice(0, 32)}`,
      title: fileLabel,
      excerpt: text,
    };
  const sourceRefs = input.sourceRefs?.length ? input.sourceRefs : [sourceRef];
  const scopePolicy = input.target?.kind === 'agent'
    ? { agentIds: [input.target.id] }
    : input.target?.kind === 'space'
      ? { workspaceIds: [input.target.id] }
      : input.target?.kind === 'project'
        ? {
          ...(input.target.spaceId ? { workspaceIds: [input.target.spaceId] } : {}),
          projectIds: [input.target.id],
        }
        : undefined;
  const spaceId = input.target?.kind === 'space'
    ? input.target.id
    : input.target?.kind === 'project' ? input.target.spaceId : undefined;
  const captureKey = input.target
    ? `legacy-memory-scoped-${createHash('sha256').update(JSON.stringify({ target: input.target, scopePolicy, hash: input.contentHash })).digest('hex').slice(0, 32)}`
    : `legacy-memory-${input.scope}-${input.contentHash.slice(0, 32)}`;
  const candidate = await saveRecallCandidate(userId, {
    judgment: text,
    // 旧记忆迁移=忠实搬运历史原文：豁免闸门，警示与治理轮兜底。
    rawStatement: true,
    value: text,
    summary: makeDisplayTitle(text),
    suggestedType: 'personal',
    suggestedScope: 'general',
    suggestedAction: 'create',
    sourceRefs,
    evidenceRefs: sourceRefs,
    captureKey,
    ...(scopePolicy ? { scopePolicy } : {}),
    ...(spaceId ? { spaceId } : {}),
  });

  if (candidate.status === 'confirmed' && candidate.promotedAssetId) {
    return { mode: 'created', assetId: candidate.promotedAssetId, candidateId: candidate.id };
  }
  try {
    const promoted = await promoteRecallCandidate(userId, candidate.id, {
      actor: 'user',
      decisionType: 'accept',
      decisionReason: `User explicitly migrated this entry from ${fileLabel}.`,
    });
    return { mode: 'created', assetId: promoted.asset.id, candidateId: candidate.id };
  } catch (error) {
    // A semantic duplicate, security gate, or other review-only condition must
    // leave the source note in place. The persisted candidate remains visible
    // to the user; migration cleanup only occurs after a confirmed asset.
    const latest = await readRecallCandidate(userId, candidate.id).catch(() => undefined);
    if (latest && ['pending_review', 'deferred', 'observed', 'weak_observation'].includes(latest.status)) {
      return { mode: 'pending-review', candidateId: candidate.id };
    }
    throw error;
  }
}

export function isAutoCaptureEligible(candidate: Pick<RecallCandidateRecord, 'status'>): boolean {
  return candidate.status === 'pending_review' || candidate.status === 'failed';
}

function requireIsoTimestamp(value: unknown, field: string, fallback?: string): string {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (!text || !Number.isFinite(Date.parse(text))) throw new Error(`invalid ${field}`);
  return new Date(text).toISOString();
}


const KSTAR_ATTRIBUTIONS = new Set<KstarLearningProvenance['attribution']>([
  'knowledge_gap', 'rule_gap', 'template_gap', 'skill_gap', 'execution_gap', 'unclear',
]);

function normalizedStringArray(value: unknown, field: string, maxItems = 100): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`malformed candidate learning provenance ${field}`);
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error(`malformed candidate learning provenance ${field}`);
    const text = item.replace(/\s+/g, ' ').trim();
    if (!text || text.length > 500) throw new Error(`malformed candidate learning provenance ${field}`);
    return text;
  });
}

function normalizeActionDelta(value: unknown): KstarLearningProvenance['actionDelta'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed candidate learning provenance action delta');
  const record = value as Record<string, unknown>;
  if (typeof record.orderMismatch !== 'boolean') throw new Error('malformed candidate learning provenance action delta');
  return {
    missingTools: normalizedStringArray(record.missingTools, 'missing tools'),
    unexpectedTools: normalizedStringArray(record.unexpectedTools, 'unexpected tools'),
    missingActors: normalizedStringArray(record.missingActors, 'missing actors'),
    unexpectedActors: normalizedStringArray(record.unexpectedActors, 'unexpected actors'),
    missingPlanSteps: normalizedStringArray(record.missingPlanSteps, 'missing plan steps'),
    extraActions: normalizedStringArray(record.extraActions, 'extra actions'),
    failedActions: normalizedStringArray(record.failedActions, 'failed actions'),
    orderMismatch: record.orderMismatch,
  };
}

function normalizeResultDelta(value: unknown): KstarLearningProvenance['resultDelta'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed candidate learning provenance result delta');
  const record = value as Record<string, unknown>;
  if (!['completed', 'failed', 'cancelled', 'timed_out', 'waiting_input'].includes(String(record.terminalStatus))) {
    throw new Error('malformed candidate learning provenance result delta');
  }
  if (!Array.isArray(record.acceptanceSignals) || record.acceptanceSignals.length > 100) {
    throw new Error('malformed candidate learning provenance acceptance signals');
  }
  const acceptanceSignals = record.acceptanceSignals.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('malformed candidate learning provenance acceptance signal');
    const signal = item as Record<string, unknown>;
    if (!['met', 'not_met', 'unknown'].includes(String(signal.status))) throw new Error('malformed candidate learning provenance acceptance signal');
    const normalizedSignal = boundedText(signal.signal, 'learning provenance acceptance signal', 500, true)!;
    const evidence = boundedText(signal.evidence, 'learning provenance acceptance evidence', 2_000, true)!;
    return { signal: normalizedSignal, status: signal.status as 'met' | 'not_met' | 'unknown', evidence };
  });
  return {
    acceptanceSignals,
    missingPredictedFiles: normalizedStringArray(record.missingPredictedFiles, 'missing predicted files'),
    unexpectedProducedFiles: normalizedStringArray(record.unexpectedProducedFiles, 'unexpected produced files'),
    terminalStatus: record.terminalStatus as 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'waiting_input',
  };
}

function normalizeLearningProvenance(value: unknown): KstarLearningProvenance | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed candidate learning provenance');
  const record = value as Record<string, unknown>;
  if (
    !safeId(record.projectionId)
    || (record.forecastId !== undefined && !safeId(record.forecastId))
    || !safeId(record.episodeId)
  ) {
    throw new Error('malformed candidate learning provenance ids');
  }
  if (!KSTAR_ATTRIBUTIONS.has(record.attribution as KstarLearningProvenance['attribution'])) {
    throw new Error('malformed candidate learning provenance attribution');
  }
  const ruleRefs = normalizedStringArray(record.ruleRefs, 'rule refs');
  if (ruleRefs.some((ref) => !/^[A-Za-z0-9:_-]+$/.test(ref))) throw new Error('malformed candidate learning provenance rule refs');
  const actionDelta = normalizeActionDelta(record.actionDelta);
  const resultDelta = normalizeResultDelta(record.resultDelta);
  return {
    projectionId: record.projectionId as string,
    ...(record.forecastId ? { forecastId: record.forecastId as string } : {}),
    episodeId: record.episodeId as string,
    ruleRefs,
    attribution: record.attribution as KstarLearningProvenance['attribution'],
    ...(actionDelta ? { actionDelta } : {}),
    ...(resultDelta ? { resultDelta } : {}),
  };
}

function normalizeLearningSignal(value: unknown): KstarLearningSignal | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed candidate learning signal');
  const signal = value as Record<string, unknown>;
  if (
    (signal.expectedResult !== undefined && typeof signal.expectedResult !== 'string') ||
    (signal.actualResult !== undefined && typeof signal.actualResult !== 'string') ||
    (signal.deltaR !== 'unknown' && (typeof signal.deltaR !== 'number' || !Number.isFinite(signal.deltaR))) ||
    (signal.deltaA !== 'unknown' && (typeof signal.deltaA !== 'number' || !Number.isFinite(signal.deltaA))) ||
    !['better_than_expected', 'met_expected', 'worse_than_expected', 'unclear'].includes(String(signal.outcome)) ||
    typeof signal.confidence !== 'number' || !Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1 ||
    signal.source !== 'review'
  ) throw new Error('malformed candidate learning signal');
  return signal as unknown as KstarLearningSignal;
}

function asCandidate(value: RecallJsonRecord): RecallCandidateRecord {
  if (value.contentFormatVersion !== undefined && value.contentFormatVersion !== 1) {
    throw new Error('unsupported recall candidate content format');
  }
  if (
    typeof value.judgment !== 'string' ||
    typeof value.suggestedType !== 'string' ||
    typeof value.suggestedScope !== 'string' ||
    !Array.isArray(value.sourceRefs) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) throw new Error('malformed recall candidate');
  const storedStatus = normalizeCandidateStatus(value.status);
  const cooldownUntil = value.cooldownUntil === undefined
    ? undefined
    : requireIsoTimestamp(value.cooldownUntil, 'candidate cooldown');
  const status = storedStatus === 'deferred' && cooldownUntil !== undefined && Date.parse(cooldownUntil) <= Date.now()
    ? 'pending_review'
    : storedStatus;
  const sourceRefs = normalizeCognitionSourceRefs(value.sourceRefs);
  const evidenceRefs = Array.isArray(value.evidenceRefs)
    ? normalizeCognitionSourceRefs(value.evidenceRefs)
    : sourceRefs;
  if ((!sourceRefs.length || !evidenceRefs.length) && status !== 'observed' && status !== 'weak_observation'
    && (value as { origin?: unknown }).origin !== 'manual') {
    throw new Error('malformed recall candidate evidence');
  }
  const learningSignal = normalizeLearningSignal(value.learningSignal);
  const learningProvenance = normalizeLearningProvenance(value.learningProvenance);
  const scopePolicy = normalizeAbilityAssetScopePolicy(value.scopePolicy);
  const origin = deriveCandidateOrigin(value, learningProvenance !== undefined);
  const createdAt = requireIsoTimestamp(value.createdAt, 'candidate created at');
  // The previous bubble-capture contract wrote an evidence explanation into
  // `value` and left scope empty. Keep that text in its own compatibility slot
  // and expose an empty future-value field so the user can complete the new form.
  // The one-time candidate-format migration persists this lossless projection.
  const legacyBubbleEvidence = value.contentFormatVersion === undefined
    && !value.captureKey
    && value.suggestedScope === ''
    && sourceRefs.some((ref) => ref.kind === 'conversation' && ref.subtype === 'message')
    && evidenceRefs.some((ref) => ref.kind === 'conversation' && ref.subtype === 'session')
    ? boundedText(value.value, 'legacy evidence summary', 4_000)
    : undefined;
  const evidenceSummary = typeof value.evidenceSummary === 'string'
    ? boundedText(value.evidenceSummary, 'candidate evidence summary', 4_000)
    : legacyBubbleEvidence;
  const candidateSummary = boundedText(value.summary, 'candidate summary', 1_000)
    || fallbackCandidateTitle(String(value.judgment || ''));
  const candidateValue = Object.prototype.hasOwnProperty.call(value, 'value')
    ? (legacyBubbleEvidence ? '' : boundedText(value.value, 'candidate value', 4_000) || '')
    : value.judgment;
  return {
    ...value,
    contentFormatVersion: 1,
    taxonomyVersion: 2,
    status,
    value: candidateValue,
    summary: candidateSummary,
    ...(evidenceSummary ? { evidenceSummary } : {}),
    suggestedType: requireAssetType(value.suggestedType),
    suggestedAction: requireCandidateAction(value.suggestedAction),
    risk: requireCandidateRisk(value.risk),
    sourceRefs,
    evidenceRefs,
    ...(cooldownUntil ? { cooldownUntil } : {}),
    expiresAt: requireIsoTimestamp(value.expiresAt, 'candidate expiry', new Date(Date.parse(createdAt) + DEFAULT_CANDIDATE_TTL_MS).toISOString()),
    ...(learningSignal ? { learningSignal } : {}),
    ...(learningProvenance ? { learningProvenance } : {}),
    ...(scopePolicy ? { scopePolicy } : {}),
    ...(origin ? { origin } : {}),
    // 正文规范警示（2026-09-29）：读时派生、不落盘——只给人看与治理轮圈选，
    // 不拦截写入（正文是知识本体，把关权在人，设计定稿）。
    ...(recallStatementIssues({ statement: value.judgment, type: value.suggestedType }).length
      ? { statementIssues: recallStatementIssues({ statement: value.judgment, type: value.suggestedType }) }
      : {}),
  } as RecallCandidateRecord;
}

/** 候选来源的惰性推导（读时附加、不落盘、零迁移）：KStar 溯源最硬，其次
 *  captureKey 前缀，再次教学信号引用；兜底 capture（复盘/整理/capture 线
 *  统称）。旧记录读了就有 origin，新写入不改盘上形状。 */
function deriveCandidateOrigin(
  value: RecallJsonRecord,
  hasLearningProvenance: boolean,
): 'kstar' | 'teaching' | 'capture' | 'manual' | undefined {
  // 手动标记优先于一切前缀推导：「记一条」候选落盘即带 origin='manual'，
  // 读回时保住它（否则会被兜底推成 'capture'），豁免链全靠这个识别。
  if ((value as { origin?: unknown }).origin === 'manual') return 'manual';
  if (hasLearningProvenance) return 'kstar';
  const captureKey = typeof value.captureKey === 'string' ? value.captureKey : '';
  if (captureKey.startsWith('kstar-')) return 'kstar';
  if (captureKey.startsWith('teaching-')) return 'teaching';
  if (Array.isArray(value.sourceRefs)
    && value.sourceRefs.some((ref) => ref && typeof ref === 'object' && (ref as { kind?: unknown }).kind === 'user_teaching_signal')) {
    return 'teaching';
  }
  return 'capture';
}

function asAsset(value: RecallJsonRecord): RecallAbilityAssetRecord {
  if (
    typeof value.candidateId !== 'string' || typeof value.title !== 'string' ||
    typeof value.statement !== 'string' || !Array.isArray(value.evidenceRefs) ||
    typeof value.scope !== 'string' || typeof value.version !== 'string'
  ) throw new Error('malformed recall ability asset');
  const evidenceRefs = normalizeCognitionSourceRefs(value.evidenceRefs);
  if (!evidenceRefs.length && (value as { origin?: unknown }).origin !== 'manual') {
    throw new Error('malformed recall ability asset evidence');
  }
  const learningSignal = normalizeLearningSignal(value.learningSignal);
  const learningProvenance = normalizeLearningProvenance(value.learningProvenance);
  const causalRule = value.causalRule === undefined ? undefined : normalizeCausalRule(value.causalRule);
  const ontologyRefs = value.ontologyRefs === undefined ? undefined : normalizeAbilityAssetOntologyRefs(value.ontologyRefs);
  const relationContract = readAbilityAssetRelationContract(value, value.id);
  const scopePolicy = normalizeAbilityAssetScopePolicy(value.scopePolicy);
  return {
    ...value,
    reviewDecisionId: typeof value.reviewDecisionId === 'string' ? value.reviewDecisionId : 'legacy-untracked',
    lifecycleStatus: value.lifecycleStatus === 'automatically_extracted_unverified'
      || value.lifecycleStatus === 'system_precipitated_unverified'
      ? value.lifecycleStatus
      : 'user_confirmed_unverified',
    evidenceRefs,
    ...(learningSignal ? { learningSignal } : {}),
    ...(learningProvenance ? { learningProvenance } : {}),
    ...(causalRule ? { causalRule } : {}),
    ...(ontologyRefs ? { ontologyRefs } : {}),
    ...relationContract,
    ...(scopePolicy ? { scopePolicy } : {}),
  } as RecallAbilityAssetRecord;
}

function candidateDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, 'candidates', 'placeholder'));
}

function fingerprint(input: Pick<RecallCandidateRecord, 'judgment' | 'value' | 'suggestedType' | 'suggestedScope' | 'suggestedAction' | 'targetAssetId'>
  & Pick<RecallCandidateRecord, 'scopePolicy' | 'spaceId'>): string {
  const scopePolicy = scopePolicyIdentity(input.scopePolicy);
  return [input.judgment, input.value, input.suggestedType, input.suggestedScope, input.suggestedAction, input.targetAssetId || '']
    .map((part) => part.trim().toLocaleLowerCase())
    .concat([input.spaceId || '', scopePolicy])
    .join('\n');
}

/** Canonical identity for access boundaries. Semantic dedup may only join
 * records with the same boundary; otherwise a scoped candidate could silently
 * update or absorb a global / differently scoped record. */
function scopePolicyIdentity(value: unknown): string {
  const policy = normalizeAbilityAssetScopePolicy(value);
  if (!policy) return '';
  return JSON.stringify(Object.fromEntries(Object.entries(policy)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => [key, [...values].sort()])));
}

function mergeSourceRefs(left: CognitionSourceRef[], right: CognitionSourceRef[]): CognitionSourceRef[] {
  return normalizeCognitionSourceRefsForWrite([...left, ...right]);
}

function hasNewSourceRefs(existing: CognitionSourceRef[], incoming: CognitionSourceRef[]): boolean {
  const existingKeys = new Set(existing.map(cognitionSourceRefKey));
  return incoming.some((ref) => !existingKeys.has(cognitionSourceRefKey(ref)));
}

function maxCandidateRisk(left: RecallCandidateRisk, right: RecallCandidateRisk): RecallCandidateRisk {
  const rank: Record<RecallCandidateRisk, number> = { low: 0, medium: 1, high: 2 };
  return rank[left] >= rank[right] ? left : right;
}

function isCandidateContentReviewReady(candidate: Pick<
  RecallCandidateRecord,
  'value' | 'sourceRefs' | 'evidenceRefs' | 'suggestedScope' | 'suggestedAction' | 'targetAssetId'
>): boolean {
  return Boolean(candidate.value) && candidate.sourceRefs.length > 0 && candidate.evidenceRefs.length > 0
    && Boolean(candidate.suggestedScope)
    && (!candidateActionNeedsTarget(candidate.suggestedAction) || Boolean(candidate.targetAssetId));
}

function candidateActionNeedsTarget(action: RecallCandidateAction): boolean {
  return action === 'update' || action === 'limit_scope' || action === 'pause';
}

/**
 * 更新型候选（update / limit_scope / pause）的 suggestedType 必须取自目标资产。
 *
 * 确认/晋升时的守卫是硬拒绝——`target.type !== candidate.suggestedType` 抛
 * `candidate target asset type mismatch`。类型对不上，这条提案**永远确认不了**，
 * 用户只会看到 submit_failed：语义查重的融合与 KSTAR 的改进链都断在这里，而且
 * 断在用户点了确认之后，前面没有任何一步会提示。
 *
 * update 型候选的类型不是「推断出来的属性」，而是「它要改的那条资产的类型」。
 * 但三条生产路径各自独立决定类型（语义查重改写 / KSTAR drain 桥 / KSTAR 直通），
 * 它们都拿不到目标资产，所以各自在落候选前过一道这个口。读不到目标（已删除、
 * 不存在）时保持原样——让守卫如实拒绝，不在这里把它吞成静默。
 */
export async function alignUpdateCandidateType(
  userId: string,
  input: {
    suggestedType: RecallAbilityAssetRecord['type'];
    suggestedAction: RecallCandidateAction;
    targetAssetId?: string;
  },
): Promise<RecallAbilityAssetRecord['type']> {
  if (!input.targetAssetId || !candidateActionNeedsTarget(input.suggestedAction)) return input.suggestedType;
  try {
    const target = await readAbilityAsset(userId, input.targetAssetId);
    return target?.type ?? input.suggestedType;
  } catch {
    return input.suggestedType;
  }
}

function candidateIdForCaptureKey(captureKey: string): string {
  return `cand-${createHash('sha256').update(captureKey).digest('hex').slice(0, 24)}`;
}

export async function listRecallCandidates(userId: string): Promise<RecallCandidateRecord[]> {
  await migrateCandidateContentFormat(userId);
  let names: string[];
  try { names = await fs.readdir(candidateDirectory(userId)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const ids = names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map((name) => name.slice(0, -5));
  // 逐条降级，而不是让一条坏记录把整份候选池读失败。记录形状的不变量分布在
  // 两层——store 的 `validateRecallRecord` 和这里的 `asCandidate`——任一层一抛，
  // `recall.candidates.list` 就整体失败，「待我处理」和候选池同时清空，用户看到
  // 的是"我的候选全没了"。DTO 层（withRecallCandidateCapabilities）早就是这个
  // 口径：认不出的降级，而不是让读口炸掉。
  //
  // 只降级**记录形状**的错。真正的 IO 故障（EACCES / EISDIR……）带 errno code，
  // 照旧上抛：那种情况下静默少几条，等于把磁盘问题伪装成"候选变少了"。
  const reads = await Promise.all(ids.map(async (id) => {
    try {
      return { id, record: await readRecallJsonRecord(userId, 'candidates', id) };
    } catch (error) {
      if (typeof (error as NodeJS.ErrnoException).code === 'string') throw error;
      return { id, error: error as Error };
    }
  }));
  const candidates: RecallCandidateRecord[] = [];
  for (const read of reads) {
    if (read.error) {
      log.warn('skipped an unreadable recall candidate', { candidateId: read.id, error: read.error.message });
      continue;
    }
    if (!read.record) continue;
    try {
      candidates.push(asCandidate(read.record));
    } catch (error) {
      log.warn('skipped a malformed recall candidate', { candidateId: read.id, error: (error as Error).message });
    }
  }
  return candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** One-time, lossless migration for existing candidate JSON records. Old bubble
 * captures had their evidence explanation in `value`; asCandidate exposes it
 * separately so this pass can write the canonical fields without deleting text.
 * Each record is updated under its existing file lock; a marker is written only
 * after the full scan succeeds so an interrupted pass safely retries. */
async function migrateCandidateContentFormat(userId: string): Promise<void> {
  const migrationLockPath = recallJsonRecordPath(userId, 'candidate-locks', CANDIDATE_CONTENT_FORMAT_MIGRATION_ID);
  await fileEditLock(migrationLockPath).runExclusive(async () => {
    if (await readRecallJsonRecord(userId, 'candidate-migrations', CANDIDATE_CONTENT_FORMAT_MIGRATION_ID)) return;
    let names: string[];
    try { names = await fs.readdir(candidateDirectory(userId)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = [];
      else throw error;
    }
    const ids = names
      .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
      .map((name) => name.slice(0, -5));
    for (const id of ids) {
      try {
        const raw = await readRecallJsonRecord(userId, 'candidates', id);
        if (!raw) continue;
        const normalized = asCandidate(raw);
        const hasStoredValue = Object.prototype.hasOwnProperty.call(raw, 'value');
        const needsMigration = raw.contentFormatVersion !== 1
          || raw.taxonomyVersion !== 2
          || raw.summary !== normalized.summary
          || !hasStoredValue
          || raw.value !== normalized.value
          || !Array.isArray(raw.evidenceRefs);
        if (!needsMigration) continue;
        await updateRecallJsonRecord(userId, 'candidates', id, (current) => {
          if (!current) return normalized;
          return asCandidate(current);
        });
      } catch (error) {
        if (typeof (error as NodeJS.ErrnoException).code === 'string') throw error;
        log.warn('skipped an unmigratable recall candidate', {
          candidateId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await writeRecallJsonRecord(userId, 'candidate-migrations', CANDIDATE_CONTENT_FORMAT_MIGRATION_ID, {
      schemaVersion: 1,
      ownerId: userId,
      id: CANDIDATE_CONTENT_FORMAT_MIGRATION_ID,
      appliedAt: new Date().toISOString(),
    });
  });
}

export async function readRecallCandidate(userId: string, candidateId: string): Promise<RecallCandidateRecord> {
  const record = await readRecallJsonRecord(userId, 'candidates', candidateId);
  if (!record) throw recallCandidateError('recall_candidate_not_found', 'recall candidate not found');
  return asCandidate(record);
}

export async function importPersonalOntologyCandidate(userId: string, legacyCandidateId: string): Promise<RecallCandidateRecord> {
  if (!safeId(legacyCandidateId)) throw new Error('invalid personal ontology candidate id');
  const data = await personalOntologyCandidates.listCandidates(userId);
  const legacy = (data.candidate_updates || []).find((candidate) => candidate.candidate_id === legacyCandidateId);
  if (!legacy) throw new Error('personal ontology candidate not found');
  const suggestedType: AbilityAssetType = legacy.kind === 'preference' ? 'personal' : legacy.kind === 'rule' ? 'rule' : 'personal';
  return saveRecallCandidate(userId, {
    judgment: legacy.memory_text || legacy.summary,
    // 旧本体候选导入=历史原文搬运：豁免闸门。
    rawStatement: true,
    summary: legacy.summary,
    suggestedType,
    suggestedScope: legacy.memory_scope === 'user' ? 'global' : 'project',
    sourceRefs: legacy.source_memory_refs.map((id) => ({ kind: 'memory', id })),
  });
}

export async function saveRecallCandidate(userId: string, input: SaveRecallCandidateInput): Promise<RecallCandidateRecord> {
  // 入池正文闸门（2026-09-29 根治冗长正文）：机器生成线的不合规正文先经
  // suggestAbilityAssetStatement 改写（见 candidate-statement-gate.ts 头注）。
  // 必须在文件锁外——改写是 LLM 调用，锁内跑模型会阻塞整池写入。
  const gatedJudgment = await gateCandidateStatement(userId, {
    judgment: input.judgment,
    suggestedType: requireAssetType(input.suggestedType),
    skip: input.rawStatement === true || input.manual === true,
  });
  const gatedInput = gatedJudgment === input.judgment ? input : { ...input, judgment: gatedJudgment };
  const lockPath = recallJsonRecordPath(userId, 'candidate-locks', 'save');
  return fileEditLock(lockPath).runExclusive(() => saveRecallCandidateUnlocked(userId, gatedInput));
}

async function saveRecallCandidateUnlocked(userId: string, input: SaveRecallCandidateInput): Promise<RecallCandidateRecord> {
  const judgment = boundedText(input.judgment, 'judgment', 4_000, true)!;
  // value 上限与 judgment 对齐（2026-09-19）：value 缺省兜底改为 judgment 全文，
  // 1000 上限会把长 judgment 挡在门外（forecast-commit 实测抓出）。
  const value = boundedText(input.value, 'value', 4_000);
  const evidenceSummary = boundedText(input.evidenceSummary, 'evidence summary', 4_000);
  const summary = boundedText(input.summary, 'summary', 1_000) || fallbackCandidateTitle(judgment);
  const uncertainty = boundedText(input.uncertainty, 'uncertainty', 1_000);
  const suggestedScope = boundedText(input.suggestedScope, 'suggested scope', 500) || '';
  const scopePolicy = normalizeAbilityAssetScopePolicy(input.scopePolicy);
  const sourceRefs = normalizeCognitionSourceRefsForWrite(input.sourceRefs);
  const evidenceRefs = normalizeCognitionSourceRefsForWrite(input.evidenceRefs || input.sourceRefs);
  const suggestedType = requireAssetType(input.suggestedType);
  const hasExplicitValue = Object.prototype.hasOwnProperty.call(input, 'value');
  const hasExplicitAction = Object.prototype.hasOwnProperty.call(input, 'suggestedAction');
  const suggestedAction = requireCandidateAction(input.suggestedAction);
  const risk = requireCandidateRisk(input.risk);
  const learningSignal = normalizeLearningSignal(input.learningSignal);
  const learningProvenance = normalizeLearningProvenance(input.learningProvenance);
  assertNotForbiddenToPersist([
    judgment,
    value,
    evidenceSummary,
    summary,
    uncertainty,
    JSON.stringify(sourceRefs),
    JSON.stringify(evidenceRefs),
    learningSignal ? JSON.stringify(learningSignal) : undefined,
    learningProvenance ? JSON.stringify(learningProvenance) : undefined,
  ]);
  const captureKey = input.captureKey === undefined
    ? undefined
    : boundedText(input.captureKey, 'capture key', 160, true);
  const persistedOrigin = input.manual === true
    ? 'manual'
    : deriveCandidateOrigin(
      {
        captureKey,
        learningProvenance,
        sourceRefs,
      } as unknown as RecallJsonRecord,
      learningProvenance !== undefined,
    );
  if (captureKey && !safeId(captureKey)) throw new Error('invalid capture key');
  if (captureKey) {
    const captured = (await listRecallCandidates(userId)).find((candidate) => candidate.captureKey === captureKey);
    if (captured) return captured;
  }
  const now = new Date().toISOString();
  // value 缺省兜底用 judgment（正文）而不是 summary（标题）：标题残片拼进
  // 资产正文是实测过的污染（"可复用经验：数据的文档…"），而 value=judgment
  // 会被 promote 的防重检查挡掉，不进 statement——调用方从此不必被迫双存。
  const resolvedValue = hasExplicitValue ? (value || '') : judgment;
  const expiresAt = requireIsoTimestamp(input.expiresAt, 'candidate expiry', new Date(Date.parse(now) + DEFAULT_CANDIDATE_TTL_MS).toISOString());
  const taskRunId = input.taskRunId === undefined ? undefined : boundedText(input.taskRunId, 'task run id', 160, true);
  if (taskRunId && !safeId(taskRunId)) throw new Error('invalid task run id');
  const targetAssetId = input.targetAssetId === undefined ? undefined : boundedText(input.targetAssetId, 'target asset id', 160, true);
  if (targetAssetId && !safeId(targetAssetId)) throw new Error('invalid target asset id');
  const targetVersionUsed = input.targetVersionUsed === undefined ? undefined : boundedText(input.targetVersionUsed, 'target version used', 16, true);
  // 规则候选的适用/禁止范围：抽取阶段就带着走，否则自动线永远给不出边界，
  // 而 PRD 3.1 把边界列为 RuleAsset 的最低准入门槛，规则就再也晋升不了。
  // 走和资产同一套归一化，并过一遍敏感内容闸（这是自由文本）。
  const candidateBoundaries = readAbilityAssetSemantics({
    ...(input.applicableWhen ? { applicableWhen: input.applicableWhen } : {}),
    ...(input.forbiddenWhen ? { forbiddenWhen: input.forbiddenWhen } : {}),
  });
  assertNotForbiddenToPersist([
    ...(candidateBoundaries.applicableWhen || []),
    ...(candidateBoundaries.forbiddenWhen || []),
  ]);
  const candidateDraft = {
    judgment, value: resolvedValue, suggestedType, suggestedScope, suggestedAction, targetAssetId,
    ...(input.spaceId && safeId(input.spaceId) ? { spaceId: input.spaceId } : {}),
    ...(scopePolicy ? { scopePolicy } : {}),
  };
  const reviewReady = input.forceWeakObservation !== true
    && Boolean(resolvedValue)
    && (input.manual === true || (sourceRefs.length > 0 && evidenceRefs.length > 0))
    && Boolean(suggestedScope) && (hasExplicitAction || !hasExplicitValue)
    && (!candidateActionNeedsTarget(suggestedAction) || Boolean(targetAssetId));
  let existing = (await listRecallCandidates(userId)).find((candidate) => {
    if (fingerprint(candidate) !== fingerprint(candidateDraft)) return false;
    const hasNewEvidence = hasNewSourceRefs(candidate.evidenceRefs, evidenceRefs);
    const riskIncreased = maxCandidateRisk(candidate.risk, risk) !== candidate.risk;
    if (isSuppressedTerminalCandidate(candidate.status)) return !hasNewEvidence && !riskIncreased;
    if (candidate.status === 'confirmed') return !riskIncreased;
    return true;
  });
  if (existing?.status === 'confirmed' && existing.promotedAssetId) {
    const hasNewProvenance = hasNewSourceRefs(existing.sourceRefs, sourceRefs)
      || hasNewSourceRefs(existing.evidenceRefs, evidenceRefs);
    if (hasNewProvenance) {
      const asset = await readAbilityAsset(userId, existing.promotedAssetId);
      if (asset.status === 'revoked' || asset.status === 'purged') {
        existing = undefined;
      } else {
        await appendAssetEvidence(userId, asset, {
          ...existing,
          sourceRefs: mergeSourceRefs(existing.sourceRefs, sourceRefs),
          evidenceRefs: mergeSourceRefs(existing.evidenceRefs, evidenceRefs),
        });
      }
    }
  }
  if (existing) {
    const merged = await updateRecallJsonRecord(userId, 'candidates', existing.id, (current) => {
      if (!current) return existing;
      const candidate = asCandidate(current);
      const hasNewEvidence = hasNewSourceRefs(candidate.evidenceRefs, evidenceRefs);
      const riskIncreased = maxCandidateRisk(candidate.risk, risk) !== candidate.risk;
      const shouldReopen = (hasNewEvidence || riskIncreased) && (
        candidate.status === 'observed'
        || candidate.status === 'weak_observation'
        || candidate.status === 'deferred'
        || candidate.status === 'failed'
      );
      return {
        ...candidate,
        sourceRefs: mergeSourceRefs(candidate.sourceRefs, sourceRefs),
        evidenceRefs: mergeSourceRefs(candidate.evidenceRefs, evidenceRefs),
        risk: maxCandidateRisk(candidate.risk, risk),
        ...(candidateBoundaries.applicableWhen !== undefined
          ? { applicableWhen: candidateBoundaries.applicableWhen }
          : {}),
        ...(candidateBoundaries.forbiddenWhen !== undefined
          ? { forbiddenWhen: candidateBoundaries.forbiddenWhen }
          : {}),
        ...(shouldReopen ? {
          status: reviewReady ? 'pending_review' : 'weak_observation',
          cooldownUntil: undefined,
          failureCode: undefined,
          failureMessage: undefined,
          failedAt: undefined,
        } : {}),
        updatedAt: now,
      };
    });
    return asCandidate(merged);
  }
  const record: RecallCandidateRecord = {
    schemaVersion: 1,
    contentFormatVersion: 1,
    taxonomyVersion: 2,
    ownerId: userId,
    id: captureKey ? candidateIdForCaptureKey(captureKey) : `cand-${genId12()}`,
    status: reviewReady ? 'pending_review' : 'weak_observation',
    judgment,
    value: resolvedValue,
    summary,
    ...(evidenceSummary ? { evidenceSummary } : {}),
    ...(uncertainty ? { uncertainty } : {}),
    suggestedType,
    suggestedScope,
    sourceRefs,
    evidenceRefs,
    suggestedAction,
    risk,
    ...(candidateBoundaries.applicableWhen ? { applicableWhen: candidateBoundaries.applicableWhen } : {}),
    ...(candidateBoundaries.forbiddenWhen ? { forbiddenWhen: candidateBoundaries.forbiddenWhen } : {}),
    ...(learningSignal ? { learningSignal } : {}),
    ...(learningProvenance ? { learningProvenance } : {}),
    ...(captureKey ? { captureKey } : {}),
    // 写入侧显式落 origin（2026-09-19 归一化第二步）：新记录落盘即带统一
    // 来源标记，读时推导只服务旧记录；与推导规则同源（provenance > 前缀 >
    // 教学引用 > capture），两处规则由 deriveCandidateOrigin 单点维护。
    ...(persistedOrigin ? { origin: persistedOrigin } : {}),
    ...(input.spaceId && safeId(input.spaceId) ? { spaceId: input.spaceId } : {}),
    ...(scopePolicy ? { scopePolicy } : {}),
    ...(taskRunId ? { taskRunId } : {}),
    ...(targetAssetId ? { targetAssetId } : {}),
    ...(targetVersionUsed ? { targetVersionUsed } : {}),
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };
  if (captureKey) {
    return asCandidate(await updateRecallJsonRecord(
      userId,
      'candidates',
      record.id,
      (current) => current || record,
    ));
  }
  await writeRecallJsonRecord(userId, 'candidates', record.id, record);
  // 与 captureKey 路径同口径：返回前过 asCandidate，让 origin 等读时推导
  // 字段在两条路径上一致。
  return asCandidate(record as unknown as RecallJsonRecord);
}

/**
 * 更新候选时**新加进来的**证据引用必须能在来源目录里查到。
 *
 * 为什么必须在服务端拦：`normalizeCognitionSourceRef` 只校验形状（kind 在白名单、
 * id 过 safeId 的格式检查），`isCognitionSourceEnabled` 在查不到控制记录时默认
 * 放行——两者都不回答"这个来源真的存在吗"。而证据非空正是 reviewReady 与
 * `candidate-capabilities` 里 canPromote 的判据，于是编造一条 ref 就能把只读
 * 候选变成可晋升，并作为正式资产的证据链落库。渲染层已改成只读+可删（无法再
 * 手敲 id），但 `recall.candidates.update` 这个 IPC 通道对任何调用方都开着，
 * 所以真正的闸必须在这里。
 *
 * 只校验**新增**的：已在候选上的引用原样放行。旧记录可能指向已被删除的来源，
 * 那是既成事实，重新校验会让一批历史候选突然存不下去——那是数据迁移问题，
 * 不该由一次编辑来触发。
 */
async function assertResolvableNewSourceRefs(
  userId: string,
  current: RecallCandidateRecord,
  nextRefs: readonly CognitionSourceRef[],
): Promise<void> {
  const known = new Set([...(current.evidenceRefs || []), ...(current.sourceRefs || [])]
    .map((ref) => cognitionSourceRefKey(ref)));
  const added = nextRefs.filter((ref) => !known.has(cognitionSourceRefKey(ref)));
  if (!added.length) return;
  // 按 kind + id **精确**判定，不走列表窗口：`listCognitionSources` 的 limit 上限
  // 是 100 且在 adapter 内部截断，拿它当存在性判据会让来源超过 100 时合法的
  // 第 101 条被判成"不存在"——那是把展示分页伪装成真实性结论。
  const { cognitionExistingSourceIds } = await import('./source-catalog');
  // 按 kind 归并后再查：一个 kind 只枚举一次底层来源。逐条查会让新增 N 条
  // 同类引用时全量扫 N 遍。
  const byKind = new Map<CognitionSourceType, string[]>();
  for (const ref of added) {
    const kind = ref.kind as CognitionSourceType;
    byKind.set(kind, [...(byKind.get(kind) || []), ref.id]);
  }
  const existing = new Map<CognitionSourceType, Set<string>>();
  await Promise.all([...byKind].map(async ([kind, ids]) => {
    existing.set(kind, await cognitionExistingSourceIds(userId, kind, ids));
  }));
  const unknown = added.filter((ref) => !existing.get(ref.kind as CognitionSourceType)?.has(ref.id));
  if (unknown.length) {
    throw recallCandidateError(
      'recall_candidate_unknown_source',
      `evidence reference is not a known cognition source: ${unknown.map((ref) => `${ref.kind}:${ref.id}`).join(', ')}`,
    );
  }
}

export async function updateRecallCandidate(userId: string, candidateId: string, input: SaveRecallCandidateInput): Promise<RecallCandidateRecord> {
  const judgment = boundedText(input.judgment, 'judgment', 4_000, true)!;
  // value 上限与 judgment 对齐（2026-09-19）：value 缺省兜底改为 judgment 全文，
  // 1000 上限会把长 judgment 挡在门外（forecast-commit 实测抓出）。
  const value = boundedText(input.value, 'value', 4_000);
  const summary = boundedText(input.summary, 'summary', 1_000) || fallbackCandidateTitle(judgment);
  const uncertainty = boundedText(input.uncertainty, 'uncertainty', 1_000);
  const suggestedScope = boundedText(input.suggestedScope, 'suggested scope', 500) || '';
  const suggestedType = requireAssetType(input.suggestedType);
  const sourceRefs = normalizeCognitionSourceRefsForWrite(input.sourceRefs);
  const evidenceRefs = normalizeCognitionSourceRefsForWrite(input.evidenceRefs || input.sourceRefs);
  const currentCandidate = await readRecallCandidate(userId, candidateId);
  const evidenceSummary = input.evidenceSummary === undefined
    ? currentCandidate.evidenceSummary
    : boundedText(input.evidenceSummary, 'evidence summary', 4_000);
  const scopePolicy = input.scopePolicy === undefined
    ? currentCandidate.scopePolicy
    : normalizeAbilityAssetScopePolicy(input.scopePolicy);
  await assertResolvableNewSourceRefs(userId, currentCandidate, [...sourceRefs, ...evidenceRefs]);
  if (currentCandidate.status === 'failed' && currentCandidate.reviewDecisionId) {
    const appliedAsset = await readAppliedHandoffAsset(
      userId,
      currentCandidate,
      currentCandidate.reviewDecisionId,
    );
    if (appliedAsset) {
      throw recallCandidateError(
        'recall_candidate_handoff_incomplete',
        'candidate has an incomplete asset handoff; retry confirmation before editing',
      );
    }
  }
  const suggestedAction = input.suggestedAction === undefined
    ? currentCandidate.suggestedAction
    : requireCandidateAction(input.suggestedAction);
  const risk = input.risk === undefined ? currentCandidate.risk : requireCandidateRisk(input.risk);
  const learningSignal = normalizeLearningSignal(input.learningSignal);
  const learningProvenance = normalizeLearningProvenance(input.learningProvenance);
  const candidateBoundaries = readAbilityAssetSemantics({
    ...(input.applicableWhen !== undefined ? { applicableWhen: input.applicableWhen } : {}),
    ...(input.forbiddenWhen !== undefined ? { forbiddenWhen: input.forbiddenWhen } : {}),
  });
  assertNotForbiddenToPersist([
    judgment,
    value,
    evidenceSummary,
    summary,
    uncertainty,
    JSON.stringify(sourceRefs),
    JSON.stringify(evidenceRefs),
    learningSignal ? JSON.stringify(learningSignal) : undefined,
    learningProvenance ? JSON.stringify(learningProvenance) : undefined,
    ...(candidateBoundaries.applicableWhen || []),
    ...(candidateBoundaries.forbiddenWhen || []),
  ]);
  const duplicates = await listRecallCandidates(userId);
  const hasExplicitValue = Object.prototype.hasOwnProperty.call(input, 'value');
  const resolvedValue = hasExplicitValue ? (value || '') : (currentCandidate.value && currentCandidate.value !== currentCandidate.judgment ? currentCandidate.value : judgment);
  const expiresAt = input.expiresAt === undefined
    ? currentCandidate.expiresAt
    : requireIsoTimestamp(input.expiresAt, 'candidate expiry');
  const taskRunId = input.taskRunId === undefined
    ? currentCandidate.taskRunId
    : boundedText(input.taskRunId, 'task run id', 160, true);
  if (taskRunId && !safeId(taskRunId)) throw new Error('invalid task run id');
  const targetAssetId = input.targetAssetId === undefined
    ? currentCandidate.targetAssetId
    : boundedText(input.targetAssetId, 'target asset id', 160, true);
  if (targetAssetId && !safeId(targetAssetId)) throw new Error('invalid target asset id');
  const nextFingerprint = fingerprint({
    judgment, value: resolvedValue, suggestedType, suggestedScope, suggestedAction, targetAssetId,
    spaceId: currentCandidate.spaceId,
    ...(scopePolicy ? { scopePolicy } : {}),
  });
  if (duplicates.some((candidate) => candidate.id !== candidateId && fingerprint(candidate) === nextFingerprint)) {
    throw recallCandidateError('recall_candidate_duplicate', 'duplicate recall candidate');
  }
  // 编辑后的**新内容**够不够格成为正式资产。跑的是晋升时那一个闸门，
  // actor 取 'user'——与 candidate-capabilities 和真实确认路径同源。
  // 冲突类型按编辑后的文本重算：改了 judgment 可能制造新冲突，也可能解掉旧的。
  const editedForConflicts: RecallCandidateRecord = {
    ...currentCandidate, judgment, suggestedType, status: currentCandidate.status,
  };
  const conflictScan = recallCandidateConflictingTypes([
    editedForConflicts,
    ...duplicates.filter((candidate) => candidate.id !== candidateId),
  ]);
  const promotionEligible = validatePromotionByAssetType({
    judgment,
    value: resolvedValue,
    ...(summary ? { summary } : {}),
    suggestedType,
    suggestedScope,
    suggestedAction,
    ...(candidateBoundaries.applicableWhen ? { applicableWhen: candidateBoundaries.applicableWhen } : {}),
    ...(candidateBoundaries.forbiddenWhen ? { forbiddenWhen: candidateBoundaries.forbiddenWhen } : {}),
    ...(conflictScan.get(candidateId)?.length ? { conflictingTypes: conflictScan.get(candidateId)! } : {}),
  }, { actor: 'user' }).ok;
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, (raw) => {
    if (!raw) throw new Error('recall candidate not found');
    const current = asCandidate(raw);
    if (isTerminalCandidate(current.status)) {
      throw new RecallCandidateStateError(RECALL_CANDIDATE_TERMINAL_ERROR_CODE, 'recall candidate is terminal', current.status);
    }
    // 字段齐全 **且** 内容过得了正式资产准入门槛，才允许迁到 pending_review。
    //
    // 少了后半句就是"洗白"：抽取期因为分类不合格被 forceWeakObservation 压成
    // weak_observation 的候选，用户随手改一个 summary 就会变成 pending_review，
    // 状态标签从「证据较弱」跳成「待确认」，看起来像修好了——而晋升闸门会用
    // 同一套判据再拒一次。`forceWeakObservation` 只作用于 saveRecallCandidate，
    // 编辑路径此前没有对应项。
    //
    // 反过来也成立：用户真把内容改成一条合格的长期偏好，这里就会放它进
    // pending_review，确认按钮自己回来。
    const reviewReady = Boolean(resolvedValue) && sourceRefs.length > 0 && evidenceRefs.length > 0
      && Boolean(suggestedScope) && (!candidateActionNeedsTarget(suggestedAction) || Boolean(targetAssetId))
      && promotionEligible;
    const now = new Date().toISOString();
    return {
      ...current,
      contentFormatVersion: 1,
      judgment,
      value: resolvedValue,
      ...(evidenceSummary ? { evidenceSummary } : {}),
      ...(summary ? { summary } : {}),
      ...(uncertainty ? { uncertainty } : {}),
      suggestedType,
      suggestedScope,
      sourceRefs,
      evidenceRefs,
      suggestedAction,
      risk,
      ...candidateBoundaries,
      ...(scopePolicy ? { scopePolicy } : { scopePolicy: undefined }),
      expiresAt,
      ...(taskRunId ? { taskRunId } : {}),
      ...(targetAssetId ? { targetAssetId } : {}),
      status: reviewReady ? 'pending_review' : 'weak_observation',
      failureCode: undefined,
      failureMessage: undefined,
      failedAt: undefined,
      promotedAssetId: undefined,
      reviewDecisionId: undefined,
      promotionErrorCode: undefined,
      promotionErrorMessage: undefined,
      promotionFailedAt: undefined,
      userModifiedAt: now,
      ...(learningSignal ? { learningSignal } : current.learningSignal ? { learningSignal: current.learningSignal } : {}),
      ...(learningProvenance ? { learningProvenance } : current.learningProvenance ? { learningProvenance: current.learningProvenance } : {}),
      updatedAt: now,
    };
  });
  return asCandidate(updated);
}

/** Record an independent execution outcome without changing the candidate's
 * lifecycle. Promotion and asset governance remain responsible for status;
 * this counter is only the evidence ledger used to decide maturity or pause. */
export async function recordRecallCandidateValidation(
  userId: string,
  candidateId: string,
  outcome: 'success' | 'failure',
  validationId?: string,
): Promise<RecallCandidateRecord> {
  if (!safeId(candidateId)) throw new Error('invalid candidate id');
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, (current) => {
    if (!current) throw new Error('recall candidate not found');
    const candidate = asCandidate(current);
    const appliedValidationIds = Array.isArray(candidate.appliedValidationIds)
      ? candidate.appliedValidationIds
      : [];
    if (validationId && appliedValidationIds.includes(validationId)) return candidate;
    const now = new Date().toISOString();
    return {
      ...candidate,
      validationCount: (candidate.validationCount || 0) + (outcome === 'success' ? 1 : 0),
      ...(outcome === 'success' ? { lastValidatedAt: now, consecutiveFailures: 0 } : { consecutiveFailures: (candidate.consecutiveFailures || 0) + 1 }),
      ...(validationId ? { appliedValidationIds: [...new Set([...appliedValidationIds, validationId])] } : {}),
      updatedAt: now,
    };
  });
  return asCandidate(updated);
}

export function deferRecallCandidate(userId: string, candidateId: string, note?: string): Promise<RecallCandidateRecord> {
  return decideWithoutAsset(userId, candidateId, 'defer', 'deferred', note);
}

export async function resumeRecallCandidate(userId: string, candidateId: string): Promise<RecallCandidateRecord> {
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, (current) => {
    if (!current) throw new Error('recall candidate not found');
    const storedStatus = normalizeCandidateStatus(current.status);
    const candidate = asCandidate(current);
    if (isTerminalCandidate(storedStatus)) {
      throw new RecallCandidateStateError(RECALL_CANDIDATE_TERMINAL_ERROR_CODE, 'recall candidate is terminal', storedStatus);
    }
    if (storedStatus !== 'deferred') throw new Error('only a deferred recall candidate can be resumed');
    if (!isCandidateContentReviewReady(candidate)) throw new Error('candidate evidence is insufficient for review');
    return {
      ...candidate,
      status: 'pending_review',
      cooldownUntil: undefined,
      updatedAt: new Date().toISOString(),
    };
  });
  return asCandidate(updated);
}

export function rejectRecallCandidate(userId: string, candidateId: string, note?: string): Promise<RecallCandidateRecord> {
  return decideWithoutAsset(userId, candidateId, 'reject', 'rejected', note);
}

export function ignoreRecallCandidate(userId: string, candidateId: string, note?: string): Promise<RecallCandidateRecord> {
  return decideWithoutAsset(userId, candidateId, 'ignore', 'ignored', note);
}

export function keepCurrentRecallCandidate(userId: string, candidateId: string, note?: string): Promise<RecallCandidateRecord> {
  return decideWithoutAsset(userId, candidateId, 'keep_current', 'ignored', note);
}

async function decideWithoutAsset(
  userId: string,
  candidateId: string,
  decisionType: 'defer' | 'reject' | 'ignore' | 'keep_current',
  status: 'deferred' | 'rejected' | 'ignored',
  note?: string,
  actor: ReviewDecisionActor = 'user',
): Promise<RecallCandidateRecord> {
  const decisionNote = boundedText(note, 'decision note', 1_000);
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, async (current) => {
    if (!current) throw new Error('recall candidate not found');
    const candidate = asCandidate(current);
    if (isTerminalCandidate(candidate.status)) return candidate;
    // 同上：拒绝 / 稍后 / 忽略 是用户对一条弱候选最基本的处置权，不能因为
    // 证据弱就把它锁死在待办里。系统 actor 仍然不许替用户下这个决定，
    // refs 为空的候选也仍然出不去（否则写出的记录读不回来）。
    if ((candidate.status === 'observed' || candidate.status === 'weak_observation')
      && (actor !== 'user' || !getRecallCandidateCapabilities(candidate).canReject)) {
      throw new Error('candidate evidence is insufficient for review');
    }
    await writeReviewDecision(userId, {
      targetRef: `recall_candidate:${candidate.id}`,
      decisionType,
      decision: decisionType,
      antecedentRef: candidate.id,
      scope: candidate.suggestedScope,
      reason: decisionNote,
      actor,
      idempotencyKey: `${decisionType}-${candidate.updatedAt}`,
    });
    return {
      ...candidate,
      status,
      ...(decisionNote ? { decisionNote } : {}),
      ...(status === 'deferred'
        ? { cooldownUntil: new Date(Date.now() + DEFAULT_DEFER_COOLDOWN_MS).toISOString() }
        : { cooldownUntil: undefined }),
      updatedAt: new Date().toISOString(),
    };
  });
  return asCandidate(updated);
}

/** Apply an extracted candidate under the user's automatic-capture policy. */
export async function autoApplyRecallCandidate(
  userId: string,
  candidateId: string,
  opts: { semanticDedup?: boolean; provenance?: RecallPromotionProvenance } = {},
): Promise<{
  candidate: RecallCandidateRecord;
  asset?: RecallAbilityAssetRecord;
  mergedIntoAssetId?: string;
  mergedIntoCandidateId?: string;
  updateCandidate?: RecallCandidateRecord;
}> {
  // 两条系统线共用这个出口，来源要一路带到 lifecycleStatus，否则 KStar
  // 自进化沉淀会被记成会话自动抽取。缺省按 capture 线处理。
  const provenance: RecallPromotionProvenance = opts.provenance || 'capture';
  const candidate = await readRecallCandidate(userId, candidateId);
  const policy = evaluatePromotionPolicy(candidate);
  if (policy.action === 'pause') throw new PromotionPausedError(policy.reason);
  if (candidate.status === 'confirmed') {
    try {
      const promoted = await promoteRecallCandidate(userId, candidate.id, { actor: 'system', provenance });
      return { candidate: promoted.candidate, asset: promoted.asset };
    } catch (error) {
      const retryable = await readRecallCandidate(userId, candidate.id);
      if (retryable.status !== 'failed') throw error;
      const recovered = await promoteRecallCandidate(userId, retryable.id, { actor: 'system', provenance });
      return { candidate: recovered.candidate, asset: recovered.asset };
    }
  }
  if (!isAutoCaptureEligible(candidate)) throw new Error('candidate is not ready for automatic capture');
  if (candidate.risk === 'high') {
    throw new Error('high-risk candidate requires an independent user risk gate');
  }
  // N-2: 语义复核（模型级，SEMANTIC_RULES 闭集）。自动晋升是无人审阅的
  // 路径，语义发现（越权改写/敏感个人信息/疑似凭据/越界声称）应把候选
  // 留给用户决定，而不是静默晋升。复核失败（模型不可用）不阻断——退化
  // 为纯确定性闸（现状），只记一条警告。这里复用 review-decision 的
  // defer 语义，候选以 deferred 状态留在池里等用户。
  try {
    const { reviewCandidateSemantically } = await import('../cognition/semantic-review');
    const reviewed = await reviewCandidateSemantically(userId, {
      title: candidate.summary,
      summary: candidate.value,
      body: candidate.judgment,
    });
    if (reviewed.ok && reviewed.findings.some((finding) => finding.level !== 'LOW')) {
      const { writeReviewDecision } = await import('../cognition/review-decision');
      await writeReviewDecision(userId, {
        targetRef: `recall_candidate:${candidate.id}`,
        decisionType: 'defer',
        decision: 'semantic review flag',
        antecedentRef: candidate.id,
        scope: candidate.suggestedScope,
        reason: `Semantic review flagged ${reviewed.findings.map((finding) => finding.rule).join(', ')}; kept for user decision.`,
        actor: 'system',
      }).catch(() => undefined);
      await updateRecallJsonRecord(userId, 'candidates', candidate.id, (current) => {
        if (!current) return undefined;
        return {
          ...current,
          status: 'deferred',
          failureCode: 'semantic_review_flagged',
          failureMessage: `Semantic review flagged: ${reviewed.findings.map((finding) => finding.rule).join(', ')}`,
          updatedAt: new Date().toISOString(),
        };
      });
      log.info('recall candidate deferred by semantic review', {
        candidateId: candidate.id,
        rules: reviewed.findings.map((finding) => finding.rule),
      });
      return { candidate: await readRecallCandidate(userId, candidate.id) };
    }
  } catch (error) {
    log.warn('recall candidate semantic review degraded; proceeding with deterministic gate', {
      candidateId: candidate.id,
      error: (error as Error).message,
    });
  }
  // 晋升前资产语义查重 + 质量融合（设计 §4.7/§4.9）。默认开启；查重不可用时
  // semanticDedupBeforePromote 抛 SemanticDedupUnavailableError，自动晋升中止。
  if (opts.semanticDedup !== false) {
    const deduped = await semanticDedupBeforePromote(userId, candidate);
    if (deduped) return deduped;
  }
  const reason = 'automatic capture policy';
  if (candidate.suggestedAction === 'reject') {
    return { candidate: await decideWithoutAsset(userId, candidate.id, 'reject', 'rejected', reason, 'system') };
  }
  if (candidate.suggestedAction === 'keep_current') {
    return { candidate: await decideWithoutAsset(userId, candidate.id, 'keep_current', 'ignored', reason, 'system') };
  }
  const promoted = await promoteRecallCandidate(userId, candidate.id, {
    actor: 'system',
    provenance,
    decisionType: 'accept',
    decisionReason: reason,
  });
  return { candidate: promoted.candidate, asset: promoted.asset };
}

/** 语义查重辅助：加载候选池 + 资产库的可比文本。
 *  `findSemanticDuplicate` 在 similarity.ts；本函数负责装配输入。 */
async function loadDedupPools(userId: string): Promise<{
  candidateTexts: Array<{ id: string; text: string; scopePolicy?: RecallAbilityAssetScopePolicy }>;
  assetTexts: Array<{ id: string; text: string; scopePolicy?: RecallAbilityAssetScopePolicy }>;
}> {
  const [candidates, assets] = await Promise.all([
    listRecallCandidates(userId).catch(() => [] as RecallCandidateRecord[]),
    import('./asset-service').then((m) => m.listAbilityAssets(userId)).catch(() => [] as RecallAbilityAssetRecord[]),
  ]);
  return {
    // 查重池 = 非终态候选。和用户侧 capability 是两个问题，但共用同一份
    // terminal policy，免得再长出第三套状态清单。
    candidateTexts: candidates
      .filter((c) => !isTerminalCandidate(c.status))
      .map((c) => ({ id: c.id, text: String(c.judgment || ''), ...(c.scopePolicy ? { scopePolicy: c.scopePolicy } : {}) })),
    assetTexts: assets
      .filter((a) => a.status !== 'deleted' && a.status !== 'purged' && a.status !== 'revoked')
      .map((a) => ({ id: a.id, text: String(a.statement || a.title || ''), ...(a.scopePolicy ? { scopePolicy: a.scopePolicy } : {}) })),
  };
}

/** 把候选改写为"更新目标资产"形态（L1 重复命中与 L2 质量更优共用）。
 *  不直接改资产——update 候选仍要过确认闸门，由融合路径合成新版本。 */
async function rewriteCandidateAsAssetUpdate(
  userId: string,
  candidate: RecallCandidateRecord,
  asset: RecallAbilityAssetRecord,
): Promise<RecallCandidateRecord> {
  const updateCandidate = await updateRecallCandidate(userId, candidate.id, {
    judgment: candidate.judgment,
    value: candidate.value,
    summary: candidate.summary,
    uncertainty: candidate.uncertainty,
    // 更新的是 asset 这条资产，类型跟着目标走（与下面 applicableWhen /
    // forbiddenWhen 同样的继承口径）。用候选自带的类型会在确认守卫处撞上
    // type mismatch，这条融合路径就永远走不完。
    suggestedType: asset.type,
    suggestedScope: candidate.suggestedScope,
    suggestedAction: 'update',
    risk: candidate.risk,
    targetAssetId: asset.id,
    sourceRefs: candidate.sourceRefs,
    evidenceRefs: candidate.evidenceRefs,
    expiresAt: candidate.expiresAt,
    taskRunId: candidate.taskRunId,
    ...(candidate.applicableWhen !== undefined
      ? { applicableWhen: candidate.applicableWhen }
      : asset.applicableWhen !== undefined ? { applicableWhen: asset.applicableWhen } : {}),
    ...(candidate.forbiddenWhen !== undefined
      ? { forbiddenWhen: candidate.forbiddenWhen }
      : asset.forbiddenWhen !== undefined ? { forbiddenWhen: asset.forbiddenWhen } : {}),
  });
  await updateRecallJsonRecord(userId, 'candidates', candidate.id, (current) => ({
    ...(current || updateCandidate),
    mergedIntoAssetId: asset.id,
  }));
  return readRecallCandidate(userId, candidate.id);
}

/** 晋升前资产语义查重（设计 §4.7/§4.9 ＋ 2026-09-19 查重金字塔 L2）。
 *  返回 null 表示无语义重复 → 调用方继续正常 promote。
 *  命中正式资产时只生成 update 候选，不能在没有 ReviewDecision 和交接回执的
 *  情况下直接改资产；命中候选时合并证据并正常结束重复候选。 */
async function semanticDedupBeforePromote(
  userId: string,
  candidate: RecallCandidateRecord,
): Promise<{
  candidate: RecallCandidateRecord;
  asset?: RecallAbilityAssetRecord;
  mergedIntoAssetId?: string;
  mergedIntoCandidateId?: string;
  updateCandidate?: RecallCandidateRecord;
} | null> {
  const { findSemanticDuplicate, assetQualityScore, QUALITY_GAP } = await import('./similarity');
  const pools = await loadDedupPools(userId);
  const scopeIdentity = scopePolicyIdentity(candidate.scopePolicy);
  const outcome = await findSemanticDuplicate(userId, {
    text: String(candidate.judgment || ''),
    candidateTexts: pools.candidateTexts
      .filter((c) => c.id !== candidate.id && scopePolicyIdentity(c.scopePolicy) === scopeIdentity)
      .map(({ id, text }) => ({ id, text })),
    assetTexts: pools.assetTexts
      .filter((asset) => scopePolicyIdentity(asset.scopePolicy) === scopeIdentity)
      .map(({ id, text }) => ({ id, text })),
    excludeIds: new Set([candidate.id]),
  });
  // 查重没做成 ≠ 没有重复。embedding 不可用时不能当作"查过且干净"继续晋升，
  // 否则两条沉淀线会无声地各写一条讲同一件事的正式资产（指纹拦不住，两边
  // judgment 文本几乎从不逐字相同）。这里抛错，让自动线把候选留在池子里等
  // 人工确认；用户手动确认的晋升路径不经过这里，不受影响。
  if (outcome.status === 'degraded') {
    throw new SemanticDedupUnavailableError(outcome.reason);
  }
  if (outcome.status === 'no_match') {
    // L2 相关层（查重金字塔）：0.70–0.85 的相关资产不是重复，但当新内容
    // 质量显著更优（差 ≥ QUALITY_GAP）时，它的增量值得并入旧资产——走与
    // 重复命中相同的 update 候选路径，由确认闸门与融合生成器合成新版本，
    // 而不是放任新开一条讲相关事情的零散资产。差距不足的相关命中留给 L3
    // 归族，此轮放行。
    const related = outcome.related;
    if (related?.kind === 'asset') {
      const relatedAsset = await readAbilityAssetSafe(userId, related.id);
      if (relatedAsset) {
        const now = Date.now();
        const candidateScore = assetQualityScore({
          text: String(candidate.judgment || ''),
          id: candidate.id,
          kind: 'candidate',
          evidenceCount: (candidate.evidenceRefs || []).length,
          sourceKinds: new Set((candidate.evidenceRefs || []).map((ref) => ref.kind)),
          ageMs: now - Date.parse(candidate.createdAt || ''),
          risk: candidate.risk,
          structureBonus: Boolean(candidate.applicableWhen?.length || candidate.forbiddenWhen?.length),
        });
        const assetScore = assetQualityScore({
          text: String(relatedAsset.statement || relatedAsset.title || ''),
          id: relatedAsset.id,
          kind: 'asset',
          evidenceCount: (relatedAsset.evidenceRefs || []).length,
          sourceKinds: new Set((relatedAsset.evidenceRefs || []).map((ref) => ref.kind)),
          ageMs: now - Date.parse(relatedAsset.updatedAt || ''),
          maturity: relatedAsset.maturity,
          structureBonus: Boolean(relatedAsset.applicableWhen?.length || relatedAsset.forbiddenWhen?.length),
        });
        if (candidateScore - assetScore >= QUALITY_GAP) {
          const linked = await rewriteCandidateAsAssetUpdate(userId, candidate, relatedAsset);
          return { candidate: linked, updateCandidate: linked, mergedIntoAssetId: relatedAsset.id };
        }
      }
    }
    return null;
  }
  const match = outcome.match;
  if (match.kind === 'asset') {
    const asset = await readAbilityAssetSafe(userId, match.id);
    if (!asset) return null;
    const linked = await rewriteCandidateAsAssetUpdate(userId, candidate, asset);
    return { candidate: linked, updateCandidate: linked, mergedIntoAssetId: asset.id };
  }
  // 命中候选：证据并入已有候选（语义合并），候选标记 mergedInto
  const existingCandidate = await readRecallCandidate(userId, match.id).catch(() => undefined);
  if (existingCandidate) {
    const merged = await updateRecallJsonRecord(userId, 'candidates', existingCandidate.id, (current) => {
      const cur = current ? asCandidate(current) : existingCandidate;
      const mergedSources = mergeSourceRefs(cur.sourceRefs || [], candidate.sourceRefs || []);
      const mergedEvidence = mergeSourceRefs(cur.evidenceRefs || [], candidate.evidenceRefs || []);
      const upgraded = cur.status === 'weak_observation' || cur.status === 'observed' ? 'pending_review' : cur.status;
      return { ...cur, evidenceRefs: mergedEvidence, sourceRefs: mergedSources, status: upgraded };
    });
    await updateRecallJsonRecord(userId, 'candidates', candidate.id, (current) => {
      const cur = current ? asCandidate(current) : candidate;
      return { ...cur, mergedInto: existingCandidate.id };
    });
    const ignored = await decideWithoutAsset(
      userId,
      candidate.id,
      'ignore',
      'ignored',
      `semantic duplicate of candidate ${existingCandidate.id}`,
      'system',
    );
    return {
      candidate: ignored,
      mergedIntoCandidateId: asCandidate(merged).id,
      // Compatibility for callers that historically collected every dedup
      // target in one list. New code should prefer mergedIntoCandidateId.
      mergedIntoAssetId: existingCandidate.id,
    };
  }
  return null;
}

async function readAbilityAssetSafe(userId: string, assetId: string): Promise<RecallAbilityAssetRecord | undefined> {
  try {
    const { readAbilityAsset } = await import('./asset-service');
    return await readAbilityAsset(userId, assetId);
  } catch {
    return undefined;
  }
}

/** 证据并入资产：内容变化时 bump 版本 + 快照 + 审计（走 asset-service 的
 *  导出边界，旧实现不 bump 版本导致冻结快照与实时 evidenceRefs 分叉）。 */
async function appendAssetEvidence(
  userId: string,
  asset: RecallAbilityAssetRecord,
  candidate: RecallCandidateRecord,
): Promise<RecallAbilityAssetRecord> {
  const { mergeAbilityAssetEvidence } = await import('./asset-service');
  return mergeAbilityAssetEvidence(userId, asset.id, candidate.evidenceRefs || [], {
    reason: 'evidence merged from candidate dedup',
    actor: 'system',
    sourceSessionIds: sourceSessionIdsFrom(candidate.sourceRefs || []),
  });
}

export async function batchPromoteRecallCandidates(
  userId: string,
  candidateIds: string[],
): Promise<{ succeeded: Array<{ candidateId: string; assetId: string; reviewDecisionId: string }>; failed: Array<{ candidateId: string; error: string }> }> {
  const succeeded: Array<{ candidateId: string; assetId: string; reviewDecisionId: string }> = [];
  const failed: Array<{ candidateId: string; error: string }> = [];
  for (const candidateId of [...new Set(candidateIds)]) {
    try {
      const candidate = await readRecallCandidate(userId, candidateId);
      // 用户批量晋升的准入 = 用户侧 capability，不是 pending_review 单点。
      // 只认 pending_review 会让实机上占多数的 weak_observation 全部落空。
      if (!getRecallCandidateCapabilities(candidate).canPromote) {
        failed.push({ candidateId, error: RECALL_CANDIDATE_NOT_PROMOTABLE_ERROR_CODE });
        continue;
      }
      const result = await promoteRecallCandidate(userId, candidateId, { actor: 'user' });
      succeeded.push({ candidateId, assetId: result.asset.id, reviewDecisionId: result.decision.decision_id });
    } catch (error) {
      failed.push({ candidateId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { succeeded, failed };
}

async function unavailableCandidateSources(
  userId: string,
  refs: CognitionSourceRef[],
): Promise<CognitionSourceRef[]> {
  const checks = await Promise.all(refs.map(async (ref) => {
    if (ref.taxonomyVersion !== 2) return undefined;
    const enabled = await isCognitionSourceEnabled(userId, {
      kind: ref.kind as CognitionSourceType,
      id: ref.id,
    });
    return enabled ? undefined : ref;
  }));
  return checks.filter((ref): ref is CognitionSourceRef => Boolean(ref));
}

function confirmationIdempotencyKey(candidate: RecallCandidateRecord): string {
  return `confirm-${createHash('sha256').update(JSON.stringify({
    candidateId: candidate.id,
    judgment: candidate.judgment,
    value: candidate.value,
    type: candidate.suggestedType,
    scope: candidate.suggestedScope,
    action: candidate.suggestedAction,
    targetAssetId: candidate.targetAssetId,
    evidence: candidate.evidenceRefs.map(cognitionSourceRefKey).sort(),
  })).digest('hex').slice(0, 32)}`;
}

function createdAssetId(candidateId: string, reviewDecisionId: string): string {
  return `aa-${createHash('sha256').update(`${candidateId}\n${reviewDecisionId}`).digest('hex').slice(0, 24)}`;
}

async function readAppliedHandoffAsset(
  userId: string,
  candidate: RecallCandidateRecord,
  reviewDecisionId: string,
): Promise<RecallAbilityAssetRecord | undefined> {
  const assetId = candidate.suggestedAction === 'create'
    ? createdAssetId(candidate.id, reviewDecisionId)
    : candidate.targetAssetId || candidate.promotedAssetId;
  if (!assetId) return undefined;
  let asset: RecallAbilityAssetRecord;
  try {
    asset = await readAbilityAsset(userId, assetId);
  } catch {
    return undefined;
  }
  const belongsToCandidate = asset.candidateId === candidate.id
    || asset.sourceCandidateIds?.includes(candidate.id);
  if (!belongsToCandidate) return undefined;
  if (candidate.suggestedAction === 'create') {
    return asset.reviewDecisionId === reviewDecisionId ? asset : undefined;
  }
  return asset.reviewDecisionId === reviewDecisionId
    || asset.appliedReviewDecisionIds?.includes(reviewDecisionId)
    ? asset
    : undefined;
}

function handoffReceipt(
  asset: RecallAbilityAssetRecord,
  reviewDecisionId = asset.reviewDecisionId,
): RecallAssetHandoffReceipt {
  return {
    assetId: asset.id,
    assetType: asset.type,
    version: asset.version,
    lifecycleStatus: asset.lifecycleStatus,
    scope: asset.scope,
    sourceRefs: asset.evidenceRefs,
    reviewDecisionId,
  };
}

function handoffReceiptId(candidateId: string, reviewDecisionId: string): string {
  return `handoff-${createHash('sha256').update(`${candidateId}\n${reviewDecisionId}`).digest('hex').slice(0, 24)}`;
}

function asStoredHandoffReceipt(
  value: RecallJsonRecord,
  candidateId: string,
  reviewDecisionId: string,
): StoredRecallAssetHandoffReceipt {
  if (
    value.candidateId !== candidateId
    || value.reviewDecisionId !== reviewDecisionId
    || typeof value.assetId !== 'string'
    || !safeId(value.assetId)
    || typeof value.version !== 'string'
    || !value.version.trim()
    || typeof value.scope !== 'string'
    || !value.scope.trim()
    || !Array.isArray(value.sourceRefs)
    || typeof value.createdAt !== 'string'
  ) throw new Error('malformed recall asset handoff receipt');
  const sourceRefs = normalizeCognitionSourceRefs(value.sourceRefs);
  // 空 sourceRefs 的回执只可能来自手动候选（「记一条」豁免，2026-09-28）：
  // 该豁免之前空证据根本晋升不到这一步，不存在历史脏数据需要拦截。
  return {
    ...value,
    candidateId,
    reviewDecisionId,
    assetId: value.assetId,
    assetType: requireAssetType(value.assetType),
    lifecycleStatus: requireAssetLifecycleStatus(value.lifecycleStatus),
    version: value.version.trim(),
    scope: value.scope.trim(),
    sourceRefs,
    createdAt: requireIsoTimestamp(value.createdAt, 'handoff receipt created at'),
  } as StoredRecallAssetHandoffReceipt;
}

export async function readRecallAssetHandoffReceipt(
  userId: string,
  candidateId: string,
  reviewDecisionId: string,
): Promise<RecallAssetHandoffReceipt | undefined> {
  if (!safeId(candidateId) || !/^rd_[A-Za-z0-9_-]{8,64}$/.test(reviewDecisionId)) {
    throw new Error('invalid recall asset handoff receipt identity');
  }
  const stored = await readRecallJsonRecord(
    userId,
    'asset-handoff-receipts',
    handoffReceiptId(candidateId, reviewDecisionId),
  );
  let receipt: StoredRecallAssetHandoffReceipt;
  if (stored) {
    receipt = asStoredHandoffReceipt(stored, candidateId, reviewDecisionId);
  } else {
    const candidateRecord = await readRecallJsonRecord(userId, 'candidates', candidateId);
    if (!candidateRecord) return undefined;
    const candidate = asCandidate(candidateRecord);
    if (
      candidate.status !== 'confirmed'
      || candidate.reviewDecisionId !== reviewDecisionId
      || !candidate.promotedAssetId
    ) return undefined;
    const assetRecord = await readRecallJsonRecord(userId, 'ability-assets', candidate.promotedAssetId);
    if (!assetRecord) return undefined;
    return recoverHandoffReceipt(userId, candidate, reviewDecisionId, asAsset(assetRecord));
  }
  return {
    assetId: receipt.assetId,
    assetType: receipt.assetType,
    version: receipt.version,
    lifecycleStatus: receipt.lifecycleStatus,
    scope: receipt.scope,
    sourceRefs: receipt.sourceRefs,
    reviewDecisionId: receipt.reviewDecisionId,
  };
}

async function persistHandoffReceipt(
  userId: string,
  candidateId: string,
  receipt: RecallAssetHandoffReceipt,
): Promise<RecallAssetHandoffReceipt> {
  const id = handoffReceiptId(candidateId, receipt.reviewDecisionId);
  const now = new Date().toISOString();
  const record = await updateRecallJsonRecord(userId, 'asset-handoff-receipts', id, (current) => current || ({
    schemaVersion: 2,
    ownerId: userId,
    id,
    candidateId,
    ...receipt,
    createdAt: now,
  } satisfies StoredRecallAssetHandoffReceipt));
  const stored = asStoredHandoffReceipt(record, candidateId, receipt.reviewDecisionId);
  return {
    assetId: stored.assetId,
    assetType: stored.assetType,
    version: stored.version,
    lifecycleStatus: stored.lifecycleStatus,
    scope: stored.scope,
    sourceRefs: stored.sourceRefs,
    reviewDecisionId: stored.reviewDecisionId,
  };
}

async function recoverHandoffReceipt(
  userId: string,
  candidate: RecallCandidateRecord,
  reviewDecisionId: string,
  asset: RecallAbilityAssetRecord,
): Promise<RecallAssetHandoffReceipt | undefined> {
  const belongsToCandidate = asset.candidateId === candidate.id
    || asset.sourceCandidateIds?.includes(candidate.id);
  if (!belongsToCandidate || asset.type !== candidate.suggestedType) return undefined;
  if (asset.reviewDecisionId === reviewDecisionId) {
    return persistHandoffReceipt(userId, candidate.id, handoffReceipt(asset, reviewDecisionId));
  }
  const version = (await listAbilityAssetVersions(userId, asset.id))
    .find((entry) => entry.reason === `review_decision:${reviewDecisionId}`);
  if (!version || version.snapshot.type !== candidate.suggestedType) return undefined;
  return persistHandoffReceipt(userId, candidate.id, {
    assetId: asset.id,
    assetType: version.snapshot.type,
    version: version.version,
    lifecycleStatus: asset.lifecycleStatus,
    scope: version.snapshot.scope,
    sourceRefs: version.snapshot.evidenceRefs,
    reviewDecisionId,
  });
}

export async function promoteRecallCandidate(
  userId: string,
  candidateId: string,
  options: PromoteRecallCandidateOptions & AbilityAssetRelationContract = {},
): Promise<RecallCandidatePromotionResult> {
  if (options.actor !== 'user' && options.actor !== 'system') {
    throw new Error('recall candidate promotion requires a user actor or system actor');
  }
  const ontologyRefs = options.ontologyRefs === undefined ? undefined : normalizeAbilityAssetOntologyRefs(options.ontologyRefs);
  const profileTarget = normalizePersonalProfileTarget(options.profileTarget);
  const relationContract = readAbilityAssetRelationContract(options as Record<string, unknown>);
  const optionSemantics = readAbilityAssetSemantics(options as unknown as Record<string, unknown>);
  const preflight = await readRecallCandidate(userId, candidateId);
  // 版本组防分裂闸门（2026-09-16）：用户确认 create 候选时若与现有资产语义
  // 高度相似，先问一句（专用错误码）——前端提示"新条目还是改为更新"，确认
  // 新条目后带 forceCreateSimilar 重试。带 update 目标/自动线不经过这里；
  // embedding 不可用（degraded）时放行（不能因查重基础设施缺席卡用户）。
  if (options.actor === 'user'
    && !options.forceCreateSimilar
    && !preflight.targetAssetId
    && String(preflight.suggestedAction || 'create') === 'create'
    && preflight.status !== 'confirmed') {
    const { findSemanticDuplicate } = await import('./similarity');
    const pools = await loadDedupPools(userId);
    const scopeIdentity = scopePolicyIdentity(preflight.scopePolicy);
    const outcome = await findSemanticDuplicate(userId, {
      text: String(preflight.judgment || ''),
      candidateTexts: [],
      assetTexts: pools.assetTexts
        .filter((asset) => scopePolicyIdentity(asset.scopePolicy) === scopeIdentity)
        .map(({ id, text }) => ({ id, text })),
      excludeIds: new Set([preflight.id]),
    });
    if (outcome.status === 'match' && outcome.match.kind === 'asset') {
      // 排除"这条资产本来就是本候选写出的"（handoff 中断后的重试路径）——
      // 那是同一件事的产物，不是分裂。
      const matched = await readAbilityAssetSafe(userId, outcome.match.id);
      const isOwnHandoff = matched
        && (matched.candidateId === preflight.id
          || (matched.sourceCandidateIds || []).includes(preflight.id));
      if (!isOwnHandoff) {
        throw recallCandidateError(
          'recall_candidate_similar_asset',
          `similar asset ${outcome.match.id} "${matched ? String(matched.title || '') : ''}" (score ${outcome.match.score.toFixed(2)})`,
        );
      }
    }
  }
  let targetSemantics: AbilityAssetSemantics = {};
  if (preflight.targetAssetId && candidateActionNeedsTarget(preflight.suggestedAction)) {
    const target = await readAbilityAsset(userId, preflight.targetAssetId);
    if (preflight.scopePolicy
      && scopePolicyIdentity(preflight.scopePolicy) !== scopePolicyIdentity(target.scopePolicy)) {
      throw recallCandidateError(
        'recall_candidate_scope_policy_mismatch',
        'A scope-restricted candidate can only update an asset with the same access boundary. Save it as a new asset or choose a matching target.',
      );
    }
    targetSemantics = readAbilityAssetSemantics(target as unknown as Record<string, unknown>);
  }
  const semantics: AbilityAssetSemantics = {
    ...(optionSemantics.applicableWhen !== undefined
      ? { applicableWhen: optionSemantics.applicableWhen }
      : preflight.applicableWhen !== undefined
        ? { applicableWhen: preflight.applicableWhen }
        : targetSemantics.applicableWhen !== undefined ? { applicableWhen: targetSemantics.applicableWhen } : {}),
    ...(optionSemantics.forbiddenWhen !== undefined
      ? { forbiddenWhen: optionSemantics.forbiddenWhen }
      : preflight.forbiddenWhen !== undefined
        ? { forbiddenWhen: preflight.forbiddenWhen }
        : targetSemantics.forbiddenWhen !== undefined ? { forbiddenWhen: targetSemantics.forbiddenWhen } : {}),
  };
  // 条件是评审时新写下的自由文本，不一定走 saveRecallCandidate 那道闸，这里补上。
  assertNotForbiddenToPersist([
    ...(semantics.applicableWhen || []),
    ...(semantics.forbiddenWhen || []),
  ]);
  const causalRule = options.causalRule === undefined ? undefined : normalizeCausalRule(options.causalRule);
  const scopePolicy = options.scopePolicy === undefined
    ? preflight.scopePolicy
    : normalizeAbilityAssetScopePolicy(options.scopePolicy);

  // 统一晋升闸门（PRD 3.1 四类最低准入门槛）。晋升入口不止一个——会话线、
  // KStar 线、用户确认、失败重试都能走到这里，所以校验必须钉在这一处，
  // 而不是只在抽取管线里做一次。
  {
    // 同一句话被分成两类，说明至少一边分错了。扫一遍候选池：只看同文本、
    // 未被否决的条目，收集它们的类型。
    const sameText = comparableJudgmentText(preflight.judgment);
    const conflictingTypes = sameText
      ? [...new Set((await listRecallCandidates(userId))
        .filter((other) => other.id !== preflight.id
          && other.status !== 'rejected'
          && other.status !== 'ignored'
          && other.status !== 'expired'
          && other.status !== 'failed'
          && comparableJudgmentText(other.judgment) === sameText
          && other.suggestedType !== preflight.suggestedType)
        .map((other) => other.suggestedType))]
      : [];
    const validation = validatePromotionByAssetType({
      judgment: preflight.judgment,
      value: preflight.value,
      summary: preflight.summary,
      suggestedType: preflight.suggestedType,
      suggestedScope: preflight.suggestedScope,
      suggestedAction: preflight.suggestedAction,
      applicableWhen: semantics.applicableWhen,
      forbiddenWhen: semantics.forbiddenWhen,
      ...(conflictingTypes.length ? { conflictingTypes } : {}),
    }, { actor: options.actor });
    if (!validation.ok) {
      log.info('recall candidate blocked at the promotion gate', {
        candidateId,
        suggestedType: preflight.suggestedType,
        actor: options.actor,
        reasons: validation.reasons,
      });
      throw new PromotionBlockedError(validation.reasons);
    }
  }

  let decision: ReviewDecision | undefined;
  let receipt: RecallAssetHandoffReceipt | undefined;
  // 本次确认有没有核对到"改进对象版本"（specs/015 T021）：随结果回给渲染层。
  let versionCheckSkipped = false;
  // 显式重锚的原锚（specs/015 US-702 再确认路径）：只有真的换了基线才回传。
  let rebasedFrom: string | undefined;
  let updated: RecallJsonRecord;
  try {
    updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, async (current) => {
    if (!current) throw new Error('recall candidate not found');
    const candidate = asCandidate(current);
    if (candidate.status === 'confirmed') return candidate;
    if (isTerminalCandidate(candidate.status)) {
      throw new RecallCandidateStateError(RECALL_CANDIDATE_TERMINAL_ERROR_CODE, 'recall candidate is terminal', candidate.status);
    }
    // 证据不足只拦**系统**自动晋升——弱证据不该在没人看过的情况下变成资产。
    // 用户显式确认是另一回事：他看到了"证据较弱"的提示仍然决定沉淀，那是
    // 一次有效决策。与紧邻的高风险门禁同一套 actor 判据。
    // 但"用户可操作"仍以 capability 为准：refs 为空的候选连状态都迁不出去
    // （asCandidate 不变量），放它进来只会写出一条读不回的 failed 记录。
    if ((candidate.status === 'weak_observation' || candidate.status === 'observed')
      && (options.actor !== 'user' || !getRecallCandidateCapabilities(candidate).canPromote)) {
      throw recallCandidateError('recall_candidate_evidence_insufficient', 'candidate evidence is insufficient for review');
    }
    if (candidate.risk === 'high' && (options.actor !== 'user' || options.riskAcknowledged !== true)) {
      throw recallCandidateError('recall_candidate_risk_gate', 'high-risk candidate requires an independent risk gate');
    }
    if (candidate.suggestedAction === 'keep_current' || candidate.suggestedAction === 'reject') {
      throw recallCandidateError('recall_candidate_non_asset_decision', 'candidate action must use its non-asset review decision');
    }
    const gate = evaluateCandidate({
      title: candidate.summary,
      summary: candidate.value,
      body: candidate.judgment,
    });
    if (isCandidateBlocked(gate)) {
      throw recallCandidateError('recall_candidate_security_blocked', 'candidate is blocked by cognition security gate');
    }
    if (Date.parse(candidate.expiresAt) <= Date.now()) {
      return {
        ...candidate,
        status: 'expired',
        failureCode: 'candidate_expired',
        failureMessage: 'candidate expired before confirmation',
        failedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    const unavailableSources = await unavailableCandidateSources(
      userId,
      mergeSourceRefs(candidate.sourceRefs, candidate.evidenceRefs),
    );
    // 手动候选（「记一条」）没有对话证据：空 evidenceRefs 是它的常态而非
    // 失败——确认动作本身就是用户输入，无需来源可用性背书（2026-09-28）。
    if ((unavailableSources.length || !candidate.evidenceRefs.length) && candidate.origin !== 'manual') {
      return {
        ...candidate,
        status: 'failed',
        failureCode: unavailableSources.length ? 'source_unavailable' : 'evidence_insufficient',
        failureMessage: unavailableSources.length
          ? 'candidate source is paused, removed, or no longer authorized'
          : 'candidate has no usable evidence',
        failedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    const targetRef = `recall_candidate:${candidate.id}`;
    decision = candidate.status === 'failed' && candidate.reviewDecisionId
      ? await readReviewDecision(userId, targetRef, candidate.reviewDecisionId)
      : undefined;
    if (candidate.status === 'failed' && candidate.reviewDecisionId && !decision) {
      throw new Error('previous review decision is unavailable; confirmation cannot be retried safely');
    }
    decision = decision || await writeReviewDecision(userId, {
      targetRef,
      decisionType: options.decisionType || (candidate.userModifiedAt ? 'modify' : 'accept'),
      decision: options.actor === 'system'
        ? 'automatic capture'
        : options.decisionType === 'modify' || candidate.userModifiedAt ? 'modify and save' : 'accept',
      antecedentRef: candidate.id,
      scope: candidate.suggestedScope,
      reason: options.decisionReason,
      actor: options.actor,
      modifiedContent: candidate.userModifiedAt ? candidate.judgment : undefined,
      idempotencyKey: confirmationIdempotencyKey(candidate),
      decisionId: options.decisionId,
    });
    const handoffActor: AbilityAssetActor = decision.actor === 'system' ? 'system' : 'user';
    // 出身收敛（2026-09-20 拍板）：模型记下来的=已确定——晋升一律落
    // user_confirmed_unverified（=确定、未实证），不再区分 user/kstar/auto
    // 三条出身线；provenance 保留为审计提示，不产生任何行为差异。
    const handoffLifecycleStatus: RecallAbilityAssetLifecycleStatus = 'user_confirmed_unverified';
    const now = new Date().toISOString();
    let stored: RecallAbilityAssetRecord;
    const handoffReason = `review_decision:${decision.decision_id}`;
    // 版本重检计划在这里定：更新型候选把"要核的版本"传进 `updateAbilityAsset`
    // （比对在它的锁内，唯一一处）；用户显式重锚（confirmBaselineVersion）时
    // 以他看过的当前在用版为准，缺省仍是候选原锚。存量候选缺这个字段又没重锚
    // 就如实标 versionCheckSkipped，不假装核对过。
    const versionPlan = candidateVersionRecheckPlan(
      candidate.suggestedAction,
      candidate.targetVersionUsed,
      options.confirmBaselineVersion,
    );
    versionCheckSkipped = versionPlan.versionCheckSkipped;
    rebasedFrom = versionPlan.rebasedFrom;
    const alreadyApplied = await readAppliedHandoffAsset(userId, candidate, decision.decision_id);
    if (alreadyApplied) {
      receipt = await readRecallAssetHandoffReceipt(userId, candidate.id, decision.decision_id)
        || await recoverHandoffReceipt(userId, candidate, decision.decision_id, alreadyApplied);
      if (!receipt) throw new Error('immutable handoff receipt cannot be recovered safely');
      decision = await recordReviewDecisionOutcome(
        userId,
        targetRef,
        decision.decision_id,
        { assetId: alreadyApplied.id },
      );
      return {
        ...candidate,
        status: 'confirmed',
        promotedAssetId: alreadyApplied.id,
        reviewDecisionId: decision.decision_id,
        failureCode: undefined,
        failureMessage: undefined,
        failedAt: undefined,
        updatedAt: now,
      };
    }
    if (candidate.suggestedAction === 'create') {
      const sourceSessionIds = sourceSessionIdsFrom(candidate.sourceRefs);
      const assetId = createdAssetId(candidate.id, decision.decision_id);
      // 正文先行定稿：标题兜底的合规判定与 LLM 起标题都要拿**将落盘的最终
      // 正文**比对（与收口闸门同一份口径），不能拿候选 judgment 单独判。
      // 新建路（2026-09-29 正文一等规范）：正文＝judgment 单一来源，value 不再
      // 硬拼——「知识」与「为什么有用」是异质内容，拼接正是旧正文多行混排的
      // 形态病根；value 仍是候选层评审辅助字段（确认页展示），不进资产正文。
      // 更新/融合路（else 分支）维持旧拼装：value 参与融合是 KStar admission
      // 链核对基线的既有语义，本轮规范只收新建路，不动它。
      const createStatement = candidate.judgment.slice(0, 4_000);
      const promotionTitle = await resolvePromotionAssetTitle(userId, {
        preferredTitle: candidate.summary || '',
        statement: createStatement,
        type: candidate.suggestedType,
      });
      stored = await createAbilityAsset(userId, {
        schemaVersion: 2,
        ownerId: userId,
        id: assetId,
        candidateId: candidate.id,
        sourceCandidateIds: [candidate.id],
        reviewDecisionId: decision.decision_id,
        type: candidate.suggestedType,
        title: promotionTitle,
        // Substantive statement: judgment (what to retain) + value (why it
        // matters / future value) when present — the value clause is the
        // reusable insight, and a bare conclusion sentence alone is too thin
        // to stand as a method/template asset body.
        statement: createStatement,
        evidenceRefs: candidate.evidenceRefs,
        // 手动候选（「记一条」）没有对话证据：资产侧空证据的合法性靠这个
        // origin 标记识别（asAsset 读回与展示徽章都用它，2026-09-28 拍板项）。
        ...(candidate.origin === 'manual' ? { origin: 'manual' as const } : {}),
        ...(candidate.learningSignal ? { learningSignal: candidate.learningSignal } : {}),
        ...(candidate.learningProvenance ? { learningProvenance: candidate.learningProvenance } : {}),
        ...(causalRule ? { causalRule } : {}),
        ...(ontologyRefs?.length ? { ontologyRefs } : {}),
        ...relationContract,
        ...semantics,
        scope: candidate.suggestedScope,
        ...(scopePolicy ? { scopePolicy } : {}),
        ...(candidate.spaceId ? { spaceId: candidate.spaceId } : {}),
        status: 'active',
        lifecycleStatus: handoffLifecycleStatus,
        maturity: handoffActor === 'system' ? 'seed' : 'bud',
        version: '1',
        ...(sourceSessionIds.length ? { sourceSessionIds } : {}),
        createdAt: now,
        updatedAt: now,
      }, { actor: handoffActor, reason: handoffReason });
      // 入库自动挂族（2026-09-19 列表 #2）：新资产与既有资产静态同键或语义
      // ≥ 0.60 → 写 same_family 关系。挂族是增强不是闸门，失败在函数内静默。
      try {
        const { listAbilityAssets } = await import('./asset-service');
        const { attachFamilyOnCreate } = await import('./family');
        const peers = (await listAbilityAssets(userId))
          .filter((asset) => asset.id !== stored.id && asset.status === 'active');
        await attachFamilyOnCreate(userId, stored, peers, {
          reviewDecisionId: decision.decision_id,
          sourceCandidateId: candidate.id,
        });
      } catch {
        // 挂族失败不影响入库。
      }
      // 学习回流本体（2026-09-19 本体增强）：新资产投本体候选池等用户确认
      // （蓝图 R13 提议-确认）。只挂 create 落点——融合/更新路径（merged/
      // fused）内容已在资产里，回流只会重复。白名单与防洪在 backflow 模块内。
      try {
        const { backflowAssetToOntologyPool } = await import('./ontology-backflow');
        await backflowAssetToOntologyPool(userId, stored);
      } catch {
        // 回流失败不影响入库。
      }
    } else {
      if (!candidate.targetAssetId) throw new Error('candidate target asset is required');
      const target = await readAbilityAsset(userId, candidate.targetAssetId);
      if (target.type !== candidate.suggestedType) throw new Error('candidate target asset type mismatch');
      if (candidate.suggestedAction === 'pause') {
        stored = await pauseAbilityAsset(userId, target.id, {
          actor: handoffActor,
          reason: handoffReason,
          reviewDecisionId: decision.decision_id,
          sourceCandidateId: candidate.id,
        });
      } else if (candidate.suggestedAction === 'update' || candidate.suggestedAction === 'limit_scope') {
        // 融合而非覆盖（2026-09-19 刀二）：update 的正文 = 旧正文为主体 +
        // 候选判断按句级三档融入（重述留更长/改写新替旧/增量追加）。选择
        // "融合错了可回退"兜底而不是放弃融合——版本快照保证旧版随时可切回。
        // 主体取的是**刚才读到的当前正文**（`target` 在候选记录的锁内读、紧接着
        // 交给资产锁比对）：显式重锚时融合的就是用户看过的那一版正文，绝不拿
        // 候选原锚版本的旧正文去糊当前版。若正文在两次读之间又变了，资产锁内
        // 的版本比对会拦住（零改动），不会把旧内容套上去。
        // limit_scope（范围收窄）不融合：它的判断文本通常是对范围的完整重写。
        const fused = candidate.suggestedAction === 'update' && String(target.statement || '').trim()
          ? fuseStatements(String(target.statement), String(candidate.judgment || ''))
          : null;
        const updateStatement = fused ? fused.statement : candidate.judgment;
        // 与 create 分支同款：标题合规判定拿**写入后的最终正文**（融合结果）
        // 比对；summary 不合规时走 LLM 起标题链（设计 3.2 晋升线口径）。
        const updateTitle = await resolvePromotionAssetTitle(userId, {
          preferredTitle: candidate.summary || '',
          statement: updateStatement,
          type: candidate.suggestedType,
        });
        try {
          stored = await updateAbilityAsset(userId, target.id, {
            title: updateTitle,
            statement: updateStatement,
            scope: candidate.suggestedScope,
            // An update adds evidence to the chain; it must not erase the
            // evidence already supporting the target asset.
            evidenceRefs: mergeSourceRefs(target.evidenceRefs, candidate.evidenceRefs),
            ...(ontologyRefs?.length ? { ontologyRefs } : {}),
            ...relationContract,
            ...semantics,
            ...(scopePolicy ? { scopePolicy } : {}),
            // 版本重检（specs/015 D6/D7）：要核的版本（候选原锚，或用户显式
            // 重锚后的当前在用版）交给资产服务，在它的锁内与当前在用版比对
            // ——不在本文件写第二处比对。
            ...(versionPlan.expectedVersion ? { expectedVersion: versionPlan.expectedVersion } : {}),
            actor: handoffActor,
            reason: fused ? `${handoffReason};semantic-fusion` : handoffReason,
            reviewDecisionId: decision.decision_id,
            sourceCandidateId: candidate.id,
          });
        } catch (error) {
          const conflict = abilityAssetVersionConflict(error, versionPlan.expectedVersion, candidate.targetVersionUsed);
          throw conflict ? new RecallCandidateVersionConflictError(conflict) : error;
        }
      } else {
        throw new Error('candidate action does not create or change an asset');
      }
    }
    // 空间归属自动挂载：资产带 spaceId（来源会话/任务的空间）时自动补
    // workspace-ref（资产 × 空间绑定）。手动投影/预览/确认路径
    // （buildRecallView / isAssetEligibleForProjection）要求空间会话的资产
    // 存在该空间的 workspace-ref，否则出现"资产 tab 可见但引用不到"。
    // 统一在此收口（幂等；KStar 直接沉淀线在 direct-experience-assets
    // 里的挂载保留，重复挂载无害）。挂载失败不阻断确认——资产本身已成立。
    if (stored?.spaceId && safeId(stored.spaceId)) {
      try {
        const { addWorkspaceAssetReference } = await import('./workspace-refs');
        await addWorkspaceAssetReference(userId, {
          assetId: stored.id,
          workspaceId: stored.spaceId,
          scope: candidate.suggestedScope,
        });
      } catch (error) {
        log.warn('recall workspace reference auto-binding degraded', {
          userId,
          candidateId,
          assetId: stored.id,
          error: (error as Error).message,
        });
      }
    }
    receipt = await persistHandoffReceipt(userId, candidate.id, handoffReceipt(stored, decision.decision_id));
    decision = await recordReviewDecisionOutcome(
      userId,
      `recall_candidate:${candidate.id}`,
      decision.decision_id,
      { assetId: stored.id },
    );
    // 重锚留痕（`contracts/ipc.md` §二）：确认**已生效**之后才补记原锚，未生效
    // 的尝试不写（那是"没发生的事"）。承接在上面那条终态记录之后追加，账本仍是
    // 只增不改；同一 decision_id 以最后一条为准，所以读口看到的是带原锚的终态。
    if (rebasedFrom) {
      decision = await recordRebasedDecisionTrace(
        userId,
        `recall_candidate:${candidate.id}`,
        decision,
        rebasedFrom,
      );
    }
    return {
      ...candidate,
      status: 'confirmed',
      promotedAssetId: stored.id,
      reviewDecisionId: decision.decision_id,
      failureCode: undefined,
      failureMessage: undefined,
      failedAt: undefined,
      updatedAt: now,
    };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 版本重检不一致（specs/015 D6/D9）：候选**不落终态**——用户没做错什么，
    // 只是资产在他看候选的时候被改过；资产零改动（比对在 updateAbilityAsset
    // 锁内，不通过就没写）。台账只记一次"未生效的确认尝试"，与 specs/008 的
    // approval_confirmed「未生效」行同口径；不写 failed，也不改资产。
    const versionConflict = recallCandidateVersionConflictOf(error);
    if (decision) {
      await recordReviewDecisionOutcome(
        userId,
        `recall_candidate:${candidateId}`,
        decision.decision_id,
        { failureCode: versionConflict ? 'version_conflict' : 'asset_write_failed' },
      ).catch(() => undefined);
      if (versionConflict) throw error;
      await updateRecallJsonRecord(userId, 'candidates', candidateId, (current) => {
        if (!current) throw error;
        const candidate = asCandidate(current);
        if (candidate.status === 'confirmed' || isTerminalCandidate(candidate.status)) return candidate;
        const now = new Date().toISOString();
        return {
          ...candidate,
          status: 'failed',
          failureCode: 'asset_write_failed',
          failureMessage: message.slice(0, 1_000),
          failedAt: now,
          reviewDecisionId: decision.decision_id,
          updatedAt: now,
        };
      }).catch(() => undefined);
    }
    throw error;
  }
  const candidate = asCandidate(updated);
  if (candidate.status === 'expired') throw new Error('recall candidate expired');
  if (candidate.status === 'failed') throw new Error(candidate.failureMessage || 'recall candidate confirmation failed');
  if (!candidate.promotedAssetId) {
    const now = new Date().toISOString();
    await updateRecallJsonRecord(userId, 'candidates', candidate.id, (current) => {
      if (!current) throw new Error('recall candidate not found');
      const latest = asCandidate(current);
      return {
        ...latest,
        status: 'failed',
        failureCode: 'asset_write_failed',
        failureMessage: 'confirmed candidate has no asset identity; confirmation can be retried',
        failedAt: now,
        updatedAt: now,
      };
    });
    throw new Error('promoted candidate has no ability asset; confirmation can be retried');
  }
  let storedAsset: RecallJsonRecord | undefined;
  try {
    storedAsset = await readRecallJsonRecord(userId, 'ability-assets', candidate.promotedAssetId);
  } catch {
    storedAsset = undefined;
  }
  if (!storedAsset) {
    const now = new Date().toISOString();
    await updateRecallJsonRecord(userId, 'candidates', candidate.id, (current) => {
      if (!current) throw new Error('recall candidate not found');
      const latest = asCandidate(current);
      return {
        ...latest,
        status: 'failed',
        failureCode: 'asset_write_failed',
        failureMessage: 'confirmed ability asset is missing; confirmation can be retried',
        failedAt: now,
        updatedAt: now,
      };
    });
    throw new Error('promoted ability asset not found; confirmation can be retried');
  }
  const asset = asAsset(storedAsset);
  const reviewDecisionId = candidate.reviewDecisionId || asset.reviewDecisionId;
  if (!decision) {
    decision = await readReviewDecision(userId, `recall_candidate:${candidate.id}`, reviewDecisionId);
  }
  if (!decision) throw new Error('review decision not found for promoted asset');
  receipt = receipt || await readRecallAssetHandoffReceipt(userId, candidate.id, reviewDecisionId);
  if (!receipt) {
    throw new Error('immutable handoff receipt not found for promoted asset');
  }
  // Personal 资产通过用户确认或自动沉淀策略落库后投影进 USER.md，并按需投影
  // 到已安装角色模板。这些都是
  // 第二个、单向增量视图：
  // 它失败不能反过来把正式资产判成失败，但要在本次确认返回前完成，保证用户
  // 点击确认后马上能在「关于我」看到结果。显式目标优先；没有目标时由路由器
  // 自动匹配字段。schedulePersonalProfileSync 自带同用户在途去重。
  let profileProjection: PersonalProfileSyncResult | undefined;
  if (asset.type === 'personal') {
    try {
      const { schedulePersonalProfileSync } = await import('./personal-profile-sync');
      profileProjection = await schedulePersonalProfileSync(userId, {
        assetId: asset.id,
        ...(profileTarget ? { target: profileTarget } : {}),
      });
    } catch (error) {
      log.warn('personal profile projection after promote degraded', {
        userId,
        assetId: asset.id,
        error: (error as Error).message,
      });
    }
  }
  return {
    candidate,
    asset,
    decision,
    receipt,
    ...(versionCheckSkipped ? { versionCheckSkipped: true as const } : {}),
    ...(rebasedFrom ? { rebasedFrom } : {}),
    ...(profileProjection ? { profileProjection } : {}),
  };
}
