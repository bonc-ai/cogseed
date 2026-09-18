/**
 * family.ts — 判族引擎（2026-09-19 合并实施·清单 #2）。
 *
 * 目标（子安口径）：相关内容归成一条完整信息，不零散。族＝大类：面板按族
 * 聚合资产成「关于我 / 关于周报 / …」的分组视图。
 *
 * 族键优先级（静态部分，本模块）：
 *   ① 本体分组引用（ontologyRefs）——资产已被显式挂到某个大类；
 *   ② KStar 同轮次溯源（learningProvenance.episodeId）——同一轮任务沉淀的
 *      经验天然同族；
 *   ③ 语义聚类（FAMILY_SEMANTIC_THRESHOLD ≥ 0.60，跨资产 embedding 相似）
 *      ——没挂组、没溯源的存量资产，在入库扫描时补判（下一轮接线）。
 *
 * 族的载体是 relations 的 same_family（asset-relations.ts）：不新建顶级字段，
 * 挂在既有关系容器里，版本快照与归一化校验全部免费复用。
 */

import type { AbilityAssetRelation } from './asset-relations';
import type { RecallAbilityAssetRecord } from './candidate-service';

export const FAMILY_SEMANTIC_THRESHOLD = 0.60;

/** 静态族键：本体组优先，其次 KStar 轮次。返回 null 表示静态判不出。 */
export function computeStaticFamilyKey(
  asset: Pick<RecallAbilityAssetRecord, 'ontologyRefs' | 'learningProvenance'>,
): string | null {
  const groupIds = (asset.ontologyRefs || [])
    .map((ref) => String(ref.groupId || '').trim())
    .filter(Boolean)
    .sort();
  if (groupIds.length > 0) return `group:${groupIds[0]}`;
  const episodeId = String((asset.learningProvenance as { episodeId?: string } | undefined)?.episodeId || '').trim();
  if (episodeId) return `episode:${episodeId}`;
  return null;
}

/** 按静态族键分组；只保留 ≥2 条的组（单条不成族）。 */
export function collectStaticFamilyGroups(
  assets: ReadonlyArray<Pick<RecallAbilityAssetRecord, 'id' | 'ontologyRefs' | 'learningProvenance'>>,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const asset of assets) {
    const key = computeStaticFamilyKey(asset);
    if (!key) continue;
    const members = groups.get(key);
    if (members) {
      if (!members.includes(asset.id)) members.push(asset.id);
    } else {
      groups.set(key, [asset.id]);
    }
  }
  for (const [key, members] of groups) {
    if (members.length < 2) groups.delete(key);
  }
  return groups;
}

export interface SameFamilyRelationPatch {
  assetId: string;
  /** 需要新增的 same_family 关系（已存在的跳过）。 */
  addRelations: Array<{ kind: 'same_family'; assetId: string; note?: string }>;
}

/** 语义聚类族组：静态判不出（无本体组、无 KStar 溯源）的资产两两比 embedding，
 *  相似 ≥ FAMILY_SEMANTIC_THRESHOLD 并查集成组，组键取组内最小资产 id（稳定）。
 *  规模保护：参与聚类的资产超过 MAX_SEMANTIC_CLUSTER 时只聚最近更新的
 *  MAX_SEMANTIC_CLUSTER 条并记 warn——embedding 两两比对是 O(n²)，用户级
 *  资产库不该无限膨胀这个成本。embedding 不可用时返回空（聚类是兜底路径，
 *  失败静默，不阻断入库）。 */
export const MAX_SEMANTIC_CLUSTER = 200;

type ClusterInput = Pick<RecallAbilityAssetRecord, 'id' | 'statement' | 'title' | 'updatedAt' | 'ontologyRefs' | 'learningProvenance'>;

