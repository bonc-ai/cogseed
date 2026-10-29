/** Host-only continuation of a real human standing intent. Proofs travel in the
 * atomic asset commit and its recoverable immutable version snapshot. No public
 * actor, reason string, model boolean or arbitrary JSON can issue a permit. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { RecallAbilityAssetRecord, RecallCandidateRecord } from './candidate-service';
import type { AbilityAssetVersionRecord } from './asset-service';
import { normalizeAbilityAssetScopePolicy, resolveScopeForAsset } from './scope-policy';
import { normalizeCognitionSourceRefsForWrite } from './source-service';
import { readRecallJsonRecord } from './store';
import { readReviewDecision } from '../cognition/review-decision';
import { cognitionEditDecisionSchema, type CognitionEditDecision } from '../cognition/edit-decision';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify({ value: canonical(value) })).digest('hex');
const terms = (values?: readonly string[]) => [...new Set((values || []).map(value => value.trim().replace(/\s+/g, ' ')))].sort();
export function standingGuidanceHash(asset: RecallAbilityAssetRecord): string {
  return hash({ assetId: asset.id, ownerId: asset.ownerId, type: asset.type, contentCategory: asset.contentCategory,
    statement: asset.statement, scope: asset.scope, scopePolicy: normalizeAbilityAssetScopePolicy(asset.scopePolicy),
    applicableWhen: terms(asset.applicableWhen), forbiddenWhen: terms(asset.forbiddenWhen),
    evidenceRefs: normalizeCognitionSourceRefsForWrite(asset.evidenceRefs), spaceId: asset.spaceId,
    sensitivity: asset.sensitivity, crossScopeConfirmedAt: asset.crossScopeConfirmedAt });
}
function controlHash(asset: RecallAbilityAssetRecord): string {
  return hash({ ownerId: asset.ownerId, assetId: asset.id, type: asset.type, contentCategory: asset.contentCategory,
    scope: asset.scope, scopePolicy: normalizeAbilityAssetScopePolicy(asset.scopePolicy),
    evidenceRefs: normalizeCognitionSourceRefsForWrite(asset.evidenceRefs), spaceId: asset.spaceId,
    sensitivity: asset.sensitivity, crossScopeConfirmedAt: asset.crossScopeConfirmedAt });
}
type Root = { rootCandidateId: string; rootDecisionId: string; rootVersion: string; rootKind?: 'candidate' | 'edit' };
type SupportBinding = { id: string; fingerprint: string; hash: string; candidateDigest: string; epoch: string; captureId: string; targetVersion: string };
export interface StandingPreferenceAuthority extends Root {
  schemaVersion: 1; ownerId: string; assetId: string; method: 'human_details_save' | 'nightly_supported_update' | 'human_instruction_edit';
  previousVersion: string; previousGuidanceHash: string; committedVersion: string; guidanceHash: string; createdAt: string;
  candidateId?: string; decisionId?: string; support?: SupportBinding; editDecision?: CognitionEditDecision;
}
type Permit = { uid: string; assetId: string; previousVersion: string; previousActiveVersion: string;
  previousGuidanceHash: string; root: Root; method: StandingPreferenceAuthority['method']; active: boolean;
  candidateId?: string; decisionId?: string; support?: SupportBinding; editDecision?: CognitionEditDecision;
  standingAuthorized?: boolean };
const permits = new AsyncLocalStorage<Permit>();
const positive = ['supported', 'noUnsupportedClaims', 'scopePreserved', 'finalDecisionPreserved', 'priorContentPreserved'];
function eligibleShape(asset: RecallAbilityAssetRecord, reviewedEditRoot = false): boolean {
  return asset.type === 'cognition' && asset.contentCategory === 'preference' && (asset.maturity !== 'seed' || reviewedEditRoot)
    && asset.status !== 'purged' && asset.status !== 'deleted' && asset.status !== 'revoked' && !asset.crossScopeConfirmedAt;
}
function view(asset: RecallAbilityAssetRecord, row: AbilityAssetVersionRecord): RecallAbilityAssetRecord {
  // Version snapshots freeze the content contract; live-only privacy fields are
  // checked by the current guidance hash and cannot be rolled back by this view.
  const value = { ...asset, ...row.snapshot, version: row.version, activeVersion: row.version };
  for (const key of ['scopePolicy', 'applicableWhen', 'forbiddenWhen', 'standingPreferenceAuthority'] as const)
    if (!(key in row.snapshot)) delete value[key];
  return value as RecallAbilityAssetRecord;
}
async function rootValid(uid: string, asset: RecallAbilityAssetRecord, root: Root, rows: AbilityAssetVersionRecord[]): Promise<boolean> {
  if (root.rootKind === 'edit') {
    const row = rows.find(value => value.version === root.rootVersion);
    const decision = cognitionEditDecisionSchema.safeParse(row?.snapshot.userEditDecision);
    return Boolean(row?.actor === 'user' && decision.success && decision.data.method === 'full_preview'
      && decision.data.ownerId === uid && decision.data.targetId === asset.id
      && decision.data.id === root.rootDecisionId && decision.data.committedVersion === root.rootVersion
      && row.reason === `cognition_edit:${decision.data.id}`);
  }
  const { readRecallCandidate, readRecallAssetHandoffReceipt } = await import('./candidate-service');
  const candidate = await readRecallCandidate(uid, root.rootCandidateId);
  const decision = await readReviewDecision(uid, `recall_candidate:${candidate.id}`, root.rootDecisionId);
  const row = rows.find(value => value.version === root.rootVersion);
  const saved = row?.snapshot;
  if (!row || !saved || row.actor !== 'user') return false;
  const { verifyCandidateFormationForCommittedRead } = await import('../cognition/human-instruction-provenance');
  await verifyCandidateFormationForCommittedRead(uid, candidate);
  const handoff = await readRecallAssetHandoffReceipt(uid, candidate.id, root.rootDecisionId, { recovery: 'none' });
  const parent = rows.find(value => Number(value.version) === Number(row.version) - 1);
  const { resolveExecutionEvidenceRefs } = await import('./evidence-resolution');
  const expectedSources = await resolveExecutionEvidenceRefs(uid, normalizeCognitionSourceRefsForWrite([
    ...(candidate.suggestedAction === 'create' ? [] : parent?.snapshot.evidenceRefs || []), ...candidate.evidenceRefs,
  ]));
  if (!handoff || handoff.assetId !== asset.id || handoff.version !== root.rootVersion
    || hash(normalizeCognitionSourceRefsForWrite(handoff.sourceRefs)) !== hash(normalizeCognitionSourceRefsForWrite(saved.evidenceRefs))
    || hash(expectedSources) !== hash(normalizeCognitionSourceRefsForWrite(saved.evidenceRefs))) return false;
  return Boolean(candidate.ownerId === uid && candidate.status === 'confirmed' && candidate.promotedAssetId === asset.id
    && candidate.reviewDecisionId === root.rootDecisionId && candidate.suggestedType === 'cognition' && candidate.contentCategory === 'preference'
    && (candidate.spaceId || '') === (asset.spaceId || '') && candidate.sensitivity === asset.sensitivity
    && (candidate.captureProvenance?.pipeline === 'nightly_conversation' || candidate.humanInstructionProvenance?.pipeline === 'human_instruction') && decision?.actor === 'user'
    && ['accept', 'modify'].includes(decision.decision_type) && decision.outcome === 'asset_created' && decision.asset_id === asset.id
    && decision.antecedent_ref === candidate.id && row?.reason === `review_decision:${decision.decision_id}`
    && saved?.type === 'cognition' && saved.contentCategory === 'preference' && saved.statement === candidate.judgment
    && saved.scope === resolveScopeForAsset(candidate.suggestedScope)
    && hash(normalizeAbilityAssetScopePolicy(saved.scopePolicy)) === hash(normalizeAbilityAssetScopePolicy(candidate.scopePolicy))
    && hash(terms(saved.applicableWhen)) === hash(terms(candidate.applicableWhen))
    && hash(terms(saved.forbiddenWhen)) === hash(terms(candidate.forbiddenWhen)));
}
async function findRoot(uid: string, asset: RecallAbilityAssetRecord, rows: AbilityAssetVersionRecord[]): Promise<Root | undefined> {
  const existing = parseProof(asset.standingPreferenceAuthority, asset);
  if (existing && await rootValid(uid, asset, existing, rows)) return {
    rootCandidateId: existing.rootCandidateId, rootDecisionId: existing.rootDecisionId,
    rootVersion: existing.rootVersion, ...(existing.rootKind ? { rootKind: existing.rootKind } : {}),
  };
  const { readRecallCandidate } = await import('./candidate-service');
  for (const id of [...new Set([...(asset.sourceCandidateIds || []), asset.candidateId])].reverse()) {
    try {
      const candidate = await readRecallCandidate(uid, id);
      if (!candidate.reviewDecisionId) continue;
      const row = rows.find(value => value.reason === `review_decision:${candidate.reviewDecisionId}`);
      if (!row) continue;
      const root = { rootCandidateId: id, rootDecisionId: candidate.reviewDecisionId, rootVersion: row.version };
      if (await rootValid(uid, asset, root, rows)) return root;
    } catch { /* One non-human revision cannot authorize or hide another root. */ }
  }
}
function parseProof(value: unknown, asset: RecallAbilityAssetRecord): StandingPreferenceAuthority | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const proof = value as StandingPreferenceAuthority;
  if (proof.schemaVersion !== 1 || proof.ownerId !== asset.ownerId || proof.assetId !== asset.id
    || !['human_details_save', 'nightly_supported_update', 'human_instruction_edit'].includes(proof.method)
    || ![proof.committedVersion, proof.previousVersion, proof.rootVersion].every(version => /^\d+$/.test(String(version)))
    || Number(proof.committedVersion) !== Number(proof.previousVersion) + 1
    || ![proof.guidanceHash, proof.previousGuidanceHash].every(value => /^[a-f0-9]{64}$/.test(value || ''))
    || !Number.isFinite(Date.parse(proof.createdAt))) return undefined;
  return proof;
}
function unchangedVersionContract(asset: RecallAbilityAssetRecord, rows: AbilityAssetVersionRecord[], from: string, through: string, guidanceHash: string): boolean {
  const start = rows.find(row => row.version === from);
  if (!start || Number(through) < Number(from) || standingGuidanceHash(view(asset, start)) !== guidanceHash) return false;
  const intervening = rows.filter(row => Number(row.version) > Number(from) && Number(row.version) <= Number(through));
  return intervening.length === Number(through) - Number(from)
    && intervening.every(row => standingGuidanceHash(view(asset, row)) === guidanceHash);
}
async function validateProof(uid: string, asset: RecallAbilityAssetRecord, proof: StandingPreferenceAuthority,
  rows: AbilityAssetVersionRecord[], depth = 0): Promise<boolean> {
  if (depth > rows.length || !await rootValid(uid, asset, proof, rows)) return false;
  const committed = rows.find(row => row.version === proof.committedVersion);
  const parent = rows.find(row => row.version === proof.previousVersion);
  if (!committed || !parent || hash(committed.snapshot.standingPreferenceAuthority) !== hash(proof)
    || standingGuidanceHash(view(asset, committed)) !== proof.guidanceHash
    || standingGuidanceHash(view(asset, parent)) !== proof.previousGuidanceHash) return false;
  // The structured proof is itself queued in the atomic version commit by the
  // private host permit. A lagging version append need not invent actor metadata.
  if (proof.method === 'human_details_save') return true;
  if (proof.method === 'human_instruction_edit') {
    const decision = cognitionEditDecisionSchema.safeParse(committed.snapshot.userEditDecision);
    if (!decision.success || hash(decision.data) !== hash(proof.editDecision)
      || decision.data.ownerId !== uid || decision.data.targetId !== asset.id
      || decision.data.previousVersion !== parent.version || decision.data.committedVersion !== committed.version
      || committed.actor !== 'user' || committed.reason !== `cognition_edit:${decision.data.id}`) return false;
    if (decision.data.method === 'full_preview') return proof.rootKind === 'edit' && proof.rootVersion === committed.version;
    if (controlHash(view(asset, parent)) !== controlHash(view(asset, committed))) return false;
    const parentProof = parseProof(parent.snapshot.standingPreferenceAuthority, asset);
    if (parentProof) return unchangedVersionContract(asset, rows, parentProof.committedVersion, parent.version, parentProof.guidanceHash)
      && validateProof(uid, asset, parentProof, rows, depth + 1);
    return unchangedVersionContract(asset, rows, proof.rootVersion, parent.version, proof.previousGuidanceHash);
  }
  if (!proof.candidateId || !proof.decisionId || !proof.support) return false;
  const { readRecallCandidate } = await import('./candidate-service');
  const candidate = await readRecallCandidate(uid, proof.candidateId);
  const { nightlySemanticCandidateDigest } = await import('./nightly-automatic-support');
  const decision = await readReviewDecision(uid, `recall_candidate:${proof.candidateId}`, proof.decisionId);
  const support = await readRecallJsonRecord(uid, 'automatic-source-support', proof.support.id);
  if (candidate.status !== 'confirmed' || nightlySemanticCandidateDigest(candidate) !== proof.support.candidateDigest
    || candidate.reviewDecisionId !== proof.decisionId || candidate.promotedAssetId !== asset.id
    || candidate.suggestedAction !== 'update' || candidate.targetAssetId !== asset.id || candidate.targetVersionUsed !== proof.previousVersion
    || candidate.judgment !== committed.snapshot.statement || candidate.contentCategory !== 'preference'
    || decision?.actor !== 'system' || decision.decision_type !== 'accept' || decision.outcome !== 'asset_created' || decision.asset_id !== asset.id
    || decision.antecedent_ref !== proof.candidateId || committed.reason !== `review_decision:${proof.decisionId}`
    || !support || hash(support) !== proof.support.hash || support.fingerprint !== proof.support.fingerprint
    || support.policyEpoch !== proof.support.epoch || support.targetVersion !== proof.previousVersion || support.candidateId !== proof.candidateId
    || support.captureId !== proof.support.captureId || support.method !== 'model_assisted' || support.modelCompleted !== true
    || !positive.every(key => (support.checks as Record<string, unknown>)?.[key] === true)) return false;
  const { verifyCaptureProvenanceForCommittedCandidate } = await import('./capture-provenance');
  await verifyCaptureProvenanceForCommittedCandidate(uid, candidate);
  const { readRecallAssetHandoffReceipt } = await import('./candidate-service');
  const handoff = await readRecallAssetHandoffReceipt(uid, proof.candidateId, proof.decisionId, { recovery: 'none' });
  if (handoff?.assetId !== asset.id || handoff.version !== proof.committedVersion) return false;
  const parentProof = parseProof(parent.snapshot.standingPreferenceAuthority, asset);
  if (parentProof) return unchangedVersionContract(asset, rows, parentProof.committedVersion, parent.version, parentProof.guidanceHash)
    && validateProof(uid, asset, parentProof, rows, depth + 1);
  // An ordinary title-only version can still carry the original unchanged
  // human intent; it must match that immutable human content contract.
  return unchangedVersionContract(asset, rows, proof.rootVersion, parent.version, proof.previousGuidanceHash);
}
export async function hasCommittedStandingPreferenceAuthority(uid: string, asset: RecallAbilityAssetRecord): Promise<boolean> {
  try {
    const proof = parseProof(asset.standingPreferenceAuthority, asset);
    if (!proof || !eligibleShape(asset, proof.rootKind === 'edit') || asset.ownerId !== uid || asset.status !== 'active'
      || String(asset.activeVersion || asset.version) !== asset.version || standingGuidanceHash(asset) !== proof.guidanceHash) return false;
    const { listAbilityAssetVersions } = await import('./asset-service');
    const rows = await listAbilityAssetVersions(uid, asset.id);
    if (!await validateProof(uid, asset, proof, rows)) return false;
    // Metadata-only version advances preserve authority only while every
    // intervening immutable contract is unchanged. Reverts cannot launder edits.
    return unchangedVersionContract(asset, rows, proof.committedVersion, asset.version, proof.guidanceHash)
      && rows.some(row => row.version === asset.version);
  } catch { return false; }
}
/** Read-only verifier for the original human commit and unchanged metadata
 * versions. It shares the exact source/decision/handoff checks with continuation
 * proofs; a category, actor string or enabled source alone cannot authorize it. */
