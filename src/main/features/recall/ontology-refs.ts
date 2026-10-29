export interface AbilityAssetOntologyRef {
  groupId: string;
  section?: string;
  field?: string;
  /** Canonical refs retain groupId as a compatibility alias of moduleId. */
  moduleId?: string;
  recordId?: string;
  versionPolicy?: 'current' | 'pinned';
  targetVersion?: number;
  sharedBody?: true;
}
export interface CanonicalAbilityAssetOntologyRef extends AbilityAssetOntologyRef {
  moduleId: string;
  recordId: string;
  versionPolicy: 'current' | 'pinned';
}

export function normalizeAbilityAssetOntologyRefs(value: unknown): AbilityAssetOntologyRef[] {
  if (!Array.isArray(value)) throw new Error('malformed ability asset ontology refs');
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('malformed ability asset ontology ref');
    const ref = raw as Record<string, unknown>;
    if (ref.moduleId !== undefined || ref.recordId !== undefined) {
      const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
        && !['__proto__', 'constructor', 'prototype'].includes(value);
      if (!validId(ref.moduleId) || !validId(ref.recordId)
        || (ref.groupId !== undefined && ref.groupId !== ref.moduleId)
        || !['current', 'pinned'].includes(String(ref.versionPolicy))
        || (ref.versionPolicy === 'pinned' && (!Number.isSafeInteger(ref.targetVersion) || Number(ref.targetVersion) < 1))
        || (ref.versionPolicy === 'current' && ref.targetVersion !== undefined)
        || (ref.sharedBody !== undefined && ref.sharedBody !== true)
        || (ref.sharedBody === true && ref.versionPolicy !== 'current')) throw new Error('malformed canonical ontology ref');
      return { groupId: ref.moduleId, moduleId: ref.moduleId, recordId: ref.recordId,
        versionPolicy: ref.versionPolicy as 'current' | 'pinned',
        ...(ref.targetVersion !== undefined ? { targetVersion: Number(ref.targetVersion) } : {}),
        ...(ref.sharedBody === true ? { sharedBody: true as const } : {}) };
    }
    if (typeof ref.groupId !== 'string' || !ref.groupId.trim()) throw new Error('malformed ability asset ontology ref');
    if (ref.section !== undefined && typeof ref.section !== 'string') throw new Error('malformed ability asset ontology ref');
    if (ref.field !== undefined && typeof ref.field !== 'string') throw new Error('malformed ability asset ontology ref');
    const groupId = ref.groupId.trim();
    const section = typeof ref.section === 'string' ? ref.section.trim() : '';
    const field = typeof ref.field === 'string' ? ref.field.trim() : '';
    return { groupId, ...(section ? { section } : {}), ...(field ? { field } : {}) };
  });
}
