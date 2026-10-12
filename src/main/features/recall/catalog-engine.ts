/** One turn-scoped ranking snapshot for prompt, tool catalog and receipt audit. */
import { readJsonl, safeId } from '../../storage';
import { conversationMessageReadFile } from '../../util/project-layout';
import { listAbilityAssets } from './asset-service';
import type { RecallAbilityAssetRecord } from './candidate-service';
import { catalogMatches, type CatalogMatch } from './catalog-relevance';
import { CATALOG_PRESENTATION } from './catalog-params';
import { pruneCatalogVectors } from './catalog-vector-cache';
import { loadAssetAdoptionStatsCached, type AssetAdoptionStat } from './asset-catalog';
import { rankAssets, type RankedAsset, type RankingSceneContext } from './asset-ranking';
import { DEFAULT_RANKING_WEIGHTS, getRankingWeights } from './catalog-ranking-weights';
import { filterRecallAssetsForAgentRead, type RecallAgentReadContext } from './prompt-injection';

const SNAPSHOT_TTL_MS = 30 * 60_000;
const MAX_SNAPSHOTS = 80;
const MAX_TASK_PROFILES = 80;

export interface CatalogContext {
  cid?: string;
  turnId?: string;
  taskText?: string;
  scene?: RankingSceneContext;
  agentId?: string;
}

export interface CatalogSnapshot {
  userId: string;
  cid: string;
  turnId: string;
  at: number;
  /** Full eligible universe, ordered without truncation. */
  assets: readonly RecallAbilityAssetRecord[];
  ranked: readonly RankedAsset[];
  byId: ReadonlyMap<string, RankedAsset>;
  matches: ReadonlyMap<string, CatalogMatch>;
  stars: ReadonlySet<string>;
  adoption: ReadonlyMap<string, AssetAdoptionStat>;
}

const snapshots = new Map<string, CatalogSnapshot>();
const pending = new Map<string, Promise<CatalogSnapshot>>();
const latestTurnByConversation = new Map<string, string>();
const taskProfiles = new Map<string, string>();

function conversationKey(userId: string, cid: string): string { return `${userId}\0${cid}`; }
function snapshotKey(userId: string, cid: string, turnId: string): string { return `${userId}\0${cid}\0${turnId}`; }

async function taskProfile(userId: string, cid: string, text: string): Promise<string> {
  const latest = text.trim().slice(0, 2_000);
  if (!cid) return latest;
  const key = conversationKey(userId, cid);
  let previous = taskProfiles.get(key) || '';
  const continuation = /^(继续|接着|好的?|嗯|可以|照做|往下做|继续做)[。！.!\s]*$/u.test(latest);
  const referential = latest.length <= 32 && /(刚才|上面|之前|这个方案|这个任务)/u.test(latest);
  if (!previous && (continuation || referential) && safeId(userId) && safeId(cid)) {
    try {
      const messages = await readJsonl<{ from?: string; text?: string }>(conversationMessageReadFile(userId, cid), 50);
      previous = [...messages].reverse()
        .filter((row) => row.from === 'user')
        .map((row) => String(row.text || '').trim())
        .find((row) => row.length > 8 && row !== latest && !/^(继续|接着|好的?)[。！.!\s]*$/u.test(row))
        ?.slice(0, 1_300) || '';
    } catch { /* The current message still gives the model a usable catalog. */ }
  }
  if (continuation && previous) return previous;
  const resolved = referential && previous ? `${previous.slice(0, 1_300)}\n${latest}` : latest;
  if (resolved) {
    taskProfiles.delete(key);
    taskProfiles.set(key, resolved);
    if (taskProfiles.size > MAX_TASK_PROFILES) taskProfiles.delete(taskProfiles.keys().next().value!);
  }
  return resolved;
}

export function catalogAgentReadContext(input: CatalogContext): RecallAgentReadContext {
  const taskText = input.taskText?.trim();
  return {
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.scene?.turnProjectId ? { projectId: input.scene.turnProjectId } : {}),
    ...(input.scene?.turnSpaceId ? { workspaceId: input.scene.turnSpaceId } : {}),
    ...(taskText ? { taskText } : {}),
  };
}

/** Runtime admission is repeated for every content-returning entry point. */
export async function filterCatalogAssetsForAgentRead(
  userId: string,
  assets: readonly RecallAbilityAssetRecord[],
  context: CatalogContext,
): Promise<RecallAbilityAssetRecord[]> {
  return filterRecallAssetsForAgentRead(
    userId,
    assets.filter((asset) => asset.status === 'active'),
    catalogAgentReadContext(context),
  );
}