export async function hasOriginalHumanStandingPreferenceAuthority(uid: string, asset: RecallAbilityAssetRecord): Promise<boolean> {
  try {
    if (!eligibleShape(asset) || asset.ownerId !== uid || asset.status !== 'active'
      || asset.lifecycleStatus !== 'user_confirmed_unverified' || !asset.reviewDecisionId
      || String(asset.activeVersion || asset.version) !== asset.version) return false;
    const { listAbilityAssetVersions } = await import('./asset-service');
    const rows = await listAbilityAssetVersions(uid, asset.id);
    const row = rows.find(value => value.actor === 'user' && value.reason === `review_decision:${asset.reviewDecisionId}`);
    if (!row) return false;
    const { readRecallCandidate } = await import('./candidate-service');
    for (const id of [...new Set([...(asset.sourceCandidateIds || []), asset.candidateId])].reverse()) {
      if (!id) continue;
      const candidate = await readRecallCandidate(uid, id);
      if (candidate.reviewDecisionId !== asset.reviewDecisionId) continue;
      const root = { rootCandidateId: id, rootDecisionId: asset.reviewDecisionId, rootVersion: row.version };
      if (!await rootValid(uid, asset, root, rows)) return false;
      const guidance = standingGuidanceHash(view(asset, row));
      if (standingGuidanceHash(asset) !== guidance) return false;
      const intervening = rows.filter(value => Number(value.version) > Number(row.version) && Number(value.version) <= Number(asset.version));
      return Number(asset.version) >= Number(row.version) && intervening.length === Number(asset.version) - Number(row.version)
        && intervening.every(value => standingGuidanceHash(view(asset, value)) === guidance)
        && rows.some(value => value.version === asset.version);
    }
    return false;
  } catch { return false; }
}
async function runPermit<T>(permit: Permit | undefined, work: () => Promise<T>): Promise<T> {
  if (!permit) return work();
  try { return await permits.run(permit, work); } finally { permit.active = false; }
}
export async function withHumanStandingPreferenceDetailsSave<T>(uid: string, asset: RecallAbilityAssetRecord, work: () => Promise<T>): Promise<T> {
  const { listAbilityAssetVersions } = await import('./asset-service');
  const rows = await listAbilityAssetVersions(uid, asset.id);
  const existing = parseProof(asset.standingPreferenceAuthority, asset);
  let root = eligibleShape(asset, existing?.rootKind === 'edit') && asset.ownerId === uid ? await findRoot(uid, asset, rows) : undefined;
  if (root) {
    // The editor reviews body and natural-language conditions, not arbitrary
    // hidden ACL or source changes made since the earlier authorized revision.
    let controlsAuthorized = false;
    for (const row of [...rows].reverse()) {
      if (controlHash(view(asset, row)) !== controlHash(asset)) continue;
      const proof = parseProof(row.snapshot.standingPreferenceAuthority, asset);
      if (proof ? await validateProof(uid, asset, proof, rows) : row.version === root.rootVersion) {
        controlsAuthorized = true; break;
      }
    }
    if (!controlsAuthorized) root = undefined;
  }
  return runPermit(root ? { uid, assetId: asset.id, root, method: 'human_details_save', active: true,
    previousVersion: asset.version, previousActiveVersion: String(asset.activeVersion || asset.version), previousGuidanceHash: standingGuidanceHash(asset) } : undefined, work);
}
/** The caller is the host editor after verifying a real message or resolving
 * its complete preview interaction. This permit cannot be supplied as tool JSON. */
