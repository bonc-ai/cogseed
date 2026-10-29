import { ensureNightlySemanticSupport, relevantAutomaticSummaryUnresolved } from './nightly-automatic-support';
import { cognitionMessageSourceId } from './source-catalog';
import { readRecallCaptureSettings } from './capture-settings';
import { readRecallJsonRecord } from './store';
import { verifyCaptureProvenanceForPromotion } from './capture-provenance';
import { validatePromotionByAssetType } from './formal-assets/promotion';
import { resolveScopeForAsset } from './scope-policy';
import type { RecallCandidateRecord, RecallCandidatePromotionResult } from './candidate-service';
import type { AutomaticCandidateReview } from './automatic-review-history';
import type { CaptureContextSummary } from './capture-context-summary';

/** A fresh explicit grant permits only complete, supported nightly formations.
 * This establishes permission to retain cognition, never evidence of effectiveness. */
export interface NightlyAutomaticApprovalOptions { semanticSupport?: 'check' | 'cached_only'; signal?: AbortSignal }
export async function evaluateNightlyAutomaticApproval(userId: string, candidate: RecallCandidateRecord, options: NightlyAutomaticApprovalOptions = {}): Promise<AutomaticCandidateReview> {
  options.signal?.throwIfAborted();
  const settings = await readRecallCaptureSettings(userId);
  const reasons: string[] = [];
  const capture = candidate.captureProvenance
    ? await readRecallJsonRecord(userId, 'captures', candidate.captureProvenance.captureId) : undefined;
  if (!settings.enabled || !settings.autoApproval) reasons.push('automatic_confirmation_disabled');
  if (!settings.autoApprovalEpoch || !capture || capture.autoApprovalEpoch !== settings.autoApprovalEpoch
    || !settings.autoApprovalEnabledAt || capture.autoApprovalEnabledAt !== settings.autoApprovalEnabledAt
    || Date.parse(candidate.createdAt) < Date.parse(settings.autoApprovalEnabledAt)
    || !candidate.captureProvenance || Date.parse(candidate.captureProvenance.valueJudgment.judgedAt) < Date.parse(settings.autoApprovalEnabledAt)) {
    reasons.push('automatic_confirmation_grant_expired');
  }
  if (candidate.status !== 'pending_review' || candidate.userModifiedAt || candidate.ontologyHandoff) reasons.push('candidate_requires_individual_review');
  if (candidate.risk !== 'low') reasons.push('risk_requires_individual_review');
  if (candidate.uncertainty?.trim()) reasons.push('candidate_has_uncertainty');
  if (Date.parse(candidate.expiresAt) <= Date.now()) reasons.push('candidate_expired');
  if (!candidate.judgment.trim() || !candidate.value?.trim() || !candidate.suggestedScope.trim()
    || candidate.statementIssues?.length || candidate.evidenceRefs.some(ref => ref.degraded)) reasons.push('candidate_incomplete');
  if (!['cognition', 'personal', 'rule', 'fact'].includes(candidate.suggestedType)) reasons.push('structure_requires_individual_review');
  if (!['create', 'update'].includes(candidate.suggestedAction)) reasons.push('action_requires_individual_review');
  const plan = candidate.ontologyFormation as { requiresTReview?: boolean; blockedReasons?: string[] } | undefined;
  if (plan?.requiresTReview || plan?.blockedReasons?.length) reasons.push('ontology_requires_individual_review');
  const summary = capture?.contextSummary as CaptureContextSummary | undefined;
  const messageEvidenceIds = new Set(candidate.evidenceRefs.filter(ref => ref.kind === 'conversation' && ref.subtype === 'message').map(ref => ref.id));
  const relevantTopics = summary?.topics.filter(topic => topic.evidence.some(item =>
    messageEvidenceIds.has(cognitionMessageSourceId(String(capture?.conversationId || ''), item.messageId)))) || [];
  if (!summary || !relevantTopics.length) reasons.push('candidate_summary_topic_unavailable');
  const summaryUnresolved = summary ? relevantAutomaticSummaryUnresolved(candidate, summary, String(capture?.conversationId || '')) : undefined;
  const hasSummaryUncertainty = !!summaryUnresolved?.length;
  if (relevantTopics.length && !summaryUnresolved) reasons.push('conversation_has_unresolved_questions');
  try { await verifyCaptureProvenanceForPromotion(userId, candidate); }
  catch { reasons.push('nightly_formation_or_sources_unavailable'); }
  if (!reasons.length) {
    const { cognitionExistingSourceIds } = await import('./source-catalog');
    const groups = new Map<import('./source-service').CognitionSourceType, string[]>();
    for (const ref of [...candidate.sourceRefs, ...candidate.evidenceRefs]) {
      if (ref.taxonomyVersion !== 2) { reasons.push('legacy_source_requires_individual_review'); continue; }
      const kind = ref.kind as import('./source-service').CognitionSourceType;
      groups.set(kind, [...(groups.get(kind) || []), ref.id]);
    }
    for (const [kind, ids] of groups) {
      const existing = await cognitionExistingSourceIds(userId, kind, ids);
      if (ids.some(id => !existing.has(id))) reasons.push('source_record_unavailable');
    }
  }
  const validation = candidate.proposalTarget === 'ontology' ? { ok: true, advisories: [] }
    : validatePromotionByAssetType(candidate, { actor: 'system' });
  // Length is explicitly a soft display budget, not missing content. Keep
  // completeness/identity/scope advisories manual and verify the whole body.
  if (!validation.ok || validation.advisories.some(reason => reason !== 'statement_over_soft_budget')) reasons.push('formal_asset_requirements_incomplete');
  // Perform policy checks before optional semantic infrastructure; blocked work
  // must not call models merely to discover another reason to hold it.
  let ontologyReasons: string[] = [];
  if (!reasons.length && candidate.ontologyFormation) {
    const { ontologyFormationComparisonReasons } = await import('./ontology-automatic-comparison');
    ontologyReasons = await ontologyFormationComparisonReasons(userId, candidate);
    reasons.push(...ontologyReasons);
  }
  // An ontology revision mismatch must not skip the asset-version check.
  // Both reasons can be present, and neither one writes the newer body.
  if (candidate.proposalTarget !== 'ontology' && reasons.every(reason => ontologyReasons.includes(reason))) {
    const { readAbilityAsset, listAbilityAssets } = await import('./asset-service');
    const { listRecallCandidates, comparableJudgmentText } = await import('./candidate-service');
    if (candidate.suggestedAction === 'update') {
      if (!candidate.targetAssetId || !candidate.targetVersionUsed) reasons.push('update_baseline_missing');
      else {
        try {
          const target = await readAbilityAsset(userId, candidate.targetAssetId);
          if (target.status !== 'active' || target.type !== candidate.suggestedType
            || target.version !== candidate.targetVersionUsed || (target.activeVersion || target.version) !== candidate.targetVersionUsed
            || target.scope !== resolveScopeForAsset(candidate.suggestedScope)
            || JSON.stringify(target.scopePolicy || null) !== JSON.stringify(candidate.scopePolicy || null)) reasons.push('update_baseline_conflict');
        } catch { reasons.push('update_target_unavailable'); }
      }
    } else if (candidate.targetAssetId || candidate.targetVersionUsed) reasons.push('create_baseline_conflict');
    if (!reasons.length) {
    const [assets, candidates] = await Promise.all([listAbilityAssets(userId), listRecallCandidates(userId)]);
    const peers = candidates.filter(other => other.id !== candidate.id
      && other.proposalTarget !== 'ontology'
      && !['rejected', 'ignored', 'expired', 'failed', 'superseded', 'integrated', 'confirmed'].includes(other.status));
    const comparableAssets = assets.filter(asset => asset.status === 'active' && asset.id !== candidate.targetAssetId);
    const text = comparableJudgmentText(candidate.judgment);
    if (peers.some(other => comparableJudgmentText(other.judgment) === text)
      || comparableAssets.some(asset => comparableJudgmentText(asset.statement) === text)) reasons.push('existing_cognition_conflict');
    if (!reasons.length) {
      const { findSemanticDuplicate, embedForDedup } = await import('./similarity');
      // The shared lookup tolerates individual failed comparison embeddings.
      // Automatic confirmation needs every relevant comparison to be available.
      for (const text of [...peers.map(other => other.judgment), ...comparableAssets.map(asset => asset.statement)]) {
        options.signal?.throwIfAborted();
        if (!await embedForDedup(userId, text)) { reasons.push('semantic_conflict_check_unavailable'); break; }
      }
      const outcome = await findSemanticDuplicate(userId, { text: candidate.judgment,
        candidateTexts: peers.map(other => ({ id: other.id, text: other.judgment })),
        assetTexts: comparableAssets.map(asset => ({ id: asset.id, text: asset.statement })) });
      if (outcome.status === 'degraded') reasons.push('semantic_conflict_check_unavailable');
      if (outcome.status === 'match' || (outcome.status === 'no_match' && outcome.related)) reasons.push('existing_cognition_requires_comparison');
    }
    }
  }
  if (!reasons.length) {
    const support = await ensureNightlySemanticSupport(userId, candidate, settings.autoApprovalEpoch!, { cachedOnly: options.semanticSupport === 'cached_only', signal: options.signal });
    if (support !== 'supported') reasons.push(support === 'unsupported' ? 'candidate_semantic_support_failed'
      : support === 'stale' ? 'candidate_semantic_support_changed' : 'candidate_semantic_support_unavailable');
  }
  options.signal?.throwIfAborted();
  if (hasSummaryUncertainty && reasons.length) reasons.push('conversation_has_unresolved_questions');
  return { policyVersion: 1, eligible: reasons.length === 0, reasons, checkedAt: new Date().toISOString(), policyEpoch: settings.autoApprovalEpoch };
}

