import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { buildRunner } from '../../model/core-agent/runner';
import { safeId } from '../../storage';
import { scheduleBootBackground, type ScheduledBootBackgroundTask } from '../../util/boot_init';
import { getConfiguredModelOAuthExpiredMessage, hasConfiguredModel } from '../auth';
import * as chats from '../chats';
import {
  isQuiescent,
  subscribeTaskTerminals,
  type TaskTerminalEvent,
  type TaskTerminalListener,
} from '../group_chat/bus';
import type { GroupMessage } from '../group_chat/visibility';
import {
  promoteRecallCandidate,
  readRecallCandidate,
  saveRecallCandidate,
  type AbilityAssetType,
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
  nextAction: RecallCaptureNextAction;
  actions: RecallCaptureAction[];
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
  summary: string;
  uncertainty?: string;
  suggestedType: AbilityAssetType;
  suggestedScope: string;
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
    || (value.recallViewId !== undefined && (typeof value.recallViewId !== 'string' || !safeId(value.recallViewId)))
    || (value.stage !== undefined && !isCaptureStage(value.stage))
    || (value.executionPolicy !== undefined && !isExecutionPolicy(value.executionPolicy))
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
    || !optionalTimestampIsValid(value.recoveredAt)
    || !optionalTimestampIsValid(value.startedAt)
    || !optionalTimestampIsValid(value.finishedAt)
    || !optionalNonNegativeInteger(value.durationMs)
    || !isIsoTimestamp(value.createdAt)
    || !isIsoTimestamp(value.updatedAt)
  ) throw new Error('malformed recall capture');
  return {
    ...value,
    taxonomyVersion: 2,
    executionPolicy: isExecutionPolicy(value.executionPolicy) ? value.executionPolicy : 'immediate',
    stage: ['review_ready', 'no_candidate', 'cancelled'].includes(String(value.status))
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

function manualConversationCaptureId(conversationId: string, finishedMessageId: string): string {
  const digest = createHash('sha256')
    .update(`${conversationId}\0manual-history\0${finishedMessageId}`)
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

function isCaptureMessage(message: GroupMessage): boolean {
  return !message.deleted_at
    && !message.dispatch
    && !message.system_kind
    && !message.failure_kind
    && typeof message.text === 'string'
    && Boolean(message.text.trim());
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
    if (!isCaptureMessage(message)) return false;
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
      role: message.from === 'user' ? 'user' : 'assistant',
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

function parseCandidateType(value: unknown): AbilityAssetType {
  if (value === 'personal' || value === 'rule' || value === 'template' || value === 'skill_method') return value;
  throw new CaptureFailure('invalid_model_output', 'invalid suggestedType');
}

export function parseRecallCaptureOutput(raw: string, validLabels: Set<string>): ParsedCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CaptureFailure('invalid_model_output', 'model output is not strict JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CaptureFailure('invalid_model_output', 'model output must be an object');
  }
  const candidates = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length > MAX_MODEL_CANDIDATES) {
    throw new CaptureFailure('invalid_model_output', 'invalid candidate count');
  }

  return candidates.map((rawCandidate): ParsedCandidate => {
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
    const uncertainty = candidate.uncertainty === undefined
      ? undefined
      : boundedRequiredText(candidate.uncertainty, 'uncertainty', 1_000);
    return {
      judgment: boundedRequiredText(candidate.judgment, 'judgment', 4_000),
      summary: boundedRequiredText(candidate.summary, 'summary', 1_000),
      ...(uncertainty ? { uncertainty } : {}),
      suggestedType: parseCandidateType(candidate.suggestedType),
      suggestedScope: boundedRequiredText(candidate.suggestedScope, 'suggestedScope', 500),
      evidence,
    };
  });
}

function extractionSystemPrompt(): string {
  return [
    'You extract durable, user-reviewable knowledge from one completed conversation run.',
    'Return exactly one JSON object and no markdown or commentary.',
    'Schema: {"candidates":[{"judgment":"...","summary":"...","suggestedType":"personal|rule|template|skill_method","suggestedScope":"...","evidence":["m1"],"uncertainty":"optional"}]}',
    'Return at most 3 candidates. Return {"candidates":[]} when nothing is durable enough.',
    'Only extract reusable preferences, constraints, decisions, templates, or methods supported by the supplied messages.',
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
    || error.message.startsWith('malformed recall record:');
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
  if (workflowStatus === 'paused') return 'resume';
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
  if (['waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled', 'paused'].includes(capture.status)) {
    actions.push('run_now');
  }
  if (['waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled', 'queued', 'extracting'].includes(capture.status)
    && !(capture.status === 'extracting' && capture.stage === 'candidate_save')) {
    actions.push('pause');
  }
  if (capture.status === 'paused') actions.push('resume');
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

  return Promise.all(captures.map(async (capture) => {
    const candidateIds = [...new Set(capture.candidateIds)];
    const candidates = await Promise.all(candidateIds.map(readCandidate));
    const reviewSummary: RecallCaptureReviewSummary = {
      total: candidateIds.length,
      pending: 0,
      deferred: 0,
      promoted: 0,
      rejected: 0,
      missing: 0,
    };
    const linkedAssetIds = new Set<string>();
    for (const candidate of candidates) {
      if (!candidate) {
        reviewSummary.missing += 1;
        continue;
      }
      reviewSummary[candidate.status] += 1;
      if (candidate.status === 'promoted' && candidate.promotedAssetId && safeId(candidate.promotedAssetId)) {
        linkedAssetIds.add(candidate.promotedAssetId);
      }
    }

    let workflowStatus: RecallCaptureWorkflowStatus = capture.status;
    if (capture.status === 'no_candidate') {
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
  return summarizeRecallCaptures(userId, (await listAllRecallCaptures(userId)).slice(0, wanted));
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
  const all = await summarizeRecallCaptures(userId, await listAllRecallCaptures(userId));
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
  const byId = new Map(allMessages.filter(isCaptureMessage).map((message) => [message.id, message]));
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

export async function runRecallCapture(
  userId: string,
  id: string,
  signal?: AbortSignal,
): Promise<RecallCaptureRecord> {
  const queued = await readRecallCapture(userId, id);
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
    if (!hasConfiguredModel().configured && !process.env.ANTHROPIC_API_KEY) {
      throw new CaptureFailure('model_not_configured', 'model configuration is required');
    }
    if (getConfiguredModelOAuthExpiredMessage()) {
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
    try {
      result = await runner.run({
        message: extractionInput(conversation.title, promptMessages, recallView),
        signal,
        thinkingLevel: 'off',
        cacheRetention: 'none',
      });
    } catch {
      throw new CaptureFailure('model_failed', 'model extraction failed');
    }
    if (signal?.aborted) return settleInterruptedCapture(userId, id);
    if (result.meta.aborted) throw new CaptureFailure('model_failed', 'model extraction was aborted');
    if (result.meta.error) {
      const code = result.meta.error.kind === 'auth' ? 'model_auth_required' : 'model_failed';
      throw new CaptureFailure(code, result.meta.error.message);
    }
    const parsed = parseRecallCaptureOutput(
      result.text.trim(),
      new Set(promptMessages.map((message) => message.label)),
    );
    capture = await setCaptureStage(userId, id, 'candidate_save');
    if (capture.status !== 'extracting') return capture;
    const byLabel = new Map(promptMessages.map((message) => [message.label, message]));
    const candidates = [];
    for (const [index, candidate] of parsed.entries()) {
      const evidenceMessages = candidate.evidence.map((label) => byLabel.get(label)!);
      const teachingSignals = activeTeachingSignals.filter((signal) => (
        evidenceMessages.some((message) => message.id === signal.messageId)
      ));
      if (teachingSignals.length) {
        const teachingCandidateIds = [...new Set(teachingSignals.flatMap((signal) => signal.candidateIds))];
        const existing = await Promise.all(teachingCandidateIds.map(async (candidateId) => {
          try { return await readRecallCandidate(userId, candidateId); }
          catch { return undefined; }
        }));
        const matching = existing.find((current) => current && (
          comparableCandidateText(current.judgment) === comparableCandidateText(candidate.judgment)
        ));
        if (matching) {
          if (matching.status === 'pending' || matching.status === 'deferred') candidates.push(matching);
          continue;
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
        candidates.push(await saveRecallCandidate(userId, {
          judgment: candidate.judgment,
          summary: candidate.summary,
          ...(candidate.uncertainty ? { uncertainty: candidate.uncertainty } : {}),
          suggestedType: candidate.suggestedType,
          suggestedScope: candidate.suggestedScope,
          captureKey: `capture-${capture.id}-${index}`,
          ...(captureSpaceId ? { spaceId: captureSpaceId } : {}),
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
        }));
      } catch {
        throw new CaptureFailure('candidate_save_failed', 'candidate could not be saved');
      }
    }

    const candidateIds = [...new Set(candidates.map((candidate) => candidate.id))];
    capture = await updateCapture(userId, id, (current) => current.status !== 'extracting'
      ? current
      : {
          ...current,
          candidateIds,
          updatedAt: new Date().toISOString(),
        });
    if (capture.status !== 'extracting' || signal?.aborted) return settleInterruptedCapture(userId, id);

    const reviewSettings = await readRecallCaptureSettings(userId);
    const automaticCandidates = reviewSettings.reviewPolicy === 'auto'
      ? candidates.filter((candidate) => !candidate.uncertainty)
      : [];
    if (automaticCandidates.length) {
      capture = await setCaptureStage(userId, id, 'asset_write');
      if (capture.status !== 'extracting' || signal?.aborted) return settleInterruptedCapture(userId, id);
      try {
        for (const candidate of automaticCandidates) {
          const promoted = await promoteRecallCandidate(userId, candidate.id);
          await prepareSkillDraftForPromotedAsset(userId, promoted);
        }
      } catch {
        throw new CaptureFailure('asset_write_failed', 'automatic recall asset write failed');
      }
    }

    const finishedAt = new Date().toISOString();
    const modelUsage = normalizeModelUsage(result.meta.usage);
    capture = await updateCapture(userId, id, (current) => current.status !== 'extracting'
      ? current
      : {
          ...current,
          status: candidates.length ? 'review_ready' : 'no_candidate',
          stage: undefined,
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
    return updateCapture(userId, id, (current) => current.status !== 'extracting'
      ? current
      : {
          ...current,
          status,
          errorCode: code,
          finishedAt,
          durationMs: durationSince(current.startedAt, finishedAt),
          updatedAt: finishedAt,
        });
  }
}

const scheduledCaptures = new Map<string, ScheduledBootBackgroundTask>();
const captureScheduleAdmissions = new Set<string>();
let captureSchedulingEnabled = true;

function cancelScheduledCapture(userId: string, id: string): void {
  const key = captureTaskKey(userId, id);
  const task = scheduledCaptures.get(key);
  if (!task) return;
  scheduledCaptures.delete(key);
  task.cancel();
}

async function activateScheduledCapture(userId: string, id: string): Promise<RecallCaptureRecord> {
  const stored = await readRecallCapture(userId, id);
  if (stored.status === 'waiting_quiet' || stored.status === 'scheduled') {
    if (stored.scheduledFor && Date.parse(stored.scheduledFor) > Date.now()) return stored;
    if (!isQuiescent(userId, stored.conversationId)) {
      return updateCapture(userId, id, (current) => !['waiting_quiet', 'scheduled'].includes(current.status)
        ? current
        : {
            ...current,
            scheduledFor: new Date(Date.now() + 60_000).toISOString(),
            updatedAt: new Date().toISOString(),
          });
    }

    let latestMessage: GroupMessage | undefined;
    try {
      latestMessage = (await chats.getMessages(userId, stored.conversationId, 2_000))
        .filter(isCaptureMessage)
        .at(-1);
    } catch {
      return updateCapture(userId, id, (current) => !['waiting_quiet', 'scheduled'].includes(current.status)
        ? current
        : {
            ...current,
            scheduledFor: new Date(Date.now() + 60_000).toISOString(),
            updatedAt: new Date().toISOString(),
          });
    }

    const capturedLastMessageId = stored.messageIds.at(-1);
    if (!latestMessage || latestMessage.id !== capturedLastMessageId) {
      return updateCapture(userId, id, (current) => !['waiting_quiet', 'scheduled'].includes(current.status)
        ? current
        : {
            ...current,
            status: 'waiting_completion',
            scheduledFor: undefined,
            ...(latestMessage && isIsoTimestamp(latestMessage.ts) ? { lastActivityAt: latestMessage.ts } : {}),
            updatedAt: new Date().toISOString(),
          });
    }

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
  if (!captureSchedulingEnabled || !['waiting_quiet', 'queued', 'scheduled'].includes(capture.status)) return;
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
    preferIdle: true,
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
          errorCode,
          updatedAt: new Date().toISOString(),
        };
      }
      return {
        ...current,
        status: waitingStatus,
        scheduledFor: undefined,
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

export async function queueManualRecallCaptureFromConversation(
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
  const eligible = messages.filter(isCaptureMessage);
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

  const covering = (await listAllRecallCaptures(userId)).find((capture) => (
    capture.conversationId === conversationId
    && capture.status !== 'cancelled'
    && capture.messageIds.includes(finished.id)
  ));
  if (covering) return covering;

  const settings = await readRecallCaptureSettings(userId);
  if (!settings.enabled) throw new Error('recall capture is disabled');

  const id = manualConversationCaptureId(conversationId, finished.id);
  const existing = await readRecallJsonRecord(userId, CAPTURE_COLLECTION, id);
  if (existing) {
    const stored = asCapture(existing);
    if (stored.status !== 'cancelled') return stored;
    return updateCapture(userId, id, (current) => ({
      ...current,
      status: 'waiting_manual',
      stage: undefined,
      executionPolicy: 'manual',
      attempt: current.attempt + 1,
      candidateIds: [],
      errorCode: undefined,
      scheduledFor: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      durationMs: undefined,
      modelUsage: undefined,
      updatedAt: new Date().toISOString(),
    }));
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
    executionPolicy: 'manual',
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

export async function promoteRecallCaptureCandidate(
  userId: string,
  candidateId: string,
): Promise<{ candidate: RecallCandidateRecord; asset: RecallAbilityAssetRecord }> {
  if (!safeId(candidateId)) throw new Error('invalid recall candidate id');
  const capture = (await listAllRecallCaptures(userId)).find((item) => item.candidateIds.includes(candidateId));
  if (!capture) {
    // 用户确认提升 → actor 必须为 user（promoteRecallCandidate 强制校验；此前漏传导致 IPC 提升一直失败）
    const promoted = await promoteRecallCandidate(userId, candidateId, { actor: 'user' });
    await prepareSkillDraftForPromotedAsset(userId, promoted);
    return promoted;
  }

  await updateCapture(userId, capture.id, (current) => {
    if (!current.candidateIds.includes(candidateId)) throw new Error('candidate does not belong to recall capture');
    if (current.status === 'writing') throw new Error('recall capture is already writing');
    if (current.status !== 'review_ready') throw new Error('recall capture is not ready for review');
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
    const promoted = await promoteRecallCandidate(userId, candidateId, { actor: 'user' });
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
    if (current.status === 'review_ready') {
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
    return {
      ...current,
      status,
      scheduledFor: ['waiting_quiet', 'scheduled'].includes(status) ? scheduledFor : undefined,
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
    if (['review_ready', 'no_candidate', 'cancelled'].includes(current.status)) {
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
    throw new Error(sourceControl.availability === 'removed'
      ? 'conversation source was removed from Recall'
      : 'conversation source is paused');
  }
  const capture = await updateCapture(userId, id, (current) => {
    if (current.status === 'queued' || current.status === 'extracting') return current;
    if (![
      'waiting_quiet', 'waiting_completion', 'waiting_manual', 'scheduled', 'paused', 'failed', 'configuration_required',
    ].includes(current.status)) {
      throw new Error('recall capture cannot run now');
    }
    const retrying = current.status === 'failed' || current.status === 'configuration_required';
    return {
      ...current,
      status: 'queued',
      stage: undefined,
      resumeStatus: undefined,
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
    let capture = item;
    if (capture.status === 'writing') {
      const recoveredAt = new Date().toISOString();
      capture = await updateCapture(userId, capture.id, (current) => ({
        ...current,
        status: 'review_ready',
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
    if (capture.status === 'queued' || capture.status === 'waiting_quiet' || capture.status === 'scheduled') {
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
    captureControlRequests.clear();
  };
}
