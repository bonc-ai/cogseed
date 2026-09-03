import { createHash } from 'node:crypto';

import { appendRecallJsonlRecord, listRecallJsonlRecords } from './store';
import type { RecallJsonRecord } from './types';
import { safeId } from '../../storage';

export interface InjectionReceipt extends RecallJsonRecord {
  schemaVersion: 1;
  taskRunId: string;
  projectionId?: string;
  assetId: string;
  assetVersion: string;
  boundary: 'real' | 'degraded' | 'test-double';
  status: 'injected' | 'dispatched' | 'omitted' | 'failed';
  messageId?: string;
  createdAt: string;
}

const INJECTION_BOUNDARIES = new Set<InjectionReceipt['boundary']>(['real', 'degraded', 'test-double']);
const INJECTION_STATUSES = new Set<InjectionReceipt['status']>(['injected', 'dispatched', 'omitted', 'failed']);

function asInjectionReceipt(userId: string, value: RecallJsonRecord): InjectionReceipt {
  if (
    value.schemaVersion !== 1
    || value.ownerId !== userId
    || !safeId(value.id)
    || !safeId(value.taskRunId)
    || (value.projectionId !== undefined && !safeId(value.projectionId))
    || !safeId(value.assetId)
    || typeof value.assetVersion !== 'string'
    || !value.assetVersion.trim()
    || !INJECTION_BOUNDARIES.has(value.boundary as InjectionReceipt['boundary'])
    || !INJECTION_STATUSES.has(value.status as InjectionReceipt['status'])
    || (value.messageId !== undefined && !safeId(value.messageId))
    || typeof value.createdAt !== 'string'
  ) throw new Error('malformed injection receipt');
  return value as InjectionReceipt;
}

export async function recordInjectionReceipt(
  userId: string,
  input: {
    taskRunId: string; projectionId?: string; assetId: string; assetVersion: string;
    boundary: InjectionReceipt['boundary']; status: InjectionReceipt['status']; messageId?: string;
  },
): Promise<InjectionReceipt> {
  if (
    !safeId(userId)
    || !safeId(input.taskRunId)
    || (input.projectionId !== undefined && !safeId(input.projectionId))
    || !safeId(input.assetId)
    || typeof input.assetVersion !== 'string'
    || !input.assetVersion.trim()
    || !INJECTION_BOUNDARIES.has(input.boundary)
    || !INJECTION_STATUSES.has(input.status)
    || (input.messageId !== undefined && !safeId(input.messageId))
  ) throw new Error('invalid injection receipt reference');
  const key = `${input.taskRunId}:${input.assetId}:${input.assetVersion}:${input.status}:${input.messageId || ''}`;
  const record: InjectionReceipt = {
    schemaVersion: 1, ownerId: userId,
    id: `inj-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
    taskRunId: input.taskRunId, ...(input.projectionId ? { projectionId: input.projectionId } : {}),
    assetId: input.assetId, assetVersion: input.assetVersion, boundary: input.boundary,
    status: input.status, ...(input.messageId ? { messageId: input.messageId } : {}),
    createdAt: new Date().toISOString(),
  };
  const existing = (await listInjectionReceipts(userId))
    .find((item) => item.id === record.id);
  if (existing) return existing;
  await appendRecallJsonlRecord(userId, 'injection-receipts', 'events', record);
  return record;
}

export async function listInjectionReceipts(userId: string, taskRunId?: string): Promise<InjectionReceipt[]> {
  if (!safeId(userId) || (taskRunId !== undefined && !safeId(taskRunId))) {
    throw new Error('invalid injection receipt reference');
  }
  const records = (await listRecallJsonlRecords(userId, 'injection-receipts', 'events', 0))
    .map((record) => asInjectionReceipt(userId, record));
  return records.filter((record) => !taskRunId || record.taskRunId === taskRunId);
}

/** Exact host-side lookup. Receipt ids are validated before the JSONL stream
 * is touched so callers cannot turn a lookup into a path/reference probe. */
export async function readInjectionReceipt(userId: string, receiptId: string): Promise<InjectionReceipt | undefined> {
  if (!safeId(userId) || !safeId(receiptId)) throw new Error('invalid injection receipt reference');
  return (await listInjectionReceipts(userId)).find((record) => record.id === receiptId);
}