export async function withHumanInstructionEdit<T>(uid: string, asset: RecallAbilityAssetRecord,
  decision: CognitionEditDecision, work: () => Promise<T>): Promise<T> {
  cognitionEditDecisionSchema.parse(decision);
  if (decision.ownerId !== uid || decision.targetId !== asset.id || decision.previousVersion !== asset.version
    || decision.previousActiveVersion !== String(asset.activeVersion || asset.version)) throw new Error('edit decision baseline changed');
  const { listAbilityAssetVersions } = await import('./asset-service');
  const rows = await listAbilityAssetVersions(uid, asset.id);
  const root = decision.method === 'full_preview'
    ? { rootKind: 'edit' as const, rootCandidateId: asset.candidateId, rootDecisionId: decision.id, rootVersion: decision.committedVersion }
    : await findRoot(uid, asset, rows);
  const standingAuthorized = decision.method === 'full_preview' || await hasReviewedStandingContract(uid, asset);
  if (decision.method === 'exact_patch' && ['statement', 'applicableWhen', 'forbiddenWhen'].some(key => Object.hasOwn(decision.patch, key)) && asset.type === 'cognition' && asset.contentCategory === 'preference' && !standingAuthorized)
    throw new Error('exact edit requires a complete reviewed contract');
  return runPermit({ uid, assetId: asset.id, root: root || { rootCandidateId: asset.candidateId, rootDecisionId: decision.id, rootVersion: decision.committedVersion },
    method: 'human_instruction_edit', editDecision: decision, standingAuthorized, active: true, previousVersion: asset.version,
    previousActiveVersion: String(asset.activeVersion || asset.version), previousGuidanceHash: standingGuidanceHash(asset) }, work);
}
/** Pausing an asset does not erase the person's earlier complete decision;
 * using it still requires active status in the ordinary runtime gate. */
