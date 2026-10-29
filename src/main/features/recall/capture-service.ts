import { cognitionMessageSourceRef } from './source-locator';
import { captureBudgetWindowKey, isCaptureModelFailureHeld, resetCaptureModelFailureGuard } from './capture-model-budget';
import { runStockOrganization, readStockOrganizationSavedCount, type StockOrganizationProgress } from './stock-organization';
import { resolveRecallCaptureModelCandidates } from './capture-model-selection';
import { queuedNightlyFeedback, feedbackObservation, admitNightlyFeedback, type NightlyFeedbackObservation } from './nightly-feedback';
import { isContentCategory, type CognitionContentCategory } from './content-category';
import { RECALL_TEXT_LIMITS } from './content-contract';
import { parseFormationProposalEnvelope } from './formation-proposal';
import { captureValueJudgmentInput, parseCaptureValueJudgment, type CaptureValueJudgment } from './capture-value-judgment';
import { captureSummaryDecisionDigest } from './capture-provenance';
import { assessFormationBatch, analyzeFormationDependencies, FormationBatchUnavailableError, type FormationBatchCheckpoint } from './formation-batch-assessment';
import { captureSourcePassages } from './capture-context-payload';
import { findConversationMessageById } from './conversation-message-lookup';
import { validateFormationComparison, type FormationComparison } from './formation-comparison';
import { observeCaptureBatchUncertainty, type CaptureUncertaintyAssessment } from './capture-uncertainty';
import { hasFormationRuleChanges, reviseFormationRuleSemantics, formationRuleContracts, formationRuleContext, deriveFormationRuleRevisions,
  type SourceRuleConclusion, type FormationRuleRevision } from './ontology-rule-semantics';
import { captureExistingAssetReadContext, loadCaptureExistingAssetPool, selectCaptureExistingAssetsFromPool,
  type CaptureExistingAssetsResult, type CaptureExistingAssetPool } from './capture-existing-assets';
import { readOntologyDocument } from '../cognition/ontology/service';
import {
  buildOntologyFormationContext, buildSourceQualifiedOntologyFormationContext, ontologyFormationPromptContract, parseOntologyFormationProposal, validateOntologyFormationScope,
} from './ontology-formation';
import {
  summarizeCaptureContext, captureContextSourceDigest, validateCaptureContextSummary,
  CaptureContextInterruptedError, type CaptureContextCheckpoint, type CaptureContextSummary,
} from './capture-context-summary';
import { nonRetainableActivityContent } from './activity-projection';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { maskId } from '../../util/log-redact';
import { prompts } from '../../prompts/loader';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
import { runRecallCaptureModel } from './capture-model-routing';
import { safeId } from '../../storage';
import { scheduleBootBackground, type ScheduledBootBackgroundTask } from '../../util/boot_init';
import { getConfiguredModelOAuthExpiredMessage, getConfiguredModelOAuthExpiredMessageForUser, hasConfiguredModel, hasConfiguredModelForUser } from '../auth';
import * as chats from '../chats';
import { detectAll } from '../local_agents/registry';
import type { ReviewDecision } from '../cognition/review-decision';
import { getRecallCandidateCapabilities, recallCandidateError, type RecallCandidateCapabilities } from './candidate-capabilities';
import { isAssetScopeAllowed, normalizeAssetScopeValue } from './scope-policy';
import type { PersonalProfileSyncResult, PersonalProfileTarget } from './personal-profile-sync';
import {
  isQuiescent,
} from '../group_chat/bus';
import { readMembers } from '../group_chat/state';
import type { GroupMessage } from '../group_chat/visibility';
import { readAbilityAsset, readAbilityAssetVersionSnapshot } from './asset-service';
import { assertFeedbackResultContextsCurrent, readFeedbackResultContext, readFeedbackVersionContext, type FeedbackResultContext } from './feedback-version-context';
import {
  isAutoCaptureEligible,
  findCaptureCandidateReceipt,
  confirmRecallOntologyCandidate,
  listRecallCandidates,
  promoteRecallCandidate,
  readRecallAssetHandoffReceipt,
  readRecallCandidate,
  supersedeRecallCandidate,
  type AbilityAssetType,
  type RecallAssetHandoffReceipt,
  type RecallAbilityAssetRecord,
  type RecallCandidateRecord,
  type RecallCandidateStatus,
  type SaveRecallCandidateInput,
  type RecallOntologyCandidateConfirmation,
} from './candidate-service';
import { submitCognitionCandidate } from '../cognition/candidate-submission';
import { withCognitionTransition } from '../cognition_bridge';
import { recallJsonRecordPath } from './paths';
import { notifyCognitionWrite } from './store-events';
import type { CognitionSourceRef } from './source-service';
import {
  cognitionArtifactSourceId,
  cognitionMessageSourceId,
  listCognitionSources,
} from './source-catalog';
import { readCognitionSourceControl, listDisabledCognitionMessageIds } from './source-control';
import { createRecallView, isRecallViewExpired, readRecallView, type RecallViewRecord } from './recall-view-service';
import {
  readRecallJsonRecord,
  updateRecallJsonRecord,
} from './store';
import type { RecallJsonRecord } from './types';
import { listUserTeachingSignals } from './teaching-service';
import {
  isWithinNightlyWindow,
  migrateUnifiedDiscoverySettings,
  nextNightlyRunAt,
  readRecallCaptureSettings,
  captureAutoApprovalAuthorization,
  type RecallCaptureExecutionPolicy,
  type RecallCaptureSettingsRecord,
} from './capture-settings';
import {
  bumpRecallCaptureStats,
  type RecallCaptureStatsDelta,
} from './capture-stats';
import {
  assessRecallCandidateClassification,
  assessRecallCaptureCandidateQuality,
  isRecallCaptureCandidateGrounded,
  isTaskLocalRuleProposal,
  screenRecallCaptureValue,
  type RecallCaptureFilterReason,
  type RecallCaptureValueSignal,
} from './capture-value-screening';
import { isRecallAssistantMessage, isRecallConversationMessage } from './conversation-message-policy';

const log = createLogger('recall.capture');
const CAPTURE_COLLECTION = 'captures';
const MAX_MODEL_CANDIDATES = 64;
export type RecallCaptureStatus =
  | 'waiting_quiet'
  | 'waiting_completion'
  | 'waiting_manual'
  | 'scheduled'
  | 'queued'
  | 'extracting'
  | 'writing'
  | 'paused'
  | 'review_ready'
  | 'no_candidate'
  | 'completed'
  | 'configuration_required'
  | 'failed'
  | 'cancelled';

export type RecallCaptureStage =
  | 'context_summary'
  | 'value_judgment'
  | 'model_check'
  | 'recall_view'
  | 'model_extraction'
  | 'candidate_save'
  | 'asset_write';

export interface RecallCaptureModelUsage {
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface RecallCaptureRecord extends RecallJsonRecord {
  id: string;
  taxonomyVersion: 2;
  conversationId: string;
  conversationTitle?: string;
  terminalRunId: string;
  anchorMessageId: string;
  messageIds: string[];
  /** Non-discovery messages retained in source order to explain new content. */
  contextMessageIds?: string[];
  status: RecallCaptureStatus;
  visibility: 'internal' | 'visible';
  screeningStatus: 'pending' | 'qualified' | 'filtered';
  screeningSignals?: RecallCaptureValueSignal[];
  screenedAt?: string;
  filterReason?: RecallCaptureFilterReason;
  /** 模型显式判空时它自己给的一句理由。只有 `model_no_candidate` 会带。 */
  noCandidateReason?: string;
  waitingCompletionReason?: 'terminal_waiting_input' | 'activity_changed';
  stage?: RecallCaptureStage;
  executionPolicy: RecallCaptureExecutionPolicy | 'immediate';
  quietMinutes?: number;
  lastActivityAt?: string;
  scheduledFor?: string;
  nightlyStart?: string;
  nightlyEnd?: string;
  catchUpMissed?: boolean;
  resumeStatus?: 'waiting_quiet' | 'waiting_completion' | 'waiting_manual' | 'scheduled' | 'queued';
  attempt: number;
  candidateIds: string[];
  /** 终态时点固化的复核计数快照：workflowStatus 判定以它
   *  为准，杜绝 defer 冷却过期等读取时点漂移把已完成任务翻成失败。 */
  reviewSnapshot?: RecallCaptureReviewSummary;
  writingCandidateId?: string;
  /** 历史自动写入标记，只用于读兼容；新提取不设置、不授予发布权限。 */
  autoWrite?: boolean;
  autoApprovalEpoch?: string;
  autoApprovalEnabledAt?: string;
  recallViewId?: string;
  errorCode?: string;
  /** 失败细分（固定校验器短语或宿主失败 token，≤80 字符，非用户/模型文本）。
   *  旧记录无此字段照常读取；与 errorCode 同步清除。 */
  reasonCode?: string;
  recoveredAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  modelUsage?: RecallCaptureModelUsage;
  extractionRepairAttempted?: boolean;
  formationBatchAssessment?: FormationBatchCheckpoint;
  /** Source-bound semantic observations; no raw conversation or effect proof. */
  uncertaintyAssessments?: Array<CaptureUncertaintyAssessment & { candidateIndex: number }>;
  /** Evaluation availability is separate from an explicit unsupported verdict.
   * These observations carry no source text or publication authority. */
  candidateSupportUnavailable?: Array<{ candidateIndex: number; stage: 'grounding' | 'uncertainty'; reason: string; candidateHash: string; relatedAssetIds?: string[] }>;
  candidateSupportUnavailableCount?: number;
  valueJudgment?: CaptureValueJudgment;
  contextSummary?: CaptureContextSummary;
  summaryCheckpoint?: CaptureContextCheckpoint;
  extractionCompletedAt?: string;
  formationCheckpoint?: RecallCaptureFormationCheckpoint;
  feedbackRevision?: string;
  feedbackObservations?: NightlyFeedbackObservation[];
  feedbackVersionContexts?: Array<NightlyFeedbackObservation & { resultContext?: FeedbackResultContext; versionContext?: unknown }>;
  reviewDay?: string;
  /** Absolute admission boundaries survive timezone changes and later retries. */
  reviewDayStart?: string;
  reviewDayEnd?: string;
  lastAttemptReviewDay?: string;
  createdAt: string;
  updatedAt: string;
}

/** A complete, validated preparation is durable before the first group write.
 * Sources and versions are rechecked during replay; model groups never regenerate. */
export interface RecallCaptureFormationCheckpoint {
  version: 1; sourceDigest: string; summaryDigest: string; judgedAt: string; completedAt: string;
  sourceScope: { projectId?: string; workspaceId?: string; conversationKind?: string };
  groups: Array<{ index: number; input: SaveRecallCandidateInput; savedCandidateId?: string; omitted?: boolean; submissionStarted?: true;
    ruleSourceAssessment?: { policyVersion: 3; sourceFingerprint: string; batchFingerprint: string; finalInputFingerprint: string;
      conclusions: SourceRuleConclusion[]; resultingContracts: FormationRuleRevision[] } }>;
  /** Frozen, safe parsed groups still needing support; absent on legacy complete checkpoints. */
  pendingCandidates?: Array<{ index: number; candidate: ParsedCandidate }>;
  /** Source-only proposals remain unchanged until the asset decision is committed. */
  sourceProposalVersion?: 1;
  /** Read-only compatibility for checkpoints created by an earlier local build. */
  formationDrafts?: Array<{ index: number; candidate: ParsedCandidate }>;
  formationGeneration?: number;
  assetBaselineAttempt?: number;
  supportPendingIndexes?: number[];
  assetBaselineDigest?: string;
  assetBaselineRefreshes?: 0 | 1;
  formationNeedsRefresh?: boolean;
  parsedCount: number; emittedCount: number; noCandidateReason?: string; modelUsage?: RecallCaptureModelUsage;
}

export type RecallCaptureWorkflowStatus = RecallCaptureStatus | 'completed' | 'partial';

export type RecallCaptureDisplayStatus =
  | 'waiting'
  | 'extracting'
  | 'review_ready'
  | 'writing'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type RecallCaptureDisplayReason =
  | 'quiet_period'
  | 'conversation_active'
  | 'manual_start_required'
  | 'nightly_window'
  | 'queued'
  | 'paused'
  | 'extracting'
  | 'asset_write'
  | 'review_pending'
  | 'no_candidate'
  | 'review_completed'
  | 'partial_support'
  | 'model_not_configured'
  | 'model_auth_required'
  | 'asset_write_failed'
  | 'asset_write_interrupted'
  | 'capture_failed'
  | 'cancelled';

export type RecallCaptureAction = 'review_candidates' | 'view_assets' | 'open_conversation';

export interface RecallCaptureReviewSummary {
  total: number;
  pending: number;
  deferred: number;
  promoted: number;
  rejected: number;
  integrated: number;
  missing: number;
}

export type RecallCaptureNextAction = 'review_candidates' | 'view_assets' | 'none';

/** Only a completed concrete proposal can require user attention. Background
 * diagnostics stay silent; historical completed records remain readable. */
export type RecallCaptureBucket = 'attention' | 'active' | 'silent' | 'done';

export function captureBucket(capture: Pick<RecallCaptureRecord, 'status'>): RecallCaptureBucket {
  if (capture.status === 'no_candidate') return 'done';
  if (capture.status === 'review_ready') return 'attention';
  if (['failed', 'configuration_required', 'paused', 'waiting_manual'].includes(capture.status)) return 'silent';
  if (['completed', 'cancelled'].includes(capture.status)) return 'done';
  return 'active';
}

/** Background diagnostics have no candidate/asset joins and never become a
 * user-managed task. Internal empty results also avoid reading legacy IDs. */
function isSilentCapture(capture: RecallCaptureRecord): boolean {
  return capture.visibility === 'internal' && (!capture.candidateIds.length || capture.status === 'no_candidate');
}

/** 整理详情使用的候选展示投影，随 workflow 记录下发。
 * 从全量候选池读取实际消费字段，不依赖只覆盖最近记录的 review-queue 窗口。 */
export interface RecallCaptureCandidateOutcome {
  proposalTarget?: RecallCandidateRecord['proposalTarget'];
  automaticUndo?: RecallCandidateRecord['automaticUndo'];
  id: string;
  status: RecallCandidateStatus;
  summary: string;
  judgment: string;
  contentCategory?: import('./content-category').StoredCognitionContentCategory;
  suggestedType: AbilityAssetType;
  suggestedScope: string;
  sourceRefs: CognitionSourceRef[];
  evidenceRefs: CognitionSourceRef[];
  /** pending 过滤口径与队列同源（getRecallCandidateCapabilities 现算）。 */
  capabilities: RecallCandidateCapabilities;
}

export interface RecallCaptureWorkflowRecord extends RecallCaptureRecord {
  workflowStatus: RecallCaptureWorkflowStatus;
  displayStatus: RecallCaptureDisplayStatus;
  displayReason: RecallCaptureDisplayReason;
  bucket: RecallCaptureBucket;
  reviewSummary: RecallCaptureReviewSummary;
  linkedAssetIds: string[];
  confirmedAssetReceipts: RecallCaptureConfirmedAssetReceipt[];
  /** 整理结果内联投影：见 RecallCaptureCandidateOutcome。 */
  candidateOutcomes: RecallCaptureCandidateOutcome[];
  nextAction: RecallCaptureNextAction;
  actions: RecallCaptureAction[];
}

/** Small, display-safe view of a formal asset created through candidate review. */
export interface RecallCaptureConfirmedAssetReceipt {
  assetId: string;
  assetType: AbilityAssetType;
  version: string;
  scope: string;
  sourceRefCount: number;
  reviewDecisionId: string;
}

export interface RecallCaptureCandidatePromotion {
  candidate: RecallCandidateRecord;
  asset: RecallAbilityAssetRecord;
  decision: ReviewDecision;
  receipt: RecallAssetHandoffReceipt;
  profileProjection?: PersonalProfileSyncResult;
  /** 原样透传的版本重检口径（本层不判定版本）：
   *  `versionCheckSkipped`（复盘候选缺 targetVersionUsed，没能核对改进对象）
   *  与显式重锚成功后的 `rebasedFrom`（原锚）。 */
  versionCheckSkipped?: true;
  rebasedFrom?: string;
}

export type RecallCaptureQueryStatus = RecallCaptureStatus | RecallCaptureDisplayStatus | 'completed';

/** 列表范围：visible=只看用户可见记录（默认，既有口径）；all=含系统内部
 *  记录（被筛掉的 no_candidate、内部失败等），配合 bucket 分桶展示。 */
export type RecallCaptureListScope = 'visible' | 'all';

export interface ListRecallCapturesQuery {
  statuses?: RecallCaptureQueryStatus[];
  executionPolicy?: RecallCaptureExecutionPolicy | 'immediate';
  cursor?: string;
  limit?: number;
  scope?: RecallCaptureListScope;
}

export interface RecallCaptureCounts {
  waiting: number;
  processing: number;
  review: number;
  failed: number;
  completed: number;
  cancelled: number;
  partial?: number;
}

export interface RecallCaptureBucketCounts {
  attention: number;
  active: number;
  silent: number;
  done: number;
}

export interface RecallCapturePage {
  captures: RecallCaptureWorkflowRecord[];
  nextCursor: string | null;
  counts: RecallCaptureCounts;
  buckets: RecallCaptureBucketCounts;
}

export interface CapturePromptMessage {
  observations?: NightlyFeedbackObservation[];
  label: string;
  id: string;
  ts: string;
  role: 'user' | 'assistant';
  text: string;
  discovery?: boolean;
  artifacts: Array<{ id: string; title: string; conversationId: string }>;
}

interface ParsedCandidate {
  proposalTarget?: 'cognition' | 'ontology' | 'joint';
  formationProposalId?: string;
  judgment: string;
  value: string;
  valueProvided: boolean;
  summary: string;
  uncertainty?: string;
  contentCategory?: CognitionContentCategory;
  suggestedType: AbilityAssetType;
  suggestedScope: string;
  suggestedAction?: 'create' | 'update' | 'limit_scope' | 'pause' | 'keep_current' | 'reject';
  actionProvided: boolean;
  risk?: 'low' | 'medium' | 'high';
  targetAssetId?: string;
  /** 规则候选的适用/禁止范围。缺失 = 模型没给出，不是「无限制」。 */
  applicableWhen?: string[];
  forbiddenWhen?: string[];
  evidence: string[];
  ontologyChanges?: unknown;
  comparison?: FormationComparison;
}

class CaptureFailure extends Error {
  /** Optional machine-readable sub-reason (fixed validator phrase or host
   * failure token; never user or model text) persisted beside `errorCode`. */
  constructor(readonly code: string, message: string, readonly reasonCode?: string) {
    super(message);
  }
}

function captureDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, CAPTURE_COLLECTION, 'placeholder'));
}

function isCaptureStatus(value: unknown): value is RecallCaptureStatus {
  return value === 'waiting_quiet'
    || value === 'waiting_completion'
    || value === 'waiting_manual'
    || value === 'scheduled'
    || value === 'queued'
    || value === 'extracting'
    || value === 'writing'
    || value === 'paused'
    || value === 'review_ready'
    || value === 'no_candidate'
    || value === 'completed'
    || value === 'configuration_required'
    || value === 'failed'
    || value === 'cancelled';
}

function isCaptureStage(value: unknown): value is RecallCaptureStage {
  return value === 'context_summary' || value === 'value_judgment' || value === 'model_check'
    || value === 'recall_view'
    || value === 'model_extraction'
    || value === 'candidate_save'
    || value === 'asset_write';
}

function isExecutionPolicy(value: unknown): value is RecallCaptureRecord['executionPolicy'] {
  return value === 'smart' || value === 'immediate' || value === 'nightly' || value === 'manual';
}

function isCaptureVisibility(value: unknown): value is RecallCaptureRecord['visibility'] {
  return value === 'internal' || value === 'visible';
}

function isCaptureScreeningStatus(value: unknown): value is RecallCaptureRecord['screeningStatus'] {
  return value === 'pending' || value === 'qualified' || value === 'filtered';
}

const CAPTURE_VALUE_SIGNALS = new Set<RecallCaptureValueSignal>([
  'preference', 'rule', 'decision', 'template', 'method', 'artifact',
  'reusable_outcome', 'substantive_exchange', 'manual_selection',
]);

const CAPTURE_FILTER_REASONS = new Set<RecallCaptureFilterReason>([
  'trivial_exchange', 'no_result', 'low_reuse_value', 'model_no_candidate',
  'candidate_unparsable', 'candidate_quality',
]);

function isCaptureValueSignals(value: unknown): value is RecallCaptureValueSignal[] {
  return Array.isArray(value) && value.length <= CAPTURE_VALUE_SIGNALS.size
    && value.every((signal) => typeof signal === 'string' && CAPTURE_VALUE_SIGNALS.has(signal as RecallCaptureValueSignal));
}

function isQuietMinutes(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 120;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function optionalTimestampIsValid(value: unknown): boolean {
  return value === undefined || isIsoTimestamp(value);
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function normalizeModelUsage(value: unknown): RecallCaptureModelUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const usage: RecallCaptureModelUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    if (Number.isFinite(raw[key]) && Number(raw[key]) >= 0) usage[key] = Math.floor(Number(raw[key]));
  }
  for (const key of ['provider', 'model'] as const) {
    if (typeof raw[key] === 'string' && raw[key].trim()) usage[key] = raw[key].trim().slice(0, 200);
  }
  return Object.keys(usage).length ? usage : undefined;
}

function asCapture(value: RecallJsonRecord): RecallCaptureRecord {
  if (
    !isCaptureStatus(value.status)
    || typeof value.conversationId !== 'string'
    || (value.conversationTitle !== undefined && typeof value.conversationTitle !== 'string')
    || typeof value.terminalRunId !== 'string'
    || typeof value.anchorMessageId !== 'string'
    || !Array.isArray(value.messageIds)
    || value.messageIds.some((id) => typeof id !== 'string')
    || (value.contextMessageIds !== undefined && (!Array.isArray(value.contextMessageIds)
      || value.contextMessageIds.some(id => typeof id !== 'string')))
    || ((value.reviewDayStart !== undefined || value.reviewDayEnd !== undefined)
      && (!isIsoTimestamp(value.reviewDayStart) || !isIsoTimestamp(value.reviewDayEnd)
        || Date.parse(value.reviewDayStart) >= Date.parse(value.reviewDayEnd)))
    || !Number.isInteger(value.attempt)
    || Number(value.attempt) < 1
    || !Array.isArray(value.candidateIds)
    || value.candidateIds.some((id) => typeof id !== 'string')
    || (value.writingCandidateId !== undefined
      && (typeof value.writingCandidateId !== 'string' || !safeId(value.writingCandidateId)))
    || (value.autoWrite !== undefined && typeof value.autoWrite !== 'boolean')
    || (value.recallViewId !== undefined && (typeof value.recallViewId !== 'string' || !safeId(value.recallViewId)))
    || (value.stage !== undefined && !isCaptureStage(value.stage))
    || (value.executionPolicy !== undefined && !isExecutionPolicy(value.executionPolicy))
    || (value.visibility !== undefined && !isCaptureVisibility(value.visibility))
    || (value.screeningStatus !== undefined && !isCaptureScreeningStatus(value.screeningStatus))
    || (value.screeningSignals !== undefined && !isCaptureValueSignals(value.screeningSignals))
    || (value.filterReason !== undefined
      && (typeof value.filterReason !== 'string' || !CAPTURE_FILTER_REASONS.has(value.filterReason as RecallCaptureFilterReason)))
    || (value.noCandidateReason !== undefined
      && (typeof value.noCandidateReason !== 'string' || value.noCandidateReason.length > 500))
    || (value.waitingCompletionReason !== undefined
      && value.waitingCompletionReason !== 'terminal_waiting_input'
      && value.waitingCompletionReason !== 'activity_changed')
    || (value.quietMinutes !== undefined && !isQuietMinutes(value.quietMinutes))
    || (value.nightlyStart !== undefined && (typeof value.nightlyStart !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.nightlyStart)))
    || (value.nightlyEnd !== undefined && (typeof value.nightlyEnd !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.nightlyEnd)))
    || (value.catchUpMissed !== undefined && typeof value.catchUpMissed !== 'boolean')
    || (value.resumeStatus !== undefined
      && value.resumeStatus !== 'waiting_quiet'
      && value.resumeStatus !== 'waiting_completion'
      && value.resumeStatus !== 'waiting_manual'
      && value.resumeStatus !== 'scheduled'
      && value.resumeStatus !== 'queued')
    || !optionalTimestampIsValid(value.scheduledFor)
    || !optionalTimestampIsValid(value.lastActivityAt)
    || !optionalTimestampIsValid(value.screenedAt)
    || !optionalTimestampIsValid(value.recoveredAt)
    || !optionalTimestampIsValid(value.startedAt)
    || !optionalTimestampIsValid(value.finishedAt)
    || !optionalNonNegativeInteger(value.durationMs)
    || !isIsoTimestamp(value.createdAt)
    || !isIsoTimestamp(value.updatedAt)
  ) throw new Error('malformed recall capture');
  const executionPolicy = isExecutionPolicy(value.executionPolicy) ? value.executionPolicy : 'immediate';
  const status = value.status as RecallCaptureStatus;
  const legacyVisible = executionPolicy === 'manual'
    || ['paused', 'review_ready', 'writing', 'completed', 'configuration_required', 'failed', 'cancelled'].includes(status);
  const visibility = !value.candidateIds.length && !['completed', 'cancelled'].includes(status)
    ? 'internal' : isCaptureVisibility(value.visibility) ? value.visibility : legacyVisible ? 'visible' : 'internal';
  const screeningStatus = isCaptureScreeningStatus(value.screeningStatus)
    ? value.screeningStatus
    : executionPolicy === 'manual'
      ? 'qualified'
      : status === 'no_candidate'
        ? 'filtered'
        : ['waiting_quiet', 'waiting_completion', 'scheduled', 'queued', 'extracting'].includes(status)
          ? 'pending'
          : 'qualified';
  return {
    ...value,
    taxonomyVersion: 2,
    executionPolicy,
    visibility,
    screeningStatus,
    stage: ['review_ready', 'no_candidate', 'completed', 'cancelled'].includes(String(value.status))
      ? undefined
      : value.stage,
    ...(normalizeModelUsage(value.modelUsage) ? { modelUsage: normalizeModelUsage(value.modelUsage) } : {}),
    ...(typeof value.reasonCode === 'string' && value.reasonCode.trim() ? { reasonCode: value.reasonCode } : {}),
  } as RecallCaptureRecord;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function truncateText(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}


function sameIds(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((id) => rightSet.has(id));
}

export function selectCaptureMessages(
  messages: GroupMessage[],
  startedAtMs: number,
  finishedAtMs: number,
  anchorMessageId?: string,
  finishedMessageId?: string,
): CapturePromptMessage[] {
  const anchorIndex = anchorMessageId
    ? messages.findIndex((message) => message.id === anchorMessageId)
    : -1;
  const finishedIndex = anchorIndex >= 0 && finishedMessageId
    ? messages.findIndex((message, index) => index >= anchorIndex && message.id === finishedMessageId)
    : -1;
  const boundedMessages = anchorIndex >= 0
    ? messages.slice(anchorIndex, finishedIndex >= anchorIndex ? finishedIndex + 1 : undefined)
    : messages;
  const secondAlignedStart = Math.floor(startedAtMs / 1_000) * 1_000;
  const inRun = boundedMessages.filter((message) => {
    if (!isRecallConversationMessage(message)) return false;
    const at = timestampMs(message.ts);
    if (anchorIndex >= 0) return at <= finishedAtMs;
    return at >= secondAlignedStart && at <= finishedAtMs;
  });
  // Source selection never applies a model budget. The summary stage submits
  // every character in bounded slices, including long intermediate responses.
  return inRun.map((message, index) => {
    return {
      label: `m${index + 1}`,
      id: message.id,
      ts: message.ts,
      role: isRecallAssistantMessage(message) ? 'assistant' : 'user',
      text: message.text,
      artifacts: (message.artifacts || []).slice(0, 10).map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        conversationId: artifact.source_cid || '',
      })),
    };
  });
}

function boundedRequiredText(value: unknown, field: string, max: number, preserveParagraphs = false): string {
  if (typeof value !== 'string') throw new CaptureFailure('invalid_model_output', `missing ${field}`);
  const text = preserveParagraphs ? value.replace(/\r\n?/g, '\n').trim() : value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > max) throw new CaptureFailure('invalid_model_output', `invalid ${field}`);
  return text;
}

/** Optional-model-field tolerance: missing, empty, or WRONG-TYPED values are
 *  dropped (undefined) instead of killing the whole candidate — models
 *  occasionally emit `uncertainty: 0.5` or a nested object where a string is
 *  expected. Core fields (judgment/value/summary/scope) stay strict. */
function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > max) return undefined;
  return text;
}

function parseCandidateAction(value: unknown): NonNullable<ParsedCandidate['suggestedAction']> {
  if (value === 'create' || value === 'update' || value === 'limit_scope' || value === 'pause'
    || value === 'keep_current' || value === 'reject') return value;
  throw new CaptureFailure('invalid_model_output', 'invalid suggestedAction');
}

function parseCandidateRisk(value: unknown): NonNullable<ParsedCandidate['risk']> {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw new CaptureFailure('invalid_model_output', 'invalid risk');
}

/** 容错解析模型输出：LLM 常把 JSON 包在 ```json 围栏里，或前后带散文/说明。
 *  先剥 markdown 围栏，再隔离最外层 {...}，最后 JSON.parse。任何一步失败
 *  都抛 invalid_model_output（与严格路径同码，语义不变）。 */
function parseCaptureJson(raw: string): unknown {
  let text = String(raw || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new CaptureFailure('invalid_model_output', 'model output is not strict JSON');
  }
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    throw new CaptureFailure('invalid_model_output', 'model output is not strict JSON');
  }
}

/** 模型解析结果保留原始产出数和有效候选数组，区分显式判空、全部解析丢弃、
 * 缺少 candidates 键三种情况；不能把解析侧丢弃记为内容没有候选。 */
