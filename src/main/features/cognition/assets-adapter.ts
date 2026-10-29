import { listFormalAssets } from '../recall/formal-assets';
import { relationRef } from './normalize';
import type { CognitionAssetSummary, CognitionAssetType } from './types';

export interface ListCognitionAssetsFilter {
  type?: CognitionAssetType;
  category?: CognitionAssetType;
  limit?: number;
}

function baseAsset(input: Omit<CognitionAssetSummary, 'relationRefs' | 'candidateRefs'> & Partial<Pick<CognitionAssetSummary, 'relationRefs' | 'candidateRefs'>>): CognitionAssetSummary {
  return {
    ...input,
    type: input.category,
    relationRefs: input.relationRefs || [],
    candidateRefs: input.candidateRefs || [],
  };
}

export async function listCognitionAssets(
  userId: string,
  filter: ListCognitionAssetsFilter = {},
): Promise<CognitionAssetSummary[]> {
  const category = filter.category || filter.type;
  const items: CognitionAssetSummary[] = [];
  // 唯一读口：canonical 层已经保证出来的每一条都是四类正式资产，
  // 这里只做形状转换，不再自己判断"哪些算资产"。
  // P-r3-1（2026-10-01 死代码真删批）：这里曾为每个 skill_method 资产做
  // readInstalledSkillForAsset + readRecallSkillDraft 共 3-7 次读盘（含懒迁移
  // 写副作用），并为全列表做候选池/回执两次关联读（enrichAssetCounts）——
  // 全部只为填零渲染消费字段（generatedSkillId/recallSkillDraft*/计数三件套/
  // lifecycleStatus 透传），已随字段一并删除。
  const formalAssets = (await listFormalAssets(userId)).map((asset) => asset.record);
  for (const asset of formalAssets) {
    if (category && asset.type !== category) continue;
    items.push(baseAsset({
      id: asset.id,
      type: asset.type,
      category: asset.type,
      title: asset.title,
      summary: asset.statement,
      source: 'recall_ability_asset',
      version: asset.version,
      status: asset.status,
      maturity: asset.maturity,
      owner: asset.ownerId,
      scope: asset.scope,
      ...(asset.scopePolicy ? { scopePolicy: asset.scopePolicy } : {}),
      ...(asset.recommendedAction ? { recommendedAction: asset.recommendedAction } : {}),
      ...(asset.recommendationReason ? { recommendationReason: asset.recommendationReason } : {}),
      ...(asset.recommendationAt ? { recommendationAt: asset.recommendationAt } : {}),
      candidateRefs: [asset.candidateId],
      relationRefs: asset.evidenceRefs.map((ref) => relationRef(
        ref.kind === 'artifact_file'
          || ref.kind === 'authorized_external_system'
          || ref.kind === 'context'
          || ref.kind === 'artifact'
          ? 'knowledge'
          : ref.kind === 'execution_evaluation'
            ? ref.subtype === 'evaluation' ? 'evaluation' : 'execution'
            : ref.kind === 'execution'
              ? 'execution'
                : ref.kind === 'conversation' || ref.kind === 'message'
              ? 'conversation'
                  : ref.kind === 'ontology'
                    ? 'ontology'
                    : 'memory',
        ref.id,
        ref.title,
      )),
    }));
  }

  // 个人本体「分组」不是正式能力资产。按 PRD 3.3 它属于非资产支撑对象，
  // 不占用四类一级分类，也不参与成熟度与认知树成长；曾经在这里合成
  // `CA-PERSONAL-*` 条目并硬编码 maturity: 'transfer_validated'，既污染了
  // 资产边界，又在没有 TransferProof / Receipt 的情况下伪造了成熟度
  // （PRD 3.6 Transfer Verified 要求真实加载 + 生成 Receipt）。
  // 分组的入口在「我的资产」的 personal 分类里（personal-ontology.js 展开），
  // 不需要在资产列表里重复出现一条。

  const limit = Number(filter.limit || 0);
  return limit > 0 ? items.slice(0, Math.min(limit, 500)) : items;
}
