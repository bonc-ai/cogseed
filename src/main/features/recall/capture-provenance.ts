import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isCognitionSourceEnabled, listDisabledCognitionMessageIds } from './source-control';
import { captureContextSourceDigest, summaryCoversUserQuote, type CaptureContextSummary } from './capture-context-summary';
import type { RecallCandidateRecord } from './candidate-service';
import { readJsonl, safeId } from '../../storage';
import { conversationMessageReadFile } from '../../util/project-layout';
import { isRecallAssistantMessage, isRecallConversationMessage } from './conversation-message-policy';
import type { GroupMessage } from '../group_chat/visibility';
import type { CognitionSourceRef } from './source-service';
import { cognitionMessageSourceId } from './source-catalog';
import { readRecallJsonRecord } from './store';
import type { FeedbackResultContext } from './feedback-version-context';
import type { NightlyFeedbackObservation } from './nightly-feedback';

/** Evidence of the value decision and extraction; not a grant to publish. */
export interface RecallCaptureProvenance {
  pipeline: 'nightly_conversation';
  captureId: string;
  messageIds: string[];
  valueJudgment: {
    eligible: true;
    reason: string;
    evidence: Array<{ messageId: string; sourceId: string; quote: string }>;
    judgedAt: string;
    summaryDigest?: string;
  };
  extractionCompletedAt: string;
}

export class CaptureFormationSourceUnavailableError extends Error {
  constructor() { super('capture formation source is unavailable'); this.name = 'CaptureFormationSourceUnavailableError'; }
}

function iso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function normalizeCaptureProvenance(value: unknown): RecallCaptureProvenance | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid capture provenance');
  const proof = value as RecallCaptureProvenance;
  const judgment = proof.valueJudgment;
  if (proof.pipeline !== 'nightly_conversation' || !safeId(proof.captureId)
    || !Array.isArray(proof.messageIds) || !proof.messageIds.length
    || proof.messageIds.some(id => !safeId(id)) || new Set(proof.messageIds).size !== proof.messageIds.length
    || !judgment || judgment.eligible !== true || typeof judgment.reason !== 'string'
    || !judgment.reason.trim() || judgment.reason.length > 500 || !iso(judgment.judgedAt)
    || !iso(proof.extractionCompletedAt) || Date.parse(proof.extractionCompletedAt) < Date.parse(judgment.judgedAt)
    || !Array.isArray(judgment.evidence) || !judgment.evidence.length || judgment.evidence.length > 64
    || judgment.evidence.some(item => !item || !safeId(item.messageId) || !safeId(item.sourceId)
      || !proof.messageIds.includes(item.messageId) || typeof item.quote !== 'string'
      || !item.quote.trim() || item.quote.length > 1_000)) {
    throw new Error('invalid capture provenance');
  }
  return proof;
}

/** Same summary binding used by the nightly orchestrator. */
export function captureSummaryDecisionDigest(summary: CaptureContextSummary): string {
  return createHash('sha256').update(JSON.stringify({ version: 1, sourceDigest: summary.sourceDigest,
    topics: summary.topics, coverage: summary.coverage })).digest('hex');
}

function assertCompleteSummary(capture: Record<string, unknown>, proof: RecallCaptureProvenance): void {
  const summary = capture.contextSummary as CaptureContextSummary | undefined;
  const coverage = summary?.coverage;
  const allIds = [...proof.messageIds, ...((capture.contextMessageIds as string[] | undefined) || [])];
  if (!summary || !/^[a-f0-9]{64}$/.test(summary.sourceDigest) || !iso(summary.completedAt)
    || Date.parse(summary.completedAt) > Date.parse(proof.valueJudgment.judgedAt)
    || !coverage || coverage.messageCount !== new Set(allIds).size
    || !Number.isInteger(coverage.sourceChars) || coverage.sourceChars <= 0
    || !Number.isInteger(coverage.segmentCount) || coverage.segmentCount <= 0
    || !Number.isInteger(coverage.maxInputChars) || coverage.maxInputChars <= 0
    || !Array.isArray(coverage.processedSegmentIds)
    || coverage.processedSegmentIds.length !== coverage.segmentCount
    || new Set(coverage.processedSegmentIds).size !== coverage.segmentCount
    || coverage.processedSegmentIds.some(id => typeof id !== 'string' || !id)
    || !Array.isArray(summary.topics) || !summary.topics.length
    || summary.topics.some(topic => !topic || typeof topic.content !== 'string' || !topic.content.trim()
      || !Array.isArray(topic.evidence) || !topic.evidence.length
      || topic.evidence.some(item => !allIds.includes(item.messageId) || typeof item.quote !== 'string' || !item.quote.trim()
        || !Number.isInteger(item.start) || item.start < 0 || item.end !== item.start + item.quote.length))
    || proof.valueJudgment.summaryDigest !== captureSummaryDecisionDigest(summary)
    || proof.valueJudgment.evidence.some(item => !summaryCoversUserQuote(summary, item.messageId, item.quote))) {
    throw new Error('capture formation requires a complete matching context summary');
  }
}

