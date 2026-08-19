import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { buildRunner } from '../../model/core-agent/runner';
import { safeId } from '../../storage';
import { scheduleBootBackground, type ScheduledBootBackgroundTask } from '../../util/boot_init';
import { getConfiguredModelOAuthExpiredMessage, hasConfiguredModel } from '../auth';
import * as chats from '../chats';
import type { ReviewDecision } from '../cognition/review-decision';
import { getRecallCandidateCapabilities, recallCandidateError } from './candidate-capabilities';
import type { PersonalProfileSyncResult, PersonalProfileTarget } from './personal-profile-sync';
import {
  run as runCliAgent,
} from '../local_agents/runner';
import { detectAll } from '../local_agents/registry';
import {
  isQuiescent,
  subscribeTaskTerminals,
  type TaskTerminalEvent,
  type TaskTerminalListener,
} from '../group_chat/bus';
import type { GroupMessage } from '../group_chat/visibility';
import { readAbilityAsset } from './asset-service';
import {
  isAutoCaptureEligible,
  autoApplyRecallCandidate,
  promoteRecallCandidate,
  readRecallAssetHandoffReceipt,
  readRecallCandidate,
  saveRecallCandidate,
  type AbilityAssetType,
  type RecallAssetHandoffReceipt,
  type RecallAbilityAssetRecord,
  type RecallCandidateRecord,
} from './candidate-service';
import { recallJsonRecordPath } from './paths';
import {
  cognitionArtifactSourceId,
  cognitionMessageSourceId,
  listCognitionSources,
} from './source-catalog';
import { readCognitionSourceControl } from './source-control';
import { createRecallView, isRecallViewExpired, readRecallView, type RecallViewRecord } from './recall-view-service';
import { prepareRecallSkillDraft } from './skill-draft-service';
import {
  readRecallJsonRecord,
  updateRecallJsonRecord,
} from './store';
import type { RecallJsonRecord } from './types';
import { listUserTeachingSignals } from './teaching-service';
import {
  isWithinNightlyWindow,
  nextNightlyRunAt,
  readRecallCaptureSettings,
  type RecallCaptureExecutionPolicy,
} from './capture-settings';
import {
  assessRecallCandidateClassification,
  assessRecallCaptureCandidateQuality,
  screenRecallCaptureValue,
  type RecallCaptureFilterReason,
  type RecallCaptureValueSignal,
} from './capture-value-screening';
import { isRecallAssistantMessage, isRecallConversationMessage } from './conversation-message-policy';

const log = createLogger('recall.capture');
const CAPTURE_COLLECTION = 'captures';
const MAX_CAPTURE_MESSAGES = 32;
const MAX_CAPTURE_TEXT_CHARS = 22_000;
const MAX_MODEL_CANDIDATES = 3;
async function prepareSkillDraftForPromotedAsset(
  userId: string,
  promoted: { candidate: RecallCandidateRecord; asset: RecallAbilityAssetRecord },
): Promise<void> {
  if (promoted.asset.type !== 'skill_method' || promoted.asset.status !== 'active') return;
  try {
    const draft = await prepareRecallSkillDraft(userId, promoted.asset.id);
    if (draft.status === 'failed') {
      log.warn('automatic Recall skill draft failed', {
        asset_id: promoted.asset.id,
        code: draft.errorCode,
      });
    }
  } catch (error) {
    log.warn('automatic Recall skill draft could not be prepared', {
      asset_id: promoted.asset.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

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
  | 'model_check'
  | 'recall_view'
  | 'model_extraction'
  | 'candidate_save'
  | 'asset_write';

export interface RecallCaptureModelUsage {
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
  writingCandidateId?: string;
  /** Persisted intent to write qualifying candidates without a later approval click. */
  autoWrite?: boolean;
  recallViewId?: string;
  errorCode?: string;
  recoveredAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  modelUsage?: RecallCaptureModelUsage;
  createdAt: string;
  updatedAt: string;
}

export type RecallCaptureWorkflowStatus = RecallCaptureStatus | 'completed';

export type RecallCaptureDisplayStatus =
  | 'waiting'
  | 'extracting'
  | 'review_ready'
  | 'writing'
  | 'completed'
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
  | 'model_not_configured'
  | 'model_auth_required'
  | 'asset_write_failed'
  | 'asset_write_interrupted'
  | 'capture_failed'
  | 'cancelled';

export type RecallCaptureAction =
  | 'run_now'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'review_candidates'
  | 'configure_model'
  | 'retry'
  | 'view_assets'
  | 'open_conversation';

export interface RecallCaptureReviewSummary {
  total: number;
  pending: number;
  deferred: number;
  promoted: number;
  rejected: number;
  missing: number;
}

export type RecallCaptureNextAction =
  | 'wait_quiet'
  | 'complete_conversation'
  | 'run_now'
  | 'wait_nightly'
  | 'wait_processing'
  | 'resume'
  | 'review_candidates'
  | 'configure_model'
  | 'retry'
  | 'view_assets'
  | 'none';

export interface RecallCaptureWorkflowRecord extends RecallCaptureRecord {
  workflowStatus: RecallCaptureWorkflowStatus;
  displayStatus: RecallCaptureDisplayStatus;
  displayReason: RecallCaptureDisplayReason;
  reviewSummary: RecallCaptureReviewSummary;
  linkedAssetIds: string[];
  confirmedAssetReceipts: RecallCaptureConfirmedAssetReceipt[];
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
}

export type RecallCaptureQueryStatus = RecallCaptureStatus | RecallCaptureDisplayStatus | 'completed';

export interface ListRecallCapturesQuery {
  statuses?: RecallCaptureQueryStatus[];
  executionPolicy?: RecallCaptureExecutionPolicy | 'immediate';
  cursor?: string;
  limit?: number;
}

export interface RecallCaptureCounts {
  waiting: number;
  processing: number;
  review: number;
  failed: number;
  completed: number;
  cancelled: number;
}

export interface RecallCapturePage {
  captures: RecallCaptureWorkflowRecord[];
  nextCursor: string | null;
  counts: RecallCaptureCounts;
}

export interface CapturePromptMessage {
  label: string;
  id: string;
  ts: string;
  role: 'user' | 'assistant';
  text: string;
  artifacts: Array<{ id: string; title: string; conversationId: string }>;
}

interface ParsedCandidate {
  judgment: string;
  value: string;
  valueProvided: boolean;
  summary: string;
  uncertainty?: string;
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
}

class CaptureFailure extends Error {
  constructor(readonly code: string, message: string) {
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
  return value === 'model_check'
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
  const visibility = isCaptureVisibility(value.visibility) ? value.visibility : legacyVisible ? 'visible' : 'internal';
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
  } as RecallCaptureRecord;
}

function captureId(conversationId: string, anchorMessageId: string): string {
  const digest = createHash('sha256')
    .update(`${conversationId}\0${anchorMessageId}`)
    .digest('hex')
    .slice(0, 24);
  return `rcap-${digest}`;
}

function manualConversationCaptureId(
  conversationId: string,
  finishedMessageId: string,
  retryNonce = '',
): string {
  const digest = createHash('sha256')
    .update(`${conversationId}\0manual-history\0${finishedMessageId}\0${retryNonce}`)
    .digest('hex')
    .slice(0, 24);
  return `rcap-${digest}`;
}

function quietScheduleAt(now: Date, quietMinutes: number): Date {
  return new Date(now.getTime() + quietMinutes * 60_000);
}

function nightlyScheduleAfterQuiet(
  now: Date,
  quietMinutes: number,
  nightlyStart: string,
  nightlyEnd: string,
): Date {
  const quietAt = quietScheduleAt(now, quietMinutes);
  return isWithinNightlyWindow(quietAt, nightlyStart, nightlyEnd)
    ? quietAt
    : nextNightlyRunAt(quietAt, nightlyStart, nightlyEnd);
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

function comparableCandidateText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
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
  const firstUserIndex = inRun.findIndex((message) => message.from === 'user');
  if (firstUserIndex < 0) return [];
  const fromFirstUser = inRun.slice(firstUserIndex);
  const selected = fromFirstUser.length <= MAX_CAPTURE_MESSAGES
    ? fromFirstUser
    : [fromFirstUser[0], ...fromFirstUser.slice(-(MAX_CAPTURE_MESSAGES - 1))];

  const firstCap = selected.length === 1 ? MAX_CAPTURE_TEXT_CHARS : 6_000;
  const lastCap = selected.length === 1 ? MAX_CAPTURE_TEXT_CHARS : 8_000;
  const middleCount = Math.max(0, selected.length - 2);
  const middleCap = middleCount
    ? Math.max(200, Math.floor((MAX_CAPTURE_TEXT_CHARS - firstCap - lastCap) / middleCount))
    : 0;

  return selected.map((message, index) => {
    const cap = index === 0 ? firstCap : index === selected.length - 1 ? lastCap : middleCap;
    return {
      label: `m${index + 1}`,
      id: message.id,
      ts: message.ts,
      role: isRecallAssistantMessage(message) ? 'assistant' : 'user',
      text: truncateText(message.text, cap),
      artifacts: (message.artifacts || []).slice(0, 10).map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        conversationId: artifact.source_cid || '',
      })),
    };
  });
}

function boundedRequiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new CaptureFailure('invalid_model_output', `missing ${field}`);
  const text = value.replace(/\s+/g, ' ').trim();
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

function parseCandidateType(value: unknown): AbilityAssetType {
  if (value === 'personal' || value === 'rule' || value === 'template' || value === 'skill_method') return value;
  throw new CaptureFailure('invalid_model_output', 'invalid suggestedType');
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

/**
 * 解析结果的**完整事实**，而不只是候选数组。
 *
 * 旧口径只交出候选数组，于是调用方无法区分三件事：模型显式判空、模型给了候选
 * 但全被逐条丢弃、模型压根没给 candidates 键。这三种在实机上都会落成同一个
 * `model_no_candidate`，「为什么这次没抽出来」在系统里没有任何地方记着。
 *
 * `emittedCount` 是模型**声称**产出的候选数，`candidates` 是我们真正接住的。
 * 两者不等就说明是解析侧丢了东西，不是内容里没有。
 */
export interface RecallCaptureParseResult {
  candidates: ParsedCandidate[];
  /** 模型在 `candidates` 数组里给出的原始条目数（含随后被丢弃的）。 */
  emittedCount: number;
  /** 模型显式判空时给出的理由（提示词要求随空数组一并返回）。 */
  noCandidateReason?: string;
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
  const candidates = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length > MAX_MODEL_CANDIDATES) {
    throw new CaptureFailure('invalid_model_output', 'invalid candidate count');
  }

  // 逐候选容错：LLM 输出里单个候选字段非法（如 suggestedType: "method"）
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

/** 只要候选数组的旧口径。保留是因为它是纯函数、被多处单测直接断言。 */
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
    judgment: boundedRequiredText(candidate.judgment, 'judgment', 4_000),
    value: valueProvided ? boundedRequiredText(candidate.value, 'value', 1_000) : '',
    valueProvided,
    summary: boundedRequiredText(candidate.summary, 'summary', 1_000),
    ...(uncertainty ? { uncertainty } : {}),
    suggestedType: parseCandidateType(candidate.suggestedType),
      ...parseCandidateBoundaries(candidate),
    suggestedScope: boundedRequiredText(candidate.suggestedScope, 'suggestedScope', 500),
    ...(candidate.suggestedAction === undefined ? {} : { suggestedAction: parseCandidateAction(candidate.suggestedAction) }),
    actionProvided,
    ...(candidate.risk === undefined ? {} : { risk: parseCandidateRisk(candidate.risk) }),
    ...(targetAssetId ? { targetAssetId } : {}),
    evidence,
  };

}

