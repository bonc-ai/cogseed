import { genId12, nowIso, safeId } from '../../storage';
import {
  listKstarJsonRecords,
  readKstarJsonRecord,
  replaceKstarJsonRecord,
  writeKstarJsonRecord,
} from './episode-store';
import type {
  KstarConversationTaskStateRecord,
  KstarExpectedResult,
  KstarRequirementRecord,
  KstarRequirementStatus,
  KstarTaskPhase,
  KstarTaskRecord,
} from './requirement-types';

const MAX_TITLE = 200;
const MAX_GOAL = 4_000;

function normalizedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`invalid ${field}`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(`missing ${field}`);
  if (text.length > max) throw new Error(`${field} is too long`);
  return text;
}

function validRecordBase(userId: string, record: Record<string, unknown>, recordId: string, kind: string): void {
  if (record.ownerId !== userId || record.id !== recordId || !safeId(recordId)) {
    throw new Error(`malformed kstar ${kind}`);
  }
  if (record.schemaVersion !== 1) throw new Error(`malformed kstar ${kind}`);
}

function validateExpectedResult(value: unknown): asserts value is KstarExpectedResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed kstar expected result');
  const record = value as Record<string, unknown>;
  if (
    typeof record.summary !== 'string' || record.summary.length > MAX_GOAL ||
    !Array.isArray(record.acceptanceSignals) || record.acceptanceSignals.some((item) => typeof item !== 'string') ||
    !['user_message', 'router', 'model', 'unknown'].includes(String(record.source)) ||
    typeof record.confidence !== 'number' || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1
  ) throw new Error('malformed kstar expected result');
}

function validateTask(userId: string, raw: Record<string, unknown>): KstarTaskRecord {
  const id = String(raw.id || '');
  validRecordBase(userId, raw, id, 'task');
  if (
    typeof raw.conversationId !== 'string' || !safeId(raw.conversationId) ||
    typeof raw.title !== 'string' || raw.title.length > MAX_TITLE ||
    !['open', 'closing', 'closed', 'abandoned'].includes(String(raw.status)) ||
    !Array.isArray(raw.requirementIds) || raw.requirementIds.some((item) => typeof item !== 'string' || !safeId(item)) ||
    (raw.workspaceId !== undefined && (typeof raw.workspaceId !== 'string' || !safeId(raw.workspaceId))) ||
    (raw.currentRequirementId !== undefined && (typeof raw.currentRequirementId !== 'string' || !safeId(raw.currentRequirementId))) ||
    (raw.closeReason !== undefined && !['user_complete', 'topic_switch', 'aborted'].includes(String(raw.closeReason))) ||
    (raw.aggregateReviewId !== undefined && typeof raw.aggregateReviewId !== 'string') ||
    (raw.candidateRunId !== undefined && typeof raw.candidateRunId !== 'string') ||
    typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string'
  ) throw new Error('malformed kstar task');
  return raw as KstarTaskRecord;
}

/**
 * Read-time compatibility for schemaVersion 1 requirements written before
 * projection history was introduced. The persisted record is never mutated or
 * rewritten here; the normalized copy only gives the current validator and
 * callers the field shape they expect.
 */
function normalizeRequirementForRead(raw: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(raw.projectionIds)) return raw;
  // A present-but-malformed array must still fail validation; only a genuinely
  // missing field is eligible for legacy compatibility.
  if (Object.prototype.hasOwnProperty.call(raw, 'projectionIds')) return raw;
  if (Object.prototype.hasOwnProperty.call(raw, 'projectionId')) {
    return { ...raw, projectionIds: [raw.projectionId] };
  }
  return { ...raw, projectionIds: [] };
}

