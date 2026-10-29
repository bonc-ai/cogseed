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
  // 先滤后截（2026-10-01 质检 P-r1-77）：过滤必须在全集上做，截断只发生在
  // 攒够 limit 条之后。此前先截 3 倍窗口再过滤，窗口外的命中被静默丢弃——
  // 按 skillId / agentId / conversationId 过滤时「最近没用」伪装成「从未用过」。
  // 补执行记录仍按新到旧逐条读盘（贵在读 IO，不在比对）：回执本体就能判的
  // 谓词（status / skillId）先零 IO 收紧候选池，只有按 agentId /
  // conversationId 过滤时才需要边读边判；无论哪种，攒够 limit 条即停——
  // 无过滤的常见路径补读数反而从 3×limit 降到 limit。
  const ordered = receipts.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const pool = ordered.filter((receipt) => {
    if (filter.status && mapStatus(receipt.status) !== filter.status) return false;
    if (filter.skillId && !receiptReferencesSkill(receipt, filter.skillId)) return false;
    return true;
  });
  const out: CognitionReuseReceiptView[] = [];
  let skipped = 0;
  for (const receipt of pool) {
    if (out.length >= limit) break;
    try {
      const execution = await executionRecords.read(userId, receipt.executionId).catch(() => undefined);
      const view = mapReceipt(receipt, execution);
      // 最终裁决仍走 matches 单一口径（池子预筛只是省 IO 的优化，不是第二套判据）。
      if (matches(view, receipt, filter)) out.push(view);
    } catch (error) {
      skipped += 1;
      log.warn('unreadable cognition reuse receipt skipped', {
        receiptId: receipt.receiptId, error: (error as Error).message,
      });
    }
  }
  if (skipped) log.warn('skipped unreadable cognition reuse receipts', { skipped });
  return out;
}