export async function hasReviewedStandingContract(uid: string, asset: RecallAbilityAssetRecord): Promise<boolean> {
  const active = { ...asset, status: 'active' as const };
  return await hasCommittedStandingPreferenceAuthority(uid, active) || await hasOriginalHumanStandingPreferenceAuthority(uid, active);
}

export async function withAutomaticStandingPreferenceUpdate<T>(uid: string, candidate: RecallCandidateRecord,
  decisionId: string, epoch: string, work: () => Promise<T>): Promise<T> {
  if (candidate.suggestedAction !== 'update' || candidate.suggestedType !== 'cognition' || candidate.contentCategory !== 'preference' || !candidate.targetAssetId) return work();
  const { readAbilityAsset, listAbilityAssetVersions } = await import('./asset-service');
  const asset = await readAbilityAsset(uid, candidate.targetAssetId);
  const { hasUserAuthorizedStandingPreference } = await import('./standing-preference');
  if (!await hasUserAuthorizedStandingPreference(uid, asset)) return work();
  const root = await findRoot(uid, asset, await listAbilityAssetVersions(uid, asset.id));
  if (!root) return work();
  const { readVerifiedPendingNightlySupport, nightlySemanticCandidateDigest } = await import('./nightly-automatic-support');
  const support = await readVerifiedPendingNightlySupport(uid, candidate, epoch);
  const decision = await readReviewDecision(uid, `recall_candidate:${candidate.id}`, decisionId);
  if (!support || support.targetVersion !== asset.version || decision?.actor !== 'system' || decision.decision_type !== 'accept'
    || decision.antecedent_ref !== candidate.id || decision.outcome === 'asset_created') throw new Error('standing automatic continuation requires its current verified review');
  return runPermit({ uid, assetId: asset.id, root, method: 'nightly_supported_update', active: true,
    previousVersion: asset.version, previousActiveVersion: String(asset.activeVersion || asset.version), previousGuidanceHash: standingGuidanceHash(asset),
    candidateId: candidate.id, decisionId, support: { id: support.id, fingerprint: support.fingerprint, hash: hash(support), candidateDigest: nightlySemanticCandidateDigest(candidate), epoch,
      captureId: support.captureId, targetVersion: asset.version } }, work);
}
/** Invoked only inside the actual asset updater, before the atomic store/journal
 * commit. An input cannot contain or construct the private live ALS permit. */
