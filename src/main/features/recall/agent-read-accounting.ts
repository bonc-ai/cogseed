/** Shared accounting for full asset bodies delivered to a model. Reading is never adoption. */
import { createLogger } from '../../logger';
import { logErrorRef, maskId } from '../../util/log-redact';
import { recordInjectionReceipt, listInjectionReceipts } from './injection-receipt';
import { recordRecallUsage } from './usage-service';
const log = createLogger('asset-agent-read');
export interface AssetAgentReadContext { userId: string; turnId?: string; cid?: string; spaceId?: string; }
export async function recordAssetAgentReads(
  opts: AssetAgentReadContext,
  entries: Array<{ assetId: string; assetVersion: string }>,
): Promise<void> {
  const turnId = String(opts.turnId || '');
  if (!entries.length) return;
  if (!turnId) {
    // taskRunId 必填；没有回合 id 时如实告警，不能静默丢弃读取记录。
    log.warn('agent_read not recorded: tool built without a turn id', { userId: maskId(opts.userId) });
    return;
  }
  try {
    // 「为什么排前」拆解随回执留痕，与派发侧使用同一份当轮排序视图：
    // 只查 asset-catalog-hint 当轮 ranked 视图（userId+cid 同键），不在记账
    // 路径重算（排序唯一处）；没建过目录 / 会话对不上 → 空 Map，不带
    // ranking（读取侧 explainable:false，如实说「没有记录」）。
    const { lastCatalogRankedForTurn } = await import('./asset-catalog-hint');
    const { explainRanking } = await import('./asset-ranking');
    const rankedThisTurn: ReadonlyMap<string, import('./asset-ranking').RankedAsset>
      = opts.cid ? lastCatalogRankedForTurn(opts.userId, opts.cid, opts.turnId) : new Map();
    const seenThisTurn = new Set(
      (await listInjectionReceipts(opts.userId, turnId))
        .filter((row) => String(row.channel || '') === 'agent_read')
        .map((row) => String(row.assetId || '')),
    );
    for (const entry of entries) {
      const rankedRow = rankedThisTurn.get(entry.assetId);
      await recordInjectionReceipt(opts.userId, {
        taskRunId: turnId,
        assetId: entry.assetId,
        assetVersion: entry.assetVersion,
        boundary: 'real',
        status: 'injected',
        channel: 'agent_read',
        ...(rankedRow ? { ranking: explainRanking(rankedRow) } : {}),
      });
      if (seenThisTurn.has(entry.assetId)) continue;
      seenThisTurn.add(entry.assetId);
      await recordRecallUsage(opts.userId, {
        assetId: entry.assetId,
        assetVersion: entry.assetVersion,
        taskRunId: turnId,
        ...(opts.spaceId ? { workspaceId: opts.spaceId } : {}),
        boundary: 'real',
        outcome: 'agent_read',
      });
    }
  } catch (err) {
    log.warn('agent_read accounting failed', { userId: maskId(opts.userId), error: logErrorRef(err as Error) });
  }
}
