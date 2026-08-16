import { listFormalAssets } from '../recall/formal-assets';
import { readInstalledSkillForAsset, readRecallSkillDraft } from '../recall/skill-draft-service';
import { refMatchesAsset, relationRef, titleFromText } from './normalize';
import { listCognitionCandidates } from './candidates-adapter';
import { listCognitionReuseReceipts } from './receipts-adapter';
import type { CognitionAssetSummary, CognitionAssetType } from './types';

export interface ListCognitionAssetsFilter {
  type?: CognitionAssetType;
  category?: CognitionAssetType;
  limit?: number;
}

function baseAsset(input: Omit<CognitionAssetSummary, 'relationRefs' | 'candidateCount' | 'reuseCount' | 'workspaceRefs' | 'receiptRefs' | 'candidateRefs'> & Partial<Pick<CognitionAssetSummary, 'relationRefs' | 'candidateCount' | 'reuseCount' | 'workspaceRefs' | 'receiptRefs' | 'candidateRefs'>>): CognitionAssetSummary {
  return {
    ...input,
    type: input.category,
    relationRefs: input.relationRefs || [],
    candidateCount: input.candidateCount || 0,
    reuseCount: input.reuseCount || 0,
    workspaceRefs: input.workspaceRefs || [],
    receiptRefs: input.receiptRefs || [],
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
  const formalAssets = (await listFormalAssets(userId)).map((asset) => asset.record);
  const generatedSkillIds = new Map(await Promise.all(formalAssets
    .filter((asset) => asset.type === 'skill_method')
    .map(async (asset) => {
      try { return [asset.id, await readInstalledSkillForAsset(userId, asset.id)] as const; }
      catch { return [asset.id, undefined] as const; }
    })));
  const skillDrafts = new Map(await Promise.all(formalAssets
    .filter((asset) => asset.type === 'skill_method')
    .map(async (asset) => {
      try { return [asset.id, await readRecallSkillDraft(userId, asset.id)] as const; }
      catch { return [asset.id, undefined] as const; }
    })));
  for (const asset of formalAssets) {
    if (category && asset.type !== category) continue;
    const skillDraft = skillDrafts.get(asset.id);
    const currentSkillDraft = skillDraft?.sourceAssetVersion === asset.version ? skillDraft : undefined;
    items.push(baseAsset({
      id: asset.id,
      type: asset.type,
      category: asset.type,
      title: asset.title,
      summary: asset.statement,
      source: 'recall_ability_asset',
      lifecycleStatus: asset.lifecycleStatus,
      version: asset.version,
      status: asset.status,
      maturity: asset.maturity,
      owner: asset.ownerId,
      scope: asset.scope,
      ...(asset.scopePolicy ? { scopePolicy: asset.scopePolicy } : {}),
      ...(asset.recommendedAction ? { recommendedAction: asset.recommendedAction } : {}),
      ...(asset.recommendationReason ? { recommendationReason: asset.recommendationReason } : {}),
      ...(asset.recommendationAt ? { recommendationAt: asset.recommendationAt } : {}),
      ...(generatedSkillIds.get(asset.id) ? { generatedSkillId: generatedSkillIds.get(asset.id) } : {}),
      ...(currentSkillDraft?.status === 'draft' ? { recallSkillDraftStatus: 'draft' as const } : {}),
      ...(currentSkillDraft?.status === 'draft' ? {
        recallSkillDraft: {
          draftHash: currentSkillDraft.draftHash,
          fileCount: currentSkillDraft.files.length,
          workflowSteps: currentSkillDraft.proposal?.workflowSteps || [],
          validationOk: currentSkillDraft.validation.ok,
          ...(currentSkillDraft.recallContext ? {
            recallContext: {
              assetCount: currentSkillDraft.recallContext.assetIds.length,
              sourceCount: currentSkillDraft.recallContext.sourceRefs.length,
            },
          } : {}),
        },
      } : {}),
      ...(currentSkillDraft?.status === 'failed' ? {
        recallSkillDraftStatus: 'failed' as const,
        recallSkillDraftErrorCode: currentSkillDraft.errorCode,
      } : {}),
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

  await enrichAssetCounts(userId, items);

  const limit = Number(filter.limit || 0);
  return limit > 0 ? items.slice(0, Math.min(limit, 500)) : items;
}

async function enrichAssetCounts(userId: string, items: CognitionAssetSummary[]): Promise<void> {
  if (!items.length) return;
  const [candidatesSettled, receiptsSettled] = await Promise.allSettled([
    listCognitionCandidates(userId),
    listCognitionReuseReceipts(userId, { limit: 200 }),
  ] as const);
  const candidates = candidatesSettled.status === 'fulfilled' ? candidatesSettled.value : [];
  const receipts = receiptsSettled.status === 'fulfilled' ? receiptsSettled.value : [];
  for (const item of items) {
    const linkedCandidateRefs = new Set(item.candidateRefs || []);
    item.candidateCount = candidates.filter((candidate) => {
      if (linkedCandidateRefs.has(`${candidate.source}:${candidate.sourceId}`)) return true;
      if (item.baselineSkillRef && candidate.targetAssetId === item.baselineSkillRef) return true;
      return candidate.sourceRefs.some((ref) => refMatchesAsset(ref, item.category, item.id))
        || candidate.evidenceRefs.some((ref) => refMatchesAsset(ref, item.category, item.id));
    }).length || item.candidateRefs.length;
    const matchingReceipts = receipts.filter((receipt) => {
      const refs = [...receipt.reusedRefs, ...receipt.omittedRefs, receipt.receiptId].filter(Boolean);
      return refs.some((ref) => item.receiptRefs.includes(ref) || refMatchesAsset(ref, item.category, item.id));
    });
    item.reuseCount = matchingReceipts.length;
    item.lastReusedAt = matchingReceipts[0]?.completedAt || matchingReceipts[0]?.createdAt;
  }
}