/** 读模型给出的边界短语。非数组/空串一律忽略，宁可留空也不编造边界。 */
function parseCandidateBoundaries(candidate: Record<string, unknown>): {
  applicableWhen?: string[];
  forbiddenWhen?: string[];
} {
  const read = (raw: unknown): string[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const items = raw
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0)
      .slice(0, 10)
      .map((item) => item.slice(0, 300));
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
    'You extract durable, user-reviewable knowledge from one completed conversation run.',
    'Return exactly one JSON object and no markdown or commentary.',
    'Schema: {"candidates":[{"judgment":"what to retain","value":"how this reduces future repetition or risk","summary":"short title","suggestedType":"personal|rule|template|skill_method","suggestedScope":"...","applicableWhen":["required for rule"],"forbiddenWhen":["required for rule"],"suggestedAction":"create|update|limit_scope|pause|keep_current|reject","targetAssetId":"required for update, limit_scope, or pause","risk":"low|medium|high","evidence":["m1"],"uncertainty":"optional"}]}',
    'Return at most 3 candidates.',
    // 空返回也要说明白为什么。没有这句，实机上「这次没抽出来」在系统里没有
    // 任何解释，用户无法判断是抽对了还是抽漏了。
    'When nothing is durable enough, return {"candidates":[],"reason":"one short sentence, in the language of the conversation, saying what was missing"}.',
    // 四类定义与硬边界（PRD 3.1/3.2/3.3）。缺了这段，模型只能靠四个英文枚举
    // 词自行猜测，项目事实会被写成 personal、原文件会被写成 template。
    'suggestedType must answer one of four questions, and each has contents that are explicitly excluded:',
    '- personal: "What is durably true about this user?" Identity, role, long-term preference, stable relationship, long-term environment, boundary. EXCLUDED: current task progress, the current sprint or milestone, a meeting or schedule, a temporary contact relationship, any project fact. Those stay with the project, not with the person.',
    '- rule: "Under what condition should which judgment or behaviour hold?" A complete rule has a condition, a principle, and a boundary. EXCLUDED: a bare preference with no condition ("likes concise"), and one-off instructions for this task only.',
    'For a rule candidate you MUST also return applicableWhen and forbiddenWhen: short concrete phrases for when it applies and where it must not be used. A rule without both cannot become a formal asset. Do not invent a boundary the messages do not support — drop the candidate instead.',
    '- template: "Is there a structure that can be applied again next time?" Document skeletons, checklists, section structures, reusable fragments, output schemas. EXCLUDED: the source file itself. A PRD.docx stays a source file; only the reusable structure extracted from it can be a template.',
    '- skill_method: "Is there an executable, checkable method here?" It must be able to state a trigger, inputs, an ordered action plan, outputs, and how the result is validated. EXCLUDED: capability claims such as "I am good at writing PRDs", and single one-step actions.',
    'When the content does not satisfy the type it would need, drop it rather than forcing it into the closest type.',
    'judgment must BE the reusable content itself, never a verdict about the candidate. "Useful and reusable" or "valuable, shows what the user expects" are judgements about your own extraction, not knowledge — drop those instead of emitting them.',
    'Never emit the same judgment under two different suggestedType values. Pick the one type it actually satisfies, or drop it.',
    'Only extract reusable preferences, constraints, decisions, templates, or methods supported by the supplied messages.',
    'Each candidate must state a concrete future value and an explicit suggestedAction; do not restate its summary as value.',
    'Every candidate must cite at least one user message. Short acknowledgements, greetings, status checks, and failed work are not candidates.',
    'Write candidate text in the same language as the conversation.',
    'Do not invent facts. Every candidate must cite at least one supplied message label.',
  ].join('\n');
}

function extractionInput(
  conversationTitle: string,
  messages: CapturePromptMessage[],
  recallView: RecallViewRecord,
): string {
  return JSON.stringify({
    conversation: { title: conversationTitle },
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
    messages: messages.map((message) => ({
      label: message.label,
      role: message.role,
      ts: message.ts,
      text: message.text,
      ...(message.artifacts.length
        ? { artifacts: message.artifacts.map(({ id, title }) => ({ id, title })) }
        : {}),
    })),
  });
}

/** CLI-based extraction fallback for recall capture when no CogSeed model is
 *  configured. Mirrors onboarding's `cognition_extraction.ts`: pick an
 *  installed/authenticated local CLI (claude preferred, else first available),
 *  dispatch a one-shot print-mode turn with the extraction prompt + input, and
 *  return the CLI's final text. Returns null when no CLI is usable. */
async function extractCaptureViaCli(
  userId: string,
  capture: RecallCaptureRecord,
  conversation: Awaited<ReturnType<typeof chats.getConversation>>,
  promptMessages: CapturePromptMessage[],
  recallView: RecallViewRecord,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const entries = await detectAll();
  const available = entries.filter((e) => e && e.available);
  if (!available.length) return null;
  const chosen = available.find((e) => e.type === 'claude') ?? available[0];
  const input = extractionInput(conversation?.title || capture.conversationTitle || '', promptMessages, recallView);
  const prompt =
    `You extract durable, user-reviewable knowledge from one completed conversation run.\n` +
    `Analyze the JSON conversation below and return exactly ONE JSON object and no markdown or commentary:\n` +
    `Schema: {"candidates":[{"judgment":"what to retain","value":"how this reduces future repetition or risk","summary":"short title","suggestedType":"personal|rule|template|skill_method","suggestedScope":"...","suggestedAction":"create|update|limit_scope|pause|keep_current|reject","targetAssetId":"required for update, limit_scope, or pause","risk":"low|medium|high","evidence":["m1"],"uncertainty":"optional"}]}\n` +
    `Return at most 3 candidates. Return {"candidates":[]} when nothing is durable enough.\n` +
    `Only extract reusable preferences, constraints, decisions, templates, or methods supported by the supplied messages.\n` +
    `Each candidate must cite at least one user message label in "evidence". Do not invent facts.\n` +
    `Write candidate text in the same language as the conversation.\n\n` +
    `## Conversation JSON\n${input}`;

  const controller = new AbortController();
  const relayAbort = (): void => controller.abort();
  signal?.addEventListener('abort', relayAbort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const result = await runCliAgent({
      uid: userId,
      cid: capture.conversationId,
      agentId: 'recall-capture-extractor',
      agentName: 'Capture Extractor',
      cli: chosen.type,
      prompt,
      cwd: os.tmpdir(),
      signal: controller.signal,
      skipDispatchCheck: true,
      onEvent: () => {},
    });
    if (signal?.aborted) return null;
    if (result.status !== 'completed' || typeof result.output !== 'string' || !result.output.trim()) {
      log.warn('recall capture CLI extraction did not complete', {
        conversation_id: capture.conversationId,
        cli: chosen.type,
        status: result.status,
        error: result.error,
      });
      return null;
    }
    return result.output.trim();
  } finally {
    signal?.removeEventListener('abort', relayAbort);
  }
}

/** Older builds used the historical-selection entry point as an automatic
 * write path. Once that task was persisted as `queued + autoWrite`, a restart
 * could silently extract and write it without the user clicking "立即执行".
 * Convert only an untouched legacy wait; tasks that already have candidates or
 * are in a write/extract stage remain recoverable on their existing path.
 */
function isLegacyHistoricalAutomaticWait(capture: RecallCaptureRecord): boolean {
  return capture.status === 'queued'
    && capture.executionPolicy === 'manual'
    && capture.autoWrite === true
    && capture.candidateIds.length === 0
    && capture.writingCandidateId === undefined
    && capture.stage === undefined
    && capture.startedAt === undefined;
}

async function migrateLegacyHistoricalAutomaticWait(
  userId: string,
  capture: RecallCaptureRecord,
): Promise<RecallCaptureRecord> {
  if (!isLegacyHistoricalAutomaticWait(capture)) return capture;
  const now = new Date().toISOString();
  return updateCapture(userId, capture.id, (current) => {
    if (!isLegacyHistoricalAutomaticWait(current)) return current;
    return {
      ...current,
      status: 'waiting_manual',
      visibility: 'visible',
      screeningStatus: 'qualified',
      screeningSignals: ['manual_selection'],
      screenedAt: current.screenedAt || now,
      scheduledFor: undefined,
      resumeStatus: undefined,
      autoWrite: undefined,
      errorCode: undefined,
      recoveredAt: undefined,
      updatedAt: now,
    };
  });
}

export async function readRecallCapture(userId: string, id: string): Promise<RecallCaptureRecord> {
  if (!safeId(id)) throw new Error('invalid recall capture id');
  const record = await readRecallJsonRecord(userId, CAPTURE_COLLECTION, id);
  if (!record) throw new Error('recall capture not found');
  let capture = asCapture(record);
  capture = await migrateLegacyHistoricalAutomaticWait(userId, capture);
  // Older builds returned an error from runNow before persisting the source
  // failure, leaving a task in `queued` with a permanent source error. Migrate
  // that impossible combination on read so it cannot be scheduled or rendered
  // as if extraction were still pending. The source/candidates are untouched.
  if (capture.status === 'queued'
    && (capture.errorCode === 'source_removed' || capture.errorCode === 'source_paused')) {
    const now = new Date().toISOString();
    return asCapture(await updateRecallJsonRecord(userId, CAPTURE_COLLECTION, id, (current) => {
      if (!current) return record;
      const latest = asCapture(current);
      if (latest.status !== 'queued'
        || (latest.errorCode !== 'source_removed' && latest.errorCode !== 'source_paused')) return latest;
      return {
        ...latest,
        status: 'paused',
        stage: undefined,
        resumeStatus: 'queued',
        updatedAt: now,
      };
    }));
  }
  return capture;
}

