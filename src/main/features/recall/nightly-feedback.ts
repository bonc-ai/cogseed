/** Supporting input ledger for the sole nightly formation pipeline. */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../../logger';
import { recallJsonRecordPath } from './paths';
import { safeId } from '../../storage';
import { updateRecallJsonRecord, readRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';

import { validGroupExecutionSource, type GroupExecutionResultSource } from './execution-result-content';
const log = createLogger('recall.nightly-feedback');

export interface NightlyFeedbackRecord extends RecallJsonRecord {
  id: string; conversationId: string; messageId: string; assetId: string; assetVersion: string;
  taskRunId: string; feedback: 'positive' | 'negative' | 'neutral' | 'invalid' | 'rework';
  resultSource?: GroupExecutionResultSource;
  note?: string; status: 'queued' | 'admitted'; createdAt: string; updatedAt: string; captureId?: string;
}
export type NightlyFeedbackObservation = Pick<NightlyFeedbackRecord, 'id' | 'messageId' | 'assetId' | 'assetVersion' | 'taskRunId' | 'feedback' | 'updatedAt' | 'note' | 'resultSource'>;
const collection = 'nightly-feedback';

export async function queueNightlyFeedback(userId: string, input: Omit<NightlyFeedbackObservation, 'id' | 'updatedAt'> & { conversationId: string; observedAt?: string }) {
  if (![userId, input.conversationId, input.messageId, input.assetId, input.taskRunId].every(safeId)
    || !/^\d{1,9}$/.test(input.assetVersion) || !['positive', 'negative', 'neutral', 'invalid', 'rework'].includes(input.feedback))
    throw new Error('invalid nightly feedback reference');
  if (input.resultSource && (!validGroupExecutionSource(input.resultSource) || input.resultSource.conversationId !== input.conversationId)) throw new Error('invalid feedback execution source');
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 4000)) throw new Error('invalid feedback note');
  if (input.observedAt !== undefined && !Number.isFinite(Date.parse(input.observedAt))) throw new Error('invalid feedback observation time');
  const id = 'nf-' + createHash('sha256').update(JSON.stringify([input.conversationId, input.messageId, input.assetId, input.assetVersion, ...(input.resultSource ? [input.resultSource.executionId] : [])])).digest('hex').slice(0, 24);
  const now = input.observedAt ? new Date(input.observedAt).toISOString() : new Date().toISOString();
  const { observedAt: _observedAt, ...event } = input;
  return updateRecallJsonRecord(userId, collection, id, current => current && (typeof current.updatedAt === 'string'
    && (current.updatedAt > now || input.observedAt !== undefined && current.updatedAt === now)
    || current.feedback === input.feedback && current.note === input.note) ? current : {
    schemaVersion: 1, ownerId: userId, id, ...event, status: 'queued', createdAt: current?.createdAt || now, updatedAt: now,
  });
}
export async function queuedNightlyFeedback(userId: string): Promise<NightlyFeedbackRecord[]> {
  let names: string[];
  try { names = await fs.readdir(path.dirname(recallJsonRecordPath(userId, collection, 'placeholder'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const rows = await Promise.all(names.filter(name => name.endsWith('.json') && safeId(name.slice(0, -5))).map(name => readRecallJsonRecord(userId, collection, name.slice(0, -5))));
  return rows.filter(row => !!row).filter(row => row!.ownerId === userId && row!.status === 'queued'
    && safeId(row!.conversationId) && safeId(row!.messageId) && typeof row!.updatedAt === 'string') as NightlyFeedbackRecord[];
}
export function feedbackObservation(record: NightlyFeedbackRecord): NightlyFeedbackObservation {
  return { id: record.id, messageId: record.messageId, assetId: record.assetId, assetVersion: record.assetVersion,
    ...(record.resultSource ? { resultSource: record.resultSource } : {}),
    taskRunId: record.taskRunId, feedback: record.feedback, updatedAt: record.updatedAt, ...(record.note ? { note: record.note } : {}) };
}
export async function admitNightlyFeedback(userId: string, observation: NightlyFeedbackObservation, captureId: string): Promise<boolean> {
  const current = await readRecallJsonRecord(userId, collection, observation.id);
  if (!current) {
    // A queued row can be removed between queueing and admission; missing is
    // not a malformed record and must not be retried as a transient failure.
    log.warn('nightly feedback record missing; admission skipped', { feedbackId: observation.id, captureId });
    return false;
  }
  await updateRecallJsonRecord(userId, collection, observation.id, row => !row || row.updatedAt !== observation.updatedAt ? row!
    : { ...row, status: 'admitted', captureId });
  return true;
}
