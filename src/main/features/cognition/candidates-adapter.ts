import * as personalOntologyCandidates from '../personal_ontology_candidates';
import * as p3394 from '../p3394';
import type { CandidateUpdate } from '../personal_ontology_candidates';
import type { CompatExperienceCandidate, CompatPatchCandidate } from '../p3394';
import { cognitionSourceRefKeys } from '../recall/source-service';
import { actionsForCandidate, titleFromText } from './normalize';
import type { CognitionCandidateSource, CognitionCandidateType, CognitionCandidateView } from './types';

export interface ListCognitionCandidatesFilter {
  status?: 'pending' | 'accepted' | 'rejected';
  type?: CognitionCandidateType;
  conversationId?: string;
  skillId?: string;
  limit?: number;
}

function typeForPersonal(row: CandidateUpdate): CognitionCandidateType {
  if (row.kind === 'preference') return 'preference';
  if (row.kind === 'rule') return 'rule';
  return 'ontology';
}

function mapPersonal(row: CandidateUpdate): CognitionCandidateView {
  const summary = row.summary || row.memory_text || row.candidate_id;
  const sourceRefs = cognitionSourceRefKeys(row.source_memory_refs || [], 'memory');
  return {
    id: `personal_ontology:${row.candidate_id}`,
    source: 'personal_ontology',
    sourceId: row.candidate_id,
    type: typeForPersonal(row),
    status: 'pending',
    title: titleFromText(summary, row.candidate_id),
    summary,
    confidence: row.confidence,
    scope: row.memory_scope,
    sourceRefs,
    evidenceRefs: sourceRefs,
    targetAssetId: undefined,
    diffAvailable: false,
    actions: actionsForCandidate('personal_ontology', 'pending'),
    raw: row,
  };
}

