import * as personalOntologyCandidates from '../personal_ontology_candidates';
import type { CandidateUpdate } from '../personal_ontology_candidates';
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
  const personal = await personalOntologyCandidates.listCandidates(userId);
  return applyFilter((personal.candidate_updates || []).map(mapPersonal), filter);
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
  throw new Error('unsupported cognition candidate source');
}