async function verifyFormation(
  userId: string, value: unknown, sourceRefs: readonly CognitionSourceRef[], candidateId?: string,
  purpose: 'new_write' | 'committed_read' = 'new_write',
): Promise<RecallCaptureProvenance> {
  const proof = normalizeCaptureProvenance(value);
  if (!proof) throw new Error('nightly capture formation evidence is required');
  const capture = await readRecallJsonRecord(userId, 'captures', proof.captureId);
  const validState = candidateId
    ? capture && (capture.status === 'review_ready' || (capture.status === 'writing' && capture.writingCandidateId === candidateId)
      || (purpose === 'committed_read' && capture.status === 'completed'))
      && Array.isArray(capture.candidateIds) && capture.candidateIds.includes(candidateId)
    : capture?.status === 'extracting';
  if (!capture || capture.ownerId !== userId || capture.id !== proof.captureId
    || capture.executionPolicy !== 'nightly' || typeof capture.reviewDay !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(capture.reviewDay) || !validState
    || capture.extractionCompletedAt !== proof.extractionCompletedAt
    || !isDeepStrictEqual(capture.messageIds, proof.messageIds)
    || !isDeepStrictEqual(capture.valueJudgment, proof.valueJudgment)
    || !safeId(capture.conversationId)
    || !sourceRefs.some(ref => ref.kind === 'conversation' && ref.subtype === 'session' && ref.id === capture.conversationId && ref.degraded !== true)
    || proof.valueJudgment.evidence.some(item => item.sourceId !== cognitionMessageSourceId(String(capture.conversationId), item.messageId))
    || !proof.valueJudgment.evidence.some(item => sourceRefs.some(ref => ref.kind === 'conversation'
      && ref.subtype === 'message' && ref.id === item.sourceId && ref.degraded !== true))) {
    throw new Error('capture formation evidence does not match the completed extraction');
  }
  assertCompleteSummary(capture, proof);
  // The summary covers every frozen message, not only direct evidence. A
  // message paused after extraction must invalidate the whole formation.
  const frozenMessageIds = [...proof.messageIds, ...((capture.contextMessageIds as string[] | undefined) || [])];
  if ((await listDisabledCognitionMessageIds(userId, String(capture.conversationId), frozenMessageIds)).size)
    throw new CaptureFormationSourceUnavailableError();
  if (purpose === 'new_write') {
    try {
      const { assertFeedbackResultContextsCurrent } = await import('./feedback-version-context');
      await assertFeedbackResultContextsCurrent(userId, String(capture.conversationId),
        (capture.feedbackVersionContexts || capture.feedbackObservations || []) as Array<NightlyFeedbackObservation & { resultContext?: FeedbackResultContext }>);
    } catch { throw new CaptureFormationSourceUnavailableError(); }
  }
  for (const ref of sourceRefs) {
    // Legacy supplementary refs have no v2 source-control identity. This is
    // the same availability contract used by candidate-service.
    if (ref.taxonomyVersion !== 2) continue;
    if (!await isCognitionSourceEnabled(userId, ref)) throw new CaptureFormationSourceUnavailableError();
  }
  return proof;
}

/** Save runs while extraction is in progress; candidateIds is registered afterwards. */
export async function verifyCaptureProvenanceForWrite(
  userId: string, value: unknown, sourceRefs: readonly CognitionSourceRef[],
): Promise<RecallCaptureProvenance> {
  return verifyFormation(userId, value, sourceRefs);
}

/** Revalidate every frozen context message, including source restrictions that
 * were summarized but were not selected as direct candidate evidence. */
async function verifyCurrentCaptureSourceDigest(userId: string, proof: RecallCaptureProvenance): Promise<void> {
  try {
    const capture = await readRecallJsonRecord(userId, 'captures', proof.captureId);
    const summary = capture?.contextSummary as CaptureContextSummary | undefined;
    if (!capture || !summary || !safeId(capture.conversationId)) throw new CaptureFormationSourceUnavailableError();
    const wanted = new Set([...proof.messageIds, ...((capture.contextMessageIds as string[] | undefined) || [])]);
    const current = (await readJsonl<GroupMessage>(conversationMessageReadFile(userId, String(capture.conversationId)), Number.MAX_SAFE_INTEGER))
      .filter(message => wanted.has(message.id) && isRecallConversationMessage(message));
    if (current.length !== wanted.size) throw new CaptureFormationSourceUnavailableError();
    const digest = captureContextSourceDigest(current.map(message => ({ id: message.id,
      role: isRecallAssistantMessage(message) ? 'assistant' : 'user', text: message.text,
      discovery: proof.messageIds.includes(message.id),
      ...((capture.feedbackObservations as Array<{ messageId: string }> | undefined)?.some(item => item.messageId === message.id)
        ? { observations: ((capture.feedbackVersionContexts || capture.feedbackObservations) as Array<{ messageId: string }>).filter(item => item.messageId === message.id) } : {}) })));
    if (digest !== summary.sourceDigest) throw new CaptureFormationSourceUnavailableError();
  } catch { throw new CaptureFormationSourceUnavailableError(); }
}