export interface RecallCaptureParseResult {
  candidates: ParsedCandidate[];
  /** 模型在 `candidates` 数组里给出的原始条目数（含随后被丢弃的）。 */
  emittedCount: number;
  /** 模型显式判空时给出的理由（提示词要求随空数组一并返回）。 */
  noCandidateReason?: string;
}

/** 把批次层拒绝原因压缩成可落盘/可记日志的固定短语：zod 错误只留字段路径
 *  与 issue code，自家批次校验抛的是固定文案——两者都不携带模型或用户正文。 */
function rejectionReasonSummary(error: unknown): string | undefined {
  if (error instanceof CaptureFailure) return error.message;
  const issues = (error as { issues?: unknown } | null | undefined)?.issues;
  if (Array.isArray(issues) && issues.length) {
    const issue = issues[0] as { path?: unknown; code?: unknown };
    const fieldPath = Array.isArray(issue.path) ? issue.path.map(part => String(part)).join('.') : '';
    return `schema ${fieldPath || 'root'} ${String(issue.code ?? 'invalid')}`;
  }
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' && message ? message.slice(0, 200) : undefined;
}

export function parseRecallCaptureResult(raw: string, validLabels: Set<string>): RecallCaptureParseResult {
  let parsed: unknown;
  try {
    parsed = parseCaptureJson(raw);
  } catch (error) {
    if (error instanceof CaptureFailure) throw error;
    throw new CaptureFailure('invalid_model_output', 'model output is not strict JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CaptureFailure('invalid_model_output', 'model output must be an object');
  }
  if (Object.hasOwn(parsed, 'proposalVersion') || Object.hasOwn(parsed, 'proposals')) {
    try {
      const envelope = parseFormationProposalEnvelope(parsed, validLabels);
      if (envelope.firstDroppedReason) {
        log.warn('recall capture proposal skipped (malformed)', { reason: envelope.firstDroppedReason });
      }
      // 逐提案容错：单个提案在信封层或候选层违约只丢弃该提案，其余合法提案
      // 继续交付——与 legacy 分支同口径；身份/依赖校验仍在批次层整批拒绝。
      const versionedCandidates: ParsedCandidate[] = [];
      for (const proposal of envelope.proposals) {
        const body = proposal.target === 'ontology'
          ? { ...proposal.explanation, judgment: proposal.explanation.description, suggestedAction: 'create' }
          : proposal.cognition;
        try {
          const candidate = parseOneCandidate({ ...body,
            ...(proposal.target !== 'cognition' ? { ontologyChanges: proposal.ontologyChanges } : {}) }, validLabels);
          versionedCandidates.push({ ...candidate, proposalTarget: proposal.target, formationProposalId: proposal.id });
        } catch (error) {
          if (!(error instanceof CaptureFailure)) throw error;
          log.warn('recall capture candidate skipped (malformed)', { reason: error.message });
        }
      }
      return { emittedCount: envelope.emittedCount, candidates: versionedCandidates,
        ...(envelope.reason ? { noCandidateReason: envelope.reason } : {}) };
    } catch (error) {
      throw new CaptureFailure('invalid_model_output', 'invalid versioned formation proposal', rejectionReasonSummary(error));
    }
  }
  // A sibling plan has no candidate owner. Neither singleton assignment nor
  // dropping it can establish a complete jointly reviewed proposal; the
  // existing bounded extraction repair must regenerate the full response.
  if ((parsed as { ontologyChanges?: unknown }).ontologyChanges != null) {
    throw new CaptureFailure('invalid_model_output', 'ontologyChanges must belong inside its candidate');
  }
  const candidates = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length > MAX_MODEL_CANDIDATES) {
    throw new CaptureFailure('invalid_model_output', 'invalid candidate count');
  }

  // 逐候选容错：LLM 输出里单个候选字段非法（如缺少正文或证据）
  // 只丢弃该候选，保留其余合法候选——旧行为一个坏候选毁掉整批提取。
  const parsedOut: ParsedCandidate[] = [];
  for (const rawCandidate of candidates) {
    try {
      parsedOut.push(parseOneCandidate(rawCandidate, validLabels));
    } catch (error) {
      if (error instanceof CaptureFailure) {
        log.warn('recall capture candidate skipped (malformed)', {
          reason: error.message,
        });
        continue;
      }
      throw error;
    }
  }
  // 空返回时的理由是**可选**读取：模型不给也不算解析失败（旧记录、旧提示词都
  // 没有这个字段），只是那一条从此说不出所以然。
  const rawReason = (parsed as { reason?: unknown }).reason;
  const noCandidateReason = typeof rawReason === 'string' && rawReason.trim()
    ? rawReason.replace(/\s+/g, ' ').trim().slice(0, 500)
    : undefined;
  return {
    candidates: parsedOut,
    emittedCount: candidates.length,
    ...(noCandidateReason ? { noCandidateReason } : {}),
  };
}

/** 兼容只读取候选数组的调用方。 */
export function parseRecallCaptureOutput(raw: string, validLabels: Set<string>): ParsedCandidate[] {
  return parseRecallCaptureResult(raw, validLabels).candidates;
}

function parseOneCandidate(rawCandidate: unknown, validLabels: Set<string>): ParsedCandidate {
  if (!rawCandidate || typeof rawCandidate !== 'object' || Array.isArray(rawCandidate)) {
    throw new CaptureFailure('invalid_model_output', 'candidate must be an object');
  }
  const candidate = rawCandidate as Record<string, unknown>;
  if (!Array.isArray(candidate.evidence) || !candidate.evidence.length) {
    throw new CaptureFailure('invalid_model_output', 'candidate evidence is required');
  }
  const evidence = [...new Set(candidate.evidence.map((label) => {
    if (typeof label !== 'string' || !validLabels.has(label)) {
      throw new CaptureFailure('invalid_model_output', 'unknown evidence label');
    }
    return label;
  }))];
  const uncertainty = optionalText(candidate.uncertainty, 1_000);
  const targetAssetId = optionalText(candidate.targetAssetId, 160);
  if (targetAssetId && !safeId(targetAssetId)) throw new CaptureFailure('invalid_model_output', 'invalid targetAssetId');
  const valueProvided = Object.prototype.hasOwnProperty.call(candidate, 'value');
  const actionProvided = Object.prototype.hasOwnProperty.call(candidate, 'suggestedAction');
  return {
    judgment: boundedRequiredText(candidate.judgment, 'judgment', RECALL_TEXT_LIMITS.statement, true),
    value: valueProvided ? boundedRequiredText(candidate.value, 'value', 1_000) : '',
    valueProvided,
    summary: boundedRequiredText(candidate.summary, 'summary', RECALL_TEXT_LIMITS.summary),
    ...(uncertainty ? { uncertainty } : {}),
    // New formation has one content contract. Old model labels are ignored;
    // an update's historical type is resolved from its actual target by the host.
    // A bad browsing label cannot discard otherwise supported cognition.
    contentCategory: isContentCategory(candidate.contentCategory) ? candidate.contentCategory : 'unclassified',
    suggestedType: 'cognition',
      ...parseCandidateBoundaries(candidate),
    // scope 归一：LLM 自由文本（"用户全局画像"等）
    // 尽力归一词表；归不了的保留原文——匹配层 token 软匹配兜底，不硬拒。
    suggestedScope: normalizeAssetScopeValue(String(candidate.suggestedScope || ''))
      ?? boundedRequiredText(candidate.suggestedScope, 'suggestedScope', 500),
    ...(candidate.suggestedAction === undefined ? {} : { suggestedAction: parseCandidateAction(candidate.suggestedAction) }),
    actionProvided,
    ...(candidate.risk === undefined ? {} : { risk: parseCandidateRisk(candidate.risk) }),
    ...(targetAssetId ? { targetAssetId } : {}),
    ...(candidate.comparison ? { comparison: candidate.comparison as FormationComparison } : {}),
    evidence,
    ...(candidate.ontologyChanges === undefined ? {} : { ontologyChanges: candidate.ontologyChanges }),
  };

}

/** 读模型给出的边界短语。非数组/空串一律忽略，宁可留空也不编造边界。 */
function parseCandidateBoundaries(candidate: Record<string, unknown>): {
  applicableWhen?: string[];
  forbiddenWhen?: string[];
} {
  const read = (raw: unknown): string[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    if (raw.length > 32 || raw.some(item => typeof item !== 'string' || !item.trim() || item.length > 500))
      throw new CaptureFailure('invalid_model_output', 'invalid complete candidate boundaries');
    const items = raw.map(item => (item as string).trim());
    return items.length ? items : undefined;
  };
  const applicableWhen = read(candidate.applicableWhen);
  const forbiddenWhen = read(candidate.forbiddenWhen);
  return {
    ...(applicableWhen ? { applicableWhen } : {}),
    ...(forbiddenWhen ? { forbiddenWhen } : {}),
  };
}

function extractionSystemPrompt(): string {
  return [
    'Cognition is an understanding formed through exchange, thinking or practice that influences later understanding, judgment or action. Before proposing an asset, identify its specific understanding, concrete future use, original support and limits; resembling a template, rule or experience never grants admission. Facts can still qualify when they guide future understanding or action. A method remains cognition: never convert, link or generate an executable skill. Do not use tools.',
    'You prepare complete, source-grounded understandings and practices for the user to review and retain for future use. Keep storage type cognition; after extracting each complete item propose its contentCategory for browsing.',
    'Return exactly one JSON object and no markdown or commentary.',
    'Read the entire bounded run before deciding candidates; the first user message provides context only and must not dominate what you extract.',
    'The context summary preserves the whole daily conversation, including later corrections, conditions and unresolved questions. Use it together with the original messages or labeled source excerpts. Never restore a superseded claim. Only form conclusions supported by approvedEvidence; the other material provides context, not approval to extract unrelated topics.',
    'A useful understanding can concern the user, other people, a project, a concept, a relationship, a goal, or a judgment. A useful practice can include a method, ordered steps, a reusable structure, or evaluation criteria. Meaningful experience keeps the relevant situation, observed result, lesson and limits; it is not merely a usage count or a success claim. These are possible contents, not required sections for every item. Propose contentCategory only after reading the complete content; it is browsing metadata independent of storage type and does not decide value or eligibility.',
    `Return {"proposalVersion":2,"proposals":[...]}, up to ${MAX_MODEL_CANDIDATES} independently decidable groups. Each group has a unique safe ASCII id and target "cognition", "ontology" or "joint". Do not stop after the first three. When nothing durable is supported, return an empty proposals array and a short reason.`,
    'A cognition group contains cognition:{judgment,value,summary,contentCategory,suggestedScope,suggestedAction,risk,evidence,applicableWhen?,forbiddenWhen?,uncertainty?,targetAssetId?}. A joint group contains the same cognition object plus its own ontologyChanges. An ontology-only group contains explanation:{description,value,summary,suggestedScope,risk,evidence,applicableWhen?,forbiddenWhen?,uncertainty?} plus nonempty ontologyChanges.actions. explanation describes the actual supported change, its future use and limits; it is not cognition and will not become a cognition asset. Do not invent a reusable insight merely to retain a new object or fact. Omit absent optional properties. Each dependent change must be inside the same group; do not use cross-group dependencies.',
    'Every candidate must cite at least one approved user message label from newly discovered content. Greetings, status checks, repeated queries and the mere completion or failure of one operation are not candidates. A failed operation may still yield a supported, bounded lesson; preserve that lesson without inventing causes or successful verification.',
    'When newly discovered content qualifies or adopts an earlier statement, include the relevant contextual user labels in the candidate evidence alongside the approved new label. Context with discovery false explains the approved topic and its rule fields but never establishes new value by itself. ontologyChanges.evidence must retain approved new user labels; contextual field citations belong in the source assessment, not in that approval list.',
    'Do not invent a new person or project for each mention, equate people by shared names, infer authority from roles, or widen a project-specific requirement to every project. Preserve exact subjects, time, conditions and uncertainty. Do not claim to have created ontology records or executable skills; this stage only prepares reviewable content.',
    'When a statement contains relative time ("last week", "from next quarter"), anchor it against the message timestamp and write the resolved absolute date into judgment; never store a bare relative phrase.',
    'Preserve explicit negation and reversal. Distinguish an earlier mistake from a later real-world change. A historical statement alone does not establish the current state; when the current state is not supplied, retain that uncertainty instead of inventing the opposite preference.',
    'Extract all source-supported durable topics, even if the source appears to repeat another understanding. Write only what the source supports; do not merge stored asset text, choose an asset identity, or make a comparison. This extraction is independent of stored assets. The later formation stage resolves whether each proposal is new, an update, a duplicate or unresolved.',
    'When the conversation states a change of an assignment or value ("X changed from A to B"), record B as the current state and note the superseded prior state A inside judgment.',
    'Only retain supported content that improves a later understanding, decision or action. One meaningful item should occur once; do not split or duplicate it merely to satisfy a classification system.',
    prompts.load('recall_candidate_contract'),
    ontologyFormationPromptContract,
    'For this extraction only, the source-proposal contract overrides asset-comparison instructions above: include every supported topic without checking stored cognition, set suggestedAction to create, and omit targetAssetId and comparison. The later formation stage resolves the action and target.',
  ].join('\n\n');
}

function extractionInput(
  conversationTitle: string,
  messages: CapturePromptMessage[],
  recallView: RecallViewRecord,
  existingAssets: Array<{ id: string; title: string; statement: string; type: string; scope: string; version: string }> = [],
  summary?: CaptureContextSummary,
  approvedEvidence: CaptureValueJudgment['evidence'] = [],
  ontology?: ReturnType<typeof buildOntologyFormationContext>,
  sourceScope?: { projectId?: string; workspaceId?: string },
  existingAssetsCoverage?: CaptureExistingAssetsResult['coverage'],
): string {
  const envelope = {
    conversation: { title: conversationTitle },
    ...(summary ? { summary: summary.topics, approvedEvidence } : {}),
    ...(existingAssets.length ? { existingAssets } : {}),
    ...(existingAssetsCoverage ? { existingAssetsCoverage } : {}),
    ...(ontology ? { existingOntology: ontology } : {}),
    ...(sourceScope ? { sourceScope } : {}),
    recallView: {
      id: recallView.id,
      purpose: recallView.purpose,
      sourceRefs: recallView.sourceRefs.map((ref) => ({
        kind: ref.kind,
        subtype: ref.subtype,
        id: ref.id,
        ...(ref.degraded ? { degraded: true } : {}),
      })),
      assetRefs: recallView.assetRefs,
      degradedRefs: recallView.degradedRefs,
    },
  };
  const sourceMessage = (message: CapturePromptMessage) => ({
      label: message.label,
      id: message.id,
      role: message.role,
      discovery: message.discovery !== false,
      ts: message.ts,
      text: message.text,
      ...(message.observations?.length ? { observations: message.observations } : {}),
      ...(message.artifacts.length
        ? { artifacts: message.artifacts.map(({ id, title }) => ({ id, title })) }
        : {}),
    });
  const full = JSON.stringify({ ...envelope, messages: messages.map(sourceMessage) });
  const budget = 96_000;
  if (full.length <= budget) return full;
  // Full context has already been summarized. For oversized extraction inputs,
  // carry every summary topic plus bounded original passages for all evidence,
  // including corrections and conditions, not just the positively judged quote.
  const excerpts = captureSourcePassages(messages.map(sourceMessage), summary, approvedEvidence);
  const bounded = JSON.stringify({ ...envelope, messages: excerpts });
  if (!excerpts.length || bounded.length > budget) throw new CaptureFailure('extraction_context_too_large', 'complete evidence cannot fit extraction input');
  return bounded;
}

/** Same channel selection as the extraction runner; never infer outage from a failed read. */
export async function readRecallCaptureModelRuntime(userId?: string) {
  const apiConfigured = (userId ? hasConfiguredModelForUser(userId) : hasConfiguredModel()).configured || Boolean(process.env.ANTHROPIC_API_KEY);
  const authorizationRequired = apiConfigured && Boolean(userId
    ? getConfiguredModelOAuthExpiredMessageForUser(userId) : getConfiguredModelOAuthExpiredMessage());
  if (apiConfigured) return { runtimeStatus: 'known' as const, apiConfigured, available: !authorizationRequired,
    channel: authorizationRequired ? 'unavailable' as const : 'api' as const, authorizationRequired };
  try {
    const entries = await detectAll();
    const available = entries.filter(entry => entry?.available);
    const chosen = available.find(entry => entry.type === 'claude') || available[0];
    return { runtimeStatus: 'known' as const, apiConfigured: false, cliAvailable: Boolean(chosen), available: Boolean(chosen),
      channel: chosen ? 'cli' as const : 'unavailable' as const, cliAgentId: chosen?.type, cliAuthenticated: chosen?.auth?.loggedIn,
      authorizationRequired: false, cliAuthorizationRequired: chosen?.auth?.loggedIn === false };
  } catch (error) {
    return { runtimeStatus: 'unknown' as const, apiConfigured: false, available: undefined, channel: undefined,
      runtimeError: String((error as Error).message).slice(0, 300) };
  }
}

/** Fixed host failure token for a model-side summary/value failure; the
 * provider's diagnostic message never enters records, logs or telemetry. */
function captureModelFailureReasonCode(error: { kind?: unknown } | undefined): string {
  return String((error && typeof error.kind === 'string' && error.kind) || 'aborted').slice(0, 40);
}

/** Budget-class phrases thrown by the summary validator itself
 * (capture-context-summary.ts); a summary can outgrow its bounded output
 * even when every model call succeeded. */
const CAPTURE_SUMMARY_BUDGET_REASONS = new Set(['output too large', 'summary compression budget exhausted',
  'compression input too large', 'checkpoint summary exceeds budget', 'checkpoint merge exceeds budget']);

/** The summary validator rejects malformed output with fixed
 * `invalid capture context summary: <reason>` phrases of its own — never user
 * or model text. Surface that reason so a failure stays diagnosable. */
function captureSummaryInvalidReason(error: unknown): string | undefined {
  const match = /^invalid capture context summary: (.+)$/.exec(error instanceof Error ? error.message : '');
  const reason = match?.[1].trim();
  return reason ? reason.slice(0, 80) : undefined;
}

/** Bounded repair texts for repairable summary-validator rejections. Each
 * restates the closed output contract for ONE retry of the same frozen input;
 * they never quote user text or echo the previous model output. */
const CAPTURE_SUMMARY_REPAIR_INSTRUCTIONS: Readonly<Record<string, string>> = {
  'nonempty source requires a topic': '上一次输出缺少话题。规则：只要片段含有正文，就必须给出至少一个话题；空 topics 只能表示片段没有可摘要的正文。本阶段不做价值筛选，价值判断由后续阶段负责。请对同一输入重新输出完整 JSON。',
  'incomplete coverage': '上一次输出的覆盖不完整。规则：coveredIds 必须恰好列出全部输入片段或输入摘要的 id，不能多也不能少。请对同一输入重新输出。',
  'dropped input topic': '上一次输出丢弃了输入话题。规则：合并时全部输入话题必须至少映射到一个输出话题的 inputIds；不得丢掉不相关话题。请对同一输入重新输出。',
  'unknown input topic': '上一次输出的 inputIds 含未知话题。规则：inputIds 只能引用输入中真实存在的话题 id。请对同一输入重新输出。',
  'quote outside submitted source': '上一次输出的引文不在提交的原文片段内。规则：quote 必须是本次提交片段内逐字连续的原文，不能改标点、空白或补字；chunk 阶段 evidence 只输出 messageId 和 quote。请对同一输入重新输出。',
  'quote outside input evidence': '上一次输出的引文不在输入证据内。规则：合并或压缩只能复用输入 evidence 已有的 messageId 和 quote，不得编造新证据。请对同一输入重新输出。',
  'fabricated quote': '上一次输出的引文未通过逐字校验。规则：quote 必须与原文逐字一致，不能改标点、空白或补字。请对同一输入重新输出。',
  'fabricated offset': '上一次输出的引文坐标与原文不符。规则：合并或压缩阶段保留输入已有的 start/end 且不得改变；chunk 阶段不输出坐标，坐标由主程序定位。请对同一输入重新输出。',
  'fabricated role': '上一次输出的角色与原文不符。规则：角色由输入消息决定，合并或压缩阶段保留输入已有 role 且不得改变。请对同一输入重新输出。',
  'object shape': '上一次输出不符合封闭输出契约。规则：输出单个 JSON 对象，仅包含 coveredIds 和 topics；每个 topic 仅包含 title、content、conditions、unresolved、attribution、evidence（合并阶段另含 inputIds）。请对同一输入重新输出。',
  'topics shape': '上一次输出的话题列表不符合契约。规则：topics 是数组，每个话题必须含 title、content、conditions、unresolved、attribution 和非空 evidence。请对同一输入重新输出。',
  'evidence shape': '上一次输出的证据不符合契约。规则：每个话题的 evidence 是非空数组，每项只包含 messageId、quote（合并或压缩阶段可保留已有 role、start、end）。请对同一输入重新输出。',
  'text size or shape': '上一次输出的字段长度或类型不符合契约。规则：title 至多 200 字符、content 至多 4000 字符、conditions 与 unresolved 各至多 16 项、每条引文至多 1000 字符。请对同一输入重新输出。',
  'list shape': '上一次输出的数组不符合契约。规则：conditions、unresolved 必须是字符串数组且不超过 16 项。请对同一输入重新输出。',
  attribution: '上一次输出的 attribution 不符合契约。规则：attribution 只能是 user_requirement、assistant_proposal、source_observation、mixed。请对同一输入重新输出。',
  'invalid topic annotation': '上一次输出携带了无效的 topic 注解。规则：不要附加契约之外的注解字段；如提供 id 则必须是非空字符串。请对同一输入重新输出。',
  'user attribution lacks user evidence': '上一次输出把话题标为用户要求但缺少用户消息证据。规则：标为 user_requirement 的话题必须包含来自用户消息的证据。请对同一输入重新输出。',
  'assistant attribution lacks assistant evidence': '上一次输出把话题标为助手提议但缺少助手消息证据。规则：标为 assistant_proposal 的话题必须包含来自助手消息的证据。请对同一输入重新输出。',
  'compression dropped evidence': '上一次压缩删掉了原有证据。规则：压缩只精简表达，原有每项 evidence（messageId、quote 及已有角色、坐标）都必须保留。请对同一输入重新输出。',
  'output too large': '上一次输出超过了本次输出的字符预算 outputBudgetChars。规则：优先压缩重复描述，保留具体内容、条件、纠正与未解决处，输出必须低于该预算。请对同一输入重新输出更紧凑的 JSON。',
};

/** Only these validator rejections earn one bounded contract-repair retry;
 * checkpoint, geometric and input failures surface unchanged instead. */
export function captureSummaryRepairInstruction(reason: string): string | undefined {
  return CAPTURE_SUMMARY_REPAIR_INSTRUCTIONS[reason];
}

function captureSummaryFailure(reason: string): CaptureFailure {
  return CAPTURE_SUMMARY_BUDGET_REASONS.has(reason)
    ? new CaptureFailure('summary_budget_exhausted', `context summary exceeded its output budget: ${reason}`, reason)
    : new CaptureFailure('summary_output_invalid', `context summary failed validation: ${reason}`, reason);
}

async function runCaptureAnalysisModel(
  userId: string, capture: RecallCaptureRecord, stage: 'summary' | 'value', message: string, signal?: AbortSignal, shouldContinue?: () => Promise<boolean>, repairInstruction?: string,
): Promise<string> {
  const settings = await readRecallCaptureSettings(userId);
  const modelCandidates = await resolveRecallCaptureModelCandidates(userId, settings.modelCandidates);
  const systemPrompt = prompts.load(stage === 'summary' ? 'cognition_capture_summary' : 'cognition_capture_value') + (capture.feedbackObservations?.length ? '\nobservations are authenticated user feedback about a specific prior task and exact asset version, not verbatim chat text or a new standing instruction. Preserve that attribution. Do not fabricate an evidence quote for metadata, infer a current-version defect from historical-version feedback, or generalize one click into a durable rule.' : '')
    // Fixed contract restatement carried only by the one bounded repair retry.
    + (repairInstruction ? `\n\n${repairInstruction}` : '');
  if (!systemPrompt.trim()) throw new CaptureFailure(stage === 'summary' ? 'summary_failed' : 'value_judgment_failed', 'analysis prompt unavailable');
  const { result } = await runRecallCaptureModel(userId, { sessionId: `memory-${stage}-recall-${capture.id}`,
    systemPrompt, modelCandidates, message, signal, shouldContinue: shouldContinue || (() => nightlyCaptureCanStart(userId)),
    cliContext: { conversationId: capture.conversationId, agentId: `recall-capture-${stage}`,
      agentName: stage === 'summary' ? 'Context Summary' : 'Value Screening' }, budget: { jobId: capture.id, stage } });
  if (result.meta.aborted || result.meta.error) {
    if (result.meta.error?.kind === 'auth') throw new CaptureFailure('model_auth_required', 'capture analysis did not complete');
    // A model-side failure (transport error, abort without a signal) is kept
    // apart from output-validation failures; the fixed host failure token goes
    // to the record, never provider message text.
    throw new CaptureFailure(stage === 'summary' ? 'summary_model_failed' : 'value_judgment_failed',
      'capture analysis did not complete', captureModelFailureReasonCode(result.meta.error));
  }
  return result.text;
}

function assertSafeCaptureSummary(value: unknown): void {
  try {
    // Apply the existing credential storage gate before creating any derived
    // summary copy. Inspect original strings, not escaped JSON serialization.
    const pending: unknown[] = [value];
    const strings: string[] = [];
    while (pending.length) {
      const item = pending.pop();
      if (typeof item === 'string') strings.push(item);
      else if (Array.isArray(item)) pending.push(...item);
      else if (item && typeof item === 'object') pending.push(...Object.values(item));
    }
    assertNotForbiddenToPersist(strings);
  } catch {
    throw new CaptureFailure('summary_sensitive_content', 'summary contains content forbidden to persist');
  }
}

async function judgeCaptureValue(
  userId: string, capture: RecallCaptureRecord, messages: CapturePromptMessage[], signal?: AbortSignal, shouldContinue?: () => Promise<boolean>,
): Promise<string> {
  if (!capture.contextSummary) throw new CaptureFailure('summary_failed', 'summary required before value decision');
  // The summary keeps context and corrections; the attached quotations let the
  // judge check claims against actual source text without re-truncating it.
  const input = captureValueJudgmentInput(capture.contextSummary, messages);
  return runCaptureAnalysisModel(userId, capture, 'value', JSON.stringify(input), signal, shouldContinue);
}

export async function readRecallCapture(userId: string, id: string): Promise<RecallCaptureRecord> {
  if (!safeId(id)) throw new Error('invalid recall capture id');
  const record = await readRecallJsonRecord(userId, CAPTURE_COLLECTION, id);
  if (!record) throw new Error('recall capture not found');
  return asCapture(record);
}

function candidateUnavailableForWorkflow(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === 'recall candidate not found'
    || error.message.startsWith('malformed recall candidate')
    || error.message.startsWith('malformed recall record:')
    || error.message.startsWith('missing recall record:');
}

function abilityAssetUnavailableForWorkflow(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === 'recall ability asset not found'
    || error.message.startsWith('malformed recall ability asset')
    || error.message.startsWith('malformed recall record:')
    || error.message.startsWith('missing recall record:');
}

function confirmedAssetReceipt(
  candidate: RecallCandidateRecord,
  asset: RecallAbilityAssetRecord,
  receipt: RecallAssetHandoffReceipt,
): RecallCaptureConfirmedAssetReceipt | undefined {
  if (candidate.contentPurgedAt || asset.status === 'purged') return undefined;
  if (candidate.status !== 'confirmed' || !candidate.promotedAssetId || asset.id !== candidate.promotedAssetId) {
    return undefined;
  }
  const belongsToCandidate = asset.candidateId === candidate.id
    || asset.sourceCandidateIds?.includes(candidate.id);
  if (!belongsToCandidate) return undefined;
  if (
    !candidate.reviewDecisionId
    || receipt.assetId !== asset.id
    || receipt.assetType !== asset.type
    || receipt.reviewDecisionId !== candidate.reviewDecisionId
  ) {
    return undefined;
  }
  return {
    assetId: receipt.assetId,
    assetType: receipt.assetType,
    version: receipt.version,
    scope: receipt.scope,
    sourceRefCount: receipt.sourceRefs.length,
    reviewDecisionId: receipt.reviewDecisionId,
  };
}

function captureNextAction(
  capture: RecallCaptureRecord,
  workflowStatus: RecallCaptureWorkflowStatus,
  linkedAssetIds: string[],
  hasPendingCandidates = false,
): RecallCaptureNextAction {
  if (workflowStatus === 'partial') return hasPendingCandidates ? 'review_candidates' : linkedAssetIds.length ? 'view_assets' : 'none';
  if (workflowStatus === 'completed' && linkedAssetIds.length) return 'view_assets';
  if (workflowStatus === 'review_ready') return 'review_candidates';
  return 'none';
}

function captureDisplayStatus(
  capture: RecallCaptureRecord,
  workflowStatus: RecallCaptureWorkflowStatus,
): RecallCaptureDisplayStatus {
  if (workflowStatus === 'partial') return 'partial';
  if (workflowStatus === 'completed') return 'completed';
  if (workflowStatus === 'failed' || workflowStatus === 'configuration_required') return 'failed';
  if (workflowStatus === 'cancelled') return 'cancelled';
  if (workflowStatus === 'extracting') return 'extracting';
  if (workflowStatus === 'writing') return 'writing';
  if (workflowStatus === 'review_ready') return 'review_ready';
  if (capture.status === 'no_candidate') return 'completed';
  return 'waiting';
}

