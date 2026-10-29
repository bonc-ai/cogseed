import * as personalOntologyCandidates from '../personal_ontology_candidates';
import type { CandidateUpdate } from '../personal_ontology_candidates';
import { cognitionSourceRefKeys } from '../recall/source-service';
import { personalOntologyCandidateActions, titleFromText } from './normalize';
import type { CognitionCandidateType, CognitionCandidateView } from './types';

// P-r1-1：status/conversationId/skillId 三个归因过滤维度已删——唯一候选源
// （个人本体候选 md）不携带这三个归因（status 恒 'pending'、conversationId/
// skillId 恒缺失），过滤分支对任何输入恒空或恒真，是死路径；按 skill/会话
// 归因候选若将来有产品需求，需先补数据链路再恢复过滤位。
export interface ListCognitionCandidatesFilter {
  type?: CognitionCandidateType;
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
    actions: [...personalOntologyCandidateActions],
    createdAt: row.recorded_time || undefined,
    raw: row,
  };
}

function applyFilter(items: CognitionCandidateView[], filter: ListCognitionCandidatesFilter = {}): CognitionCandidateView[] {
  let out = items;
  if (filter.type) out = out.filter((item) => item.type === filter.type);
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
