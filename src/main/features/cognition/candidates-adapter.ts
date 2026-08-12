import * as personalOntologyCandidates from '../personal_ontology_candidates';
import * as p3394 from '../p3394';
import type { CandidateUpdate } from '../personal_ontology_candidates';
import type { CompatExperienceCandidate, CompatPatchCandidate } from '../p3394';
import { cognitionSourceRefKeys } from '../recall/source-service';
import { actionsForCandidate, titleFromText } from './normalize';
import {
  evaluateCandidate,
  isCandidateBlocked,
  mergeSemanticReview,
  toSecurityView,
  type CandidateContent,
  type CandidateGateDecision,
  type SemanticReviewResult,
} from './gate';
import { reviewCandidateSemantically, type SemanticReviewOptions } from './semantic-review';
import type {
  CognitionCandidateSource,
  CognitionCandidateType,
  CognitionCandidateView,
  CognitionSecurityView,
} from './types';

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

/**
 * Attach the deterministic admission status to each candidate.
 *
 * Runs after filtering so the cost scales with what is actually returned
 * (measured ~3ms per 200 candidates, so this is safe on the list path).
 *
 * Pending candidates only: once a candidate is accepted or rejected its
 * verdict is history, and re-scanning it here would imply a fresh check that
 * did not happen.
 */
function withSecurity(items: CognitionCandidateView[]): CognitionCandidateView[] {
  return items.map((item) => {
    if (item.status !== 'pending') return item;
    try {
      const decision = evaluateCandidate(gateContentFor(item.source, item.raw));
      return { ...item, security: toSecurityView(decision) };
    } catch {
      // A scan failure must not hide the candidate, but it must not be
      // reported as a pass either.
      return {
        ...item,
        security: { status: 'unknown', findingCount: 0, semanticReviewed: false },
      };
    }
  });
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
  // Suppression first, then the admission gate: annotating candidates the user
  // will never see would run the scanner for nothing, and the security axis is
  // only meaningful for what actually gets rendered.
  return withSecurity(visible);
}

/**
 * Content of a candidate that the admission gate should scan.
 *
 * Each source stores its payload under a different shape, so the text has to
 * be projected before scanning. Anything not listed here is not scanned, so
 * new payload-bearing fields must be added deliberately.
 */
function gateContentFor(
  source: CognitionCandidateSource,
  raw: unknown,
): CandidateContent {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

  if (source === 'personal_ontology') {
    return {
      type: 'ontology',
      summary: str(row.summary),
      // The memory text is what actually gets written into recall, so it is
      // the field that matters most here.
      body: str(row.memory_text),
    };
  }
  if (source === 'p3394_experience') {
    return { type: 'experience', summary: str(row.summary), body: str(row.detail) };
  }
  const proposal = (row.proposal && typeof row.proposal === 'object'
    ? row.proposal : {}) as Record<string, unknown>;
  return {
    type: 'skill_evolution',
    title: str(proposal.title),
    summary: str(proposal.summary) || str(proposal.rationale),
    body: str(proposal.content) || str(row.proposed_content),
  };
}

/**
 * Read a candidate's stored row so the gate can scan its real content rather
 * than trusting a caller-supplied payload.
 */
async function loadCandidateRaw(
  userId: string,
  source: CognitionCandidateSource,
  candidateId: string,
): Promise<unknown> {
  if (source === 'personal_ontology') {
    const data = await personalOntologyCandidates.listCandidates(userId);
    return data.candidate_updates.find((r) => r.candidate_id === candidateId);
  }
  if (source === 'p3394_experience') {
    const rows = await p3394.listExperienceCandidates(userId);
    return rows.find((r) => r.id === candidateId);
  }
  const rows = await p3394.listPatchCandidates(userId);
  return rows.find((r) => r.id === candidateId);
}

/**
 * Deterministic admission check for a candidate, run before it is accepted.
 *
 * Returns the gate decision so callers can persist / surface it. Throws when
 * the candidate is blocked: accepting content that carries a red flag or an
 * injection payload is not a user-overridable decision, matching the install
 * path where EXTREME cannot be forced.
 */
export async function checkCognitionCandidate(
  userId: string,
  source: CognitionCandidateSource,
  candidateId: string,
): Promise<CandidateGateDecision> {
  const raw = await loadCandidateRaw(userId, source, candidateId);
  if (raw === undefined) throw new Error('cognition candidate not found');
  return evaluateCandidate(gateContentFor(source, raw));
}

/**
 * Run both layers for a candidate without deciding it, so the UI can show a
 * deep-review result before the user commits.
 *
 * Never throws on model failure: the returned view carries `degradedReason`
 * instead, keeping "unavailable" distinguishable from "clean".
 */
export async function deepReviewCognitionCandidate(
  userId: string,
  source: CognitionCandidateSource,
  candidateId: string,
  opts: { buildRunnerFn?: SemanticReviewOptions['buildRunnerFn'] } = {},
): Promise<CognitionSecurityView> {
  const raw = await loadCandidateRaw(userId, source, candidateId);
  if (raw === undefined) throw new Error('cognition candidate not found');
  const content = gateContentFor(source, raw);
  const review = await reviewCandidateSemantically(userId, content, {
    ...(opts.buildRunnerFn ? { buildRunnerFn: opts.buildRunnerFn } : {}),
  });
  return toSecurityView(mergeSemanticReview(evaluateCandidate(content), review));
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
    /**
     * Pre-computed semantic review, e.g. forwarded from a caller that already
     * ran one. Advisory: it can escalate the verdict but never clear a code
     * finding, so it is safe to accept from an untrusted layer.
     */
    semanticReview?: SemanticReviewResult;
    /**
     * Run the semantic review here instead of receiving one. Preferred: the
     * review is then triggered in main rather than trusted from a caller.
     * Ignored when `semanticReview` is supplied.
     */
    runSemanticReview?: boolean;
    /** Test seam forwarded to the reviewer. */
    buildRunnerFn?: SemanticReviewOptions['buildRunnerFn'];
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

  // 准入门在账本之后、写入之前：账本记录用户的决定，门决定该决定能否落地。
  // Rejection needs no scan: nothing is written.
  if (input.decision === 'accept') {
    const content = gateContentFor(
      input.source,
      await loadCandidateRaw(userId, input.source, input.candidateId).then((raw) => {
        if (raw === undefined) throw new Error('cognition candidate not found');
        return raw;
      }),
    );
    let decision = evaluateCandidate(content);

    let review = input.semanticReview;
    if (!review && input.runSemanticReview) {
      review = await reviewCandidateSemantically(userId, content, {
        ...(input.buildRunnerFn ? { buildRunnerFn: input.buildRunnerFn } : {}),
      });
    }
    if (review) decision = mergeSemanticReview(decision, review);

    if (isCandidateBlocked(decision)) {
      const top = decision.findings.find((f) => f.level === 'EXTREME') || decision.findings[0];
      const err = new Error(
        `cognition candidate blocked by admission gate (${top?.rule || 'unknown'})`,
      ) as Error & { gateDecision?: CandidateGateDecision };
      err.gateDecision = decision;
      throw err;
    }

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