function captureDisplayReason(
  capture: RecallCaptureRecord,
  workflowStatus: RecallCaptureWorkflowStatus,
): RecallCaptureDisplayReason {
  if (workflowStatus === 'partial') return 'partial_support';
  if (workflowStatus === 'completed') {
    return capture.status === 'no_candidate' ? 'no_candidate' : 'review_completed';
  }
  if (workflowStatus === 'cancelled') return 'cancelled';
  if (capture.errorCode === 'model_not_configured') return 'model_not_configured';
  if (capture.errorCode === 'model_auth_required') return 'model_auth_required';
  if (capture.errorCode === 'asset_write_failed') return 'asset_write_failed';
  if (capture.errorCode === 'asset_write_interrupted') return 'asset_write_interrupted';
  if (workflowStatus === 'failed' || workflowStatus === 'configuration_required') return 'capture_failed';
  if (workflowStatus === 'writing') return 'asset_write';
  if (workflowStatus === 'extracting') return 'extracting';
  if (workflowStatus === 'review_ready') return 'review_pending';
  if (workflowStatus === 'waiting_quiet') return 'quiet_period';
  if (workflowStatus === 'waiting_completion') return 'conversation_active';
  if (workflowStatus === 'waiting_manual') return 'manual_start_required';
  if (workflowStatus === 'scheduled') return 'nightly_window';
  if (workflowStatus === 'paused') return 'paused';
  return 'queued';
}

function captureActions(
  capture: RecallCaptureRecord,
  workflowStatus: RecallCaptureWorkflowStatus,
  linkedAssetIds: string[],
  hasPendingCandidates = false,
): RecallCaptureAction[] {
  if (workflowStatus === 'partial') return [
    ...(hasPendingCandidates ? ['review_candidates' as const] : []),
    ...(linkedAssetIds.length ? ['view_assets' as const] : []),
    'open_conversation',
  ];
  if (workflowStatus === 'review_ready') return ['review_candidates', 'open_conversation'];
  if (workflowStatus === 'completed' && linkedAssetIds.length) return ['view_assets', 'open_conversation'];
  return [];
}

async function summarizeRecallCaptures(
  userId: string,
  captures: RecallCaptureRecord[],
): Promise<RecallCaptureWorkflowRecord[]> {
  const candidateReads = new Map<string, Promise<RecallCandidateRecord | undefined>>();
  const assetReads = new Map<string, Promise<RecallAbilityAssetRecord | undefined>>();
  const receiptReads = new Map<string, Promise<RecallAssetHandoffReceipt | undefined>>();
  const readCandidate = (candidateId: string): Promise<RecallCandidateRecord | undefined> => {
    if (!safeId(candidateId)) return Promise.resolve(undefined);
    const cached = candidateReads.get(candidateId);
    if (cached) return cached;
    const pending = readRecallCandidate(userId, candidateId).catch((error: unknown) => {
      if (candidateUnavailableForWorkflow(error)) return undefined;
      throw error;
    });
    candidateReads.set(candidateId, pending);
    return pending;
  };
  const readAsset = (assetId: string): Promise<RecallAbilityAssetRecord | undefined> => {
    if (!safeId(assetId)) return Promise.resolve(undefined);
    const cached = assetReads.get(assetId);
    if (cached) return cached;
    const pending = readAbilityAsset(userId, assetId).catch((error: unknown) => {
      if (abilityAssetUnavailableForWorkflow(error)) return undefined;
      throw error;
    });
    assetReads.set(assetId, pending);
    return pending;
  };
  const readReceipt = (
    candidateId: string,
    reviewDecisionId: string,
  ): Promise<RecallAssetHandoffReceipt | undefined> => {
    if (!safeId(candidateId) || !/^rd_[A-Za-z0-9_-]{8,64}$/.test(reviewDecisionId)) {
      return Promise.resolve(undefined);
    }
    const key = `${candidateId}:${reviewDecisionId}`;
    const cached = receiptReads.get(key);
    if (cached) return cached;
    const pending = readRecallAssetHandoffReceipt(userId, candidateId, reviewDecisionId).catch((error: unknown) => {
      if (candidateUnavailableForWorkflow(error)) return undefined;
      if (error instanceof Error && (
        error.message.startsWith('malformed recall asset handoff receipt')
        || error.message.startsWith('invalid recall asset handoff receipt')
      )) return undefined;
      throw error;
    });
    receiptReads.set(key, pending);
    return pending;
  };

  return Promise.all(captures.map(async (capture) => {
    const candidateIds = [...new Set(capture.candidateIds)];
    const candidates = await Promise.all(candidateIds.map(readCandidate));
    // 终态固化的快照优先：只保护 completed 终态——防 defer
    // 冷却过期等读取时点漂移把已完成的任务翻成失败。review_ready 保持现算：
    // 它是活的等待区，用户确认/拒绝后照常翻「已完成」（既有行为），不锁死。
    // 快照存在时仍现算 confirmed 回执——那是详情页的展示数据。
    const snapshotted = capture.status === 'completed' ? capture.reviewSnapshot : undefined;
    const reviewSummary: RecallCaptureReviewSummary = snapshotted
      ? { ...snapshotted, integrated: snapshotted.integrated ?? 0 }
      : { total: 0, pending: 0, deferred: 0, promoted: 0, rejected: 0, integrated: 0, missing: 0 };
    const linkedAssetIds = new Set<string>();
    const confirmedAssetReceipts: RecallCaptureConfirmedAssetReceipt[] = [];
    // 已清除内容不构成一次新的沉淀：既不生成回执，也不进结果区。
    const purgedOutcomeIds = new Set<string>();
    let purgedPromoted = 0;
    const collectConfirmedReceipt = async (candidate: RecallCandidateRecord) => {
      if (!candidate.promotedAssetId || !candidate.reviewDecisionId) return;
      const [asset, receipt] = await Promise.all([
        readAsset(candidate.promotedAssetId),
        readReceipt(candidate.id, candidate.reviewDecisionId),
      ]);
      const displayReceipt = asset && receipt
        ? confirmedAssetReceipt(candidate, asset, receipt)
        : undefined;
      if (displayReceipt) {
        linkedAssetIds.add(displayReceipt.assetId);
        confirmedAssetReceipts.push(displayReceipt);
      }
    };
    for (const candidate of candidates) {
      if (!candidate) {
        if (!snapshotted) {
          reviewSummary.total += 1;
          reviewSummary.missing += 1;
        }
        continue;
      }
      // 复核摘要按 capability 计数；有处理能力的 weak_observation 也计入。
      // 不需要用户处理且未终结的弱观察不进摘要。
      const capability = getRecallCandidateCapabilities(candidate);
      // 稍后处理是用户自己按下的静音，这份摘要里继续保持安静（既有行为）。
      if (capability.isSnoozed) continue;
      if (!capability.countsAsPending && !capability.isTerminal) continue;
      if (candidate.contentPurgedAt) {
        purgedOutcomeIds.add(candidate.id);
        if (snapshotted && candidate.status === 'confirmed') purgedPromoted += 1;
        continue;
      }
      // 清除级联失败/重试窗口里，候选正文可能还在，但资产墓碑已经落了；
      // 同样按“内容已清除”处理，避免误记 missing 把 capture 翻成 failed。
      if (candidate.status === 'confirmed' && candidate.promotedAssetId) {
        const promotedAsset = await readAsset(candidate.promotedAssetId);
        if (promotedAsset?.status === 'purged') {
          purgedOutcomeIds.add(candidate.id);
          if (snapshotted) purgedPromoted += 1;
          continue;
        }
      }
      if (snapshotted) {
        if (candidate.status === 'confirmed') await collectConfirmedReceipt(candidate);
        continue;
      }
      reviewSummary.total += 1;
      if (capability.countsAsPending) reviewSummary.pending += 1;
      else if (candidate.status === 'confirmed') {
        if (!candidate.promotedAssetId || !candidate.reviewDecisionId) {
          reviewSummary.missing += 1;
          continue;
        }
        const [asset, receipt] = await Promise.all([
          readAsset(candidate.promotedAssetId),
          readReceipt(candidate.id, candidate.reviewDecisionId),
        ]);
        const displayReceipt = asset && receipt
          ? confirmedAssetReceipt(candidate, asset, receipt)
          : undefined;
        if (!displayReceipt) {
          reviewSummary.missing += 1;
          continue;
        }
        reviewSummary.promoted += 1;
        linkedAssetIds.add(displayReceipt.assetId);
        confirmedAssetReceipts.push(displayReceipt);
      } else if (candidate.status === 'integrated') {
        // Ontology integration has its own receipt; it is a completed terminal
        // outcome, not an asset promotion. A status without the receipt is an
        // integrity gap, so keep the capture failed instead of silently done.
        if (candidate.ontologyHandoff?.status === 'integrated') reviewSummary.integrated += 1;
        else reviewSummary.missing += 1;
      } else if (candidate.status === 'rejected' || candidate.status === 'ignored' || candidate.status === 'expired') {
        reviewSummary.rejected += 1;
      } else {
        log.warn('capture review summary saw an unsupported candidate status', {
          captureId: capture.id, status: candidate.status,
        });
        reviewSummary.missing += 1;
      }
    }
    // 冻结快照不能替已经清除的内容继续声称“已验证/已沉淀”。
    if (snapshotted && purgedPromoted > 0) {
      const drop = Math.min(purgedPromoted, reviewSummary.promoted);
      reviewSummary.promoted -= drop;
      reviewSummary.total = Math.max(0, reviewSummary.total - drop);
    }

    const checkpoint = capture.formationCheckpoint;
    const unfinishedSupport = (capture.candidateSupportUnavailableCount || 0) > 0
      || (checkpoint?.supportPendingIndexes?.length || 0) > 0
      || Boolean(checkpoint?.sourceProposalVersion === 1 && checkpoint.groups.some(group => !group.omitted && !group.savedCandidateId));
    const partial = candidateIds.length > 0 && unfinishedSupport
      && ['review_ready', 'completed', 'failed', 'configuration_required', 'no_candidate'].includes(capture.status);
    let workflowStatus: RecallCaptureWorkflowStatus = capture.status;
    if (partial) {
      workflowStatus = 'partial';
    } else if (capture.status === 'completed') {
      workflowStatus = reviewSummary.pending || reviewSummary.deferred || reviewSummary.missing
        ? 'failed'
        : 'completed';
    } else if (capture.status === 'no_candidate') {
      workflowStatus = 'completed';
    } else if (capture.status === 'review_ready' && reviewSummary.total === 0) {
      workflowStatus = 'completed';
    } else if (capture.status === 'review_ready' && reviewSummary.missing > 0) {
      workflowStatus = 'failed';
    } else if (
      capture.status === 'review_ready'
      && reviewSummary.total > 0
      && reviewSummary.pending === 0
      && reviewSummary.deferred === 0
      && reviewSummary.missing === 0
      && reviewSummary.promoted + reviewSummary.rejected + reviewSummary.integrated === reviewSummary.total
    ) {
      workflowStatus = 'completed';
    }
    const linkedAssets = [...linkedAssetIds];
    // 整理结果内联投影：全量读池结果直接进 workflow 记录，详情页
    // 不再依赖渲染层队列窗口（review-queue 只含最近 5 条处理记录）。读不到
    // 的候选（missing）不进投影——与旧 join 语义一致（.filter(Boolean)），
    // missing 计数仍由 reviewSummary 如实反映。
    const candidateOutcomes: RecallCaptureCandidateOutcome[] = [];
    for (const candidate of candidates) {
      if (!candidate || purgedOutcomeIds.has(candidate.id) || candidate.contentPurgedAt) continue;
      candidateOutcomes.push({
        id: candidate.id,
        status: candidate.status,
        summary: candidate.summary,
        judgment: candidate.judgment,
        suggestedType: candidate.suggestedType,
        ...(candidate.proposalTarget ? { proposalTarget: candidate.proposalTarget } : {}),
        ...(candidate.automaticUndo ? { automaticUndo: candidate.automaticUndo } : {}),
        ...(candidate.contentCategory !== undefined ? { contentCategory: candidate.contentCategory } : {}),
        suggestedScope: candidate.suggestedScope,
        sourceRefs: candidate.sourceRefs,
        evidenceRefs: candidate.evidenceRefs,
        capabilities: getRecallCandidateCapabilities(candidate),
      });
    }
    const displayStatus = captureDisplayStatus(capture, workflowStatus);
    // 分桶按最终展示状态计算，已处理完成的 review_ready 记录进入 done。
    const bucket = displayStatus === 'partial' ? 'attention' as const
      : displayStatus === 'completed' || displayStatus === 'cancelled'
      ? 'done' as const
      : captureBucket(capture);
    return {
      ...capture,
      workflowStatus,
      displayStatus,
      displayReason: captureDisplayReason(capture, workflowStatus),
      bucket,
      reviewSummary,
      linkedAssetIds: linkedAssets,
      confirmedAssetReceipts,
      candidateOutcomes,
      nextAction: captureNextAction(capture, workflowStatus, linkedAssets, reviewSummary.pending > 0),
      actions: captureActions(capture, workflowStatus, linkedAssets, reviewSummary.pending > 0),
    };
  }));
}

/** 静默记录的展示视图：不经 summarizeRecallCaptures（不读候选/资产）。
 *  no_candidate 语义上已终态且无任何用户动作，reviewSummary 全零即真值。 */
function silentRecallCaptureWorkflow(capture: RecallCaptureRecord): RecallCaptureWorkflowRecord {
  return {
    ...capture,
    workflowStatus: capture.status === 'no_candidate' ? 'completed' : capture.status,
    displayStatus: captureDisplayStatus(capture, capture.status),
    displayReason: capture.status === 'no_candidate' ? 'no_candidate' : captureDisplayReason(capture, capture.status),
    // 展示归「已完成」：行上显示的就是「已完成」，
    // 筛选与计数必须一致；零读取路由（isSilentCapture）不受此影响。
    bucket: capture.status === 'no_candidate' ? 'done' : 'silent',
    reviewSummary: { total: 0, pending: 0, deferred: 0, promoted: 0, rejected: 0, integrated: 0, missing: 0 },
    linkedAssetIds: [],
    confirmedAssetReceipts: [],
    // 静默记录语义上无候选（no_candidate），投影为空数组即真值。
    candidateOutcomes: [],
    nextAction: 'none',
    actions: [],
  };
}

/** 读路径补会话标题：conversationTitle 只在执行提炼时落盘（runRecallCapture），
 *  从未跑过的等待类记录永远没有标题。这里按会话去重补齐——只在内存里补，
 *  不写盘（记录的 updatedAt 不因展示需要而变动）；会话读取失败不抛（标题是
 *  展示增强，不是数据修复），保留「未命名会话的整理」兜底。 */
async function withConversationTitles(
  userId: string,
  captures: RecallCaptureWorkflowRecord[],
): Promise<RecallCaptureWorkflowRecord[]> {
  const missing = captures.filter((capture) => !String(capture.conversationTitle || '').trim());
  if (!missing.length) return captures;
  const titles = new Map<string, string>();
  await Promise.all([...new Set(missing.map((capture) => capture.conversationId))].map(
    async (conversationId) => {
      try {
        const conversation = await chats.getConversation(userId, conversationId);
        if (conversation && conversation.title) titles.set(conversationId, conversation.title);
      } catch {
        // 会话已删或读取失败：不阻塞列表，标题走兜底文案。
      }
    },
  ));
  if (!titles.size) return captures;
  return captures.map((capture) => (!String(capture.conversationTitle || '').trim())
    && titles.has(capture.conversationId)
    ? { ...capture, conversationTitle: titles.get(capture.conversationId) }
    : capture);
}

export async function readRecallCaptureWorkflow(
  userId: string,
  id: string,
): Promise<RecallCaptureWorkflowRecord> {
  const [capture] = await summarizeRecallCaptures(userId, [await readRecallCapture(userId, id)]);
  return (await withConversationTitles(userId, [capture]))[0];
}

/* ── 整理详情的「对话上下文」──────────────────
 * 展示口径 = 本次整理实际读到的消息（capture.messageIds），与模型看到的
 * 一致——"系统就是看这些内容得出的结论"。独立于 loadStoredPromptMessages
 *（模型路径的文本预算截断不该影响展示），保留 from/to 原始 actor id 供
 * 参与角色与时间线渲染。 */

export interface RecallCaptureContextParticipant {
  id: string;
  name: string;
  kind: 'user' | 'commander' | 'agent';
}

export interface RecallCaptureContextMessage {
  id: string;
  /** m1..mN，与实际提交给模型的标签一致，用于映射证据。 */
  label: string;
  ts: string;
  role: 'user' | 'assistant';
  from: string;
  to: string[];
  text: string;
  truncated: boolean;
  artifacts: Array<{ id: string; title: string }>;
  /** evidenceRefs 用的稳定哈希 id（cognitionMessageSourceId），前端据此把
   *  候选证据关联到时间线上的具体消息。 */
  sourceId: string;
  /** 模型输入中的上下文消息（不在本次新消息集合内）。 */
  contextOnly?: boolean;
  /** 冻结集合引用的消息已不可读；保留标签与位置供详情降级展示。 */
  unavailable?: boolean;
}

export interface RecallCaptureContextRecord {
  captureId: string;
  conversationId: string;
  conversationTitle?: string;
  participants: RecallCaptureContextParticipant[];
  messages: RecallCaptureContextMessage[];
  /** 会话消息已不可读（被清理/迁移）：详情页仍可渲染，只是没有上下文区。 */
  contextUnavailable?: boolean;
}

const CAPTURE_CONTEXT_TEXT_LIMIT = 4_000;

function contextParticipantKind(actorId: string): RecallCaptureContextParticipant['kind'] {
  if (actorId === 'user') return 'user';
  if (actorId === 'commander') return 'commander';
  return 'agent';
}

export async function readRecallCaptureContext(
  userId: string,
  id: string,
): Promise<RecallCaptureContextRecord> {
  const capture = await readRecallCapture(userId, id);
  const base: RecallCaptureContextRecord = {
    captureId: capture.id,
    conversationId: capture.conversationId,
    conversationTitle: capture.conversationTitle,
    participants: [],
    messages: [],
  };
  let frozen: CapturePromptMessage[] = [];
  let missingIds: string[] = [];
  let byId = new Map<string, GroupMessage>();
  try {
    let allMessages: GroupMessage[];
  if (capture.reviewDay) {
    const { start, end } = captureReviewDayBounds(capture);
    allMessages = await readReviewDayMessages(userId, capture.conversationId, start, end, true);
  } else {
    allMessages = await chats.getMessages(userId, capture.conversationId, 2_000);
  }
  byId = new Map(allMessages.filter(isRecallConversationMessage).map((message) => [message.id, message]));
    const wanted = new Set([...(capture.contextMessageIds || []), ...capture.messageIds]);
    // Same union and selector as loadStoredPromptMessages: labels and order in
    // the detail must be the labels and order the model actually received.
    frozen = selectCaptureMessages(allMessages.filter((message) => wanted.has(message.id)), 0, Number.MAX_SAFE_INTEGER);
    const present = new Set(frozen.map((message) => message.id));
    missingIds = [...wanted].filter((messageId) => !present.has(messageId));
  } catch {
    // 会话存储不可读：上下文不可用，但任务元数据照常展示。
    return { ...base, contextUnavailable: true };
  }
  if (!frozen.length && !missingIds.length) return { ...base, contextUnavailable: true };

  const members = await readMembers(userId, capture.conversationId);
  const nameById = new Map(members.actors.map((actor) => [actor.id, actor.name || actor.id]));

  const messages: RecallCaptureContextMessage[] = [
    ...frozen.map((message) => {
      const raw = byId.get(message.id);
      const text = String(raw?.text ?? message.text ?? '');
      return {
        id: message.id,
        label: message.label,
        ts: raw?.ts ?? message.ts,
        role: message.role,
        from: raw?.from ?? (message.role === 'user' ? 'user' : 'commander'),
        to: raw && Array.isArray(raw.to) ? [...raw.to] : [],
        text: text.length > CAPTURE_CONTEXT_TEXT_LIMIT ? text.slice(0, CAPTURE_CONTEXT_TEXT_LIMIT) : text,
        truncated: text.length > CAPTURE_CONTEXT_TEXT_LIMIT,
        artifacts: (raw?.artifacts ?? message.artifacts ?? []).slice(0, 10).map((artifact) => ({
          id: artifact.id,
          title: artifact.title,
        })),
        sourceId: cognitionMessageSourceId(capture.conversationId, message.id),
        contextOnly: !capture.messageIds.includes(message.id),
      };
    }),
    ...missingIds.map((messageId, index) => ({
      id: messageId,
      label: `m${frozen.length + index + 1}`,
      ts: '',
      role: 'user' as const,
      from: '',
      to: [],
      text: '',
      truncated: false,
      artifacts: [],
      sourceId: cognitionMessageSourceId(capture.conversationId, messageId),
      contextOnly: !capture.messageIds.includes(messageId),
      unavailable: true,
    })),
  ];

  // 参与角色：只列这段上下文里实际出现过的 actor（user 最前、指挥官次之、
  // agent 按首次出现），名字取成员名录，缺名录时用 actor id。
  const order: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const actorId of [message.from, ...message.to]) {
      if (!actorId || seen.has(actorId)) continue;
      seen.add(actorId);
      order.push(actorId);
    }
  }
  order.sort((left, right) => {
    const weight = (actorId: string) => (actorId === 'user' ? 0 : actorId === 'commander' ? 1 : 2);
    return weight(left) - weight(right);
  });
  const participants = order.map((actorId) => ({
    id: actorId,
    name: actorId === 'user' || actorId === 'commander'
      ? actorId
      : (nameById.get(actorId) || actorId),
    kind: contextParticipantKind(actorId),
  }));

  return { ...base, participants, messages };
}

async function listAllRecallCaptures(userId: string): Promise<RecallCaptureRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(captureDirectory(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  // 逐条降级，而不是让一条坏 capture 把整个列表、终端事件入队和调度恢复全部
  // 读失败（照抄 workspace-refs / listAbilityAssets 的既有口径）：记录形状的
  // 不变量分布在 store 的 validateRecallRecord 和这里的 asCapture 两层，任一层
  // 一抛，好记录也列不出。只降级记录形状的错；真正的 IO 故障（带 errno code）
  // 照旧上抛——静默少几条等于把磁盘问题伪装成「没有整理任务」。
  const reads = await Promise.all(names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map(async (name) => {
      const id = name.slice(0, -5);
      try {
        return { id, record: await readRecallJsonRecord(userId, CAPTURE_COLLECTION, id) };
      } catch (error) {
        if (typeof (error as NodeJS.ErrnoException).code === 'string') throw error;
        return { id, error: error as Error };
      }
    }));
  const captures: RecallCaptureRecord[] = [];
  for (const read of reads) {
    if (read.error) {
      log.warn('skipped an unreadable recall capture', { captureId: read.id, error: read.error.message });
      continue;
    }
    if (!read.record) continue;
    try {
      captures.push(asCapture(read.record));
    } catch (error) {
      log.warn('skipped a malformed recall capture', { captureId: read.id, error: (error as Error).message });
    }
  }
  return captures
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
}

export async function listRecallCaptures(userId: string, limit = 20): Promise<RecallCaptureWorkflowRecord[]> {
  const wanted = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  const visible = (await listAllRecallCaptures(userId)).filter((capture) => capture.visibility === 'visible');
  return withConversationTitles(userId, (await summarizeRecallCaptures(userId, visible.slice(0, wanted))));
}

function captureCounts(captures: RecallCaptureWorkflowRecord[]): RecallCaptureCounts {
  return captures.reduce<RecallCaptureCounts>((counts, capture) => {
    if (capture.displayStatus === 'extracting' || capture.displayStatus === 'writing') counts.processing += 1;
    else if (capture.displayStatus === 'partial') counts.partial = (counts.partial || 0) + 1;
    else if (capture.displayStatus === 'review_ready') counts.review += 1;
    else if (capture.displayStatus === 'failed') counts.failed += 1;
    else if (capture.displayStatus === 'completed') counts.completed += 1;
    else if (capture.displayStatus === 'cancelled') counts.cancelled += 1;
    else counts.waiting += 1;
    return counts;
  }, { waiting: 0, processing: 0, review: 0, failed: 0, completed: 0, cancelled: 0 });
}

/** 分桶计数按 workflow 记录的（修正后）bucket 字段直读——它已含
 *  displayStatus 的 done 修正与 no_candidate 归并，与行上展示一致。 */
function captureBucketCounts(captures: Array<Pick<RecallCaptureWorkflowRecord, 'bucket'>>): RecallCaptureBucketCounts {
  return captures.reduce<RecallCaptureBucketCounts>((counts, capture) => {
    counts[capture.bucket] += 1;
    return counts;
  }, { attention: 0, active: 0, silent: 0, done: 0 });
}

const DISPLAY_CAPTURE_STATUSES = new Set<RecallCaptureDisplayStatus>([
  'waiting', 'extracting', 'review_ready', 'writing', 'completed', 'partial', 'failed', 'cancelled',
]);

function encodeCaptureCursor(capture: RecallCaptureRecord): string {
  return Buffer.from(JSON.stringify([capture.updatedAt, capture.id]), 'utf8').toString('base64url');
}

function decodeCaptureCursor(cursor: string): [string, string] {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length !== 2
      || !isIsoTimestamp(parsed[0])
      || typeof parsed[1] !== 'string'
      || !safeId(parsed[1])
    ) throw new Error('invalid cursor');
    return [parsed[0], parsed[1]];
  } catch {
    throw new Error('invalid recall capture cursor');
  }
}

