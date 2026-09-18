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
