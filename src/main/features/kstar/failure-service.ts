import { createHash } from 'node:crypto';

import { nowIso, safeId } from '../../storage';
import { listKstarJsonRecords, readKstarJsonRecord, replaceKstarJsonRecord } from './episode-store';
import { listKstarRequirementsForTask, listKstarTasksForConversation } from './requirement-store';
import type { KstarFailureRecord, KstarFailureStage } from './types';

const MAX_ERROR_MESSAGE = 2_000;
const FAILURE_STAGES = new Set<KstarFailureStage>(['capture', 'review_inference', 'precipitation', 'control_receipt']);

export interface RecordKstarFailureInput {
  stage: KstarFailureStage;
  errorCode: string;
  errorMessage: string;
  operationKey: string;
  conversationId?: string;
  episodeId?: string;
  requirementId?: string;
  taskId?: string;
}

function bounded(value: string, max: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function failureId(input: RecordKstarFailureInput): string {
  const key = [input.stage, input.errorCode, input.operationKey, input.conversationId || '', input.episodeId || '', input.requirementId || '', input.taskId || ''].join(':');
  return `ksf-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

function validate(userId: string, value: unknown, expectedId?: string): KstarFailureRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed kstar failure record');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || row.ownerId !== userId || typeof row.id !== 'string' || !safeId(row.id) || (expectedId && row.id !== expectedId)
    || typeof row.stage !== 'string' || !FAILURE_STAGES.has(row.stage as KstarFailureStage)
    || typeof row.errorCode !== 'string' || !row.errorCode || typeof row.errorMessage !== 'string'
    || typeof row.at !== 'string' || typeof row.operationKey !== 'string' || !safeId(row.operationKey)
    || (row.conversationId !== undefined && (typeof row.conversationId !== 'string' || !safeId(row.conversationId)))
    || (row.episodeId !== undefined && (typeof row.episodeId !== 'string' || !safeId(row.episodeId)))
    || (row.requirementId !== undefined && (typeof row.requirementId !== 'string' || !safeId(row.requirementId)))
    || (row.taskId !== undefined && (typeof row.taskId !== 'string' || !safeId(row.taskId)))) {
    throw new Error('malformed kstar failure record');
  }
  return row as KstarFailureRecord;
}

export async function recordKstarFailure(userId: string, input: RecordKstarFailureInput): Promise<KstarFailureRecord> {
  if (!safeId(userId) || !FAILURE_STAGES.has(input.stage) || !safeId(input.operationKey)) throw new Error('invalid kstar failure reference');
  const record: KstarFailureRecord = {
    schemaVersion: 1, ownerId: userId, id: failureId(input), stage: input.stage,
    errorCode: bounded(input.errorCode, 120) || 'unknown', errorMessage: bounded(input.errorMessage, MAX_ERROR_MESSAGE) || 'Unknown KSTAR failure',
    at: nowIso(), operationKey: input.operationKey,
    ...(input.conversationId && safeId(input.conversationId) ? { conversationId: input.conversationId } : {}),
    ...(input.episodeId && safeId(input.episodeId) ? { episodeId: input.episodeId } : {}),
    ...(input.requirementId && safeId(input.requirementId) ? { requirementId: input.requirementId } : {}),
    ...(input.taskId && safeId(input.taskId) ? { taskId: input.taskId } : {}),
  };
  const existing = await readKstarJsonRecord(userId, 'failures', record.id);
  if (existing) return validate(userId, existing, record.id);
  return replaceKstarJsonRecord(userId, 'failures', record);
}

export async function listKstarFailures(userId: string, input: { conversationId?: string } = {}): Promise<KstarFailureRecord[]> {
  if (input.conversationId !== undefined && !safeId(input.conversationId)) throw new Error('invalid kstar failure conversation id');
  let failures = (await listKstarJsonRecords(userId, 'failures'))
    .map((record) => validate(userId, record))
    .sort((a, b) => b.at.localeCompare(a.at));
  if (input.conversationId === undefined) return failures;

  const tasks = await listKstarTasksForConversation(userId, input.conversationId);
  const taskIds = new Set(tasks.map((task) => task.id));
  const requirements = (await Promise.all(tasks.map((task) => listKstarRequirementsForTask(userId, task.id)))).flat();
  const requirementIds = new Set(requirements.map((requirement) => requirement.id));
  const episodeIds = new Set(requirements.flatMap((requirement) => requirement.episodeIds));
  failures = failures.filter((failure) => (
    failure.conversationId === input.conversationId
    || (failure.taskId !== undefined && taskIds.has(failure.taskId))
    || (failure.requirementId !== undefined && requirementIds.has(failure.requirementId))
    || (failure.episodeId !== undefined && episodeIds.has(failure.episodeId))
  ));
  return failures;
}