function mapExperience(row: CompatExperienceCandidate): CognitionCandidateView {
  const status = row.status === 'approved' ? 'accepted' : row.status === 'rejected' ? 'rejected' : 'pending';
  const refs = cognitionSourceRefKeys([
    row.source_run_id ? { kind: 'execution', id: row.source_run_id } : undefined,
    row.conversation_id ? { kind: 'conversation', id: row.conversation_id } : undefined,
  ].filter(Boolean), 'execution');
  return {
    id: `p3394_experience:${row.id}`,
    source: 'p3394_experience',
    sourceId: row.id,
    type: 'experience',
    status,
    title: titleFromText(row.summary, row.id),
    summary: row.summary || '',
    conversationId: row.conversation_id,
    sourceRefs: refs,
    evidenceRefs: refs,
    diffAvailable: false,
    actions: actionsForCandidate('p3394_experience', status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    raw: row,
  };
}

function mapPatch(row: CompatPatchCandidate): CognitionCandidateView {
  const target = row.target || { kind: 'custom_skill' as const };
  const skillId = target.kind === 'custom_skill' && target.id ? target.id : undefined;
  const status = row.status === 'approved' || row.status === 'applied' ? 'accepted' : row.status === 'rejected' ? 'rejected' : 'pending';
  const sourceRefs = cognitionSourceRefKeys([
    row.source_run_id ? { kind: 'execution', id: row.source_run_id } : undefined,
    row.source_experience_id ? { kind: 'p3394_experience', id: row.source_experience_id } : undefined,
  ].filter(Boolean), 'execution');
  return {
    id: `p3394_patch:${row.id}`,
    source: 'p3394_patch',
    sourceId: row.id,
    type: 'skill_evolution',
    status,
    title: titleFromText(row.proposal?.title || row.proposal?.summary || '', row.id),
    summary: row.proposal?.summary || row.proposal?.rationale || '',
    conversationId: row.conversation_id,
    skillId,
    targetAssetId: skillId ? `skill:${skillId}` : undefined,
    targetAssetTitle: skillId,
    sourceRefs,
    evidenceRefs: cognitionSourceRefKeys([
      ...sourceRefs,
      row.conversation_id ? { kind: 'conversation', id: row.conversation_id } : undefined,
    ].filter(Boolean), 'artifact'),
    diffAvailable: Boolean(row.proposal?.proposed_content),
    actions: actionsForCandidate('p3394_patch', status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    raw: row,
  };
}

function applyFilter(items: CognitionCandidateView[], filter: ListCognitionCandidatesFilter = {}): CognitionCandidateView[] {
  let out = items;
  if (filter.status) out = out.filter((item) => item.status === filter.status);
  if (filter.type) out = out.filter((item) => item.type === filter.type);
  if (filter.conversationId) out = out.filter((item) => item.conversationId === filter.conversationId);
  if (filter.skillId) out = out.filter((item) => item.skillId === filter.skillId || item.targetAssetId === `skill:${filter.skillId}`);
  out = out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const limit = Number(filter.limit || 0);
  return limit > 0 ? out.slice(0, Math.min(limit, 200)) : out;
}

export async function listCognitionCandidates(
  userId: string,
  filter: ListCognitionCandidatesFilter = {},
): Promise<CognitionCandidateView[]> {
  const [personal, experiences, patches] = await Promise.all([
    personalOntologyCandidates.listCandidates(userId),
    p3394.listExperienceCandidates(userId, filter.conversationId),
    p3394.listPatchCandidates(userId, filter.conversationId),
  ]);
  const candidates = applyFilter([
    ...(personal.candidate_updates || []).map(mapPersonal),
    ...experiences.map(mapExperience),
    ...patches.map(mapPatch),
  ], filter);

  // 拒绝/暂缓抑制（FR-EXT-07）：pending 候选若最近被 defer/reject 且无 accept
  // 覆盖，不重复提示——账本过滤，不侵入底层存储。
  const reviewDecisions = await import('./review-decision');
  const visible: CognitionCandidateView[] = [];
  for (const c of candidates) {
    if (c.status === 'pending' && await reviewDecisions.isCandidateSuppressed(userId, `${c.source}:${c.sourceId}`)) {
      continue;
    }
    visible.push(c);
  }
  return visible;
}

export async function decideCognitionCandidate(
  userId: string,
  input: {
    source: CognitionCandidateSource;
    candidateId: string;
    decision: 'accept' | 'modify' | 'defer' | 'reject';
    reason?: string;
    notes?: string;
    toGlobalMemory?: boolean;
    toGroupIds?: string[];
    /** 前指建议（短确认语"采用/确认/是"场景必填；PRD FR-REV-03）。 */
    antecedentRef?: string;
    scope?: string;
    sourceSignalRef?: string;
  },
): Promise<unknown> {
  const targetRef = `${input.source}:${input.candidateId}`;
  // 先记录审查决定（账本）。短确认语缺 antecedent_ref 会在此抛错（资产零变化）。
  const reviewDecisions = await import('./review-decision');
  await reviewDecisions.writeReviewDecision(userId, {
    targetRef,
    decisionType: input.decision,
    decision: input.decision,
    ...(input.antecedentRef ? { antecedentRef: input.antecedentRef } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.sourceSignalRef ? { sourceSignalRef: input.sourceSignalRef } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.notes && input.decision === 'modify' ? { modifiedContent: input.notes } : {}),
  });

  if (input.decision === 'defer') {
    // 暂缓：不改变底层候选状态（pending 保留），由列表层按账本过滤抑制。
    // "稍后处理"入口读账本重新呈现。
    return { ok: true, deferred: true, targetRef };
  }

  if (input.source === 'personal_ontology') {
    if (input.decision === 'accept') {
      return personalOntologyCandidates.confirmCandidate(userId, input.candidateId, {
        toGlobalMemory: input.toGlobalMemory,
        toGroupIds: input.toGroupIds,
      });
    }
    // modify = 拒绝原内容（不直接确认原候选），修改后的新候选由下次提取生成
    return personalOntologyCandidates.rejectCandidate(userId, input.candidateId, input.reason);
  }
  if (input.source === 'p3394_experience') {
    return p3394.decideExperienceCandidate(userId, input.candidateId, input.decision === 'accept' ? 'approve' : 'reject');
  }
  if (input.source === 'p3394_patch') {
    return p3394.reviewPatchCandidate(userId, input.candidateId, input.decision === 'accept' ? 'approve' : 'reject', input.notes || input.reason || '');
  }
  throw new Error('unsupported cognition candidate source');
}
