import { genId12 } from '../../storage';
import { appendRecallJsonlRecord, listRecallJsonlRecords } from './store';
import type { RecallJsonRecord } from './types';
export interface RecallUsageRecord extends RecallJsonRecord { assetId: string; assetVersion: string; taskRunId: string; projectionId?: string; workspaceId?: string; messageId?: string; boundary?: 'real'|'degraded'|'test-double'; outcome?: string; createdAt: string; }
export interface RecordRecallUsageInput { assetId: string; assetVersion: string; taskRunId: string; projectionId?: string; workspaceId?: string; messageId?: string; boundary?: 'real'|'degraded'|'test-double'; outcome?: string; matchScore?: number; }
export async function recordRecallUsage(userId: string, input: RecordRecallUsageInput): Promise<RecallUsageRecord> { const createdAt = new Date().toISOString(); const record: RecallUsageRecord = { schemaVersion: 1, ownerId: userId, id: `usage-${genId12()}`, ...input, createdAt }; await appendRecallJsonlRecord(userId, 'usage-records', 'events', record); return record; }
export async function listRecallUsage(userId: string, assetId?: string): Promise<RecallUsageRecord[]> { const all = (await listRecallJsonlRecords(userId, 'usage-records', 'events', 0)) as RecallUsageRecord[]; return all.filter((row) => !assetId || row.assetId === assetId); }
