import { withCognitionCommitLifetime, assertCognitionCommitActive } from '../cognition_kernel/store';
import { withCognitionTransition } from '../cognition_bridge';
import { t } from '../../i18n';
import { purgedOrganizationRecord } from './organization-content-lifecycle';
import { verifyContentOrganization, type ContentOrganizationPlan, type ContentOrganizationReceipt } from './content-organization';
import { normalizeStockOrganizationProvenance, verifyStockOrganizationCandidate, withStockOrganizationConfirmation, type StockOrganizationProvenance } from './stock-organization-provenance';
import { formationComparisonSchema, type FormationComparison } from './formation-comparison';
import { isDeepStrictEqual } from 'node:util';
import { bindOntologyFormationPlan, normalizeOntologyFormationPlan, withOntologyFormationPromotion, withOntologyOnlyFormation, type OntologyFormationPlan } from './ontology-formation';
import { withRecallAutoApprovalLock } from './capture-settings';
import { evaluateNightlyAutomaticApproval, NightlyAutomaticApprovalHeldError, requireNightlyAutomaticApproval } from './nightly-automatic-approval';
import { requireContentCategory, readContentCategory, type CognitionContentCategory, type StoredCognitionContentCategory } from './content-category';
import type { AutomaticCandidateReview } from './automatic-review-history';
import { CaptureFormationSourceUnavailableError, normalizeCaptureProvenance, verifyCaptureProvenanceForWrite, type RecallCaptureProvenance } from './capture-provenance';
import { normalizeHumanInstructionProvenance, verifyHumanInstructionCandidate, verifyCandidateFormationForPromotion, type HumanInstructionProvenance } from '../cognition/human-instruction-provenance';
import * as fs from 'node:fs/promises';
import { describeRoleTemplateFieldRef } from '../personal_ontology_contract';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { createLogger } from '../../logger';
import { evaluatePromotionPolicy } from './promotion-policy';
import { ContentContractError, RECALL_TEXT_LIMITS, assertContentWithinContract, contentExceedsContract, normalizeStatementText } from './content-contract';

import { describePromotionBlock, validatePromotionByAssetType, type PromotionBlockReason } from './formal-assets/promotion';
import { appendJsonlAtomic, genId12, nowIso, safeId } from '../../storage';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
import { fileEditLock } from '../../util/locks';
import { recallJsonRecordPath } from './paths';
import { gateCandidateStatement } from './candidate-statement-gate';
import { hasReviewableCandidateEvidence } from './candidate-evidence';
import { bumpRecallCaptureStats } from './capture-stats';
import { notifyCognitionWrite } from './store-events';
import {
  createRecallCollectionReader, readRecallJsonRecord,
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
  abilityAssetActiveVersion,
  createAbilityAsset,
  listAbilityAssetVersions,
  pauseAbilityAsset,
  readAbilityAsset,
  readAbilityAssets,
  updateAbilityAsset,
  type AbilityAssetActor,
} from './asset-service';
import { makeDisplayTitle } from './statement-fusion';
import { recallTitleIssue } from './title-policy';
import { recallStatementIssues } from './statement-policy';
import { evaluateCandidate, isCandidateBlocked } from '../cognition/gate';
import { isCognitionSourceEnabled } from './source-control';
import {
  readReviewDecision,
  listReviewDecisions,
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
  | 'integrated'
  | 'rejected'
  | 'ignored'
  | 'expired'
  | 'failed'
  | 'superseded';
export type AbilityAssetType = 'cognition' | 'personal' | 'rule' | 'template' | 'skill_method' | 'fact';
export type RecallCandidateAction = 'create' | 'update' | 'limit_scope' | 'pause' | 'keep_current' | 'reject';
export type RecallCandidateRisk = 'low' | 'medium' | 'high';
export type RecallAbilityAssetLifecycleStatus = 'user_confirmed_unverified' | 'automatically_extracted_unverified' | 'system_precipitated_unverified';

const DEFAULT_CANDIDATE_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
/** Legacy aggregate markers stay on disk for audit; the boot runner below
 *  audits actual records instead of trusting them. */
const USER_DEFER_RETIRED_MIGRATION_ID = 'user-defer-retired-20261002';
const CANDIDATE_RECORD_MIGRATION_ID = 'candidate-record-contract-v2';

type CandidateRecordMigrationStatus = 'applied' | 'current' | 'failed' | 'blocked' | 'missing';

interface CandidateRecordMigrationEntry {
  status: CandidateRecordMigrationStatus;
  attempts: number;
  at: string;
  fingerprint?: string;
  error?: string;
}

interface CandidateRecordMigrationJournal extends RecallJsonRecord {
  startedAt?: string;
  completedAt?: string;
  entries?: Record<string, CandidateRecordMigrationEntry>;
}


export interface RecallCandidateRecord extends RecallJsonRecord {
  /** The content was removed with an owning asset; identity and outcome remain. */
  contentPurgedAt?: string;
  contentAssetIds?: string[];
  contentOrganization?: ContentOrganizationPlan;
  organizationReceipt?: ContentOrganizationReceipt;
  id: string;
  proposalTarget?: 'cognition' | 'ontology' | 'joint';
  formationProposalId?: string;
  /** Canonical content fields below are stable across every candidate producer. */
  contentFormatVersion: 1;
  taxonomyVersion: 2;
  status: RecallCandidateStatus;
  judgment: string;
  /** Why retaining this cognition will be useful in later work. */
  value?: string;
  /** Preserved only for legacy message captures that stored evidence prose in `value`. */
  evidenceSummary?: string;
  summary: string;
  uncertainty?: string;
  contentCategory?: StoredCognitionContentCategory;
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
  /** Capture submissions merged into this candidate, committed with the merge. */
  captureReceiptKeys?: string[];
  captureProvenance?: RecallCaptureProvenance;
  stockOrganizationProvenance?: StockOrganizationProvenance;
  humanInstructionProvenance?: HumanInstructionProvenance;
  /** 统一来源标记：读取时由 learningProvenance/
   *  captureKey 前缀/教学信号引用惰性推导，不再靠调用方拿前缀猜——
   *  'kstar'（KStar 沉淀）/ 'teaching'（用户教学）/ 'capture'（复盘·整理·
   *  capture 等系统提取的统称）；'manual'（「记一条」手动新建：
   *  保存时显式落盘，读回校验与晋升豁免都靠它识别，不由前缀推导）。 */
  origin?: 'kstar' | 'teaching' | 'capture' | 'manual' | 'human_instruction' | 'stock_organization' | 'organization';
  /** 正文规范警示（读时派生、不落盘）：确认页展示，不拦截写入。 */
  statementIssues?: Array<'empty' | 'too_long' | 'session_debris' | 'local_path'>;
  promotedAssetId?: string;
  /** The candidate was user-reviewed and materialized as canonical ontology records. */
  ontologyHandoff?: RecallCandidateOntologyHandoff;
  reviewDecisionId?: string;
  autoReview?: AutomaticCandidateReview;
  automaticUndo?: { decisionId: string; originalDecisionId: string; commandId: string; committedAt: string };

  ontologyFormation?: OntologyFormationPlan;
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
  /** 版本组契约：任务实际使用的目标资产版本（KSTAR 改进
   *  提案锚定用）；确认时与资产当前在用版核对，避免改错对象。 */
  targetVersionUsed?: string;
  formationComparison?: FormationComparison;
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

export interface RecallCandidateOntologyHandoff {
  status: 'in_progress' | 'integrated';
  commandId: string;
  moduleIds: string[];
  recordIds: string[];
  ontologyRevision: number;
  committedAt: string;
}

export interface RecallAbilityAssetRecord extends RecallJsonRecord {
  id: string;
  candidateId: string;
  sourceCandidateIds?: string[];
  appliedReviewDecisionIds?: string[];
  reviewDecisionId: string;
  /** Host-issued continuation proof; no candidate/model/IPC input accepts it. */
  standingPreferenceAuthority?: import('./standing-preference-authority').StandingPreferenceAuthority;
  userEditDecision?: import('../cognition/edit-decision').CognitionEditDecision;
  type: AbilityAssetType;
  contentCategory?: StoredCognitionContentCategory;
  title: string;
  statement: string;
  /** Concrete future use; review context, not an authorization scope. */
  value?: string;
  evidenceRefs: CognitionSourceRef[];
  /** 手动新建资产的空证据豁免标记（「记一条」晋升时从候选透传）。 */
  origin?: 'manual';
  learningSignal?: KstarLearningSignal;
  learningProvenance?: KstarLearningProvenance;
  /** R-Box causal rule frozen from a delta_r lesson (world-model ontology). */
  causalRule?: CausalRule;
  ontologyRefs?: AbilityAssetOntologyRef[];
  relations?: AbilityAssetRelation[];
  /** 大类名：挂族时继承族内已有名，用户可改
   *  （recall.families.rename 批量写族内全部成员）；元数据，不 bump 内容版本。 */
  familyName?: string;
  /** 主题标签：标签名数组，指向标签库
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
  /** 用户显式确认允许跨作用域使用的时间；缺失表示未确认，不表示拒绝。 */
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
  /** 清除前正文的不可逆摘要；重试时用它继续清理同文候选，不保留正文。 */
  purgedTextHash?: string;
  /** Ontology records owned by the asset at purge time; kept as IDs so a
   *  retried cascade can still scrub history after `ontologyRefs` is cleared. */
  purgedOntologyRecordIds?: string[];
  version: string;
  /** 在用版本指针：缺省=跟随最新（version）；
   *  selectAbilityAssetVersion 切换后指向所选历史版本；后续内容更新
   *  bump 时重置为最新版。注入默认取该版本的内容快照。 */
  activeVersion?: string;
  /** 归并去向：本条已并入某条目后记录其 id；
   *  本条随之归档，历史引用不回写。 */
  mergedIntoAssetId?: string;
  /** Semantic organization keeps original chains and records group lineage. */
  contentOrganizationId?: string;
  organizationArchivedBy?: string;
  organizationResultIds?: string[];
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
  contentOrganization?: ContentOrganizationPlan;
  proposalTarget?: 'cognition' | 'ontology' | 'joint';
  formationProposalId?: string;
  ontologyFormation?: OntologyFormationPlan;
  judgment: string;
  value?: string;
  evidenceSummary?: string;
  summary?: string;
  uncertainty?: string;
  contentCategory?: CognitionContentCategory;
  suggestedType: AbilityAssetType;
  suggestedScope: string;
  sourceRefs: unknown[];
  evidenceRefs?: unknown[];
  suggestedAction?: RecallCandidateAction;
  risk?: RecallCandidateRisk;
  expiresAt?: string;
  taskRunId?: string;
  targetAssetId?: string;
  /** 版本组契约：任务实际使用的目标资产版本（KSTAR 改进
   *  提案锚定用）；确认时与资产当前在用版核对，避免改错对象。 */
  targetVersionUsed?: string;
  formationComparison?: FormationComparison;
  learningSignal?: KstarLearningSignal;
  learningProvenance?: KstarLearningProvenance;
  captureKey?: string;
  captureProvenance?: RecallCaptureProvenance;
  stockOrganizationProvenance?: StockOrganizationProvenance;
  humanInstructionProvenance?: HumanInstructionProvenance;
  /** 「记一条」手动新建标记：手动候选没有对话
   *  来源，sourceRefs 只能为空——证据闸防的是自动提炼线编造来源，对用户
   *  亲自输入不适用；manual=true 时跳过"空证据落 weak_observation"判定、
   *  直接 pending_review，读回与晋升的同款放行靠落盘的 origin='manual'
   *  识别。自动线（capture/teaching/KStar）行为零变化。 */
  manual?: boolean;
  /** 忠实搬运豁免：文本是用户亲写或历史原文
   *  （对话中当场记 / 旧记忆迁移 / 旧本体导入），跳过机器改写——调用方
   *  显式声明；机器生成线不声明，默认过闸。manual（记一条）天然豁免。 */
  rawStatement?: boolean;
  /** 空间归属（可选）：来源会话/任务的 space_id。 */
  spaceId?: string;
  /** 需原样保留到正式资产的读取范围限制。 */
  scopePolicy?: RecallAbilityAssetScopePolicy;
  /** 规则候选的适用/禁止范围须从候选阶段保留到晋升校验。
   * 缺失表示没有提出边界，不表示无限制。 */
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
  /** 版本重检口径：本次确认**没能**核对"改进对象版本"
   *  ——存量候选没有 `targetVersionUsed` 可核对。缺省不出现（=核对过，或
   *  本来就是新建型，没有可核对的版本）。渲染层据此如实提示"无法核对改进
   *  对象"，而不是假装核对过。 */
  versionCheckSkipped?: true;
  /** 显式重锚的留痕：本次确认把比对
   *  基线从候选原锚（= 这个字段的值，即原 `targetVersionUsed`）换到了用户看
   *  过差异后的当前在用版。只在**确实换了**（原锚存在且与传入的
   *  `confirmBaselineVersion` 不同）且这次确认**已生效**时出现——冲突路径
   *  不带它（没生效就谈不上重锚）。 */
  rebasedFrom?: string;
}

export interface RecallOntologyCandidateConfirmation {
  candidate: RecallCandidateRecord;
  ontologyHandoff: RecallCandidateOntologyHandoff;
}

/** Individual confirmation uses the existing pool mutex and source checks;
 * candidate completion and all T/R/A changes are one authoritative commit. */
export async function confirmRecallOntologyCandidate(userId: string, candidateId: string,
  options: { riskAcknowledged?: boolean; actor?: 'user' | 'system'; signal?: AbortSignal } = {}): Promise<RecallOntologyCandidateConfirmation> {
  if (options.actor === 'system') {
    const candidate = await readRecallCandidate(userId, candidateId);
    if (candidate.status === 'integrated' && candidate.ontologyHandoff) return { candidate, ontologyHandoff: candidate.ontologyHandoff };
    const review = await evaluateNightlyAutomaticApproval(userId, candidate, { signal: options.signal });
    if (!review.eligible) throw new NightlyAutomaticApprovalHeldError(review.reasons);
    return withCognitionCommitLifetime(userId, options.signal, () =>
      withRecallAutoApprovalLock(userId, () => confirmRecallOntologyCandidateWithGrant(userId, candidateId, options)));
  }
  return confirmRecallOntologyCandidateWithGrant(userId, candidateId, options);
}

async function confirmRecallOntologyCandidateWithGrant(userId: string, candidateId: string,
  options: { riskAcknowledged?: boolean; actor?: 'user' | 'system' }): Promise<RecallOntologyCandidateConfirmation> {
  return withRecallCandidatePromotionLock(userId, async () => {
    let saved: RecallCandidateRecord | undefined;
    const preliminary = await readRecallCandidate(userId, candidateId);
    if (preliminary.stockOrganizationProvenance && options.actor === 'system') throw new Error('stock organization requires manual confirmation');
    if (preliminary.proposalTarget !== 'ontology') throw new Error('candidate is not an ontology-only proposal');
    if (preliminary.status === 'integrated' && preliminary.ontologyHandoff) return { candidate: preliminary, ontologyHandoff: preliminary.ontologyHandoff };
    if (isTerminalCandidate(preliminary.status)) throw new RecallCandidateStateError(RECALL_CANDIDATE_TERMINAL_ERROR_CODE, 'candidate is terminal', preliminary.status);
    await verifyCandidateFormationForPromotion(userId, preliminary);
    if ((!preliminary.stockOrganizationProvenance && !preliminary.value?.trim()) || !preliminary.suggestedScope.trim() || !preliminary.summary.trim())
      throw new Error('ontology proposal explanation, future use and scope are required');
    if (!preliminary.ontologyFormation) throw new Error('ontology plan is missing');
    await withStockOrganizationConfirmation(userId, preliminary, () => withOntologyOnlyFormation(userId, preliminary.ontologyFormation, () => updateRecallJsonRecord(userId, 'candidates', candidateId, async raw => {
      if (!raw) throw new Error('candidate is unavailable');
      const candidate = asCandidate(raw);
      if (!isDeepStrictEqual(candidate, preliminary)) throw Object.assign(new Error('candidate changed; review the current proposal'),
        preliminary.stockOrganizationProvenance ? { code: 'stock_organization_baseline_changed' } : {});
      await verifyCandidateFormationForPromotion(userId, candidate);
      if (Date.parse(candidate.expiresAt) <= Date.now()) throw new Error('candidate expired');
      if (candidate.uncertainty?.trim()) throw recallCandidateError('ontology_meaning_unresolved', 'ontology proposal has unresolved meaning');
      if (candidate.risk === 'high' && !options.riskAcknowledged) throw new Error('high-risk ontology changes require individual acknowledgment');
      const automaticReview = options.actor === 'system' ? await requireNightlyAutomaticApproval(userId, candidate) : undefined;
      assertCognitionCommitActive(userId);
      const decision = await writeReviewDecision(userId, { targetRef: `recall_candidate:${candidate.id}`, decisionType: 'modify',
        decision: 'integrate_to_ontology', antecedentRef: candidate.id, scope: candidate.suggestedScope,
        reason: options.actor === 'system' ? 'Explicit nightly grant and independent source checks permit this ontology change.'
          : 'User confirmed the complete source-grounded independent ontology proposal.', actor: options.actor === 'system' ? 'system' : 'user',
        modifiedContent: candidate.judgment, idempotencyKey: `ontology-${candidate.ontologyFormation!.commandId}` });
      const now = new Date().toISOString();
      saved = { ...candidate, status: 'integrated', reviewDecisionId: decision.decision_id,
        ...(automaticReview ? { autoReview: automaticReview } : {}),
        ontologyHandoff: { status: 'integrated', commandId: candidate.ontologyFormation!.commandId,
          moduleIds: [], recordIds: [], ontologyRevision: candidate.ontologyFormation!.baselineRevision,
          committedAt: now }, cooldownUntil: undefined, failureCode: undefined, failureMessage: undefined, failedAt: undefined, updatedAt: now };
      return saved;
    }), options.actor === 'system' ? 'system' : 'user'));
    if (!saved?.ontologyHandoff) throw new Error('ontology confirmation did not commit');
    const candidate = await readRecallCandidate(userId, candidateId);
    notifyCognitionWrite(userId, 'ontology', 'update', candidate.ontologyHandoff!.commandId);
    return { candidate, ontologyHandoff: candidate.ontologyHandoff! };
  });
}

/** 版本重检不一致的结构化冲突。
 *
 *  字段名与 `asset-approval-service.ts` 的 `versionConflict`
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
 *  结构化冲突返回体。 */
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

/** 版本重检与显式重锚的传参约束：
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
 *  `asset-approval-service.ts` 相同），不另算一遍。
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

/** 重锚留痕：显式把候选的比对基线换到
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
   *  （与 ReviewDecisionActor 使用同一角色域）。 */
  actor?: ReviewDecisionActor;
  /** Host cancellation before the first formal commit; ignored by completed recovery. */
  signal?: AbortSignal;
  /** 仅在 actor === 'system' 时有意义；缺省按会话自动抽取线处理。 */
  provenance?: RecallPromotionProvenance;
  ontologyRefs?: AbilityAssetOntologyRef[];
  scopePolicy?: RecallAbilityAssetScopePolicy;
  decisionType?: 'accept' | 'modify';
  decisionId?: string;
  decisionReason?: string;
  riskAcknowledged?: boolean;
  /** 版本组防分裂：用户在相似资产提示后明确选择"仍保存为新
   *  条目"时置 true，跳过相似闸门。 */
  forceCreateSimilar?: boolean;
  /** R-Box causal rule; only activated when explicitly supplied by the user. */
  causalRule?: CausalRule;
  /** Optional explicit personal-template destination selected during review. */
  profileTarget?: PersonalProfileTarget;
  /** 版本冲突后的**显式重锚**：调用方声明"我已看过候选判断**对版本 X 的差异**，按它
   *  重新确认"。与 `targetVersionUsed`（候选生成时冻下的锚，只读）不同，这个
   *  值来自用户看过差异之后，代表他这次认可哪一版。
   *
   *  主进程在 `updateAbilityAsset` **锁内**再核一次 `X === 当前在用版`（唯一
   *  一处比对）：不成立仍按结构化冲突返回（零改动），成立才准确保存用户
   *  重新核对过的完整建议，并在决定账本记 `rebasedFrom`（原锚，与 X 不同才记）。
   *  缺省 = 老行为（比 `targetVersionUsed`），存量候选的语义一个字不变。
   *  只对更新型候选（`update` / `limit_scope`）有意义（见
   *  `candidateVersionRecheckPlan`）。 */
  confirmBaselineVersion?: string;
}

const log = createLogger('recall.candidates');

/** 判重用的可比文本：与 capture-service 的同名归一化保持一致（大小写、
 *  空白、标点都不参与比较）。冲突表、inbox 待办分组、inbox 选边共用这一个
 *  口径，保持列表、待办与冲突处置的判定一致。 */
export function comparableJudgmentText(value: string): string {
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
    if (ref.kind !== 'conversation' || ref.subtype === 'message' || ids.includes(ref.id)) continue;
    ids.push(ref.id);
    if (ids.length >= MAX_SOURCE_SESSION_IDS) break;
  }
  return ids;
}