export async function collectSemanticFamilyGroups(
  userId: string,
  assets: ReadonlyArray<ClusterInput>,
  deps: {
    embedForDedup?: (userId: string, text: string) => Promise<number[] | null>;
    log?: { warn: (message: string, context?: Record<string, unknown>) => void };
  } = {},
): Promise<Map<string, string[]>> {
  const { embedForDedup } = await import('./similarity');
  const embed = deps.embedForDedup || embedForDedup;
  const orphans = assets
    .filter((asset) => computeStaticFamilyKey(asset) === null)
    .slice()
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .slice(0, MAX_SEMANTIC_CLUSTER);
  const groups = new Map<string, string[]>();
  if (orphans.length < 2) return groups;

  const vectors = new Map<string, number[]>();
  for (const asset of orphans) {
    const vector = await embed(userId, String(asset.statement || asset.title || ''));
    if (vector) vectors.set(asset.id, vector);
  }
  if (vectors.size < 2) return groups;

  const { cosineScore } = await import('./similarity');
  const parent = new Map(orphans.map((asset) => [asset.id, asset.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (left: string, right: string): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(a > b ? a : b, a > b ? b : a);
  };
  const listed = orphans.filter((asset) => vectors.has(asset.id));
  for (let i = 0; i < listed.length; i += 1) {
    for (let j = i + 1; j < listed.length; j += 1) {
      if (cosineScore(vectors.get(listed[i].id)!, vectors.get(listed[j].id)!) >= FAMILY_SEMANTIC_THRESHOLD) {
        union(listed[i].id, listed[j].id);
      }
    }
  }
  const clusters = new Map<string, string[]>();
  for (const asset of listed) {
    const root = find(asset.id);
    const members = clusters.get(root) || [];
    members.push(asset.id);
    clusters.set(root, members);
  }
  for (const [root, members] of clusters) {
    if (members.length >= 2) groups.set(`sem:${[...members].sort()[0]}`, members);
  }
  return groups;
}

/** 新资产入库后自动挂族：静态键同组，或与既有资产语义 ≥ 阈值 → 给新资产写
 *  same_family 关系指向同族成员。返回挂上的成员 id（空=无族可挂）。
 *  挂族是增强不是闸门：任何失败静默降级为"没挂上"，不阻断入库。 */
export async function attachFamilyOnCreate(
  userId: string,
  created: Pick<RecallAbilityAssetRecord, 'id' | 'statement' | 'title' | 'ontologyRefs' | 'learningProvenance' | 'relations' | 'candidateId'>,
  peers: ReadonlyArray<Pick<RecallAbilityAssetRecord, 'id' | 'statement' | 'title' | 'ontologyRefs' | 'learningProvenance'>>,
  reviewHandoff?: { reviewDecisionId: string; sourceCandidateId: string },
  deps: {
    embedForDedup?: (userId: string, text: string) => Promise<number[] | null>;
    writeRelations?: (userId: string, assetId: string, relations: AbilityAssetRelation[]) => Promise<unknown>;
  } = {},
): Promise<string[]> {
  try {
    const candidates: string[] = [];
    const createdKey = computeStaticFamilyKey(created);
    const semanticPeers: string[] = [];
    if (createdKey) {
      for (const peer of peers) {
        if (computeStaticFamilyKey(peer) === createdKey) candidates.push(peer.id);
      }
    }
    if (candidates.length === 0) {
      const { embedForDedup, cosineScore } = await import('./similarity');
      const embed = deps.embedForDedup || embedForDedup;
      const createdVector = await embed(userId, String(created.statement || created.title || ''));
      if (createdVector) {
        for (const peer of peers) {
          const peerVector = await embed(userId, String(peer.statement || peer.title || ''));
          if (peerVector && cosineScore(createdVector, peerVector) >= FAMILY_SEMANTIC_THRESHOLD) {
            semanticPeers.push(peer.id);
          }
        }
      }
      candidates.push(...semanticPeers);
    }
    if (candidates.length === 0) return [];

    const existing = created.relations || [];
    const existingPeerIds = new Set(existing
      .filter((relation) => relation.kind === 'same_family')
      .map((relation) => relation.assetId));
    const addRelations = [...new Set(candidates)]
      .filter((peerId) => !existingPeerIds.has(peerId))
      .map((peerId) => ({ kind: 'same_family' as const, assetId: peerId, note: 'auto-attach on ingest' }));
    if (addRelations.length === 0) return [...existingPeerIds];

    if (deps.writeRelations) {
      await deps.writeRelations(userId, created.id, [...existing, ...addRelations]);
    } else {
      // 直写 relations 不走 updateAbilityAsset：挂族是元数据变更不是内容变更
      // ——经 updateAbilityAsset 会 bump version，撞破投影的版本冻结（transfer
      // receipt 校验"receipt 必须证明投影钉住的全部版本"，挂族推号让 v1 投影
      // 对不上 v2 资产）。写入前过 normalize 保形状。
      const { updateRecallJsonRecord } = await import('./store');
      const { normalizeAbilityAssetRelations } = await import('./asset-relations');
      await updateRecallJsonRecord(userId, 'ability-assets', created.id, (current: Record<string, unknown> | null) => ({
        ...(current || {}),
        relations: normalizeAbilityAssetRelations([...existing, ...addRelations], created.id),
        updatedAt: new Date().toISOString(),
      }));
    }
    return addRelations.map((relation) => relation.assetId);
  } catch {
    return [];
  }
}

/** 由族组生成每条资产的 same_family 关系补丁（幂等：已有的不重复生成）。 */
export function buildSameFamilyPatches(
  groups: ReadonlyMap<string, string[]>,
  existingByAssetId: ReadonlyMap<string, ReadonlyArray<Pick<AbilityAssetRelation, 'kind' | 'assetId'>>>,
): SameFamilyRelationPatch[] {
  const patches = new Map<string, Array<{ kind: 'same_family'; assetId: string; note?: string }>>();
  for (const [, members] of groups) {
    const uniqueMembers = [...new Set(members)];
    for (const assetId of uniqueMembers) {
      const existing = existingByAssetId.get(assetId) || [];
      const alreadyRelated = new Set(existing
        .filter((relation) => relation.kind === 'same_family')
        .map((relation) => relation.assetId));
      for (const peer of uniqueMembers) {
        if (peer === assetId || alreadyRelated.has(peer)) continue;
        const entry = patches.get(assetId) || [];
        // 组成员列表可能带重复（调用方直造的脏组）：同一对关系只生成一次。
        if (entry.some((relation) => relation.assetId === peer)) continue;
        entry.push({ kind: 'same_family', assetId: peer });
        patches.set(assetId, entry);
      }
    }
  }
  return [...patches.entries()].map(([assetId, addRelations]) => ({ assetId, addRelations }));
}
