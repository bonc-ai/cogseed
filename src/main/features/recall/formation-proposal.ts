/** Versioned extraction envelopes. An ontology-only proposal has a change
 * explanation, never a synthetic cognition body; materialization is separate. */
import { z } from 'zod';
import { formationComparisonSchema } from './formation-comparison';

const text = (limit: number) => z.string().min(1).max(limit).refine(value => Boolean(value.trim()));
const labels = z.array(text(160)).min(1).max(100);
const boundaries = z.array(text(500)).max(32).optional();
const cognition = z.object({
  judgment: text(4000), value: text(1000), summary: text(1000),
  contentCategory: z.string().max(100).optional(),
  suggestedScope: text(500),
  suggestedAction: z.enum(['create', 'update', 'limit_scope', 'pause', 'keep_current', 'reject']),
  risk: z.enum(['low', 'medium', 'high']), evidence: labels,
  targetAssetId: z.string().regex(/^[A-Za-z0-9_-]+$/).max(160).optional(),
  applicableWhen: boundaries, forbiddenWhen: boundaries, uncertainty: text(1000).optional(),
  comparison: formationComparisonSchema.optional(),
}).strict();
const explanation = z.object({
  description: text(4000), value: text(1000), summary: text(1000),
  suggestedScope: text(500), risk: z.enum(['low', 'medium', 'high']), evidence: labels,
  applicableWhen: boundaries, forbiddenWhen: boundaries, uncertainty: text(1000).optional(),
}).strict();
// Full action/identity/version validation belongs to ontology-formation. This
// envelope establishes ownership and evidence before that canonical validation.
const ontologyChanges = z.object({
  reason: text(2000), evidence: labels, actions: z.array(z.unknown()).max(50),
  refs: z.array(z.unknown()).max(100).optional(),
  identityEvidence: z.array(z.unknown()).max(50).optional(),
}).strict();
const id = z.string().regex(/^[A-Za-z0-9_-]+$/).min(1).max(64);
const proposal = z.discriminatedUnion('target', [
  z.object({ id, target: z.literal('cognition'), cognition }).strict(),
  z.object({ id, target: z.literal('ontology'), explanation,
    ontologyChanges: ontologyChanges.refine(value => value.actions.length > 0, 'ontology-only proposal requires a change') }).strict(),
  z.object({ id, target: z.literal('joint'), cognition,
    ontologyChanges: ontologyChanges.refine(value => value.actions.length > 0 || Boolean(value.refs?.length), 'joint proposal requires ontology changes or references') }).strict(),
]);
// The shell keeps the batch contract hard: exact version, a bounded proposals
// array and no stray top-level fields. Proposal bodies are validated
// individually so one malformed group cannot void its valid siblings.
const envelopeShell = z.object({
  proposalVersion: z.literal(2), proposals: z.array(z.unknown()).max(64), reason: text(1000).optional(),
}).strict();

export type FormationProposal = z.infer<typeof proposal>;

export interface FormationProposalEnvelopeResult {
  /** Proposals that passed their own schema and evidence checks. */
  proposals: FormationProposal[];
  /** Raw proposal count the model emitted, including dropped ones. */
  emittedCount: number;
  /** Reason the model may attach to an explicitly empty extraction. */
  reason?: string;
  /** First per-proposal violation as a schema path plus issue code (or a
   * fixed check phrase). Never carries model or user text. */
  firstDroppedReason?: string;
}

/** No legacy top-level plan can be guessed into this versioned protocol.
 * Each proposal is an independently decidable group; dependencies inside one
 * group are committed together. Cross-group dependencies are unsupported and
 * rejected as unknown fields instead of silently losing their atomicity.
 *
 * A single malformed proposal is dropped while its valid siblings survive,
 * mirroring the legacy per-candidate tolerance; identity (duplicate ids) and
 * dependency (ontology evidence ownership) checks stay batch-level and still
 * reject the whole envelope. */
export function parseFormationProposalEnvelope(raw: unknown, validLabels: ReadonlySet<string>): FormationProposalEnvelopeResult {
  const parsed = envelopeShell.parse(raw);
  const proposals: FormationProposal[] = [];
  const ids = new Set<string>();
  let firstDroppedReason: string | undefined;
  const drop = (reason: string) => { firstDroppedReason ??= reason; };
  for (const item of parsed.proposals) {
    const checked = proposal.safeParse(item);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      drop(`proposal schema ${issue.path.map(part => String(part)).join('.') || 'root'} ${issue.code}`);
      continue;
    }
    const value = checked.data;
    const content = value.target === 'ontology' ? value.explanation : value.cognition;
    if (content.evidence.some(label => !validLabels.has(label))) { drop('unknown formation evidence label'); continue; }
    if (ids.has(value.id)) throw new Error('duplicate formation proposal id');
    ids.add(value.id);
    if (value.target !== 'cognition') {
      const evidence = new Set(content.evidence);
      if (value.ontologyChanges.evidence.some(label => !evidence.has(label))) throw new Error('ontology evidence must belong to its proposal');
    }
    proposals.push(value);
  }
  return { proposals, emittedCount: parsed.proposals.length,
    ...(parsed.reason ? { reason: parsed.reason } : {}),
    ...(firstDroppedReason ? { firstDroppedReason } : {}) };
}