export async function queryRecallCaptures(
  userId: string,
  query: ListRecallCapturesQuery = {},
): Promise<RecallCapturePage> {
  const records = await listAllRecallCaptures(userId);
  const scoped = query.scope === 'all'
    ? records
    : records.filter((capture) => capture.visibility === 'visible');
  // 性能不变式：静默记录（内部筛空的 no_candidate，随时间无界增长）永不进
  // summarizeRecallCaptures——它要逐条读候选/资产。静默记录走零读取的
  // 展示构造器；counts 口径不变（只数非静默），静默数走 buckets。
  const loud = scoped.filter((capture) => !isSilentCapture(capture));
  const silent = scoped.filter(isSilentCapture);
  const summarized = await summarizeRecallCaptures(userId, loud);
  const all = [...summarized, ...silent.map(silentRecallCaptureWorkflow)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  const counts = captureCounts(summarized);
  // 分桶计数按 workflow 记录（含 displayStatus 的 done 修正），与行上展示一致。
  const buckets = captureBucketCounts(all);
  const statuses = query.statuses?.length ? new Set(query.statuses) : undefined;
  const cursor = query.cursor ? decodeCaptureCursor(query.cursor) : undefined;
  const limit = Math.max(1, Math.min(100, Math.floor(Number(query.limit) || 25)));
  const filtered = all.filter((capture) => {
    if (statuses && ![...statuses].some((status) => (
      DISPLAY_CAPTURE_STATUSES.has(status as RecallCaptureDisplayStatus)
        ? capture.displayStatus === status
        : status === 'completed'
          ? capture.workflowStatus === 'completed'
        : status === 'no_candidate'
          ? capture.status === 'no_candidate'
          : capture.workflowStatus === status
    ))) return false;
    if (query.executionPolicy && capture.executionPolicy !== query.executionPolicy) return false;
    if (!cursor) return true;
    return capture.updatedAt < cursor[0]
      || (capture.updatedAt === cursor[0] && capture.id < cursor[1]);
  });
  const captures = filtered.slice(0, limit);
  return {
    captures: await withConversationTitles(userId, captures),
    counts,
    buckets,
    nextCursor: filtered.length > captures.length && captures.length
      ? encodeCaptureCursor(captures[captures.length - 1])
      : null,
  };
}

async function updateCapture(
  userId: string,
  id: string,
  updater: (capture: RecallCaptureRecord) => RecallCaptureRecord | Promise<RecallCaptureRecord>,
): Promise<RecallCaptureRecord> {
  const updated = await updateRecallJsonRecord(userId, CAPTURE_COLLECTION, id, async (current) => {
    if (!current) throw new Error('recall capture not found');
    return updater(asCapture(current));
  });
  return asCapture(updated);
}

function requeueInterruptedCapture(userId: string, id: string): Promise<RecallCaptureRecord> {
  return updateCapture(userId, id, (current) => current.status === 'extracting'
    ? {
        ...current,
        status: 'queued',
        stage: undefined,
        errorCode: undefined,
        reasonCode: undefined,
        updatedAt: new Date().toISOString(),
      }
    : current);
}

function captureTaskKey(userId: string, id: string): string {
  return `${userId}:${id}`;
}

function durationSince(startedAt: string | undefined, finishedAt: string): number | undefined {
  if (!startedAt) return undefined;
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
}

async function settleInterruptedCapture(userId: string, id: string): Promise<RecallCaptureRecord> {
  return requeueInterruptedCapture(userId, id);
}

async function setCaptureStage(
  userId: string,
  id: string,
  stage: RecallCaptureStage,
): Promise<RecallCaptureRecord> {
  return updateCapture(userId, id, (current) => {
    if (current.status !== 'extracting') return current;
    return { ...current, stage, updatedAt: new Date().toISOString() };
  });
}

/** Feedback about a prior version is source evidence, not a current asset view.
 * Recheck the historical body's access using the capture's own scope. */
async function captureFeedbackEvaluatedBody(userId: string, assetId: string, version: string,
  sourceScope: RecallCaptureFormationCheckpoint['sourceScope'], head?: RecallAbilityAssetRecord) {
  try {
    const current = head || await readAbilityAsset(userId, assetId);
    const context = captureExistingAssetReadContext({ sourceScope });
    if (current.ownerId !== userId || current.status !== 'active' || !isAssetScopeAllowed(current.scopePolicy, context)) return undefined;
    const snapshot = await readAbilityAssetVersionSnapshot(userId, assetId, version);
    if (!snapshot || typeof snapshot.statement !== 'string' || !snapshot.statement.trim()) return undefined;
    const { filterRecallAssetsForAgentRead } = await import('./prompt-injection');
    const historical = { ...current, ...snapshot, status: current.status, scope: current.scope, scopePolicy: current.scopePolicy,
      evidenceRefs: snapshot.evidenceRefs || current.evidenceRefs };
    if (!(await filterRecallAssetsForAgentRead(userId, [historical], context)).length) return undefined;
    return { version, statement: snapshot.statement, applicableWhen: snapshot.applicableWhen, forbiddenWhen: snapshot.forbiddenWhen };
  } catch { return undefined; }
}

async function captureFeedbackSourceContext(userId: string, capture: RecallCaptureRecord,
  observations: NightlyFeedbackObservation[]) {
  const conversation = await chats.getConversation(userId, capture.conversationId);
  const sourceScope = { projectId: conversation?.project_id || undefined, workspaceId: conversation?.space_id || undefined,
    conversationKind: conversation?.kind || undefined };
  return Promise.all(observations.map(async observation => {
    let resultContext: FeedbackResultContext | undefined;
    if (observation.resultSource) {
      try { resultContext = await readFeedbackResultContext(userId, capture.conversationId, observation); }
      catch { resultContext = { status: 'unavailable' }; }
    }
    const readContext = resultContext?.status === 'available' && resultContext.readContext ? resultContext.readContext : sourceScope;
    const evaluated = resultContext?.status === 'unavailable' ? undefined
      : await captureFeedbackEvaluatedBody(userId, observation.assetId, observation.assetVersion, readContext);
    const versionContext = evaluated ? { status: 'evaluated_only' as const, evaluated } : { status: 'unavailable' as const };
    return { ...observation, ...(resultContext ? { resultContext } : {}), versionContext };
  }));
}

/** The current body in feedback is derived from the same admitted pool used by
 * the formation comparison; unavailable or no-longer-readable bodies stay absent. */
async function captureFeedbackAtBaseline(userId: string, observations: readonly NightlyFeedbackObservation[],
  pool: CaptureExistingAssetPool, sourceScope: RecallCaptureFormationCheckpoint['sourceScope']) {
  return Promise.all(observations.map(async observation => {
    const { versionContext: original, ...source } = observation as NightlyFeedbackObservation & {
      versionContext?: { status: string; evaluated?: { statement: string } }; resultContext?: FeedbackResultContext };
    const entry = pool.entries.find(item => item.snapshot.id === observation.assetId);
    const readContext = source.resultContext?.status === 'available' && source.resultContext.readContext
      ? source.resultContext.readContext : sourceScope;
    const historical = original?.status === 'evaluated_only'
      ? await captureFeedbackEvaluatedBody(userId, observation.assetId, observation.assetVersion, readContext, entry?.record) : undefined;
    const evaluated = historical?.statement === original?.evaluated?.statement ? historical : undefined;
    if (!entry || !evaluated) return { ...source, versionContext: { status: 'unavailable' as const, ...(evaluated ? { evaluated } : {}) } };
    const current = { version: entry.snapshot.version, statement: entry.snapshot.statement,
      applicableWhen: entry.snapshot.applicableWhen, forbiddenWhen: entry.snapshot.forbiddenWhen };
    return { ...source, versionContext: { status: current.version === observation.assetVersion ? 'current' as const : 'historical' as const,
      evaluated, current } };
  }));
}

async function loadStoredPromptMessages(
  userId: string,
  capture: RecallCaptureRecord,
): Promise<CapturePromptMessage[]> {
  const { start, end } = captureReviewDayBounds(capture);
  const allMessages = await readReviewDayMessages(userId, capture.conversationId, start, end, true);
  const byId = new Map(allMessages.filter(isRecallConversationMessage).map((message) => [message.id, message]));
  const wanted = new Set([...(capture.contextMessageIds || []), ...capture.messageIds]);
  const selected = allMessages.filter(message => wanted.has(message.id));
  if (wanted.size !== selected.length || !selected.length || capture.messageIds.some(id => !byId.has(id))) {
    throw new CaptureFailure('source_unavailable', 'capture messages are unavailable');
  }
  const conversationControl = await readCognitionSourceControl(userId, { kind: 'conversation', id: capture.conversationId });
  if (conversationControl && conversationControl.availability !== 'active'
    || (await listDisabledCognitionMessageIds(userId, capture.conversationId, [...wanted])).size) {
    throw new CaptureFailure('source_unavailable', 'capture source is paused or removed');
  }
  // A frozen worker result cannot be replaced by a later result under the same
  // execution id when an interrupted summary or preparation resumes.
  if (capture.feedbackVersionContexts) await assertCaptureFeedbackCurrent(userId, capture);
  // Legacy prepared checkpoints retain their original recovery contract.
  const feedbackContext = capture.formationCheckpoint && !capture.formationCheckpoint.assetBaselineDigest
    ? await readFeedbackVersionContext(userId, capture.conversationId, capture.feedbackObservations || [])
    : await captureFeedbackSourceContext(userId, capture, capture.feedbackObservations || []);
  if (feedbackContext.some(observation => observation.resultSource && observation.resultContext?.status !== 'available'))
    throw new CaptureFailure('source_unavailable', 'feedback execution context is unavailable');
  if (feedbackContext.length) {
    assertNotForbiddenToPersist([JSON.stringify(feedbackContext)]);
    await updateCapture(userId, capture.id, current => ({ ...current, feedbackVersionContexts: feedbackContext }));
  }
  return selectCaptureMessages(selected, 0, Number.MAX_SAFE_INTEGER).map((message) => ({
    ...message,
    discovery: capture.messageIds.includes(message.id),
    ...(capture.feedbackObservations?.some(item => item.messageId === message.id) ? { observations: feedbackContext.filter(item => item.messageId === message.id) } : {}),
    artifacts: message.artifacts.map((artifact) => ({
      ...artifact,
      conversationId: artifact.conversationId || capture.conversationId,
    })),
  }));
}

async function assertCaptureFeedbackCurrent(userId: string, capture: RecallCaptureRecord): Promise<void> {
  try {
    const contexts = capture.feedbackVersionContexts;
    if (!contexts || capture.formationCheckpoint && !capture.formationCheckpoint.assetBaselineDigest) {
      await assertFeedbackResultContextsCurrent(userId, capture.conversationId, contexts || capture.feedbackObservations || []);
    } else {
      for (const item of contexts) if (item.resultSource) {
        if (item.resultContext?.status !== 'available') throw new Error('feedback execution context unavailable');
        const current = await readFeedbackResultContext(userId, capture.conversationId, item);
        if (current.fingerprint !== item.resultContext.fingerprint) throw new Error('feedback execution context changed');
      }
    }
    const withEvaluated = (capture.feedbackVersionContexts || []).filter(item =>
      (item.versionContext as { status?: string } | undefined)?.status === 'evaluated_only');
    if (withEvaluated.length) {
      const conversation = await chats.getConversation(userId, capture.conversationId);
      const sourceScope = { projectId: conversation?.project_id || undefined, workspaceId: conversation?.space_id || undefined,
        conversationKind: conversation?.kind || undefined };
      for (const item of withEvaluated) {
        const readContext = item.resultContext?.status === 'available' && item.resultContext.readContext
          ? item.resultContext.readContext : sourceScope;
        const body = await captureFeedbackEvaluatedBody(userId, item.assetId, item.assetVersion, readContext);
        const previous = (item.versionContext as { evaluated?: { statement?: string } }).evaluated;
        if (!body || body.statement !== previous?.statement) throw new Error('feedback evaluated source unavailable');
      }
    }
  } catch { throw new CaptureFailure('source_unavailable', 'feedback execution context changed or is unavailable'); }
}

/** Local shortlist only. The independent model value decision follows this
 * check; an earlier local qualification never substitutes for that decision. */
async function screenQueuedRecallCapture(
  userId: string,
  id: string,
  capture: RecallCaptureRecord,
): Promise<{ capture: RecallCaptureRecord; promptMessages?: CapturePromptMessage[] }> {
  if (capture.screeningStatus === 'qualified') {
    return { capture };
  }
  let promptMessages: CapturePromptMessage[];
  try {
    promptMessages = await loadStoredPromptMessages(userId, capture);
  } catch {
    const finishedAt = new Date().toISOString();
    return {
      capture: await updateCapture(userId, id, (current) => current.status !== 'queued'
        ? current
        : {
            ...current,
            status: 'failed',
            visibility: 'internal',
            errorCode: 'source_unavailable',
            reasonCode: undefined,
            finishedAt,
            updatedAt: finishedAt,
          }),
    };
  }
  const fresh = promptMessages.filter(message => message.discovery !== false);
  const screening = screenRecallCaptureValue(fresh.some(message => message.role === 'user') ? fresh : promptMessages);
  const screenedAt = new Date().toISOString();
  const screened = await updateCapture(userId, id, (current) => current.status !== 'queued'
    ? current
    : screening.eligible || current.feedbackRevision
      ? {
          ...current,
          screeningStatus: 'qualified',
          screeningSignals: screening.signals,
          screenedAt,
          filterReason: undefined,
          updatedAt: screenedAt,
        }
      : {
          ...current,
          status: 'no_candidate',
          visibility: 'internal',
          screeningStatus: 'filtered',
          screeningSignals: screening.signals,
          screenedAt,
          filterReason: screening.reason || 'low_reuse_value',
          finishedAt: screenedAt,
          durationMs: undefined,
          updatedAt: screenedAt,
        });
  if (screened.status === 'no_candidate' && screened.filterReason) {
    void bumpRecallCaptureStats(userId, {
      coarseFiltered: 1,
      coarseReasons: { [screened.filterReason]: 1 },
    }).catch(() => {
      // 统计失败不影响筛选主流程。
    });
  }
  return { capture: screened, promptMessages };
}

function captureNeedsSupportRetry(capture: RecallCaptureRecord): boolean {
  return ['failed', 'configuration_required'].includes(capture.status)
    || ['review_ready', 'completed', 'no_candidate'].includes(capture.status)
      && !!capture.formationCheckpoint?.pendingCandidates?.length;
}

function isSettledAutomaticCandidate(candidate: Pick<RecallCandidateRecord, 'status'>): boolean {
  return ['confirmed', 'integrated', 'rejected', 'ignored', 'expired'].includes(candidate.status);
}

function isManuallyAdmittedCapture(capture: Pick<RecallCaptureRecord, 'terminalRunId'>): boolean {
  return String(capture.terminalRunId || '').includes('-manual-');
}

const preparedInputFingerprint = (input: SaveRecallCandidateInput) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
/** This certificate is part of the first immutable preparation, not a later
 * rewrite of an old checkpoint. It binds source conclusions to this group's
 * actual fully revised input rather than to the pre-revision extraction. */
function preparedRuleSourceAssessment(userId: string, input: SaveRecallCandidateInput, capture: RecallCaptureRecord, index: number,
  document: ReturnType<typeof readOntologyDocument>) {
  const batch = capture.formationBatchAssessment;
  const row = batch?.assessments.find(row => row.index === index);
  if (batch?.ruleSemanticsPolicyVersion !== 3 || !batch.sourceFingerprint || !row?.sourceRuleConclusions
    || !Object.entries(row.checks).filter(([key]) => key !== 'evidence').every(([, value]) => value === true)) return undefined;
  if (document.ownerId !== userId) return undefined;
  const context = formationRuleContext(document);
  const resultingContracts = formationRuleContracts(input.ontologyFormation, context);
  if (!resultingContracts.length || !deriveFormationRuleRevisions(input.ontologyFormation, row.sourceRuleConclusions, context, false).supported) return undefined;
  return { policyVersion: 3 as const, sourceFingerprint: batch.sourceFingerprint, batchFingerprint: batch.fingerprint,
    finalInputFingerprint: preparedInputFingerprint(input), conclusions: structuredClone(row.sourceRuleConclusions), resultingContracts };
}
function hasPreparedRuleSourceAssessment(userId: string, capture: RecallCaptureRecord, group: RecallCaptureFormationCheckpoint['groups'][number],
  document: ReturnType<typeof readOntologyDocument>): boolean {
  const proof = group.ruleSourceAssessment, batch = capture.formationBatchAssessment;
  if (!proof || proof.policyVersion !== 3 || batch?.ruleSemanticsPolicyVersion !== 3 || proof.sourceFingerprint !== batch.sourceFingerprint
    || proof.batchFingerprint !== batch.fingerprint || proof.finalInputFingerprint !== preparedInputFingerprint(group.input)) return false;
  const row = batch.assessments.find(row => row.index === group.index);
  if (!row?.sourceRuleConclusions || JSON.stringify(row.sourceRuleConclusions) !== JSON.stringify(proof.conclusions)
    || !Object.entries(row.checks).filter(([key]) => key !== 'evidence').every(([, value]) => value === true)) return false;
  if (document.ownerId !== userId) return false;
  const context = formationRuleContext(document);
  const actual = formationRuleContracts(group.input.ontologyFormation, context);
  return JSON.stringify(actual) === JSON.stringify(proof.resultingContracts)
    && deriveFormationRuleRevisions(group.input.ontologyFormation, proof.conclusions, context, false).supported;
}

function sameFormationGeneration(current: RecallCaptureRecord, expected: RecallCaptureFormationCheckpoint): boolean {
  if (!expected.assetBaselineDigest) return true;
  const actual = current.formationCheckpoint;
  return !!actual && actual.assetBaselineDigest === expected.assetBaselineDigest
    && (actual.assetBaselineRefreshes || 0) === (expected.assetBaselineRefreshes || 0)
    && (actual.formationGeneration || 0) === (expected.formationGeneration || 0)
    && (actual.assetBaselineAttempt || current.attempt) === (expected.assetBaselineAttempt || current.attempt);
}

async function recoverPreparedCaptureReceipts(userId: string, checkpoint: RecallCaptureFormationCheckpoint): Promise<void> {
  for (const group of checkpoint.groups) {
    if (group.savedCandidateId || group.omitted || !group.input.captureKey
      || checkpoint.sourceProposalVersion === 1 && !group.submissionStarted) continue;
    const candidate = await findCaptureCandidateReceipt(userId, group.input.captureKey);
    if (candidate) group.savedCandidateId = candidate.id;
  }
}

async function assertFormationAssetBaselineCurrent(userId: string,
  sourceScope: RecallCaptureFormationCheckpoint['sourceScope'], expectedDigest?: string): Promise<void> {
  if (!expectedDigest) return;
  await withCognitionTransition(userId, async () => {
    const current = await loadCaptureExistingAssetPool(userId, { sourceScope });
    if (current.baselineDigest !== expectedDigest)
      throw new CaptureFailure('formation_baseline_stale', 'asset baseline changed during formation');
  });
}

async function persistPreparedCapture(userId: string, capture: RecallCaptureRecord,
  checkpoint: RecallCaptureFormationCheckpoint, canContinue: () => Promise<boolean>, signal?: AbortSignal, settle = true): Promise<RecallCaptureRecord> {
  const execute = () => persistPreparedCaptureCore(userId, capture, checkpoint, canContinue, signal, settle);
  let result = checkpoint.assetBaselineDigest
    ? await withCognitionTransition(userId, async () => {
      const latest = await readRecallCapture(userId, capture.id);
      if (latest.status !== 'extracting' || latest.startedAt !== capture.startedAt || !sameFormationGeneration(latest, checkpoint)) return latest;
      await recoverPreparedCaptureReceipts(userId, checkpoint);
      await assertFormationAssetBaselineCurrent(userId, checkpoint.sourceScope, checkpoint.assetBaselineDigest);
      return execute();
    })
    : await execute();
  if (result.status === 'review_ready' && result.autoApprovalEpoch)
    result = await automaticallyReviewCompletedCapture(userId, result, signal);
  return result;
}

async function persistPreparedCaptureCore(userId: string, capture: RecallCaptureRecord,
  checkpoint: RecallCaptureFormationCheckpoint, canContinue: () => Promise<boolean>, signal?: AbortSignal, settle = true): Promise<RecallCaptureRecord> {
  const id = capture.id;
  const runStartedAt = capture.startedAt;
  await assertCaptureFeedbackCurrent(userId, capture);
  const candidates: RecallCandidateRecord[] = [];
  for (const group of checkpoint.groups) {
    if (signal?.aborted || !await canContinue()) return settleInterruptedCapture(userId, id);
    if (group.omitted) continue;
    let candidate: RecallCandidateRecord | undefined;
    if (group.savedCandidateId) {
      try { candidate = await readRecallCandidate(userId, group.savedCandidateId); }
      catch (error) { if (!candidateUnavailableForWorkflow(error)) throw error; }
      if (!candidate && checkpoint.assetBaselineDigest) throw new CaptureFailure('candidate_save_failed', 'saved candidate is unavailable');
    }
    if (!candidate) {
      let input = group.input;
      if (!input?.captureKey || input.captureProvenance?.captureId !== id
        || input.captureProvenance.extractionCompletedAt !== checkpoint.completedAt
        || input.captureProvenance.valueJudgment.judgedAt !== checkpoint.judgedAt)
        throw new CaptureFailure('formation_checkpoint_stale', 'prepared group identity is invalid');
      const ontologyDocument = input.ontologyFormation ? readOntologyDocument(userId) : undefined;
      if (ontologyDocument && hasFormationRuleChanges(input.ontologyFormation, ontologyDocument.records)
        && !hasPreparedRuleSourceAssessment(userId, capture, group, ontologyDocument)) {
        // Preserve the frozen group.input and saved groups. Only the submitted
        // unsaved copy gets an explicit human-visible hold; no model call or
        // semantic repair is allowed during legacy checkpoint recovery.
        const marker = '形成提案尚未完成来源优先的规则合同核查，请核对强度、条件、例外及效果后确认。';
        const uncertainty = input.ontologyFormation?.blockedReasons.includes('rule_source_assessment_required') && input.uncertainty
          ? input.uncertainty : input.uncertainty ? `${marker}\n${input.uncertainty}` : marker;
        input = { ...input, uncertainty: uncertainty.length <= 1000 ? uncertainty : input.uncertainty,
          ontologyFormation: { ...input.ontologyFormation!, blockedReasons: [...new Set([
            ...input.ontologyFormation!.blockedReasons, 'rule_source_assessment_required'])] } };
      }
      if (input.targetAssetId) {
        let target: RecallAbilityAssetRecord;
        try { target = await readAbilityAsset(userId, input.targetAssetId); }
        catch { throw new CaptureFailure('formation_baseline_unavailable', 'prepared target is unavailable'); }
        const version = String(target.activeVersion || target.version);
        if (version !== target.version) {
          const snapshot = await readAbilityAssetVersionSnapshot(userId, target.id, version);
          if (!snapshot) throw new CaptureFailure('formation_baseline_unavailable', 'prepared target snapshot is unavailable');
          target = { ...target, ...snapshot, status: target.status, scope: target.scope, scopePolicy: target.scopePolicy };
        }
        const { filterRecallAssetsForAgentRead } = await import('./prompt-injection');
        const context = captureExistingAssetReadContext({ sourceScope: checkpoint.sourceScope });
        if (target.status !== 'active' || !isAssetScopeAllowed(target.scopePolicy, context)
          || !(await filterRecallAssetsForAgentRead(userId, [target], context)).length)
          throw new CaptureFailure('formation_baseline_unavailable', 'prepared target is no longer readable');
        if (version !== input.targetVersionUsed) input = { ...input,
          uncertainty: input.uncertainty || '已有内容的在用版本已变化，请比较当前版本后确认。' };
      }
      if (input.ontologyFormation && ontologyDocument!.revision !== input.ontologyFormation.baselineRevision) {
        input = { ...input, ontologyFormation: { ...input.ontologyFormation,
          blockedReasons: [...new Set([...input.ontologyFormation.blockedReasons, 'ontology_baseline_changed'])] } };
      }
      await assertCaptureFeedbackCurrent(userId, capture);
      if (checkpoint.sourceProposalVersion === 1 && !group.submissionStarted) {
        // Record the uncertain write window before touching candidate storage.
        // A fresh group has no receipt to recover and must not scan the pool.
        group.submissionStarted = true;
        capture = await updateCapture(userId, id, current => current.status !== 'extracting' || current.startedAt !== runStartedAt
          || !sameFormationGeneration(current, checkpoint) ? current : {
          ...current, formationCheckpoint: checkpoint, updatedAt: new Date().toISOString(),
        });
        if (capture.status !== 'extracting' || capture.startedAt !== runStartedAt || !sameFormationGeneration(capture, checkpoint)) return capture;
      }
      try { candidate = await submitCognitionCandidate(userId, input); }
      catch (error) {
        if (String((error as Error).message).includes('forbidden to persist')) {
          group.omitted = true;
        } else {
          log.warn('prepared capture group save failed', { captureId: id, groupIndex: group.index });
          throw new CaptureFailure('candidate_save_failed', 'prepared group could not be saved');
        }
      }
      if (candidate) group.savedCandidateId = candidate.id;
      capture = await updateCapture(userId, id, current => current.status !== 'extracting' || current.startedAt !== runStartedAt
        || !sameFormationGeneration(current, checkpoint) ? current : {
        ...current, formationCheckpoint: checkpoint,
        candidateIds: [...new Set([...(current.candidateIds || []), ...(candidate ? [candidate.id] : [])])],
        updatedAt: new Date().toISOString(),
      });
      if (capture.status !== 'extracting') return capture;
    }
    if (candidate && (isAutoCaptureEligible(candidate) || isSettledAutomaticCandidate(candidate))) candidates.push(candidate);
  }
  const candidateIds = [...new Set([
    ...candidates.map((candidate) => candidate.id),
  ])];
  capture = await updateCapture(userId, id, (current) => current.status !== 'extracting' || current.startedAt !== runStartedAt
    || !sameFormationGeneration(current, checkpoint)
    ? current
    : {
        ...current,
        candidateIds,
        updatedAt: new Date().toISOString(),
      });
  if (capture.status !== 'extracting' || signal?.aborted) return settleInterruptedCapture(userId, id);

  if (!settle) return capture;

  const finishedAt = new Date().toISOString();
  const modelUsage = checkpoint.modelUsage;
  const hasQualifiedCandidates = candidateIds.length > 0;
  const supportEvaluationFailed = !hasQualifiedCandidates && (capture.candidateSupportUnavailableCount || 0) > 0;
  const hasReviewableCandidates = candidates.some((candidate) => (
    isAutoCaptureEligible(candidate)
  ));
  capture = await updateCapture(userId, id, (current) => current.status !== 'extracting' || current.startedAt !== runStartedAt
    || !sameFormationGeneration(current, checkpoint)
    ? current
    : {
        ...current,
        ...(checkpoint.sourceProposalVersion === 1 ? { formationCheckpoint: { ...checkpoint, pendingCandidates: (checkpoint.pendingCandidates || []).filter(item => (checkpoint.supportPendingIndexes || []).includes(item.index)) } } : {}),
        status: supportEvaluationFailed ? 'failed' : hasReviewableCandidates ? 'review_ready' : hasQualifiedCandidates ? 'completed' : 'no_candidate',
        visibility: current.executionPolicy === 'manual' || hasQualifiedCandidates ? 'visible' : 'internal',
        screeningStatus: hasQualifiedCandidates || supportEvaluationFailed ? 'qualified' : 'filtered',
        // 区分模型判空、全部解析丢弃与有效候选被质量门筛掉，不混淆处理原因。
        filterReason: hasQualifiedCandidates || supportEvaluationFailed
          ? undefined
          : checkpoint.parsedCount
            ? 'candidate_quality'
            : checkpoint.emittedCount ? 'candidate_unparsable' : 'model_no_candidate',
        ...(checkpoint.noCandidateReason && !hasQualifiedCandidates && !supportEvaluationFailed
          ? { noCandidateReason: checkpoint.noCandidateReason }
          : {}),
        stage: undefined,
        autoWrite: undefined,
        candidateIds,
        errorCode: supportEvaluationFailed ? 'candidate_support_unavailable' : undefined,
        reasonCode: undefined,
        finishedAt,
        durationMs: durationSince(current.startedAt, finishedAt),
        ...(modelUsage ? { modelUsage } : {}),
        updatedAt: finishedAt,
      });
  if (capture.status === 'failed' && capture.errorCode === 'candidate_support_unavailable') {
    void bumpRecallCaptureStats(userId, { failures: { candidate_support_unavailable: 1 } }).catch(() => {});
  }
  if (capture.status === 'review_ready' || capture.status === 'no_candidate' || capture.status === 'completed') {
    void bumpRecallCaptureStats(userId, {
      extracted: 1,
      suggestions: candidateIds.length,
      ...(capture.status === 'review_ready' ? { reviewReady: 1 } : {}),
      ...(capture.status === 'no_candidate'
        ? {
          noCandidate: 1,
          ...(capture.filterReason ? { noCandidateReasons: { [capture.filterReason]: 1 } } : {}),
        }
        : {}),
    }).catch(() => {
      // 统计失败不影响结算主流程。
    });
  }
  return capture;
}

export async function runRecallCapture(
  userId: string,
  id: string,
  signal?: AbortSignal,
): Promise<RecallCaptureRecord> {
  let queued = await readRecallCapture(userId, id);
  if (queued.status !== 'queued') return queued;
  if (queued.executionPolicy !== 'nightly' || !queued.reviewDay) throw new Error('only nightly capture is available');
  const manualAdmitted = isManuallyAdmittedCapture(queued);
  const canContinue = () => nightlyCaptureCanStart(userId, manualAdmitted);
  const executionSettings = await readRecallCaptureSettings(userId);
  if (!executionSettings.enabled) {
    return updateCapture(userId, id, current => current.status !== 'queued' ? current : {
      ...current, status: 'cancelled', visibility: 'internal', errorCode: 'capture_disabled', reasonCode: undefined, updatedAt: new Date().toISOString(),
    });
  }
  if (!await canContinue()) return queued;
  const sourceControl = await readCognitionSourceControl(userId, {
    kind: 'conversation',
    id: queued.conversationId,
  });
  if (sourceControl && sourceControl.availability !== 'active') {
    return updateCapture(userId, id, (current) => current.status !== 'queued'
      ? current
      : {
          ...current,
          status: 'cancelled',
          visibility: 'internal',
          resumeStatus: undefined,
          errorCode: sourceControl.availability === 'removed' ? 'source_removed' : 'source_paused',
          reasonCode: undefined,
          updatedAt: new Date().toISOString(),
        });
  }
  const screened = await screenQueuedRecallCapture(userId, id, queued);
  // 筛选阶段已加载过同一份消息（messageIds 在 capture 创建时固定，两次读之间
  // 本就无锁），提取阶段复用，免去对同一会话 JSONL 的第二次全量翻页读；
  // qualified/manual 重跑没读过（undefined）则提取阶段自读。
  const screenedPromptMessages = screened.promptMessages;
  queued = screened.capture;
  if (queued.status !== 'queued') return queued;
  let claimed = false;
  const startedAt = new Date().toISOString();
  let capture = await updateCapture(userId, id, (current) => ({
    ...(current.status === 'queued' ? (() => {
      claimed = true;
      return {
        ...current,
        ...(current.formationCheckpoint?.assetBaselineDigest
          && current.formationCheckpoint.assetBaselineAttempt !== undefined
          && current.formationCheckpoint.assetBaselineAttempt !== current.attempt
          ? { formationCheckpoint: { ...current.formationCheckpoint, assetBaselineAttempt: current.attempt,
              assetBaselineRefreshes: 0 as const, formationNeedsRefresh: true,
              formationGeneration: (current.formationCheckpoint.formationGeneration || 0) + 1, supportPendingIndexes: undefined },
              formationBatchAssessment: undefined, uncertaintyAssessments: undefined,
              candidateSupportUnavailable: undefined, candidateSupportUnavailableCount: undefined } : {}),
        status: 'extracting' as const,
        stage: 'model_check' as const,
        errorCode: undefined,
        reasonCode: undefined,
        startedAt,
        autoApprovalEpoch: current.feedbackRevision ? undefined : captureAutoApprovalAuthorization(executionSettings).autoApprovalEpoch,
        autoApprovalEnabledAt: current.feedbackRevision ? undefined : captureAutoApprovalAuthorization(executionSettings).autoApprovalEnabledAt,
        finishedAt: undefined,
        durationMs: undefined,
        modelUsage: undefined,
        extractionRepairAttempted: undefined,
        uncertaintyAssessments: current.formationCheckpoint && (current.formationCheckpoint.assetBaselineAttempt === undefined || current.formationCheckpoint.assetBaselineAttempt === current.attempt) ? current.uncertaintyAssessments : undefined,
        candidateSupportUnavailable: current.formationCheckpoint && (current.formationCheckpoint.assetBaselineAttempt === undefined || current.formationCheckpoint.assetBaselineAttempt === current.attempt) ? current.candidateSupportUnavailable : undefined,
        candidateSupportUnavailableCount: current.formationCheckpoint && (current.formationCheckpoint.assetBaselineAttempt === undefined || current.formationCheckpoint.assetBaselineAttempt === current.attempt) ? current.candidateSupportUnavailableCount : undefined,
        updatedAt: startedAt,
      };
    })() : current),
  }));
  if (!claimed) return capture;
  let activeFormationToken = capture.formationCheckpoint ? structuredClone(capture.formationCheckpoint) : undefined;

  try {
    if (signal?.aborted) return settleInterruptedCapture(userId, id);
    const settings = await readRecallCaptureSettings(userId);
    const modelCandidates = await resolveRecallCaptureModelCandidates(userId, settings.modelCandidates);
    capture = await setCaptureStage(userId, id, 'recall_view');
    if (capture.status !== 'extracting' || signal?.aborted) return settleInterruptedCapture(userId, id);
    let conversation: Awaited<ReturnType<typeof chats.getConversation>>;
    let promptMessages: CapturePromptMessage[];
    try {
      [conversation, promptMessages] = await Promise.all([
        chats.getConversation(userId, capture.conversationId),
        screenedPromptMessages ?? loadStoredPromptMessages(userId, capture),
      ]);
    } catch (error) {
      if (error instanceof CaptureFailure) throw error;
      throw new CaptureFailure('source_unavailable', 'capture source could not be read');
    }
    if (!conversation) throw new CaptureFailure('source_unavailable', 'conversation is unavailable');
    if (!capture.conversationTitle && conversation.title) {
      capture = await updateCapture(userId, id, (current) => ({
        ...current,
        conversationTitle: conversation.title,
        updatedAt: new Date().toISOString(),
      }));
    }

    if (!await canContinue()) return settleInterruptedCapture(userId, id);
    const sourceDigest = captureContextSourceDigest(promptMessages);
    if (capture.formationCheckpoint && capture.formationCheckpoint.sourceDigest !== sourceDigest)
      throw new CaptureFailure('formation_checkpoint_stale', 'prepared source changed; review the existing groups');
    let validSummary: CaptureContextSummary | undefined;
    if (capture.contextSummary) {
      try {
        validSummary = validateCaptureContextSummary(capture.contextSummary, promptMessages);
        assertSafeCaptureSummary(validSummary);
      }
      catch { validSummary = undefined; /* Rebuild stale, malformed or unsafe derived content. */ }
    }
    if (capture.formationCheckpoint && !validSummary)
      throw new CaptureFailure('formation_checkpoint_stale', 'prepared context summary is unavailable');
    if (!validSummary) {
      capture = await setCaptureStage(userId, id, 'context_summary');
      let checkpoint = capture.summaryCheckpoint?.sourceDigest === sourceDigest
        ? capture.summaryCheckpoint : undefined;
      if (checkpoint) {
        try { assertSafeCaptureSummary(checkpoint); }
        catch { checkpoint = undefined; }
      }
      capture = await updateCapture(userId, id, current => current.status !== 'extracting' ? current : {
        ...current, contextSummary: undefined, valueJudgment: undefined, extractionCompletedAt: undefined,
        summaryCheckpoint: checkpoint, updatedAt: new Date().toISOString(),
      });
      if (capture.status !== 'extracting') return capture;
      // One bounded contract-repair retry for validator rejections: the retry
      // resends the same frozen source from the last persisted checkpoint with a
      // fixed contract restatement (never user text or previous output) through
      // the same validator; both attempts are ordinary metered model calls.
      let summaryResume: CaptureContextCheckpoint | undefined = checkpoint;
      const persistSummaryCheckpoint = async (progress: CaptureContextCheckpoint) => {
        assertSafeCaptureSummary(progress);
        summaryResume = progress;
        capture = await updateCapture(userId, id, current => current.status !== 'extracting' ? current : {
          ...current, summaryCheckpoint: progress, updatedAt: new Date().toISOString(),
        });
      };
      const summarizeOnce = (repairInstruction?: string) => summarizeCaptureContext(promptMessages, {
        checkpoint: summaryResume,
        run: input => runCaptureAnalysisModel(userId, capture, 'summary', input, signal, canContinue, repairInstruction),
        shouldContinue: async () => capture.status === 'extracting' && !signal?.aborted && await canContinue(),
        onCheckpoint: persistSummaryCheckpoint,
      });
      try {
        try {
          validSummary = await summarizeOnce();
        } catch (error) {
          const repairInstruction = captureSummaryRepairInstruction(captureSummaryInvalidReason(error) || '');
          if (!repairInstruction) throw error;
          validSummary = await summarizeOnce(repairInstruction);
        }
        assertSafeCaptureSummary(validSummary);
      } catch (error) {
        if (error instanceof CaptureContextInterruptedError || signal?.aborted
          || (error as { code?: string })?.code === 'ABORT_ERR') return settleInterruptedCapture(userId, id);
        if (error instanceof CaptureFailure) throw error;
        if ((error as { code?: string }).code === 'capture_model_not_configured') throw new CaptureFailure('model_not_configured', 'capture model configuration is required');
        // Split the former single summary_failed so logs and records tell model
        // failures, validator rejections and output-budget exhaustion apart.
        const invalidReason = captureSummaryInvalidReason(error);
        if (invalidReason) throw captureSummaryFailure(invalidReason);
        if ((error as { code?: string }).code === 'capture_model_unavailable')
          throw new CaptureFailure('summary_model_failed', 'capture analysis model did not complete', 'capture_model_unavailable');
        log.warn('recall capture summary failed', { captureId: capture.id,
          reason: (error as Error)?.message?.slice(0, 300) || String(error).slice(0, 300) });
        throw new CaptureFailure('summary_failed', 'context summary failed validation');
      }
      capture = await updateCapture(userId, id, current => current.status !== 'extracting' ? current : {
        ...current, contextSummary: validSummary, summaryCheckpoint: undefined, updatedAt: new Date().toISOString(),
      });
      if (capture.status !== 'extracting') return capture;
    } else {
      capture = { ...capture, contextSummary: validSummary };
    }
    if (!await canContinue()) return settleInterruptedCapture(userId, id);
    // A previous value decision may only be reused with the very same validated
    // complete summary. Legacy decisions never skip this new stage.
    const judgmentSummaryDigest = captureSummaryDecisionDigest(validSummary);
    if (capture.formationCheckpoint && (!capture.valueJudgment?.eligible
      || capture.formationCheckpoint.summaryDigest !== judgmentSummaryDigest
      || capture.formationCheckpoint.judgedAt !== capture.valueJudgment.judgedAt))
      throw new CaptureFailure('formation_checkpoint_stale', 'prepared value decision changed');
    if (!capture.valueJudgment?.eligible || capture.valueJudgment.summaryDigest !== judgmentSummaryDigest) {
      capture = await setCaptureStage(userId, id, 'value_judgment');
      let judgment: CaptureValueJudgment;
      try {
        judgment = { ...parseCaptureValueJudgment(await judgeCaptureValue(userId, capture, promptMessages, signal, canContinue),
          promptMessages.map(message => ({ ...message, sourceId: cognitionMessageSourceId(capture.conversationId, message.id) })), validSummary),
          summaryDigest: judgmentSummaryDigest };
        assertNotForbiddenToPersist([judgment.reason, ...judgment.evidence.map(item => item.quote)]);
      } catch (error) {
        if (signal?.aborted || (error as { code?: string })?.code === 'ABORT_ERR') return settleInterruptedCapture(userId, id);
        if (error instanceof CaptureFailure) throw error;
        if ((error as { code?: string }).code === 'capture_model_not_configured') throw new CaptureFailure('model_not_configured', 'capture model configuration is required');
        log.warn('recall capture value judgment failed', { captureId: capture.id,
          reason: (error as Error)?.message?.slice(0, 300) || String(error).slice(0, 300) });
        throw new CaptureFailure('value_judgment_failed', 'value judgment failed validation');
      }
      if (signal?.aborted) return settleInterruptedCapture(userId, id);
      capture = await updateCapture(userId, id, current => current.status !== 'extracting' ? current : {
        ...current, valueJudgment: judgment, extractionCompletedAt: undefined, updatedAt: judgment.judgedAt,
        ...(!judgment.eligible ? { status: 'no_candidate' as const, visibility: 'internal' as const,
          screeningStatus: 'filtered' as const, filterReason: 'low_reuse_value' as const,
          noCandidateReason: judgment.reason, finishedAt: judgment.judgedAt, stage: undefined } : {}),
      });
      if (capture.status !== 'extracting') return capture;
    }

    const sourceScope = { projectId: conversation.project_id || undefined,
      workspaceId: conversation.space_id || undefined, conversationKind: conversation.kind || undefined };
    if (capture.formationCheckpoint) {
      if (capture.formationCheckpoint.version !== 1 || !Array.isArray(capture.formationCheckpoint.groups)
        || JSON.stringify(capture.formationCheckpoint.sourceScope) !== JSON.stringify(sourceScope))
        throw new CaptureFailure('formation_checkpoint_stale', 'prepared source scope changed');
      if (capture.formationCheckpoint.assetBaselineDigest && capture.formationCheckpoint.formationNeedsRefresh) {
        const original = capture.formationCheckpoint;
        const recovered = structuredClone(original);
        await withCognitionTransition(userId, () => recoverPreparedCaptureReceipts(userId, recovered));
        const saved = recovered.groups.filter(group => group.savedCandidateId);
        recovered.groups = saved;
        recovered.pendingCandidates = recovered.pendingCandidates?.filter(item => !saved.some(group => group.index === item.index));
        capture = await updateCapture(userId, id, current => current.status !== 'extracting' || current.startedAt !== startedAt
          || !sameFormationGeneration(current, original) ? current : { ...current, formationCheckpoint: recovered,
            candidateIds: [...new Set([...(current.candidateIds || []), ...saved.flatMap(group => group.savedCandidateId ? [group.savedCandidateId] : [])])] });
        if (capture.status !== 'extracting' || capture.startedAt !== startedAt || !sameFormationGeneration(capture, recovered)) return capture;
        activeFormationToken = structuredClone(recovered);
      }
      const resumeCheckpoint = capture.formationCheckpoint;
      if (!resumeCheckpoint) return capture;
      if ((!resumeCheckpoint.pendingCandidates?.length || resumeCheckpoint.sourceProposalVersion === 1
        && resumeCheckpoint.supportPendingIndexes?.length === 0) && !resumeCheckpoint.formationNeedsRefresh)
        return await persistPreparedCapture(userId, capture, resumeCheckpoint, canContinue, signal);
      // Finish immutable prepared writes before replacing the batch proof for
      // remaining groups. A stale formation retries from its frozen drafts instead.
      if (!resumeCheckpoint.formationNeedsRefresh) {
        capture = await persistPreparedCapture(userId, capture, resumeCheckpoint, canContinue, signal, false);
        if (capture.status !== 'extracting') return capture;
      }
    }

    // Keep later corrections and prior context. Value evidence controls what
    // may be extracted; it must not delete contextual messages from the input.

    let recallView: RecallViewRecord | undefined;
    const feedbackSourceRefs = (capture.feedbackVersionContexts || []).flatMap(observation =>
      observation.resultContext?.status === 'available' ? observation.resultContext.sourceRefs : []);
    let activeTeachingSignals: Awaited<ReturnType<typeof listUserTeachingSignals>> = [];
    try {
      activeTeachingSignals = (await listUserTeachingSignals(userId, {
        conversationId: capture.conversationId,
        status: 'active',
        limit: 100,
      })).filter((signal) => capture.messageIds.includes(signal.messageId));
      const workspaceId = conversation.project_id || undefined;
      if (capture.recallViewId) {
        try {
          const existing = await readRecallView(userId, capture.recallViewId);
          if (
            !isRecallViewExpired(existing)
            && existing.purpose === 'conversation_capture'
            && existing.workspaceId === workspaceId
            && feedbackSourceRefs.every(source => existing.sourceRefs.some(ref => ref.kind === source.kind
              && ref.subtype === source.subtype && ref.id === source.id && ref.sourceVersion === source.sourceVersion && !ref.degraded))
            && sameIds(
              existing.sourceRefs
                .filter((ref) => ref.kind === 'user_teaching_signal' && !ref.degraded)
                .map((ref) => ref.id),
              activeTeachingSignals.map((signal) => signal.id),
            )
          ) recallView = existing;
        } catch {
          // A missing view can be rebuilt from the durable capture source ids.
        }
      }
      if (!recallView) {
        const executionGroups = await listCognitionSources(userId, {
          kinds: ['execution_evaluation'],
          conversationId: capture.conversationId,
          limit: 10,
        });
        const sourceRefs = [
          {
            kind: 'conversation' as const,
            subtype: 'session' as const,
            scope: 'conversation' as const,
            id: capture.conversationId,
            title: conversation.title,
            sourceVersion: conversation.updated_at,
          },
          ...promptMessages.map(message => cognitionMessageSourceRef(capture.conversationId, message)),
          ...promptMessages.flatMap((message) => message.artifacts.map((artifact) => ({
            kind: 'artifact_file' as const,
            subtype: 'artifact' as const,
            scope: 'conversation' as const,
            id: cognitionArtifactSourceId(artifact.conversationId || capture.conversationId, artifact.id),
            title: artifact.title,
            sourceVersion: message.ts,
          }))),
          ...executionGroups.flatMap((group) => group.items),
          ...feedbackSourceRefs,
          ...activeTeachingSignals.map((signal) => ({
            kind: 'user_teaching_signal' as const,
            subtype: 'teaching' as const,
            scope: signal.scope,
            id: signal.id,
            sourceVersion: signal.createdAt,
          })),
        ];
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
        recallView = await createRecallView(userId, {
          purpose: 'conversation_capture',
          ...(workspaceId ? { workspaceId } : {}),
          sourceRefs,
          assetRefs: [],
          expiresAt,
        });
        capture = await updateCapture(userId, id, (current) => ({
          ...current,
          recallViewId: recallView.id,
          updatedAt: new Date().toISOString(),
        }));
      }
    } catch (error) {
      log.warn('recall view creation failed', { captureId: capture.id,
        reason: (error as Error)?.message?.slice(0, 300) || String(error).slice(0, 300) });
      throw new CaptureFailure('recall_view_failed', 'recall view could not be created');
    }

    capture = await setCaptureStage(userId, id, 'model_extraction');
    if (capture.status !== 'extracting' || signal?.aborted) return settleInterruptedCapture(userId, id);

    if (!await canContinue()) return settleInterruptedCapture(userId, id);

    // All formation stages retain the configured API or installed CLI model route.
    const extractionAssetPool = await withCognitionTransition(userId, () => loadCaptureExistingAssetPool(userId, { sourceScope }));
    const { assets: extractionAssets, coverage: comparisonCoverage } = await selectCaptureExistingAssetsFromPool(userId, extractionAssetPool, {
      summary: capture.contextSummary, approvedEvidence: capture.valueJudgment?.evidence,
      sourceScope,
    });
    const ontologyDocument = readOntologyDocument(userId);
    let ontologyContext = await buildSourceQualifiedOntologyFormationContext(userId, ontologyDocument, {
      scopeBound: true,
      queryText: [capture.contextSummary?.topics.map(topic => `${topic.title}\n${topic.content}`).join('\n'),
        capture.valueJudgment?.evidence.map(item => item.quote).join('\n')].filter(Boolean).join('\n'),
      ...(conversation.project_id ? { projectId: conversation.project_id } : {}),
      ...(conversation.space_id ? { workspaceId: conversation.space_id } : {}),
    });
    let extractionText: string;
    let extractionModelUsage: RecallCaptureModelUsage | undefined;
    const schemaRepairInstruction = 'The previous extraction was not a complete parseable proposal. Re-read the same approved source and return the explicit proposalVersion:2 envelope described above. Each group owns its complete cognition or ontology explanation and its evidence. ontologyChanges belongs only inside its owning ontology or joint proposal. Never borrow an unowned top-level plan or invent cognition for ontology-only changes. Include supported conditions and exceptions. Do not guess a missing scope, identity, fact or source, and do not claim anything has been saved. If the source cannot support a complete proposal, return an empty proposals array and a short reason.';
    const requestExtraction = async (repair = false): Promise<{ text: string; usage?: RecallCaptureModelUsage }> => {
      const { result, chosen } = await runRecallCaptureModel(userId, {
        sessionId: `memory-extract-${repair ? 'repair' : 'recall'}-${capture.id}`,
        cliContext: { conversationId: capture.conversationId, agentId: 'recall-capture-extractor', agentName: 'Capture Extractor' },
        budget: { jobId: capture.id, stage: 'extraction' },
        systemPrompt: extractionSystemPrompt() + (repair ? `\n\n${schemaRepairInstruction}` : ''), modelCandidates,
        message: extractionInput(conversation.title, promptMessages, recallView, [],
          capture.contextSummary, capture.valueJudgment?.evidence, ontologyContext, {
            ...(conversation.project_id ? { projectId: conversation.project_id } : {}),
            ...(conversation.space_id ? { workspaceId: conversation.space_id } : {}),
          }), signal,
        shouldContinue: () => canContinue(),
      });
      if (signal?.aborted) throw Object.assign(new Error('capture extraction interrupted'), { code: 'ABORT_ERR' });
      if (result.meta.aborted) throw Object.assign(new Error('capture extraction interrupted'), { code: 'ABORT_ERR' });
      if (result.meta.error) {
        const code = result.meta.error.kind === 'auth'
          ? 'model_auth_required'
          : result.meta.error.kind === 'timeout'
            ? 'model_timeout'
            : 'model_failed';
        throw new CaptureFailure(code, result.meta.error.message);
      }
      return { text: result.text.trim(), usage: normalizeModelUsage({ ...result.meta.usage, ...chosen }) };
    };
    const previousPreparation = capture.formationCheckpoint;
    let parseResult: RecallCaptureParseResult | undefined;
    let drafts: NonNullable<RecallCaptureFormationCheckpoint['pendingCandidates']>;
    if (previousPreparation && (previousPreparation.pendingCandidates?.length
      || previousPreparation.sourceProposalVersion === 1 && previousPreparation.pendingCandidates !== undefined)) {
      drafts = structuredClone(previousPreparation.pendingCandidates || []).filter(item =>
        !previousPreparation.groups.some(group => group.savedCandidateId && group.index === item.index)
        && (previousPreparation.formationNeedsRefresh || previousPreparation.supportPendingIndexes === undefined
          || previousPreparation.supportPendingIndexes.includes(item.index)));
      parseResult = { candidates: drafts.map(item => item.candidate), emittedCount: previousPreparation.emittedCount,
        ...(previousPreparation.noCandidateReason ? { noCandidateReason: previousPreparation.noCandidateReason } : {}) };
      extractionModelUsage = previousPreparation.modelUsage;
    } else {
      const initialExtraction = await requestExtraction();
      if (signal?.aborted || !await canContinue()) return settleInterruptedCapture(userId, id);
      extractionText = initialExtraction.text; extractionModelUsage = initialExtraction.usage;
      let initialParseError: unknown;
      try {
        parseResult = parseRecallCaptureResult(
          extractionText,
          new Set(promptMessages.map((message) => message.label)),
        );
      } catch (error) {
        // Keep model output out of logs: it may contain user-authored content.
        log.warn('recall capture parse failed', {
          capture_id: id,
          conversation_id: capture.conversationId,
          error: error instanceof CaptureFailure ? error.message : String((error as Error)?.message || error),
        });
        initialParseError = error;
      }
      // One bounded format repair, using the same full source and baselines.
      // Valid proposals are never discarded/re-generated to improve the verdict.
      // Missing fields cannot be invented by a deterministic default.
      if (!parseResult || (parseResult.emittedCount > 0 && parseResult.candidates.length === 0)) {
        if (signal?.aborted || !await canContinue()) return settleInterruptedCapture(userId, id);
        capture = await updateCapture(userId, id, current => current.status !== 'extracting' ? current : {
          ...current, extractionRepairAttempted: true, updatedAt: new Date().toISOString(),
        });
        if (capture.status !== 'extracting') return capture;
        const repaired = await requestExtraction(true);
        if (signal?.aborted || !await canContinue()) return settleInterruptedCapture(userId, id);
        extractionText = repaired.text;
        if (repaired.usage) {
          const earlier = extractionModelUsage;
          extractionModelUsage = { ...repaired.usage,
            ...Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens'].flatMap(key => {
              const sum = Number(earlier?.[key] || 0) + Number(repaired.usage?.[key] || 0);
              return sum > 0 ? [[key, sum]] : [];
            })),
          };
        }
        parseResult = parseRecallCaptureResult(extractionText, new Set(promptMessages.map(message => message.label)));
      }
      if (!parseResult) throw initialParseError;
      drafts = parseResult!.candidates.flatMap((candidate, index) => {
        // A model cannot choose an asset or action before the formation snapshot.
        if (candidate.proposalTarget !== 'ontology') {
          delete candidate.targetAssetId; delete candidate.comparison;
          candidate.suggestedAction = 'create'; candidate.actionProvided = true;
        }
        try { assertNotForbiddenToPersist([JSON.stringify(candidate)]); return [{ index, candidate }]; }
        catch (error) {
          if (String((error as Error).message).includes('forbidden to persist')) return [];
          throw error;
        }
      });
    }
    await assertCaptureFeedbackCurrent(userId, capture);
    const extractionCompletedAt = capture.extractionCompletedAt || new Date().toISOString();
    // Freeze parsed proposals before the support call. A later window resumes
    // these exact identities rather than paying for another extraction.
    if (previousPreparation?.assetBaselineDigest && !previousPreparation.formationNeedsRefresh
      && previousPreparation.assetBaselineDigest !== extractionAssetPool.baselineDigest)
      throw new CaptureFailure('formation_baseline_stale', 'asset baseline changed before resumed formation');
    const pendingPreparation: RecallCaptureFormationCheckpoint = previousPreparation ? {
      ...previousPreparation,
      assetBaselineDigest: previousPreparation.assetBaselineDigest ? extractionAssetPool.baselineDigest : undefined,
      formationNeedsRefresh: false,
    } : {
      version: 1, sourceDigest, summaryDigest: judgmentSummaryDigest, judgedAt: capture.valueJudgment!.judgedAt,
      completedAt: extractionCompletedAt, sourceScope, groups: [], parsedCount: parseResult!.candidates.length,
      emittedCount: parseResult!.emittedCount, ...(parseResult!.noCandidateReason ? { noCandidateReason: parseResult!.noCandidateReason } : {}),
      ...(extractionModelUsage ? { modelUsage: extractionModelUsage } : {}),
      pendingCandidates: structuredClone(drafts), sourceProposalVersion: 1, formationGeneration: 0, assetBaselineAttempt: capture.attempt,
      assetBaselineDigest: extractionAssetPool.baselineDigest, assetBaselineRefreshes: 0, formationNeedsRefresh: false,
    };
    capture = await updateCapture(userId, id, current => current.status !== 'extracting' || current.startedAt !== startedAt
      || previousPreparation && !sameFormationGeneration(current, previousPreparation)
      || !previousPreparation && !!current.formationCheckpoint ? current : {
      ...current, extractionCompletedAt, formationCheckpoint: pendingPreparation, updatedAt: extractionCompletedAt,
    });
    if (capture.status !== 'extracting' || capture.startedAt !== startedAt || !sameFormationGeneration(capture, pendingPreparation)) return capture;
    activeFormationToken = structuredClone(pendingPreparation);
    await assertFormationAssetBaselineCurrent(userId, sourceScope, pendingPreparation.assetBaselineDigest);
    // Local grounding is only a fast path. All actual ambiguities share one
    // source-complete assessment; never fan out model calls per candidate.
    const bySourceLabel = new Map(promptMessages.map(message => [message.label, message]));
    const approved = capture.valueJudgment?.evidence || [];
    const sourcesFor = (candidate: ParsedCandidate) => candidate.evidence.flatMap(label => {
      const message = bySourceLabel.get(label);
      if (message?.role !== 'user') return [];
      const approvedQuotes = approved.filter(ref => ref.messageId === message.id).map(ref => ref.quote);
      // Context can establish fields of the newly approved topic, not approve
      // a topic itself. An explicit empty list preserves that distinction in
      // the grounding and rule-source validators.
      return approvedQuotes.length || message.discovery === false
        ? [{ label, text: message.text, approvedQuotes }] : [];
    });
    const qualitySourcesFor = (candidate: ParsedCandidate) => candidate.evidence.map(label => bySourceLabel.get(label)!)
      .map(message => message.role !== 'user' ? message : { ...message,
        text: approved.filter(ref => ref.messageId === message.id).map(ref => ref.quote).join('\n') });
    const dependencies = analyzeFormationDependencies(drafts);
    const itemFailures = new Map<number, string>(dependencies.invalidIndexes.map(index => [index, 'assessment_invalid']));
    const overflowAssets = new Map<number, string[]>();
    const holdFailedDependencies = () => {
      for (const group of dependencies.groups) if (group.some(index => itemFailures.has(index))) {
        for (const index of group) if (!itemFailures.has(index)) itemFailures.set(index, 'dependency_unavailable');
      }
    };
    holdFailedDependencies();
    const ambiguity = drafts.flatMap(({ candidate, index }) => {
      if (itemFailures.has(index)) return [];
      const evidenceMessages = candidate.evidence.map(label => bySourceLabel.get(label)!);
      if (!sourcesFor(candidate).some(source => source.approvedQuotes.length)
        || isTaskLocalRuleProposal(candidate, evidenceMessages) || nonRetainableActivityContent(candidate.judgment)) return [];
      let comparisonValid = false;
      if (candidate.comparison) try {
        candidate.comparison = validateFormationComparison(candidate.comparison, extractionAssets, comparisonCoverage);
        comparisonValid = candidate.comparison.relation === 'new' ? !candidate.targetAssetId
          : candidate.comparison.relation !== 'ambiguous' && candidate.comparison.targetAssetId === candidate.targetAssetId;
      } catch { delete candidate.comparison; }
      if (!candidate.comparison && !comparisonCoverage.total && !comparisonCoverage.truncated && !comparisonCoverage.unavailable)
        candidate.comparison = { relation: 'new', reason: 'No existing readable active cognition in the source scope.', coverage: comparisonCoverage };
      const qualitySources = qualitySourcesFor(candidate);
      return assessRecallCaptureCandidateQuality(candidate, qualitySources).reviewable
        && (candidate.uncertainty || !isRecallCaptureCandidateGrounded(candidate, qualitySources)
          || hasFormationRuleChanges(candidate.ontologyChanges, ontologyDocument.records)
          || comparisonCoverage.truncated || comparisonCoverage.unavailable || ontologyContext.truncated && candidate.ontologyChanges
          || extractionAssets.length > 0 && !comparisonValid && candidate.proposalTarget !== 'ontology')
        ? [{ index, candidate, sources: sourcesFor(candidate),
          ...(pendingPreparation.sourceProposalVersion === 1 && candidate.proposalTarget !== 'ontology' ? { sourceProposal: true } : {}),
          ...(candidate.comparison ? { comparison: candidate.comparison } : {}) }] : [];
    });
    const assessed = new Map<number, FormationBatchCheckpoint['assessments'][number]>();
    let batchUnavailableReason: string | undefined;
    let formationAssets = extractionAssets;
    let formationMessages = promptMessages;
    if (ambiguity.length) {
      try {
        // Old-content observations are computed from the same admitted snapshot,
        // not from historical inspection runs or a second live asset read.
        const { collectInspectionFindings } = await import('./asset-inspection-service');
        const admitted = extractionAssetPool.entries.map(({ record, snapshot }) => ({ ...record, ...snapshot }));
        const initialIds = new Set(extractionAssets.map(asset => asset.id));
        const observations = collectInspectionFindings(admitted, new Date(), initialIds);
        const relatedIds = [...new Set(observations.flatMap(finding => finding.assetIds))];
        const requestedIds = [...new Set([...extractionAssets.map(asset => asset.id), ...relatedIds,
          ...ambiguity.flatMap(item => item.candidate.targetAssetId ? [item.candidate.targetAssetId] : [])])];
        const complete = comparisonCoverage.truncated || requestedIds.some(id => !initialIds.has(id))
          ? await selectCaptureExistingAssetsFromPool(userId, extractionAssetPool, { summary: capture.contextSummary, approvedEvidence: approved,
            sourceScope, maxAssets: 100, maxChars: 96_000, targetAssetIds: requestedIds })
          : { assets: extractionAssets, coverage: comparisonCoverage, baselineDigest: extractionAssetPool.baselineDigest };
        formationAssets = complete.assets;
        const formationIds = new Set(formationAssets.map(asset => asset.id));
        const relatedFindings = observations.filter(finding => finding.assetIds.every(id => formationIds.has(id)))
          .map(({ category, assetIds, detail }) => ({ category, assetIds, detail }));
        if (ontologyContext.truncated) ontologyContext = await buildSourceQualifiedOntologyFormationContext(userId, ontologyDocument, {
          scopeBound: true, projectId: conversation.project_id || undefined, workspaceId: conversation.space_id || undefined,
          queryText: ambiguity.map(item => item.candidate.judgment).join('\n'), maxChars: 96_000 });
        const sourceFeedback = promptMessages.flatMap(message => message.observations || []);
        const formationFeedback = pendingPreparation.assetBaselineDigest
          ? await captureFeedbackAtBaseline(userId, sourceFeedback, extractionAssetPool, sourceScope)
          : await readFeedbackVersionContext(userId, capture.conversationId, capture.feedbackObservations || []);
        formationMessages = pendingPreparation.assetBaselineDigest ? promptMessages.map(message => ({ ...message,
          ...(message.observations?.length ? { observations: formationFeedback.filter(item => item.messageId === message.id) } : {}) })) : promptMessages;
        const batch = await assessFormationBatch(userId, { sessionId: `memory-formation-recall-${capture.id}`,
          items: ambiguity, contextMessages: formationMessages, summary: capture.contextSummary?.topics,
          conversationId: capture.conversationId, contextSummary: capture.contextSummary,
          existing: complete, relatedFindings, ontology: ontologyContext, feedback: formationFeedback,
          modelCandidates, budget: { jobId: capture.id, stage: 'grounding' }, signal,
          shouldContinue: () => canContinue(), checkpoint: capture.formationBatchAssessment });
        await assertFormationAssetBaselineCurrent(userId, sourceScope, pendingPreparation.assetBaselineDigest);
        for (const row of batch.assessments) assessed.set(row.index, row);
        for (const failure of batch.itemFailures || []) {
          itemFailures.set(failure.index, failure.reason);
          if (failure.relatedAssetIds?.length) overflowAssets.set(failure.index, failure.relatedAssetIds);
        }
        capture = await updateCapture(userId, id, current => current.status !== 'extracting' || current.startedAt !== startedAt
          || !sameFormationGeneration(current, pendingPreparation) ? current : {
          ...current, formationBatchAssessment: batch, updatedAt: new Date().toISOString() });
        if (capture.status !== 'extracting' || capture.startedAt !== startedAt || !sameFormationGeneration(capture, pendingPreparation)) return capture;
      } catch (error) {
        if (signal?.aborted || (error as { code?: string }).code === 'ABORT_ERR'
          || error instanceof CaptureFailure && error.code === 'formation_baseline_stale') throw error;
        batchUnavailableReason = error instanceof FormationBatchUnavailableError ? error.reason : 'assessment_invalid';
      }
    }
    if (batchUnavailableReason) for (const item of ambiguity) itemFailures.set(item.index, batchUnavailableReason);
    // Source proposals gain asset identities only after assessment. Two writes
    // to the same target cannot be promoted as independent complete revisions.
    if (pendingPreparation.sourceProposalVersion === 1) {
      const targetWriters = new Map<string, number[]>();
      for (const [index, row] of assessed) {
        const comparison = row.comparison;
        if (!comparison?.targetAssetId || !['evidence', 'exception', 'correction', 'changed'].includes(comparison.relation)) continue;
        targetWriters.set(comparison.targetAssetId, [...(targetWriters.get(comparison.targetAssetId) || []), index]);
      }
      for (const indexes of targetWriters.values()) if (indexes.length > 1)
        for (const index of indexes) itemFailures.set(index, 'dependency_unavailable');
    }
    holdFailedDependencies();
    for (const index of itemFailures.keys()) assessed.delete(index);
    // A late model result, including an unavailable verdict, cannot settle a
    // scheduled capture after admission closes or overwrite cancellation.
    if (signal?.aborted || !await canContinue()) return settleInterruptedCapture(userId, id);
    capture = await readRecallCapture(userId, id);
    if (capture.status !== 'extracting' || capture.startedAt !== startedAt || !sameFormationGeneration(capture, pendingPreparation)) return capture;
    // Replaying candidate persistence must retain the proof already attached to
    // a saved group. A rebuilt summary/value decision clears this checkpoint.
    const extractionIdentity = createHash('sha256').update(JSON.stringify({ sourceDigest,
      summaryDigest: judgmentSummaryDigest, judgedAt: capture.valueJudgment!.judgedAt })).digest('hex').slice(0, 20);
    capture = await updateCapture(userId, id, current => current.status !== 'extracting' || current.startedAt !== startedAt
      || !sameFormationGeneration(current, pendingPreparation) ? current : {
      ...current, extractionCompletedAt, stage: 'candidate_save', updatedAt: extractionCompletedAt,
    });
    if (capture.status !== 'extracting') return capture;
    // 自动来源只能形成候选；旧 autoWrite/auto 配置不构成逐条确认授权。
    const byLabel = new Map(promptMessages.map((message) => [message.label, message]));
    const prepared: RecallCaptureFormationCheckpoint['groups'] = [...pendingPreparation.groups];
    const supportUnavailable: NonNullable<RecallCaptureRecord['candidateSupportUnavailable']> = [];
    const uncertaintyAssessments: NonNullable<RecallCaptureRecord['uncertaintyAssessments']> = (capture.uncertaintyAssessments || []).filter(row => !drafts.some(item => item.index === row.candidateIndex));
    const recordSupportUnavailable = async (candidateIndex: number, candidate: ParsedCandidate,
      stage: 'grounding' | 'uncertainty', reason: string) => {
      supportUnavailable.push({ candidateIndex, stage, reason,
        ...(overflowAssets.has(candidateIndex) ? { relatedAssetIds: overflowAssets.get(candidateIndex)! } : {}),
        candidateHash: createHash('sha256').update(JSON.stringify(candidate)).digest('hex') });
      capture = await updateCapture(userId, id, current => current.status !== 'extracting' || current.startedAt !== startedAt
        || !sameFormationGeneration(current, pendingPreparation) ? current : {
        ...current, candidateSupportUnavailable: [...supportUnavailable], candidateSupportUnavailableCount: supportUnavailable.length,
        updatedAt: new Date().toISOString(),
      });
    };
    for (const { index, candidate } of drafts) {
      const itemUnavailableReason = itemFailures.get(index);
      const evidenceMessages = candidate.evidence.map((label) => byLabel.get(label)!);
      if (capture.executionPolicy !== 'manual' && (isTaskLocalRuleProposal(candidate, evidenceMessages) || nonRetainableActivityContent(candidate.judgment))) {
        log.info('recall capture omitted task-local rule', { captureId: capture.id, candidateIndex: index });
        continue;
      }
      const judgedEvidence = capture.valueJudgment?.evidence || [];
      if (!evidenceMessages.some(message => message.role === 'user'
        && judgedEvidence.some(evidence => evidence.messageId === message.id && message.text.includes(evidence.quote)))) {
        continue;
      }
      const qualityEvidence = evidenceMessages.map(message => {
        if (message.role !== 'user') return message;
        const quotes = judgedEvidence.filter(evidence => evidence.messageId === message.id).map(evidence => evidence.quote);
        return { ...message, text: quotes.join('\n') };
      });
      const assessment = assessed.get(index);
      const needsAssessment = ambiguity.some(item => item.index === index) || !!itemUnavailableReason;
      if (itemUnavailableReason === 'related_assets_overflow') {
        await recordSupportUnavailable(index, candidate, 'grounding', itemUnavailableReason);
        continue;
      }
      const supported = Boolean(assessment && Object.entries(assessment.checks).filter(([key]) => key !== 'evidence').every(([, value]) => value === true));
      // A source-supported body with unresolved R metadata is a human review,
      // not a technical retry or a silent rejection. Unsupported bodies still
      // fail the existing grounding gate; this never certifies the R contract.
      const ruleSemanticsHeld = !supported && !!assessment?.sourceRuleConclusions?.length
        && !!assessment.sourceChecks && Object.entries(assessment.sourceChecks)
          .filter(([key]) => key !== 'evidence').every(([, value]) => value === true);
      let uncertaintyAssessment: CaptureUncertaintyAssessment | undefined;
      if (candidate.uncertainty && needsAssessment) {
        const target = formationAssets.find(asset => asset.id === (assessment?.comparison?.targetAssetId || candidate.targetAssetId));
        const unavailableReason: CaptureUncertaintyAssessment['reason'] = itemUnavailableReason === 'context_too_large'
          ? 'uncertainty_context_too_large' : itemUnavailableReason === 'source_unavailable'
            ? 'uncertainty_context_unavailable' : ['assessment_invalid', 'dependency_unavailable'].includes(itemUnavailableReason || '')
              ? 'uncertainty_assessment_invalid' : 'uncertainty_model_unavailable';
        uncertaintyAssessment = observeCaptureBatchUncertainty({ candidate, sources: sourcesFor(candidate), contextMessages: formationMessages,
          summary: capture.contextSummary?.topics, ...(target ? { existingTarget: target } : {}) }, ruleSemanticsHeld ? { ...assessment!, checks: assessment!.sourceChecks! } : assessment, unavailableReason);
        uncertaintyAssessments.push({ ...uncertaintyAssessment, candidateIndex: index });
        capture = await updateCapture(userId, id, current => current.status !== 'extracting' || current.startedAt !== startedAt
          || !sameFormationGeneration(current, pendingPreparation) ? current : {
          ...current, uncertaintyAssessments: [...uncertaintyAssessments], updatedAt: new Date().toISOString(),
        });
        if (capture.status !== 'extracting') return capture;
        if (!uncertaintyAssessment.modelCompleted) {
          await recordSupportUnavailable(index, candidate, 'uncertainty', uncertaintyAssessment.reason || 'uncertainty_assessment_invalid');
          continue;
        }
        if (!uncertaintyAssessment.nonBlocking) continue;
      } else if (itemUnavailableReason) {
        await recordSupportUnavailable(index, candidate, 'grounding', itemUnavailableReason);
        continue;
      }
      if (assessment?.comparison) candidate.comparison = assessment.comparison;
      if (pendingPreparation.sourceProposalVersion === 1 && candidate.proposalTarget !== 'ontology' && assessment?.comparison) {
        const compared = assessment.comparison;
        if (['evidence', 'exception', 'correction', 'changed'].includes(compared.relation)) {
          candidate.targetAssetId = compared.targetAssetId;
          candidate.suggestedAction = 'update';
        } else {
          delete candidate.targetAssetId;
          candidate.suggestedAction = 'create';
        }
        candidate.actionProvided = true;
      }
      if (supported && assessment?.revision) {
        candidate.judgment = assessment.revision.judgment;
        if (assessment.revision.applicableWhen !== undefined) candidate.applicableWhen = assessment.revision.applicableWhen;
        if (assessment.revision.forbiddenWhen !== undefined) candidate.forbiddenWhen = assessment.revision.forbiddenWhen;
      }
      if (supported && assessment?.ruleRevisions) candidate.ontologyChanges = reviseFormationRuleSemantics(
        candidate.ontologyChanges, assessment.ruleRevisions, Object.values(ontologyDocument.records));
      const deltaSupported = Boolean(assessment && assessment.checks.supported && assessment.checks.noUnsupportedClaims
        && assessment.checks.scopePreserved && assessment.checks.finalDecisionPreserved);
      if (uncertaintyAssessment?.nonBlocking) delete candidate.uncertainty;
      if (ruleSemanticsHeld) {
        const reasons = assessment!.sourceRuleConclusions!.flatMap(row => row.status !== 'resolved' ? [row.reason] : []);
        candidate.uncertainty = `规则强度、条件、例外或引用尚未得到来源支持，请人工核对后保存。${reasons.join('；')}`.slice(0, 1000);
      }
      const comparisonHeld = assessment && !assessment.checks.priorContentPreserved
        || candidate.comparison?.relation === 'ambiguous'
        || candidate.comparison && !['new', 'duplicate'].includes(candidate.comparison.relation)
          && (candidate.targetAssetId !== candidate.comparison.targetAssetId || !['update', 'limit_scope', 'pause', 'keep_current'].includes(candidate.suggestedAction || ''))
        || needsAssessment && (!assessment || assessment.uncertaintyDisposition === 'content_unresolved');
      if (comparisonHeld) candidate.uncertainty ||= '形成比较尚未消除对象、范围或来源歧义，需要人工核对。';
      // No-change repetitions should not repeatedly become attention items.
      if ((candidate.comparison?.relation === 'duplicate' || candidate.suggestedAction === 'keep_current') && !candidate.ontologyChanges) continue;
      const quality = assessRecallCaptureCandidateQuality(candidate, qualityEvidence);
      // New cognition follows one quality contract. Historical type validation
      // remains read-compatible; it no longer asks the model to choose a class.
      const classification = assessRecallCandidateClassification(candidate);
      if (!classification.ok) {
        log.info('recall capture candidate misclassified', {
          captureId: capture.id,
          suggestedType: candidate.suggestedType,
          ...(candidate.contentCategory !== undefined ? { contentCategory: candidate.contentCategory } : {}),
          reasons: classification.blockingReasons,
        });
      }
      // Automatic output rejected by evidence/value gates must not accumulate as weak observations.
      const grounded = assessment ? supported || deltaSupported || ruleSemanticsHeld : !comparisonHeld && isRecallCaptureCandidateGrounded(candidate, qualityEvidence);
      if (!quality.reviewable || !classification.ok || !grounded) {
        log.info('capture candidate filtered before persistence', { captureId: capture.id,
          classification: classification.blockingReasons, quality: quality.reasons,
          grounding: quality.automaticIneligibilityReasons, grounded });
        continue;
      }
      if (signal?.aborted || !await canContinue()) return settleInterruptedCapture(userId, id);
      const artifactRefs = evidenceMessages.flatMap((message) => message.artifacts.map((artifact) => ({
        kind: 'artifact_file' as const,
        subtype: 'artifact' as const,
        scope: 'conversation' as const,
        id: cognitionArtifactSourceId(artifact.conversationId || capture.conversationId, artifact.id),
        title: artifact.title,
      })));
      // 空间归属：捕获的会话属于哪个空间 → 候选带 spaceId（资产随 recall 全局，
      // 空间资产 tab 按 spaceId 过滤显示；空间可读全局资产但显示只显示本空间的）。
      const captureSpaceId = typeof (conversation as any)?.space_id === 'string'
        ? (conversation as any).space_id : undefined;
      const sourceScopePolicy = {
        ...(captureSpaceId ? { workspaceIds: [captureSpaceId] } : {}),
        ...(conversation.project_id ? { projectIds: [conversation.project_id] } : {}),
      };
      let ontologyFormation: ReturnType<typeof parseOntologyFormationProposal>;
      try {
        ontologyFormation = parseOntologyFormationProposal(ontologyDocument, `proposal-${capture.id}-${index}`,
          candidate.ontologyChanges, candidate.judgment, extractionCompletedAt, candidate.proposalTarget === 'ontology' ? 'ontology' : 'cognition');
        ontologyFormation = validateOntologyFormationScope(userId, ontologyDocument, ontologyFormation,
          Object.keys(sourceScopePolicy).length ? sourceScopePolicy : undefined);
      } catch (error) {
        if (error instanceof Error && error.message.includes('forbidden to persist')) {
          log.warn('capture ontology candidate omitted (sensitive)', { captureId: capture.id, candidateIndex: index });
          continue;
        }
        throw new CaptureFailure('candidate_save_failed', 'ontology proposal could not be prepared');
      }
      if (ontologyFormation) {
        if (ruleSemanticsHeld) ontologyFormation.blockedReasons.push('rule_source_assessment_required');
        const approvedLabels = new Set(evidenceMessages.filter(message => message.role === 'user'
          && judgedEvidence.some(evidence => evidence.messageId === message.id && message.text.includes(evidence.quote))).map(message => message.label));
        if (!ontologyFormation.evidence.length || ontologyFormation.evidence.some(label => !approvedLabels.has(label))) {
          ontologyFormation.blockedReasons.push('ontology_evidence_unapproved');
        }
        if (ontologyContext.truncated) ontologyFormation.blockedReasons.push('ontology_comparison_incomplete');
        const comparedIds = new Set(ontologyContext.records.map(record => record.id));
        if (ontologyFormation.actions.some(action => action.intent !== 'create' && !comparedIds.has(action.recordId)))
          ontologyFormation.blockedReasons.push('ontology_target_not_compared');
      }
      if (candidate.proposalTarget === 'ontology' && !ontologyFormation?.actions.length && !ontologyFormation?.blockedReasons.length) continue;
      try {
        const preparedInput: SaveRecallCandidateInput = {
          rawStatement: true,
          judgment: candidate.judgment,
          value: candidate.value,
          summary: candidate.summary,
          ...(candidate.proposalTarget ? { proposalTarget: candidate.proposalTarget, formationProposalId: candidate.formationProposalId } : {}),
          ...(ontologyFormation ? { ontologyFormation } : {}),
          ...(candidate.uncertainty ? { uncertainty: candidate.uncertainty } : {}),
          ...(candidate.comparison ? { formationComparison: candidate.comparison } : {}),
          suggestedType: candidate.suggestedType,
          ...(candidate.contentCategory !== undefined ? { contentCategory: candidate.contentCategory } : {}),
          suggestedScope: candidate.suggestedScope,
          ...(candidate.suggestedAction ? { suggestedAction: candidate.suggestedAction } : {}),
          ...(candidate.risk ? { risk: candidate.risk } : {}),
          ...(candidate.targetAssetId ? { targetAssetId: candidate.targetAssetId,
            targetVersionUsed: candidate.comparison?.targetAssetId === candidate.targetAssetId ? candidate.comparison.targetVersion
              : formationAssets.find(asset => asset.id === candidate.targetAssetId)?.version } : {}),
          ...(Object.keys(sourceScopePolicy).length ? { scopePolicy: sourceScopePolicy } : {}),
          ...(candidate.applicableWhen ? { applicableWhen: candidate.applicableWhen } : {}),
          ...(candidate.forbiddenWhen ? { forbiddenWhen: candidate.forbiddenWhen } : {}),
          captureKey: `capture-${capture.id}-${extractionIdentity}-${candidate.formationProposalId ? `v2-${candidate.formationProposalId}` : `legacy-${index}`}`,
          ...(captureSpaceId ? { spaceId: captureSpaceId } : {}),
          taskRunId: capture.terminalRunId,
          captureProvenance: { pipeline: 'nightly_conversation', captureId: capture.id, messageIds: capture.messageIds,
            valueJudgment: { ...capture.valueJudgment!, eligible: true }, extractionCompletedAt },
          sourceRefs: [
            { kind: 'conversation', subtype: 'session', scope: 'conversation', id: capture.conversationId, title: conversation.title },
            ...evidenceMessages.map((message) => ({
              ...cognitionMessageSourceRef(capture.conversationId, message),
              excerpt: capture.valueJudgment?.evidence.find(evidence => evidence.messageId === message.id)?.quote
                || message.text.slice(0, 1_000),
            })),
            ...artifactRefs,
            ...feedbackSourceRefs,
          ],
        };
        assertSafeCaptureSummary(preparedInput);
        const ruleSourceAssessment = preparedRuleSourceAssessment(userId, preparedInput, capture, index, ontologyDocument);
        prepared.push({ index, input: preparedInput, ...(ruleSourceAssessment ? { ruleSourceAssessment } : {}) });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        // 凭据等 L3 敏感内容由 saveRecallCandidate 拦截，且不得落盘。
        // 仅丢弃当前敏感候选，其他候选仍可保存，并记录稳定原因码。
        if (messageText.includes('forbidden to persist')) {
          log.warn('recall capture candidate dropped (sensitive)', {
            capture_id: capture.id,
            candidate_index: index,
            error: messageText,
          });
          continue;
        }
        // 其他保存错误记录脱敏诊断信息，保留可定位的失败原因。
        log.warn('recall capture candidate save threw', {
          capture_id: capture.id,
          candidate_index: index,
          suggested_type: candidate.suggestedType,
          error: messageText,
        });
        throw new CaptureFailure('candidate_save_failed', 'candidate could not be saved');
      }
    }

    const pendingIndexes = new Set(supportUnavailable.map(row => row.candidateIndex));
    const checkpoint: RecallCaptureFormationCheckpoint = { ...pendingPreparation, groups: prepared,
      pendingCandidates: pendingPreparation.sourceProposalVersion === 1
        ? pendingPreparation.pendingCandidates : pendingPreparation.pendingCandidates?.filter(item => pendingIndexes.has(item.index)) || [],
      ...(pendingPreparation.sourceProposalVersion === 1 ? { supportPendingIndexes: [...pendingIndexes] } : {}),
    };
    capture = await updateCapture(userId, id, current => current.status !== 'extracting' || current.startedAt !== startedAt
      || !sameFormationGeneration(current, pendingPreparation) ? current : {
      ...current, formationCheckpoint: checkpoint,
      candidateSupportUnavailable: supportUnavailable.length ? supportUnavailable : undefined, candidateSupportUnavailableCount: supportUnavailable.length || undefined,
      // A completed row with an unusable uncertainty observation must not be
      // replayed indefinitely when its group is retried in a later window.
      formationBatchAssessment: current.formationBatchAssessment?.assessments.some(row => !pendingIndexes.has(row.index)) ? { ...current.formationBatchAssessment,
        assessments: current.formationBatchAssessment.assessments.filter(row => !pendingIndexes.has(row.index)) } : undefined,
      updatedAt: new Date().toISOString(),
    });
    if (capture.status !== 'extracting' || capture.startedAt !== startedAt || !sameFormationGeneration(capture, checkpoint)) return capture;
    return await persistPreparedCapture(userId, capture, checkpoint, canContinue, signal);
  } catch (error) {
    if (signal?.aborted || (error as { code?: string })?.code === 'ABORT_ERR') return settleInterruptedCapture(userId, id);
    if (error instanceof CaptureFailure && error.code === 'formation_baseline_stale') {
      const latest = await readRecallCapture(userId, id);
      if (!activeFormationToken || latest.startedAt !== startedAt || !sameFormationGeneration(latest, activeFormationToken)) return latest;
      const checkpoint = latest.formationCheckpoint ? structuredClone(latest.formationCheckpoint) : undefined;
      if (checkpoint?.assetBaselineDigest) {
        try { await withCognitionTransition(userId, () => recoverPreparedCaptureReceipts(userId, checkpoint)); }
        catch {
          const finishedAt = new Date().toISOString();
          return updateCapture(userId, id, current => current.status !== 'extracting' && current.status !== 'writing'
            || current.startedAt !== startedAt || !sameFormationGeneration(current, activeFormationToken!) ? current : {
            ...current, status: 'failed', visibility: 'internal', stage: undefined,
            errorCode: 'candidate_save_failed', reasonCode: undefined, finishedAt,
            durationMs: durationSince(current.startedAt, finishedAt), updatedAt: finishedAt,
          });
        }
      }
      if (checkpoint?.assetBaselineDigest && (checkpoint.assetBaselineRefreshes || 0) < 1) {
        const drafts = structuredClone(checkpoint.formationDrafts || checkpoint.pendingCandidates || []);
        const savedGroups = checkpoint.groups.filter(group => group.savedCandidateId);
        const savedCandidateIds = savedGroups.flatMap(group => group.savedCandidateId ? [group.savedCandidateId] : []);
        const queued = await updateCapture(userId, id, current => current.status !== 'extracting' && current.status !== 'writing'
          || current.startedAt !== startedAt || !sameFormationGeneration(current, activeFormationToken!) ? current : {
          ...current,
          status: 'queued', stage: undefined, errorCode: undefined, reasonCode: undefined,
          finishedAt: undefined, durationMs: undefined, reviewSnapshot: undefined,
          candidateIds: savedCandidateIds,
          formationCheckpoint: { ...checkpoint, groups: savedGroups,
            pendingCandidates: drafts.filter(item => !savedGroups.some(group => group.index === item.index)),
            formationGeneration: (checkpoint.formationGeneration || 0) + 1,
            assetBaselineRefreshes: 1, formationNeedsRefresh: true, supportPendingIndexes: undefined },
          formationBatchAssessment: undefined, uncertaintyAssessments: undefined,
          candidateSupportUnavailable: undefined, candidateSupportUnavailableCount: undefined,
          updatedAt: new Date().toISOString(),
        });
        if (queued.status === 'queued' && queued.formationCheckpoint?.formationGeneration === (checkpoint.formationGeneration || 0) + 1) {
          log.info('recall capture formation baseline refreshed', { captureId: id });
          return runRecallCapture(userId, id, signal);
        }
        return queued;
      }
    }
    const currentAtFailure = await readRecallCapture(userId, id);
    if (currentAtFailure.startedAt !== startedAt || activeFormationToken && !sameFormationGeneration(currentAtFailure, activeFormationToken)) return currentAtFailure;
    const code = error instanceof CaptureFailure ? error.code
      : (error as { code?: string }).code === 'capture_model_not_configured' ? 'model_not_configured' : 'capture_failed';
    const reasonCode = error instanceof CaptureFailure ? error.reasonCode : undefined;
    const status: RecallCaptureStatus = code === 'model_not_configured' || code === 'model_auth_required'
      ? 'configuration_required'
      : 'failed';
    log.warn('recall capture extraction failed', {
      capture_id: capture.id,
      conversation_id: capture.conversationId,
      error_code: code,
      // Fixed validator phrase or host failure token; never user/model text.
      ...(reasonCode ? { reason_code: reasonCode } : {}),
    });
    const finishedAt = new Date().toISOString();
    void bumpRecallCaptureStats(userId, {
      failures: { [code]: 1 },
    }).catch(() => {
      // 统计失败不影响失败结算主流程。
    });
    return updateCapture(userId, id, (current) => (current.status !== 'extracting' && current.status !== 'writing') || current.startedAt !== startedAt
      || activeFormationToken && !sameFormationGeneration(current, activeFormationToken)
      ? current
      : {
          ...current,
          status,
          visibility: 'internal',
          errorCode: code,
          // Shorthand keeps a stale sub-reason from surviving a later failure.
          reasonCode,
          finishedAt,
          durationMs: durationSince(current.startedAt, finishedAt),
          updatedAt: finishedAt,
        });
  }
}