export function readStandingPreferenceAuthorityBaseline(uid: string, assetId: string): { version: string; activeVersion: string } | undefined {
  const permit = permits.getStore();
  return permit?.active && permit.uid === uid && permit.assetId === assetId
    ? { version: permit.previousVersion, activeVersion: permit.previousActiveVersion } : undefined;
}
export function attachHumanEditMetadata(uid: string, current: RecallAbilityAssetRecord, next: RecallAbilityAssetRecord): void {
  const permit = permits.getStore();
  if (permit?.active && permit.uid === uid && permit.assetId === current.id && permit.editDecision)
    next.userEditDecision = { ...permit.editDecision, committedVersion: next.version };
}
export function attachStandingPreferenceAuthority(uid: string, current: RecallAbilityAssetRecord, next: RecallAbilityAssetRecord): void {
  const permit = permits.getStore();
  if (!permit?.active || permit.uid !== uid || permit.assetId !== current.id) return;
  if (standingGuidanceHash(current) !== permit.previousGuidanceHash) throw new Error('standing preference authority baseline changed');
  if (permit.editDecision) {
    next.userEditDecision = permit.editDecision;
    if (permit.editDecision.method === 'full_preview' && next.type === 'cognition' && next.contentCategory === 'preference') {
      // Reviewing the complete contract establishes intent, not proven effects.
      // Maturity stays on the independent validation axis, including seed.
      next.lifecycleStatus = 'user_confirmed_unverified';
    }
  }
  if (!eligibleShape(next, permit.root.rootKind === 'edit')) { delete next.standingPreferenceAuthority; return; }
  if (permit.method === 'human_instruction_edit' && !permit.standingAuthorized) {
    // A title/tag decision may save metadata, but cannot review an intervening
    // body merely because that body still carries an older proof object.
    delete next.standingPreferenceAuthority;
    return;
  }
  if (permit.method === 'human_details_save' && (controlHash(current) !== controlHash(next)
    || (current.statement === next.statement && hash(terms(current.applicableWhen)) === hash(terms(next.applicableWhen))
      && hash(terms(current.forbiddenWhen)) === hash(terms(next.forbiddenWhen))))) return;
  if (permit.method === 'nightly_supported_update' && (next.reviewDecisionId !== permit.decisionId
    || hash(normalizeAbilityAssetScopePolicy(current.scopePolicy)) !== hash(normalizeAbilityAssetScopePolicy(next.scopePolicy))
    || current.scope !== next.scope)) throw new Error('standing automatic continuation cannot expand its access');
  next.standingPreferenceAuthority = { schemaVersion: 1, ownerId: uid, assetId: next.id, ...permit.root, method: permit.method,
    previousVersion: current.version, previousGuidanceHash: permit.previousGuidanceHash, committedVersion: next.version,
    guidanceHash: standingGuidanceHash(next), createdAt: next.updatedAt,
    ...(permit.editDecision ? { editDecision: permit.editDecision } : {}),
    ...(permit.candidateId ? { candidateId: permit.candidateId, decisionId: permit.decisionId, support: permit.support } : {}) } satisfies StandingPreferenceAuthority;
}