function validateRequirement(userId: string, raw: Record<string, unknown>): KstarRequirementRecord {
  const id = String(raw.id || '');
  validRecordBase(userId, raw, id, 'requirement');
  if (
    typeof raw.taskId !== 'string' || !safeId(raw.taskId) ||
    typeof raw.conversationId !== 'string' || !safeId(raw.conversationId) ||
    !Array.isArray(raw.userMessageIds) || raw.userMessageIds.some((item) => typeof item !== 'string' || !safeId(item)) ||
    !Array.isArray(raw.episodeIds) || raw.episodeIds.some((item) => typeof item !== 'string' || !safeId(item)) ||
    !['open', 'waiting_review', 'closed', 'abandoned'].includes(String(raw.status)) ||
    typeof raw.title !== 'string' || raw.title.length > MAX_TITLE ||
    typeof raw.goalText !== 'string' || raw.goalText.length > MAX_GOAL ||
    (raw.rHat !== undefined && (() => { validateExpectedResult(raw.rHat); return false; })()) ||
    (raw.projectionId !== undefined && (typeof raw.projectionId !== 'string' || !safeId(raw.projectionId))) ||
    (raw.forecastId !== undefined && (typeof raw.forecastId !== 'string' || !safeId(raw.forecastId))) ||
    !Array.isArray(raw.projectionIds) || raw.projectionIds.some((item: unknown) => typeof item !== 'string' || !safeId(item)) ||
    (raw.wakeRequestId !== undefined && (typeof raw.wakeRequestId !== 'string' || !safeId(raw.wakeRequestId))) ||
    (raw.prmReview !== undefined && (typeof raw.prmReview !== 'object' || raw.prmReview === null)) ||
    (raw.aar !== undefined && (typeof raw.aar !== 'object' || raw.aar === null)) ||
    (raw.closedAt !== undefined && typeof raw.closedAt !== 'string') ||
    typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string'
  ) throw new Error('malformed kstar requirement');
  return raw as KstarRequirementRecord;
}

function validateState(userId: string, raw: Record<string, unknown>, conversationId: string): KstarConversationTaskStateRecord {
  validRecordBase(userId, raw, conversationId, 'conversation task state');
  if (
    raw.conversationId !== conversationId || typeof raw.conversationId !== 'string' || !safeId(conversationId) ||
    typeof raw.taskComplete !== 'boolean' ||
    (raw.currentTaskId !== undefined && (typeof raw.currentTaskId !== 'string' || !safeId(raw.currentTaskId))) ||
    (raw.currentRequirementId !== undefined && (typeof raw.currentRequirementId !== 'string' || !safeId(raw.currentRequirementId))) ||
    (raw.requirementJustClosed !== undefined && (typeof raw.requirementJustClosed !== 'string' || !safeId(raw.requirementJustClosed))) ||
    (raw.lastRoutedUserMessageId !== undefined && (typeof raw.lastRoutedUserMessageId !== 'string' || !safeId(raw.lastRoutedUserMessageId))) ||
    typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string'
  ) throw new Error('malformed kstar conversation task state');
  if (raw.pendingTaskStart !== undefined) {
    const pending = raw.pendingTaskStart as Record<string, unknown>;
    if (
      typeof pending !== 'object' || pending === null ||
      typeof pending.userMessageId !== 'string' || !safeId(pending.userMessageId) ||
      typeof pending.text !== 'string' || !pending.text.trim() || pending.text.length > MAX_GOAL ||
      (pending.workspaceId !== undefined && (typeof pending.workspaceId !== 'string' || !safeId(pending.workspaceId))) ||
      pending.reason !== 'topic_switch'
    ) throw new Error('malformed kstar pending task start');
  }
  return raw as KstarConversationTaskStateRecord;
}

