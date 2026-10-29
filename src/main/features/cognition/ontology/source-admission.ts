/** Current task access to canonical ontology sources. Committed history is
 * evidence, not a perpetual permission grant. Queries and operation preflight
 * share these checks; neither creates approval credentials while reading. */
import { isDeepStrictEqual } from 'node:util';
import { createAssetSourceAvailability } from '../../recall/asset-source-availability';
import { readAbilityAsset } from '../../recall/asset-service';
import { readRecallJsonRecord } from '../../recall/store';
import { readRecallCandidate } from '../../recall/candidate-service';
import { verifyCandidateFormationForCommittedRead } from '../human-instruction-provenance';
import { isCognitionSourceEnabled, cognitionSourceControlSnapshot } from '../../recall/source-control';
import type { CognitionSourceRef } from '../../recall/source-service';
import { isAssetScopeAllowed } from '../../recall/scope-policy';
import { evaluateAssetRuntimeEligibility, type AssetRuntimeContext } from '../../recall/formal-assets/runtime';
import { readReviewDecision } from '../review-decision';
import { cognitionCompatibility } from '../../cognition_bridge';
import { readOntologyDocument } from './service';
import { OntologyError, type OntologyDocument, type OntologyRecord } from './model';
import { ontologyModuleVisibleToTask, type OntologyTaskScopeContext } from './query';

export type OntologySourceAdmission = 'allowed' | 'disabled' | 'unavailable';
export type OntologySourceContext = OntologyTaskScopeContext & AssetRuntimeContext;

export async function assessOntologySources(userId: string, doc: OntologyDocument, context: OntologySourceContext = {}): Promise<Map<string, OntologySourceAdmission>> {
  const compatibilityRevision = cognitionCompatibility(userId)?.revision;
  const controls = new Map<string, { ref: CognitionSourceRef; snapshot: string }>();
  const enabled = async (ref: CognitionSourceRef) => {
    const key = `${ref.kind}:${ref.id}`;
    if (!controls.has(key)) controls.set(key, { ref, snapshot: cognitionSourceControlSnapshot(userId, ref) });
    return isCognitionSourceEnabled(userId, ref);
  };
  const sourcesAvailable = createAssetSourceAvailability(userId);
  const cache = new Map<string, Promise<OntologySourceAdmission>>();
  const asset = (id: string): Promise<OntologySourceAdmission> => {
    const key = `asset:${id}`;
    if (!cache.has(key)) cache.set(key, (async () => {
      try {
        if (!await readRecallJsonRecord(userId, 'ability-assets', id)) return 'disabled';
        const row = await readAbilityAsset(userId, id);
        for (const ref of row.evidenceRefs) if (ref.taxonomyVersion === 2 && !await enabled(ref)) return 'disabled';
        return evaluateAssetRuntimeEligibility(row, { ...context, sourceAvailable: context.sourceAvailable !== false && await sourcesAvailable(row), operation: 'inspect' }).accessAllowed ? 'allowed' : 'disabled';
      } catch { return 'unavailable'; }
    })());
    return cache.get(key)!;
  };
  const candidate = (id: string): Promise<OntologySourceAdmission> => {
    const key = `candidate:${id}`;
    if (!cache.has(key)) cache.set(key, (async () => {
      try {
        const row = await readRecallCandidate(userId, id);
        if (row.status === 'confirmed' && row.promotedAssetId) return asset(row.promotedAssetId);
        if (row.status !== 'integrated' || row.proposalTarget !== 'ontology' || !row.ontologyHandoff) return 'disabled';
        if (!isAssetScopeAllowed(row.scopePolicy, { ...context, purpose: context.purpose || context.taskText })) return 'disabled';
        for (const ref of [...row.sourceRefs, ...row.evidenceRefs]) if (ref.taxonomyVersion === 2 && !await enabled(ref)) return 'disabled';
        await verifyCandidateFormationForCommittedRead(userId, row);
        const decision = await readReviewDecision(userId, `recall_candidate:${row.id}`, row.reviewDecisionId!);
        const receipt = doc.receipts[row.ontologyHandoff.commandId];
        if (!decision || decision.decision !== 'integrate_to_ontology'
          || !receipt || receipt.revision !== row.ontologyHandoff.ontologyRevision
          || !isDeepStrictEqual(receipt.changedIds, row.ontologyHandoff.recordIds)) return 'unavailable';
        return 'allowed';
      } catch { return 'unavailable'; }
    })());
    return cache.get(key)!;
  };
  const statuses = new Map<string, OntologySourceAdmission>();
  for (const record of Object.values(doc.records)) {
    const module = record.kind === 'module' ? record : doc.records[record.moduleId];
    if (!module || module.kind !== 'module' || module.status !== 'active' || record.status !== 'active'
      || !ontologyModuleVisibleToTask(module, context) || record.access !== 'task' || context.sourceAvailable === false) {
      statuses.set(record.id, 'disabled'); continue;
    }
    const results: OntologySourceAdmission[] = [];
    for (const ref of record.source.refs || []) {
      if (ref.kind === 'asset') results.push(await asset(ref.id));
      else if (ref.kind === 'candidate') results.push(await candidate(ref.id));
    }
    if (record.source.kind === 'candidate') results.push(record.source.recordId ? await candidate(record.source.recordId) : 'unavailable');
    statuses.set(record.id, results.includes('disabled') ? 'disabled' : results.includes('unavailable') ? 'unavailable' : 'allowed');
  }
  const current = readOntologyDocument(userId);
  // Legacy view adds compatibility records without changing canonical revision;
  // compare only canonical IDs when a query supplied that owner-visible view.
  if (current.revision !== doc.revision || cognitionCompatibility(userId)?.revision !== compatibilityRevision
    || [...controls.values()].some(({ ref, snapshot }) => cognitionSourceControlSnapshot(userId, ref) !== snapshot)
    || Object.entries(current.records).some(([id, record]) => !isDeepStrictEqual(record, doc.records[id])))
    throw new OntologyError('baseline_changed', 'ontology changed during source admission');
  return statuses;
}

export function ontologyWithAdmittedSources(doc: OntologyDocument, statuses: ReadonlyMap<string, OntologySourceAdmission>): OntologyDocument {
  const admitted = (record: OntologyRecord) => statuses.get(record.id) === 'allowed'
    && (record.kind === 'module' || statuses.get(record.moduleId) === 'allowed');
  return { ...doc, records: Object.fromEntries(Object.entries(doc.records).filter(([, record]) => admitted(record))),
    history: doc.history.filter(row => Boolean(doc.records[row.after.id]) && admitted(doc.records[row.after.id])
      && row.after.access === 'task' && isDeepStrictEqual(row.after.source, doc.records[row.after.id].source))
      .map(row => row.before && (row.before.access !== 'task' || !isDeepStrictEqual(row.before.source, row.after.source))
        ? { ...row, before: undefined } : row) };
}