async function buildSnapshot(userId: string, input: CatalogContext): Promise<CatalogSnapshot> {
  const cid = input.cid || '';
  const turnId = input.turnId || '';
  const query = await taskProfile(userId, cid, input.taskText || '');
  const allAssets = await listAbilityAssets(userId);
  await pruneCatalogVectors(userId, new Set(allAssets.filter((asset) => asset.status === 'active').map((asset) => asset.id))).catch(() => {});
  const assets = await filterCatalogAssetsForAgentRead(userId, allAssets, { ...input, taskText: query });
  const matches = query ? await catalogMatches(userId, query, assets) : new Map<string, CatalogMatch>();
  const relevance = new Map([...matches].map(([id, match]) => [id, match.score]));
  const adoption = await loadAssetAdoptionStatsCached(userId, turnId || undefined).catch(() => new Map<string, AssetAdoptionStat>());
  const weights = await getRankingWeights(userId).catch(() => ({ weights: { ...DEFAULT_RANKING_WEIGHTS }, source: 'default' as const }));
  const ranked = rankAssets({
    assets: assets.map((asset) => ({
      id: asset.id,
      maturity: asset.maturity,
      updatedAt: asset.updatedAt,
      ...(asset.spaceId ? { spaceId: asset.spaceId } : {}),
      ...(asset.scopePolicy ? { scopePolicy: asset.scopePolicy } : {}),
    })),
    relevance,
    adoptionStats: adoption,
    ...(input.scene ? { scene: input.scene } : {}),
    weights: weights.weights,
    weightsSource: weights.source,
  });
  // Relevance marks are selected from evidence, not from popularity-weighted rank.
  const stars = new Set([...matches.entries()]
    .filter(([, match]) => match.strong)
    .sort((left, right) => right[1].score - left[1].score || left[0].localeCompare(right[0]))
    .slice(0, CATALOG_PRESENTATION.maxStars).map(([id]) => id));
  return {
    userId, cid, turnId, at: Date.now(), assets, ranked,
    byId: new Map(ranked.map((row) => [row.assetId, row])), matches, stars, adoption,
  };
}

export async function catalogSnapshot(userId: string, input: CatalogContext): Promise<CatalogSnapshot> {
  const cid = input.cid || '';
  const turnId = input.turnId || 'legacy';
  const key = snapshotKey(userId, cid, turnId);
  const previous = snapshots.get(key);
  if (input.turnId && previous && Date.now() - previous.at < SNAPSHOT_TTL_MS) return previous;
  const running = input.turnId ? pending.get(key) : undefined;
  if (running) return running;
  const work = buildSnapshot(userId, { ...input, turnId: input.turnId || '' }).then((snapshot) => {
    snapshots.delete(key);
    snapshots.set(key, snapshot);
    const conversation = conversationKey(userId, cid);
    latestTurnByConversation.delete(conversation);
    latestTurnByConversation.set(conversation, turnId);
    if (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
    if (latestTurnByConversation.size > MAX_SNAPSHOTS) latestTurnByConversation.delete(latestTurnByConversation.keys().next().value!);
    return snapshot;
  });
  if (input.turnId) pending.set(key, work);
  try { return await work; } finally { pending.delete(key); }
}

export function catalogRankedForTurn(userId: string, cid: string, turnId?: string): ReadonlyMap<string, RankedAsset> {
  const id = turnId || latestTurnByConversation.get(conversationKey(userId, cid));
  if (!id) return new Map();
  const snapshot = snapshots.get(snapshotKey(userId, cid, id));
  return snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS ? snapshot.byId : new Map();
}

/** Revalidate a fresh tool pool, then keep the prompt snapshot's order. */
export async function catalogOrderedToolPool(
  userId: string,
  input: CatalogContext,
  pool: readonly RecallAbilityAssetRecord[],
): Promise<RecallAbilityAssetRecord[]> {
  const eligible = await filterCatalogAssetsForAgentRead(userId, pool, input);
  const snapshot = await catalogSnapshot(userId, input);
  const position = new Map(snapshot.ranked.map((row, index) => [row.assetId, index]));
  return [...eligible].sort((left, right) => (position.get(left.id) ?? Number.MAX_SAFE_INTEGER)
    - (position.get(right.id) ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id));
}

export function resetCatalogEngineForTest(): void {
  snapshots.clear(); pending.clear(); latestTurnByConversation.clear(); taskProfiles.clear();
}