function boundedText(value: unknown, field: string, max: number, required = false, preserveLayout = false): string | undefined {
  if (typeof value !== 'string') {
    if (required) throw new Error(`missing ${field}`);
    return undefined;
  }
  const text = preserveLayout ? value.trim() : value.replace(/\s+/g, ' ').trim();
  if (!text) {
    if (required) throw new Error(`missing ${field}`);
    return undefined;
  }
  if (text.length > max) throw new Error(`${field} is too long`);
  return text;
}

/** Candidate bodies use the same normalization as persisted assets: line endings
 *  are canonicalized before the shared storage limit is applied. */
function boundedCandidateStatement(value: unknown): string {
  return boundedText(
    typeof value === 'string' ? normalizeStatementText(value) : value,
    'judgment',
    RECALL_TEXT_LIMITS.statement,
    true,
    true,
  )!;
}

function fallbackCandidateTitle(judgment: string): string {
  return makeDisplayTitle(judgment, /\p{Script=Han}/u.test(judgment) ? 16 : 60);
}

/** 晋升优先使用合规 summary；缺失或不符合最终正文的标题规则时，
 * 调用 suggestAbilityAssetTitle 生成并校验标题。模型不可用或输出仍不合规
 * 则明确失败，不截取正文替代标题，也不落盘半成品。
 * 动态 import 避免候选服务与模型链形成静态循环依赖。 */
async function resolvePromotionAssetTitle(
  userId: string,
  input: { preferredTitle: string; statement: string; type: AbilityAssetType; reviewedTitle?: boolean },
): Promise<string> {
  const statement = String(input.statement || '');
  if (input.reviewedTitle) {
    const { assertReviewedAbilityAssetTitle } = await import('./title-policy');
    assertReviewedAbilityAssetTitle(input.preferredTitle);
    return input.preferredTitle;
  }
  if (!recallTitleIssue(input.preferredTitle, statement)) return input.preferredTitle;
  const { suggestAbilityAssetTitle } = await import('./asset-title-suggestion');
  const suggested = await suggestAbilityAssetTitle(userId, {
    statement,
    type: input.type,
  });
  return suggested.title;
}

function requireAssetType(value: unknown): AbilityAssetType {
  if (value === 'cognition' || value === 'personal' || value === 'rule' || value === 'template' || value === 'skill_method' || value === 'fact') return value;
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
  // 历史语义重复候选的 superseded 读作 ignored；当前合并使用
  // mergedInto + decideWithoutAsset('ignored')，不再写入 superseded。
  if (value === 'superseded') return 'ignored';
  if (value === 'observed' || value === 'weak_observation' || value === 'pending_review'
    || value === 'deferred' || value === 'confirmed' || value === 'integrated' || value === 'rejected'
    || value === 'ignored' || value === 'expired' || value === 'failed') return value;
  throw new Error('malformed recall candidate');
}

function isTerminalCandidate(status: RecallCandidateStatus): boolean {
  return status === 'confirmed' || status === 'integrated' || status === 'rejected' || status === 'ignored' || status === 'expired';
}

function isSuppressedTerminalCandidate(status: RecallCandidateStatus): boolean {
  return status === 'integrated' || status === 'rejected' || status === 'ignored' || status === 'expired';
}


/** After purge the candidate body is cleared, so fingerprint dedupe misses the
 *  old row. Match the incoming text against live candidates (same hash) or the
 *  asset references retained by cleared candidates, then confirm the asset
 *  tombstone hash. Reads only referenced tombstones — no full asset listing. */
async function findConfirmedCandidateSuppressedByPurge(
  userId: string,
  judgment: string,
  knownCandidates: RecallCandidateRecord[],
): Promise<RecallCandidateRecord | undefined> {
  const text = String(judgment || '').trim();
  if (!text) return undefined;
  const { candidateTextHash } = await import('../personal_ontology_candidates');
  const hash = candidateTextHash(text);
  if (!hash) return undefined;

  const candidates = knownCandidates.filter((candidate) => {
    if (candidate.status !== 'confirmed' && candidate.status !== 'integrated') return false;
    if (!candidate.contentPurgedAt && candidateTextHash(candidate.judgment) !== hash) return false;
    return candidateAssetIds(candidate).length > 0;
  });
  if (!candidates.length) return undefined;

  const assets = new Map<string, RecallAbilityAssetRecord>();
  for (const assetId of [...new Set(candidates.flatMap(candidateAssetIds))]) {
    try { assets.set(assetId, await readAbilityAsset(userId, assetId)); } catch { /* missing tombstone cannot suppress */ }
  }
  const matches = candidates.filter((candidate) => candidateAssetIds(candidate).some((assetId) => {
    const asset = assets.get(assetId);
    return asset?.status === 'purged' && asset.purgedTextHash === hash;
  }));
  return matches.find((candidate) => candidate.contentPurgedAt) ?? matches[0];
}

function candidateAssetIds(candidate: RecallCandidateRecord): string[] {
  const ids = [
    candidate.promotedAssetId,
    ...(candidate.contentPurgedAt ? candidate.contentAssetIds || [] : []),
  ];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && safeId(id)))];
}


/** Serialize ontology handoff against normal candidate promotion/rejection. */
export function withRecallCandidateReviewLock<T>(userId: string, work: () => Promise<T>): Promise<T> {
  if (!safeId(userId)) throw new Error('invalid recall candidate owner');
  return fileEditLock(recallJsonRecordPath(userId, 'candidate-locks', 'promote')).runExclusive(work);
}

function normalizeOntologyHandoff(value: unknown): RecallCandidateOntologyHandoff | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed ontology candidate handoff');
  const raw = value as Partial<RecallCandidateOntologyHandoff>;
  if ((raw.status !== 'in_progress' && raw.status !== 'integrated') || !safeId(raw.commandId) || !Array.isArray(raw.moduleIds) || raw.moduleIds.length < 1 || raw.moduleIds.length > 20
    || raw.moduleIds.some(id => !safeId(id)) || new Set(raw.moduleIds).size !== raw.moduleIds.length
    || !Array.isArray(raw.recordIds) || raw.recordIds.length < 1 || raw.recordIds.length > 100
    || raw.recordIds.some(id => !safeId(id)) || new Set(raw.recordIds).size !== raw.recordIds.length
    || !Number.isSafeInteger(raw.ontologyRevision) || Number(raw.ontologyRevision) < 1) {
    throw new Error('malformed ontology candidate handoff');
  }
  return { status: raw.status, commandId: raw.commandId, moduleIds: [...raw.moduleIds], recordIds: [...raw.recordIds],
    ontologyRevision: Number(raw.ontologyRevision), committedAt: requireIsoTimestamp(raw.committedAt, 'ontology handoff committed at') };
}

