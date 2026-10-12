import { createLogger } from '../../logger';
import { logErrorRef, maskId } from '../../util/log-redact';
import { formatCatalogEntry, type AssetUsageStat } from './asset-catalog';
import type { RecallAbilityAssetRecord } from './candidate-service';
import {
  catalogRankedForTurn,
  catalogSnapshot,
  filterCatalogAssetsForAgentRead,
  resetCatalogEngineForTest,
  type CatalogSnapshot,
} from './catalog-engine';
import type { RankedAsset, RankingSceneContext } from './asset-ranking';
import { CATALOG_PRESENTATION } from './catalog-params';

const log = createLogger('recall.catalog-hint');
/** Full universe stays in the tool catalog; this is only the prompt excerpt. */
export const INLINE_CATALOG_MAX_ENTRIES = CATALOG_PRESENTATION.maxPromptEntries;
const PROMPT_TOKEN_BUDGET = CATALOG_PRESENTATION.promptTokenBudget;

export function resetAssetCatalogHintCacheForTest(): void { resetCatalogEngineForTest(); }

/** The optional turn ID prevents a concurrent conversation from replacing evidence. */
export function lastCatalogRankedForTurn(userId: string, cid: string, turnId?: string): ReadonlyMap<string, RankedAsset> {
  return catalogRankedForTurn(userId, cid, turnId);
}

function estimatedTokens(value: string): number {
  const han = (value.match(/\p{Script=Han}/gu) || []).length;
  return Math.ceil(han * 1.6 + (value.length - han) / 3);
}

function assetVersion(asset: RecallAbilityAssetRecord): string { return String(asset.activeVersion || asset.version || '1'); }

export interface CatalogPromptResult {
  text: string;
  relevantIds: Set<string>;
  shown: Array<{ id: string; version: string }>;
}

/** Keep discovery prompt compact while making every eligible asset reachable by tool. */
export function renderCatalogPrompt(
  snapshot: CatalogSnapshot,
  options: { attachedAssetIds?: ReadonlySet<string> } = {},
): CatalogPromptResult {
  if (!snapshot.assets.length) return { text: '', relevantIds: new Set(), shown: [] };
  const attached = options.attachedAssetIds ?? new Set<string>();
  const byId = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
  const ordered = snapshot.ranked.map((row) => byId.get(row.assetId))
    .filter((asset): asset is RecallAbilityAssetRecord => Boolean(asset));
  const stars = ordered.filter((asset) => snapshot.stars.has(asset.id));
  const other = ordered.filter((asset) => !snapshot.stars.has(asset.id));
  const exploration = other.find((asset) => (snapshot.adoption.get(asset.id)?.appliedCount || 0) === 0
    && snapshot.matches.get(asset.id)?.strong);
  const sections: Array<{ heading: string; assets: RecallAbilityAssetRecord[] }> = [
    { heading: '── 与本轮相关', assets: stars },
    { heading: '── 待探索', assets: exploration ? [exploration] : [] },
    { heading: '── 其他可用资产', assets: other.filter((asset) => asset.id !== exploration?.id) },
  ];
  // 预算按无截断披露的原句式估算；渲染完成后 lines[0] 回填真实 listed 数
  // （修4）——「17 条可用」不说明只列 9 条，会被误读成库里只有 9 条。
  const header = `Asset catalog: ${snapshot.assets.length} assets are available for this task. “用N次” means confirmed application. Read full content with search_ability_assets + assetIds before applying an asset.`;
  const footer = '其余资产可用 search_ability_assets 带 query 检索，或不带参数分页浏览。';
  const lines = [header];
  let budget = estimatedTokens(header) + estimatedTokens(footer);
  const shown: Array<{ id: string; version: string }> = [];
  const relevantIds = new Set<string>();
  for (const section of sections) {
    let headingAdded = false;
    for (const asset of section.assets) {
      if (shown.length >= INLINE_CATALOG_MAX_ENTRIES) break;
      // 本轮已注入（committed/模型自选/画像镜像）的资产行尾标注 [attached]
      // （修3）：标注而非删除——目录保持「可用全集」语义，模型不用在目录里
      // 重复翻找已经到手的内容。
      const line = formatCatalogEntry(
        asset,
        { count: snapshot.adoption.get(asset.id)?.appliedCount || 0 } as AssetUsageStat,
        shown.length + 1,
        snapshot.stars.has(asset.id),
      ) + (attached.has(asset.id) ? ' [attached]' : '');
      const cost = estimatedTokens(line) + (headingAdded ? 0 : estimatedTokens(section.heading));
      if (budget + cost > PROMPT_TOKEN_BUDGET) break;
      if (!headingAdded) { lines.push(section.heading); headingAdded = true; budget += estimatedTokens(section.heading); }
      lines.push(line);
      budget += estimatedTokens(line);
      shown.push({ id: asset.id, version: assetVersion(asset) });
      if (snapshot.stars.has(asset.id)) relevantIds.add(asset.id);
    }
  }
  lines.push(footer);
  if (shown.length < snapshot.assets.length) {
    lines[0] = header.replace(' for this task.', ` for this task; top ${shown.length} are listed below.`);
  }
  return { text: lines.join('\n'), relevantIds, shown };
}