const scheduledCaptures = new Map<string, ScheduledBootBackgroundTask>();
const captureScheduleAdmissions = new Set<string>();
let captureSchedulingEnabled = true;

async function nightlyCaptureCanStart(userId: string, allowOutsideWindow = false): Promise<boolean> {
  const settings = await readRecallCaptureSettings(userId);
  const run = sweepControls.get(userId);
  if (run?.controller.signal.aborted) return false;
  if (!run && (await readNightlySweepRecord(userId))?.heldWindow === captureBudgetWindowKey(new Date(), settings.nightlyStart)) return false;
  if (await isCaptureModelFailureHeld(userId)) return false;
  // A running sweep owns its admission window even if the user edits the next one.
  const start = run?.nightlyStart ?? settings.nightlyStart;
  const end = run?.nightlyEnd ?? settings.nightlyEnd;
  return settings.enabled && settings.executionPolicy === 'nightly'
    && (allowOutsideWindow || run?.manual || isWithinNightlyWindow(new Date(), start, end));
}

async function scheduleKnownRecallCapture(userId: string, capture: RecallCaptureRecord): Promise<void> {
  const reviewReady = capture.status === 'review_ready' && Boolean(capture.autoApprovalEpoch);
  const schedulable = (capture.status === 'queued' || reviewReady) && capture.executionPolicy === 'nightly' && Boolean(capture.reviewDay);
  // Captures admitted by a manual run keep processing outside the window;
  // scheduled admissions stay night-only.
  const manualAdmitted = isManuallyAdmittedCapture(capture);
  if (!captureSchedulingEnabled || !schedulable || !await nightlyCaptureCanStart(userId, manualAdmitted)) return;
  const key = captureTaskKey(userId, capture.id);
  // Recheck after the settings read so concurrent admissions share one task.
  if (!captureSchedulingEnabled || sweepControls.get(userId)?.controller.signal.aborted) return;
  if (scheduledCaptures.has(key)) {
    const existing = scheduledCaptures.get(key)!;
    const run = sweepControls.get(userId);
    run?.tasks.add(existing); run?.captureTasks.set(capture.id, existing); return;
  }
  let execution: Promise<void> | undefined;
  const task = scheduleBootBackground(`recall:capture:${capture.id}`, signal => {
    execution = (reviewReady ? automaticallyReviewCompletedCapture(userId, capture, signal)
      : runRecallCapture(userId, capture.id, signal)).then(() => undefined);
    return execution;
  }, 0, { resourceClass: 'model', preferIdle: !manualAdmitted });
  // The scheduler cancellation promise may settle before the model unwinds.
  // Keep the scan running until both admission and actual execution settle.
  const tracked = { cancel: () => task.cancel(), promise: task.promise.then(async () => { await execution; }) };
  scheduledCaptures.set(key, tracked);
  const owner = sweepControls.get(userId);
  owner?.tasks.add(tracked);
  owner?.captureTasks.set(capture.id, tracked);
  void tracked.promise.finally(() => owner?.tasks.delete(tracked)).catch(() => {});
  void tracked.promise.finally(() => {
    if (scheduledCaptures.get(key) === tracked) scheduledCaptures.delete(key);
    // No immediate self-renewal: a task deferred at the window boundary remains
    // queued until a later nightly sweep, without a daytime rescheduling loop.
  }).catch(() => {});
}

