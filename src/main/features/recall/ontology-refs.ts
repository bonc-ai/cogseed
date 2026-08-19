export interface AbilityAssetOntologyRef {
  groupId: string;
  section?: string;
  field?: string;
}

export function normalizeAbilityAssetOntologyRefs(value: unknown): AbilityAssetOntologyRef[] {
  if (!Array.isArray(value)) throw new Error('malformed ability asset ontology refs');
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('malformed ability asset ontology ref');
    const ref = raw as Record<string, unknown>;
    if (typeof ref.groupId !== 'string' || !ref.groupId.trim()) throw new Error('malformed ability asset ontology ref');
    if (ref.section !== undefined && typeof ref.section !== 'string') throw new Error('malformed ability asset ontology ref');
    if (ref.field !== undefined && typeof ref.field !== 'string') throw new Error('malformed ability asset ontology ref');
    const groupId = ref.groupId.trim();
    const section = typeof ref.section === 'string' ? ref.section.trim() : '';
    const field = typeof ref.field === 'string' ? ref.field.trim() : '';
    return { groupId, ...(section ? { section } : {}), ...(field ? { field } : {}) };
  });
}