async function recentAttachmentLine(
  userId: string,
  cid: string,
  taskText: string,
  scene?: RankingSceneContext,
  agentId?: string,
): Promise<string> {
  if (!cid) return '';
  try {
    const { listContextProjections } = await import('./context-projection');
    const { readAbilityAsset } = await import('./asset-service');
    const projections = await listContextProjections(userId, { status: 'confirmed', limit: 50 });
    const newest = projections.filter((item) => item.authorization === 'model_selected'
      && item.conversationId && item.conversationId !== cid)
      .sort((left, right) => String(right.decidedAt || right.createdAt || '').localeCompare(String(left.decidedAt || left.createdAt || '')))[0];
    if (!newest) return '';
    const candidates = (await Promise.all(newest.assetIds.slice(0, 6).map((id) => readAbilityAsset(userId, id).catch(() => null))))
      .filter((asset): asset is RecallAbilityAssetRecord => Boolean(asset));
    const allowed = await filterCatalogAssetsForAgentRead(userId, candidates, { taskText, scene, agentId });
    if (!allowed.length) return '';
    return `Recently attached in another conversation: ${allowed.map((asset) => asset.title.slice(0, 24)).join('、')}. Reattach with attach_assets_to_task if needed.`;
  } catch {
    return '';
  }
}

export async function assetCatalogForPrompt(
  userId: string, cid = '', now = Date.now(), taskText = '', scene?: RankingSceneContext, agentId?: string, turnId?: string,
): Promise<string> {
  return (await assetCatalogForPromptWithRelevance(userId, cid, now, taskText, scene, agentId, turnId)).text;
}

export async function assetCatalogForPromptWithRelevance(
  userId: string, cid = '', now = Date.now(), taskText = '', scene?: RankingSceneContext, agentId?: string, turnId?: string,
  attachedAssetIds?: ReadonlySet<string>,
): Promise<{ text: string; relevantIds: Set<string>; shown: Array<{ id: string; version: string }> }> {
  void now;
  try {
    const snapshot = await catalogSnapshot(userId, { cid, turnId, taskText, scene, agentId });
    const rendered = renderCatalogPrompt(snapshot, attachedAssetIds ? { attachedAssetIds } : {});
    const reuse = await recentAttachmentLine(userId, cid, taskText, scene, agentId);
    return { ...rendered, text: [rendered.text, reuse].filter(Boolean).join('\n\n') };
  } catch (error) {
    log.warn('asset catalog prompt unavailable', { userId: maskId(userId), error: logErrorRef(error as Error) });
    return { text: '', relevantIds: new Set(), shown: [] };
  }
}
