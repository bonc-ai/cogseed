/** Shared rule text follows its owning cognition in the same atomic store draft. */
import { createHash } from 'node:crypto';
import type { CognitionStoreDocument } from '../../cognition_kernel/object-model';
import { applyOntologyCommand } from './commands';
import { OntologyError } from './model';
import { normalizeAbilityAssetOntologyRefs } from '../../recall/ontology-refs';
import type { RecallAbilityAssetScopePolicy } from '../../recall/scope-policy';
import { ontologyScopeViolations } from './cognition-scope';

export function synchronizeOntologyRuleBodies(doc: CognitionStoreDocument, record: Record<string, unknown>): void {
  const previous = doc.compatibility?.records['ability-assets']?.[String(record.id)];
  const oldBindings = normalizeAbilityAssetOntologyRefs(previous?.ontologyRefs ?? []).filter(ref => ref.sharedBody);
  const refs = normalizeAbilityAssetOntologyRefs(record.ontologyRefs ?? []);
  for (const old of oldBindings) if (!refs.some(ref => ref.recordId === old.recordId && ref.sharedBody)) {
    // An explicit atomic formation undo may retire a newly created binding.
    // A generic rollback still keeps bindings and cannot silently unbind R.
    const undoId = typeof record.formationUndoCommandId === 'string' ? record.formationUndoCommandId : undefined;
    const undone = undoId && doc.ontology?.receipts[undoId]?.changedIds.includes(old.recordId!)
      && doc.ontology.records[old.recordId!]?.status === 'archived'
      && doc.ontology.history.some(row => row.commandId === undoId && row.after.id === old.recordId && row.intent === 'undo_command');
    if (!undone) refs.push(old);
  }
  if (refs.length) record.ontologyRefs = refs;
  const bindings = refs.filter(ref => ref.sharedBody);
  if (!bindings.length && !refs.some(ref => ref.recordId && record.scopePolicy)) return;
  if (!doc.ontology || typeof record.statement !== 'string') throw new OntologyError('invalid_reference', 'shared rule requires canonical ontology and cognition text');
  const actions: import('./commands').OntologyAction[] = [];
  const status = record.status === 'active' ? 'active' : ['paused', 'revoked'].includes(String(record.status)) ? 'paused' : 'archived';
  for (const ref of bindings) {
    const rule = doc.ontology.records[ref.recordId!];
    if (!rule || rule.kind !== 'rule' || rule.moduleId !== ref.moduleId || rule.status === 'corrected'
      || !rule.source.refs?.some(source => source.kind === 'asset' && source.id === record.id))
      throw new OntologyError('invalid_reference', 'shared rule is not bound to this cognition');
    const privacyNarrowed = ontologyScopeViolations(doc.ontology, [{ ...rule, status }], record.scopePolicy as RecallAbilityAssetScopePolicy | undefined).length > 0;
    if (rule.requirement !== record.statement || rule.status !== status || privacyNarrowed) actions.push({ intent: 'update', recordId: rule.id, expectedVersion: rule.version,
      patch: { requirement: record.statement, status, ...(privacyNarrowed ? { access: 'owner_only' } : {}) }, sourceLabel: '共享认知正文、范围和生命周期版本更新' });
  }
  const sourceCandidates = new Set([record.candidateId, ...(Array.isArray(record.sourceCandidateIds) ? record.sourceCandidateIds : [])]);
  for (const ref of refs) {
    const fact = doc.ontology.records[ref.recordId!];
    if (fact?.kind !== 'assertion' || !(sourceCandidates.has(fact.source.recordId) || fact.source.refs?.some(source => source.kind === 'asset' && source.id === record.id))
      || !ontologyScopeViolations(doc.ontology, [fact], record.scopePolicy as RecallAbilityAssetScopePolicy | undefined).length) continue;
    actions.push({ intent: 'update', recordId: fact.id, expectedVersion: fact.version, patch: { access: 'owner_only' }, sourceLabel: '关联认知范围收窄，事实正文和有效时间不变' });
  }
  if (!actions.length) return;
  const commandId = 'body-' + createHash('sha256').update(JSON.stringify([record.id, record.version, record.statement, doc.ontology.revision])).digest('hex').slice(0, 32);
  const outcome = applyOntologyCommand(doc.ontology, { commandId, expectedRevision: doc.ontology.revision, actions }, new Date().toISOString());
  const editDecision = record.userEditDecision as import('../edit-decision').CognitionEditDecision | undefined;
  if (editDecision && editDecision.committedVersion === String(record.version)) {
    outcome.receipt.userEditDecision = editDecision;
    outcome.document.receipts[commandId] = outcome.receipt;
  }
  // Preserve ownership provenance while extending version history.
  for (const id of outcome.receipt.changedIds) {
    const previousSource = doc.ontology.records[id].source;
    outcome.document.records[id].source = previousSource;
    outcome.document.history.filter(row => row.commandId === commandId && row.after.id === id).forEach(row => { row.after.source = previousSource; });
  }
  doc.ontology = outcome.document;
  doc.pendingJournal ??= [];
  doc.pendingJournal.push({ key: `ontology-${commandId}`, line: { at: new Date().toISOString(), kind: 'ontology', receipt: outcome.receipt } });
}
