/**
 * 「版本与治理」的版本比对读口。
 *
 * 之前这一页只能列出版本号和时间，回答不了用户真正要问的那句话：**这一版
 * 到底改了什么。** 没有这个答案，"回滚到此版本"就是一次盲赌——用户只能靠
 * 时间戳猜哪一版是他要的。
 *
 * 数据不需要新增：每一版的 snapshot 本来就存了完整内容，这里只做比对。
 */

import { createLogger } from '../../logger';
import { listAbilityAssetVersions } from '../recall/asset-service';
import { buildAssetVersionDiffs, type AssetVersionDiff } from '../recall/formal-assets';

const log = createLogger('cognition.version-diff');

/**
 * 相邻两版之间的变更，最新的在前。没有版本历史、或历史里没有任何内容变化时
 * 返回空数组——第一版不产生 diff，谎称它改了每一个字段只是噪音。
 */
export async function listCognitionAssetDiffs(
  userId: string,
  assetId: string,
): Promise<AssetVersionDiff[]> {
  try {
    return buildAssetVersionDiffs(assetId, await listAbilityAssetVersions(userId, assetId));
  } catch (error) {
    log.warn('asset version diff read degraded', { userId, assetId, error: (error as Error).message });
    return [];
  }
}