export function isAutoCaptureEligible(candidate: Pick<RecallCandidateRecord, 'status' | 'contentPurgedAt'>): boolean {
  return !candidate.contentPurgedAt && (candidate.status === 'pending_review' || candidate.status === 'failed');
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
  if (value.contentPurgedAt !== undefined) {
    const at = requireIsoTimestamp(value.contentPurgedAt, 'candidate content purge');
    return {
      ...purgedOrganizationRecord('candidates', value, at),
      status: normalizeCandidateStatus(value.status),
      suggestedType: requireAssetType(value.suggestedType),
      suggestedAction: requireCandidateAction(value.suggestedAction),
      risk: requireCandidateRisk(value.risk),
      contentFormatVersion: 1, taxonomyVersion: 2,
      createdAt: requireIsoTimestamp(value.createdAt, 'candidate created at'),
      updatedAt: requireIsoTimestamp(value.updatedAt, 'candidate updated at'),
      expiresAt: requireIsoTimestamp(value.expiresAt, 'candidate expiry', new Date(Date.parse(String(value.createdAt)) + DEFAULT_CANDIDATE_TTL_MS).toISOString()),
      summary: t('cognition.content_purged'), judgment: '',
    } as RecallCandidateRecord;
  }
  if (value.proposalTarget !== undefined && !['cognition', 'ontology', 'joint'].includes(String(value.proposalTarget)))
    throw new Error('malformed formation proposal target');
  if (value.formationProposalId !== undefined && (!safeId(value.formationProposalId) || String(value.formationProposalId).length > 160))
    throw new Error('malformed formation proposal identity');
  if (value.proposalTarget === 'ontology' && (!value.ontologyFormation || value.promotedAssetId || value.targetAssetId))
    throw new Error('malformed ontology-only candidate');
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
    && (value as { origin?: unknown }).origin !== 'manual' && !normalizeStockOrganizationProvenance(value.stockOrganizationProvenance) && !value.contentOrganization) {
    throw new Error('malformed recall candidate evidence');
  }
  const learningSignal = normalizeLearningSignal(value.learningSignal);
  const learningProvenance = normalizeLearningProvenance(value.learningProvenance);
  const scopePolicy = normalizeAbilityAssetScopePolicy(value.scopePolicy);
  const ontologyHandoff = normalizeOntologyHandoff(value.ontologyHandoff);
  const captureProvenance = normalizeCaptureProvenance(value.captureProvenance);
  const humanInstructionProvenance = normalizeHumanInstructionProvenance(value.humanInstructionProvenance);
  const stockOrganizationProvenance = normalizeStockOrganizationProvenance(value.stockOrganizationProvenance);
  if ([captureProvenance, humanInstructionProvenance, stockOrganizationProvenance].filter(Boolean).length > 1) throw new Error('ambiguous candidate formation origin');
  if ((status === 'integrated') !== (ontologyHandoff?.status === 'integrated')
    || (ontologyHandoff?.status === 'in_progress' && isTerminalCandidate(status))) {
    throw new Error('malformed recall candidate ontology handoff state');
  }
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
    ? boundedText(value.value, 'legacy evidence summary', RECALL_TEXT_LIMITS.evidenceSummary)
    : undefined;
  const evidenceSummary = typeof value.evidenceSummary === 'string'
    ? boundedText(value.evidenceSummary, 'candidate evidence summary', RECALL_TEXT_LIMITS.evidenceSummary)
    : legacyBubbleEvidence;
  const candidateSummary = boundedText(value.summary, 'candidate summary', RECALL_TEXT_LIMITS.summary)
    || fallbackCandidateTitle(String(value.judgment || ''));
  const candidateValue = (stockOrganizationProvenance || value.contentOrganization) && value.value === undefined ? undefined : Object.prototype.hasOwnProperty.call(value, 'value')
    ? (legacyBubbleEvidence ? '' : boundedText(value.value, 'candidate value', RECALL_TEXT_LIMITS.value, false, true) || '')
    : stockOrganizationProvenance ? undefined : value.judgment;
  return {
    ...value,
    contentFormatVersion: 1,
    taxonomyVersion: 2,
    ontologyFormation: normalizeOntologyFormationPlan(value.ownerId, value.id, value.ontologyFormation),
    status,
    value: candidateValue,
    summary: candidateSummary,
    ...(evidenceSummary ? { evidenceSummary } : {}),
    ...(value.contentCategory !== undefined ? { contentCategory: readContentCategory(value.contentCategory) } : {}),
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
    ...(ontologyHandoff ? { ontologyHandoff } : {}),
    ...(captureProvenance ? { captureProvenance } : {}),
    ...(humanInstructionProvenance ? { humanInstructionProvenance } : {}),
    ...(stockOrganizationProvenance ? { stockOrganizationProvenance } : {}),
    ...(origin ? { origin } : {}),
    // 读时重新派生正文警示，不落盘、不拦截写入。
    // 显式覆盖旧 statementIssues，保证正文更改后陈旧警示能够清除。
    ...(recallStatementIssues({ statement: value.judgment, type: value.suggestedType }).length
      ? { statementIssues: recallStatementIssues({ statement: value.judgment, type: value.suggestedType }) }
      : { statementIssues: undefined }),
  } as RecallCandidateRecord;
}

/** 候选来源的惰性推导（读时附加、不落盘、零迁移）：KStar 溯源最硬，其次
 *  captureKey 前缀，再次教学信号引用；兜底 capture（复盘/整理/capture 线
 *  统称）。旧记录读了就有 origin，新写入不改盘上形状。 */
