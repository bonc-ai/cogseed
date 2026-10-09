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

/**
 * 回执列表**以回执本身为准**，不再从 ExecutionRecord 的 `receiptId` 反查。
 *
 * 反查曾让这个列表恒空：群聊回合在 `bus.ts` 注入资产后直接
 * `prepareReceipt({ executionId: 'turn-<turnId>' })` 落回执，而同回合建立的
 * ExecutionRecord 从来没有人把 receiptId 回填上去（全仓仅 local_agents 那条
 * 独立链路会写这个字段）。于是回执文件真实存在、terminal-proof 也照常按
 * executionId 读到它并完成迁移证明，只有这个面向 UI 的读口看不见——实机可
 * 观测：4 条资产升到 transfer_validated、迁移证明 status=succeeded 且带
 * receiptId，而本函数返回 0 条。
 *
 * 权威源是 p3394 的回执目录（`<local>/kstar/executions/<id>/`）。ExecutionRecord
 * 在这里降级为**可选的展示补充**（executionKind / agentId / conversationId），
 * 取不到不影响回执本身出现在列表里。
 */
export async function listCognitionReuseReceipts(
  userId: string,
  filter: ListCognitionReceiptsFilter = {},
): Promise<CognitionReuseReceiptView[]> {
  const limit = Math.min(Math.max(Number(filter.limit || 50), 1), 200);
  let receipts: ContextReuseReceipt[];
  try {
    receipts = await p3394.listReceipts(userId);
  } catch (error) {
    log.warn('list cognition reuse receipts failed', { error: (error as Error).message });
    return [];
  }
  // 先按时间倒序截一个工作窗口再补执行记录：补充信息要按 executionId 逐条读盘，
  // 全量补一遍在回执攒多之后会很贵，而调用方只要最新的 limit 条。窗口留出
  // 冗余，给随后按 agentId / conversationId / skillId 的过滤留余量。
  const ordered = receipts.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const window = ordered.slice(0, Math.max(limit * 3, limit));
  const settled = await Promise.allSettled(window.map(async (receipt) => {
    const execution = await executionRecords.read(userId, receipt.executionId).catch(() => undefined);
    const view = mapReceipt(receipt, execution);
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
  return out.slice(0, limit);
}
