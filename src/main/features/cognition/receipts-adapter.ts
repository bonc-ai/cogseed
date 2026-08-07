import { createLogger } from '../../logger';
import { cognitionSourceRefKeys } from '../recall/source-service';
import * as executionRecords from '../execution-records';
import * as p3394 from '../p3394';
import type { ExecutionRecord } from '../execution-records';
import type { ContextReuseReceipt } from '../p3394';
import type { CognitionReceiptStatus, CognitionReuseReceiptView } from './types';

const log = createLogger('cognition.receipts-adapter');

export interface ListCognitionReceiptsFilter {
  status?: CognitionReceiptStatus;
  agentId?: string;
  conversationId?: string;
  skillId?: string;
  limit?: number;
}

function mapStatus(status: ContextReuseReceipt['status']): CognitionReceiptStatus {
  if (status === 'completed') return 'succeeded';
  if (status === 'degraded') return 'degraded';
  if (status === 'rejected') return 'rejected';
  return 'prepared';
}

function receiptReferencesSkill(receipt: ContextReuseReceipt, skillId: string): boolean {
  const refs = [...receipt.reusedRefs, ...receipt.omittedRefs];
  return refs.some((ref) => ref === `skill:${skillId}` || ref === `skill://${skillId}`);
}

function mapReceipt(receipt: ContextReuseReceipt, execution?: ExecutionRecord): CognitionReuseReceiptView {
  return {
    receiptId: receipt.receiptId,
    executionId: receipt.executionId,
    status: mapStatus(receipt.status),
    sourceSessionId: receipt.sourceSessionId,
    sourceContextId: receipt.sourceContextId,
    targetSessionId: receipt.targetSessionId,
    targetContextId: receipt.targetContextId,
    reusedRefs: receipt.reusedRefs,
    omittedRefs: receipt.omittedRefs,
    sourceRefs: cognitionSourceRefKeys([
      { kind: 'execution', id: receipt.executionId },
      ...(receipt.sourceContextId ? [{ kind: 'context', id: receipt.sourceContextId }] : []),
      ...(receipt.targetContextId ? [{ kind: 'context', id: receipt.targetContextId }] : []),
      ...receipt.reusedRefs,
      ...receipt.omittedRefs,
    ], 'artifact'),
    permissionMode: receipt.permissionMode,
    allowedScopes: receipt.allowedScopes,
    boundary: receipt.boundary,
    executionKind: execution?.kind,
    agentId: execution?.agentId,
    conversationId: execution?.conversationId,
    createdAt: receipt.createdAt,
    completedAt: receipt.completedAt,
  };
}

function matches(item: CognitionReuseReceiptView, receipt: ContextReuseReceipt, filter: ListCognitionReceiptsFilter): boolean {
  if (filter.status && item.status !== filter.status) return false;
  if (filter.agentId && item.agentId !== filter.agentId) return false;
  if (filter.conversationId && item.conversationId !== filter.conversationId) return false;
  if (filter.skillId && !receiptReferencesSkill(receipt, filter.skillId)) return false;
  return true;
}

export async function readCognitionReuseReceipt(userId: string, executionId: string): Promise<CognitionReuseReceiptView> {
  const [receipt, execution] = await Promise.all([
    p3394.readReceipt(userId, executionId),
    executionRecords.read(userId, executionId).catch(() => undefined),
  ]);
  return mapReceipt(receipt, execution);
}

export async function listCognitionReuseReceipts(
  userId: string,
  filter: ListCognitionReceiptsFilter = {},
): Promise<CognitionReuseReceiptView[]> {
  const limit = Math.min(Math.max(Number(filter.limit || 50), 1), 200);
  const records = (await executionRecords.list(userId)).filter((record) => !!record.receiptId).slice(0, Math.max(limit * 3, limit));
  const settled = await Promise.allSettled(records.map(async (record) => {
    const receipt = await p3394.readReceipt(userId, record.executionId);
    const view = mapReceipt(receipt, record);
    return matches(view, receipt, filter) ? view : null;
  }));
  const out: CognitionReuseReceiptView[] = [];
  let skipped = 0;
  for (const item of settled) {
    if (item.status === 'fulfilled') {
      if (item.value) out.push(item.value);
    } else {
      skipped += 1;
    }
  }
  if (skipped) log.warn('skipped unreadable cognition reuse receipts', { skipped });
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}
