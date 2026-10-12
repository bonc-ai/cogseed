/**
 * How a skill trust verdict should be read.
 *
 * WHY THIS IS A LEAF MODULE
 * `skill_trust.ts` owns the receipts and `skill_reverify.ts` owns the report that
 * produces their decision; importing one from the other closes a cycle. The
 * alternative — spelling the same judgement out at each call site — is not
 * hypothetical: two surfaces read the same 59 receipts and disagreed, because
 * only one of them knew that a `risk` decision can be driven entirely by
 * declaration hygiene. One predicate, one home.
 *
 * ZERO DEPENDENCIES on purpose (same shape as `skill_id.ts`): importable from
 * features, IPC and tests without pulling storage or the report pipeline in.
 */

/** The receipt fields these judgements read. Structural, so callers need not import the type. */
export interface VerdictFields {
  decision?: string;
  topRule?: string;
  topLevel?: string;
}

/**
 * Authoring-completeness rule families, which describe declaration quality rather
 * than safety.
 *
 * The shape rules require standard artifacts of every skill ("declare `use_when`",
 * "add an output contract", "declare a staged ceiling"). They fire at MEDIUM
 * across nearly the whole existing library — measured on a real profile, 59 of 60
 * receipts recorded `risk` and **every one** was driven by these families while
 * the deep scanner scored the same skills 100/100:
 *
 *   57 × `shape_staged_ceiling_missing`
 *    1 × `frontmatter_name_invalid`
 *    1 × `frontmatter_description_too_long`
 *    1 × a skill whose eight violations were `frontmatter_extension_field` ×3,
 *        `frontmatter_description_too_long`, `skill_meta_category_missing`,
 *        `skill_meta_routing_incomplete` and two shape rules
 *
 * Not one security finding among them. A missing contract is a real authoring gap
 * and the quality report lists it in full, but it is not a reason to tell the user
 * a skill is a security risk.
 *
 * Listed as completeness families rather than "everything that is not a security
 * rule" on purpose: a future security rule must never be swallowed into
 * "convention" by default. A new completeness family lands as a visible false
 * risk instead — noisy, but not silent.
 */
const COMPLETENESS_RULE_PREFIXES = ['shape_', 'frontmatter_', 'skill_meta_', 'agent_'];

/** Convention (`true`) vs substantive (`false`) rule, by rule id. */
export function isConventionRule(rule: string): boolean {
  const id = String(rule || '');
  return COMPLETENESS_RULE_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Whether a receipt's verdict is worth showing as a **security** risk.
 *
 * `decision: 'risk'` means "the scan recorded at least one violation of any
 * level", which includes the declaration nits above. `topLevel` is the height of
 * the finding that produced the verdict and `topRule` names it, so the pair is
 * enough to tell a security verdict from a bookkeeping one — and both are
 * persisted, so this needs no rescan.
 *
 * A receipt written before `topLevel` existed carries no level and is treated as
 * not notable rather than assumed severe; the next rescan fills it in. Consumers
 * must still show the raw decision somewhere: this predicate decides *emphasis*,
 * never whether the user may see the finding.
 */
export function securityNotableOf(receipt: VerdictFields): boolean {
  if (receipt.decision !== 'risk') return false;
  if (isConventionRule(receipt.topRule || '')) return false;
  return receipt.topLevel === 'EXTREME' || receipt.topLevel === 'MEDIUM';
}