export function createInitialConversationTaskState(userId: string, conversationId: string): KstarConversationTaskStateRecord {
  if (!safeId(userId) || !safeId(conversationId)) throw new Error('invalid kstar conversation state id');
  const now = nowIso();
  return {
    schemaVersion: 1,
    ownerId: userId,
    id: conversationId,
    conversationId,
    taskComplete: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function createKstarTaskRecord(
  userId: string,
  input: { conversationId: string; title: string; workspaceId?: string },
): KstarTaskRecord {
  if (!safeId(userId) || !safeId(input.conversationId)) throw new Error('invalid kstar task conversation id');
  const now = nowIso();
  return {
    schemaVersion: 1,
    ownerId: userId,
    id: `kst-${genId12()}`,
    conversationId: input.conversationId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    title: normalizedText(input.title, 'task title', MAX_TITLE),
    status: 'open',
    requirementIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createKstarRequirementRecord(
  userId: string,
  input: { taskId: string; conversationId: string; userMessageIds: string[]; title: string; goalText: string; rHat?: KstarExpectedResult },
): KstarRequirementRecord {
  if (!safeId(userId) || !safeId(input.taskId) || !safeId(input.conversationId)) throw new Error('invalid kstar requirement reference');
  if (input.userMessageIds.some((id) => !safeId(id))) throw new Error('invalid kstar requirement message id');
  const now = nowIso();
  return {
    schemaVersion: 1,
    ownerId: userId,
    id: `ksreq-${genId12()}`,
    taskId: input.taskId,
    conversationId: input.conversationId,
    userMessageIds: [...new Set(input.userMessageIds)],
    episodeIds: [],
    projectionIds: [],
    status: 'open',
    title: normalizedText(input.title, 'requirement title', MAX_TITLE),
    goalText: normalizedText(input.goalText, 'requirement goal', MAX_GOAL),
    ...(input.rHat ? { rHat: input.rHat } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export async function readConversationTaskState(userId: string, conversationId: string): Promise<KstarConversationTaskStateRecord | null> {
  const raw = await readKstarJsonRecord(userId, 'task-states', conversationId);
  return raw ? validateState(userId, raw as Record<string, unknown>, conversationId) : null;
}

export async function writeConversationTaskState(userId: string, record: KstarConversationTaskStateRecord): Promise<KstarConversationTaskStateRecord> {
  return writeKstarJsonRecord(userId, 'task-states', validateState(userId, record as unknown as Record<string, unknown>, record.conversationId));
}

export async function replaceConversationTaskState(userId: string, record: KstarConversationTaskStateRecord): Promise<KstarConversationTaskStateRecord> {
  return replaceKstarJsonRecord(userId, 'task-states', validateState(userId, record as unknown as Record<string, unknown>, record.conversationId));
}

export async function readKstarTask(userId: string, taskId: string): Promise<KstarTaskRecord | null> {
  const raw = await readKstarJsonRecord(userId, 'tasks', taskId);
  return raw ? validateTask(userId, raw as Record<string, unknown>) : null;
}

export async function replaceKstarTask(userId: string, record: KstarTaskRecord): Promise<KstarTaskRecord> {
  return replaceKstarJsonRecord(userId, 'tasks', validateTask(userId, record as unknown as Record<string, unknown>));
}

export async function readKstarRequirement(userId: string, requirementId: string): Promise<KstarRequirementRecord | null> {
  const raw = await readKstarJsonRecord(userId, 'requirements', requirementId);
  return raw ? validateRequirement(userId, normalizeRequirementForRead(raw as Record<string, unknown>)) : null;
}

export async function replaceKstarRequirement(userId: string, record: KstarRequirementRecord): Promise<KstarRequirementRecord> {
  return replaceKstarJsonRecord(userId, 'requirements', validateRequirement(userId, record as unknown as Record<string, unknown>));
}

export async function listKstarRequirementsForTask(userId: string, taskId: string): Promise<KstarRequirementRecord[]> {
  if (!safeId(taskId)) throw new Error('invalid kstar task id');
  const records = await listKstarJsonRecords(userId, 'requirements');
  return records
    .map((record) => validateRequirement(userId, normalizeRequirementForRead(record as Record<string, unknown>)))
    .filter((record) => record.taskId === taskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}


export async function findKstarRequirementByProjection(
  userId: string,
  conversationId: string,
  projectionId: string,
): Promise<KstarRequirementRecord> {
  if (!safeId(conversationId) || !safeId(projectionId)) throw new Error('invalid kstar projection lookup');
  const records = await listKstarJsonRecords(userId, 'requirements');
  const matches = records
    .map((record) => validateRequirement(userId, normalizeRequirementForRead(record as Record<string, unknown>)))
    .filter((record) => record.conversationId === conversationId && record.projectionId === projectionId);
  if (matches.length === 0) throw new Error('no kstar requirement matches conversation and projection');
  if (matches.length > 1) throw new Error('multiple kstar requirements match conversation and projection');
  return matches[0];
}

export async function bindKstarRequirementWakeRequestByProjection(
  userId: string,
  conversationId: string,
  projectionId: string,
  wakeRequestId: string,
): Promise<KstarRequirementRecord> {
  if (
    !safeId(conversationId) ||
    !safeId(projectionId) ||
    !safeId(wakeRequestId)
  ) throw new Error('invalid kstar projection wake binding id');
  const records = await listKstarJsonRecords(userId, 'requirements');
  const matches = records
    .map((record) => validateRequirement(userId, normalizeRequirementForRead(record as Record<string, unknown>)))
    .filter((record) => record.conversationId === conversationId && record.projectionId === projectionId);
  if (matches.length === 0) throw new Error('no kstar requirement matches conversation and projection');
  if (matches.length > 1) throw new Error('multiple kstar requirements match conversation and projection');
  const requirement = matches[0];
  if (requirement.wakeRequestId && requirement.wakeRequestId !== wakeRequestId) {
    throw new Error('kstar requirement is already bound to another wake request');
  }
  if (requirement.wakeRequestId === wakeRequestId) return requirement;
  return replaceKstarRequirement(userId, { ...requirement, wakeRequestId, updatedAt: nowIso() });
}

export type { KstarRequirementStatus, KstarTaskPhase };
