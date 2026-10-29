import type { OntologyRecord } from './model';

/** Reuse the ontology dependency closure, excluding inaccessible dependencies.
 * A unit with a missing dependency cannot be sent as a partial record. */
export function ontologyDependencyClosure(records: Record<string, OntologyRecord>, ids: string[]): OntologyRecord[] | undefined {
  const selected = new Map<string, OntologyRecord>();
  const keys = new Set(['moduleId', 'typeId', 'subjectId', 'definitionId', 'targetModuleId', 'targetRecordId', 'subjectTypes', 'objectTypes', 'entityId']);
  let missing = false;
  const add = (id: string) => {
    if (selected.has(id)) return;
    const record = records[id]; if (!record) { missing = true; return; }
    selected.set(id, record);
    const visit = (value: unknown, key = '') => {
      if (typeof value === 'string' && keys.has(key)) add(value);
      else if (Array.isArray(value)) value.forEach(child => visit(child, key));
      else if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        if (object.kind === 'entity' && typeof object.id === 'string') add(object.id);
        if (object.kind === 'task' && object.field === 'entityId' && typeof object.equals === 'string') add(object.equals);
        Object.entries(object).filter(([k]) => k !== 'source').forEach(([k, v]) => visit(v, k));
      }
    }; visit(record);
  };
  ids.forEach(add);
  return missing ? undefined : [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}