export function scheduleRecallCapture(userId: string, id: string): void {
  if (!captureSchedulingEnabled) return;
  const key = captureTaskKey(userId, id);
  if (scheduledCaptures.has(key) || captureScheduleAdmissions.has(key)) return;
  captureScheduleAdmissions.add(key);
  void readRecallCapture(userId, id)
    .then((capture) => scheduleKnownRecallCapture(userId, capture))
    .catch(() => {
      // A removed or malformed capture cannot be scheduled.
    })
    .finally(() => captureScheduleAdmissions.delete(key));
}

export async function promoteRecallCaptureCandidate(
  userId: string,
  candidateId: string,
  options: { riskAcknowledged?: boolean; profileTarget?: PersonalProfileTarget; forceCreateSimilar?: boolean; confirmBaselineVersion?: string } = {},
): Promise<RecallCaptureCandidatePromotion | RecallOntologyCandidateConfirmation> {
  if (!safeId(candidateId)) throw new Error('invalid recall candidate id');
  const similarRetry = options.forceCreateSimilar === true ? { forceCreateSimilar: true } : {};
  // 版本冲突后的显式重锚：本层只是
  // 把调用方声明的基线转发下去，不做任何版本判定——判定在
  // `updateAbilityAsset` 的锁内（唯一一处）。
  const rebase = options.confirmBaselineVersion ? { confirmBaselineVersion: options.confirmBaselineVersion } : {};
  const confirm = async () => {
    const candidate = await readRecallCandidate(userId, candidateId);
    return candidate.proposalTarget === 'ontology'
      ? confirmRecallOntologyCandidate(userId, candidateId, { riskAcknowledged: options.riskAcknowledged })
      : promoteRecallCandidate(userId, candidateId, { actor: 'user', riskAcknowledged: options.riskAcknowledged,
        ...similarRetry, ...rebase, ...(options.profileTarget ? { profileTarget: options.profileTarget } : {}) });
  };
  const capture = (await listAllRecallCaptures(userId)).find((item) => item.candidateIds.includes(candidateId));
  if (!capture) {
    // Only committed-asset recovery can succeed without a live formation record.
    // The canonical promotion gate rejects any first publication of old input.
    const promoted = await confirm();
    return promoted;
  }

  await updateCapture(userId, capture.id, (current) => {
    if (!current.candidateIds.includes(candidateId)) throw new Error('candidate does not belong to recall capture');
    if (current.status === 'writing') throw recallCandidateError('recall_capture_writing', 'recall capture is already writing');
    if (current.status !== 'review_ready') {
      throw recallCandidateError('recall_capture_not_review_ready', 'recall capture is not ready for review');
    }
    return {
      ...current,
      status: 'writing',
      stage: 'asset_write',
      writingCandidateId: candidateId,
      errorCode: undefined,
      reasonCode: undefined,
      updatedAt: new Date().toISOString(),
    };
  });

  try {
    const promoted = await confirm();
    await updateCapture(userId, capture.id, (current) => (
      current.status === 'writing' && current.writingCandidateId === candidateId
        ? {
            ...current,
            status: 'review_ready',
            stage: undefined,
            writingCandidateId: undefined,
            errorCode: undefined,
            reasonCode: undefined,
            updatedAt: new Date().toISOString(),
          }
        : current
    ));
    return promoted;
  } catch (error) {
    await updateCapture(userId, capture.id, (current) => (
      current.status === 'writing' && current.writingCandidateId === candidateId
        ? {
            ...current,
            status: 'review_ready',
            stage: undefined,
            writingCandidateId: undefined,
            errorCode: 'asset_write_failed',
            reasonCode: undefined,
            updatedAt: new Date().toISOString(),
          }
        : current
    ));
    throw error;
  }
}

