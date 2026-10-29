/** User-reviewed inverse of a concrete automatic save, with one atomic source commit. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { safeId } from '../../storage';
import { withCognitionTransition, withCognitionSourceDependency } from '../cognition_bridge';
import { readOntologyDocument } from '../cognition/ontology/service';
import { applyOntologyCommand, type OntologyCommand } from '../cognition/ontology/commands';
import { OntologyError, type OntologyRecord } from '../cognition/ontology/model';
import { readReviewDecision, writeReviewDecision } from '../cognition/review-decision';
import { readRecallCandidate, readRecallAssetHandoffReceipt, withRecallCandidatePromotionLock } from './candidate-service';
import { readAbilityAsset, readAbilityAssetVersionSnapshot, listAbilityAssets, deleteAbilityAsset, rollbackAbilityAsset } from './asset-service';
import { readRecallJsonRecord, updateRecallJsonRecord } from './store';
import { isCognitionSourceEnabled } from './source-control';
import { notifyCognitionWrite } from './store-events';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function withoutJournal(record: Record<string, unknown> | undefined) {
  if (!record) return record;
  const { pendingVersionSnapshots: _journal, ...content } = record;
  return content;
}
export interface AutomaticFormationUndoPreview {
  candidateId: string; token: string; alreadyUndone: boolean;
  assetChange?: { assetId: string; title: string; before: string; after?: string; action: 'delete' | 'rollback'; toVersion?: string };
  ontologyChanges: Array<{ before: OntologyRecord; after: OntologyRecord }>;
}

async function prepare(userId: string, candidateId: string) {
  if (!safeId(userId) || !safeId(candidateId)) throw new Error('invalid automatic undo identity');
  const candidate = await readRecallCandidate(userId, candidateId);
  const raw = await readRecallJsonRecord(userId, 'candidates', candidateId);
  if (!raw || !candidate.reviewDecisionId || !['confirmed', 'integrated'].includes(candidate.status))
    throw new Error('a completed automatic save is required');
  const approval = await readReviewDecision(userId, `recall_candidate:${candidateId}`, candidate.reviewDecisionId);
  if (approval?.actor !== 'system') throw new Error('only an automatic save can use this undo');
  const doc = readOntologyDocument(userId);
  const commandId = 'undo-formation-' + hash([userId, candidateId, candidate.reviewDecisionId]).slice(0, 32);
  if (candidate.automaticUndo) return { candidate, raw, doc, commandId,
    preview: { candidateId, token: hash(candidate.automaticUndo), alreadyUndone: true, ontologyChanges: [] } as AutomaticFormationUndoPreview };
  let command: OntologyCommand | undefined;
  let ontologyChanges: AutomaticFormationUndoPreview['ontologyChanges'] = [];
  if (candidate.ontologyFormation?.actions.length) {
    const receipt = doc.receipts[candidate.ontologyFormation.commandId];
    if (!receipt) throw new Error('the saved ontology receipt is unavailable');
    const id = receipt.changedIds[0], record = doc.records[id];
    if (!record) throw new Error('the saved ontology impact is unavailable');
    command = { commandId, expectedRevision: doc.revision, actions: [{ intent: 'undo_command',
      recordId: id, expectedVersion: record.version, originalCommandId: receipt.commandId, sourceLabel: '用户撤销本次自动保存' }] };
    const outcome = applyOntologyCommand(doc, command, new Date().toISOString());
    ontologyChanges = outcome.receipt.changedIds.map(id => ({ before: doc.records[id], after: outcome.document.records[id] }));
    const created = new Set(ontologyChanges.filter(change => change.after.status === 'archived').map(change => change.before.id));
    if ((await listAbilityAssets(userId)).some(asset => asset.id !== candidate.promotedAssetId
      && !['deleted', 'purged', 'revoked'].includes(asset.status)
      && asset.ontologyRefs?.some(ref => ref.recordId && created.has(ref.recordId))))
      throw new OntologyError('invalid_reference', 'another cognition now references the saved ontology impact; compare again');
  }
  let asset: Awaited<ReturnType<typeof readAbilityAsset>> | undefined;
  let assetChange: AutomaticFormationUndoPreview['assetChange'];
  let previousSnapshot: Awaited<ReturnType<typeof readAbilityAssetVersionSnapshot>> | undefined;
  let rawAsset: Awaited<ReturnType<typeof readRecallJsonRecord>>;
  if (candidate.promotedAssetId) {
    const receipt = await readRecallAssetHandoffReceipt(userId, candidateId, candidate.reviewDecisionId, { recovery: 'none' });
    asset = await readAbilityAsset(userId, candidate.promotedAssetId);
    rawAsset = await readRecallJsonRecord(userId, 'ability-assets', candidate.promotedAssetId);
    if (!receipt || receipt.assetId !== asset.id || receipt.version !== asset.version
      || String(asset.activeVersion || asset.version) !== receipt.version || asset.status !== 'active'
      || asset.reviewDecisionId !== candidate.reviewDecisionId)
      throw new OntologyError('baseline_changed', 'the automatically saved cognition has changed; compare again');
    if (candidate.suggestedAction === 'create' && asset.candidateId === candidateId) {
      if ((await listAbilityAssets(userId)).some(other => other.id !== asset!.id
        && !['deleted', 'purged', 'revoked'].includes(other.status)
        && (other.derivedFrom?.includes(asset!.id) || other.relations?.some(ref => ref.assetId === asset!.id))))
        throw new OntologyError('invalid_reference', 'another cognition references this save; compare again');
      assetChange = { assetId: asset.id, title: asset.title, before: asset.statement, action: 'delete' };
    } else if (candidate.suggestedAction === 'update' && candidate.targetVersionUsed) {
      previousSnapshot = await readAbilityAssetVersionSnapshot(userId, asset.id, candidate.targetVersionUsed);
      if (!previousSnapshot || candidate.targetVersionUsed === asset.version) throw new Error('the prior cognition version is unavailable');
      for (const ref of previousSnapshot.evidenceRefs || []) if (!await isCognitionSourceEnabled(userId, ref))
        throw new OntologyError('source_unavailable', 'the prior cognition source is no longer authorized');
      assetChange = { assetId: asset.id, title: asset.title, before: asset.statement, after: previousSnapshot.statement,
        action: 'rollback', toVersion: candidate.targetVersionUsed };
    } else throw new Error('this automatic action needs a new explicit comparison before reversal');
  }
  if (!assetChange && !command) throw new Error('no saved impact can be reversed');
  const token = hash({ raw, rawAsset, previousSnapshot, docRevision: doc.revision, command });
  return { candidate, raw, rawAsset, asset, doc, command, commandId,
    preview: { candidateId, token, alreadyUndone: false, ...(assetChange ? { assetChange } : {}), ontologyChanges } as AutomaticFormationUndoPreview };
}

export async function previewAutomaticFormationUndo(userId: string, candidateId: string): Promise<AutomaticFormationUndoPreview> {
  return withCognitionTransition(userId, async () => (await prepare(userId, candidateId)).preview);
}

export async function undoAutomaticFormation(userId: string, candidateId: string, previewToken: string) {
  if (!/^[a-f0-9]{64}$/.test(previewToken)) throw new Error('a reviewed undo preview is required');
  return withRecallCandidatePromotionLock(userId, () => withCognitionTransition(userId, async () => {
    const prepared = await prepare(userId, candidateId);
    if (prepared.preview.alreadyUndone) return { candidate: prepared.candidate, alreadyUndone: true };
    if (prepared.preview.token !== previewToken) throw new OntologyError('baseline_changed', 'undo preview changed; review current impact again');
    const now = new Date().toISOString();
    const decision = await writeReviewDecision(userId, { targetRef: `recall_candidate:${candidateId}`, actor: 'user',
      decisionType: 'modify', decision: 'undo_automatic_save', reason: '撤销已审阅的本次自动保存影响',
      supersedesRef: prepared.candidate.reviewDecisionId, idempotencyKey: prepared.commandId });
    const marker = { decisionId: decision.decision_id, originalDecisionId: prepared.candidate.reviewDecisionId!,
      commandId: prepared.commandId, committedAt: now };
    let applied = false;
    await withCognitionSourceDependency(userId, prepared.asset ? 'ability-assets' : 'candidates', (store, source) => {
      // Version-journal recovery and post-commit metadata use the same business
      // writer. Neither is the actual inverse's source commit.
      if (applied) return;
      const inverse = prepared.preview.assetChange;
      if (prepared.asset && source.version === prepared.asset.version && source.status === prepared.asset.status) return;
      if (prepared.asset && (source.id !== prepared.asset.id || inverse?.action === 'rollback'
        && (String(source.version) !== String(Number(prepared.asset.version) + 1) || source.statement !== inverse.after)
        || inverse?.action === 'delete' && source.status !== 'deleted'))
        throw new OntologyError('baseline_changed', 'the inverse source does not match the reviewed impact');

      const current = store.compatibility?.records.candidates?.[candidateId];
      if (!current || !isDeepStrictEqual(current, prepared.raw)) throw new OntologyError('baseline_changed', 'candidate changed before undo commit');
      if (prepared.asset && !isDeepStrictEqual(withoutJournal(store.compatibility!.records['ability-assets']?.[prepared.asset.id]), withoutJournal(prepared.rawAsset)))
        throw new OntologyError('baseline_changed', 'cognition changed before undo commit');
      if (prepared.command) {
        if (!store.ontology || !isDeepStrictEqual(store.ontology, prepared.doc)) throw new OntologyError('baseline_changed', 'ontology changed before undo commit');
        const outcome = applyOntologyCommand(store.ontology, prepared.command, now);
        store.ontology = outcome.document;
        store.pendingJournal ??= [];
        store.pendingJournal.push({ key: `ontology-${marker.commandId}`, line: { at: now, kind: 'ontology', receipt: outcome.receipt } });
        if (prepared.asset) source.formationUndoCommandId = marker.commandId;
      }
      applied = true;
      if (prepared.asset) {
        store.compatibility!.records.candidates[candidateId] = { ...current, automaticUndo: marker, updatedAt: now };
        return { records: { candidates: [candidateId] } };
      }
    }, async () => {
      const change = prepared.preview.assetChange;
      if (change?.action === 'delete') await deleteAbilityAsset(userId, change.assetId,
        { actor: 'user', reason: '撤销本次自动新增', expectedVersion: prepared.asset!.version });
      else if (change) await rollbackAbilityAsset(userId, change.assetId, change.toVersion!, { actor: 'user', reason: '撤销本次自动更新' });
      else await updateRecallJsonRecord(userId, 'candidates', candidateId, raw => ({ ...raw!, automaticUndo: marker, updatedAt: now }));
    });
    if (!applied) throw new Error('the reviewed inverse did not commit');
    notifyCognitionWrite(userId, 'candidates', 'update', candidateId);
    return { candidate: await readRecallCandidate(userId, candidateId), alreadyUndone: false };
  }));
}