function candidateUnavailableForWorkflow(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === 'recall candidate not found'
    || error.message.startsWith('malformed recall candidate')
    || error.message.startsWith('malformed recall record:');
}

function abilityAssetUnavailableForWorkflow(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === 'recall ability asset not found'
    || error.message.startsWith('malformed recall ability asset')
    || error.message.startsWith('malformed recall record:');
}

function confirmedAssetReceipt(
  candidate: RecallCandidateRecord,
  asset: RecallAbilityAssetRecord,
  receipt: RecallAssetHandoffReceipt,
): RecallCaptureConfirmedAssetReceipt | undefined {
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
): RecallCaptureNextAction {
  if (workflowStatus === 'completed') return linkedAssetIds.length ? 'view_assets' : 'none';
  if (workflowStatus === 'waiting_quiet') return 'wait_quiet';
  if (workflowStatus === 'waiting_completion') return 'complete_conversation';
  if (workflowStatus === 'waiting_manual') return 'run_now';
  if (workflowStatus === 'scheduled') return 'wait_nightly';
  if (workflowStatus === 'queued' || workflowStatus === 'extracting' || workflowStatus === 'writing') return 'wait_processing';
  // A removed source cannot be resumed locally: reading it again would only
  // requeue the task and immediately fail. Keep the task visible for audit and
  // let the user reconnect/select a new source before creating another task.
  if (workflowStatus === 'paused') return capture.errorCode === 'source_removed' ? 'none' : 'resume';
  if (workflowStatus === 'review_ready') return 'review_candidates';
  if (workflowStatus === 'configuration_required') return 'configure_model';
  if (workflowStatus === 'failed') return 'retry';
  if (capture.status === 'no_candidate' || workflowStatus === 'cancelled') return 'none';
  return 'none';
}

function captureDisplayStatus(
  capture: RecallCaptureRecord,
  workflowStatus: RecallCaptureWorkflowStatus,
): RecallCaptureDisplayStatus {
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
): RecallCaptureAction[] {
  const actions: RecallCaptureAction[] = [];
  if (['waiting_quiet', 'waiting_manual', 'scheduled'].includes(capture.status)
    || (capture.status === 'paused' && capture.errorCode !== 'source_removed')) {
    actions.push('run_now');
  }
  if (['waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled', 'queued', 'extracting'].includes(capture.status)
    && !(capture.status === 'extracting' && capture.stage === 'candidate_save')) {
    actions.push('pause');
  }
  if (capture.status === 'paused' && capture.errorCode !== 'source_removed') actions.push('resume');
  if (workflowStatus === 'configuration_required') actions.push('configure_model', 'retry');
  else if (workflowStatus === 'failed') actions.push('retry');
  if (workflowStatus === 'review_ready') actions.push('review_candidates');
  if (workflowStatus === 'completed' && linkedAssetIds.length) actions.push('view_assets');
  if (!['review_ready', 'no_candidate', 'writing', 'cancelled', 'completed'].includes(workflowStatus)
    && !(capture.status === 'extracting' && capture.stage === 'candidate_save')) {
    actions.push('cancel');
  }
  actions.push('open_conversation');
  return [...new Set(actions)];
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
    const reviewSummary: RecallCaptureReviewSummary = {
      total: 0,
      pending: 0,
      deferred: 0,
      promoted: 0,
      rejected: 0,
      missing: 0,
    };
    const linkedAssetIds = new Set<string>();
    const confirmedAssetReceipts: RecallCaptureConfirmedAssetReceipt[] = [];
    for (const candidate of candidates) {
      if (!candidate) {
        reviewSummary.total += 1;
        reviewSummary.missing += 1;
        continue;
      }
      // 复核摘要按 capability 计数，不按 raw status 列举：实机上多数候选是
      // weak_observation，旧写法把它们整条排除，用户看到的 pending 恒为 0。
      // 既不需要用户处理、又还没走完的（证据不足的弱观察）仍然不进摘要。
      const capability = getRecallCandidateCapabilities(candidate);
      // 稍后处理是用户自己按下的静音，这份摘要里继续保持安静（既有行为）。
      if (capability.isSnoozed) continue;
      if (!capability.countsAsPending && !capability.isTerminal) continue;
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
      } else if (candidate.status === 'ignored' || candidate.status === 'expired') reviewSummary.rejected += 1;
      else reviewSummary[candidate.status] += 1;
    }

    let workflowStatus: RecallCaptureWorkflowStatus = capture.status;
    if (capture.status === 'completed') {
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
      && reviewSummary.promoted + reviewSummary.rejected === reviewSummary.total
    ) {
      workflowStatus = 'completed';
    }
    const linkedAssets = [...linkedAssetIds];
    const displayStatus = captureDisplayStatus(capture, workflowStatus);
    return {
      ...capture,
      workflowStatus,
      displayStatus,
      displayReason: captureDisplayReason(capture, workflowStatus),
      reviewSummary,
      linkedAssetIds: linkedAssets,
      confirmedAssetReceipts,
      nextAction: captureNextAction(capture, workflowStatus, linkedAssets),
      actions: captureActions(capture, workflowStatus, linkedAssets),
    };
  }));
}

export async function readRecallCaptureWorkflow(
  userId: string,
  id: string,
): Promise<RecallCaptureWorkflowRecord> {
  const [capture] = await summarizeRecallCaptures(userId, [await readRecallCapture(userId, id)]);
  return capture;
}

async function listAllRecallCaptures(userId: string): Promise<RecallCaptureRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(captureDirectory(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map((name) => readRecallJsonRecord(userId, CAPTURE_COLLECTION, name.slice(0, -5))));
  return records
    .filter((record): record is RecallJsonRecord => Boolean(record))
    .map(asCapture)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
}

const MERGEABLE_AUTOMATIC_STATUSES = new Set<RecallCaptureStatus>([
  'waiting_quiet',
  'waiting_completion',
  'waiting_manual',
  'scheduled',
  'paused',
]);

async function findMergeableAutomaticCapture(
  userId: string,
  conversationId: string,
  executionPolicy?: 'smart' | 'nightly',
): Promise<RecallCaptureRecord | undefined> {
  return (await listAllRecallCaptures(userId)).find((capture) => (
    capture.conversationId === conversationId
    && (capture.executionPolicy === 'smart' || capture.executionPolicy === 'nightly')
    && (!executionPolicy || capture.executionPolicy === executionPolicy)
    && MERGEABLE_AUTOMATIC_STATUSES.has(capture.status)
  ));
}

export async function listRecallCaptures(userId: string, limit = 20): Promise<RecallCaptureWorkflowRecord[]> {
  const wanted = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  const visible = (await listAllRecallCaptures(userId)).filter((capture) => capture.visibility === 'visible');
  return summarizeRecallCaptures(userId, visible.slice(0, wanted));
}

function captureCounts(captures: RecallCaptureWorkflowRecord[]): RecallCaptureCounts {
  return captures.reduce<RecallCaptureCounts>((counts, capture) => {
    if (capture.displayStatus === 'extracting' || capture.displayStatus === 'writing') counts.processing += 1;
    else if (capture.displayStatus === 'review_ready') counts.review += 1;
    else if (capture.displayStatus === 'failed') counts.failed += 1;
    else if (capture.displayStatus === 'completed') counts.completed += 1;
    else if (capture.displayStatus === 'cancelled') counts.cancelled += 1;
    else counts.waiting += 1;
    return counts;
  }, { waiting: 0, processing: 0, review: 0, failed: 0, completed: 0, cancelled: 0 });
}

const DISPLAY_CAPTURE_STATUSES = new Set<RecallCaptureDisplayStatus>([
  'waiting', 'extracting', 'review_ready', 'writing', 'completed', 'failed', 'cancelled',
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
  const visible = (await listAllRecallCaptures(userId)).filter((capture) => capture.visibility === 'visible');
  const all = await summarizeRecallCaptures(userId, visible);
  const counts = captureCounts(all);
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
    captures,
    counts,
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
        updatedAt: new Date().toISOString(),
      }
    : current);
}

type RecallCaptureControlRequest = 'pause' | 'cancel';
const captureControlRequests = new Map<string, RecallCaptureControlRequest>();

function captureTaskKey(userId: string, id: string): string {
  return `${userId}:${id}`;
}

function durationSince(startedAt: string | undefined, finishedAt: string): number | undefined {
  if (!startedAt) return undefined;
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
}

