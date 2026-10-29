/** Compare source visibility with the narrower module-only ontology task boundary. */
import type { OntologyDocument, OntologyRecord } from './model';
import { normalizeAbilityAssetScopePolicy, type RecallAbilityAssetScopePolicy } from '../../recall/scope-policy';
export function ontologyScopeViolations(doc: OntologyDocument, records: OntologyRecord[], input?: RecallAbilityAssetScopePolicy): string[] {
  const policy = normalizeAbilityAssetScopePolicy(input);
  if (!policy) return [];
  return records.filter(record => {
    const module = record.kind === 'module' ? record : doc.records[record.moduleId];
    if (record.status !== 'active' || module?.status !== 'active') return false;
    if (record.access === 'owner_only' || module?.access === 'owner_only') return false;
    if (!module || module.kind !== 'module') return true;
    if (Object.keys(policy).some(key => !['projectIds', 'workspaceIds'].includes(key))) return true;
    if (policy.projectIds !== undefined && (module.scope.kind !== 'project' || !policy.projectIds.includes(module.scope.id!))) return true;
    if (policy.workspaceIds !== undefined && (module.scope.kind !== 'workspace' || !policy.workspaceIds.includes(module.scope.id!))) return true;
    return false;
  }).map(record => `ontology_scope_exceeds_cognition:${record.id}`);
}
