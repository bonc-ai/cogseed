/** A complete, host-confirmed creation is a distinct origin from nightly
 * extraction. Model JSON, actor labels and historical manual flags cannot mint
 * it. The original source and exact reviewed contract remain verifiable. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { t } from '../../i18n';
import { readJsonl } from '../../storage';
import { conversationMessageReadFile } from '../../util/project-layout';
import { readReviewDecision } from './review-decision';
import { isCognitionSourceEnabled } from '../recall/source-control';
import { cognitionMessageSourceId } from '../recall/source-catalog';
import { normalizeCognitionSourceRefsForWrite, type CognitionSourceRef } from '../recall/source-service';
import { normalizeAbilityAssetScopePolicy, resolveScopeForAsset } from '../recall/scope-policy';
import { readAbilityAssetSemantics } from '../recall/asset-semantics';
import { verifyCaptureProvenanceForPromotion, verifyCaptureProvenanceForCommittedCandidate } from '../recall/capture-provenance';
import type { RecallCandidateRecord, SaveRecallCandidateInput } from '../recall/candidate-service';
import type { GroupMessage } from '../group_chat/visibility';

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
export const humanInstructionProvenanceSchema = z.object({ schemaVersion: z.literal(1), pipeline: z.literal('human_instruction'),
  ownerId: id, requestId: id, candidateId: id, cid: id, sourceMessageId: id,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), contractHash: z.string().regex(/^[a-f0-9]{64}$/),
  interactionId: id, decisionId: z.string().regex(/^rd_[A-Za-z0-9_-]{8,64}$/), confirmedAt: z.string().datetime({ offset: true }),
}).strict();
export type HumanInstructionProvenance = z.infer<typeof humanInstructionProvenanceSchema>;
const permits = new AsyncLocalStorage<{ uid: string; proof: HumanInstructionProvenance; active: boolean }>();
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : value;
export const humanInstructionDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function normalizeHumanInstructionProvenance(value: unknown): HumanInstructionProvenance | undefined {
  return value === undefined ? undefined : humanInstructionProvenanceSchema.parse(value);
}
/** Normalize only the same material fields normalized by candidate persistence.
 * Operational status, IDs and proof bookkeeping never change the contract. */
