const MAX_RELATIONS = 64;
const MAX_DERIVED_FROM = 32;
const MAX_NOTE_LENGTH = 500;

export type AbilityAssetRelationKind =
  | 'refines'
  | 'depends_on'
  | 'replaces'
  | 'conflicts_with'
  | 'related_to';

export interface AbilityAssetRelation {
  kind: AbilityAssetRelationKind;
  assetId: string;
  note?: string;
}

export interface AbilityAssetRelationContract {
  relations?: AbilityAssetRelation[];
  /** Provenance only; the cognition tree does not project this field. */
  derivedFrom?: string[];
}

const RELATION_KINDS = new Set<AbilityAssetRelationKind>([
  'refines',
  'depends_on',
  'replaces',
  'conflicts_with',
  'related_to',
]);

function assetIdOrThrow(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`malformed ability asset ${field}`);
  const id = value.trim();
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`malformed ability asset ${field}`);
  return id;
}

function boundedNote(value: unknown): string | undefined {
  if (typeof value !== 'string') throw new Error('malformed ability asset relation note');
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  if (text.length > MAX_NOTE_LENGTH) throw new Error('ability asset relation note is too long');
  return text;
}

export function normalizeAbilityAssetRelations(
  value: unknown,
  selfAssetId?: string,
): AbilityAssetRelation[] {
  if (!Array.isArray(value)) throw new Error('malformed ability asset relations');
  if (value.length > MAX_RELATIONS) throw new Error('too many ability asset relations');

  const seen = new Set<string>();
  const relations: AbilityAssetRelation[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('malformed ability asset relation');
    }
    const entry = raw as Record<string, unknown>;
    if (!RELATION_KINDS.has(entry.kind as AbilityAssetRelationKind)) {
      throw new Error('malformed ability asset relation kind');
    }
    const kind = entry.kind as AbilityAssetRelationKind;
    const assetId = assetIdOrThrow(entry.assetId, 'relation asset id');
    if (selfAssetId && assetId === selfAssetId) throw new Error('ability asset cannot relate to itself');
    const note = entry.note === undefined ? undefined : boundedNote(entry.note);
    const key = `${kind}\0${assetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    relations.push({ kind, assetId, ...(note ? { note } : {}) });
  }
  return relations;
}

export function normalizeAbilityAssetDerivedFrom(
  value: unknown,
  selfAssetId?: string,
): string[] {
  if (!Array.isArray(value)) throw new Error('malformed ability asset derived from');
  if (value.length > MAX_DERIVED_FROM) throw new Error('too many ability asset derived from refs');
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const id = assetIdOrThrow(raw, 'derived from ref');
    if (selfAssetId && id === selfAssetId) throw new Error('ability asset cannot derive from itself');
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function readAbilityAssetRelationContract(
  value: Record<string, unknown>,
  selfAssetId?: string,
): AbilityAssetRelationContract {
  return {
    ...(value.relations === undefined
      ? {}
      : { relations: normalizeAbilityAssetRelations(value.relations, selfAssetId) }),
    ...(value.derivedFrom === undefined
      ? {}
      : { derivedFrom: normalizeAbilityAssetDerivedFrom(value.derivedFrom, selfAssetId) }),
  };
}