/** Resume only proposals from the same still-enabled grant. Policy rejection
 * keeps them in individual review and never becomes a background failure task. */
async function automaticallyReviewCompletedCapture(userId: string, capture: RecallCaptureRecord, signal?: AbortSignal, recoverOnly = false): Promise<RecallCaptureRecord> {
  if (capture.status !== 'review_ready' || !capture.autoApprovalEpoch) return capture;
  const { tryAutomaticallyApproveRecallCandidate } = await import('./nightly-automatic-approval');
  for (const candidateId of capture.candidateIds) {
    if (signal?.aborted) return readRecallCapture(userId, capture.id);
    try { await tryAutomaticallyApproveRecallCandidate(userId, candidateId, { signal, recoverOnly }); }
    catch {
      if (signal?.aborted) return readRecallCapture(userId, capture.id);
      log.warn('automatic cognition confirmation held; proposal retained for review');
    }
  }
  const current = await readRecallCapture(userId, capture.id);
  const [workflow] = await summarizeRecallCaptures(userId, [current]);
  if (current.status === 'review_ready' && workflow.workflowStatus === 'completed') {
    return updateCapture(userId, capture.id, latest => latest.status !== 'review_ready' ? latest : {
      ...latest, status: 'completed', reviewSnapshot: workflow.reviewSummary, updatedAt: new Date().toISOString(),
    });
  }
  return current;
}

export async function recoverRecallCaptures(userId: string): Promise<number> {
  const captures = await listAllRecallCaptures(userId);
  let recovered = 0;
  for (const item of captures) {
    if (item.executionPolicy !== 'nightly' || !item.reviewDay) continue;
    const key = captureTaskKey(userId, item.id);
    if (scheduledCaptures.has(key)) continue;
    let capture = item;
    if (capture.status === 'extracting') {
      const recoveredAt = new Date().toISOString();
      capture = await updateCapture(userId, capture.id, current => current.status !== 'extracting' || scheduledCaptures.has(key)
        ? current : {
          ...current, status: 'queued', stage: undefined, errorCode: undefined, reasonCode: undefined,
          recoveredAt, updatedAt: recoveredAt,
        });
    }
    // Recovery fixes orphaned state even outside the window. Model admission
    // remains owned by the existing window, settings and cancellation gates.
    if (scheduledCaptures.has(key)) continue;
    const canRunNightly = await nightlyCaptureCanStart(userId, isManuallyAdmittedCapture(capture));
    if (capture.status === 'review_ready' && capture.autoApprovalEpoch) {
      // Boot recovery repairs committed results. Fresh approval belongs to a
      // sweep-owned model task, so Stop has a cancellation owner.
      capture = await automaticallyReviewCompletedCapture(userId, capture, undefined, true);
    }
    if (capture.status === 'writing') {
      const recoveredAt = new Date().toISOString();
      capture = await updateCapture(userId, capture.id, (current) => current.status !== 'writing' || scheduledCaptures.has(key) ? current : ({
        ...current,
        status: current.autoWrite ? 'failed' : 'review_ready',
        stage: undefined,
        writingCandidateId: undefined,
        errorCode: 'asset_write_interrupted',
        reasonCode: undefined,
        recoveredAt,
        updatedAt: recoveredAt,
      }));
    }
    const schedulable = canRunNightly && capture.status === 'queued';
    if (schedulable) {
      await scheduleKnownRecallCapture(userId, capture);
      recovered += 1;
    }
  }
  return recovered;
}

// ── 夜间增量清扫──────────────────────────────────────────────────────
// Sole automatic producer: the previous complete local day, frozen at window
// start. Missed windows have no daytime catch-up. Persisted ranges may retry
// on subsequent nights without re-admitting or scanning old conversation days.
const SWEEP_COLLECTION = 'capture-sweep';
const NIGHTLY_SWEEP_ID = 'nightly';
const NIGHTLY_SWEEP_TICK_MS = 15 * 60_000;
const NIGHTLY_AUTO_RETRY_ATTEMPT_LIMIT = 3;

export type RecallNightlySweepCursorState = 'covered' | 'ignored' | 'failed' | 'deferred';

export interface RecallNightlySweepCursor {
  state: RecallNightlySweepCursorState;
  throughMessageId?: string;
  throughTs?: string;
  errorCode?: string;
  updatedAt: string;
}

export interface RecallNightlyClaim {
  captureId: string;
  candidateId: string;
  at: string;
}

/** Targets a suggestion already changes this run. Stock organization and the
 * cross-asset inspection must not produce a second suggestion for them. */
export interface RecallNightlyClaims {
  assets: Record<string, RecallNightlyClaim>;
  heldAssets?: Record<string, { captureIds: string[]; at: string }>;
  ontology: Record<string, RecallNightlyClaim>;
}

export interface RecallNightlyDiscoveryProgress {
  ranges: number;
  queued: number;
  skipped: number;
  deferred: number;
  failed: number;
}

export interface RecallNightlyInspectionProgress {
  coverage?: { total: number; evaluated: number; remaining: number; unavailable?: number };
  evaluatedAssetIds?: string[];
  coveredAssetIds?: string[];
  pendingAssetIds?: string[];
  unavailableAssetIds?: string[];
  scanned: number;
  findings: number;
  duplicate: number;
  outdated: number;
  conflict: number;
  skippedClaimed: number;
  error?: string;
}

export interface RecallNightlyReconcileProgress {
  superseded: number;
  related: number;
  error?: 'reconcile_failed';
}

export interface RecallNightlyWindowSnapshot {
  start: string;
  end: string;
  nightlyStart: string;
  nightlyEnd: string;
  reviewDay: string;
  ranForWindow: string;
}

export type RecallNightlySweepPhase = 'inventory' | 'discovery' | 'inspection'
  | 'reconcile' | 'complete' | 'partial_complete' | 'stopped' | 'failure_held' | 'failed'
  | 'conversations' | StockOrganizationProgress['phase'];

export interface RecallNightlySweepResult {
  pipelineVersion: 2 | 3;
  reviewDay: string;
  ranForWindow: string;
  finishedAt: string;
  scanned: number;
  queued: number;
  deferred: number;
  retried: number;
  skipped: number;
  failed: number;
  discovery?: RecallNightlyDiscoveryProgress;
  inspection?: RecallNightlyInspectionProgress;
  reconcile?: RecallNightlyReconcileProgress;
  error?: string;
}

export interface RecallNightlySweepItem {
  captureId: string;
  conversationId: string;
  status: 'completed' | 'partial' | 'failed' | 'pending' | 'skipped';
  errorCode?: string;
  candidateIds: string[];
  relatedAssetIds?: string[];
  failures?: Array<{ candidateIndex: number; stage: 'grounding' | 'uncertainty'; reason: string; relatedAssetIds?: string[] }>;
}

export interface RecallNightlySweepReceipt {
  runId: string;
  captureIds: string[];
  candidateIds: string[];
  inspectionRunId?: string;
  findingKeys: string[];
  items: RecallNightlySweepItem[];
}

export interface RecallNightlySweepRecord extends RecallJsonRecord {
  id: typeof NIGHTLY_SWEEP_ID;
  pipelineVersion?: 3;
  trigger?: 'scheduled' | 'manual';
  windowSnapshot?: RecallNightlyWindowSnapshot;
  baselineAt: string;
  cursors: Record<string, RecallNightlySweepCursor>;
  pendingRanges?: Record<string, RecallNightlyPendingRange>;
  reviewWindow?: Omit<RecallNightlyPendingRange, 'conversationId'>;
  claims?: RecallNightlyClaims;
  receipt?: RecallNightlySweepReceipt;
  discovery?: RecallNightlyDiscoveryProgress;
  inspection?: RecallNightlyInspectionProgress;
  reconcile?: RecallNightlyReconcileProgress;
  lastRunAt?: string;
  lastResult?: RecallNightlySweepResult;
  consecutiveErrors?: number;
  heldWindow?: string;
  phase?: RecallNightlySweepPhase;
  stock?: StockOrganizationProgress;
  remainingTasks?: number;
}

export interface RecallNightlyPendingRange {
  conversationId: string;
  feedbackRevision?: string;
  feedbackObservations?: NightlyFeedbackObservation[];
  reviewDay: string;
  start: string;
  end: string;
  ranForWindow: string;
}

export type RecallNightlySweepRun = RecallNightlySweepResult & { ran: true } | { ran: false; reason: string };

function asSweepCursor(value: unknown): RecallNightlySweepCursor {
  const raw = (value || {}) as Partial<RecallNightlySweepCursor>;
  const state: RecallNightlySweepCursorState = raw.state === 'covered' || raw.state === 'ignored'
    || raw.state === 'failed' || raw.state === 'deferred' ? raw.state : 'deferred';
  return {
    state,
    ...(typeof raw.throughMessageId === 'string' ? { throughMessageId: raw.throughMessageId } : {}),
    ...(typeof raw.throughTs === 'string' ? { throughTs: raw.throughTs } : {}),
    ...(typeof raw.errorCode === 'string' ? { errorCode: raw.errorCode } : {}),
    updatedAt: typeof raw.updatedAt === 'string' && isIsoTimestamp(raw.updatedAt) ? raw.updatedAt : new Date().toISOString(),
  };
}

function asSweepRecord(value: RecallJsonRecord): RecallNightlySweepRecord {
  const raw = value as unknown as Partial<RecallNightlySweepRecord>;
  const cursors: Record<string, RecallNightlySweepCursor> = {};
  if (raw.cursors && typeof raw.cursors === 'object') {
    for (const [cid, cursor] of Object.entries(raw.cursors)) cursors[cid] = asSweepCursor(cursor);
  }
  const pendingRanges: Record<string, RecallNightlyPendingRange> = {};
  if (raw.pendingRanges !== undefined) {
    if (!raw.pendingRanges || typeof raw.pendingRanges !== 'object' || Array.isArray(raw.pendingRanges)) {
      throw new Error('malformed nightly pending ranges');
    }
    for (const [key, range] of Object.entries(raw.pendingRanges)) {
      if (!range || !safeId(range.conversationId) || !/^\d{4}-\d{2}-\d{2}$/.test(range.reviewDay)
        || key !== `${range.reviewDay}:${range.conversationId}${range.feedbackRevision ? `:feedback-${range.feedbackRevision}` : ''}`
        || range.feedbackRevision && !/^[a-f0-9]{64}$/.test(range.feedbackRevision)
        || !isIsoTimestamp(range.start) || !isIsoTimestamp(range.end) || !isSweepWindowKey(range.ranForWindow)
        || Date.parse(range.start) >= Date.parse(range.end)) throw new Error('malformed nightly pending range');
      pendingRanges[key] = range;
    }
  }
  if (raw.reviewWindow && (!/^\d{4}-\d{2}-\d{2}$/.test(raw.reviewWindow.reviewDay)
    || !isIsoTimestamp(raw.reviewWindow.start) || !isIsoTimestamp(raw.reviewWindow.end)
    || !isSweepWindowKey(raw.reviewWindow.ranForWindow)
    || Date.parse(raw.reviewWindow.start) >= Date.parse(raw.reviewWindow.end))) {
    throw new Error('malformed nightly review window');
  }
  return {
    ...value,
    id: NIGHTLY_SWEEP_ID,
    baselineAt: typeof raw.baselineAt === 'string' && isIsoTimestamp(raw.baselineAt)
      ? raw.baselineAt : new Date().toISOString(),
    cursors,
    pendingRanges,
    ...(raw.lastRunAt ? { lastRunAt: raw.lastRunAt } : {}),
    ...(raw.lastResult ? { lastResult: raw.lastResult } : {}),
    ...(typeof raw.consecutiveErrors === 'number' ? { consecutiveErrors: raw.consecutiveErrors } : {}),
  } as RecallNightlySweepRecord;
}

/** Manual runs tag their window key with `manual-` so on-demand and scheduled
 * admissions stay distinguishable in persisted sweep state. */
function isSweepWindowKey(value: unknown): boolean {
  return isIsoTimestamp(value)
    || (typeof value === 'string' && value.startsWith('manual-') && isIsoTimestamp(value.slice('manual-'.length)));
}

async function readNightlySweepRecord(userId: string): Promise<RecallNightlySweepRecord | undefined> {
  const stored = await readRecallJsonRecord(userId, SWEEP_COLLECTION, NIGHTLY_SWEEP_ID);
  return stored ? asSweepRecord(stored) : undefined;
}

export async function readRecallNightlySweep(userId: string): Promise<RecallNightlySweepRecord | undefined> {
  const record = await readNightlySweepRecord(userId);
  if (record?.stock) record.stock = { ...record.stock, saved: await readStockOrganizationSavedCount(userId, record.stock) };
  if (!record || record.lastResult?.pipelineVersion === 2
    || record.lastResult?.pipelineVersion === 3) return record;
  // Old scan counts used a different time range and admission policy. Preserve
  // their stored history, but never present them as results of the new pipeline.
  return { ...record, lastResult: undefined, lastRunAt: undefined };
}

export interface RecallCaptureWindowStatus {
  start: string;
  end: string;
  withinWindow: boolean;
  nextRunAt?: string;
  state: 'running' | 'scheduled' | 'completed' | 'partial' | 'stopped' | 'failure_held' | 'missed' | 'error' | 'unknown';
}

/** Read model for the advanced window editor. Kept next to the sweep so the
 * renderer never re-derives "missed" or "next run" from a different clock. */
export function captureWindowStatus(
  settings: RecallCaptureSettingsRecord,
  sweep: RecallNightlySweepRecord | undefined,
  runtime: { running: boolean },
  failureHeld: boolean,
  now: Date = new Date(),
): RecallCaptureWindowStatus {
  const withinWindow = isWithinNightlyWindow(now, settings.nightlyStart, settings.nightlyEnd);
  const next = nextNightlyRunAt(now, settings.nightlyStart, settings.nightlyEnd);
  const windowStart = mostRecentWindowStart(now, settings.nightlyStart, settings.nightlyEnd);
  const startMinute = minuteOfDayValue(settings.nightlyStart);
  const endMinute = minuteOfDayValue(settings.nightlyEnd);
  const duration = ((endMinute - startMinute + 1440) % 1440) || 1440;
  const windowEnd = new Date(windowStart.getTime() + duration * 60_000);
  const lastRun = sweep?.lastRunAt ? Date.parse(sweep.lastRunAt) : undefined;
  let state: RecallCaptureWindowStatus['state'] = 'scheduled';
  if (runtime.running) state = 'running';
  else if (failureHeld || sweep?.phase === 'failure_held') state = 'failure_held';
  else if (sweep?.phase === 'stopped') state = 'stopped';
  else if (sweep?.phase === 'partial_complete') state = 'partial';
  else if (sweep?.phase === 'failed' || sweep?.lastResult?.error) state = 'error';
  else if (lastRun !== undefined && lastRun >= windowStart.getTime()) state = 'completed';
  else if (now >= windowEnd && lastRun !== undefined) state = 'missed';
  return {
    start: settings.nightlyStart,
    end: settings.nightlyEnd,
    withinWindow,
    ...(withinWindow ? {} : { nextRunAt: next.toISOString() }),
    state,
  };
}

function minuteOfDayValue(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function mostRecentWindowStart(now: Date, nightlyStart: string, nightlyEnd: string): Date {
  const start = minuteOfDayValue(nightlyStart);
  const candidate = new Date(now);
  candidate.setHours(Math.floor(start / 60), start % 60, 0, 0);
  if (candidate.getTime() > now.getTime()) candidate.setDate(candidate.getDate() - 1);
  return candidate;
}

/** Admission starts only in the configured night. Missed windows never
 * create a daytime catch-up run. */
function dueNightlyWindow(
  now: Date, settings: RecallCaptureSettingsRecord, _record: RecallNightlySweepRecord | undefined,
): string | undefined {
  if (isWithinNightlyWindow(now, settings.nightlyStart, settings.nightlyEnd)) {
    return mostRecentWindowStart(now, settings.nightlyStart, settings.nightlyEnd).toISOString();
  }
  return undefined;
}

/** Freeze the complete local day before the window starts, including windows
 * that cross midnight. Calendar arithmetic also respects DST transitions. */
export function nightlyReviewDay(ranForWindow: string): { key: string; start: Date; end: Date } {
  const end = new Date(ranForWindow);
  if (Number.isNaN(end.getTime())) throw new Error('invalid nightly review window');
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 1);
  const key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  return { key, start, end };
}

/** Manual runs do not wait for the window: they review the day the next due
 * window would review — the in-progress local day once today's window has
 * opened, otherwise the previous complete day. */
function manualNightlyReviewDay(now: Date, settings: RecallCaptureSettingsRecord): { key: string; start: Date; end: Date } {
  const [hours, minutes] = String(settings.nightlyStart || '02:00').split(':').map(Number);
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours || 0, minutes || 0, 0, 0);
  const day = now >= windowStart
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
    : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const end = new Date(day);
  end.setDate(end.getDate() + 1);
  const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  return { key, start: day, end };
}

