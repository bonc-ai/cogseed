/**
 * profile-block.ts — 背景块的资产库内容源（2026-09-19 合并实施·清单 #7）。
 *
 * 「我的画像＋核心偏好」从资产库渲染（type=personal、active），按使用次数
 * 取头部若干条——取代原"读 USER.md/MEMORY.md 全量"。过渡衔接：记忆文件尚
 * 有条目（迁移未跑）时由调用方回退文件渲染；迁移完成后文件为空、资产库
 * 自然接管，同一轮对话内无感切换。
 *
 * 预算对齐原 USER 档（1500 字量级）：条数封顶 + 单条截断 + 总长封顶。
 */

import type { RecallAbilityAssetRecord } from './candidate-service';

export const PROFILE_BLOCK_MAX_ENTRIES = 6;
export const PROFILE_ENTRY_MAX_CHARS = 500;
export const PROFILE_BLOCK_TOTAL_CHARS = 1_600;

export async function loadAssetProfileEntries(
  userId: string,
  deps: {
    listAssets?: (userId: string) => Promise<RecallAbilityAssetRecord[]>;
    usageCounts?: (userId: string) => Promise<ReadonlyMap<string, number>>;
  } = {},
): Promise<string[]> {
  const { listAbilityAssets } = await import('./asset-service');
  const { loadAssetUsageStats } = await import('./asset-catalog');
  const listAssets = deps.listAssets || ((uid: string) => listAbilityAssets(uid));
  const usageCounts = deps.usageCounts
    ? await deps.usageCounts(userId)
    : new Map(Object.entries(await loadAssetUsageStats(userId)).map(([id, stat]) => [id, stat.count]));

  const assets = (await listAssets(userId))
    .filter((asset) => asset.type === 'personal' && asset.status === 'active');
  // 三档排序（2026-09-19 画像三小修）：刚沉淀/确认的（72h 内）最优先——刚教
  // 的偏好立即生效，不被"用得少"压出块；其次用户确认过的；最后模型记的
  // 未验证。同档内使用次数为主、新近为辅。装不下的由常驻目录兜底。
  const RECENT_MS = 72 * 3600 * 1_000;
  const now = Date.now();
  const tierOf = (asset: RecallAbilityAssetRecord): number => {
    const updatedAt = Date.parse(asset.updatedAt || '') || 0;
    const confirmed = asset.lifecycleStatus === 'user_confirmed_unverified';
    if (now - updatedAt < RECENT_MS) return 3; // 新近沉淀/确认：最高档
    return confirmed ? 2 : 1;
  };
  const scoreOf = (asset: RecallAbilityAssetRecord): number => {
    const uses = usageCounts.get(asset.id) || 0;
    const recency = Date.parse(asset.updatedAt || '') || 0;
    return uses * 1_000_000_000_000 + recency;
  };
  return assets
    .slice()
    .sort((left, right) => (tierOf(right) - tierOf(left)) || (scoreOf(right) - scoreOf(left)))
    .slice(0, PROFILE_BLOCK_MAX_ENTRIES)
    .map((asset) => {
      const origin = asset.lifecycleStatus === 'user_confirmed_unverified' ? '[已确认] ' : '[模型记的] ';
      const text = String(asset.statement || '').replace(/\s+/g, ' ').trim();
      return text ? origin + text : '';
    })
    .filter(Boolean)
    .map((text) => (text.length > PROFILE_ENTRY_MAX_CHARS ? `${text.slice(0, PROFILE_ENTRY_MAX_CHARS - 1)}…` : text))
    .reduce<{ entries: string[]; total: number }>((acc, text) => {
      if (acc.total + text.length > PROFILE_BLOCK_TOTAL_CHARS) return acc;
      return { entries: [...acc.entries, text], total: acc.total + text.length };
    }, { entries: [], total: 0 })
    .entries;
}
