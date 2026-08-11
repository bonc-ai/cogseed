import * as personalOntologyCandidates from '../personal_ontology_candidates';
import * as p3394 from '../p3394';
import type { CandidateUpdate } from '../personal_ontology_candidates';
import type { CompatExperienceCandidate } from '../p3394';
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
  const [personal, experiences] = await Promise.all([
    personalOntologyCandidates.listCandidates(userId),
    p3394.listExperienceCandidates(userId, filter.conversationId),
  ]);
  return applyFilter([
    ...(personal.candidate_updates || []).map(mapPersonal),
    ...experiences.map(mapExperience),
  ], filter);
}

export async function decideCognitionCandidate(
  userId: string,
  input: {
    source: CognitionCandidateSource;
    candidateId: string;
    decision: 'accept' | 'reject';
    reason?: string;
    notes?: string;
    toGlobalMemory?: boolean;
    toGroupIds?: string[];
  },
): Promise<unknown> {
  if (input.source === 'personal_ontology') {
    if (input.decision === 'accept') {
      return personalOntologyCandidates.confirmCandidate(userId, input.candidateId, {
        toGlobalMemory: input.toGlobalMemory,
        toGroupIds: input.toGroupIds,
      });
    }
    return personalOntologyCandidates.rejectCandidate(userId, input.candidateId, input.reason);
  }
  if (input.source === 'p3394_experience') {
    return p3394.decideExperienceCandidate(userId, input.candidateId, input.decision === 'accept' ? 'approve' : 'reject');
  }
  throw new Error('unsupported cognition candidate source');
}
