import { createLogger } from '../../logger';
import { logErrorRef, maskId } from '../../util/log-redact';
import { formatCatalogEntries, loadAssetUsageStatsCached } from './asset-catalog';

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
  at: number;
  count: number;
  text: string;
}
let cache: CatalogPromptCache | null = null;

export function resetAssetCatalogHintCacheForTest(): void {
  cache = null;
}

async function buildCatalogPrompt(userId: string): Promise<{ count: number; text: string }> {
  const { listAbilityAssets } = await import('./asset-service');
  const assets = await listAbilityAssets(userId);
  const active = assets.filter((asset) => asset.status === 'active');
  if (!active.length) return { count: 0, text: '' };
  if (active.length > INLINE_CATALOG_MAX_ENTRIES) {
    return {
      count: active.length,
      text: [
        `Asset catalog: ${active.length} reusable assets are stored for this user.`,
        'Skim it once before starting a task — call search_ability_assets with no arguments',
        '(one compact line per asset), then pull full text with assetIds when one fits it.',
        'Use attach_assets_to_task if this task should keep using it.',
      ].join(' '),
    };
  }
  let stats = new Map<string, { count: number }>();
  try {
    stats = await loadAssetUsageStatsCached(userId);
  } catch {
    // 使用次数拿不到不影响目录本身。
  }
  const lines = formatCatalogEntries(active, stats as never);
  return {
    count: active.length,
    text: [
      `Asset catalog (${active.length} reusable assets; one line each — pull the full text with`,
      'search_ability_assets + assetIds when one fits, and attach_assets_to_task to keep using it):',
      ...lines,
    ].join('\n'),
  };
}

/** 目录文本（带 60 秒 TTL 缓存）；读不到或没有资产时返回空串。 */
export async function assetCatalogForPrompt(userId: string, now = Date.now()): Promise<string> {
  if (cache && cache.userId === userId && now - cache.at < CACHE_TTL_MS) return cache.text;
  try {
    const built = await buildCatalogPrompt(userId);
    cache = { userId, at: now, count: built.count, text: built.text };
    return built.text;
  } catch (error) {
    // 读不到就什么都不加（而不是加一句"0 条"——那会让模型以为用户没有资产）。
    log.warn('asset catalog prompt unavailable', { userId: maskId(userId), error: logErrorRef(error as Error) });
    return '';
  }
}
