import { requireNightlyAutomaticApproval } from './nightly-automatic-approval';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readReviewDecision } from '../cognition/review-decision';
import { readRecallJsonRecord } from './store';
import { verifyCaptureProvenanceForPromotion } from './capture-provenance';
import { cognitionSourceRefKey } from './source-service';
import { resolveExecutionEvidenceRefs } from './evidence-resolution';
import { resolveScopeForAsset } from './scope-policy';
import type { RecallAbilityAssetRecord, RecallCandidateRecord } from './candidate-service';
import { verifyHumanInstructionCandidate } from '../cognition/human-instruction-provenance';
import { normalizeStatementText } from './content-contract';

/** Final creation boundary: actor metadata never substitutes for the persisted
 * nightly candidate and the confirmation journal for its current content.
 * Existing commits bypass this function only after their identity is checked. */
export async function verifyNightlyAssetCreation(userId: string, asset: RecallAbilityAssetRecord, actor: string): Promise<void> {
  const raw = await readRecallJsonRecord(userId, 'candidates', asset.candidateId);
  if (!raw) throw new Error('ability asset requires its persisted nightly candidate');
  const candidate = raw as RecallCandidateRecord;
  if (candidate.humanInstructionProvenance) {
    if (actor !== 'user') throw new Error('human creation cannot use an automatic actor');
    await verifyHumanInstructionCandidate(userId, candidate);
  } else await verifyCaptureProvenanceForPromotion(userId, candidate);
  const decision = await readReviewDecision(userId, `recall_candidate:${candidate.id}`, asset.reviewDecisionId);
  const expectedDecisionKey = `${actor === 'system' ? 'automatic-' : ''}confirm-${createHash('sha256').update(JSON.stringify({
    candidateId: candidate.id, judgment: candidate.judgment, value: candidate.value,
    ...(candidate.contentCategory !== undefined ? { contentCategory: candidate.contentCategory } : {}),
    ...(candidate.ontologyFormation ? { ontologyFormation: candidate.ontologyFormation } : {}),
    type: candidate.suggestedType, scope: candidate.suggestedScope, action: candidate.suggestedAction,
    targetAssetId: candidate.targetAssetId,
    evidence: candidate.evidenceRefs.map(cognitionSourceRefKey).sort(),
  })).digest('hex').slice(0, 32)}`;
  const expectedEvidence = (await resolveExecutionEvidenceRefs(userId, candidate.evidenceRefs)) || [];
  const expectedAssetId = `aa-${createHash('sha256').update(`${candidate.id}\n${asset.reviewDecisionId}`).digest('hex').slice(0, 24)}`;
  // The review ledger uses storage.nowIso(): local time to whole seconds.
  // Compare at that serialization precision, so a real same-second review does
  // not appear to precede the capture's ISO timestamp with milliseconds.
  const extractionSecond = Math.floor(Date.parse(candidate.humanInstructionProvenance?.confirmedAt || candidate.captureProvenance!.extractionCompletedAt) / 1000);
  const decisionSecond = decision ? Math.floor(Date.parse(decision.timestamp) / 1000) : NaN;
  if (actor === 'system') await requireNightlyAutomaticApproval(userId, candidate);
  const checks = {
    creation_actor: actor === 'user' || actor === 'system',
    journal_present: Boolean(decision),
    journal_actor: decision?.actor === actor,
    journal_automatic_policy: actor !== 'system' || (decision?.decision === 'automatic low-risk approval' && decision.decision_type === 'accept'),
    journal_type: Boolean(decision && ['accept', 'modify'].includes(decision.decision_type)),
    journal_candidate: decision?.antecedent_ref === candidate.id,
    journal_target: decision?.target_ref === `recall_candidate:${candidate.id}`,
    journal_scope: (decision?.scope || '') === candidate.suggestedScope,
    journal_fingerprint: decision?.idempotency_key === expectedDecisionKey,
    journal_time: Number.isFinite(decisionSecond) && decisionSecond >= extractionSecond,
    journal_not_committed: !decision?.asset_id && decision?.outcome !== 'asset_created',
    reviewed_content: !candidate.userModifiedAt || decision?.modified_content === candidate.judgment,
    candidate_create: candidate.suggestedAction === 'create' && !candidate.targetAssetId,
    asset_identity: asset.id === expectedAssetId && asset.ownerId === userId,
    asset_initial_state: asset.status === 'active' && asset.lifecycleStatus === (actor === 'system' ? 'automatically_extracted_unverified' : 'user_confirmed_unverified'),
    asset_type: asset.type === candidate.suggestedType,
    asset_content_category: asset.contentCategory === candidate.contentCategory,
    asset_statement: asset.statement === normalizeStatementText(candidate.judgment),
    asset_scope: asset.scope === resolveScopeForAsset(candidate.suggestedScope),
    asset_evidence: isDeepStrictEqual(asset.evidenceRefs, expectedEvidence),
    asset_candidate_chain: isDeepStrictEqual(asset.sourceCandidateIds, [candidate.id]),
    ...(candidate.humanInstructionProvenance ? {
      asset_reviewed_boundaries: isDeepStrictEqual(asset.applicableWhen || [], candidate.applicableWhen || [])
        && isDeepStrictEqual(asset.forbiddenWhen || [], candidate.forbiddenWhen || [])
        && isDeepStrictEqual(asset.scopePolicy, candidate.scopePolicy),
    } : {}),
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);
  if (failed.length) {
    // Field names are safe to expose; never include statements or source text.
    throw new Error(`ability asset creation does not match a current authorized confirmation: ${failed.join(',')}`);
  }
}