/** New writes require a persisted candidate from the completed nightly extraction. */
export async function verifyCaptureProvenanceForPromotion(
  userId: string, candidate: Pick<RecallCandidateRecord, 'id' | 'ownerId' | 'status' | 'captureProvenance' | 'sourceRefs' | 'evidenceRefs' | 'formationComparison'>,
): Promise<RecallCaptureProvenance> {
  if (candidate.ownerId !== userId || !safeId(candidate.id) || candidate.status === 'confirmed'
    || ['rejected', 'ignored', 'expired', 'integrated'].includes(candidate.status)) {
    throw new Error('candidate has no new formation write authority');
  }
  // Supplemental references retain their availability checks; only matching
  // nightly user evidence can establish formation authority.
  const proof = await verifyFormation(userId, candidate.captureProvenance, [...candidate.sourceRefs, ...candidate.evidenceRefs], candidate.id);
  await verifyCurrentCaptureSourceDigest(userId, proof);
  if (candidate.formationComparison?.relatedAssets?.length) {
    const capture = await readRecallJsonRecord(userId, 'captures', proof.captureId);
    const scope = (capture?.formationCheckpoint as { sourceScope?: { projectId?: string; workspaceId?: string; conversationKind?: string } } | undefined)?.sourceScope;
    const conversation = typeof capture?.conversationId === 'string'
      ? await (await import('../chats')).getConversation(userId, capture.conversationId) : undefined;
    const currentScope = { projectId: conversation?.project_id || undefined, workspaceId: conversation?.space_id || undefined,
      conversationKind: conversation?.kind || undefined };
    if (!scope || !conversation || JSON.stringify(scope) !== JSON.stringify(currentScope))
      throw Object.assign(new Error('related comparison scope changed'), { code: 'baseline_changed' });
    const pool = await (await import('./capture-existing-assets')).loadCaptureExistingAssetPool(userId, { sourceScope: scope });
    try {
      const { validateFormationComparison } = await import('./formation-comparison');
      const { coverage: _coverage, ...comparison } = candidate.formationComparison;
      validateFormationComparison(comparison, pool.entries.map(item => item.snapshot),
        { total: pool.total, selected: pool.entries.length, truncated: false, unavailable: pool.unavailable }, { allowReferenceOnly: true });
    } catch {
      throw Object.assign(new Error('related comparison baseline changed'), { code: 'baseline_changed' });
    }
  }
  if (!candidate.evidenceRefs.length
    || !proof.valueJudgment.evidence.some(item => candidate.evidenceRefs.some(ref => ref.kind === 'conversation'
      && ref.subtype === 'message' && ref.id === item.sourceId && ref.degraded !== true))) {
    throw new Error('candidate evidence does not match capture sources');
  }
  return proof;
}

/** Read-only validation of the original source behind an already committed
 * candidate. This is historical evidence validation, never a new save grant:
 * confirmed candidates remain forbidden at the promotion entry point. */
export async function verifyCaptureProvenanceForCommittedCandidate(
  userId: string, candidate: Pick<RecallCandidateRecord,
    'id' | 'ownerId' | 'status' | 'captureProvenance' | 'sourceRefs' | 'evidenceRefs' | 'promotedAssetId' | 'reviewDecisionId' | 'proposalTarget' | 'ontologyHandoff'>,
): Promise<RecallCaptureProvenance> {
  const committedAsset = candidate.status === 'confirmed' && safeId(candidate.promotedAssetId);
  const committedOntology = candidate.status === 'integrated' && candidate.proposalTarget === 'ontology'
    && candidate.ontologyHandoff?.status === 'integrated' && safeId(candidate.ontologyHandoff.commandId)
    && candidate.ontologyHandoff.recordIds?.length > 0;
  if (candidate.ownerId !== userId || !safeId(candidate.id) || (!committedAsset && !committedOntology) || typeof candidate.reviewDecisionId !== 'string'
    || !/^rd_[A-Za-z0-9_-]{8,64}$/.test(candidate.reviewDecisionId)) {
    throw new Error('candidate has no committed formation evidence');
  }
  const proof = await verifyFormation(userId, candidate.captureProvenance,
    [...candidate.sourceRefs, ...candidate.evidenceRefs], candidate.id, 'committed_read');
  await verifyCurrentCaptureSourceDigest(userId, proof);
  if (!candidate.evidenceRefs.length || !proof.valueJudgment.evidence.some(item => candidate.evidenceRefs.some(ref =>
    ref.kind === 'conversation' && ref.subtype === 'message' && ref.id === item.sourceId && ref.degraded !== true))) {
    throw new Error('candidate evidence does not match committed capture sources');
  }
  return proof;
}
