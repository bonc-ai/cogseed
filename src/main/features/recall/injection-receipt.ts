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

export async function recordInjectionReceipt(
  userId: string,
  input: {
    taskRunId: string; projectionId?: string; assetId: string; assetVersion: string;
    boundary: InjectionReceipt['boundary']; status: InjectionReceipt['status']; messageId?: string;
  },
): Promise<InjectionReceipt> {
  if (!safeId(userId) || !safeId(input.taskRunId) || !safeId(input.assetId) || !input.assetVersion) throw new Error('invalid injection receipt reference');
  const key = `${input.taskRunId}:${input.assetId}:${input.assetVersion}:${input.status}:${input.messageId || ''}`;
  const record: InjectionReceipt = {
    schemaVersion: 1, ownerId: userId,
    id: `inj-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
    taskRunId: input.taskRunId, ...(input.projectionId ? { projectionId: input.projectionId } : {}),
    assetId: input.assetId, assetVersion: input.assetVersion, boundary: input.boundary,
    status: input.status, ...(input.messageId ? { messageId: input.messageId } : {}),
    createdAt: new Date().toISOString(),
  };
  const existing = (await listRecallJsonlRecords(userId, 'injection-receipts', 'events', 0) as unknown as InjectionReceipt[])
    .find((item) => item.id === record.id);
  if (existing) return existing;
  await appendRecallJsonlRecord(userId, 'injection-receipts', 'events', record);
  return record;
}

export async function listInjectionReceipts(userId: string, taskRunId?: string): Promise<InjectionReceipt[]> {
  const records = await listRecallJsonlRecords(userId, 'injection-receipts', 'events', 0) as unknown as InjectionReceipt[];
  return records.filter((record) => !taskRunId || record.taskRunId === taskRunId);
}
