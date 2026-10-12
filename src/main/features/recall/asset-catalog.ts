import type { RecallAbilityAssetRecord } from './candidate-service';
import { listRecallUsage } from './usage-service';

/**
 * 资产目录的**紧凑文本 + 使用统计**（2026-09-18 抽出共用）。
 *
 * 两个消费方共用同一份行格式，避免"模型看到的目录"与"工具返回的目录"长得不一样：
 *   - `search_ability_assets` 目录模式（工具内返回）；
 *   - 回合提示词里的常驻目录（小库直接进上下文，省掉一次工具往返）。
 *
 * 预算（有测试钉着，口径＝标题行＋meta 行**两行合计、平均** ≤ 110 字符）：
 * 标题不截断（2026-09-28 标题一等化后标题本身合法、≤16 字，闸门在 asset-service
 * 收口处保证，目录行不再需要兜底截断）、一句话 22、适用 12、页眉页脚 ≤ 250。
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
  fact: '事实',
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
  // 标题不截断（2026-09-28 标题一等化 3.4）：标题经 3.2 收口闸门保证合法
  // （中文 ≤16 字），目录行原样给出；只有缺标题的记录才落「(无标题)」兜底。
  const head = `${index}. ${relevant ? '★' : ''}[asset:${asset.id}] ${String(asset.title || '(无标题)')}`;
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

/** 旧的带入流水统计保留供资产履历使用；目录展示改为实际采用次数。 */
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

/** 实际采用与明确纠错：只读派生，不落盘。
 * `applied && boundary='real'` 是采用唯一口径；`contradicted && real`
 * 单独记录质量纠错。展示、搜索命中、带入与「本轮没用」都不计作负反馈。
 *
 *  采用判定**只经 `listAppliedUsageReceipts`**（唯一处，反漂移 II3）：它要求
 *  非空 taskRunIds，所以先全量读一遍回执**收钥匙**（只收集 taskRunId 与时间戳，
 *  不做任何状态判定），再把全量钥匙传给它 = 继承判定本身、不过滤任务。
 *  同 id 多条回执（负反馈覆盖 append 的产物）由读取侧取末条，天然不双计。 */
export interface AssetAdoptionStat {
  appliedCount: number;
  /** 最近一条 applied 回执的时间（排序近度微调用；拿不到就缺省）。 */
  lastAppliedAt?: string;
  contradictedCount?: number;
  lastContradictedAt?: string;
}

export async function loadAssetAdoptionStats(userId: string): Promise<Map<string, AssetAdoptionStat>> {
  const stats = new Map<string, AssetAdoptionStat>();
  const { listAssetUsageReceipts, listAppliedUsageReceipts } = await import('./asset-usage-receipt');
  const receipts = await listAssetUsageReceipts(userId);
  const taskRunIds = [...new Set(receipts.map((row) => String(row.taskRunId || '')).filter(Boolean))];
  if (!taskRunIds.length) return stats;
  const applied = await listAppliedUsageReceipts(userId, { taskRunIds });
  const createdAtById = new Map(receipts.map((row) => [row.id, String(row.createdAt || '')]));
  for (const receipt of applied) {
    const id = String(receipt.assetId || '');
    if (!id) continue;
    const current = stats.get(id) || { appliedCount: 0 };
    current.appliedCount += 1;
    const at = createdAtById.get(receipt.id) || '';
    if (at && (!current.lastAppliedAt || at > current.lastAppliedAt)) current.lastAppliedAt = at;
    stats.set(id, current);
  }
  for (const receipt of receipts) {
    if (receipt.status !== 'contradicted' || receipt.boundary !== 'real') continue;
    const current = stats.get(receipt.assetId) || { appliedCount: 0 };
    current.contradictedCount = (current.contradictedCount || 0) + 1;
    if (!current.lastContradictedAt || receipt.createdAt > current.lastContradictedAt) {
      current.lastContradictedAt = receipt.createdAt;
    }
    stats.set(receipt.assetId, current);
  }
  return stats;
}

/** 采用统计的按回合缓存（与上面的使用统计缓存同一口径/同一形状）：同一回合内
 *  重复调用复用同一份快照，新回合重算；没有回合上下文时直读，不缓存。 */
let adoptionCache: { key: string; stats: Map<string, AssetAdoptionStat> } | null = null;

export function resetAssetAdoptionStatsCacheForTest(): void {
  adoptionCache = null;
}

export async function loadAssetAdoptionStatsCached(userId: string, turnId?: string): Promise<Map<string, AssetAdoptionStat>> {
  const key = turnId ? `${userId}:${turnId}` : '';
  if (key && adoptionCache && adoptionCache.key === key) return adoptionCache.stats;
  const stats = await loadAssetAdoptionStats(userId);
  if (key) adoptionCache = { key, stats };
  return stats;
}

/** 兼容旧调用方的相关度入口；实际召回由 catalog-relevance 唯一实现。
 * embedding 不可用时仍有词面与专名通道。 */
export async function catalogRelevanceScores(
  userId: string,
  taskText: string,
  assets: Array<{ id: string; statement: string; title: string; type?: RecallAbilityAssetRecord['type']; applicableWhen?: string[]; forbiddenWhen?: string[] }>,
): Promise<Map<string, number>> {
  const { catalogMatches } = await import('./catalog-relevance');
  const matches = await catalogMatches(userId, taskText, assets);
  return new Map([...matches].map(([id, match]) => [id, match.score]));
}
