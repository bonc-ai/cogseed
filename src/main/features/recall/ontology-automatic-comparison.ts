/** Automatic ontology retention compares canonical identities and full rule
 * semantics. An unavailable comparison is a hold, never a no-match verdict. */
import { readOntologyDocument } from '../cognition/ontology/service';
import type { OntologyRecord } from '../cognition/ontology/model';
import type { RecallCandidateRecord } from './candidate-service';
import { assessOntologySources } from '../cognition/ontology/source-admission';
import { readRecallJsonRecord } from './store';

export async function independentOntologyComparisonReasons(userId: string, candidate: RecallCandidateRecord): Promise<string[]> {
  return ontologyFormationComparisonReasons(userId, candidate);
}

/** Joint formations have the same identity/conflict contract. A shared rule
 * body is allowed only with its own cognition, never a reason to skip checks. */
export async function ontologyFormationComparisonReasons(userId: string, candidate: RecallCandidateRecord): Promise<string[]> {
  const plan = candidate.ontologyFormation;
  if (!plan || candidate.proposalTarget === 'ontology' && (!plan.actions.length || plan.refs.some(ref => ref.sharedBody)))
    return ['ontology_independent_plan_incomplete'];
  const doc = readOntologyDocument(userId);
  if (doc.revision !== plan.baselineRevision) return ['ontology_baseline_changed'];
  // This operation compares stored source records; it does not apply the
  // candidate as task guidance. Both candidate and summary bodies may quote
  // forbidden contexts. Neither is an actual taskText or a read-purpose grant.
  // Use current, canonical source metadata rather than model-proposed policy.
  let sourceScope: { projectId?: string; workspaceId?: string; conversationKind?: string };
  try {
    const capture = candidate.captureProvenance
      ? await readRecallJsonRecord(userId, 'captures', candidate.captureProvenance.captureId) : undefined;
    if (!capture || typeof capture.conversationId !== 'string') return ['ontology_source_comparison_unavailable'];
    const { getConversation } = await import('../chats');
    const conversation = await getConversation(userId, capture.conversationId);
    if (!conversation) return ['ontology_source_comparison_unavailable'];
    sourceScope = { projectId: conversation.project_id || undefined, workspaceId: conversation.space_id || undefined,
      conversationKind: conversation.kind || undefined };
    const frozen = (capture.formationCheckpoint as { sourceScope?: unknown } | undefined)?.sourceScope;
    if (frozen && JSON.stringify(frozen) !== JSON.stringify(sourceScope)) return ['ontology_source_comparison_unavailable'];
  } catch { return ['ontology_source_comparison_unavailable']; }
  const statuses = await assessOntologySources(userId, doc, sourceScope);
  const { listRecallCandidates } = await import('./candidate-service');
  const peers = (await listRecallCandidates(userId)).filter(other => other.id !== candidate.id
    && !['confirmed', 'integrated', 'rejected', 'ignored', 'expired', 'superseded'].includes(other.status));
  const touched = new Set(plan.actions.map(action => action.recordId));
  if (peers.some(other => other.ontologyFormation?.actions.some(action => touched.has(action.recordId))))
    return ['ontology_pending_change_conflict'];
  const reasons: string[] = [];
  for (const action of plan.actions) {
    const current = action.intent === 'create' ? undefined : doc.records[action.recordId];
    if (current && statuses.get(current.id) !== 'allowed') reasons.push('ontology_target_source_unavailable');
    if (current?.kind === 'rule' && current.source.refs?.some(ref => ref.kind === 'asset'
      && (candidate.proposalTarget === 'ontology' || ref.id !== candidate.targetAssetId))) reasons.push('ontology_bound_cognition_requires_joint_change');
    const proposed = plan.previewChanges.find(row => row.after.id === action.recordId)?.after;
    if (action.intent !== 'create' || !proposed) continue;
    const related = Object.values(doc.records).filter(record => record.status === 'active' && record.kind === proposed.kind
      && record.kind !== 'module' && proposed.kind !== 'module' && record.moduleId === proposed.moduleId && record.access === proposed.access);
    if (related.some(record => statuses.get(record.id) === 'unavailable')) return ['ontology_source_comparison_unavailable'];
    const pool = related.filter(record => statuses.get(record.id) === 'allowed');
    if (proposed.kind === 'entity' && pool.some(record => record.kind === 'entity' && record.typeId === proposed.typeId
      && [record.name, ...record.aliases].some(name => [proposed.name, ...proposed.aliases].includes(name))))
      reasons.push('ontology_identity_requires_comparison');
    if (proposed.kind === 'assertion' && pool.some(record => record.kind === 'assertion' && record.subjectId === proposed.subjectId
      && record.definitionId === proposed.definitionId && JSON.stringify(record.object) === JSON.stringify(proposed.object)))
      reasons.push('ontology_existing_fact_requires_comparison');
    if (proposed.kind === 'rule' && pool.length) {
      const text = (record: OntologyRecord) => record.kind === 'rule'
        ? JSON.stringify({ requirement: record.requirement, strength: record.strength, condition: record.condition, exception: record.exception }) : '';
      const { findSemanticDuplicate, embedForDedup } = await import('./similarity');
      const entries = pool.map(record => ({ id: record.id, text: text(record) }));
      for (const entry of entries) if (!await embedForDedup(userId, entry.text)) return ['ontology_semantic_comparison_unavailable'];
      const result = await findSemanticDuplicate(userId, { text: text(proposed), candidateTexts: [], assetTexts: entries });
      if (result.status === 'degraded') reasons.push('ontology_semantic_comparison_unavailable');
      if (result.status === 'match' || (result.status === 'no_match' && result.related)) reasons.push('ontology_existing_rule_requires_comparison');
    }
  }
  return [...new Set(reasons)];
}
