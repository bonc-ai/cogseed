/**
 * 保留期到期清理（specs/008 T005 · US-306 交付项，验收归 specs/010）。
 *
 * 口径（2026-09-24 定，不得偏离）：删除后 30 天内可恢复；保留期内可在
 * 「已删除」列表对单条「立即彻底删除」；**到期系统自动彻底删除**（内容与记录
 * 一并清除、搜索不可见、不可恢复）。级联清理在 `asset-service.ts::purgeAbilityAsset`。
 *
 * 三个刻意的选择：
 *   ① **低频周期 + 启动后延迟一轮**：到期是日期边界不是用户动作，"晚一小时清"
 *      与"到期即清"在语义上没有差别，却省掉一个常驻高频定时器、也不跟启动期
 *      抢磁盘；
 *   ② **只清"deletedAt 可解析且确已过期"的记录**。时间戳缺失/损坏的已删除记录
 *      属于"时间不明"而不是"已到期"——在歧义上销毁数据比留着一条（本来就已
 *      不可恢复的）记录更糟，这类记录只记日志、等人工处置；
 *   ③ **不设"已处理"标记位**：purged 是终态（`setStatus` 的 `assertNotPurged`
 *      会拒绝二次清除），所以重复执行既无对象也不会重复记账。幂等靠状态机，
 *      不靠额外记账。
 */

import {
  ABILITY_ASSET_DELETION_RETENTION_DAYS,
  isWithinDeletionRetention,
  listAbilityAssets,
  purgeAbilityAsset,
} from './asset-service';
import { createLogger } from '../../logger';
import { logErrorRef, maskId } from '../../util/log-redact';
import { scheduleBootBackground, type ScheduledBootBackgroundTask } from '../../util/boot_init';

const log = createLogger('recall.asset-retention');

/** 到期清理的周期。到期是日期边界，一天一清也不算迟；一小时是"用户感觉不到
 *  延迟、又不会留下整天窗口"的折中。 */
export const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** 台账里"为什么被清除"的依据文本（自动清理必须能自证来由）。天数取自唯一的
 *  常量，不在这里重抄一个 30。 */
export const RETENTION_EXPIRY_REASON =
  `保留期（${ABILITY_ASSET_DELETION_RETENTION_DAYS} 天）届满，系统自动彻底删除`;

export interface RetentionSweepResult {
  /** 扫过的资产总数（含未到期与其它状态）。 */
  scanned: number;
  /** 本轮真正清除的资产 id。 */
  purged: string[];
  /** 已删除但 deletedAt 缺失/损坏、**未**自动清除的资产 id。 */
  ambiguous: string[];
  /** 清除失败的资产（单个失败不中断整轮）。 */
  failed: Array<{ assetId: string; error: string }>;
}

function hasParsableDeletedAt(asset: { deletedAt?: string }): boolean {
  return typeof asset.deletedAt === 'string' && !Number.isNaN(Date.parse(asset.deletedAt));
}

/**
 * 跑一轮到期清理。`now` 可注入，供测试跨过 30 天边界而不改系统时钟。
 */
export async function runAbilityAssetRetentionSweep(
  userId: string,
  options: { now?: Date } = {},
): Promise<RetentionSweepResult> {
  const now = options.now ?? new Date();
  const assets = await listAbilityAssets(userId);
  const result: RetentionSweepResult = { scanned: assets.length, purged: [], ambiguous: [], failed: [] };

  for (const asset of assets) {
    if (asset.status !== 'deleted') continue;
    if (!hasParsableDeletedAt(asset)) {
      // 时间不明 ≠ 已到期：不替用户销毁它，但要留下痕迹等人工处置。
      result.ambiguous.push(asset.id);
      log.warn('retention sweep skipped an asset with an unparsable deletedAt', {
        userId: maskId(userId),
        assetId: asset.id,
      });
      continue;
    }
    if (isWithinDeletionRetention(asset, now)) continue;
    try {
      await purgeAbilityAsset(userId, asset.id, { actor: 'system', reason: RETENTION_EXPIRY_REASON }, { requireDeleted: true });
      result.purged.push(asset.id);
    } catch (err) {
      result.failed.push({ assetId: asset.id, error: (err as Error).message });
      log.warn('retention sweep purge failed', {
        userId: maskId(userId),
        assetId: asset.id,
        error: logErrorRef(err as Error),
      });
    }
  }

  if (result.purged.length) {
    log.info('retention sweep purged expired assets', {
      userId: maskId(userId),
      count: result.purged.length,
    });
  }
  return result;
}

export interface RetentionSweepHandle {
  stop(): void;
}

/**
 * 启动低频清理循环：立即排一轮，此后每 `intervalMs` 一轮，直到 `stop()`。
 * 走 `scheduleBootBackground` 的准入与空闲等待（与 reflection 循环同款），
 * 不用裸定时器。
 */
export function startAbilityAssetRetentionLoop(
  userId: string,
  intervalMs: number = RETENTION_SWEEP_INTERVAL_MS,
): RetentionSweepHandle {
  let scheduled: ScheduledBootBackgroundTask | null = null;
  let stopped = false;

  const scheduleNext = (delayMs: number): void => {
    scheduled = scheduleBootBackground('recall:retention-sweep', async (signal) => {
      if (stopped || signal?.aborted) return;
      try {
        await runAbilityAssetRetentionSweep(userId);
      } catch (err) {
        // 单轮失败不终止循环：保留期清理没有时效性，下一轮重试即可。
        log.error('retention sweep threw', { userId: maskId(userId), error: logErrorRef(err as Error) });
      }
    }, delayMs, { resourceClass: 'disk', preferIdle: true, maxSliceMs: 20_000 });
    void scheduled.promise.finally(() => {
      scheduled = null;
      if (!stopped) scheduleNext(intervalMs);
    });
  };

  scheduleNext(0);
  return {
    stop() {
      stopped = true;
      scheduled?.cancel();
      scheduled = null;
    },
  };
}
