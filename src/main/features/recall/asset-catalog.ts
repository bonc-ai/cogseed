import type { RecallAbilityAssetRecord } from './candidate-service';
import { listRecallUsage } from './usage-service';

/**
 * 资产目录的**紧凑文本 + 使用统计**（2026-09-18 抽出共用）。
 *
 * 两个消费方共用同一份格式，避免"模型看到的目录"与"工具返回的目录"长得不一样：
 *   - `search_ability_assets` 目录模式（工具内返回）；
 *   - 回合提示词里的常驻目录（小库直接进上下文，省掉一次工具往返）。
 *
 * 预算（有测试钉着）：每条 ≤ 110 字符；标题 14、一句话 22、适用 12、页眉页脚 ≤ 250。
 */

export interface AssetUsageStat {
  count: number;
  lastAt?: string;
}

const TYPE_LABELS: Record<string, string> = {
  rule: '规则',
  template: '模板',
  skill_method: '技能',
  personal: '偏好',
};
/** 成熟度显示两态（2026-09-22 刀三）：seed/bud=未验证、transfer+=已实证；
 *  正式的档位命名（认知树映射层）后置统一再定，这里先用工作名。 */
const MATURITY_LABELS: Record<string, string> = {
  seed: '未验证',
  bud: '未验证',
  transfer_validated: '已实证',
  effectiveness_validated: '已实证',
};

export function catalogOneLine(statement?: string, limit = 22): string {
  const text = String(statement || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const first = (text.split(/[。！？!?]/)[0] || text).trim();
  const cut = first.length > limit ? first.slice(0, limit) : first;
  return cut.replace(/[，、；：,;:\-—\s]+$/, '');
}

export function catalogTruncate(value: string, limit: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).replace(/[，、；：,;:\-—\s]+$/, '')}…`;
}

export function catalogScopeLabel(scope?: string): string {
  const value = String(scope || '').trim();
  if (!value || value.toLowerCase() === 'general') return '通用';
  return value;
}

/** 目录条目：一行"标题 + 一句话"，第二行短标签元信息 + 适用首条。
 *  禁用场景不进目录（由服务端硬闸执行，读取与注入块里完整给出）。 */
export function formatCatalogEntry(
  asset: RecallAbilityAssetRecord,
  stat: AssetUsageStat | undefined,
  index: number,
  relevant = false,
): string {
  const type = TYPE_LABELS[String(asset.type || '')] || String(asset.type || '?');
  const maturity = MATURITY_LABELS[String(asset.maturity || '')] || String(asset.maturity || '?');
  const meta = [
    type,
    catalogScopeLabel(asset.scope),
    maturity,
    `v${asset.activeVersion || asset.version || '1'}`,
    stat && stat.count ? `用${stat.count}次` : '没用过',
  ].join('·');
  const applies = (asset.applicableWhen || [])[0];
  const oneLine = catalogOneLine(asset.statement);
  const head = `${index}. ${relevant ? '★' : ''}[asset:${asset.id}] ${catalogTruncate(String(asset.title || '(无标题)'), 14)}`;
  return [
    oneLine ? `${head} — ${oneLine}` : head,
    ` ${meta}${applies ? `｜适用:${catalogTruncate(String(applies), 12)}` : ''}`,
  ].join('\n');
}

/** 目录正文（不含页眉页脚）：工具与提示词共用。 */
/** 目录正文（不含页眉页脚）：工具与提示词共用。relevantIds＝当轮相关条（★ 标记）。 */
export function formatCatalogEntries(
  assets: RecallAbilityAssetRecord[],
  stats: Map<string, AssetUsageStat>,
  startIndex = 1,
  relevantIds?: ReadonlySet<string>,
): string[] {
  return assets.map((asset, index) => formatCatalogEntry(asset, stats.get(asset.id), startIndex + index, relevantIds?.has(asset.id) === true));
}

/** 每条的取用次数与最近时间（一次流水扫描）。消费方各自缓存（提示词侧 60 秒
 *  TTL），避免每回合重复扫流水。 */
export async function loadAssetUsageStats(userId: string): Promise<Map<string, AssetUsageStat>> {
  const stats = new Map<string, AssetUsageStat>();
  for (const row of await listRecallUsage(userId)) {
    const id = String(row.assetId || '');
    if (!id) continue;
    const current = stats.get(id) || { count: 0 };
    current.count += 1;
    const at = String(row.createdAt || '');
    if (at && (!current.lastAt || at > current.lastAt)) current.lastAt = at;
    stats.set(id, current);
  }
  return stats;
}

/** 使用统计的进程内缓存（**按回合**，2026-09-18 效率版）：目录每次调用都全量扫
 *  一遍使用流水是纯浪费，但"按 30 秒 TTL"会把跨回合的计数也冻住（用户在两个回合
 *  之间做的取用看不出来）。按 turnId 做键最准：同一回合内重复调用复用同一份快照，
 *  新回合必然重算；没有回合上下文时直读，不缓存（宁可慢，不可错）。 */
let usageCache: { key: string; stats: Map<string, AssetUsageStat> } | null = null;

export function resetAssetUsageStatsCacheForTest(): void {
  usageCache = null;
}

export async function loadAssetUsageStatsCached(userId: string, turnId?: string): Promise<Map<string, AssetUsageStat>> {
  const key = turnId ? `${userId}:${turnId}` : '';
  if (key && usageCache && usageCache.key === key) return usageCache.stats;
  const stats = await loadAssetUsageStats(userId);
  if (key) usageCache = { key, stats };
  return stats;
}
