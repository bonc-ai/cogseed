import { createLogger } from '../../logger';
import { logErrorRef, maskId } from '../../util/log-redact';
import { formatCatalogEntries, loadAssetUsageStatsCached, type AssetUsageStat } from './asset-catalog';

const log = createLogger('recall.catalog-hint');

/**
 * 资产目录进入提示词的两条路（2026-09-18，可发现性）。
 *
 * 为什么需要：注入解决的是"这一轮相关"，但模型不会主动想到"这个用户还有别的
 * 资产可以看"——真机行为样本（3 类任务、不加任何提示）0/3 会去查目录；把工具
 * 描述写得更明确后升到 1/3；样本里的任务都已被注入命中，模型更没有动机再去找。
 * 结论：**别指望模型主动调工具，把目录直接放进它眼前**。
 *
 * 成本（小库）：8 条 ≈ 1KB，相对注入块 14,000 字上限可忽略；比"多一次工具往返"
 * 更便宜，也更可能真的被用上。库大了就退回一行提示 + 工具，避免提示词被目录撑爆。
 *
 * 缓存：目录文本与条数按用户 60 秒 TTL——内容变化不需要秒级反映，而每回合重扫
 * 资产目录 + 使用流水是纯浪费。
 */
const CACHE_TTL_MS = 60_000;
/** 常驻提示词的目录上限：超过就只给一行提示（30 × ~110 字符 ≈ 3.3KB）。 */
export const INLINE_CATALOG_MAX_ENTRIES = 30;

interface CatalogPromptCache {
  userId: string;
  cid: string;
  at: number;
  count: number;
  text: string;
}
let cache: CatalogPromptCache | null = null;

export function resetAssetCatalogHintCacheForTest(): void {
  cache = null;
}

/**
 * 跨会话复用提示（2026-09-18）：模型自选挂在单会话上——换会话就不再生效。与其
 * 让宿主偷偷继承（会在无关会话里冒出你没要的资产），不如把"上次挂过这些"说给
 * 模型听，由它决定要不要再挂一次（挂上你依然会看到卡、随时可撤销）。
 */
async function recentAttachmentLine(userId: string, cid: string): Promise<string> {
  if (!cid) return '';
  try {
    const { listContextProjections } = await import('./context-projection');
    const projections = await listContextProjections(userId, { status: 'confirmed', limit: 50 });
    const others = projections.filter((item) => item.authorization === 'model_selected' && item.conversationId && item.conversationId !== cid);
    if (!others.length) return '';
    const newest = others.sort((left, right) => String(right.decidedAt || right.createdAt || '').localeCompare(String(left.decidedAt || left.createdAt || '')))[0];
    const ids = newest.assetIds.slice(0, 6);
    if (!ids.length) return '';
    const titles: string[] = [];
    for (const assetId of ids) {
      try {
        const { readAbilityAsset } = await import('./asset-service');
        const asset = await readAbilityAsset(userId, assetId);
        if (asset) titles.push(String(asset.title || assetId).slice(0, 24));
      } catch {
        // 读不到就跳过（只影响提示文案）。
      }
    }
    if (!titles.length) return '';
    return [
      `Recently attached in another conversation: ${titles.join('、')}.`,
      'If this task needs them too, attach them again with attach_assets_to_task (the user sees a revocable card).',
    ].join(' ');
  } catch {
    return '';
  }
}

async function buildCatalogPrompt(userId: string, cid: string): Promise<{ count: number; text: string }> {
  const { listAbilityAssets } = await import('./asset-service');
  const assets = await listAbilityAssets(userId);
  const active = assets.filter((asset) => asset.status === 'active');
  if (!active.length) return { count: 0, text: '' };
  let stats = new Map<string, AssetUsageStat>();
  try {
    stats = await loadAssetUsageStatsCached(userId);
  } catch {
    // 使用次数拿不到不影响目录本身。
  }
  const total = active.length;
  // 大库（>30 条）也**给一段目录**：按"用得多 + 最近用过"取前 20 条内联，其余交给
  // 工具。真机样本已经证明"只给一句提示"模型多半不会去查（0-1/3），所以在预算内
  // 尽量让目录可见；超出部分用 offset 翻页拿。
  const inline = total > INLINE_CATALOG_MAX_ENTRIES
    ? [...active].sort((left, right) => {
      const leftStat = stats.get(left.id);
      const rightStat = stats.get(right.id);
      const byCount = (rightStat?.count || 0) - (leftStat?.count || 0);
      if (byCount !== 0) return byCount;
      return String(rightStat?.lastAt || right.updatedAt || '').localeCompare(String(leftStat?.lastAt || left.updatedAt || ''));
    }).slice(0, 20)
    : active;
  const lines = formatCatalogEntries(inline, stats);
  const more = total - inline.length;
  return {
    count: total,
    text: [
      `Asset catalog (${total} reusable assets; one compact line each — pull the full text with`,
      'search_ability_assets + assetIds when one fits, and attach_assets_to_task to keep using it):',
      ...lines,
      ...(more > 0
        ? [`…还有 ${more} 条：用 search_ability_assets（不带参数，可带 offset）翻页查看更多。`]
        : []),
    ].join('\n'),
  };
}

/** 目录文本（带 60 秒 TTL 缓存）；读不到或没有资产时返回空串。 */
export async function assetCatalogForPrompt(userId: string, cid = '', now = Date.now()): Promise<string> {
  if (cache && cache.userId === userId && cache.cid === cid && now - cache.at < CACHE_TTL_MS) return cache.text;
  try {
    const built = await buildCatalogPrompt(userId, cid);
    const reuse = await recentAttachmentLine(userId, cid);
    const text = [built.text, reuse].filter(Boolean).join('\n\n');
    cache = { userId, cid, at: now, count: built.count, text };
    return text;
  } catch (error) {
    // 读不到就什么都不加（而不是加一句"0 条"——那会让模型以为用户没有资产）。
    log.warn('asset catalog prompt unavailable', { userId: maskId(userId), error: logErrorRef(error as Error) });
    return '';
  }
}
