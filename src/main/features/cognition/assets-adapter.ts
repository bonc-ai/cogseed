import * as personalOntologyGroups from '../personal_ontology_groups';
import { listAbilityAssets } from '../recall/asset-service';
import * as p3394 from '../p3394';
import { refMatchesAsset, relationRef, titleFromText } from './normalize';
import { listCognitionCandidates } from './candidates-adapter';
import { listCognitionReuseReceipts } from './receipts-adapter';
import type { CompatExperienceCandidate, CompatPatchCandidate } from '../p3394';
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

function mapExperienceCandidate(row: CompatExperienceCandidate): CognitionAssetSummary {
  return baseAsset({
    id: `candidate:${row.id}`,
    type: 'rule',
    category: 'rule',
    title: titleFromText(row.summary, row.id),
    source: 'p3394_experience_candidate',
    status: row.status === 'approved' ? 'active' : row.status === 'rejected' ? 'revoked' : 'candidate',
    maturity: row.status === 'approved' ? 'transfer_validated' : 'bud',
    owner: 'local_user',
    scope: row.conversation_id || 'current_project',
    candidateRefs: [`p3394_experience:${row.id}`],
    relationRefs: [relationRef('execution', row.source_run_id, row.summary)],
  });
}

function mapPatchCandidate(row: CompatPatchCandidate): CognitionAssetSummary {
  const skillId = row.target?.kind === 'custom_skill' && row.target.id ? row.target.id : undefined;
  return baseAsset({
    id: `candidate:${row.id}`,
    type: 'skill_method',
    category: 'skill_method',
    title: titleFromText(row.proposal?.title || row.proposal?.summary, row.id),
    source: 'p3394_patch_candidate',
    version: row.target?.version,
    status: row.status === 'approved' || row.status === 'applied' ? 'active' : row.status === 'rejected' ? 'revoked' : 'candidate',
    maturity: row.status === 'approved' || row.status === 'applied' ? 'transfer_validated' : 'bud',
    owner: 'local_user',
    scope: row.conversation_id || 'current_project',
    baselineSkillRef: skillId ? `skill:${skillId}` : undefined,
    candidateRefs: [`p3394_patch:${row.id}`],
    receiptRefs: [row.receipt_id].filter(Boolean) as string[],
    relationRefs: [
      relationRef('execution', row.source_run_id, row.proposal?.summary),
      ...(skillId ? [relationRef('skill', skillId, row.proposal?.title)] : []),
    ],
  });
}

export async function listCognitionAssets(
  userId: string,
  filter: ListCognitionAssetsFilter = {},
): Promise<CognitionAssetSummary[]> {
  const category = filter.category || filter.type;
  const items: CognitionAssetSummary[] = [];
  const formalAssets = await listAbilityAssets(userId);
  for (const asset of formalAssets) {
    if (category && asset.type !== category) continue;
    items.push(baseAsset({
      id: asset.id,
      type: asset.type,
      category: asset.type,
      title: asset.title,
      source: 'recall_ability_asset',
      version: asset.version,
      status: asset.status,
      maturity: asset.maturity,
      owner: asset.ownerId,
      scope: asset.scope,
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
              : ref.kind === 'p3394_experience' || ref.kind === 'p3394_patch'
                ? 'evaluation'
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

  if (!category || category === 'personal') {
    const groups = await personalOntologyGroups.listGroups(userId);
    for (const group of groups) {
      items.push(baseAsset({
        id: `CA-PERSONAL-${group.group_id}`,
        type: 'personal',
        category: 'personal',
        title: group.title,
        source: 'personal_ontology',
        status: 'active',
        maturity: 'transfer_validated',
        owner: 'local_user',
        scope: group.rel_path || 'personal',
        relationRefs: [relationRef('ontology', group.group_id, group.title)],
      }));
    }
  }

  if (!category || category === 'rule') {
    const experiences = await p3394.listExperienceCandidates(userId);
    items.push(...experiences.map(mapExperienceCandidate));
  }

  if (!category || category === 'skill_method') {
    const patches = await p3394.listPatchCandidates(userId);
    items.push(...patches.map(mapPatchCandidate));
  }

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
