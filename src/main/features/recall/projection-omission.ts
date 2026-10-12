import { createLogger } from '../../logger';
import { recordInjectionReceipt } from './injection-receipt';
import type { ContextProjectionRecord } from './context-projection';

const log = createLogger('recall.projection-omission');

/** 用户显式引用的资产在本轮被拦 → 留一条 omitted 回执（2026-09-25 验收修复
 *  US-604 AC4/AC7：发送前重检被拦不再静默）。
 *
 *  只对用户 @ 钉住的投影（`user_confirmed` + purpose `user_pinned`）留痕：语义/自动
 *  投影的省略是常态（相关性不够就不带），全记会给用户刷一屏噪声；而"我明明引用了
 *  却没带上"必须说得出原因。
 *
 *  `turnTaskRunId` 用**本轮**的 id（不是挂载时的 id）：同一挂载在不同轮次被拦各留
 *  一条，界面才能说明"最近这一轮为什么没带上"。
 *
 *  只存规则标识（`formal-assets/runtime.ts::assetRuntimeBlockRule` 的取值）——
 *  不存原因码原文、不存资产正文。留痕失败不影响注入本身（少一条说明好过整轮失败）。 */
export async function recordProjectionOmission(
  userId: string,
  projection: ContextProjectionRecord,
  asset: { id: string; version?: string },
  reason: string,
  turnTaskRunId?: string,
): Promise<void> {
  if (projection.authorization !== 'user_confirmed' || projection.purpose !== 'user_pinned') return;
  try {
    await recordInjectionReceipt(userId, {
      taskRunId: String(turnTaskRunId || projection.taskRunId),
      projectionId: projection.id,
      assetId: asset.id,
      assetVersion: String(projection.assetVersions?.[asset.id] || asset.version || ''),
      boundary: 'real',
      status: 'omitted',
      channel: 'projection',
      reason,
    });
  } catch (err) {
    log.warn('projection omission receipt failed', {
      projectionId: projection.id,
      assetId: asset.id,
      error: (err as Error)?.message || String(err),
    });
  }
}
