import { readGroups, listGroupFields, type GroupMeta } from '../personal_ontology_groups';
import { safeId } from '../../storage';

/**
 * ontology-taxonomy.ts — the T-Box of the KSTAR world-model ontology.
 *
 * The world model is f(K,S,T) -> (A_hat, R_hat). K is split into three boxes:
 *   - T-Box  (this module): concept definitions — the Personal Ontology group
 *     ledger (groups.md) plus each group's field vocabulary. This is the
 *     stable terminology layer assets point at via `ontologyRefs`.
 *   - A-Box  (world-model.ts): world state snapshots + deterministic predicates.
 *   - R-Box  (world-model-types.ts CausalRule): cause→effect→mitigation rules.
 *
 * The taxonomy is loaded fresh at forecast time so the Commander's simulation
 * input always carries the user's current concept definitions, without the
 * potentially large field VALUES (those live in the group files and are read
 * on demand; K only needs the vocabulary).
 */

const MAX_GROUPS = 48;
const MAX_FIELDS_PER_GROUP = 64;
const MAX_FIELD_NAME = 200;

export interface OntologyTaxonomyField {
  name: string;
  /** True when the field is a relation column (person/place/…), not a value. */
  isRelation?: boolean;
  description?: string;
}

export interface OntologyTaxonomyGroup {
  groupId: string;
  title: string;
  templateId?: string;
  templateVersion?: string;
  fields: OntologyTaxonomyField[];
}

export interface OntologyTaxonomy {
  groups: OntologyTaxonomyGroup[];
}

export interface OntologyTaxonomyOptions {
  /** Cap guards against pathological ledgers; never needed in practice. */
  maxGroups?: number;
}

function compactMeta(group: GroupMeta): Omit<OntologyTaxonomyGroup, 'fields'> {
  return {
    groupId: group.group_id,
    title: String(group.title || group.group_id).slice(0, MAX_FIELD_NAME),
    ...(group.template_id ? { templateId: group.template_id } : {}),
    ...(group.template_version ? { templateVersion: group.template_version } : {}),
  };
}

async function fieldsForGroup(uid: string, groupId: string): Promise<OntologyTaxonomyField[]> {
  const result = await listGroupFields(uid, groupId);
  if (!result.ok || !result.fields) return [];
  return result.fields
    .slice(0, MAX_FIELDS_PER_GROUP)
    .map((field) => ({
      name: String(field.name || '').trim().slice(0, MAX_FIELD_NAME),
      ...(field.isRelation ? { isRelation: true } : {}),
      ...(field.description ? { description: String(field.description).slice(0, MAX_FIELD_NAME) } : {}),
    }))
    .filter((field) => Boolean(field.name));
}

/** Load the user's T-Box: group ledger + per-group field vocabulary. */
export async function loadOntologyTaxonomy(
  userId: string,
  options: OntologyTaxonomyOptions = {},
): Promise<OntologyTaxonomy> {
  if (!safeId(userId)) return { groups: [] };
  const maxGroups = options.maxGroups || MAX_GROUPS;
  const groups = readGroups(userId).slice(0, maxGroups);
  const resolved: OntologyTaxonomyGroup[] = [];
  for (const group of groups) {
    try {
      resolved.push({
        ...compactMeta(group),
        fields: await fieldsForGroup(userId, group.group_id),
      });
    } catch {
      // A broken group file must not break the whole forecast; the group
      // still appears with an empty vocabulary.
      resolved.push({ ...compactMeta(group), fields: [] });
    }
  }
  return { groups: resolved };
}

/** Lightweight synchronous existence check for a group id (validation gate). */
export function ontologyGroupExists(userId: string, groupId: string): boolean {
  if (!safeId(userId) || !safeId(groupId)) return false;
  try {
    return readGroups(userId).some((group) => group.group_id === groupId);
  } catch {
    return false;
  }
}

/** Lightweight groupId → title map for retrieval: lets the semantic match
 *  text carry the CONCEPT name (T-Box vocabulary) instead of a bare opaque
 *  group id, so assets pointed at an ontology group rank against queries
 *  that use the concept's natural-language name. */
export function loadOntologyGroupTitleMap(userId: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!safeId(userId)) return map;
  try {
    for (const group of readGroups(userId)) {
      map.set(group.group_id, String(group.title || group.group_id).trim());
    }
  } catch {
    // ledger unreadable → fall back to raw group ids (no match signal, but
    // retrieval must not fail because the ontology is temporarily broken)
  }
  return map;
}