export function humanInstructionContractHash(input: SaveRecallCandidateInput | RecallCandidateRecord): string {
  const semantics = readAbilityAssetSemantics(input as unknown as Record<string, unknown>);
  return humanInstructionDigest({ target: input.proposalTarget || 'cognition', judgment: input.judgment.trim(),
    value: String(input.value || '').trim(), summary: String(input.summary || '').trim(), contentCategory: input.contentCategory,
    suggestedType: input.suggestedType, suggestedAction: input.suggestedAction || 'create', risk: input.risk || 'low',
    targetAssetId: input.targetAssetId, targetVersionUsed: input.targetVersionUsed,
    scope: resolveScopeForAsset(input.suggestedScope), scopePolicy: normalizeAbilityAssetScopePolicy(input.scopePolicy),
    ...semantics, sourceRefs: normalizeCognitionSourceRefsForWrite(input.sourceRefs),
    evidenceRefs: normalizeCognitionSourceRefsForWrite(input.evidenceRefs || input.sourceRefs),
    ontologyFormation: input.ontologyFormation, spaceId: input.spaceId, captureKey: input.captureKey,
    formationProposalId: input.formationProposalId });
}
export async function readHumanInstructionSource(userId: string, cid: string, messageId: string): Promise<GroupMessage> {
  id.parse(userId); id.parse(cid); id.parse(messageId);
  const refs = normalizeCognitionSourceRefsForWrite([{ kind: 'conversation', subtype: 'session', id: cid },
    { kind: 'conversation', subtype: 'message', id: cognitionMessageSourceId(cid, messageId) }]);
  for (const ref of refs) if (!await isCognitionSourceEnabled(userId, ref)) throw new Error(t('cognition.create.source_unavailable'));
  const rows = (await readJsonl<GroupMessage>(conversationMessageReadFile(userId, cid), 0)).filter(row => row.id === messageId);
  if (rows.length !== 1 || rows[0].from !== 'user' || rows[0].deleted_at || typeof rows[0].text !== 'string' || !rows[0].text.trim())
    throw new Error(t('cognition.create.source_unavailable'));
  return rows[0];
}
export async function verifyHumanInstructionCandidate(userId: string, input: SaveRecallCandidateInput | RecallCandidateRecord,
  options: { newWrite?: boolean; committed?: boolean } = {}): Promise<HumanInstructionProvenance> {
  const proof = normalizeHumanInstructionProvenance(input.humanInstructionProvenance);
  if (!proof || proof.ownerId !== userId || input.captureProvenance || input.manual || input.learningSignal || input.learningProvenance
    || input.suggestedAction !== 'create' || input.targetAssetId || input.targetVersionUsed
    || proof.contractHash !== humanInstructionContractHash(input)) throw new Error(t('cognition.create.invalid_decision'));
  if ('ownerId' in input && (input.ownerId !== userId || input.id !== proof.candidateId)) throw new Error(t('cognition.create.invalid_decision'));
  if (options.newWrite) {
    const permit = permits.getStore();
    if (!permit?.active || permit.uid !== userId || !isDeepStrictEqual(permit.proof, proof)) throw new Error(t('cognition.create.invalid_decision'));
  }
  if ('status' in input && (options.committed ? !['confirmed', 'integrated'].includes(input.status)
    : ['confirmed', 'integrated', 'ignored', 'rejected', 'expired'].includes(input.status))) throw new Error(t('cognition.create.invalid_decision'));
  const source = await readHumanInstructionSource(userId, proof.cid, proof.sourceMessageId);
  if (humanInstructionDigest(source.text) !== proof.sourceHash) throw new Error(t('cognition.create.source_unavailable'));
  const refs = normalizeCognitionSourceRefsForWrite([...input.sourceRefs, ...(input.evidenceRefs || input.sourceRefs)]);
  if (!refs.some(ref => ref.kind === 'conversation' && ref.subtype === 'session' && ref.id === proof.cid)
    || !refs.some(ref => ref.kind === 'conversation' && ref.subtype === 'message' && ref.id === cognitionMessageSourceId(proof.cid, proof.sourceMessageId)))
    throw new Error(t('cognition.create.invalid_decision'));
  for (const ref of refs) if (!await isCognitionSourceEnabled(userId, ref)) throw new Error(t('cognition.create.source_unavailable'));
  const decision = await readReviewDecision(userId, `cognition_creation:${proof.requestId}`, proof.decisionId);
  let saved: { provenance?: unknown; input?: SaveRecallCandidateInput } | undefined;
  try { saved = JSON.parse(decision?.modified_content || 'null'); } catch { /* malformed is not a decision */ }
  if (!decision || decision.actor !== 'user' || decision.decision_type !== 'accept' || decision.antecedent_ref !== proof.sourceMessageId
    || decision.source_signal_ref !== cognitionMessageSourceId(proof.cid, proof.sourceMessageId)
    || !isDeepStrictEqual(saved?.provenance, proof) || !saved?.input || humanInstructionContractHash(saved.input) !== proof.contractHash
    || decision.scope !== input.suggestedScope)
    throw new Error(t('cognition.create.invalid_decision'));
  return proof;
}
/** Only the host calls this after its actual full-preview interaction returned
 * allow. The model never receives a callable prepare/commit/permit API. */
export async function withHumanInstructionCreation<T>(userId: string, proof: HumanInstructionProvenance, work: () => Promise<T>): Promise<T> {
  humanInstructionProvenanceSchema.parse(proof);
  if (proof.ownerId !== userId) throw new Error(t('cognition.create.invalid_decision'));
  const permit = { uid: userId, proof, active: true };
  try { return await permits.run(permit, work); } finally { permit.active = false; }
}
export async function verifyCandidateFormationForPromotion(userId: string, candidate: RecallCandidateRecord): Promise<void> {
  if (candidate.contentOrganization) {
    if (!candidate.organizationReceipt) await (await import('../recall/content-organization')).verifyContentOrganization(userId, candidate);
  }
  else if (candidate.stockOrganizationProvenance) await (await import('../recall/stock-organization-provenance')).verifyStockOrganizationCandidate(userId, candidate);
  else if (candidate.humanInstructionProvenance) await verifyHumanInstructionCandidate(userId, candidate);
  else await verifyCaptureProvenanceForPromotion(userId, candidate);
}
export async function verifyCandidateFormationForCommittedRead(userId: string, candidate: RecallCandidateRecord): Promise<void> {
  if (candidate.contentOrganization) {
    if (!candidate.organizationReceipt) await (await import('../recall/content-organization')).verifyContentOrganization(userId, candidate);
  }
  else if (candidate.stockOrganizationProvenance) await (await import('../recall/stock-organization-provenance')).verifyStockOrganizationCandidate(userId, candidate, { committed: true });
  else if (candidate.humanInstructionProvenance) await verifyHumanInstructionCandidate(userId, candidate, { committed: true });
  else await verifyCaptureProvenanceForCommittedCandidate(userId, candidate);
}