export class NightlyAutomaticApprovalHeldError extends Error {
  readonly code = 'nightly_automatic_approval_held';
  constructor(readonly reasons: string[]) { super(`automatic confirmation requires individual review: ${reasons.join(',')}`); }
}

export async function requireNightlyAutomaticApproval(userId: string, candidate: RecallCandidateRecord): Promise<AutomaticCandidateReview> {
  const review = await evaluateNightlyAutomaticApproval(userId, candidate, { semanticSupport: 'cached_only' });
  if (!review.eligible) throw new NightlyAutomaticApprovalHeldError(review.reasons);
  return review;
}

/** Read-only review outcome: it never authorizes saving or changes meaning.
 * Compare the complete snapshot under the same pool lock used by promotion,
 * so a stale assessment cannot annotate a user's newer edit or confirmation. */
async function recordAutomaticHold(userId: string, expected: RecallCandidateRecord, review: AutomaticCandidateReview): Promise<RecallCandidateRecord> {
  const { recordRecallCandidateAutomaticHold } = await import('./candidate-service');
  return recordRecallCandidateAutomaticHold(userId, expected, review);
}

/** Orchestrator entry. Failed or conflicting automation remains reviewable. */
export async function tryAutomaticallyApproveRecallCandidate(userId: string, candidateId: string,
  options: { signal?: AbortSignal; recoverOnly?: boolean } = {}): Promise<{
  candidate: RecallCandidateRecord; approved: boolean; reasons: string[]; asset?: RecallCandidatePromotionResult['asset'];
}> {
  const { readRecallCandidate, promoteRecallCandidate, recoverRecallCandidatePromotion, confirmRecallOntologyCandidate } = await import('./candidate-service');
  let candidate = await readRecallCandidate(userId, candidateId);
  const recovered = await recoverRecallCandidatePromotion(userId, candidateId);
  if (recovered) return { candidate: recovered.candidate, asset: recovered.asset, approved: false, reasons: ['existing_commit_recovered'] };
  if (candidate.status === 'confirmed' || candidate.status === 'integrated') return { candidate, approved: false, reasons: ['already_confirmed'] };
  if (options.recoverOnly) return { candidate, approved: false, reasons: ['recovery_only'] };
  const review = await evaluateNightlyAutomaticApproval(userId, candidate, { signal: options.signal });
  if (!review.eligible) return { candidate: await recordAutomaticHold(userId, candidate, review), approved: false, reasons: review.reasons };
  try {
    if (candidate.proposalTarget === 'ontology') {
      const result = await confirmRecallOntologyCandidate(userId, candidateId, { actor: 'system', signal: options.signal });
      return { candidate: result.candidate, approved: true, reasons: [] };
    }
    const result = await promoteRecallCandidate(userId, candidateId, { actor: 'system', provenance: 'capture', signal: options.signal });
    return { candidate: result.candidate, asset: result.asset, approved: true, reasons: [] };
  } catch (error) {
    if ((error as Error).name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR') throw error;
    const reasons = error instanceof NightlyAutomaticApprovalHeldError
      ? error.reasons : [(error as { code?: string }).code || 'automatic_confirmation_failed'];
    return { candidate: await recordAutomaticHold(userId, candidate, {
      ...review, eligible: false, reasons, checkedAt: new Date().toISOString(),
    }), approved: false, reasons };
  }
}
