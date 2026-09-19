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

/** 当轮相关度（2026-09-22 砍注入后的算法落点）：拿当轮任务文本与资产算
 *  余弦，相关 ≥0.40 标 ★、相关分参与排序——只当参谋帮模型定位，不注入正文。
 *  embedding 不可用回退纯使用次数排序（目录本身不受影响）。 */
const CATALOG_RELEVANT_MARK = 0.40;

async function relevanceScores(userId: string, taskText: string, assets: Array<{ id: string; statement: string; title: string }>): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  try {
    const { embedForDedup, cosineScore } = await import('./similarity');
    const query = await embedForDedup(userId, taskText);
    if (!query) return scores;
    for (const asset of assets) {
      const vector = await embedForDedup(userId, String(asset.statement || asset.title || ''));
      if (vector) scores.set(asset.id, cosineScore(query, vector));
    }
  } catch { /* 相关度是增强：拿不到就按使用次数排 */ }
  return scores;
}

async function buildCatalogPrompt(userId: string, cid: string, taskText = ''): Promise<{ count: number; text: string }> {
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
  // 当轮相关度（有任务文本才算）：★ 标记 + 排序加权（相关优先于使用次数）。
  const relevance = taskText ? await relevanceScores(userId, taskText, active) : new Map<string, number>();
  const relevantIds = new Set([...relevance.entries()].filter(([, score]) => score >= CATALOG_RELEVANT_MARK).map(([id]) => id));
  const relevanceRank = (asset: typeof active[number]): number => (relevantIds.has(asset.id) ? 1 : 0);
  const relevanceScore = (asset: typeof active[number]): number => (relevance.get(asset.id) || 0);
  const usageRank = (left: typeof active[number], right: typeof active[number]): number => {
    const byCount = (stats.get(right.id)?.count || 0) - (stats.get(left.id)?.count || 0);
    if (byCount !== 0) return byCount;
    return String(stats.get(right.id)?.lastAt || right.updatedAt || '').localeCompare(String(stats.get(left.id)?.lastAt || left.updatedAt || ''));
  };
  // 大库（>30 条）：相关条优先占位，余量按"用得多 + 最近用过"；目录可见性
  // 优先于页码顺序（当轮相关的资产不能翻到第二页才被看见）。
  const sorted = [...active].sort((left, right) => {
    const byRelevanceClass = relevanceRank(right) - relevanceRank(left);
    if (byRelevanceClass !== 0) return byRelevanceClass;
    const byRelevanceScore = relevanceScore(right) - relevanceScore(left);
    if (byRelevanceScore !== 0) return byRelevanceScore;
    return usageRank(left, right);
  });
  const inline = total > INLINE_CATALOG_MAX_ENTRIES ? sorted.slice(0, 20) : sorted;
  const lines = formatCatalogEntries(inline, stats, 1, relevantIds);
  const more = total - inline.length;
  const marked = relevantIds.size;
  return {
    count: total,
    text: [
      `Asset catalog (${total} reusable assets${marked ? `, ${marked} look relevant to this turn (★)` : ''}; one compact line each — pull the full text with`,
      'search_ability_assets + assetIds when one fits, and attach_assets_to_task to keep using it):',
      ...lines,
      ...(more > 0
        ? [`…还有 ${more} 条：可用 search_ability_assets 带 query 语义检索（比翻页快），或不带参数（可带 offset）翻页查看更多。`]
        : []),
    ].join('\n'),
  };
}

/** 目录文本（带 60 秒 TTL 缓存）；读不到或没有资产时返回空串。
 *  taskText 非空时按当轮相关度排序＋★标记，**不落缓存**（任务文本每轮变，
 *  缓存住相关排序等于把上一轮的判断塞给下一轮）。 */
export async function assetCatalogForPrompt(userId: string, cid = '', now = Date.now(), taskText = ''): Promise<string> {
  if (!taskText && cache && cache.userId === userId && cache.cid === cid && now - cache.at < CACHE_TTL_MS) return cache.text;
  try {
    const built = await buildCatalogPrompt(userId, cid, taskText);
    const reuse = await recentAttachmentLine(userId, cid);
    const text = [built.text, reuse].filter(Boolean).join('\n\n');
    if (!taskText) cache = { userId, cid, at: now, count: built.count, text };
    return text;
  } catch (error) {
    // 读不到就什么都不加（而不是加一句"0 条"——那会让模型以为用户没有资产）。
    log.warn('asset catalog prompt unavailable', { userId: maskId(userId), error: logErrorRef(error as Error) });
    return '';
  }
}