function captureReviewDayBounds(capture: RecallCaptureRecord): { start: Date; end: Date } {
  if (capture.reviewDayStart && capture.reviewDayEnd) {
    return { start: new Date(capture.reviewDayStart), end: new Date(capture.reviewDayEnd) };
  }
  // Read compatibility for ranges admitted before absolute boundaries existed.
  const start = new Date(`${capture.reviewDay}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

/** Read the complete day and, when requested, the preceding user turn needed
 * to understand a cross-midnight continuation. Older context is never new work. */
async function readReviewDayMessages(userId: string, cid: string, start: Date, end: Date, includeContext = false): Promise<GroupMessage[]> {
  let before: number | null | undefined;
  const collected: GroupMessage[] = [];
  do {
    const page = await chats.getMessagesPage(userId, cid, 256, before);
    collected.unshift(...page.history.filter(message => isRecallConversationMessage(message)
      && (includeContext || timestampMs(message.ts) >= start.getTime()) && timestampMs(message.ts) < end.getTime()));
    if (page.nextCursor === null || page.nextCursor === before
      || page.history.some(message => timestampMs(message.ts) < start.getTime()
        && (!includeContext || (isRecallConversationMessage(message) && message.from === 'user')))) break;
    before = page.nextCursor;
  } while (true);
  const firstNew = collected.findIndex(message => timestampMs(message.ts) >= start.getTime());
  if (firstNew < 0) return [];
  let contextStart = firstNew;
  if (includeContext) {
    for (let index = firstNew - 1; index >= 0; index--) {
      if (collected[index].from === 'user') { contextStart = index; break; }
    }
  }
  return collected.slice(contextStart);
}

function nightSweepRunId(ranForWindow: string): string {
  return `nightly-sweep-${ranForWindow.replace(/[^0-9A-Za-z-]/g, '')}`;
}

/** A claim means "this run already has a suggestion that changes this target".
 * Only modified targets are claimed; comparison-only references stay available
 * to stock organization and the cross-asset inspection. */
async function collectNightlyClaims(userId: string, captureIds: ReadonlySet<string>): Promise<RecallNightlyClaims> {
  const claims: RecallNightlyClaims = { assets: {}, heldAssets: {}, ontology: {} };
  for (const captureId of captureIds) {
    let capture;
    try { capture = await readRecallCapture(userId, captureId); } catch { continue; }
    for (const pending of capture.candidateSupportUnavailable || []) if (pending.reason === 'related_assets_overflow') {
      for (const assetId of pending.relatedAssetIds || []) {
        const hold = claims.heldAssets![assetId] ||= { captureIds: [], at: new Date().toISOString() };
        if (!hold.captureIds.includes(captureId)) hold.captureIds.push(captureId);
      }
    }
    for (const candidateId of capture.candidateIds || []) {
      let candidate: RecallCandidateRecord;
      try { candidate = await readRecallCandidate(userId, candidateId); } catch { continue; }
      if (candidate.status === 'rejected' || candidate.status === 'ignored'
        || candidate.status === 'expired' || candidate.status === 'failed') continue;
      const claim: RecallNightlyClaim = { captureId, candidateId, at: new Date().toISOString() };
      const assetIds = [
        candidate.targetAssetId,
        candidate.mergedIntoAssetId,
        ...(candidate.contentOrganization?.draft.sourceAssetIds || []),
        ...(candidate.formationComparison?.relatedAssets || []).map(item => item.assetId),
      ];
      for (const assetId of assetIds) {
        if (assetId) claims.assets[assetId] ||= claim;
      }
      for (const row of candidate.ontologyFormation?.previewChanges || []) {
        if (row.before) claims.ontology[row.recordId] ||= claim;
      }
      for (const action of candidate.ontologyFormation?.actions || []) {
        if (action.intent !== 'create' && action.recordId) claims.ontology[action.recordId] ||= claim;
      }
    }
  }
  return claims;
}

function mergeNightlyClaims(base: RecallNightlyClaims | undefined, next: RecallNightlyClaims): RecallNightlyClaims {
  const merged: RecallNightlyClaims = { assets: { ...(base?.assets || {}) }, heldAssets: { ...(base?.heldAssets || {}) }, ontology: { ...(base?.ontology || {}) } };
  for (const [key, claim] of Object.entries(next.heldAssets || {})) {
    const hold = merged.heldAssets![key] ||= { captureIds: [], at: claim.at };
    hold.captureIds = [...new Set([...hold.captureIds, ...claim.captureIds])];
  }
  for (const [key, claim] of Object.entries(next.assets)) merged.assets[key] ||= claim;
  for (const [key, claim] of Object.entries(next.ontology)) merged.ontology[key] ||= claim;
  return merged;
}

function nightlyClaimRefs(claims: RecallNightlyClaims | undefined): Set<string> {
  return new Set([...Object.keys(claims?.assets || {}), ...Object.keys(claims?.heldAssets || {}), ...Object.keys(claims?.ontology || {})]);
}

/** Same-kind content updates are superseded by the newest run's suggestion.
 * Merge/split/conflict candidates stay pending: losing a structural suggestion
 * is worse than showing a related-suggestion hint. */
async function reconcileNightlySuggestions(userId: string, claims: RecallNightlyClaims | undefined): Promise<RecallNightlyReconcileProgress> {
  const candidates = await listRecallCandidates(userId);
  const claimedAssetIds = new Set(Object.keys(claims?.assets || {}));
  const replacements = new Map<string, RecallCandidateRecord>();
  for (const [assetId, claim] of Object.entries(claims?.assets || {})) {
    const candidate = candidates.find(item => item.id === claim.candidateId);
    if (!candidate || candidate.contentOrganization || candidate.targetAssetId !== assetId) continue;
    if (!['update', 'limit_scope'].includes(candidate.suggestedAction || '')) continue;
    replacements.set(assetId, candidate);
  }
  let superseded = 0;
  let supersedeFailed = false;
  for (const [assetId, replacement] of replacements) {
    for (const old of candidates) {
      if (old.id === replacement.id || old.targetAssetId !== assetId) continue;
      if (!['pending_review', 'deferred'].includes(old.status)) continue;
      if (old.contentOrganization) continue;
      if (!['update', 'limit_scope'].includes(old.suggestedAction || '')) continue;
      try {
        await supersedeRecallCandidate(userId, old.id, replacement.id, '被本轮更新建议取代');
        superseded += 1;
      } catch (error) {
        supersedeFailed = true;
        log.warn('nightly supersede failed', {
          userId: maskId(userId), candidateId: old.id, error: (error as Error).message,
        });
      }
    }
  }
  if (supersedeFailed) throw new Error('nightly suggestion reconciliation failed');
  const related = candidates.filter(candidate =>
    ['pending_review', 'deferred'].includes(candidate.status)
    && (candidate.contentOrganization?.draft.sourceAssetIds || []).some(id => claimedAssetIds.has(id))).length;
  return { superseded, related };
}

/** Legacy installations that used to get a daily cleanup report keep one per
 * day. New installations do not gain a report they never had. */
async function runLegacyNightlyCleanup(userId: string): Promise<void> {
  const { readInspectionSettings } = await import('./asset-inspection-service');
  const settings = await readInspectionSettings(userId);
  if (!settings.enabled) return;
  const { listCleanupReports, runAssetCleanup } = await import('./cleanup-report-service');
  const latest = (await listCleanupReports(userId, 1))[0];
  const today = new Date().toISOString().slice(0, 10);
  if (latest && String(latest.trigger || '') === 'inspection'
    && String(latest.createdAt || '').slice(0, 10) === today) return;
  await runAssetCleanup(userId, { trigger: 'inspection' });
}

interface SweepControl { controller: AbortController; tasks: Set<ScheduledBootBackgroundTask>; captureTasks: Map<string, ScheduledBootBackgroundTask>; window: string; nightlyStart: string; nightlyEnd: string; manual: boolean }
const sweepControls = new Map<string, SweepControl>();
export async function stopRecallCaptureSweep(userId: string): Promise<{ stopped: boolean }> {
  const run = sweepControls.get(userId);
  if (!run) return { stopped: false };
  run.controller.abort();
  for (const task of run.tasks) task.cancel();
  await updateRecallJsonRecord(userId, SWEEP_COLLECTION, NIGHTLY_SWEEP_ID, current => ({
    ...(current || { schemaVersion: 1, ownerId: userId, id: NIGHTLY_SWEEP_ID, baselineAt: new Date().toISOString(), cursors: {} }),
    heldWindow: run.window, phase: 'stopped',
  }));
  return { stopped: true };
}
const nightlySweepsInFlight = new Set<string>();
const nightlySweepStartedAt = new Map<string, string>();
export function readRecallNightlySweepRuntime(userId: string) {
  return { running: nightlySweepsInFlight.has(userId), startedAt: nightlySweepStartedAt.get(userId) };
}

export async function runNightlyCaptureSweep(
  userId: string, ranForWindow: string, settings: RecallCaptureSettingsRecord, signal?: AbortSignal,
  options: { manual?: boolean; reviewDay?: { key: string; start: Date; end: Date } } = {},
): Promise<RecallNightlySweepRun> {
  if (signal?.aborted) return { ran: false, reason: 'cancelled' };
  if (!settings.enabled || settings.executionPolicy !== 'nightly') return { ran: false, reason: 'disabled' };
  if (!options.manual && !isWithinNightlyWindow(new Date(), settings.nightlyStart, settings.nightlyEnd)) return { ran: false, reason: 'outside_nightly_window' };
  if (nightlySweepsInFlight.has(userId)) return { ran: false, reason: 'sweep_in_flight' };
  let day = options.reviewDay || nightlyReviewDay(ranForWindow);
  nightlySweepsInFlight.add(userId);
  const externalSignal = signal;
  const control: SweepControl = { controller: new AbortController(), tasks: new Set(), captureTasks: new Map(),
    window: captureBudgetWindowKey(new Date(), settings.nightlyStart), nightlyStart: settings.nightlyStart, nightlyEnd: settings.nightlyEnd, manual: Boolean(options.manual) };
  const cancel = () => { control.controller.abort(); for (const task of control.tasks) task.cancel(); };
  externalSignal?.addEventListener('abort', cancel, { once: true });
  signal = control.controller.signal;
  sweepControls.set(userId, control);
  const startedAt = new Date().toISOString();
  nightlySweepStartedAt.set(userId, startedAt);
  notifyCognitionWrite(userId, SWEEP_COLLECTION, 'update', NIGHTLY_SWEEP_ID);
  const counters = { scanned: 0, queued: 0, deferred: 0, retried: 0, skipped: 0, failed: 0 };
  // This is an admission cursor, not source or review history. Persisted
  // captures already retain every admitted range for retries and audit.
  const currentDayCursors = (values: Record<string, RecallNightlySweepCursor>) => Object.fromEntries(
    Object.entries(values).filter(([key]) => /^\d{4}-\d{2}-\d{2}:/.test(key) && key.slice(0, 10) >= day.key));
  let cursors: Record<string, RecallNightlySweepCursor> = {};
  let pendingRanges: Record<string, RecallNightlyPendingRange> = {};
  let admissionLoaded = false;
  let claims: RecallNightlyClaims | undefined;
  let phase: RecallNightlySweepPhase = 'inventory';
  let discoveryProgress: RecallNightlyDiscoveryProgress | undefined;
  let inspectionProgress: RecallNightlyInspectionProgress | undefined;
  let reconcileProgress: RecallNightlyReconcileProgress | undefined;
  let stockProgress: StockOrganizationProgress | undefined;
  let remainingTasks = 0;
  const processedCaptureIds = new Set<string>();
  let receipt: RecallNightlySweepReceipt = { runId: nightSweepRunId(ranForWindow), captureIds: [], candidateIds: [], findingKeys: [], items: [] };
  const canContinue = async () => !signal?.aborted && captureSchedulingEnabled && await nightlyCaptureCanStart(userId, options.manual);
  const persist = async (result?: RecallNightlySweepResult) => updateRecallJsonRecord(userId, SWEEP_COLLECTION, NIGHTLY_SWEEP_ID, current => ({
    ...(current || { schemaVersion: 1, ownerId: userId, id: NIGHTLY_SWEEP_ID, baselineAt: day.start.toISOString() }),
    pipelineVersion: 3,
    trigger: options.manual ? 'manual' : 'scheduled',
    windowSnapshot: { start: day.start.toISOString(), end: day.end.toISOString(),
      nightlyStart: settings.nightlyStart, nightlyEnd: settings.nightlyEnd, reviewDay: day.key, ranForWindow },
    phase,
    ...(claims ? { claims } : {}),
    receipt: { ...receipt, captureIds: [...processedCaptureIds], items: [
      ...receipt.items.filter(item => item.captureId),
      ...Object.entries(pendingRanges).map(([key, range]) => ({ captureId: '', conversationId: range.conversationId,
        status: 'pending' as const, ...(cursors[key]?.errorCode ? { errorCode: cursors[key].errorCode } : {}), candidateIds: [] })),
    ] },
    ...(discoveryProgress ? { discovery: discoveryProgress } : {}),
    ...(inspectionProgress ? { inspection: inspectionProgress } : {}),
    ...(reconcileProgress ? { reconcile: reconcileProgress } : {}),
    ...(stockProgress ? { stock: stockProgress } : {}),
    remainingTasks,
    cursors: { ...currentDayCursors((current as RecallNightlySweepRecord | undefined)?.cursors || {}), ...cursors },
    ...(admissionLoaded ? { pendingRanges: { ...pendingRanges } } : {}),
    ...(admissionLoaded ? { reviewWindow: { reviewDay: day.key, start: day.start.toISOString(), end: day.end.toISOString(), ranForWindow } } : {}),
    ...(result ? { lastRunAt: result.finishedAt, lastResult: result,
      consecutiveErrors: result.error ? Number(current?.consecutiveErrors || 0) + 1 : 0 } : {}),
  } as RecallJsonRecord));
  try {
    if (options.manual) await resetCaptureModelFailureGuard(userId);
    else if (await isCaptureModelFailureHeld(userId)) return { ran: false, reason: 'model_failure_held' };
    const [conversations, captures, sweep] = await Promise.all([
      chats.listConversations(userId), listAllRecallCaptures(userId), readNightlySweepRecord(userId),
    ]);
    if (!options.manual && sweep?.heldWindow === control.window) return { ran: false, reason: 'stopped_for_window' };
    // Claims belong to the unfinished ranges, not to the wall-clock window.
    // Keep them when the same run resumes; a fresh day starts without claims.
    claims = sweep && (sweep.reviewWindow?.ranForWindow === ranForWindow
      || Object.keys(sweep.pendingRanges || {}).length) ? sweep.claims : undefined;
    if (sweep?.receipt && sweep.reviewWindow?.ranForWindow === ranForWindow) {
      receipt = structuredClone(sweep.receipt);
      for (const id of receipt.captureIds) processedCaptureIds.add(id);
    }
    phase = 'inventory';
    discoveryProgress = undefined;
    inspectionProgress = undefined;
    reconcileProgress = undefined;
    stockProgress = undefined;
    remainingTasks = 0;
    await updateRecallJsonRecord(userId, SWEEP_COLLECTION, NIGHTLY_SWEEP_ID, current => ({
      ...(current || { schemaVersion: 1, ownerId: userId, id: NIGHTLY_SWEEP_ID, baselineAt: day.start.toISOString(), cursors: {} }),
      ...(options.manual ? { heldWindow: undefined } : {}), phase: 'inventory', stock: undefined, remainingTasks: 0,
      claims, discovery: undefined, inspection: undefined, reconcile: undefined,
    }));
    // scheduled 是兼容读取的退役状态，现行调度只处理 queued。
    // 对已删除、被移除或暂停的来源会话，将遗留任务收口为 cancelled，
    // 与执行入口的 source_removed/source_paused 约束一致。
    const liveConversationIds = new Set(conversations.map((conversation) => conversation.conversation_id));
    for (const legacy of captures.filter((capture) => capture.status === 'scheduled')) {
      const availability = liveConversationIds.has(legacy.conversationId)
        ? ((await readCognitionSourceControl(userId, { kind: 'conversation', id: legacy.conversationId }))?.availability ?? 'active')
        : 'removed';
      if (availability === 'active') continue;
      await updateCapture(userId, legacy.id, (current) => current.status !== 'scheduled'
        ? current
        : {
            ...current,
            status: 'cancelled',
            visibility: 'internal',
            resumeStatus: undefined,
            errorCode: availability === 'removed' ? 'source_removed' : 'source_paused',
            reasonCode: undefined,
            updatedAt: new Date().toISOString(),
          });
      counters.skipped += 1;
    }
    if (sweep?.reviewWindow?.ranForWindow === ranForWindow) {
      day = { key: sweep.reviewWindow.reviewDay, start: new Date(sweep.reviewWindow.start), end: new Date(sweep.reviewWindow.end) };
    }
    cursors = currentDayCursors(sweep?.cursors || {});
    pendingRanges = { ...sweep?.pendingRanges };
    admissionLoaded = true;
    phase = 'discovery';
    if (!await canContinue()) return { ran: false, reason: 'cancelled' };
    await (await import('./effectiveness-feedback')).recoverNightlyEffectivenessFeedback(userId)
      .catch(() => log.warn('nightly effectiveness feedback recovery deferred'));
    if (!await canContinue()) return { ran: false, reason: 'cancelled' };
    let feedbackAdmitted = 0;
    for (const event of await queuedNightlyFeedback(userId)) {
      if (!await canContinue()) break;
      try {
        const original = await findConversationMessageById(userId, event.conversationId, event.messageId);
        if (!original || !Number.isFinite(Date.parse(original.ts))) continue;
        const originalDate = new Date(original.ts), start = new Date(originalDate.getFullYear(), originalDate.getMonth(), originalDate.getDate());
        const end = new Date(start); end.setDate(end.getDate() + 1);
        const reviewDay = nightlyReviewDay(end.toISOString()).key;
        const observation = feedbackObservation(event);
        const revision = createHash('sha256').update(JSON.stringify(observation)).digest('hex');
        const key = `${reviewDay}:${event.conversationId}:feedback-${revision}`;
        pendingRanges[key] ||= { conversationId: event.conversationId, reviewDay, start: start.toISOString(), end: end.toISOString(),
          ranForWindow, feedbackRevision: revision, feedbackObservations: [observation] };
        if (++feedbackAdmitted >= 20) break;
      } catch { /* A transient source failure preserves the queued feedback. */ }
    }
    // Previously admitted ranges deferred by shutdown/window closure resume
    // only inside this night; no old conversation day is scanned again.
    for (const capture of captures.filter(item => item.reviewDay && item.executionPolicy === 'nightly' && (item.status === 'queued' || (item.status === 'review_ready' && item.autoApprovalEpoch)))) {
      if (!await canContinue()) break;
      processedCaptureIds.add(capture.id);
      await scheduleKnownRecallCapture(userId, capture);
    }
    // Retry diagnostics only for this day; no automatic historical catch-up.
    for (const capture of captures.filter(item => item.reviewDay && item.executionPolicy === 'nightly')) {
      if (!await canContinue()) break;
      if (!captureNeedsSupportRetry(capture) || (!options.manual && capture.attempt >= NIGHTLY_AUTO_RETRY_ATTEMPT_LIMIT)) continue;
      // Retry a persisted range on a subsequent night; never spend all attempts
      // during the same unavailable/configuration-failed window.
      if (!options.manual && (capture.lastAttemptReviewDay || capture.reviewDay!) >= day.key) continue;
      const retried = await updateCapture(userId, capture.id, current => !captureNeedsSupportRetry(current)
        ? current : { ...current, status: 'queued', visibility: current.candidateIds.length ? 'visible' : 'internal', reviewSnapshot: undefined, stage: undefined, attempt: current.attempt + 1, lastAttemptReviewDay: day.key,
          errorCode: undefined, reasonCode: undefined, startedAt: undefined, finishedAt: undefined, updatedAt: startedAt });
      processedCaptureIds.add(retried.id);
      await scheduleKnownRecallCapture(userId, retried);
      counters.retried += 1;
    }
    if (!await canContinue()) return { ran: false, reason: 'cancelled' };
    for (const conversation of conversations) {
      if (timestampMs(String(conversation.updated_at)) < day.start.getTime()) continue;
      const cid = conversation.conversation_id;
      const key = `${day.key}:${cid}`;
      pendingRanges[key] ||= { conversationId: cid, reviewDay: day.key,
        start: day.start.toISOString(), end: day.end.toISOString(), ranForWindow };
    }
    // Admission is durable before quiescence/source reads; even an unreadable
    // conversation can resume its exact range after this window or a restart.
    await persist();
    for (const [cursorKey, pending] of Object.entries(pendingRanges)) {
      if (!await canContinue()) break;
      const cid = pending.conversationId;
      const rangeDay = { key: pending.reviewDay, start: new Date(pending.start), end: new Date(pending.end) };
      counters.scanned += 1;
      const sourceControl = await readCognitionSourceControl(userId, { kind: 'conversation', id: cid });
      if (sourceControl && sourceControl.availability !== 'active') {
        delete pendingRanges[cursorKey];
        cursors[cursorKey] = { state: 'ignored', updatedAt: startedAt }; await persist(); counters.skipped += 1; continue;
      }
      if (!isQuiescent(userId, cid)) {
        cursors[cursorKey] = { ...(cursors[cursorKey] || {}), state: 'deferred', updatedAt: startedAt };
        await persist(); counters.deferred += 1; continue;
      }
      let dayMessages: GroupMessage[];
      let conversation;
      try {
        conversation = await chats.getConversation(userId, cid);
        if (!conversation) {
          delete pendingRanges[cursorKey];
          cursors[cursorKey] = { state: 'ignored', errorCode: 'source_removed', updatedAt: startedAt };
          await persist(); counters.skipped += 1; continue;
        }
        dayMessages = await readReviewDayMessages(userId, cid, rangeDay.start, rangeDay.end, true);
      }
      catch {
        cursors[cursorKey] = { ...(cursors[cursorKey] || {}), state: 'deferred', errorCode: 'source_unavailable', updatedAt: startedAt };
        await persist(); counters.deferred += 1; continue;
      }
      const sourceMessages = dayMessages;
      const rangeMessages = dayMessages.filter(message => timestampMs(message.ts) >= rangeDay.start.getTime());
      const pausedMessageIds = await listDisabledCognitionMessageIds(userId, cid, dayMessages.map(message => message.id));
      const firstPausedInRange = pausedMessageIds.size
        ? rangeMessages.findIndex(message => pausedMessageIds.has(message.id)) : -1;
      // A paused message is a hard stop for the cursor. Process only the active
      // prefix before it so a later throughMessageId cannot silently cover the
      // paused message; the rest waits for resume.
      const eligibleMessages = firstPausedInRange >= 0 ? rangeMessages.slice(0, firstPausedInRange) : rangeMessages;
      const covered = new Set(captures.filter(capture => capture.conversationId === cid
        && capture.executionPolicy === 'nightly' && capture.reviewDay === rangeDay.key
        && (!pending.feedbackRevision || capture.feedbackRevision === pending.feedbackRevision)).flatMap(capture => capture.messageIds));
      const cursor = cursors[cursorKey];
      if (cursor?.throughMessageId) {
        const through = eligibleMessages.findIndex(message => message.id === cursor.throughMessageId);
        if (through >= 0) eligibleMessages.slice(0, through + 1).forEach(message => covered.add(message.id));
      }
      const fresh = eligibleMessages.filter(message => !covered.has(message.id));
      if (!fresh.length) {
        if (pausedMessageIds.size && rangeMessages.some(message => pausedMessageIds.has(message.id))) {
          cursors[cursorKey] = { ...(cursors[cursorKey] || {}), state: 'deferred', errorCode: 'source_paused', updatedAt: startedAt };
          await persist(); counters.deferred += 1; continue;
        }
        const existing = pending.feedbackRevision && captures.find(item => item.feedbackRevision === pending.feedbackRevision && item.conversationId === cid);
        if (existing) for (const observation of pending.feedbackObservations || []) await admitNightlyFeedback(userId, observation, existing.id);
        delete pendingRanges[cursorKey]; await persist(); counters.skipped += 1; continue;
      }
      if (!await canContinue()) break;
      const currentSourceControl = await readCognitionSourceControl(userId, { kind: 'conversation', id: cid });
      if (currentSourceControl && currentSourceControl.availability !== 'active') {
        delete pendingRanges[cursorKey]; await persist(); counters.skipped += 1; continue;
      }
      // One frozen daily range keeps later corrections with earlier statements.
      // Model budgets are enforced by the complete-source summary chunker.
      {
        const range = fresh;
        const discoveredIds = new Set(range.map(message => message.id));
        // Cut context at the first paused message inside this range: later
        // messages may quote or answer it, so filtering only the paused row
        // would still feed its content to the model through the context.
        const firstPausedSourceIndex = firstPausedInRange >= 0
          ? sourceMessages.findIndex(message => message.id === rangeMessages[firstPausedInRange].id)
          : -1;
        const activeContext = (firstPausedSourceIndex >= 0
          ? sourceMessages.slice(0, firstPausedSourceIndex)
          : sourceMessages).filter(message => !pausedMessageIds.has(message.id));
        const contextMessages = activeContext.filter(message => !discoveredIds.has(message.id));
        // Covered messages remain context, including same-day manual captures.
        // Preserve source order when a new message precedes covered messages.
        const selected = selectCaptureMessages(activeContext, 0, Number.MAX_SAFE_INTEGER)
          .map(message => ({ ...message, discovery: discoveredIds.has(message.id) }));
        const newMessages = selected.filter(message => message.discovery);
        const screening = screenRecallCaptureValue(newMessages.some(message => message.role === 'user') ? newMessages : selected);
        const now = new Date().toISOString();
        const record: RecallCaptureRecord = {
          schemaVersion: 1, taxonomyVersion: 2, ownerId: userId,
          id: `capture-${createHash('sha256').update(JSON.stringify([cid, range.map(message => message.id), ...(pending.feedbackRevision ? [pending.feedbackRevision] : [])])).digest('hex').slice(0, 32)}`,
          conversationId: cid, ...(conversation.title ? { conversationTitle: conversation.title } : {}),
          terminalRunId: nightSweepRunId(pending.ranForWindow), anchorMessageId: range[0].id,
          messageIds: range.map(message => message.id), reviewDay: rangeDay.key, lastAttemptReviewDay: day.key,
          reviewDayStart: pending.start, reviewDayEnd: pending.end,
          ...(pending.feedbackRevision ? { feedbackRevision: pending.feedbackRevision, feedbackObservations: pending.feedbackObservations } : {}),
          ...(contextMessages.length ? { contextMessageIds: contextMessages.map(message => message.id) } : {}),
          status: screening.eligible || pending.feedbackRevision ? 'queued' : 'no_candidate', visibility: 'internal',
          screeningStatus: screening.eligible || pending.feedbackRevision ? 'pending' : 'filtered', screeningSignals: screening.signals,
          ...(screening.eligible || pending.feedbackRevision ? {} : { filterReason: screening.reason || 'low_reuse_value', screenedAt: now, finishedAt: now }),
          executionPolicy: 'nightly', attempt: 1, candidateIds: [], createdAt: now, updatedAt: now,
        };
        const stored = asCapture(await updateRecallJsonRecord(userId, CAPTURE_COLLECTION, record.id, current => current || record));
        captures.push(stored);
        processedCaptureIds.add(stored.id);
        for (const observation of pending.feedbackObservations || []) await admitNightlyFeedback(userId, observation, stored.id);
        await scheduleKnownRecallCapture(userId, stored);
        if (screening.eligible || pending.feedbackRevision) counters.queued += 1; else counters.skipped += 1;
      }
      const latest = fresh.at(-1)!;
      delete pendingRanges[cursorKey];
      cursors[cursorKey] = { state: 'covered', throughMessageId: latest.id, throughTs: latest.ts, updatedAt: startedAt };
      // Persist each admission's progress. A crash after capture save is deduped
      // by the immutable message IDs even if the cursor write has not happened.
      await persist();
    }
    // Discovery admissions are durable. Let every capture task settle before
    // stock organization and the cross-asset inspection, so the targets changed
    // by this run can be claimed deterministically.
    const discoveryTasks = [...control.captureTasks];
    const discoverySettled = await Promise.allSettled(discoveryTasks.map(async ([, task]) => {
      try { await task.promise; } finally { control.tasks.delete(task); }
    }));
    const rejectedCaptureIds = new Set(discoverySettled.flatMap((row, index) =>
      row.status === 'rejected' ? [discoveryTasks[index][0]] : []));
    const captureResults = await Promise.all([...processedCaptureIds].map(async captureId => {
      try {
        const row = await readRecallCapture(userId, captureId);
        const failures = (row.candidateSupportUnavailable || []).map(({ candidateIndex, stage, reason, relatedAssetIds }) => ({
          candidateIndex, stage, reason, ...(relatedAssetIds?.length ? { relatedAssetIds } : {}),
        }));
        const overflow = failures.find(item => item.reason === 'related_assets_overflow');
        const failed = row.status === 'failed' || row.status === 'configuration_required' || failures.length > 0
          || (!signal?.aborted && rejectedCaptureIds.has(captureId));
        const status: RecallNightlySweepItem['status'] = failed ? (row.candidateIds?.length ? 'partial' : 'failed')
          : ['queued', 'extracting', 'writing', 'paused', 'scheduled'].includes(row.status) ? 'pending'
          : row.status === 'cancelled' || row.screeningStatus === 'filtered' ? 'skipped' : 'completed';
        const errorCode = overflow ? 'related_assets_overflow' : row.errorCode
          || (failures.length ? 'candidate_support_unavailable' : !signal?.aborted && rejectedCaptureIds.has(captureId) ? 'capture_task_failed' : undefined);
        return { captureId, conversationId: row.conversationId, status, ...(errorCode ? { errorCode } : {}),
          ...(overflow?.relatedAssetIds ? { relatedAssetIds: overflow.relatedAssetIds } : {}),
          ...(failures.length ? { failures } : {}), candidateIds: row.candidateIds || [] };
      } catch {
        return { captureId, conversationId: '', status: 'failed' as const, errorCode: 'capture_unavailable', candidateIds: [] };
      }
    }));
    const failedCaptures = captureResults.filter(row => row.status === 'failed' || row.status === 'partial').length;
    const discoveryTaskFailed = failedCaptures > 0;
    receipt.items = captureResults;
    receipt.candidateIds = [...new Set([...receipt.candidateIds, ...captureResults.flatMap(row => row.candidateIds)])];
    discoveryProgress = {
      ranges: counters.scanned,
      queued: counters.queued,
      skipped: counters.skipped,
      deferred: counters.deferred,
      failed: counters.failed + failedCaptures,
    };
    // A resumed capture replaces its old overflow hold. Other captures in the
    // same run keep their own holds until their next attempt settles.
    if (claims?.heldAssets) for (const [assetId, hold] of Object.entries(claims.heldAssets)) {
      hold.captureIds = hold.captureIds.filter(id => !processedCaptureIds.has(id));
      if (!hold.captureIds.length) delete claims.heldAssets[assetId];
    }
    claims = mergeNightlyClaims(claims, await collectNightlyClaims(userId, processedCaptureIds));
    remainingTasks = 0;
    await persist();

    const reportStock = async (stock: StockOrganizationProgress) => {
      stockProgress = stock;
      remainingTasks = stock.remaining;
      phase = signal?.aborted ? 'stopped' : 'inspection';
      await persist();
    };
    let stockFailed = false;
    if (await canContinue()) {
      phase = 'inspection';
      await persist();
      const excludeRefs = nightlyClaimRefs(claims);
      let execution: Promise<StockOrganizationProgress> | undefined;
      const task = scheduleBootBackground('recall:stock-organization', taskSignal => {
        execution = runStockOrganization(userId, settings, AbortSignal.any([signal!, taskSignal!]), reportStock, canContinue,
          { retryFailed: options.manual, excludeRefs });
        return execution.then(() => undefined);
      }, 0, { resourceClass: 'model', preferIdle: !options.manual });
      const tracked = { cancel: () => task.cancel(), promise: task.promise.then(async () => {
        if (execution) stockProgress = await execution;
      }) };
      control.tasks.add(tracked);
      const settled = await Promise.allSettled([tracked].map(async item => {
        try { await item.promise; } finally { control.tasks.delete(item); }
      }));
      stockFailed = settled.some(row => row.status === 'rejected') || Boolean(stockProgress?.failed);
      receipt.candidateIds = [...new Set([...receipt.candidateIds, ...(stockProgress?.candidateIds || [])])];
    }
    phase = signal?.aborted ? 'stopped' : 'inspection';
    remainingTasks = 0;
    await persist();

    let inspectionFailed = false;
    if (await canContinue()) {
      try {
        const { runAssetInspection } = await import('./asset-inspection-service');
        const run = await runAssetInspection(userId, {
          trigger: 'nightly',
          excludeAssetIds: new Set([...Object.keys(claims?.assets || {}), ...Object.keys(claims?.heldAssets || {})]),
          signal,
        });
        const currentKeys = new Set(run.currentFindingKeys || run.findings.map(finding => finding.key));
        const currentFindings = run.findings.filter(finding => currentKeys.has(finding.key));
        const count = (category: string) => currentFindings.filter(finding => finding.category === category).length;
        receipt.inspectionRunId = run.id;
        receipt.findingKeys = [...new Set([...receipt.findingKeys, ...currentKeys])];
        inspectionProgress = {
          scanned: run.scanned,
          findings: currentFindings.length,
          duplicate: count('duplicate'),
          outdated: count('outdated'),
          conflict: count('conflict'),
          skippedClaimed: run.skippedAssetIds?.length || 0,
          ...(run.coverage ? { coverage: run.coverage } : {}),
          ...(run.evaluatedAssetIds ? { evaluatedAssetIds: run.evaluatedAssetIds } : {}),
          ...(run.coveredAssetIds ? { coveredAssetIds: run.coveredAssetIds } : {}),
          ...(run.pendingAssetIds ? { pendingAssetIds: run.pendingAssetIds } : {}),
          ...(run.unavailableAssetIds ? { unavailableAssetIds: run.unavailableAssetIds } : {}),
        };
        await runLegacyNightlyCleanup(userId);
      } catch (error) {
        inspectionFailed = true;
        inspectionProgress = { scanned: 0, findings: 0, duplicate: 0, outdated: 0, conflict: 0,
          skippedClaimed: 0, error: (error as { code?: string })?.code === 'inspection_baseline_stale'
            ? 'inspection_baseline_stale' : 'inspection_failed' };
        log.warn('nightly inspection failed', { userId: maskId(userId), error: (error as Error).message.slice(0, 300) });
      }
    }
    phase = signal?.aborted ? 'stopped' : 'reconcile';
    await persist();

    let reconcileFailed = false;
    if (await canContinue()) {
      try {
        reconcileProgress = await reconcileNightlySuggestions(userId, claims);
      } catch (error) {
        reconcileFailed = true;
        log.warn('nightly reconcile failed', { userId: maskId(userId), error: (error as Error).message.slice(0, 300) });
        reconcileProgress = { superseded: 0, related: 0, error: 'reconcile_failed' };
      }
    }
    const taskFailed = discoveryTaskFailed || stockFailed || inspectionFailed || reconcileFailed || counters.failed > 0;
    // 不可读取的资产不是待办工作：它保留在覆盖统计里，但不能让每轮都停在“部分完成”。
    const inspectionPending = Math.max(0, Number(inspectionProgress?.coverage?.remaining || 0)
      - Number(inspectionProgress?.coverage?.unavailable || 0));
    const incomplete = Object.keys(pendingRanges).length > 0 || captureResults.some(row => row.status === 'pending')
      || Boolean(stockProgress?.remaining) || inspectionPending > 0;
    counters.failed += failedCaptures;
    const inspectionMadeProgress = Boolean(inspectionProgress && !inspectionProgress.error && Number(inspectionProgress.scanned || 0) > 0);
    const discoveryMadeProgress = Number(discoveryProgress?.ranges || 0) > 0;
    const partial = taskFailed && (discoveryMadeProgress
      || captureResults.some(row => row.status === 'completed' || row.status === 'skipped' || row.status === 'partial')
      || Boolean(stockProgress?.checked) || inspectionMadeProgress);
    const failureHeld = await isCaptureModelFailureHeld(userId);
    phase = signal?.aborted ? 'stopped' : failureHeld ? 'failure_held' : taskFailed ? (partial ? 'partial_complete' : 'failed')
      : incomplete ? 'partial_complete' : 'complete';
    remainingTasks = Object.keys(pendingRanges).length + captureResults.filter(row => row.status === 'pending').length
      + (stockProgress?.remaining || 0) + inspectionPending;
    await persist();
    const result: RecallNightlySweepResult = { pipelineVersion: 3, reviewDay: day.key, ranForWindow, finishedAt: new Date().toISOString(), ...counters,
      ...(discoveryProgress ? { discovery: discoveryProgress } : {}),
      ...(inspectionProgress ? { inspection: inspectionProgress } : {}),
      ...(reconcileProgress ? { reconcile: reconcileProgress } : {}),
      ...(taskFailed ? { error: 'scan_task_failed' } : {}) };
    await persist(result);
    await bumpRecallCaptureStats(userId, { sweeps: 1, conversationsScanned: counters.scanned, retried: counters.retried }).catch(() => {});
    return { ran: true, ...result };
  } catch (error) {
    const reason = (error as Error)?.message?.slice(0, 300) || String(error).slice(0, 300);
    log.warn('recall nightly sweep failed', { reason });
    phase = 'failed';
    remainingTasks = 0;
    const result: RecallNightlySweepResult = { pipelineVersion: 3, reviewDay: day.key, ranForWindow, finishedAt: new Date().toISOString(), ...counters,
      ...(discoveryProgress ? { discovery: discoveryProgress } : {}),
      ...(inspectionProgress ? { inspection: inspectionProgress } : {}),
      ...(reconcileProgress ? { reconcile: reconcileProgress } : {}),
      error: 'sweep_failed' };
    await persist(result).catch(() => {});
    return { ran: true, ...result };
  } finally {
    externalSignal?.removeEventListener('abort', cancel);
    if (signal.aborted) for (const task of control.tasks) task.cancel();
    await Promise.allSettled([...control.tasks].map(task => task.promise));
    sweepControls.delete(userId);
    nightlySweepsInFlight.delete(userId);
    nightlySweepStartedAt.delete(userId);
    notifyCognitionWrite(userId, SWEEP_COLLECTION, 'update', NIGHTLY_SWEEP_ID);
  }
}

/** User-triggered discovery run: same admission, cursor and budget machinery
 * as the nightly window, started on demand instead of waiting for it. */
export async function runManualCaptureSweep(userId: string, signal?: AbortSignal): Promise<RecallNightlySweepRun> {
  await migrateUnifiedDiscoverySettings(userId);
  const settings = await readRecallCaptureSettings(userId);
  if (!settings.enabled || settings.executionPolicy !== 'nightly') return { ran: false, reason: 'disabled' };
  if (nightlySweepsInFlight.has(userId)) return { ran: false, reason: 'sweep_in_flight' };
  const now = new Date();
  const previous = await readNightlySweepRecord(userId);
  // A stopped sweep resumes its original ranges and result identity. A new run
  // gets a fresh manual window and can admit new conversation ranges.
  const resume = previous?.phase === 'stopped' && previous.reviewWindow;
  const resumeSettings = resume && previous?.windowSnapshot
    ? { ...settings, nightlyStart: previous.windowSnapshot.nightlyStart, nightlyEnd: previous.windowSnapshot.nightlyEnd }
    : settings;
  return runNightlyCaptureSweep(userId, resume ? resume.ranForWindow : `manual-${now.toISOString()}`, resumeSettings, signal,
    { manual: true, reviewDay: resume
      ? { key: resume.reviewDay, start: new Date(resume.start), end: new Date(resume.end) }
      : manualNightlyReviewDay(now, settings) });
}

export interface RecallCaptureSweepLoopHandle {
  stop(): void;
}

/** The bounded disk task checks admission only. The sweep coordinator owns its
 * cancellation lifetime without holding the disk or model lane while it waits
 * for model tasks. Re-arm the loop after that work has settled. */
export function startNightlyCaptureSweepLoop(userId: string): RecallCaptureSweepLoopHandle {
  let scheduled: ScheduledBootBackgroundTask | null = null;
  let stopped = false;
  const scheduleNext = (delayMs: number): void => {
    let admitted: { windowKey: string; settings: RecallCaptureSettingsRecord } | undefined;
    scheduled = scheduleBootBackground('recall:nightly-sweep', async (signal) => {
      if (stopped || signal?.aborted) return;
      try {
        await migrateUnifiedDiscoverySettings(userId);
        const settings = await readRecallCaptureSettings(userId);
        if (!settings.enabled || settings.executionPolicy !== 'nightly') return;
        // 连续失败熔断：3 次后当天不再重试，等下一个窗口。
        const record = await readNightlySweepRecord(userId);
        if ((record?.consecutiveErrors || 0) >= 3 && record?.lastRunAt
          && Date.now() - Date.parse(record.lastRunAt) < 24 * 60 * 60_000) return;
        const windowKey = dueNightlyWindow(new Date(), settings, record);
        if (!windowKey || record?.heldWindow === captureBudgetWindowKey(new Date(), settings.nightlyStart)) return;
        if (!stopped && !signal?.aborted) admitted = { windowKey, settings };
      } catch (error) {
        log.warn('recall nightly sweep tick failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, delayMs, { resourceClass: 'disk', preferIdle: true, maxSliceMs: 20_000 });
    void scheduled.promise.then(async () => {
      if (stopped || !admitted) return;
      const { windowKey, settings } = admitted;
      let execution: Promise<unknown> | undefined;
      scheduled = scheduleBootBackground('recall:nightly-sweep-run', signal => {
        // Idle admission may outlast this window. Never process a different
        // day's range using the earlier check's window.
        if (stopped || signal?.aborted || dueNightlyWindow(new Date(), settings, undefined) !== windowKey) return;
        execution = runNightlyCaptureSweep(userId, windowKey, settings, signal);
        return execution.then(() => undefined);
      }, 0, { preferIdle: true });
      await scheduled.promise;
      // cancel() settles the scheduler handle before the model unwinds.
      // Keep ownership until checkpoint writes and in-flight work settle.
      await execution;
    }).catch(error => {
      log.warn('recall nightly sweep run failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      scheduled = null;
      if (!stopped) scheduleNext(NIGHTLY_SWEEP_TICK_MS);
    });
  };
  scheduleNext(0);
  return {
    stop() {
      stopped = true;
      scheduled?.cancel();
      scheduled = null;
    },
  };
}

/** Runtime lifecycle only; the daily sweep is the sole automatic producer. */
export function startRecallCaptureOrchestrator(): () => void {
  captureSchedulingEnabled = true;
  return () => {
    captureSchedulingEnabled = false;
    for (const task of scheduledCaptures.values()) task.cancel();
    scheduledCaptures.clear();
    captureScheduleAdmissions.clear();
  };
}
