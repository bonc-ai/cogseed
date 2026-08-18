import * as fs from 'node:fs/promises';
import * as personalOntologyCandidates from '../personal_ontology_candidates';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { createLogger } from '../../logger';
import { resolveAssetLifecycle } from './formal-assets/policy';
import { describePromotionBlock, validatePromotionByAssetType, type PromotionBlockReason } from './formal-assets/promotion';
import { genId12, safeId } from '../../storage';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
import { recallJsonRecordPath } from './paths';
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
import { evaluateCandidate, isCandidateBlocked } from '../cognition/gate';
import { isCognitionSourceEnabled } from './source-control';
import {
  readReviewDecision,
  recordReviewDecisionOutcome,
  writeReviewDecision,
  type ReviewDecision,
} from '../cognition/review-decision';
import {
  cognitionSourceRefKey,
  normalizeCognitionSourceRefs,
  normalizeCognitionSourceRefsForWrite,
  type CognitionSourceRef,
  type CognitionSourceType,
} from './source-service';

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
export type AbilityAssetType = 'personal' | 'rule' | 'template' | 'skill_method';
export type RecallCandidateAction = 'create' | 'update' | 'limit_scope' | 'pause' | 'keep_current' | 'reject';
export type RecallCandidateRisk = 'low' | 'medium' | 'high';
export type RecallAbilityAssetLifecycleStatus = 'user_confirmed_unverified' | 'automatically_extracted_unverified' | 'system_precipitated_unverified';

const DEFAULT_CANDIDATE_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_DEFER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1_000;


