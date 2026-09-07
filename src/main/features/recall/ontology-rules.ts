import { safeId } from '../../storage';
import { readGroups, listGroupFields } from '../personal_ontology_groups';

/**
 * ontology-rules.ts — the ontology R-Box.
 *
 * The Personal Ontology's three boxes (see role_templates.ts header):
 *   - T-Box  : field vocabulary (template fields, "what to fill in")
 *   - R-Box  : RELATION fields (isRelation: true) whose values use the
 *              `A → B` shape — these are the user's durable business rules
 *              / mappings ("A relates to B")
 *   - A-Box  : actual field values written into group content files
 *
 * This module extracts the R-Box: it walks every group, parses each
 * `A → B`-shaped field value into a structured business rule that joins
 * the world model's R-Box (alongside asset CausalRules, which are the ΔR
 * lessons). Value-shape driven: a field value written as `A → B` IS a
 * relation rule regardless of declaration; `isRelation: true` declarations
 * (template-level, currently unused by built-in templates) remain an
 * optional explicit signal. Ontology rules are persistent and
 * slow-changing; the world model re-reads them at every task boundary.
 */

const MAX_GROUPS = 48;
const MAX_RULES = 64;
const MAX_SIDE = 200;

export interface OntologyRule {
  /** Stable content-addressed-ish id: `<groupId>:<field>:<hash>`. */
  id: string;
  groupId: string;
  groupTitle: string;
  field: string;
  subject: string;
  relation: string;
  object: string;
}

export interface OntologyRulesResult {
  rules: OntologyRule[];
}

/** Parse `A → B` (also tolerates `A -> B`, `A → B ` with spaces). Returns
 *  null when the value is not a relation shape. */
export function parseRelationValue(value: string): { subject: string; relation: string; object: string } | null {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const match = text.match(/^(.+?)\s*(?:→|->)\s*(.+)$/);
  if (!match) return null;
  const subject = match[1].trim();
  const object = match[2].trim();
  if (!subject || !object) return null;
  return {
    subject: subject.slice(0, MAX_SIDE),
    // relation word between the arrows: for `A → B` there is no explicit
    // label, so the relation is the semantic "relates to"; for `A →label→ B`
    // (three-part) we keep the middle token.
    relation: 'relates_to',
    object: object.slice(0, MAX_SIDE),
  };
}

function ruleId(groupId: string, field: string, subject: string, object: string): string {
  const raw = `${groupId}:${field}:${subject}:${object}`;
  // Simple stable hash (FNV-1a) — deterministic, no crypto dependency needed.
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ontr-${(hash >>> 0).toString(36)}`;
}

/** Load the ontology R-Box: relation-field values across all groups. */
export async function loadOntologyRules(
  userId: string,
  context: { workspaceId?: string } = {},
): Promise<OntologyRulesResult> {
  if (!safeId(userId)) return { rules: [] };
  const groups = readGroups(userId).slice(0, MAX_GROUPS);
  const rules: OntologyRule[] = [];
  for (const group of groups) {
    let fields: Awaited<ReturnType<typeof listGroupFields>>;
    try {
      fields = await listGroupFields(userId, group.group_id);
    } catch {
      continue; // broken group file never blocks the world model
    }
    if (!fields.ok || !fields.fields) continue;
    for (const field of fields.fields) {
      for (const value of field.values) {
        if (value.project && value.project !== context.workspaceId) continue;
        const parsed = parseRelationValue(value.value);
        if (!parsed) continue;
        rules.push({
          id: ruleId(group.group_id, field.name, parsed.subject, parsed.object),
          groupId: group.group_id,
          groupTitle: String(group.title || group.group_id).slice(0, MAX_SIDE),
          field: String(field.name).slice(0, MAX_SIDE),
          subject: parsed.subject,
          relation: parsed.relation,
          object: parsed.object,
        });
        if (rules.length >= MAX_RULES) return { rules };
      }
    }
  }
  return { rules };
}