function deriveCandidateOrigin(
  value: RecallJsonRecord,
  hasLearningProvenance: boolean,
): 'kstar' | 'teaching' | 'capture' | 'manual' | 'human_instruction' | 'stock_organization' | 'organization' | undefined {
  if (value.contentOrganization) return 'organization';
  if (value.stockOrganizationProvenance) return 'stock_organization';
  if (value.humanInstructionProvenance) return 'human_instruction';
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
  // Legacy saved content may have no recorded original source. Read it without
  // manufacturing evidence; new creation still requires its existing provenance gate.
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
  & Pick<RecallCandidateRecord, 'scopePolicy' | 'spaceId' | 'proposalTarget' | 'ontologyFormation'>): string {
  const scopePolicy = scopePolicyIdentity(input.scopePolicy);
  return [input.judgment, input.value ?? '', input.suggestedType, input.suggestedScope, input.suggestedAction, input.targetAssetId || '']
    .map((part) => part.trim().toLocaleLowerCase())
    .concat([input.spaceId || '', scopePolicy, input.proposalTarget || 'cognition',
      input.ontologyFormation ? JSON.stringify({ actions: input.ontologyFormation.actions, refs: input.ontologyFormation.refs }) : ''])
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

export function candidateIdForCaptureKey(captureKey: string): string {
  return `cand-${createHash('sha256').update(captureKey).digest('hex').slice(0, 24)}`;
}

/** Recover a completed capture submission, including one deduplicated into an
 * existing candidate. The receipt holds identity only, not candidate content. */
export async function findCaptureCandidateReceipt(userId: string, captureKey: string): Promise<RecallCandidateRecord | undefined> {
  if (!safeId(captureKey) || captureKey.length > 160) throw new Error('invalid capture key');
  const receipt = await readRecallJsonRecord(userId, 'capture-candidate-receipts', candidateIdForCaptureKey(captureKey));
  if (receipt) {
    if (receipt.captureKey !== captureKey || typeof receipt.candidateId !== 'string' || !safeId(receipt.candidateId))
      throw new Error('invalid capture candidate receipt');
    return readRecallCandidate(userId, receipt.candidateId);
  }
  // Unlike the user-facing list, receipt recovery cannot skip malformed rows:
  // one of them may contain the only record of a committed deduplication.
  const reader = createRecallCollectionReader(userId, 'candidates');
  let ids: string[];
  if (reader.ids) {
    ids = reader.ids;
    if (ids.some(id => !safeId(id))) throw new Error('invalid candidate identity during capture receipt recovery');
  } else {
    let names: string[];
    try { names = await fs.readdir(candidateDirectory(userId)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const files = names.filter(name => name.endsWith('.json'));
    ids = files.map(name => name.slice(0, -5));
    if (ids.some(id => !safeId(id))) throw new Error('invalid candidate identity during capture receipt recovery');
  }
  const candidates = await Promise.all(ids.map(async id => {
    const record = await reader.read(id);
    if (!record) throw new Error('candidate disappeared during capture receipt recovery');
    return asCandidate(record);
  }));
  return candidates.find(candidate => candidate.captureKey === captureKey
    || Array.isArray(candidate.captureReceiptKeys) && candidate.captureReceiptKeys.includes(captureKey));
}

async function recordCaptureCandidateReceipt(userId: string, captureKey: string | undefined, candidateId: string): Promise<void> {
  if (!captureKey) return;
  const id = candidateIdForCaptureKey(captureKey);
  await updateRecallJsonRecord(userId, 'capture-candidate-receipts', id, current => {
    if (current && (current.captureKey !== captureKey || current.candidateId !== candidateId))
      throw new Error('capture candidate receipt conflicts with saved result');
    return current || { schemaVersion: 1, ownerId: userId, id, captureKey, candidateId };
  });
}

export async function listRecallCandidates(userId: string): Promise<RecallCandidateRecord[]> {
  let names: string[];
  const reader = createRecallCollectionReader(userId, 'candidates');
  const unifiedIds = reader.ids;
  try { names = unifiedIds ? unifiedIds.map(id => `${id}.json`) : await fs.readdir(candidateDirectory(userId)); }
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
      return { id, record: await reader.read(id) };
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

/** 启动期候选记录维护：内容格式规范化 + 旧「稍后处理」退役。
 *
 * 迁移不再挂在 listRecallCandidates 上——读路径不做写迁移。每条候选都有
 * 独立进度；失败下次启动重试；内容超契约或记录自身无法规范化时记为
 * blocked 并保存指纹，内容未变不反复尝试。旧聚合标记只作为退役策略的时间
 * 截断依据，不再能让未迁移记录永久隐身。 */
function candidateMigrationFingerprint(record: RecallJsonRecord): string {
  return createHash('sha256').update(JSON.stringify({
    judgment: record.judgment,
    value: record.value,
    evidenceSummary: record.evidenceSummary,
    contentFormatVersion: record.contentFormatVersion,
    taxonomyVersion: record.taxonomyVersion,
    summary: record.summary,
    evidenceRefs: record.evidenceRefs,
    status: record.status,
    failureCode: record.failureCode,
    updatedAt: record.updatedAt,
  })).digest('hex');
}

async function candidateIdsForMaintenance(userId: string): Promise<string[]> {
  const reader = createRecallCollectionReader(userId, 'candidates');
  if (reader.ids !== undefined) return [...new Set(reader.ids.filter(safeId))].sort();
  let names: string[];
  try { names = await fs.readdir(candidateDirectory(userId)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map((name) => name.slice(0, -5))
    .sort();
}

function readCandidateMigrationEntries(journal: RecallJsonRecord | undefined): Record<string, CandidateRecordMigrationEntry> {
  const raw = journal?.entries;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries: Record<string, CandidateRecordMigrationEntry> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!safeId(id) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const status = String(row.status || '');
    if (!['applied', 'current', 'failed', 'blocked', 'missing'].includes(status)) continue;
    entries[id] = {
      status: status as CandidateRecordMigrationStatus,
      attempts: Number.isFinite(Number(row.attempts)) ? Number(row.attempts) : 0,
      at: typeof row.at === 'string' ? row.at : new Date(0).toISOString(),
      ...(typeof row.fingerprint === 'string' ? { fingerprint: row.fingerprint } : {}),
      ...(typeof row.error === 'string' ? { error: row.error } : {}),
    };
  }
  return entries;
}

/** Presence and `undefined` are equivalent for optional content fields. */
function candidateNeedsContentFormatMigration(raw: RecallJsonRecord, normalized: RecallCandidateRecord): boolean {
  const hasStoredValue = Object.prototype.hasOwnProperty.call(raw, 'value');
  const valueMatches = hasStoredValue ? isDeepStrictEqual(raw.value, normalized.value) : normalized.value === undefined;
  return raw.contentFormatVersion !== 1
    || raw.taxonomyVersion !== 2
    || raw.summary !== normalized.summary
    || !valueMatches
    || !Array.isArray(raw.evidenceRefs);
}

function userDeferredRetirementCutoff(marker: RecallJsonRecord | undefined): number | undefined {
  const at = typeof marker?.at === 'string' ? Date.parse(marker.at) : Number.NaN;
  return Number.isFinite(at) ? at : undefined;
}

/** Only deferrals that already existed when the old one-shot policy ran are
 *  retired; a later user deferral must stay deferred. */
function shouldRetireUserDeferredCandidate(raw: RecallJsonRecord, cutoffMs: number | undefined): boolean {
  if (cutoffMs === undefined || normalizeCandidateStatus(raw.status) !== 'deferred') return false;
  if (raw.failureCode === 'semantic_review_flagged') return false;
  const updatedAt = typeof raw.updatedAt === 'string' ? Date.parse(raw.updatedAt) : Number.NaN;
  return Number.isFinite(updatedAt) && updatedAt <= cutoffMs;
}

class CandidateRecordBlockedError extends Error {
  constructor(message: string, readonly fingerprint: string) {
    super(message);
    this.name = 'CandidateRecordBlockedError';
  }
}

function assertCandidateContentWithinContract(record: RecallJsonRecord): void {
  for (const [field, value] of [
    ['statement', record.judgment],
    ['value', record.value],
    ['evidenceSummary', record.evidenceSummary],
  ] as const) {
    if (typeof value === 'string' && contentExceedsContract(value, field)) {
      throw new CandidateRecordBlockedError(
        `${field} exceeds ${RECALL_TEXT_LIMITS[field]} characters`,
        candidateMigrationFingerprint(record),
      );
    }
  }
}

async function migrateOneCandidateRecord(
  userId: string,
  candidateId: string,
  retirementCutoffMs: number | undefined,
): Promise<{ status: CandidateRecordMigrationEntry['status']; fingerprint?: string }> {
  const raw = await readRecallJsonRecord(userId, 'candidates', candidateId);
  if (!raw) return { status: 'missing' };
  assertCandidateContentWithinContract(raw);
  let normalized: RecallCandidateRecord;
  try {
    normalized = asCandidate(raw);
  } catch (error) {
    throw new CandidateRecordBlockedError(
      error instanceof Error ? error.message : String(error),
      candidateMigrationFingerprint(raw),
    );
  }
  const retire = shouldRetireUserDeferredCandidate(raw, retirementCutoffMs);
  if (!candidateNeedsContentFormatMigration(raw, normalized) && !retire) {
    return { status: 'current', fingerprint: candidateMigrationFingerprint(raw) };
  }
  let fingerprint = candidateMigrationFingerprint(raw);
  await updateRecallJsonRecord(userId, 'candidates', candidateId, (current) => {
    if (!current) throw new Error('recall candidate disappeared during boot migration');
    assertCandidateContentWithinContract(current);
    let latest: RecallCandidateRecord;
    try {
      latest = asCandidate(current);
    } catch (error) {
      throw new CandidateRecordBlockedError(
        error instanceof Error ? error.message : String(error),
        candidateMigrationFingerprint(current),
      );
    }
    const next = shouldRetireUserDeferredCandidate(current, retirementCutoffMs)
      ? { ...latest, status: 'pending_review' as const, cooldownUntil: undefined, updatedAt: new Date().toISOString() }
      : latest;
    fingerprint = candidateMigrationFingerprint(next);
    return next;
  });
  return { status: 'applied', fingerprint };
}

/** Boot maintenance entry. The caller owns uid/signal; per-record failures are
 *  recorded and retried on the next boot, and progress is persisted after every
 *  record. */
export async function runCandidateRecordMigrations(userId: string, signal?: AbortSignal): Promise<void> {
  const lock = fileEditLock(recallJsonRecordPath(userId, 'candidate-locks', CANDIDATE_RECORD_MIGRATION_ID));
  await lock.runExclusive(async () => {
    const existing = await readRecallJsonRecord(userId, 'candidate-migrations', CANDIDATE_RECORD_MIGRATION_ID) as CandidateRecordMigrationJournal | undefined;
    const entries = readCandidateMigrationEntries(existing);
    const ids = await candidateIdsForMaintenance(userId);
    const idSet = new Set(ids);
    const retirementMarker = await readRecallJsonRecord(userId, 'candidate-migrations', USER_DEFER_RETIRED_MIGRATION_ID);
    const retirementCutoffMs = userDeferredRetirementCutoff(retirementMarker);
    const startedAt = existing?.startedAt || new Date().toISOString();
    let dirty = !existing;
    const counts: Record<CandidateRecordMigrationStatus, number> = { applied: 0, current: 0, failed: 0, blocked: 0, missing: 0 };

    const persist = async (completedAt?: string) => {
      const journal: CandidateRecordMigrationJournal = {
        schemaVersion: 1,
        ownerId: userId,
        id: CANDIDATE_RECORD_MIGRATION_ID,
        startedAt,
        updatedAt: new Date().toISOString(),
        ...(completedAt ? { completedAt } : {}),
        entries,
      };
      await writeRecallJsonRecord(userId, 'candidate-migrations', CANDIDATE_RECORD_MIGRATION_ID, journal);
    };

    // A failed/blocked entry whose record left the authoritative collection is resolved.
    for (const id of Object.keys(entries)) {
      if (idSet.has(id)) continue;
      const entry = entries[id];
      if (entry.status === 'failed' || entry.status === 'blocked') {
        entries[id] = { ...entry, status: 'missing', at: new Date().toISOString() };
        dirty = true;
      }
    }

    for (const id of ids) {
      if (signal?.aborted) break;
      const entry = entries[id];
      if (entry && ['applied', 'current', 'missing'].includes(entry.status)) {
        counts[entry.status] += 1;
        continue;
      }
      try {
        if (entry?.status === 'blocked') {
          const raw = await readRecallJsonRecord(userId, 'candidates', id);
          if (!raw) {
            entries[id] = { ...entry, status: 'missing', at: new Date().toISOString() };
            counts.missing += 1;
            dirty = true;
            await persist();
            continue;
          }
          if (entry.fingerprint && entry.fingerprint === candidateMigrationFingerprint(raw)) {
            counts.blocked += 1;
            continue;
          }
        }
        const result = await migrateOneCandidateRecord(userId, id, retirementCutoffMs);
        entries[id] = {
          status: result.status,
          attempts: (entry?.attempts ?? 0) + 1,
          at: new Date().toISOString(),
          ...(result.fingerprint ? { fingerprint: result.fingerprint } : {}),
        };
        counts[result.status] += 1;
      } catch (error) {
        const at = new Date().toISOString();
        if (error instanceof CandidateRecordBlockedError) {
          entries[id] = {
            status: 'blocked',
            attempts: (entry?.attempts ?? 0) + 1,
            at,
            fingerprint: error.fingerprint,
            error: error.message.slice(0, 1_000),
          };
          counts.blocked += 1;
        } else if (error instanceof ContentContractError) {
          const raw = await readRecallJsonRecord(userId, 'candidates', id).catch(() => undefined);
          entries[id] = {
            status: 'blocked',
            attempts: (entry?.attempts ?? 0) + 1,
            at,
            ...(raw ? { fingerprint: candidateMigrationFingerprint(raw) } : {}),
            error: error.message,
          };
          counts.blocked += 1;
        } else {
          entries[id] = {
            status: 'failed',
            attempts: (entry?.attempts ?? 0) + 1,
            at,
            error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
          };
          counts.failed += 1;
          log.warn('candidate boot migration failed for one record', { candidateId: id, error: (error as Error).message });
        }
      }
      dirty = true;
      await persist();
    }

    const hasRetryable = Object.values(entries).some((entry) => entry.status === 'failed');
    if (dirty) await persist(hasRetryable ? undefined : new Date().toISOString());
    log.info('candidate record maintenance complete', { ...counts, aborted: signal?.aborted === true });
  });
}

export async function readRecallCandidate(userId: string, candidateId: string): Promise<RecallCandidateRecord> {
  const record = await readRecallJsonRecord(userId, 'candidates', candidateId);
  if (!record) throw recallCandidateError('recall_candidate_not_found', 'recall candidate not found');
  return asCandidate(record);
}

export async function saveRecallCandidate(userId: string, input: SaveRecallCandidateInput): Promise<RecallCandidateRecord> {
  if (input.manual === true || input.learningSignal !== undefined || input.learningProvenance !== undefined) {
    throw new Error('retired candidate producer cannot create a nightly suggestion');
  }
  if (input.contentOrganization) await verifyContentOrganization(userId, input, true);
  else if (input.stockOrganizationProvenance) await verifyStockOrganizationCandidate(userId, input, { newWrite: true });
  else if (input.humanInstructionProvenance) await verifyHumanInstructionCandidate(userId, input, { newWrite: true });
  else await verifyCaptureProvenanceForWrite(userId, input.captureProvenance, normalizeCognitionSourceRefsForWrite(input.sourceRefs));
  // 机器生成的正文先经 candidate-statement-gate 规范化。
  // 模型调用必须在文件锁外，避免阻塞候选池写入。
  const gatedJudgment = await gateCandidateStatement(userId, {
    judgment: input.judgment,
    suggestedType: requireAssetType(input.suggestedType),
    skip: Boolean(input.contentOrganization) || Boolean(input.stockOrganizationProvenance) || input.rawStatement === true || input.proposalTarget === 'ontology',
  });
  const gatedInput = gatedJudgment === input.judgment ? input : { ...input, judgment: gatedJudgment,
    ...(input.ontologyFormation ? { ontologyFormation: { ...input.ontologyFormation,
      blockedReasons: [...new Set([...input.ontologyFormation.blockedReasons, 'candidate_edited_requires_ontology_review'])] } } : {}) };
  const lockPath = recallJsonRecordPath(userId, 'candidate-locks', 'save');
  return withCognitionTransition(userId, () => fileEditLock(lockPath).runExclusive(() => saveRecallCandidateUnlocked(userId, gatedInput)));
}

async function saveRecallCandidateUnlocked(userId: string, input: SaveRecallCandidateInput): Promise<RecallCandidateRecord> {
  if (input.proposalTarget !== undefined && !['cognition', 'ontology', 'joint'].includes(input.proposalTarget)) throw new Error('invalid formation target');
  if (input.formationProposalId !== undefined && (!safeId(input.formationProposalId) || input.formationProposalId.length > 160)) throw new Error('invalid formation identity');
  if (input.proposalTarget === 'joint' && !input.ontologyFormation) throw new Error('joint suggestion requires ontology changes');
  if (input.proposalTarget === 'ontology' && (!input.ontologyFormation || (!input.ontologyFormation.actions.length && !input.ontologyFormation.blockedReasons.length) || input.targetAssetId
    || input.targetVersionUsed || input.ontologyFormation.refs.some(ref => ref.sharedBody))) throw new Error('invalid ontology-only suggestion');
  const judgment = boundedCandidateStatement(input.judgment);
  // value 缺省取 judgment 全文，因此两者使用相同的长度上限。
  const value = boundedText(input.value, 'value', RECALL_TEXT_LIMITS.value, false, true);
  const evidenceSummary = boundedText(input.evidenceSummary, 'evidence summary', RECALL_TEXT_LIMITS.evidenceSummary);
  const summary = boundedText(input.summary, 'summary', RECALL_TEXT_LIMITS.summary) || fallbackCandidateTitle(judgment);
  const uncertainty = boundedText(input.uncertainty, 'uncertainty', RECALL_TEXT_LIMITS.uncertainty);
  const suggestedScope = boundedText(input.suggestedScope, 'suggested scope', RECALL_TEXT_LIMITS.scope) || '';
  const scopePolicy = normalizeAbilityAssetScopePolicy(input.scopePolicy);
  const sourceRefs = normalizeCognitionSourceRefsForWrite(input.sourceRefs);
  const evidenceRefs = normalizeCognitionSourceRefsForWrite(input.evidenceRefs || input.sourceRefs);
  const contentCategory = input.contentCategory === undefined ? undefined : requireContentCategory(input.contentCategory);
  const suggestedType = requireAssetType(input.suggestedType);
  const humanInstructionProvenance = input.humanInstructionProvenance
    ? await verifyHumanInstructionCandidate(userId, input, { newWrite: true }) : undefined;
  const stockOrganizationProvenance = input.stockOrganizationProvenance
    ? await verifyStockOrganizationCandidate(userId, input, { newWrite: true }) : undefined;
  if (input.contentOrganization) await verifyContentOrganization(userId, input, true);
  const captureProvenance = input.contentOrganization || humanInstructionProvenance || stockOrganizationProvenance ? undefined : await verifyCaptureProvenanceForWrite(userId, input.captureProvenance, sourceRefs);
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
    captureProvenance ? JSON.stringify(captureProvenance) : undefined,
    input.formationComparison ? JSON.stringify(input.formationComparison) : undefined,
  ]);
  const captureKey = input.captureKey === undefined
    ? undefined
    : boundedText(input.captureKey, 'capture key', 160, true);
  const persistedOrigin = input.contentOrganization ? 'organization' as const : stockOrganizationProvenance ? 'stock_organization' as const : humanInstructionProvenance ? 'human_instruction' as const : 'capture' as const;
  if (captureKey && !safeId(captureKey)) throw new Error('invalid capture key');
  if (humanInstructionProvenance && (!captureKey || candidateIdForCaptureKey(captureKey) !== humanInstructionProvenance.candidateId)) throw new Error('human creation candidate identity mismatch');
  // One pool snapshot serves the captureKey resume, fingerprint dedupe and the
  // purge-suppression lookup; this path holds the save lock and writes nothing
  // to the pool before those reads.
  const knownCandidates = await listRecallCandidates(userId);
  if (captureKey) {
    const captured = knownCandidates.find((candidate) => candidate.captureKey === captureKey
      || Array.isArray(candidate.captureReceiptKeys) && candidate.captureReceiptKeys.includes(captureKey));
    if (captured) return captured;
    if (captureProvenance) {
      const receipt = await readRecallJsonRecord(userId, 'capture-candidate-receipts', candidateIdForCaptureKey(captureKey));
      if (receipt) {
        if (receipt.captureKey !== captureKey || typeof receipt.candidateId !== 'string' || !safeId(receipt.candidateId))
          throw new Error('invalid capture candidate receipt');
        return readRecallCandidate(userId, receipt.candidateId);
      }
    }
  }
  const now = new Date().toISOString();
  // value 缺省取正文 judgment，不把标题 summary 拼入资产正文。
  // promote 会去掉与 judgment 重复的 value，调用方无需存两份正文。
  const resolvedValue = hasExplicitValue ? (value || '') : stockOrganizationProvenance || input.contentOrganization ? undefined : judgment;
  const expiresAt = requireIsoTimestamp(input.expiresAt, 'candidate expiry', new Date(Date.parse(now) + DEFAULT_CANDIDATE_TTL_MS).toISOString());
  const taskRunId = input.taskRunId === undefined ? undefined : boundedText(input.taskRunId, 'task run id', 160, true);
  if (taskRunId && !safeId(taskRunId)) throw new Error('invalid task run id');
  const targetAssetId = input.targetAssetId === undefined ? undefined : boundedText(input.targetAssetId, 'target asset id', 160, true);
  if (targetAssetId && !safeId(targetAssetId)) throw new Error('invalid target asset id');
  const targetVersionUsed = input.targetVersionUsed === undefined ? undefined : boundedText(input.targetVersionUsed, 'target version used', 16, true);
  const parsedComparison = input.formationComparison
    ? formationComparisonSchema.parse(Object.fromEntries(Object.entries(input.formationComparison).filter(([key]) => key !== 'coverage'))) : undefined;
  if (parsedComparison?.relatedAssets && (parsedComparison.relatedAssets.length < 2 || parsedComparison.relatedAssets.length > 6))
    throw new Error('related asset group requires two to six reviewed targets');
  const formationComparison = parsedComparison ? { ...parsedComparison, coverage: input.formationComparison!.coverage,
    ...(parsedComparison.relatedAssets ? { relatedAssets: parsedComparison.relatedAssets.map(({ assetId, version }) => ({ assetId, version })) } : {}) } : undefined;
  // 提取阶段保留规则候选的适用/禁止范围，使用与资产相同的规范化和敏感内容校验。
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
    ...(input.proposalTarget ? { proposalTarget: input.proposalTarget } : {}),
    ...(input.ontologyFormation ? { ontologyFormation: input.ontologyFormation } : {}),
    ...(input.spaceId && safeId(input.spaceId) ? { spaceId: input.spaceId } : {}),
    ...(scopePolicy ? { scopePolicy } : {}),
  };
  const reviewReady = input.forceWeakObservation !== true
    && (Boolean(input.contentOrganization) || Boolean(stockOrganizationProvenance) || Boolean(resolvedValue))
    && hasReviewableCandidateEvidence({ origin: persistedOrigin, contentOrganization: input.contentOrganization, stockOrganizationProvenance, sourceRefs, evidenceRefs })
    && Boolean(suggestedScope) && (hasExplicitAction || !hasExplicitValue)
    && (!candidateActionNeedsTarget(suggestedAction) || Boolean(targetAssetId));
  const existing = knownCandidates.find((candidate) => {
    if (input.contentOrganization || candidate.contentOrganization || stockOrganizationProvenance || candidate.stockOrganizationProvenance) return false;
    if (humanInstructionProvenance) return false; // Only its exact captureKey may resume a reviewed human creation.
    // Retired manual/teaching waits must not absorb a freshly completed nightly suggestion.
    if (captureProvenance && !isTerminalCandidate(candidate.status)
      && (candidate.origin !== 'capture' || candidate.captureProvenance?.captureId !== captureProvenance.captureId)) return false;
    if (fingerprint(candidate) !== fingerprint(candidateDraft)) return false;
    const hasNewEvidence = hasNewSourceRefs(candidate.evidenceRefs, evidenceRefs);
    const riskIncreased = maxCandidateRisk(candidate.risk, risk) !== candidate.risk;
    if (isSuppressedTerminalCandidate(candidate.status)) return !hasNewEvidence && !riskIncreased;
    if (['confirmed', 'integrated'].includes(candidate.status)) return !riskIncreased;
    return true;
  });
  if (existing) {
    // 相同内容命中既有候选（追加依据而非新增近义资产）：夜间统计记账。
    void bumpRecallCaptureStats(userId, { duplicatesSuppressed: 1 }).catch(() => {
      // 统计失败不影响候选合并主流程。
    });
    // Extraction may recognize an already saved idea, but it cannot append
    // evidence to its formal asset or rewrite the committed candidate proof.
    if (['confirmed', 'integrated'].includes(existing.status)) {
      if (captureProvenance) await recordCaptureCandidateReceipt(userId, captureKey, existing.id);
      return existing;
    }
    const merged = await updateRecallJsonRecord(userId, 'candidates', existing.id, (current) => {
      if (!current) return existing;
      const candidate = asCandidate(current);
      if (['confirmed', 'integrated'].includes(candidate.status)) return candidate;
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
        ...(captureProvenance && captureKey ? { captureReceiptKeys: [...new Set([...(candidate.captureReceiptKeys || []), captureKey])] } : {}),
        sourceRefs: mergeSourceRefs(candidate.sourceRefs, sourceRefs),
        evidenceRefs: mergeSourceRefs(candidate.evidenceRefs, evidenceRefs),
        risk: maxCandidateRisk(candidate.risk, risk),
        ...(captureProvenance ? { captureProvenance } : {}),
        ...(input.ontologyFormation ? { ontologyFormation: normalizeOntologyFormationPlan(userId, candidate.id, bindOntologyFormationPlan(candidate.id, input.ontologyFormation)) } : {}),
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
  // Purge clears candidate judgment, so fingerprint dedupe cannot see the old
  // confirmed row. Match the asset tombstone hash and keep returning that
  // identity instead of resurrecting a pending_review for the same text.
  if (!input.contentOrganization && !stockOrganizationProvenance && !humanInstructionProvenance) {
    const suppressed = await findConfirmedCandidateSuppressedByPurge(userId, judgment, knownCandidates);
    if (suppressed) {
      void bumpRecallCaptureStats(userId, { duplicatesSuppressed: 1 }).catch(() => {
        // 统计失败不影响清除后同文压制。
      });
      if (captureProvenance) await recordCaptureCandidateReceipt(userId, captureKey, suppressed.id);
      return suppressed;
    }
  }
  const record: RecallCandidateRecord = {
    schemaVersion: 1,
    contentFormatVersion: 1,
    taxonomyVersion: 2,
    ownerId: userId,
    id: captureKey ? candidateIdForCaptureKey(captureKey) : `cand-${genId12()}`,
    ...(input.proposalTarget ? { proposalTarget: input.proposalTarget } : {}),
    ...(input.formationProposalId ? { formationProposalId: input.formationProposalId } : {}),
    status: reviewReady ? 'pending_review' : 'weak_observation',
    judgment,
    value: resolvedValue,
    summary,
    ...(evidenceSummary ? { evidenceSummary } : {}),
    ...(uncertainty ? { uncertainty } : {}),
    ...(contentCategory !== undefined ? { contentCategory } : {}),
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
    ...(input.contentOrganization ? { contentOrganization: input.contentOrganization } : {}),
    ...(captureProvenance ? { captureProvenance } : {}),
    ...(humanInstructionProvenance ? { humanInstructionProvenance } : {}),
    ...(stockOrganizationProvenance ? { stockOrganizationProvenance } : {}),
    // 写入侧显式落 origin：新记录落盘即带统一
    // 来源标记，读时推导只服务旧记录；与推导规则同源（provenance > 前缀 >
    // 教学引用 > capture），两处规则由 deriveCandidateOrigin 单点维护。
    ...(persistedOrigin ? { origin: persistedOrigin } : {}),
    ...(input.spaceId && safeId(input.spaceId) ? { spaceId: input.spaceId } : {}),
    ...(scopePolicy ? { scopePolicy } : {}),
    ...(taskRunId ? { taskRunId } : {}),
    ...(targetAssetId ? { targetAssetId } : {}),
    ...(targetVersionUsed ? { targetVersionUsed } : {}),
    ...(formationComparison ? { formationComparison } : {}),
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };
  if (input.ontologyFormation) record.ontologyFormation = normalizeOntologyFormationPlan(userId, record.id, bindOntologyFormationPlan(record.id, input.ontologyFormation));
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

/** Partial ontology commits must finish through their existing handoff. */
function assertCandidateNotInOntologyHandoff(candidate: RecallCandidateRecord): void {
  if (candidate.ontologyHandoff?.status === 'in_progress') {
    throw recallCandidateError('recall_candidate_handoff_incomplete',
      'candidate has an incomplete ontology handoff; continue ontology review before another decision');
  }
}

/** Find the existing confirmation even if a process stopped before saving its ID. */
async function readCandidateConfirmationDecision(userId: string, candidate: RecallCandidateRecord): Promise<ReviewDecision | undefined> {
  const targetRef = `recall_candidate:${candidate.id}`;
  if (candidate.reviewDecisionId) return readReviewDecision(userId, targetRef, candidate.reviewDecisionId);
  const key = confirmationIdempotencyKey(candidate);
  const matches = (await listReviewDecisions(userId, targetRef)).filter(entry =>
    entry.idempotency_key === key || entry.idempotency_key === `automatic-${key}`);
  // A system commit can precede the final candidate write. Protect that handoff
  // from edits/rejections even when its decision ID was not stored yet.
  for (const decision of matches) {
    if (await readAppliedHandoffAsset(userId, candidate, decision.decision_id)) return decision;
  }
  return matches.find(entry => entry.asset_id || entry.outcome === 'asset_created') || matches[0];
}

/** Once content was committed, only confirmation recovery can close this review. */
async function assertCandidateHasNoAppliedHandoff(userId: string, candidate: RecallCandidateRecord): Promise<void> {
  const decision = await readCandidateConfirmationDecision(userId, candidate);
  if (decision && await readAppliedHandoffAsset(userId, candidate, decision.decision_id)) {
    throw recallCandidateError('recall_candidate_handoff_incomplete',
      'candidate has an incomplete asset handoff; retry confirmation before another decision');
  }
}

export async function updateRecallCandidate(userId: string, candidateId: string, input: SaveRecallCandidateInput): Promise<RecallCandidateRecord> {
  const judgment = boundedCandidateStatement(input.judgment);
  // value 缺省取 judgment 全文，因此两者使用相同的长度上限。
  const value = boundedText(input.value, 'value', RECALL_TEXT_LIMITS.value, false, true);
  const summary = boundedText(input.summary, 'summary', RECALL_TEXT_LIMITS.summary) || fallbackCandidateTitle(judgment);
  const uncertainty = boundedText(input.uncertainty, 'uncertainty', RECALL_TEXT_LIMITS.uncertainty);
  const suggestedScope = boundedText(input.suggestedScope, 'suggested scope', RECALL_TEXT_LIMITS.scope) || '';
  const contentCategory = input.contentCategory === undefined ? undefined : requireContentCategory(input.contentCategory);
  const suggestedType = requireAssetType(input.suggestedType);
  const sourceRefs = normalizeCognitionSourceRefsForWrite(input.sourceRefs);
  const evidenceRefs = normalizeCognitionSourceRefsForWrite(input.evidenceRefs || input.sourceRefs);
  const currentCandidate = await readRecallCandidate(userId, candidateId);
  if (currentCandidate.contentOrganization) throw new Error(t('cognition.organization.edit_group'));
  const evidenceSummary = input.evidenceSummary === undefined
    ? currentCandidate.evidenceSummary
    : boundedText(input.evidenceSummary, 'evidence summary', RECALL_TEXT_LIMITS.evidenceSummary);
  const scopePolicy = input.scopePolicy === undefined
    ? currentCandidate.scopePolicy
    : normalizeAbilityAssetScopePolicy(input.scopePolicy);
  await assertResolvableNewSourceRefs(userId, currentCandidate, [...sourceRefs, ...evidenceRefs]);
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
  const resolvedValue = hasExplicitValue ? (currentCandidate.stockOrganizationProvenance ? value || undefined : value || '') : currentCandidate.stockOrganizationProvenance ? currentCandidate.value : (currentCandidate.value && currentCandidate.value !== currentCandidate.judgment ? currentCandidate.value : judgment);
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
  if (currentCandidate.proposalTarget === 'ontology' && (targetAssetId || suggestedAction !== 'create' || suggestedType !== 'cognition'))
    throw new Error('ontology-only edits cannot target cognition assets');
  if (targetAssetId && !safeId(targetAssetId)) throw new Error('invalid target asset id');
  const nextFingerprint = fingerprint({
    judgment, value: resolvedValue, suggestedType, suggestedScope, suggestedAction, targetAssetId,
    spaceId: currentCandidate.spaceId,
    proposalTarget: currentCandidate.proposalTarget,
    ontologyFormation: currentCandidate.ontologyFormation,
    ...(scopePolicy ? { scopePolicy } : {}),
  });
  if (duplicates.some((candidate) => candidate.id !== candidateId
    && !(currentCandidate.proposalTarget === 'ontology' && isTerminalCandidate(candidate.status))
    && fingerprint(candidate) === nextFingerprint)) {
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
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, async (raw) => {
    if (!raw) throw new Error('recall candidate not found');
    const current = asCandidate(raw);
    if (isTerminalCandidate(current.status)) {
      throw new RecallCandidateStateError(RECALL_CANDIDATE_TERMINAL_ERROR_CODE, 'recall candidate is terminal', current.status);
    }
    assertCandidateNotInOntologyHandoff(current);
    await assertCandidateHasNoAppliedHandoff(userId, current);
    // 字段齐全且编辑后的内容通过正式资产准入门槛，才允许迁到 pending_review。
    const reviewReady = (Boolean(current.stockOrganizationProvenance) || Boolean(resolvedValue)) && hasReviewableCandidateEvidence({ origin: current.origin, stockOrganizationProvenance: current.stockOrganizationProvenance, sourceRefs, evidenceRefs })
      && Boolean(suggestedScope) && (!candidateActionNeedsTarget(suggestedAction) || Boolean(targetAssetId))
      && promotionEligible;
    const now = new Date().toISOString();
    const ontologyChanged = current.ontologyFormation && (current.judgment !== judgment || current.value !== resolvedValue
      || current.suggestedType !== suggestedType || current.suggestedScope !== suggestedScope
      || current.suggestedAction !== suggestedAction || current.targetAssetId !== targetAssetId
      || !isDeepStrictEqual(current.sourceRefs, sourceRefs) || !isDeepStrictEqual(current.evidenceRefs, evidenceRefs)
      || !isDeepStrictEqual(current.scopePolicy, scopePolicy)
      || (input.applicableWhen !== undefined && !isDeepStrictEqual(current.applicableWhen, candidateBoundaries.applicableWhen))
      || (input.forbiddenWhen !== undefined && !isDeepStrictEqual(current.forbiddenWhen, candidateBoundaries.forbiddenWhen)));
    const ontologyFormation = ontologyChanged ? { ...current.ontologyFormation!,
      blockedReasons: [...new Set([...current.ontologyFormation!.blockedReasons, 'candidate_edited_requires_ontology_review'])] } : current.ontologyFormation;
    return {
      ...current,
      ...(ontologyFormation ? { ontologyFormation } : {}),
      ...(current.judgment !== judgment || current.suggestedScope !== suggestedScope || current.targetAssetId !== targetAssetId
        || current.suggestedAction !== suggestedAction || !isDeepStrictEqual(current.scopePolicy, scopePolicy)
        || !isDeepStrictEqual(current.evidenceRefs, evidenceRefs) || !isDeepStrictEqual(current.sourceRefs, sourceRefs)
        || input.applicableWhen !== undefined && !isDeepStrictEqual(current.applicableWhen, candidateBoundaries.applicableWhen)
        || input.forbiddenWhen !== undefined && !isDeepStrictEqual(current.forbiddenWhen, candidateBoundaries.forbiddenWhen)
        ? { formationComparison: undefined } : {}),
      contentFormatVersion: 1,
      judgment,
      value: resolvedValue,
      ...(evidenceSummary ? { evidenceSummary } : {}),
      ...(summary ? { summary } : {}),
      ...(Object.hasOwn(input, 'uncertainty') ? { uncertainty: uncertainty || undefined } : {}),
      ...(contentCategory !== undefined ? { contentCategory } : {}),
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
      autoReview: undefined,
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

/** Stores a held automatic review as an observation, never saving authority.
 * The comparison runs inside the actual candidate record lock because edits
 * can occur independently of the wider promotion pool lock. */
export async function recordRecallCandidateAutomaticHold(userId: string, expected: RecallCandidateRecord,
  review: AutomaticCandidateReview): Promise<RecallCandidateRecord> {
  if (review.eligible) throw new Error('automatic hold cannot authorize promotion');
  const content = (candidate: RecallCandidateRecord) => {
    const { autoReview: _review, updatedAt: _updatedAt, ...snapshot } = candidate;
    return snapshot;
  };
  return withRecallCandidateReviewLock(userId, async () => {
    const saved = await updateRecallJsonRecord(userId, 'candidates', expected.id, raw => {
      if (!raw) throw new Error('recall candidate not found');
      const current = asCandidate(raw);
      if (current.status !== 'pending_review' || !isDeepStrictEqual(content(current), content(expected))) return raw;
      return { ...raw, autoReview: review };
    });
    return asCandidate(saved);
  });
}

/** Record an independent execution outcome without changing the candidate's
 * lifecycle. Promotion and asset governance remain responsible for status;
 * this counter is only the evidence ledger used to decide maturity or pause. */
/** Replace only the explicitly rechecked dependency preview. The model runs
 * outside locks; changed candidates or an already committed handoff cannot be rebased. */
export async function replaceRecallCandidateOntologyFormation(
  userId: string, candidateId: string, plan: OntologyFormationPlan, expectedCandidate: RecallCandidateRecord,
  options: { actor?: 'user' | 'system' } = {},
): Promise<RecallCandidateRecord> {
  return withRecallCandidatePromotionLock(userId, async () => asCandidate(await updateRecallJsonRecord(userId, 'candidates', candidateId, async raw => {
    if (!raw) throw recallCandidateError('recall_candidate_not_found', 'recall candidate not found');
    const current = asCandidate(raw);
    if (isTerminalCandidate(current.status)) throw new RecallCandidateStateError(RECALL_CANDIDATE_TERMINAL_ERROR_CODE, 'recall candidate is terminal', current.status);
    assertCandidateNotInOntologyHandoff(current);
    await assertCandidateHasNoAppliedHandoff(userId, current);
    if (!isDeepStrictEqual(current, expectedCandidate)) throw Object.assign(new Error('candidate changed while its ontology preview was being rechecked'), { code: 'ontology_recheck_candidate_changed' });
    const now = new Date().toISOString();
    const { reviewDecisionId: _decision, ...reviewable } = current;
    return { ...reviewable, ontologyFormation: normalizeOntologyFormationPlan(userId, candidateId, bindOntologyFormationPlan(candidateId, plan)),
      ...(options.actor === 'system' ? {} : { userModifiedAt: current.userModifiedAt || now }), updatedAt: now };
  })));
}

/** A prepared stock job is durable before the candidate points to it. The one
 * candidate write switches its preview, sources and host proof together. An
 * interrupted pre-publication job grants nothing and can be retried. */
export async function replaceStockOntologyCandidate(userId: string, expected: RecallCandidateRecord,
  prepared: SaveRecallCandidateInput): Promise<RecallCandidateRecord> {
  if (expected.proposalTarget !== 'ontology' || prepared.proposalTarget !== 'ontology' || !prepared.ontologyFormation)
    throw new Error('stock replacement requires an independent ontology proposal');
  await verifyStockOrganizationCandidate(userId, prepared, { newWrite: true });
  return withRecallCandidatePromotionLock(userId, async () => asCandidate(await updateRecallJsonRecord(userId, 'candidates', expected.id, async raw => {
    if (!raw) throw new Error('recall candidate not found');
    const current = asCandidate(raw);
    if (isTerminalCandidate(current.status) || !isDeepStrictEqual(current, expected))
      throw Object.assign(new Error('candidate changed during stock review'), { code: 'ontology_recheck_candidate_changed' });
    assertCandidateNotInOntologyHandoff(current);
    await assertCandidateHasNoAppliedHandoff(userId, current);
    await verifyStockOrganizationCandidate(userId, prepared, { newWrite: true });
    const { reviewDecisionId: _decision, ...reviewable } = current;
    return { ...reviewable, captureKey: prepared.captureKey, judgment: prepared.judgment, summary: prepared.summary,
      evidenceSummary: prepared.evidenceSummary, sourceRefs: prepared.sourceRefs, evidenceRefs: prepared.evidenceRefs,
      stockOrganizationProvenance: prepared.stockOrganizationProvenance,
      ontologyFormation: normalizeOntologyFormationPlan(userId, current.id, bindOntologyFormationPlan(current.id, prepared.ontologyFormation!)),
      updatedAt: new Date().toISOString() };
  })));
}

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

export function rejectRecallCandidate(userId: string, candidateId: string, note?: string): Promise<RecallCandidateRecord> {
  return decideWithoutAsset(userId, candidateId, 'reject', 'rejected', note);
}

export function ignoreRecallCandidate(userId: string, candidateId: string, note?: string): Promise<RecallCandidateRecord> {
  return decideWithoutAsset(userId, candidateId, 'ignore', 'ignored', note);
}

/** Mark an older same-target content suggestion as replaced by the newest one.
 * Structural merge/split/conflict suggestions deliberately do not use this
 * path: they remain reviewable alongside the new suggestion. */
export async function supersedeRecallCandidate(
  userId: string, candidateId: string, supersededBy: string, note?: string,
): Promise<RecallCandidateRecord> {
  const updated = await ignoreRecallCandidate(userId, candidateId, note || '已被本轮更新建议取代');
  if (updated.status !== 'ignored' || updated.mergedInto || !safeId(supersededBy)) return updated;
  const row = await updateRecallJsonRecord(userId, 'candidates', candidateId, current => current ? {
    ...current,
    mergedInto: supersededBy,
    updatedAt: new Date().toISOString(),
  } : current);
  return asCandidate(row);
}

export function keepCurrentRecallCandidate(userId: string, candidateId: string, note?: string): Promise<RecallCandidateRecord> {
  return decideWithoutAsset(userId, candidateId, 'keep_current', 'ignored', note);
}

/** Use the same pool mutex as asset promotion for cross-domain candidate handoffs. */
export function withRecallCandidatePromotionLock<T>(userId: string, work: () => Promise<T>): Promise<T> {
  if (!safeId(userId)) throw new Error('invalid recall candidate owner');
  return fileEditLock(recallJsonRecordPath(userId, 'candidate-locks', 'promote')).runExclusive(work);
}

/** Save progress after one or more ontology records were committed from this candidate. */
export async function recordRecallCandidateOntologyProgress(
  userId: string,
  candidateId: string,
  handoffInput: Omit<RecallCandidateOntologyHandoff, 'status'>,
): Promise<RecallCandidateRecord> {
  if (!safeId(userId) || !safeId(candidateId)) throw new Error('invalid ontology candidate handoff reference');
  const handoff = normalizeOntologyHandoff({ ...handoffInput, status: 'in_progress' });
  if (!handoff) throw new Error('ontology candidate progress is required');
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, raw => {
    if (!raw) throw new Error('recall candidate not found');
    const candidate = asCandidate(raw);
    if (candidate.status === 'integrated') throw new RecallCandidateStateError(RECALL_CANDIDATE_TERMINAL_ERROR_CODE, 'candidate is already integrated into ontology', candidate.status);
    if (isTerminalCandidate(candidate.status)) throw new RecallCandidateStateError(RECALL_CANDIDATE_TERMINAL_ERROR_CODE, 'recall candidate is terminal', candidate.status);
    const previous = candidate.ontologyHandoff?.status === 'in_progress' ? candidate.ontologyHandoff : undefined;
    const merged = normalizeOntologyHandoff({
      ...handoff,
      moduleIds: [...new Set([...(previous?.moduleIds || []), ...handoff.moduleIds])],
      recordIds: [...new Set([...(previous?.recordIds || []), ...handoff.recordIds])],
    });
    if (!merged) throw new Error('invalid ontology candidate progress');
    return { ...candidate, ontologyHandoff: merged, updatedAt: new Date().toISOString() };
  });
  return asCandidate(updated);
}

/** Finalize a user-reviewed candidate after its canonical T/A/R records commit. */
export async function markRecallCandidateIntegrated(
  userId: string,
  candidateId: string,
  handoffInput: RecallCandidateOntologyHandoff,
): Promise<RecallCandidateRecord> {
  if (!safeId(userId) || !safeId(candidateId)) throw new Error('invalid ontology candidate handoff reference');
  const handoff = normalizeOntologyHandoff(handoffInput);
  if (!handoff) throw new Error('ontology candidate handoff is required');
  const integratedHandoff: RecallCandidateOntologyHandoff = { ...handoff, status: 'integrated' };
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, async raw => {
    if (!raw) throw new Error('recall candidate not found');
    const candidate = asCandidate(raw);
    if (candidate.status === 'integrated') {
      if (candidate.ontologyHandoff?.recordIds.join(',') === integratedHandoff.recordIds.join(',')) return candidate;
      throw new RecallCandidateStateError(RECALL_CANDIDATE_TERMINAL_ERROR_CODE, 'candidate is already integrated into ontology', candidate.status);
    }
    if (isTerminalCandidate(candidate.status)) {
      throw new RecallCandidateStateError(RECALL_CANDIDATE_TERMINAL_ERROR_CODE, 'recall candidate is terminal', candidate.status);
    }
    const decision = await writeReviewDecision(userId, {
      targetRef: `recall_candidate:${candidate.id}`,
      decisionType: 'modify',
      decision: 'integrate_to_ontology',
      antecedentRef: candidate.id,
      scope: candidate.suggestedScope,
      reason: 'User reviewed and structured this candidate into canonical ontology records.',
      modifiedContent: `${handoff.recordIds.length} ontology records in ${handoff.moduleIds.length} module(s), revision ${handoff.ontologyRevision}`,
      actor: 'user',
      idempotencyKey: `ontology-${handoff.commandId}`,
    });
    const now = new Date().toISOString();
    return { ...candidate, status: 'integrated', ontologyHandoff: integratedHandoff, reviewDecisionId: decision.decision_id,
      decisionNote: '已整理到本体', cooldownUntil: undefined, updatedAt: now };
  });
  return asCandidate(updated);
}

async function decideWithoutAsset(
  userId: string,
  candidateId: string,
  decisionType: 'reject' | 'ignore' | 'keep_current',
  status: 'rejected' | 'ignored',
  note?: string,
  actor: ReviewDecisionActor = 'user',
): Promise<RecallCandidateRecord> {
  const decisionNote = boundedText(note, 'decision note', 1_000);
  // 账本是否已落：writeReviewDecision 在 updater 内执行，主档写失败
  // 时据它区分「账本已落、候选仍 pending」的半提交（需补偿）与 updater 早退
  // （账本未落，无需补偿）。
  let ledgerWritten = false;
  let updated: RecallJsonRecord;
  try {
    updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, async (current) => {
      if (!current) throw new Error('recall candidate not found');
      const candidate = asCandidate(current);
      if (isTerminalCandidate(candidate.status)) return candidate;
      assertCandidateNotInOntologyHandoff(candidate);
      await assertCandidateHasNoAppliedHandoff(userId, candidate);
      // 同上：拒绝 / 稍后 / 忽略 是用户对一条弱候选最基本的处置权，不能因为
      // 证据弱就把它锁死在待办里。系统 actor 仍然不许替用户下这个决定，
      // refs 为空的候选也仍然出不去（否则写出的记录读不回来）。
      if ((candidate.status === 'observed' || candidate.status === 'weak_observation')
        && (actor !== 'user' || !getRecallCandidateCapabilities(candidate).canReject)) {
        throw new Error('candidate evidence is insufficient for review');
      }
      const decision = await writeReviewDecision(userId, {
        targetRef: `recall_candidate:${candidate.id}`,
        decisionType,
        decision: decisionType,
        antecedentRef: candidate.id,
        scope: candidate.suggestedScope,
        reason: decisionNote,
        actor,
        idempotencyKey: `${decisionType}-${candidate.updatedAt}`,
      });
      ledgerWritten = true;
      return {
        ...candidate,
        status,
        reviewDecisionId: decision.decision_id,
        ...(decisionNote ? { decisionNote } : {}),
        cooldownUntil: undefined,
        updatedAt: new Date().toISOString(),
      };
    });
  } catch (error) {
    // 半提交补偿：账本已落、主档写失败时，候选不能留在 pending——
    // 「已处理历史」里有这条决定而待办里它还躺着，两边口径矛盾。补偿把候选
    // 标 failed（可重试口径：重新决定会走新的幂等键再记账），补偿本身失败只
    // warn（原错误优先上抛，不吞不换）。账本未落（updater 早退/复核拒绝）时
    // 不补偿——那不是半提交。
    if (ledgerWritten) {
      await updateRecallJsonRecord(userId, 'candidates', candidateId, (current) => {
        if (!current) return undefined;
        const latest = asCandidate(current);
        if (isTerminalCandidate(latest.status)) return latest;
        const now = new Date().toISOString();
        return {
          ...latest,
          status: 'failed',
          failureCode: 'decision_write_failed',
          failureMessage: `review decision was recorded but the candidate write failed: ${(error as Error).message}`.slice(0, 1_000),
          failedAt: now,
          updatedAt: now,
        };
      }).catch((compensationError) => {
        log.warn('recall candidate decision compensation failed', {
          userId,
          candidateId,
          error: (compensationError as Error).message,
        });
      });
    }
    throw error;
  }
  return asCandidate(updated);
}

/** Activity processing identity comes from the decision ledger, never from the candidate's origin. */
export async function withRecallCandidateProcessingDetails(candidateUserId: string, candidate: RecallCandidateRecord) {
  if (!candidate.reviewDecisionId) return candidate;
  try {
    const decision = await readReviewDecision(candidateUserId, `recall_candidate:${candidate.id}`, candidate.reviewDecisionId);
    if (!decision) return { ...candidate, processingActor: '处理者记录不可用', processingReason: candidate.decisionNote || '' };
    return { ...candidate,
      ...(decision.actor === 'system' || decision.actor === 'user' ? { processingDecisionActor: decision.actor } : {}),
      processingActor: decision.actor === 'system' ? (decision.decision === 'automatic low-risk approval' ? '系统自动批准' : '系统')
        : decision.actor === 'user' ? '你（人工）' : '处理者未记录',
      processingReason: decision.reason || candidate.decisionNote || ({ accept: '人工核对后保存', modify: '人工修改后保存', reject: '人工拒绝此建议', ignore: '人工忽略此建议', keep_current: '人工确认保留现有内容', defer: '人工选择稍后处理', trial: '人工选择试用' }[decision.decision_type] || ''),
    };
  } catch {
    return { ...candidate, processingActor: '处理者暂时无法读取', processingReason: candidate.decisionNote || '' };
  }
}

/** 系统只核验已确认候选的现有资产；缺失资产留给用户处理，系统不得重新发布。 */
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
  const candidate = await readRecallCandidate(userId, candidateId);
  if (candidate.status !== 'confirmed') return { candidate };
  const policy = evaluatePromotionPolicy(candidate);
  if (policy.action === 'pause') throw new PromotionPausedError(policy.reason);
  try {
    const promoted = await promoteRecallCandidate(userId, candidate.id, {
      actor: 'system', provenance: opts.provenance || 'capture',
    });
    return { candidate: promoted.candidate, asset: promoted.asset };
  } catch (error) {
    const retryable = await readRecallCandidate(userId, candidate.id);
    if (retryable.status !== 'failed') throw error;
    // 恢复缺失资产仍需用户核对，failed 状态不能作为新的系统授权。
    return { candidate: retryable };
  }
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
      .filter((c) => c.proposalTarget !== 'ontology' && !isTerminalCandidate(c.status))
      .map((c) => ({ id: c.id, text: String(c.judgment || ''), ...(c.scopePolicy ? { scopePolicy: c.scopePolicy } : {}) })),
    assetTexts: assets
      .filter((a) => a.status !== 'deleted' && a.status !== 'purged' && a.status !== 'revoked')
      .map((a) => ({ id: a.id, text: String(a.statement || a.title || ''), ...(a.scopePolicy ? { scopePolicy: a.scopePolicy } : {}) })),
  };
}

async function readAbilityAssetSafe(userId: string, assetId: string): Promise<RecallAbilityAssetRecord | undefined> {
  try {
    const { readAbilityAsset } = await import('./asset-service');
    return await readAbilityAsset(userId, assetId);
  } catch {
    return undefined;
  }
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
      // 仅按 pending_review 判断会漏掉具有晋升能力的 weak_observation。
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
    ...(candidate.contentCategory !== undefined ? { contentCategory: candidate.contentCategory } : {}),
    ...(candidate.ontologyFormation ? { ontologyFormation: candidate.ontologyFormation } : {}),
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
  } catch (error) {
    if (error instanceof Error && error.message === 'recall ability asset not found') return undefined;
    throw error; // Unreadable is not proof that no content was committed.
  }
  const belongsToCandidate = asset.candidateId === candidate.id
    || asset.sourceCandidateIds?.includes(candidate.id);
  if (!belongsToCandidate) return undefined;
  if (candidate.suggestedAction === 'create') {
    if (asset.reviewDecisionId === reviewDecisionId) return asset;
    return (await listAbilityAssetVersions(userId, asset.id))
      .some(entry => entry.version === '1' && versionHasReviewDecision(entry.reason, reviewDecisionId))
      ? asset : undefined;
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
  // 手动候选允许没有对话来源，交接回执也保留空 sourceRefs。
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
  options: { recovery?: 'allow' | 'none' } = {},
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
    if (options.recovery === 'none') return undefined;
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

/** Fusion adds a suffix; only the exact decision token identifies the commit. */
function versionHasReviewDecision(reason: string | undefined, reviewDecisionId: string): boolean {
  return reason?.split(';', 1)[0] === `review_decision:${reviewDecisionId}`;
}

async function recoverHandoffReceipt(
  userId: string,
  candidate: RecallCandidateRecord,
  reviewDecisionId: string,
  asset: RecallAbilityAssetRecord,
): Promise<RecallAssetHandoffReceipt | undefined> {
  const belongsToCandidate = asset.candidateId === candidate.id
    || asset.sourceCandidateIds?.includes(candidate.id);
  if (!belongsToCandidate) return undefined;
  // Current reviewDecisionId survives ordinary asset edits, so it cannot prove
  // the current version was the reviewed version. Prefer the immutable commit.
  const version = (await listAbilityAssetVersions(userId, asset.id))
    .find(entry => versionHasReviewDecision(entry.reason, reviewDecisionId));
  if (!version && asset.version === '1' && asset.type === candidate.suggestedType && asset.reviewDecisionId === reviewDecisionId) {
    return persistHandoffReceipt(userId, candidate.id, handoffReceipt(asset, reviewDecisionId));
  }
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

/** Finish only a proven existing commit before gates for a new content write. */
async function recoverCommittedCandidatePromotion(userId: string, candidateId: string): Promise<RecallCandidatePromotionResult | undefined> {
  const preliminary = await readRecallCandidate(userId, candidateId);
  if (preliminary.ontologyHandoff?.status === 'in_progress'
    || (isTerminalCandidate(preliminary.status) && preliminary.status !== 'confirmed')) return undefined;
  const previousDecision = await readCandidateConfirmationDecision(userId, preliminary);
  if (!previousDecision) return undefined;
  const committedAsset = await readAppliedHandoffAsset(userId, preliminary, previousDecision.decision_id);
  if (!committedAsset) {
    if (preliminary.status === 'confirmed' || previousDecision.asset_id || previousDecision.outcome === 'asset_created') {
      throw new Error('committed ability asset is unavailable; recovery cannot grant a new content write');
    }
    return undefined;
  }
  let result: RecallCandidatePromotionResult | undefined;
  await updateRecallJsonRecord(userId, 'candidates', candidateId, async raw => {
    if (!raw) throw recallCandidateError('recall_candidate_not_found', 'recall candidate not found');
    const candidate = asCandidate(raw);
    assertCandidateNotInOntologyHandoff(candidate);
    if (isTerminalCandidate(candidate.status) && candidate.status !== 'confirmed') return candidate;
    let decision = await readCandidateConfirmationDecision(userId, candidate);
    if (!decision) return candidate;
    const asset = await readAppliedHandoffAsset(userId, candidate, decision.decision_id);
    if (!asset) return candidate;
    const receipt = await readRecallAssetHandoffReceipt(userId, candidate.id, decision.decision_id)
      || await recoverHandoffReceipt(userId, candidate, decision.decision_id, asset);
    if (!receipt || receipt.assetId !== asset.id || receipt.assetType !== candidate.suggestedType
      || receipt.reviewDecisionId !== decision.decision_id
      || (decision.asset_id && decision.asset_id !== asset.id)) {
      throw recallCandidateError('recall_candidate_handoff_incomplete', 'immutable handoff receipt cannot be recovered safely');
    }
    decision = await recordReviewDecisionOutcome(userId, `recall_candidate:${candidate.id}`, decision.decision_id, { assetId: asset.id });
    const confirmed: RecallCandidateRecord = candidate.status === 'confirmed'
      && candidate.promotedAssetId === asset.id && candidate.reviewDecisionId === decision.decision_id ? candidate : {
      ...candidate, status: 'confirmed', promotedAssetId: asset.id, reviewDecisionId: decision.decision_id,
      failureCode: undefined, failureMessage: undefined, failedAt: undefined, updatedAt: new Date().toISOString(),
    };
    result = { candidate: confirmed, asset, decision, receipt };
    return confirmed;
  });
  return result;
}

/** Existing commits may close an interrupted candidate journal after opt-out.
 * This entry cannot grant any new asset write authority. */
export function recoverRecallCandidatePromotion(userId: string, candidateId: string): Promise<RecallCandidatePromotionResult | undefined> {
  return withRecallCandidatePromotionLock(userId, () => recoverCommittedCandidatePromotion(userId, candidateId));
}

export async function promoteRecallCandidate(
  userId: string,
  candidateId: string,
  options: PromoteRecallCandidateOptions & AbilityAssetRelationContract = {},
): Promise<RecallCandidatePromotionResult> {
  if (options.actor === 'system') {
    // Repair an existing commit without granting new work or spending model
    // calls after opt-out. Fresh semantic assessment happens before the grant
    // lock; the locked write path accepts only its unchanged proof.
    const recovered = await recoverRecallCandidatePromotion(userId, candidateId);
    if (recovered) return recovered;
    const candidate = await readRecallCandidate(userId, candidateId);
    const review = await evaluateNightlyAutomaticApproval(userId, candidate, { signal: options.signal });
    if (!review.eligible) throw new NightlyAutomaticApprovalHeldError(review.reasons);
    return withCognitionCommitLifetime(userId, options.signal, () =>
      withRecallAutoApprovalLock(userId, () => promoteRecallCandidateWithGrant(userId, candidateId, options)));
  }
  return promoteRecallCandidateWithGrant(userId, candidateId, options);
}

function assertPromotionContentWithinContract(candidate: RecallCandidateRecord): void {
  if (!['create', 'update', 'limit_scope'].includes(candidate.suggestedAction || 'create')) return;
  try {
    assertContentWithinContract(candidate.judgment, 'statement');
    if (typeof candidate.value === 'string') assertContentWithinContract(candidate.value, 'value', { allowEmpty: true });
    if (typeof candidate.evidenceSummary === 'string') assertContentWithinContract(candidate.evidenceSummary, 'evidenceSummary', { allowEmpty: true });
  } catch (error) {
    if (!(error instanceof ContentContractError)) throw error;
    throw recallCandidateError(
      'recall_candidate_content_too_long',
      `${error.field} is ${error.actual} characters; the storage limit is ${error.limit}. Shorten or split it before saving.`,
    );
  }
}

/** Everything a user confirmation fixes. Timestamps and projection/admin fields
 *  are deliberately excluded; any content, scope, condition, evidence, target,
 *  lifecycle or provenance change must force a fresh confirmation. */
function confirmationFields(candidate: RecallCandidateRecord) {
  return {
    judgment: candidate.judgment,
    value: candidate.value,
    summary: candidate.summary,
    suggestedType: candidate.suggestedType,
    suggestedScope: candidate.suggestedScope,
    suggestedAction: candidate.suggestedAction,
    targetAssetId: candidate.targetAssetId,
    targetVersionUsed: candidate.targetVersionUsed,
    applicableWhen: candidate.applicableWhen,
    forbiddenWhen: candidate.forbiddenWhen,
    scopePolicy: candidate.scopePolicy,
    contentCategory: candidate.contentCategory,
    risk: candidate.risk,
    expiresAt: candidate.expiresAt,
    sourceRefs: candidate.sourceRefs,
    evidenceRefs: candidate.evidenceRefs,
    origin: candidate.origin,
    status: candidate.status,
    userModifiedAt: candidate.userModifiedAt,
    contentOrganization: candidate.contentOrganization,
    ontologyHandoff: candidate.ontologyHandoff,
    captureProvenance: candidate.captureProvenance,
    stockOrganizationProvenance: candidate.stockOrganizationProvenance,
    ontologyFormation: candidate.ontologyFormation,
    humanInstructionProvenance: candidate.humanInstructionProvenance,
  };
}

function targetConfirmationIdentity(target: RecallAbilityAssetRecord, includeVersion = true) {
  return {
    id: target.id,
    ...(includeVersion ? { version: target.version, activeVersion: abilityAssetActiveVersion(target) } : {}),
    status: target.status,
    type: target.type,
    scopePolicy: target.scopePolicy,
  };
}

function candidateChangedDuringConfirmation(): Error {
  return recallCandidateError(
    'recall_candidate_changed_during_confirmation',
    'This candidate changed while its confirmation was being prepared. Review the current content and confirm again.',
  );
}

async function promoteRecallCandidateWithGrant(
  userId: string, candidateId: string, options: PromoteRecallCandidateOptions & AbilityAssetRelationContract,
): Promise<RecallCandidatePromotionResult> {
  if (options.actor !== 'user' && options.actor !== 'system') {
    throw new Error('recall candidate promotion requires a user actor or system actor');
  }
  const ontologyRefs = options.ontologyRefs === undefined ? undefined : normalizeAbilityAssetOntologyRefs(options.ontologyRefs);
  const profileTarget = normalizePersonalProfileTarget(options.profileTarget);
  const relationContract = readAbilityAssetRelationContract(options as Record<string, unknown>);
  const optionSemantics = readAbilityAssetSemantics(options as unknown as Record<string, unknown>);
  const recovered = await withRecallCandidatePromotionLock(userId, () => recoverCommittedCandidatePromotion(userId, candidateId));
  if (recovered) {
    if (recovered.asset.type === 'personal') {
      try {
        const { schedulePersonalProfileSync } = await import('./personal-profile-sync');
        recovered.profileProjection = await schedulePersonalProfileSync(userId, { assetId: recovered.asset.id, ...(profileTarget ? { target: profileTarget } : {}) });
      } catch (error) {
        log.warn('personal profile projection after recovery degraded', { userId, assetId: recovered.asset.id, error: (error as Error).message });
      }
    }
    return recovered;
  }
  const preflight = await readRecallCandidate(userId, candidateId);
  if (preflight.contentOrganization) throw new Error(t('cognition.organization.confirm_group'));
  if (preflight.humanInstructionProvenance && (options.actor !== 'user' || options.forceCreateSimilar || options.confirmBaselineVersion
    || options.decisionType || options.ontologyRefs || options.scopePolicy || options.causalRule || options.profileTarget
    || Object.keys(optionSemantics).length || Object.keys(relationContract).length))
    throw new Error('human creation confirmation cannot override its reviewed contract');
  if (preflight.stockOrganizationProvenance && (options.actor !== 'user' || options.confirmBaselineVersion
    || options.ontologyRefs || options.scopePolicy || options.causalRule || options.profileTarget
    || Object.keys(optionSemantics).length || Object.keys(relationContract).length))
    throw new Error('stock organization requires confirmation of its reviewed contract');
  if (preflight.proposalTarget === 'ontology') throw new Error('ontology-only proposal must be confirmed into ontology');
  if (isTerminalCandidate(preflight.status) && preflight.status !== 'confirmed') {
    throw new RecallCandidateStateError(RECALL_CANDIDATE_TERMINAL_ERROR_CODE, 'recall candidate is terminal', preflight.status);
  }
  assertPromotionContentWithinContract(preflight);
  try {
    await verifyCandidateFormationForPromotion(userId, preflight);
  } catch (error) {
    if (error instanceof CaptureFormationSourceUnavailableError) {
      await updateRecallJsonRecord(userId, 'candidates', candidateId, async current => {
        if (!current) throw error;
        const latest = asCandidate(current);
        if (isTerminalCandidate(latest.status) || latest.ontologyHandoff?.status === 'in_progress') return latest;
        // Recheck the current refs while locked: an edit may have removed the
        // revoked supplementary source since preflight read it.
        try { await verifyCandidateFormationForPromotion(userId, latest); return latest; }
        catch (latestError) { if (!(latestError instanceof CaptureFormationSourceUnavailableError)) return latest; }
        const now = new Date().toISOString();
        return { ...latest, status: 'failed', failureCode: 'source_unavailable',
          failureMessage: error.message, failedAt: now, updatedAt: now };
      });
    }
    throw error;
  }
  if (options.actor === 'system') {
    if (options.forceCreateSimilar || options.confirmBaselineVersion || options.decisionType === 'modify'
      || options.ontologyRefs || options.scopePolicy || options.causalRule || options.profileTarget
      || Object.keys(optionSemantics).length || Object.keys(relationContract).length) throw new PromotionPausedError('automatic_confirmation_cannot_override_candidate');
    await requireNightlyAutomaticApproval(userId, preflight);
  }
  // 版本组防分裂闸门：用户确认 create 候选时若与现有资产语义
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
  let preflightTarget: RecallAbilityAssetRecord | undefined;
  let preflightTargetSemantics: AbilityAssetSemantics = {};
  if (preflight.targetAssetId && candidateActionNeedsTarget(preflight.suggestedAction)) {
    preflightTarget = await readAbilityAsset(userId, preflight.targetAssetId);
    if (preflight.scopePolicy
      && scopePolicyIdentity(preflight.scopePolicy) !== scopePolicyIdentity(preflightTarget.scopePolicy)) {
      throw recallCandidateError(
        'recall_candidate_scope_policy_mismatch',
        'A scope-restricted candidate can only update an asset with the same access boundary. Save it as a new asset or choose a matching target.',
      );
    }
    preflightTargetSemantics = readAbilityAssetSemantics(preflightTarget as unknown as Record<string, unknown>);
  }
  const preflightSemantics: AbilityAssetSemantics = {
    ...(optionSemantics.applicableWhen !== undefined
      ? { applicableWhen: optionSemantics.applicableWhen }
      : preflight.applicableWhen !== undefined
        ? { applicableWhen: preflight.applicableWhen }
        : preflightTargetSemantics.applicableWhen !== undefined ? { applicableWhen: preflightTargetSemantics.applicableWhen } : {}),
    ...(optionSemantics.forbiddenWhen !== undefined
      ? { forbiddenWhen: optionSemantics.forbiddenWhen }
      : preflight.forbiddenWhen !== undefined
        ? { forbiddenWhen: preflight.forbiddenWhen }
        : preflightTargetSemantics.forbiddenWhen !== undefined ? { forbiddenWhen: preflightTargetSemantics.forbiddenWhen } : {}),
  };
  // 条件是评审时新写下的自由文本，不一定走 saveRecallCandidate 那道闸，这里补上。
  assertNotForbiddenToPersist([
    ...(preflightSemantics.applicableWhen || []),
    ...(preflightSemantics.forbiddenWhen || []),
  ]);
  const causalRule = options.causalRule === undefined ? undefined : normalizeCausalRule(options.causalRule);
  const preflightScopePolicy = options.scopePolicy === undefined
    ? preflight.scopePolicy
    : normalizeAbilityAssetScopePolicy(options.scopePolicy);
  // These are reassigned inside the promotion lock from scanBase; the preflight
  // values are the confirmation snapshot shown to the user.
  let semantics: AbilityAssetSemantics = preflightSemantics;
  let scopePolicy = preflightScopePolicy;
  const preflightFields = confirmationFields(preflight);

  // 所有晋升入口共用此门控。冲突扫描与晋升提交必须在同一候选池锁内完成，
  // 并以锁内新鲜读取复核，避免不同候选并发穿过相同内容的冲突门。
  const promotePoolLock = fileEditLock(recallJsonRecordPath(userId, 'candidate-locks', 'promote'));

  // 标题和其最终正文依据先在所有锁外预计算，避免通常路径持锁调用模型。
  // 锁内正文未变则复用标题；发生并发正文变化时才按新正文重新生成。
  // 只预计算本次动作将实际走到的分支（create 或 update/limit_scope），另一
  // 分支的标题输入根本不存在，预跑只会白调一次模型。
  const plannedCreateStatement = (preflight.suggestedAction || 'create') === 'create'
    ? preflight.judgment
    : undefined;
  const plannedCreateTitle = plannedCreateStatement !== undefined
    ? await resolvePromotionAssetTitle(userId, {
      preferredTitle: preflight.summary || '',
      statement: plannedCreateStatement,
      type: preflight.suggestedType,
        reviewedTitle: options.actor !== 'system' && (preflight.origin === 'stock_organization' || preflight.origin === 'manual' || preflight.origin === 'human_instruction' || Boolean(preflight.userModifiedAt)),
    })
    : undefined;
  let plannedUpdate: { statement: string; title: string } | undefined;
  if (preflightTarget && (preflight.suggestedAction === 'update' || preflight.suggestedAction === 'limit_scope')) {
    const plannedUpdateStatement = preflight.judgment;
    plannedUpdate = {
      statement: plannedUpdateStatement,
      title: await resolvePromotionAssetTitle(userId, {
        preferredTitle: preflight.summary || '',
        statement: plannedUpdateStatement,
        type: preflight.suggestedType,
        reviewedTitle: options.actor !== 'system' && (preflight.origin === 'stock_organization' || preflight.origin === 'manual' || preflight.origin === 'human_instruction' || Boolean(preflight.userModifiedAt)),
      }),
    };
  }

  let decision: ReviewDecision | undefined;
  let receipt: RecallAssetHandoffReceipt | undefined;
  // 本次确认有没有核对到"改进对象版本"：随结果回给渲染层。
  let versionCheckSkipped = false;
  // 显式重锚的原锚：只有真的换了基线才回传。
  let rebasedFrom: string | undefined;
  let updated: RecallJsonRecord;
  try {
    updated = await promotePoolLock.runExclusive(() => (async () => {
      const concurrentRecovery = await recoverCommittedCandidatePromotion(userId, candidateId);
      if (concurrentRecovery) {
        decision = concurrentRecovery.decision;
        receipt = concurrentRecovery.receipt;
        return concurrentRecovery.candidate;
      }
      // 锁内新鲜读：preflight 是锁外快照，窗口期内候选可能被编辑（换类型/改
      // 正文都会改变冲突扫描的键）。扫不到（记录被删）时 updater 自会报
      // not found，这里退回 preflight 让闸门照常先跑。
      const scanBase = (await readRecallCandidate(userId, candidateId)) || preflight;
      if (scanBase.stockOrganizationProvenance && !isDeepStrictEqual(scanBase, preflight))
        throw Object.assign(new Error('stock organization candidate changed during confirmation'), { code: 'stock_organization_baseline_changed' });
      const scanFields = confirmationFields(scanBase);
      if (!isDeepStrictEqual(scanFields, preflightFields)) throw candidateChangedDuringConfirmation();
      let lockTarget: RecallAbilityAssetRecord | undefined;
      if (preflightTarget) {
        try { lockTarget = await readAbilityAsset(userId, preflightTarget.id); }
        catch { throw candidateChangedDuringConfirmation(); }
        // 带 expectedVersion 的更新把版本漂移留给资产服务的唯一 CAS 报结构化
        // 冲突；这里只拦 id/status/type/scopePolicy。没有比对面的存量候选仍
        // 由本守卫拦版本，避免静默应用到新版本。
        const includeTargetVersion = candidateVersionRecheckPlan(
          scanBase.suggestedAction,
          scanBase.targetVersionUsed,
          options.confirmBaselineVersion,
        ).expectedVersion === undefined;
        if (!isDeepStrictEqual(
          targetConfirmationIdentity(lockTarget, includeTargetVersion),
          targetConfirmationIdentity(preflightTarget, includeTargetVersion),
        )) throw candidateChangedDuringConfirmation();
      }
      const lockTargetSemantics = lockTarget
        ? readAbilityAssetSemantics(lockTarget as unknown as Record<string, unknown>) : {};
      semantics = {
        ...(optionSemantics.applicableWhen !== undefined
          ? { applicableWhen: optionSemantics.applicableWhen }
          : scanBase.applicableWhen !== undefined
            ? { applicableWhen: scanBase.applicableWhen }
            : lockTargetSemantics.applicableWhen !== undefined ? { applicableWhen: lockTargetSemantics.applicableWhen } : {}),
        ...(optionSemantics.forbiddenWhen !== undefined
          ? { forbiddenWhen: optionSemantics.forbiddenWhen }
          : scanBase.forbiddenWhen !== undefined
            ? { forbiddenWhen: scanBase.forbiddenWhen }
            : lockTargetSemantics.forbiddenWhen !== undefined ? { forbiddenWhen: lockTargetSemantics.forbiddenWhen } : {}),
      };
      assertNotForbiddenToPersist([
        ...(semantics.applicableWhen || []),
        ...(semantics.forbiddenWhen || []),
      ]);
      scopePolicy = options.scopePolicy === undefined
        ? scanBase.scopePolicy
        : normalizeAbilityAssetScopePolicy(options.scopePolicy);
      if (scanBase.scopePolicy && lockTarget
        && scopePolicyIdentity(scanBase.scopePolicy) !== scopePolicyIdentity(lockTarget.scopePolicy)) {
        throw recallCandidateError(
          'recall_candidate_scope_policy_mismatch',
          'A scope-restricted candidate can only update an asset with the same access boundary. Save it as a new asset or choose a matching target.',
        );
      }
      if (!isDeepStrictEqual(semantics, preflightSemantics) || !isDeepStrictEqual(scopePolicy, preflightScopePolicy))
        throw candidateChangedDuringConfirmation();
      assertPromotionContentWithinContract(scanBase);
      {
        // 同一句话被分成两类，说明至少一边分错了。扫一遍候选池：只看同文本、
        // 未被否决的条目，收集它们的类型。
        const sameText = comparableJudgmentText(scanBase.judgment);
        const conflictingTypes = sameText
          ? [...new Set((await listRecallCandidates(userId))
            .filter((other) => other.id !== scanBase.id
              && other.status !== 'rejected'
              && other.status !== 'ignored'
              && other.status !== 'expired'
              && other.status !== 'failed'
              && comparableJudgmentText(other.judgment) === sameText
              && other.suggestedType !== scanBase.suggestedType)
            .map((other) => other.suggestedType))]
          : [];
        const validation = validatePromotionByAssetType({
          judgment: scanBase.judgment,
          value: scanBase.value,
          summary: scanBase.summary,
          suggestedType: scanBase.suggestedType,
          suggestedScope: scanBase.suggestedScope,
          suggestedAction: scanBase.suggestedAction,
          applicableWhen: semantics.applicableWhen,
          forbiddenWhen: semantics.forbiddenWhen,
          ...(conflictingTypes.length ? { conflictingTypes } : {}),
        }, { actor: options.actor });
        if (!validation.ok) {
          log.info('recall candidate blocked at the promotion gate', {
            candidateId,
            suggestedType: scanBase.suggestedType,
            actor: options.actor,
            reasons: validation.reasons,
          });
          throw new PromotionBlockedError(validation.reasons);
        }
      }
      return await withStockOrganizationConfirmation(userId, scanBase, () => withOntologyFormationPromotion(userId, scanBase.ontologyFormation, options.actor!, () => updateRecallJsonRecord(userId, 'candidates', candidateId, async (current) => {
    if (!current) throw new Error('recall candidate not found');
    const candidate = asCandidate(current);
    if (scanBase.stockOrganizationProvenance && !isDeepStrictEqual(candidate, scanBase))
      throw Object.assign(new Error('stock organization candidate changed'), { code: 'stock_organization_baseline_changed' });
    if (!isDeepStrictEqual(confirmationFields(candidate), scanFields)) throw candidateChangedDuringConfirmation();
    if (candidate.status === 'confirmed') throw new Error('confirmed candidate has no recoverable committed asset');
    assertPromotionContentWithinContract(candidate);
    await verifyCandidateFormationForPromotion(userId, candidate);
    const automaticReview = options.actor === 'system' ? await requireNightlyAutomaticApproval(userId, candidate) : undefined;
    assertCandidateNotInOntologyHandoff(candidate);
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
    // 失败——确认动作本身就是用户输入，无需来源可用性背书。
    if ((unavailableSources.length || (!candidate.evidenceRefs.length && !candidate.stockOrganizationProvenance)) && candidate.origin !== 'manual') {
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
    if (candidate.contentCategory !== undefined) requireContentCategory(candidate.contentCategory);
    const targetRef = `recall_candidate:${candidate.id}`;
    const previousDecision = candidate.status === 'failed' && candidate.reviewDecisionId
      ? await readReviewDecision(userId, targetRef, candidate.reviewDecisionId)
      : undefined;
    if (candidate.status === 'failed' && candidate.reviewDecisionId && !previousDecision) {
      throw new Error('previous review decision is unavailable; confirmation cannot be retried safely');
    }
    decision = previousDecision?.actor === options.actor ? previousDecision : undefined;
    assertCognitionCommitActive(userId);
    decision = decision || await writeReviewDecision(userId, {
      targetRef,
      decisionType: options.decisionType || (candidate.userModifiedAt ? 'modify' : 'accept'),
      decision: options.actor === 'system'
        ? 'automatic low-risk approval'
        : options.decisionType === 'modify' || candidate.userModifiedAt ? 'modify and save' : 'accept',
      antecedentRef: candidate.id,
      scope: candidate.suggestedScope,
      reason: automaticReview ? `nightly automatic confirmation; policy_epoch:${automaticReview.policyEpoch}; effectiveness unverified` : options.decisionReason,
      actor: options.actor,
      modifiedContent: candidate.userModifiedAt ? candidate.judgment : undefined,
      idempotencyKey: `${options.actor === 'system' ? 'automatic-' : ''}${confirmationIdempotencyKey(candidate)}`,
      decisionId: options.decisionId,
    });
    const handoffActor: AbilityAssetActor = decision.actor === 'system' ? 'system' : 'user';
    // Permission to save is separate from human review and effectiveness evidence.
    const handoffLifecycleStatus: RecallAbilityAssetLifecycleStatus = handoffActor === 'system'
      ? 'automatically_extracted_unverified' : 'user_confirmed_unverified';
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
      // 标题校验和生成均以将落盘的最终正文为准。
      // judgment 保存为正文；value 作为独立的用途字段保存。
      // 更新/融合仍使用 value 参与 KStar admission 的基线核对。
      const createStatement = candidate.judgment;
      // 标题已在锁外按 preflight 正文预计算。正文没被并发改过（与
      // 预计算依据一致）就直接沿用；变了才退回锁内按原口径重算（罕见竞态）。
      const promotionTitle = plannedCreateTitle !== undefined && createStatement === plannedCreateStatement
        ? plannedCreateTitle
        : await resolvePromotionAssetTitle(userId, {
          preferredTitle: candidate.summary || '',
          statement: createStatement,
          type: candidate.suggestedType,
        reviewedTitle: options.actor !== 'system' && (candidate.origin === 'stock_organization' || candidate.origin === 'manual' || Boolean(candidate.userModifiedAt)),
        });
      stored = await createAbilityAsset(userId, {
        schemaVersion: 2,
        ownerId: userId,
        id: assetId,
        candidateId: candidate.id,
        sourceCandidateIds: [candidate.id],
        reviewDecisionId: decision.decision_id,
        type: candidate.suggestedType,
        ...(candidate.contentCategory !== undefined ? { contentCategory: requireContentCategory(candidate.contentCategory) } : {}),
        title: promotionTitle,
        statement: createStatement,
        ...(candidate.value !== undefined ? { value: candidate.value } : {}),
        evidenceRefs: candidate.evidenceRefs,
        // 手动候选（「记一条」）没有对话证据：资产侧空证据的合法性靠这个
        // origin 标记识别（asAsset 读回与展示徽章都用它）。
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
        // 自动来源同样从 bud 开始；未验证来源由 lifecycleStatus 表达，
        // 个人事实的特殊准入仍受来源状态约束。
        maturity: 'bud',
        version: '1',
        ...(sourceSessionIds.length ? { sourceSessionIds } : {}),
        createdAt: now,
        updatedAt: now,
      }, { actor: handoffActor, reason: handoffReason });
      // 入库自动挂族：新资产与既有资产静态同键或语义
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
        // Extraction/review prepares the complete merged revision. Save exactly
        // the approved body; recombining sentences after confirmation could
        // restore a corrected claim or introduce unreviewed meaning. Prior
        // content is checked during semantic review and retained in history.
        const updateStatement = candidate.judgment;
        // The title is prepared from this same full body outside the pool lock.
        const updateTitle = plannedUpdate && plannedUpdate.statement === updateStatement
          ? plannedUpdate.title
          : await resolvePromotionAssetTitle(userId, {
            preferredTitle: candidate.summary || '',
            statement: updateStatement,
            type: candidate.suggestedType,
        reviewedTitle: options.actor !== 'system' && (candidate.origin === 'stock_organization' || candidate.origin === 'manual' || Boolean(candidate.userModifiedAt)),
          });
        try {
          const commitUpdate = () => updateAbilityAsset(userId, target.id, {
            ...(candidate.contentCategory !== undefined ? { contentCategory: requireContentCategory(candidate.contentCategory) } : {}),
            title: updateTitle,
            statement: updateStatement,
            ...(candidate.value !== undefined ? { value: candidate.value } : {}),
            scope: candidate.suggestedScope,
            // An update adds evidence to the chain; it must not erase the
            // evidence already supporting the target asset.
            ...(!candidate.stockOrganizationProvenance || target.evidenceRefs.length || candidate.evidenceRefs.length
              ? { evidenceRefs: mergeSourceRefs(target.evidenceRefs, candidate.evidenceRefs) } : {}),
            ...(ontologyRefs?.length ? { ontologyRefs } : {}),
            ...relationContract,
            ...semantics,
            ...(scopePolicy ? { scopePolicy } : {}),
            // 版本重检：要核的版本（候选原锚，或用户显式
            // 重锚后的当前在用版）交给资产服务，在它的锁内与当前在用版比对
            // ——不在本文件写第二处比对。
            ...(candidate.stockOrganizationProvenance ? { expectedVersion: candidate.stockOrganizationProvenance.headVersion,
              expectedActiveVersion: candidate.stockOrganizationProvenance.activeVersion, expectedStatus: 'active' as const }
              : versionPlan.expectedVersion ? { expectedVersion: versionPlan.expectedVersion } : {}),
            ...(handoffActor === 'system' ? { expectedActiveVersion: candidate.targetVersionUsed, expectedStatus: 'active' as const } : {}),
            actor: handoffActor,
            reason: handoffReason,
            reviewDecisionId: decision.decision_id,
            sourceCandidateId: candidate.id,
          });
          if (handoffActor === 'system' && automaticReview?.policyEpoch) {
            const { withAutomaticStandingPreferenceUpdate } = await import('./standing-preference-authority');
            stored = await withAutomaticStandingPreferenceUpdate(userId, candidate, decision.decision_id, automaticReview.policyEpoch, commitUpdate);
          } else stored = await commitUpdate();
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
    // 重锚留痕：确认**已生效**之后才补记原锚，未生效
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
      ...(automaticReview ? { autoReview: automaticReview } : {}),
      reviewDecisionId: decision.decision_id,
      failureCode: undefined,
      failureMessage: undefined,
      failedAt: undefined,
      updatedAt: now,
    };
    })));
    })());
  } catch (error) {
    if ((error as Error).name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR') throw error;
    const message = error instanceof Error ? error.message : String(error);
    // 版本冲突不使候选落终态，也不修改资产；版本比对由资产服务在锁内执行。
    // 台账仅记录未生效的确认尝试，不将并发冲突记成候选失败。
    const versionConflict = recallCandidateVersionConflictOf(error);
    const reviewHeld = ['nightly_automatic_approval_held', 'baseline_changed', 'stock_organization_baseline_changed', 'formation_blocked', 't_review_required', 'shared_body_mismatch', 'shared_body_owner_conflict', 'invalid_reference'].includes(String((error as { code?: string }).code || ''));
    if (decision) {
      await recordReviewDecisionOutcome(
        userId,
        `recall_candidate:${candidateId}`,
        decision.decision_id,
        { failureCode: versionConflict ? 'version_conflict' : reviewHeld ? String((error as { code?: string }).code) : 'asset_write_failed' },
      ).catch(() => undefined);
      if (versionConflict || reviewHeld) throw error;
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