async function settleInterruptedCapture(userId: string, id: string): Promise<RecallCaptureRecord> {
  const key = captureTaskKey(userId, id);
  const requested = captureControlRequests.get(key);
  captureControlRequests.delete(key);
  if (!requested) return requeueInterruptedCapture(userId, id);
  return updateCapture(userId, id, (current) => {
    if (current.status === 'paused' || current.status === 'cancelled') return current;
    const now = new Date().toISOString();
    if (requested === 'cancel') {
      return {
        ...current,
        status: 'cancelled',
        stage: undefined,
        resumeStatus: undefined,
        errorCode: undefined,
        finishedAt: now,
        durationMs: durationSince(current.startedAt, now),
        updatedAt: now,
      };
    }
    return {
      ...current,
      status: 'paused',
      stage: undefined,
      resumeStatus: 'queued',
      errorCode: undefined,
      updatedAt: now,
    };
  });
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

async function loadStoredPromptMessages(
  userId: string,
  capture: RecallCaptureRecord,
): Promise<CapturePromptMessage[]> {
  const allMessages = await chats.getMessages(userId, capture.conversationId, 2_000);
  const byId = new Map(allMessages.filter(isRecallConversationMessage).map((message) => [message.id, message]));
  const selected = capture.messageIds.map((id) => byId.get(id)).filter((message): message is GroupMessage => Boolean(message));
  if (!selected.length || selected[0].from !== 'user') {
    throw new CaptureFailure('source_unavailable', 'capture messages are unavailable');
  }
  return selectCaptureMessages(selected, 0, Number.MAX_SAFE_INTEGER).map((message) => ({
    ...message,
    artifacts: message.artifacts.map((artifact) => ({
      ...artifact,
      conversationId: artifact.conversationId || capture.conversationId,
    })),
  }));
}

async function screenQueuedRecallCapture(
  userId: string,
  id: string,
  capture: RecallCaptureRecord,
): Promise<RecallCaptureRecord> {
  if (capture.executionPolicy === 'manual' || capture.screeningStatus === 'qualified') return capture;
  let promptMessages: CapturePromptMessage[];
  try {
    promptMessages = await loadStoredPromptMessages(userId, capture);
  } catch {
    const finishedAt = new Date().toISOString();
    return updateCapture(userId, id, (current) => current.status !== 'queued'
      ? current
      : {
          ...current,
          status: 'failed',
          visibility: 'internal',
          errorCode: 'source_unavailable',
          finishedAt,
          updatedAt: finishedAt,
        });
  }
  const screening = screenRecallCaptureValue(promptMessages);
  const screenedAt = new Date().toISOString();
  return updateCapture(userId, id, (current) => current.status !== 'queued'
    ? current
    : screening.eligible
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
}

function isSettledAutomaticCandidate(candidate: Pick<RecallCandidateRecord, 'status'>): boolean {
  return ['rejected', 'ignored', 'expired'].includes(candidate.status);
}

async function automaticallyApplyReviewableCandidates(
  userId: string,
  candidateIds: Iterable<string>,
): Promise<{
  resolved: Map<string, RecallCandidateRecord>;
  failedCandidateIds: string[];
  /** 自动写入被安全机制挡下（不是失败）：候选原封不动留在池子里等人工确认。 */
  deferredCandidateIds: string[];
}> {
  const resolved = new Map<string, RecallCandidateRecord>();
  const failedCandidateIds: string[] = [];
  const deferredCandidateIds: string[] = [];
  for (const candidateId of new Set(candidateIds)) {
    try {
      // Read immediately before applying. A prior run or a concurrent user
      // decision may already have settled this candidate.
      const candidate = await readRecallCandidate(userId, candidateId);
      resolved.set(candidate.id, candidate);
      if (isSettledAutomaticCandidate(candidate)) continue;
      if (candidate.status === 'confirmed') {
        // A complete handoff is already settled. Only re-enter the recovery
        // path when the persisted asset or immutable receipt is missing.
        if (candidate.promotedAssetId && candidate.reviewDecisionId) {
          let asset: RecallAbilityAssetRecord | undefined;
          let receipt: RecallAssetHandoffReceipt | undefined;
          try { asset = await readAbilityAsset(userId, candidate.promotedAssetId); } catch { asset = undefined; }
          try { receipt = await readRecallAssetHandoffReceipt(userId, candidate.id, candidate.reviewDecisionId); } catch { receipt = undefined; }
          if (asset && receipt && confirmedAssetReceipt(candidate, asset, receipt)) continue;
        } else {
          continue;
        }
        const applied = await autoApplyRecallCandidate(userId, candidate.id);
        resolved.set(applied.candidate.id, applied.candidate);
        if (applied.asset) await prepareSkillDraftForPromotedAsset(userId, {
          candidate: applied.candidate,
          asset: applied.asset,
        });
        continue;
      }
      if (!isAutoCaptureEligible(candidate)) continue;
      if (candidate.risk === 'high') continue;

      const applied = await autoApplyRecallCandidate(userId, candidate.id);
      resolved.set(applied.candidate.id, applied.candidate);
      if (applied.asset) await prepareSkillDraftForPromotedAsset(userId, {
        candidate: applied.candidate,
        asset: applied.asset,
      });
    } catch (error) {
      // 语义查重不可用不是写入失败：候选没被动过，仍然可以人工确认。把它记成
      // 失败会让整次沉淀显示成错误并催用户重试，而重试同样查不了重。
      // 两类"挡下"都不是写入失败：候选没被动过，仍然可以人工确认。
      //   semantic_dedup_unavailable  查重做不了，不能当作"查过且干净"
      //   promotion_blocked           没到该类型的正式准入门槛（PRD 3.1）
      // 记成失败会让整次沉淀显示成错误并催用户重试，而重试同样过不了。
      const code = (error as { code?: string })?.code;
      if (code === 'semantic_dedup_unavailable' || code === 'promotion_blocked') {
        deferredCandidateIds.push(candidateId);
        continue;
      }
      // Continue so one blocked or temporarily failed candidate cannot prevent
      // independent later candidates from reaching their terminal state.
      failedCandidateIds.push(candidateId);
    }
  }
  return { resolved, failedCandidateIds, deferredCandidateIds };
}

export async function runRecallCapture(
  userId: string,
  id: string,
  signal?: AbortSignal,
): Promise<RecallCaptureRecord> {
  let queued = await readRecallCapture(userId, id);
  if (queued.status !== 'queued') return queued;
  const sourceControl = await readCognitionSourceControl(userId, {
    kind: 'conversation',
    id: queued.conversationId,
  });
  if (sourceControl && sourceControl.availability !== 'active') {
    return updateCapture(userId, id, (current) => current.status !== 'queued'
      ? current
      : {
          ...current,
          status: 'paused',
          resumeStatus: 'queued',
          errorCode: sourceControl.availability === 'removed' ? 'source_removed' : 'source_paused',
          updatedAt: new Date().toISOString(),
        });
  }
  queued = await screenQueuedRecallCapture(userId, id, queued);
  if (queued.status !== 'queued') return queued;
  let claimed = false;
  const startedAt = new Date().toISOString();
  let capture = await updateCapture(userId, id, (current) => ({
    ...(current.status === 'queued' ? (() => {
      claimed = true;
      return {
        ...current,
        status: 'extracting' as const,
        stage: 'model_check' as const,
        errorCode: undefined,
        startedAt,
        finishedAt: undefined,
        durationMs: undefined,
        modelUsage: undefined,
        updatedAt: startedAt,
      };
    })() : current),
  }));
  if (!claimed) return capture;

  try {
    if (signal?.aborted) return settleInterruptedCapture(userId, id);
    if ((hasConfiguredModel().configured || process.env.ANTHROPIC_API_KEY)
      && getConfiguredModelOAuthExpiredMessage()) {
      throw new CaptureFailure('model_auth_required', 'model authorization is required');
    }
    capture = await setCaptureStage(userId, id, 'recall_view');
    if (capture.status !== 'extracting' || signal?.aborted) return settleInterruptedCapture(userId, id);
    let conversation: Awaited<ReturnType<typeof chats.getConversation>>;
    let promptMessages: CapturePromptMessage[];
    try {
      [conversation, promptMessages] = await Promise.all([
        chats.getConversation(userId, capture.conversationId),
        loadStoredPromptMessages(userId, capture),
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

    let recallView: RecallViewRecord | undefined;
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
          ...promptMessages.map((message) => ({
            kind: 'conversation' as const,
            subtype: 'message' as const,
            scope: 'conversation' as const,
            id: cognitionMessageSourceId(capture.conversationId, message.id),
            sourceVersion: message.ts,
          })),
          ...promptMessages.flatMap((message) => message.artifacts.map((artifact) => ({
            kind: 'artifact_file' as const,
            subtype: 'artifact' as const,
            scope: 'conversation' as const,
            id: cognitionArtifactSourceId(artifact.conversationId || capture.conversationId, artifact.id),
            title: artifact.title,
            sourceVersion: message.ts,
          }))),
          ...executionGroups.flatMap((group) => group.items),
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
    } catch {
      throw new CaptureFailure('recall_view_failed', 'recall view could not be created');
    }

    capture = await setCaptureStage(userId, id, 'model_extraction');
    if (capture.status !== 'extracting' || signal?.aborted) return settleInterruptedCapture(userId, id);

    // No-model CLI fallback: when the user has no CogSeed API model (commander
    // already routes to local CLI agents), drive the extraction through an
    // installed/authenticated local CLI instead of failing with
    // model_not_configured. This keeps the capture→candidate→confirm loop
    // working in the exact setup that motivated CLI fallback.
    let extractionText: string;
    let extractionModelUsage: RecallCaptureModelUsage | undefined;
    if (!hasConfiguredModel().configured && !process.env.ANTHROPIC_API_KEY) {
      try {
        const cliText = await extractCaptureViaCli(
          userId,
          capture,
          conversation,
          promptMessages,
          recallView,
          signal,
        );
        if (cliText === null) {
          throw new CaptureFailure('model_not_configured', 'model configuration is required (no local CLI available)');
        }
        extractionText = cliText;
      } catch (err) {
        if (err instanceof CaptureFailure) throw err;
        throw new CaptureFailure('model_failed', `CLI extraction failed: ${(err as Error).message}`);
      }
    } else {
      let runner: Awaited<ReturnType<typeof buildRunner>>['runner'];
      try {
        ({ runner } = await buildRunner({
          sessionId: `memory-extract-recall-${capture.id}`,
          userId,
          systemPrompt: extractionSystemPrompt(),
          disableTools: true,
          ephemeralSession: true,
          skillList: [],
        }));
      } catch {
        throw new CaptureFailure('model_failed', 'model runner could not be built');
      }
      let result: Awaited<ReturnType<typeof runner.run>>;
      const modelController = new AbortController();
      const relayAbort = (): void => modelController.abort();
      signal?.addEventListener('abort', relayAbort, { once: true });
      if (signal?.aborted) modelController.abort();
      try {
        result = await runner.run({
          message: extractionInput(conversation.title, promptMessages, recallView),
          signal: modelController.signal,
          thinkingLevel: 'off',
          cacheRetention: 'none',
        });
      } catch {
        if (signal?.aborted) return settleInterruptedCapture(userId, id);
        throw new CaptureFailure('model_failed', 'model extraction failed');
      } finally {
        signal?.removeEventListener('abort', relayAbort);
      }
      if (signal?.aborted) return settleInterruptedCapture(userId, id);
      if (result.meta.aborted) throw new CaptureFailure('model_failed', 'model extraction was aborted');
      if (result.meta.error) {
        const code = result.meta.error.kind === 'auth'
          ? 'model_auth_required'
          : result.meta.error.kind === 'timeout'
            ? 'model_timeout'
            : 'model_failed';
        throw new CaptureFailure(code, result.meta.error.message);
      }
      extractionText = result.text.trim();
      extractionModelUsage = normalizeModelUsage(result.meta.usage);
    }
    let parseResult: RecallCaptureParseResult;
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
      throw error;
    }
    const parsed = parseResult.candidates;
    capture = await setCaptureStage(userId, id, 'candidate_save');
    if (capture.status !== 'extracting') return capture;
    const automaticMode = capture.autoWrite === true || (
      capture.executionPolicy !== 'manual'
      && (await readRecallCaptureSettings(userId)).reviewPolicy === 'auto'
    );
    const byLabel = new Map(promptMessages.map((message) => [message.label, message]));
    const candidates: RecallCandidateRecord[] = [];
    // Once an automatic task reaches writing, these ids are the durable replay
    // set. Preserve them even if a retry's model output is not byte-identical.
    const automaticallyEligibleCandidateIds = new Set<string>(
      capture.autoWrite === true ? capture.candidateIds : [],
    );
    for (const [index, candidate] of parsed.entries()) {
      const evidenceMessages = candidate.evidence.map((label) => byLabel.get(label)!);
      const quality = assessRecallCaptureCandidateQuality(candidate, evidenceMessages);
      // 归类校验：提示词只能"要求"模型按四类定义分类，兜底靠这里。命中 PRD
      // 明确排除的内容（项目事实当 personal、原文件当 template、能力自述当
      // skill_method）时降级为弱观察，不进 pending_review。
      const classification = assessRecallCandidateClassification(candidate);
      if (!classification.ok) {
        log.info('recall capture candidate misclassified', {
          captureId: capture.id,
          suggestedType: candidate.suggestedType,
          reasons: classification.blockingReasons,
        });
      }
      const requiresManualRiskGate = quality.reviewable
        && classification.ok
        && quality.automaticIneligibilityReasons.includes('high_risk_requires_review');
      const retainForReview = classification.ok
        && (!automaticMode || quality.automaticEligible || requiresManualRiskGate);
      const teachingSignals = activeTeachingSignals.filter((signal) => (
        evidenceMessages.some((message) => message.id === signal.messageId)
      ));
      if (quality.reviewable && teachingSignals.length) {
        const teachingCandidateIds = [...new Set(teachingSignals.flatMap((signal) => signal.candidateIds))];
        const existing = await Promise.all(teachingCandidateIds.map(async (candidateId) => {
          try { return await readRecallCandidate(userId, candidateId); }
          catch { return undefined; }
        }));
        const matching = existing.find((current) => current && (
          comparableCandidateText(current.judgment) === comparableCandidateText(candidate.judgment)
        ));
        if (matching) {
          const retainMatching = quality.reviewable
            && retainForReview
            && isAutoCaptureEligible(matching);
          if (retainMatching) {
            candidates.push(matching);
            if (quality.automaticEligible) automaticallyEligibleCandidateIds.add(matching.id);
            else automaticallyEligibleCandidateIds.delete(matching.id);
          }
          if (isAutoCaptureEligible(matching) || matching.status === 'confirmed') continue;
        }
      }
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
      try {
        const storedCandidate = await saveRecallCandidate(userId, {
          judgment: candidate.judgment,
          value: candidate.value,
          summary: candidate.summary,
          ...(candidate.uncertainty ? { uncertainty: candidate.uncertainty } : {}),
          suggestedType: candidate.suggestedType,
          suggestedScope: candidate.suggestedScope,
          ...(candidate.suggestedAction ? { suggestedAction: candidate.suggestedAction } : {}),
          ...(candidate.risk ? { risk: candidate.risk } : {}),
          ...(candidate.targetAssetId ? { targetAssetId: candidate.targetAssetId } : {}),
          ...(candidate.applicableWhen ? { applicableWhen: candidate.applicableWhen } : {}),
          ...(candidate.forbiddenWhen ? { forbiddenWhen: candidate.forbiddenWhen } : {}),
          forceWeakObservation: !quality.reviewable || !classification.ok || (automaticMode && !quality.automaticEligible && !requiresManualRiskGate),
          captureKey: `capture-${capture.id}-${index}`,
          ...(captureSpaceId ? { spaceId: captureSpaceId } : {}),
          taskRunId: capture.terminalRunId,
          sourceRefs: [
            { kind: 'conversation', subtype: 'session', scope: 'conversation', id: capture.conversationId, title: conversation.title },
            ...evidenceMessages.map((message) => ({
              kind: 'conversation' as const,
              subtype: 'message' as const,
              scope: 'conversation' as const,
              id: cognitionMessageSourceId(capture.conversationId, message.id),
            })),
            ...artifactRefs,
          ],
        });
        if (quality.reviewable
          && retainForReview
          && (
            isAutoCaptureEligible(storedCandidate) || isSettledAutomaticCandidate(storedCandidate)
          )) {
          candidates.push(storedCandidate);
          if (quality.automaticEligible) automaticallyEligibleCandidateIds.add(storedCandidate.id);
          else automaticallyEligibleCandidateIds.delete(storedCandidate.id);
        }
      } catch {
        throw new CaptureFailure('candidate_save_failed', 'candidate could not be saved');
      }
    }

    const candidateIds = [...new Set([
      ...(automaticMode ? automaticallyEligibleCandidateIds : []),
      ...candidates.map((candidate) => candidate.id),
    ])];
    capture = await updateCapture(userId, id, (current) => current.status !== 'extracting'
      ? current
      : {
          ...current,
          candidateIds,
          updatedAt: new Date().toISOString(),
        });
    if (capture.status !== 'extracting' || signal?.aborted) return settleInterruptedCapture(userId, id);

    const automaticWrite = automaticMode && automaticallyEligibleCandidateIds.size > 0;
    const resolvedCandidates = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    if (automaticWrite) {
      capture = await updateCapture(userId, id, (current) => current.status !== 'extracting'
        ? current
        : {
            ...current,
            status: 'writing',
            stage: 'asset_write',
            autoWrite: true,
            updatedAt: new Date().toISOString(),
      });
      if (capture.status !== 'writing') return capture;
      try {
        const application = await automaticallyApplyReviewableCandidates(
          userId,
          automaticallyEligibleCandidateIds,
        );
        for (const [candidateId, candidate] of application.resolved) {
          resolvedCandidates.set(candidateId, candidate);
        }
        if (application.deferredCandidateIds.length) {
          log.info('recall capture automatic write deferred to manual review', {
            captureId: id,
            candidateIds: application.deferredCandidateIds,
            reason: 'blocked_or_undecidable',
          });
        }
        if (application.failedCandidateIds.length) {
          throw new Error('one or more candidates could not be automatically written');
        }
      } catch {
        throw new CaptureFailure('asset_write_failed', 'candidate could not be automatically written to Recall');
      }
    }

    const finishedAt = new Date().toISOString();
    const modelUsage = extractionModelUsage;
    const hasQualifiedCandidates = candidateIds.length > 0;
    const hasReviewableCandidates = candidates.some((candidate) => (
      isAutoCaptureEligible(resolvedCandidates.get(candidate.id) || candidate)
    ));
    capture = await updateCapture(userId, id, (current) => (automaticWrite
      ? current.status !== 'writing'
      : current.status !== 'extracting')
      ? current
      : {
          ...current,
          status: hasReviewableCandidates ? 'review_ready' : automaticWrite ? 'completed' : 'no_candidate',
          visibility: current.executionPolicy === 'manual' || hasQualifiedCandidates || automaticWrite ? 'visible' : 'internal',
          screeningStatus: hasQualifiedCandidates ? 'qualified' : 'filtered',
          // 三分而不是二分：模型判空 / 模型给了但全被丢弃 / 给了且接住但下游筛掉。
          // 中间那档过去混在 model_no_candidate 里，让解析侧的丢弃伪装成"内容里
          // 确实没有"——实机上这两种的处置完全相反。
          filterReason: hasQualifiedCandidates
            ? undefined
            : parsed.length
              ? 'candidate_quality'
              : parseResult.emittedCount ? 'candidate_unparsable' : 'model_no_candidate',
          ...(parseResult.noCandidateReason && !hasQualifiedCandidates
            ? { noCandidateReason: parseResult.noCandidateReason }
            : {}),
          stage: undefined,
          ...(automaticWrite ? { autoWrite: true } : {}),
          candidateIds,
          errorCode: undefined,
          finishedAt,
          durationMs: durationSince(current.startedAt, finishedAt),
          ...(modelUsage ? { modelUsage } : {}),
          updatedAt: finishedAt,
        });
    captureControlRequests.delete(captureTaskKey(userId, id));
    return capture;
  } catch (error) {
    if (signal?.aborted) return settleInterruptedCapture(userId, id);
    const code = error instanceof CaptureFailure ? error.code : 'capture_failed';
    const status: RecallCaptureStatus = code === 'model_not_configured' || code === 'model_auth_required'
      ? 'configuration_required'
      : 'failed';
    log.warn('recall capture extraction failed', {
      capture_id: capture.id,
      conversation_id: capture.conversationId,
      error_code: code,
    });
    const finishedAt = new Date().toISOString();
    captureControlRequests.delete(captureTaskKey(userId, id));
    return updateCapture(userId, id, (current) => (current.status !== 'extracting' && current.status !== 'writing')
      ? current
      : {
          ...current,
          status,
          visibility: current.screeningStatus === 'qualified' ? 'visible' : current.visibility,
          errorCode: code,
          finishedAt,
          durationMs: durationSince(current.startedAt, finishedAt),
          updatedAt: finishedAt,
        });
  }
}

const scheduledCaptures = new Map<string, ScheduledBootBackgroundTask>();
const captureScheduleAdmissions = new Set<string>();
const manualCaptureRequests = new Map<string, Promise<RecallCaptureRecord>>();
let captureSchedulingEnabled = true;

function cancelScheduledCapture(userId: string, id: string): void {
  const key = captureTaskKey(userId, id);
  const task = scheduledCaptures.get(key);
  if (!task) return;
  scheduledCaptures.delete(key);
  task.cancel();
}

async function activateScheduledCapture(userId: string, id: string): Promise<RecallCaptureRecord> {
  let stored = await readRecallCapture(userId, id);
  const schedulableStatus = stored.status === 'waiting_quiet'
    || stored.status === 'scheduled'
    || (stored.status === 'waiting_completion' && stored.waitingCompletionReason === 'activity_changed');
  if (schedulableStatus) {
    if (stored.scheduledFor && Date.parse(stored.scheduledFor) > Date.now()) return stored;
    const rescheduleCheck = () => updateCapture(userId, id, (current) => ![
      'waiting_quiet', 'waiting_completion', 'scheduled',
    ].includes(current.status)
      ? current
      : {
          ...current,
          scheduledFor: new Date(Date.now() + 60_000).toISOString(),
          updatedAt: new Date().toISOString(),
        });
    if (!isQuiescent(userId, stored.conversationId)) return rescheduleCheck();

    let allMessages: GroupMessage[];
    try {
      allMessages = await chats.getMessages(userId, stored.conversationId, 2_000);
    } catch {
      return rescheduleCheck();
    }
    const latestMessage = allMessages.filter(isRecallConversationMessage).at(-1);
    const capturedLastMessageId = stored.messageIds.at(-1);
    const activityChanged = Boolean(latestMessage && latestMessage.id !== capturedLastMessageId);
    if (activityChanged || stored.waitingCompletionReason === 'activity_changed') {
      const selected = latestMessage
        ? selectCaptureMessages(
            allMessages,
            0,
            Number.MAX_SAFE_INTEGER,
            stored.anchorMessageId,
            latestMessage.id,
          )
        : [];
      const selectedLast = selected.at(-1);
      if (!selectedLast || selectedLast.role !== 'assistant') {
        return updateCapture(userId, id, (current) => ![
          'waiting_quiet', 'waiting_completion', 'scheduled',
        ].includes(current.status)
          ? current
          : {
              ...current,
              status: 'waiting_completion',
              waitingCompletionReason: 'activity_changed',
              messageIds: selected.length ? selected.map((message) => message.id) : current.messageIds,
              scheduledFor: new Date(Date.now() + 60_000).toISOString(),
              ...(latestMessage && isIsoTimestamp(latestMessage.ts) ? { lastActivityAt: latestMessage.ts } : {}),
              updatedAt: new Date().toISOString(),
            });
      }

      const activityAt = isIsoTimestamp(selectedLast.ts) ? new Date(selectedLast.ts) : new Date();
      const nextStatus: RecallCaptureStatus = stored.executionPolicy === 'nightly' ? 'scheduled' : 'waiting_quiet';
      const scheduledFor = stored.executionPolicy === 'nightly'
        ? nightlyScheduleAfterQuiet(
            activityAt,
            stored.quietMinutes || 10,
            stored.nightlyStart || '02:00',
            stored.nightlyEnd || '06:00',
          ).toISOString()
        : quietScheduleAt(activityAt, stored.quietMinutes || 10).toISOString();
      stored = await updateCapture(userId, id, (current) => ![
        'waiting_quiet', 'waiting_completion', 'scheduled',
      ].includes(current.status)
        ? current
        : {
            ...current,
            status: nextStatus,
            visibility: 'internal',
            screeningStatus: 'pending',
            screeningSignals: undefined,
            screenedAt: undefined,
            filterReason: undefined,
            waitingCompletionReason: undefined,
            messageIds: selected.map((message) => message.id),
            recallViewId: undefined,
            candidateIds: [],
            scheduledFor,
            lastActivityAt: selectedLast.ts,
            updatedAt: new Date().toISOString(),
          });
      return stored;
    }

    if (stored.status === 'waiting_completion') return stored;
    if (!latestMessage) return rescheduleCheck();

    if (stored.status === 'scheduled') {
      return updateCapture(userId, id, (current) => {
        if (current.status !== 'scheduled') return current;
        if (current.scheduledFor && Date.parse(current.scheduledFor) > Date.now()) return current;
        if (current.messageIds.at(-1) !== capturedLastMessageId) return current;
        const now = new Date();
        const nightlyStart = current.nightlyStart || '02:00';
        const nightlyEnd = current.nightlyEnd || '06:00';
        if (current.catchUpMissed === false && !isWithinNightlyWindow(now, nightlyStart, nightlyEnd)) {
          return {
            ...current,
            scheduledFor: nextNightlyRunAt(now, nightlyStart, nightlyEnd).toISOString(),
            updatedAt: now.toISOString(),
          };
        }
        return { ...current, status: 'queued', scheduledFor: undefined, updatedAt: now.toISOString() };
      });
    }

    return updateCapture(userId, id, (current) => {
      if (current.status !== 'waiting_quiet') return current;
      if (current.scheduledFor && Date.parse(current.scheduledFor) > Date.now()) return current;
      if (current.messageIds.at(-1) !== capturedLastMessageId) return current;
      return { ...current, status: 'queued', scheduledFor: undefined, updatedAt: new Date().toISOString() };
    });
  }
  return stored;
}

function scheduleKnownRecallCapture(userId: string, capture: RecallCaptureRecord): void {
  const schedulable = ['waiting_quiet', 'queued', 'scheduled'].includes(capture.status)
    || (
      capture.status === 'waiting_completion'
      && capture.waitingCompletionReason === 'activity_changed'
      && Boolean(capture.scheduledFor)
    );
  if (!captureSchedulingEnabled || !schedulable) return;
  const key = captureTaskKey(userId, capture.id);
  if (scheduledCaptures.has(key)) return;
  const delayMs = capture.status !== 'queued' && capture.scheduledFor
    ? Math.max(0, Date.parse(capture.scheduledFor) - Date.now())
    : 0;
  const task = scheduleBootBackground(`recall:capture:${capture.id}`, (signal) => (
    activateScheduledCapture(userId, capture.id)
      .then((activated) => activated.status === 'queued'
        ? runRecallCapture(userId, activated.id, signal).then(() => undefined)
        : undefined)
  ), delayMs, {
    resourceClass: 'model',
    // A user-triggered manual capture is an explicit request to start now.
    // Automatic quiet/nightly captures continue to yield to active work.
    preferIdle: capture.executionPolicy !== 'manual',
  });
  scheduledCaptures.set(key, task);
  void task.promise.finally(() => {
    if (scheduledCaptures.get(key) === task) scheduledCaptures.delete(key);
    if (!captureSchedulingEnabled) return;
    void readRecallCapture(userId, capture.id)
      .then((stored) => scheduleKnownRecallCapture(userId, stored))
      .catch(() => {
        // A removed or malformed capture cannot be rescheduled.
      });
  });
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

export async function queueRecallCaptureFromTerminal(
  event: TaskTerminalEvent,
): Promise<RecallCaptureRecord | undefined> {
  const sourceControl = await readCognitionSourceControl(event.user_id, {
    kind: 'conversation',
    id: event.conversation_id,
  });
  if (sourceControl && sourceControl.availability !== 'active') {
    log.info('recall terminal capture skipped: conversation source disabled', {
      conversation_id: event.conversation_id,
      run_id: event.run_id,
      availability: sourceControl.availability,
    });
    return undefined;
  }
  if (event.status !== 'completed') {
    const pending = await findMergeableAutomaticCapture(event.user_id, event.conversation_id);
    if (!pending) return undefined;
    cancelScheduledCapture(event.user_id, pending.id);
    const stored = await updateCapture(event.user_id, pending.id, (current) => {
      if (!MERGEABLE_AUTOMATIC_STATUSES.has(current.status)) return current;
      const waitingStatus = event.status === 'waiting_input' ? 'waiting_completion' : 'waiting_manual';
      const waitingCompletionReason = waitingStatus === 'waiting_completion'
        ? 'terminal_waiting_input' as const
        : undefined;
      const errorCode = event.status === 'failed'
        ? 'conversation_failed'
        : event.status === 'cancelled'
          ? 'conversation_cancelled'
          : undefined;
      if (current.status === 'paused') {
        return {
          ...current,
          resumeStatus: waitingStatus,
          scheduledFor: undefined,
          waitingCompletionReason,
          errorCode,
          updatedAt: new Date().toISOString(),
        };
      }
      return {
        ...current,
        status: waitingStatus,
        scheduledFor: undefined,
        waitingCompletionReason,
        errorCode,
        updatedAt: new Date().toISOString(),
      };
    });
    return stored;
  }

  const settings = await readRecallCaptureSettings(event.user_id);
  if (!settings.enabled) {
    log.info('recall terminal capture skipped: capture disabled', {
      conversation_id: event.conversation_id,
      run_id: event.run_id,
    });
    return undefined;
  }

  const messages = await chats.getMessages(event.user_id, event.conversation_id, 2_000);
  const mergeable = settings.executionPolicy === 'manual'
    ? undefined
    : await findMergeableAutomaticCapture(event.user_id, event.conversation_id);
  const selected = selectCaptureMessages(
    messages,
    event.started_at_ms,
    event.finished_at_ms,
    mergeable?.anchorMessageId || event.anchor_message_id,
    event.finished_message_id,
  );
  if (!selected.length) {
    log.warn('recall terminal capture skipped: no eligible messages', {
      conversation_id: event.conversation_id,
      run_id: event.run_id,
      anchor_message_id: event.anchor_message_id || '',
    });
    return undefined;
  }
  if (selected.at(-1)?.role !== 'assistant') {
    log.warn('recall terminal capture skipped: completed exchange has no assistant response', {
      conversation_id: event.conversation_id,
      run_id: event.run_id,
      selected_count: selected.length,
    });
    return undefined;
  }
  const requestedAnchorId = mergeable?.anchorMessageId || event.anchor_message_id;
  const anchor = requestedAnchorId
    ? selected.find((message) => message.id === requestedAnchorId && message.role === 'user')
    : [...selected].reverse().find((message) => message.role === 'user');
  if (!anchor) {
    log.warn('recall terminal capture skipped: user anchor missing', {
      conversation_id: event.conversation_id,
      run_id: event.run_id,
      anchor_message_id: event.anchor_message_id || '',
      selected_count: selected.length,
    });
    return undefined;
  }
  const id = mergeable?.id || captureId(event.conversation_id, anchor.id);
  const existing = await readRecallJsonRecord(event.user_id, CAPTURE_COLLECTION, id);
  if (existing) {
    const stored = asCapture(existing);
    const selectedIds = selected.map((message) => message.id);
    if (stored.terminalRunId === event.run_id && sameIds(stored.messageIds, selectedIds)) {
      scheduleKnownRecallCapture(event.user_id, stored);
      return stored;
    }
  }

  const nowDate = new Date();
  const now = nowDate.toISOString();
  const status: RecallCaptureStatus = settings.executionPolicy === 'manual'
    ? 'waiting_manual'
    : settings.executionPolicy === 'nightly'
      ? 'scheduled'
      : 'waiting_quiet';
  const scheduledFor = settings.executionPolicy === 'smart'
    ? quietScheduleAt(nowDate, settings.quietMinutes).toISOString()
    : settings.executionPolicy === 'nightly'
      ? nightlyScheduleAfterQuiet(
          nowDate,
          settings.quietMinutes,
          settings.nightlyStart,
          settings.nightlyEnd,
        ).toISOString()
      : undefined;
  const lastSelectedMessage = selected.at(-1);
  const lastActivityAt = lastSelectedMessage && isIsoTimestamp(lastSelectedMessage.ts)
    ? lastSelectedMessage.ts
    : now;
  const record: RecallCaptureRecord = {
    schemaVersion: 1,
    taxonomyVersion: 2,
    ownerId: event.user_id,
    id,
    conversationId: event.conversation_id,
    terminalRunId: event.run_id,
    anchorMessageId: anchor.id,
    messageIds: selected.map((message) => message.id),
    status,
    visibility: settings.executionPolicy === 'manual' ? 'visible' : 'internal',
    screeningStatus: settings.executionPolicy === 'manual' ? 'qualified' : 'pending',
    ...(settings.executionPolicy === 'manual' ? {
      screeningSignals: ['manual_selection' as const],
      screenedAt: now,
    } : {}),
    executionPolicy: settings.executionPolicy,
    ...(settings.executionPolicy !== 'manual' ? {
      quietMinutes: settings.quietMinutes,
      lastActivityAt,
    } : {}),
    ...(scheduledFor ? { scheduledFor } : {}),
    ...(settings.executionPolicy === 'nightly' ? {
      nightlyStart: settings.nightlyStart,
      nightlyEnd: settings.nightlyEnd,
      catchUpMissed: settings.catchUpMissed,
    } : {}),
    attempt: 1,
    candidateIds: [],
    createdAt: now,
    updatedAt: now,
  };
  const stored = asCapture(await updateRecallJsonRecord(
    event.user_id,
    CAPTURE_COLLECTION,
    id,
    (current) => {
      if (!current) return record;
      const capture = asCapture(current);
      const paused = capture.status === 'paused';
      return {
        ...capture,
        terminalRunId: event.run_id,
        anchorMessageId: anchor.id,
        messageIds: selected.map((message) => message.id),
        status: paused ? 'paused' : status,
        visibility: settings.executionPolicy === 'manual' ? 'visible' : 'internal',
        screeningStatus: settings.executionPolicy === 'manual' ? 'qualified' : 'pending',
        screeningSignals: settings.executionPolicy === 'manual' ? ['manual_selection'] : undefined,
        screenedAt: settings.executionPolicy === 'manual' ? now : undefined,
        filterReason: undefined,
        waitingCompletionReason: undefined,
        executionPolicy: settings.executionPolicy,
        quietMinutes: settings.executionPolicy === 'manual' ? undefined : settings.quietMinutes,
        lastActivityAt: settings.executionPolicy === 'manual' ? undefined : lastActivityAt,
        scheduledFor,
        nightlyStart: settings.executionPolicy === 'nightly' ? settings.nightlyStart : undefined,
        nightlyEnd: settings.executionPolicy === 'nightly' ? settings.nightlyEnd : undefined,
        catchUpMissed: settings.executionPolicy === 'nightly' ? settings.catchUpMissed : undefined,
        resumeStatus: paused ? status : undefined,
        errorCode: undefined,
        updatedAt: now,
      };
    },
  ));
  log.info('recall terminal capture task created', {
    conversation_id: event.conversation_id,
    run_id: event.run_id,
    capture_id: stored.id,
    status: stored.status,
    message_count: stored.messageIds.length,
  });
  cancelScheduledCapture(event.user_id, stored.id);
  scheduleKnownRecallCapture(event.user_id, stored);
  return stored;
}

const MANUAL_TAKEOVER_STATUSES = new Set<RecallCaptureStatus>([
  'waiting_quiet',
  'waiting_completion',
  'waiting_manual',
  'scheduled',
  'queued',
  'paused',
  'cancelled',
]);

function canConvertToWaitingManual(capture: RecallCaptureRecord): boolean {
  return MANUAL_TAKEOVER_STATUSES.has(capture.status)
    && capture.candidateIds.length === 0
    && capture.writingCandidateId === undefined
    && capture.stage === undefined
    && capture.startedAt === undefined
    && capture.autoWrite !== true;
}

function makeWaitingManual(
  capture: RecallCaptureRecord,
  finishedAt: string,
  now: string,
): RecallCaptureRecord {
  if (!canConvertToWaitingManual(capture)) return capture;
  return {
    ...capture,
    status: 'waiting_manual',
    visibility: 'visible',
    screeningStatus: 'qualified',
    screeningSignals: ['manual_selection'],
    screenedAt: now,
    filterReason: undefined,
    waitingCompletionReason: undefined,
    stage: undefined,
    executionPolicy: 'manual',
    quietMinutes: undefined,
    scheduledFor: undefined,
    nightlyStart: undefined,
    nightlyEnd: undefined,
    catchUpMissed: undefined,
    resumeStatus: undefined,
    lastActivityAt: finishedAt,
    autoWrite: undefined,
    errorCode: undefined,
    recoveredAt: undefined,
    finishedAt: undefined,
    durationMs: undefined,
    modelUsage: undefined,
    updatedAt: now,
  };
}

async function queueManualRecallCaptureRequest(
  userId: string,
  conversationId: string,
): Promise<RecallCaptureRecord> {
  const sourceControl = await readCognitionSourceControl(userId, {
    kind: 'conversation',
    id: conversationId,
  });
  if (sourceControl && sourceControl.availability !== 'active') {
    throw new Error(sourceControl.availability === 'removed'
      ? 'conversation source was removed from Recall'
      : 'conversation source is paused');
  }
  const conversation = await chats.getConversation(userId, conversationId);
  if (!conversation) throw new Error('conversation not found');

  const messages = await chats.getMessages(userId, conversationId, 2_000);
  const eligible = messages.filter(isRecallConversationMessage);
  const firstUser = eligible.find((message) => message.from === 'user');
  const finished = eligible.at(-1);
  if (!firstUser || !finished) throw new Error('conversation has no completed exchange');

  const selected = selectCaptureMessages(
    messages,
    0,
    Number.MAX_SAFE_INTEGER,
    firstUser.id,
    finished.id,
  );
  if (!selected.length || selected.at(-1)?.role !== 'assistant') {
    throw new Error('conversation is still waiting for a response');
  }

  const settings = await readRecallCaptureSettings(userId);
  if (!settings.enabled) throw new Error('recall capture is disabled');

  const baseId = manualConversationCaptureId(conversationId, finished.id);
  let id = baseId;
  const exact = await readRecallJsonRecord(userId, CAPTURE_COLLECTION, baseId);
  if (exact) {
    const stored = await migrateLegacyHistoricalAutomaticWait(userId, asCapture(exact));
    if (stored.status === 'waiting_manual') return stored;
    // Preserve a completed task that already owns candidates. A second manual
    // selection is only a re-extraction when the prior extraction produced no
    // candidates; otherwise it would hide the existing review work behind a
    // duplicate capture record.
    if (stored.status === 'completed' && stored.candidateIds.length > 0) return stored;
    const canRetryAfterExtraction = ['no_candidate', 'completed'].includes(stored.status);
    if (!canRetryAfterExtraction) {
      if (!canConvertToWaitingManual(stored)) return stored;
      cancelScheduledCapture(userId, stored.id);
      const now = new Date().toISOString();
      return updateCapture(userId, stored.id, (current) => makeWaitingManual(current, finished.ts, now));
    }
    id = manualConversationCaptureId(conversationId, finished.id, randomUUID());
  }

  let covering: RecallCaptureRecord | undefined;
  for (const candidate of await listAllRecallCaptures(userId)) {
    if (candidate.conversationId !== conversationId || !candidate.messageIds.includes(finished.id)) continue;
    const migrated = await migrateLegacyHistoricalAutomaticWait(userId, candidate);
    if (migrated.status === 'cancelled') continue;
    if (['no_candidate', 'completed'].includes(migrated.status)) continue;
    if (migrated.status === 'no_candidate' && migrated.visibility === 'internal') continue;
    covering = migrated;
    break;
  }
  if (covering) {
    if (covering.status === 'waiting_manual') return covering;
    if (!canConvertToWaitingManual(covering)) return covering;
    cancelScheduledCapture(userId, covering.id);
    const now = new Date().toISOString();
    return updateCapture(userId, covering.id, (current) => makeWaitingManual(current, finished.ts, now));
  }

  const now = new Date().toISOString();
  const record: RecallCaptureRecord = {
    schemaVersion: 1,
    taxonomyVersion: 2,
    ownerId: userId,
    id,
    conversationId,
    conversationTitle: conversation.title,
    terminalRunId: `manual-${id.slice('rcap-'.length)}`,
    anchorMessageId: firstUser.id,
    messageIds: selected.map((message) => message.id),
    status: 'waiting_manual',
    visibility: 'visible',
    screeningStatus: 'qualified',
    screeningSignals: ['manual_selection'],
    screenedAt: now,
    executionPolicy: 'manual',
    lastActivityAt: finished.ts,
    attempt: 1,
    candidateIds: [],
    createdAt: now,
    updatedAt: now,
  };
  const stored = asCapture(await updateRecallJsonRecord(
    userId,
    CAPTURE_COLLECTION,
    id,
    (current) => current || record,
  ));
  log.info('manual historical recall capture task created', {
    conversation_id: conversationId,
    capture_id: stored.id,
    message_count: stored.messageIds.length,
  });
  return stored;
}

export function queueManualRecallCaptureFromConversation(
  userId: string,
  conversationId: string,
): Promise<RecallCaptureRecord> {
  if (!safeId(conversationId)) return Promise.reject(new Error('invalid conversation id'));
  const key = `${userId}:${conversationId}`;
  const inFlight = manualCaptureRequests.get(key);
  if (inFlight) return inFlight;

  let request: Promise<RecallCaptureRecord>;
  request = queueManualRecallCaptureRequest(userId, conversationId).finally(() => {
    if (manualCaptureRequests.get(key) === request) manualCaptureRequests.delete(key);
  });
  manualCaptureRequests.set(key, request);
  return request;
}

/**
 * Backwards-compatible name for the old historical-auto IPC channel.
 * Selecting a past conversation must never invoke the model or write an
 * asset. It only creates the visible `waiting_manual` task; the explicit
 * `runNow` action is the sole admission point for extraction.
 */
export function startHistoricalRecallCapture(
  userId: string,
  conversationId: string,
): Promise<RecallCaptureRecord> {
  return queueManualRecallCaptureFromConversation(userId, conversationId);
}

export async function promoteRecallCaptureCandidate(
  userId: string,
  candidateId: string,
  options: { riskAcknowledged?: boolean; profileTarget?: PersonalProfileTarget } = {},
): Promise<RecallCaptureCandidatePromotion> {
  if (!safeId(candidateId)) throw new Error('invalid recall candidate id');
  const capture = (await listAllRecallCaptures(userId)).find((item) => item.candidateIds.includes(candidateId));
  if (!capture) {
    // 用户确认提升 → actor 必须为 user（promoteRecallCandidate 强制校验；此前漏传导致 IPC 提升一直失败）
    const promoted = await promoteRecallCandidate(userId, candidateId, { actor: 'user', riskAcknowledged: options.riskAcknowledged, ...(options.profileTarget ? { profileTarget: options.profileTarget } : {}) });
    await prepareSkillDraftForPromotedAsset(userId, promoted);
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
      updatedAt: new Date().toISOString(),
    };
  });

  try {
    const promoted = await promoteRecallCandidate(userId, candidateId, { actor: 'user', riskAcknowledged: options.riskAcknowledged, ...(options.profileTarget ? { profileTarget: options.profileTarget } : {}) });
    await prepareSkillDraftForPromotedAsset(userId, promoted);
    await updateCapture(userId, capture.id, (current) => (
      current.status === 'writing' && current.writingCandidateId === candidateId
        ? {
            ...current,
            status: 'review_ready',
            stage: undefined,
            writingCandidateId: undefined,
            errorCode: undefined,
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
            updatedAt: new Date().toISOString(),
          }
        : current
    ));
    throw error;
  }
}

export async function retryRecallCapture(userId: string, id: string): Promise<RecallCaptureRecord> {
  const capture = await updateCapture(userId, id, async (current) => {
    let retryable = current.status === 'failed' || current.status === 'configuration_required';
    if (current.status === 'review_ready' || current.status === 'completed') {
      const [workflow] = await summarizeRecallCaptures(userId, [current]);
      retryable = workflow.workflowStatus === 'failed' && workflow.reviewSummary.missing > 0;
    }
    if (!retryable) {
      throw new Error('recall capture is not retryable');
    }
    return {
      ...current,
      status: 'queued',
      stage: undefined,
      attempt: current.attempt + 1,
      errorCode: undefined,
      recoveredAt: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      durationMs: undefined,
      modelUsage: undefined,
      updatedAt: new Date().toISOString(),
    };
  });
  scheduleRecallCapture(userId, capture.id);
  return capture;
}

export async function pauseRecallCapture(userId: string, id: string): Promise<RecallCaptureRecord> {
  const key = captureTaskKey(userId, id);
  const capture = await updateCapture(userId, id, (current) => {
    if (!['waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled', 'queued', 'extracting'].includes(current.status)) {
      throw new Error('recall capture is not pausable');
    }
    if (current.status === 'extracting' && current.stage === 'candidate_save') {
      throw new Error('recall capture is finalizing candidates');
    }
    const resumeStatus: NonNullable<RecallCaptureRecord['resumeStatus']> = current.status === 'extracting'
      ? 'queued'
      : current.status as NonNullable<RecallCaptureRecord['resumeStatus']>;
    if (current.status === 'extracting') captureControlRequests.set(key, 'pause');
    return {
      ...current,
      status: 'paused',
      stage: undefined,
      resumeStatus,
      updatedAt: new Date().toISOString(),
    };
  });
  cancelScheduledCapture(userId, id);
  return capture;
}

export async function resumeRecallCapture(userId: string, id: string): Promise<RecallCaptureRecord> {
  const key = captureTaskKey(userId, id);
  const capture = await updateCapture(userId, id, (current) => {
    if (current.status !== 'paused') throw new Error('recall capture is not paused');
    let status = current.resumeStatus || 'queued';
    let scheduledFor = current.scheduledFor;
    if (status === 'scheduled' && (!scheduledFor || Date.parse(scheduledFor) <= Date.now())) {
      scheduledFor = current.catchUpMissed === false
        ? nextNightlyRunAt(
            new Date(),
            current.nightlyStart || '02:00',
            current.nightlyEnd || '06:00',
          ).toISOString()
        : new Date().toISOString();
    }
    if (status === 'waiting_quiet' && !scheduledFor) {
      scheduledFor = quietScheduleAt(new Date(), current.quietMinutes || 10).toISOString();
    }
    if (
      status === 'waiting_completion'
      && current.waitingCompletionReason === 'activity_changed'
      && !scheduledFor
    ) {
      scheduledFor = new Date(Date.now() + 60_000).toISOString();
    }
    const keepsSchedule = status === 'waiting_quiet'
      || status === 'scheduled'
      || (status === 'waiting_completion' && current.waitingCompletionReason === 'activity_changed');
    return {
      ...current,
      status,
      scheduledFor: keepsSchedule ? scheduledFor : undefined,
      resumeStatus: undefined,
      updatedAt: new Date().toISOString(),
    };
  });
  captureControlRequests.delete(key);
  scheduleKnownRecallCapture(userId, capture);
  return capture;
}

export async function cancelRecallCapture(userId: string, id: string): Promise<RecallCaptureRecord> {
  const key = captureTaskKey(userId, id);
  const finishedAt = new Date().toISOString();
  const capture = await updateCapture(userId, id, (current) => {
    if (current.status === 'writing') throw new Error('recall capture is writing an approved candidate');
    if (['review_ready', 'no_candidate', 'completed', 'cancelled'].includes(current.status)) {
      throw new Error('recall capture is terminal');
    }
    if (current.status === 'extracting' && current.stage === 'candidate_save') {
      throw new Error('recall capture is finalizing candidates');
    }
    if (current.status === 'extracting') captureControlRequests.set(key, 'cancel');
    return {
      ...current,
      status: 'cancelled',
      stage: undefined,
      resumeStatus: undefined,
      errorCode: undefined,
      finishedAt,
      durationMs: durationSince(current.startedAt, finishedAt),
      updatedAt: finishedAt,
    };
  });
  cancelScheduledCapture(userId, id);
  return capture;
}

export async function runRecallCaptureNow(userId: string, id: string): Promise<RecallCaptureRecord> {
  const key = captureTaskKey(userId, id);
  const stored = await readRecallCapture(userId, id);
  const sourceControl = await readCognitionSourceControl(userId, {
    kind: 'conversation',
    id: stored.conversationId,
  });
  if (sourceControl && sourceControl.availability !== 'active') {
    const errorCode = sourceControl.availability === 'removed' ? 'source_removed' : 'source_paused';
    const paused = await updateCapture(userId, id, (current) => {
      // Another worker may have claimed the task between the read and this
      // preflight. Never overwrite an active extraction or a terminal result.
      if (['extracting', 'writing', 'review_ready', 'completed', 'no_candidate', 'cancelled'].includes(current.status)) {
        return current;
      }
      const now = new Date().toISOString();
      const resumableStatus: NonNullable<RecallCaptureRecord['resumeStatus']> = [
        'waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled', 'queued',
      ].includes(current.status)
        ? current.status as NonNullable<RecallCaptureRecord['resumeStatus']>
        : 'queued';
      return {
        ...current,
        status: 'paused',
        stage: undefined,
        resumeStatus: resumableStatus,
        errorCode,
        updatedAt: now,
      };
    });
    cancelScheduledCapture(userId, id);
    return paused;
  }
  if (stored.status === 'waiting_completion') {
    throw new Error('recall capture conversation is not complete');
  }
  const capture = await updateCapture(userId, id, (current) => {
    if (current.status === 'queued' || current.status === 'extracting') return current;
    if (![
      'waiting_quiet', 'waiting_manual', 'scheduled', 'paused', 'failed', 'configuration_required',
    ].includes(current.status)) {
      throw new Error('recall capture cannot run now');
    }
    const retrying = current.status === 'failed' || current.status === 'configuration_required';
    return {
      ...current,
      status: 'queued',
      stage: undefined,
      resumeStatus: undefined,
      scheduledFor: undefined,
      waitingCompletionReason: undefined,
      attempt: retrying ? current.attempt + 1 : current.attempt,
      errorCode: undefined,
      recoveredAt: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      durationMs: undefined,
      modelUsage: undefined,
      updatedAt: new Date().toISOString(),
    };
  });
  captureControlRequests.delete(key);
  cancelScheduledCapture(userId, id);
  scheduleRecallCapture(userId, id);
  return capture;
}

export async function recoverRecallCaptures(userId: string): Promise<number> {
  const captures = await listAllRecallCaptures(userId);
  let recovered = 0;
  for (const item of captures) {
    let capture = await migrateLegacyHistoricalAutomaticWait(userId, item);
    if (capture.status === 'writing') {
      const recoveredAt = new Date().toISOString();
      capture = await updateCapture(userId, capture.id, (current) => ({
        ...current,
        status: current.autoWrite ? 'failed' : 'review_ready',
        stage: undefined,
        writingCandidateId: undefined,
        errorCode: 'asset_write_interrupted',
        recoveredAt,
        updatedAt: recoveredAt,
      }));
    }
    if (capture.status === 'extracting' || capture.status === 'queued') {
      const recoveredAt = new Date().toISOString();
      capture = await updateCapture(userId, capture.id, (current) => ({
        ...current,
        status: 'queued',
        stage: undefined,
        errorCode: undefined,
        recoveredAt,
        updatedAt: recoveredAt,
      }));
    }
    if (capture.status === 'waiting_completion' && !capture.waitingCompletionReason) {
      try {
        const latestMessage = (await chats.getMessages(userId, capture.conversationId, 2_000))
          .filter(isRecallConversationMessage)
          .at(-1);
        if (latestMessage && latestMessage.id !== capture.messageIds.at(-1)) {
          const recoveredAt = new Date().toISOString();
          capture = await updateCapture(userId, capture.id, (current) => (
            current.status !== 'waiting_completion' || current.waitingCompletionReason
              ? current
              : {
                  ...current,
                  waitingCompletionReason: 'activity_changed',
                  scheduledFor: recoveredAt,
                  recoveredAt,
                  updatedAt: recoveredAt,
                }
          ));
        }
      } catch {
        // Keep an ambiguous legacy wait untouched until its conversation is readable.
      }
    }
    if (
      capture.status === 'waiting_completion'
      && capture.waitingCompletionReason === 'activity_changed'
      && !capture.scheduledFor
    ) {
      const recoveredAt = new Date().toISOString();
      capture = await updateCapture(userId, capture.id, (current) => (
        current.status !== 'waiting_completion' || current.waitingCompletionReason !== 'activity_changed'
          ? current
          : {
              ...current,
              scheduledFor: recoveredAt,
              recoveredAt,
              updatedAt: recoveredAt,
            }
      ));
    }
    const schedulable = capture.status === 'queued'
      || capture.status === 'waiting_quiet'
      || capture.status === 'scheduled'
      || (
        capture.status === 'waiting_completion'
        && capture.waitingCompletionReason === 'activity_changed'
        && Boolean(capture.scheduledFor)
      );
    if (schedulable) {
      scheduleKnownRecallCapture(userId, capture);
      recovered += 1;
    }
  }
  return recovered;
}

type TerminalSubscribe = (listener: TaskTerminalListener) => () => void;

export interface RecallCaptureOrchestratorRuntime {
  subscribe?: TerminalSubscribe;
  queue?: (event: TaskTerminalEvent) => Promise<RecallCaptureRecord | undefined>;
}

export function startRecallCaptureOrchestrator(
  runtime: RecallCaptureOrchestratorRuntime = {},
): () => void {
  captureSchedulingEnabled = true;
  const subscribe = runtime.subscribe || subscribeTaskTerminals;
  const queue = runtime.queue || queueRecallCaptureFromTerminal;
  const unsubscribe = subscribe((event) => {
    void queue(event).catch(() => {
      log.warn('recall terminal capture queue failed', {
        conversation_id: event.conversation_id,
        run_id: event.run_id,
      });
    });
  });
  return () => {
    captureSchedulingEnabled = false;
    unsubscribe();
    for (const task of scheduledCaptures.values()) task.cancel();
    scheduledCaptures.clear();
    captureScheduleAdmissions.clear();
    manualCaptureRequests.clear();
    captureControlRequests.clear();
  };
}