export interface RecallCandidateRecord extends RecallJsonRecord {
  id: string;
  taxonomyVersion: 2;
  status: RecallCandidateStatus;
  judgment: string;
  /** Why retaining this cognition will be useful in later work. */
  value: string;
  summary?: string;
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
  promotedAssetId?: string;
  reviewDecisionId?: string;
  decisionNote?: string;
  /** 空间归属：候选来自哪个空间（空间绘画/任务产出的认知）。资产随 recall 全局存储，
   *  空间资产 tab 按此字段过滤显示；空间可读全局资产但显示只显示本空间产生的。 */
  spaceId?: string;
  cooldownUntil?: string;
  expiresAt: string;
  taskRunId?: string;
  targetAssetId?: string;
  /** Automatic semantic deduplication provenance. These links are audit hints,
   *  not lifecycle states: the candidate still ends in a normal state. */
  mergedInto?: string;
  mergedIntoAssetId?: string;
  failureCode?: 'asset_write_failed' | 'source_unavailable' | 'candidate_expired' | 'evidence_insufficient';
  failureMessage?: string;
  failedAt?: string;
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
  learningSignal?: KstarLearningSignal;
  learningProvenance?: KstarLearningProvenance;
  /** R-Box causal rule frozen from a delta_r lesson (world-model ontology). */
  causalRule?: CausalRule;
  ontologyRefs?: AbilityAssetOntologyRef[];
  relations?: AbilityAssetRelation[];
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
  /** 空间归属：资产由某空间的候选确认而来（随 recall 全局存储，不随空间删）。 */
  spaceId?: string;
  /** Provenance for assets learned from conversation sources. */
  sourceSessionIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SaveRecallCandidateInput {
  judgment: string;
  value?: string;
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
  learningSignal?: KstarLearningSignal;
  learningProvenance?: KstarLearningProvenance;
  captureKey?: string;
  /** 空间归属（可选）：来源会话/任务的 space_id。 */
  spaceId?: string;
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
  actor?: AbilityAssetActor;
  /** 仅在 actor === 'system' 时有意义；缺省按会话自动抽取线处理。 */
  provenance?: RecallPromotionProvenance;
  ontologyRefs?: AbilityAssetOntologyRef[];
  scopePolicy?: RecallAbilityAssetScopePolicy;
  decisionType?: 'accept' | 'modify';
  decisionId?: string;
  decisionReason?: string;
  riskAcknowledged?: boolean;
  /** R-Box causal rule; only activated when explicitly supplied by the user. */
  causalRule?: CausalRule;
}

const log = createLogger('recall.candidates');

/** 判重用的可比文本：与 capture-service 的同名归一化保持一致（大小写、
 *  空白、标点都不参与比较）。 */
function comparableJudgmentText(value: string): string {
  return String(value || '').normalize('NFKC').replace(/[\p{P}\p{S}\s]/gu, '').toLocaleLowerCase();
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

const MAX_SOURCE_SESSION_IDS = 50;

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

function requireAssetType(value: unknown): AbilityAssetType {
  if (value === 'personal' || value === 'rule' || value === 'template' || value === 'skill_method') return value;
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
  // A short-lived implementation wrote an undeclared `superseded` state for
  // semantic duplicates. Migrate it on read so one legacy record cannot make
  // the whole candidate list fail to load.
  if (value === 'superseded') return 'ignored';
  if (value === 'observed' || value === 'weak_observation' || value === 'pending_review'
    || value === 'deferred' || value === 'confirmed' || value === 'rejected'
    || value === 'ignored' || value === 'expired' || value === 'failed'
    // 语义去重候选合并路径（semanticDedupBeforePromote）写入的运行时状态；
    // 缺了它，池遍历（listRecallCandidates → asCandidate）遇到 superseded
    // 候选就抛 malformed——整个沉淀 degraded（已观测 19:37）。
    || value === 'superseded') return value;
  throw new Error('malformed recall candidate');
}

function isTerminalCandidate(status: RecallCandidateStatus): boolean {
  return status === 'confirmed' || status === 'rejected' || status === 'ignored' || status === 'expired';
}

function isSuppressedTerminalCandidate(status: RecallCandidateStatus): boolean {
  return status === 'rejected' || status === 'ignored' || status === 'expired';
}

export function isRecallCandidateReviewable(candidate: Pick<RecallCandidateRecord, 'status'>): boolean {
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
  if (!['completed', 'failed', 'cancelled', 'waiting_input'].includes(String(record.terminalStatus))) {
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
    terminalStatus: record.terminalStatus as 'completed' | 'failed' | 'cancelled' | 'waiting_input',
  };
}

function normalizeLearningProvenance(value: unknown): KstarLearningProvenance | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed candidate learning provenance');
  const record = value as Record<string, unknown>;
  if (!safeId(record.projectionId) || !safeId(record.forecastId) || !safeId(record.episodeId)) {
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
    forecastId: record.forecastId as string,
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
  if ((!sourceRefs.length || !evidenceRefs.length) && status !== 'observed' && status !== 'weak_observation') {
    throw new Error('malformed recall candidate evidence');
  }
  const learningSignal = normalizeLearningSignal(value.learningSignal);
  const learningProvenance = normalizeLearningProvenance(value.learningProvenance);
  const createdAt = requireIsoTimestamp(value.createdAt, 'candidate created at');
  const candidateValue = Object.prototype.hasOwnProperty.call(value, 'value')
    ? (boundedText(value.value, 'candidate value', 1_000) || '')
    : (boundedText(value.summary, 'candidate summary', 1_000) || value.judgment);
  return {
    ...value,
    taxonomyVersion: 2,
    status,
    value: candidateValue,
    suggestedType: requireAssetType(value.suggestedType),
    suggestedAction: requireCandidateAction(value.suggestedAction),
    risk: requireCandidateRisk(value.risk),
    sourceRefs,
    evidenceRefs,
    ...(cooldownUntil ? { cooldownUntil } : {}),
    expiresAt: requireIsoTimestamp(value.expiresAt, 'candidate expiry', new Date(Date.parse(createdAt) + DEFAULT_CANDIDATE_TTL_MS).toISOString()),
    ...(learningSignal ? { learningSignal } : {}),
    ...(learningProvenance ? { learningProvenance } : {}),
  } as RecallCandidateRecord;
}

function asAsset(value: RecallJsonRecord): RecallAbilityAssetRecord {
  if (
    typeof value.candidateId !== 'string' || typeof value.title !== 'string' ||
    typeof value.statement !== 'string' || !Array.isArray(value.evidenceRefs) ||
    typeof value.scope !== 'string' || typeof value.version !== 'string'
  ) throw new Error('malformed recall ability asset');
  const evidenceRefs = normalizeCognitionSourceRefs(value.evidenceRefs);
  if (!evidenceRefs.length) throw new Error('malformed recall ability asset evidence');
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

function fingerprint(input: Pick<RecallCandidateRecord, 'judgment' | 'value' | 'suggestedType' | 'suggestedScope' | 'suggestedAction' | 'targetAssetId'>): string {
  return [input.judgment, input.value, input.suggestedType, input.suggestedScope, input.suggestedAction, input.targetAssetId || '']
    .map((part) => part.trim().toLocaleLowerCase()).join('\n');
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

function candidateIdForCaptureKey(captureKey: string): string {
  return `cand-${createHash('sha256').update(captureKey).digest('hex').slice(0, 24)}`;
}

export async function listRecallCandidates(userId: string): Promise<RecallCandidateRecord[]> {
  let names: string[];
  try { names = await fs.readdir(candidateDirectory(userId)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map(async (name) => readRecallJsonRecord(userId, 'candidates', name.slice(0, -5))));
  return records.filter((record): record is RecallJsonRecord => Boolean(record)).map(asCandidate)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readRecallCandidate(userId: string, candidateId: string): Promise<RecallCandidateRecord> {
  const record = await readRecallJsonRecord(userId, 'candidates', candidateId);
  if (!record) throw new Error('recall candidate not found');
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
    summary: legacy.summary,
    suggestedType,
    suggestedScope: legacy.memory_scope === 'user' ? 'global' : 'project',
    sourceRefs: legacy.source_memory_refs.map((id) => ({ kind: 'memory', id })),
  });
}

export async function saveRecallCandidate(userId: string, input: SaveRecallCandidateInput): Promise<RecallCandidateRecord> {
  const judgment = boundedText(input.judgment, 'judgment', 4_000, true)!;
  const value = boundedText(input.value, 'value', 1_000);
  const summary = boundedText(input.summary, 'summary', 1_000);
  const uncertainty = boundedText(input.uncertainty, 'uncertainty', 1_000);
  const suggestedScope = boundedText(input.suggestedScope, 'suggested scope', 500) || '';
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
  if (captureKey && !safeId(captureKey)) throw new Error('invalid capture key');
  if (captureKey) {
    const captured = (await listRecallCandidates(userId)).find((candidate) => candidate.captureKey === captureKey);
    if (captured) return captured;
  }
  const now = new Date().toISOString();
  const resolvedValue = hasExplicitValue ? (value || '') : (summary || judgment);
  const expiresAt = requireIsoTimestamp(input.expiresAt, 'candidate expiry', new Date(Date.parse(now) + DEFAULT_CANDIDATE_TTL_MS).toISOString());
  const taskRunId = input.taskRunId === undefined ? undefined : boundedText(input.taskRunId, 'task run id', 160, true);
  if (taskRunId && !safeId(taskRunId)) throw new Error('invalid task run id');
  const targetAssetId = input.targetAssetId === undefined ? undefined : boundedText(input.targetAssetId, 'target asset id', 160, true);
  if (targetAssetId && !safeId(targetAssetId)) throw new Error('invalid target asset id');
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
  const candidateDraft = { judgment, value: resolvedValue, suggestedType, suggestedScope, suggestedAction, targetAssetId };
  const reviewReady = input.forceWeakObservation !== true
    && Boolean(resolvedValue) && sourceRefs.length > 0 && evidenceRefs.length > 0
    && Boolean(suggestedScope) && (hasExplicitAction || !hasExplicitValue)
    && (!candidateActionNeedsTarget(suggestedAction) || Boolean(targetAssetId));
  const existing = (await listRecallCandidates(userId)).find((candidate) => {
    if (fingerprint(candidate) !== fingerprint(candidateDraft)) return false;
    const hasNewEvidence = hasNewSourceRefs(candidate.evidenceRefs, evidenceRefs);
    const riskIncreased = maxCandidateRisk(candidate.risk, risk) !== candidate.risk;
    if (isSuppressedTerminalCandidate(candidate.status)) return !hasNewEvidence && !riskIncreased;
    if (candidate.status === 'confirmed') return !riskIncreased;
    return true;
  });
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
    taxonomyVersion: 2,
    ownerId: userId,
    id: captureKey ? candidateIdForCaptureKey(captureKey) : `cand-${genId12()}`,
    status: reviewReady ? 'pending_review' : 'weak_observation',
    judgment,
    value: resolvedValue,
    ...(summary ? { summary } : {}),
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
    ...(input.spaceId && safeId(input.spaceId) ? { spaceId: input.spaceId } : {}),
    ...(taskRunId ? { taskRunId } : {}),
    ...(targetAssetId ? { targetAssetId } : {}),
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
  return record;
}

export async function updateRecallCandidate(userId: string, candidateId: string, input: SaveRecallCandidateInput): Promise<RecallCandidateRecord> {
  const judgment = boundedText(input.judgment, 'judgment', 4_000, true)!;
  const value = boundedText(input.value, 'value', 1_000);
  const summary = boundedText(input.summary, 'summary', 1_000);
  const uncertainty = boundedText(input.uncertainty, 'uncertainty', 1_000);
  const suggestedScope = boundedText(input.suggestedScope, 'suggested scope', 500) || '';
  const suggestedType = requireAssetType(input.suggestedType);
  const sourceRefs = normalizeCognitionSourceRefsForWrite(input.sourceRefs);
  const evidenceRefs = normalizeCognitionSourceRefsForWrite(input.evidenceRefs || input.sourceRefs);
  const currentCandidate = await readRecallCandidate(userId, candidateId);
  if (currentCandidate.status === 'failed' && currentCandidate.reviewDecisionId) {
    const appliedAsset = await readAppliedHandoffAsset(
      userId,
      currentCandidate,
      currentCandidate.reviewDecisionId,
    );
    if (appliedAsset) {
      throw new Error('candidate has an incomplete asset handoff; retry confirmation before editing');
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
  const resolvedValue = hasExplicitValue ? (value || '') : (summary || currentCandidate.value || judgment);
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
  const nextFingerprint = fingerprint({ judgment, value: resolvedValue, suggestedType, suggestedScope, suggestedAction, targetAssetId });
  if (duplicates.some((candidate) => candidate.id !== candidateId && fingerprint(candidate) === nextFingerprint)) throw new Error('duplicate recall candidate');
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, (raw) => {
    if (!raw) throw new Error('recall candidate not found');
    const current = asCandidate(raw);
    if (isTerminalCandidate(current.status)) throw new Error('recall candidate is terminal');
    const reviewReady = Boolean(resolvedValue) && sourceRefs.length > 0 && evidenceRefs.length > 0
      && Boolean(suggestedScope) && (!candidateActionNeedsTarget(suggestedAction) || Boolean(targetAssetId));
    const now = new Date().toISOString();
    return {
      ...current,
      judgment,
      value: resolvedValue,
      ...(summary ? { summary } : {}),
      ...(uncertainty ? { uncertainty } : {}),
      suggestedType,
      suggestedScope,
      sourceRefs,
      evidenceRefs,
      suggestedAction,
      risk,
      ...candidateBoundaries,
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

export function deferRecallCandidate(userId: string, candidateId: string, note?: string): Promise<RecallCandidateRecord> {
  return decideWithoutAsset(userId, candidateId, 'defer', 'deferred', note);
}

export async function resumeRecallCandidate(userId: string, candidateId: string): Promise<RecallCandidateRecord> {
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, (current) => {
    if (!current) throw new Error('recall candidate not found');
    const storedStatus = normalizeCandidateStatus(current.status);
    const candidate = asCandidate(current);
    if (isTerminalCandidate(storedStatus)) throw new Error('recall candidate is terminal');
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
  actor: AbilityAssetActor = 'user',
): Promise<RecallCandidateRecord> {
  const decisionNote = boundedText(note, 'decision note', 1_000);
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, async (current) => {
    if (!current) throw new Error('recall candidate not found');
    const candidate = asCandidate(current);
    if (isTerminalCandidate(candidate.status)) return candidate;
    if (candidate.status === 'observed' || candidate.status === 'weak_observation') {
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
  if (!isRecallCandidateReviewable(candidate)) throw new Error('candidate is not ready for automatic capture');
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
  candidateTexts: Array<{ id: string; text: string }>;
  assetTexts: Array<{ id: string; text: string }>;
}> {
  const [candidates, assets] = await Promise.all([
    listRecallCandidates(userId).catch(() => [] as RecallCandidateRecord[]),
    import('./asset-service').then((m) => m.listAbilityAssets(userId)).catch(() => [] as RecallAbilityAssetRecord[]),
  ]);
  return {
    candidateTexts: candidates
      .filter((c) => c.status === 'observed' || c.status === 'weak_observation'
        || c.status === 'pending_review' || c.status === 'deferred' || c.status === 'failed')
      .map((c) => ({ id: c.id, text: String(c.judgment || '') })),
    assetTexts: assets
      .filter((a) => a.status !== 'deleted' && a.status !== 'purged' && a.status !== 'revoked')
      .map((a) => ({ id: a.id, text: String(a.statement || a.title || '') })),
  };
}

/** 晋升前资产语义查重（设计 §4.7/§4.9）。
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
  const { findSemanticDuplicate } = await import('./similarity');
  const pools = await loadDedupPools(userId);
  const outcome = await findSemanticDuplicate(userId, {
    text: String(candidate.judgment || ''),
    candidateTexts: pools.candidateTexts.filter((c) => c.id !== candidate.id),
    assetTexts: pools.assetTexts,
    excludeIds: new Set([candidate.id]),
  });
  // 查重没做成 ≠ 没有重复。embedding 不可用时不能当作"查过且干净"继续晋升，
  // 否则两条沉淀线会无声地各写一条讲同一件事的正式资产（指纹拦不住，两边
  // judgment 文本几乎从不逐字相同）。这里抛错，让自动线把候选留在池子里等
  // 人工确认；用户手动确认的晋升路径不经过这里，不受影响。
  if (outcome.status === 'degraded') {
    throw new SemanticDedupUnavailableError(outcome.reason);
  }
  if (outcome.status === 'no_match') return null;
  const match = outcome.match;
  if (match.kind === 'asset') {
    const asset = await readAbilityAssetSafe(userId, match.id);
    if (!asset) return null;
    const updateCandidate = await updateRecallCandidate(userId, candidate.id, {
      judgment: candidate.judgment,
      value: candidate.value,
      summary: candidate.summary,
      uncertainty: candidate.uncertainty,
      suggestedType: candidate.suggestedType,
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
    const linked = await readRecallCandidate(userId, candidate.id);
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
    reason: 'evidence merged from candidate on semantic dedup',
    actor: 'system',
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
      if (candidate.status !== 'pending_review') {
        failed.push({ candidateId, error: 'candidate is not pending review' });
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
  if (!sourceRefs.length) throw new Error('malformed recall asset handoff receipt sources');
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
): Promise<{ candidate: RecallCandidateRecord; asset: RecallAbilityAssetRecord; decision: ReviewDecision; receipt: RecallAssetHandoffReceipt }> {
  if (options.actor !== 'user' && options.actor !== 'system') {
    throw new Error('recall candidate promotion requires a user actor or system actor');
  }
  const ontologyRefs = options.ontologyRefs === undefined ? undefined : normalizeAbilityAssetOntologyRefs(options.ontologyRefs);
  const relationContract = readAbilityAssetRelationContract(options as Record<string, unknown>);
  const optionSemantics = readAbilityAssetSemantics(options as unknown as Record<string, unknown>);
  const preflight = await readRecallCandidate(userId, candidateId);
  let targetSemantics: AbilityAssetSemantics = {};
  if (preflight.targetAssetId && candidateActionNeedsTarget(preflight.suggestedAction)) {
    const target = await readAbilityAsset(userId, preflight.targetAssetId);
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
    ...(optionSemantics.sensitivity !== undefined
      ? { sensitivity: optionSemantics.sensitivity }
      : targetSemantics.sensitivity !== undefined ? { sensitivity: targetSemantics.sensitivity } : {}),
  };
  // 条件是评审时新写下的自由文本，不一定走 saveRecallCandidate 那道闸，这里补上。
  assertNotForbiddenToPersist([
    ...(semantics.applicableWhen || []),
    ...(semantics.forbiddenWhen || []),
  ]);
  const causalRule = options.causalRule === undefined ? undefined : normalizeCausalRule(options.causalRule);
  const scopePolicy = normalizeAbilityAssetScopePolicy(options.scopePolicy);

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
  let updated: RecallJsonRecord;
  try {
    updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, async (current) => {
    if (!current) throw new Error('recall candidate not found');
    const candidate = asCandidate(current);
    if (candidate.status === 'confirmed') return candidate;
    if (isTerminalCandidate(candidate.status)) throw new Error('recall candidate is terminal');
    if (candidate.status === 'weak_observation' || candidate.status === 'observed') {
      throw new Error('candidate evidence is insufficient for review');
    }
    if (candidate.risk === 'high' && (options.actor !== 'user' || options.riskAcknowledged !== true)) {
      throw new Error('high-risk candidate requires an independent risk gate');
    }
    if (candidate.suggestedAction === 'keep_current' || candidate.suggestedAction === 'reject') {
      throw new Error('candidate action must use its non-asset review decision');
    }
    const gate = evaluateCandidate({
      title: candidate.summary,
      summary: candidate.value,
      body: candidate.judgment,
    });
    if (isCandidateBlocked(gate)) throw new Error('candidate is blocked by cognition security gate');
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
    if (unavailableSources.length || !candidate.evidenceRefs.length) {
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
    // lifecycleStatus 记录的是"这条资产是谁写进来的"，与成熟度（验证到哪一步）
    // 正交。三个值必须都能写出来，否则 KStar 自进化沉淀会被伪装成会话自动抽取。
    const handoffLifecycleStatus: RecallAbilityAssetLifecycleStatus = handoffActor === 'user'
      ? 'user_confirmed_unverified'
      : resolveAssetLifecycle({
        lifecycleStatus: options.provenance === 'kstar'
          ? 'system_precipitated_unverified'
          : 'automatically_extracted_unverified',
      });
    const now = new Date().toISOString();
    let stored: RecallAbilityAssetRecord;
    const handoffReason = `review_decision:${decision.decision_id}`;
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
      stored = await createAbilityAsset(userId, {
        schemaVersion: 2,
        ownerId: userId,
        id: assetId,
        candidateId: candidate.id,
        sourceCandidateIds: [candidate.id],
        reviewDecisionId: decision.decision_id,
        type: candidate.suggestedType,
        title: candidate.summary || candidate.judgment.slice(0, 120),
        // Substantive statement: judgment (what to retain) + value (why it
        // matters / future value) when present — the value clause is the
        // reusable insight, and a bare conclusion sentence alone is too thin
        // to stand as a method/template asset body.
        statement: [
          candidate.judgment,
          ...(candidate.value?.trim() && candidate.value !== candidate.judgment
            ? [candidate.value.trim()]
            : []),
        ].join('\n').slice(0, 4_000),
        evidenceRefs: candidate.evidenceRefs,
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
        stored = await updateAbilityAsset(userId, target.id, {
          title: candidate.summary || candidate.judgment.slice(0, 120),
          statement: candidate.judgment,
          scope: candidate.suggestedScope,
          // An update adds evidence to the chain; it must not erase the
          // evidence already supporting the target asset.
          evidenceRefs: mergeSourceRefs(target.evidenceRefs, candidate.evidenceRefs),
          ...(ontologyRefs?.length ? { ontologyRefs } : {}),
          ...relationContract,
          ...semantics,
          ...(scopePolicy ? { scopePolicy } : {}),
          actor: handoffActor,
          reason: handoffReason,
          reviewDecisionId: decision.decision_id,
          sourceCandidateId: candidate.id,
        });
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
    if (decision) {
      await recordReviewDecisionOutcome(
        userId,
        `recall_candidate:${candidateId}`,
        decision.decision_id,
        { failureCode: 'asset_write_failed' },
      ).catch(() => undefined);
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
  // 新的 personal 资产要投影进已安装角色模板的字段。这一步过去只有渲染层在
  // 打开「关于我」时触发，用户不进那个页面就永远不同步。资产已经落盘，投影
  // 是单向增量视图，失败不能反过来把这次晋升变成错误——所以只 fire-and-forget
  // 并记日志。schedulePersonalProfileSync 自带同用户在途去重。
  if (asset.type === 'personal') {
    void import('./personal-profile-sync')
      .then((mod) => mod.schedulePersonalProfileSync(userId))
      .catch((error) => log.warn('personal profile projection after promote degraded', {
        userId,
        assetId: asset.id,
        error: (error as Error).message,
      }));
  }
  return { candidate, asset, decision, receipt };
}
