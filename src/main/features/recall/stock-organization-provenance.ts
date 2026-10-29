/** Host-issued provenance for organization of stored content. A saved baseline
 * is evidence of what was recorded, not a new grant to read its original source. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readRecallJsonRecord } from './store';
import { isCognitionSourceEnabled } from './source-control';
import { withCognitionTransition } from '../cognition_bridge';
import { readOntologyDocument } from '../cognition/ontology/service';
import type { OntologyFormationPlan } from './ontology-formation';
import type { RecallCandidateRecord, SaveRecallCandidateInput } from './candidate-service';
import type { StockOrganizationJob } from './stock-organization';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const schema = z.object({ kind: z.literal('stock_organization'), schemaVersion: z.literal(1),
  ownerId: id, jobId: id, unitKey: id, policyVersion: z.literal(1),
  assetId: id.optional(), headVersion: z.string().optional(), activeVersion: z.string().optional(),
  originalSourceUnrecorded: z.boolean(), checkedAt: z.string().datetime(),
}).strict();
export interface StockOrganizationProvenance {
  kind: 'stock_organization'; schemaVersion: 1; ownerId: string; jobId: string; unitKey: string; policyVersion: 1;
  assetId?: string; headVersion?: string; activeVersion?: string; originalSourceUnrecorded: boolean; checkedAt: string;
}
const permits = new AsyncLocalStorage<{ userId: string; input: SaveRecallCandidateInput; active: boolean }>();
export function normalizeStockOrganizationProvenance(value: unknown): StockOrganizationProvenance | undefined {
  return value === undefined ? undefined : schema.parse(value) as StockOrganizationProvenance;
}
export async function withStockOrganizationWrite<T>(userId: string, input: SaveRecallCandidateInput, work: () => Promise<T>): Promise<T> {
  const permit = { userId, input, active: true };
  try { return await permits.run(permit, work); } finally { permit.active = false; }
}
export async function verifyStockOrganizationCandidate(userId: string, input: SaveRecallCandidateInput | RecallCandidateRecord,
  options: { newWrite?: boolean; committed?: boolean } = {}): Promise<StockOrganizationProvenance> {
  const proof = normalizeStockOrganizationProvenance(input.stockOrganizationProvenance);
  if (!proof || proof.ownerId !== userId || input.captureProvenance || input.humanInstructionProvenance || input.manual
    || input.learningSignal || input.learningProvenance) throw new Error('invalid stock organization provenance');
  const job = await readRecallJsonRecord(userId, 'stock-organization', proof.jobId) as StockOrganizationJob | null;
  if (!job?.prepared || !isDeepStrictEqual(job.prepared.stockOrganizationProvenance, proof)
    || input.captureKey !== job.prepared.captureKey || input.targetAssetId !== job.prepared.targetAssetId
    || input.targetVersionUsed !== job.prepared.targetVersionUsed || input.proposalTarget !== job.prepared.proposalTarget
    || input.suggestedAction !== job.prepared.suggestedAction || input.suggestedType !== job.prepared.suggestedType
    || input.suggestedScope !== job.prepared.suggestedScope || !isDeepStrictEqual(input.scopePolicy, job.prepared.scopePolicy)
    || !isDeepStrictEqual(input.sourceRefs, job.prepared.sourceRefs) || !isDeepStrictEqual(input.evidenceRefs, job.prepared.evidenceRefs))
    throw Object.assign(new Error('stock organization contract changed'), { code: 'stock_organization_baseline_changed' });
  if (options.newWrite) {
    const permit = permits.getStore();
    if (!permit?.active || permit.userId !== userId || !isDeepStrictEqual(permit.input, input))
      throw new Error('stock organization write requires host preparation');
  }
  if ('ownerId' in input && (input.ownerId !== userId || input.id !== job.candidateId))
    throw new Error('stock organization candidate identity mismatch');
  for (const ref of [...input.sourceRefs, ...(input.evidenceRefs || [])]) {
    if (!await isCognitionSourceEnabled(userId, ref as import('./source-service').CognitionSourceRef))
      throw Object.assign(new Error('stock organization source unavailable'), { code: 'stock_organization_baseline_changed' });
  }
  if (!options.committed) {
    const { assertStockOrganizationBaseline } = await import('./stock-organization');
    await assertStockOrganizationBaseline(userId, job.unit);
  } else if (!('status' in input) || !['confirmed', 'integrated'].includes(input.status)) {
    throw new Error('stock organization has no committed result');
  }
  return proof;
}

/** This permit exists only while the confirmation holds the cognition transition
 * lock. It authorizes the checked plan, not a caller-selected document revision. */
const confirmations = new AsyncLocalStorage<{
  userId: string; plan: OntologyFormationPlan; revision: number; active: boolean;
}>();
export async function withStockOrganizationConfirmation<T>(userId: string, candidate: RecallCandidateRecord,
  work: () => Promise<T>): Promise<T> {
  if (!candidate.stockOrganizationProvenance || !candidate.ontologyFormation) return work();
  return withCognitionTransition(userId, async () => {
    await verifyStockOrganizationCandidate(userId, candidate);
    const job = await readRecallJsonRecord(userId, 'stock-organization', candidate.stockOrganizationProvenance!.jobId) as StockOrganizationJob | null;
    const { bindOntologyFormationPlan, normalizeOntologyFormationPlan } = await import('./ontology-formation');
    const prepared = job?.prepared;
    const expectedPlan = prepared?.ontologyFormation && normalizeOntologyFormationPlan(userId, candidate.id,
      bindOntologyFormationPlan(candidate.id, prepared.ontologyFormation));
    const plan = normalizeOntologyFormationPlan(userId, candidate.id, candidate.ontologyFormation)!;
    if (!expectedPlan || !isDeepStrictEqual(plan, expectedPlan)
      || ['judgment', 'summary', 'value', 'evidenceSummary', 'applicableWhen', 'forbiddenWhen'].some(field =>
        !isDeepStrictEqual(candidate[field as keyof RecallCandidateRecord], prepared![field as keyof SaveRecallCandidateInput])))
      throw Object.assign(new Error('stock organization reviewed proposal changed'), { code: 'stock_organization_baseline_changed' });
    const context = { userId, plan, revision: readOntologyDocument(userId).revision, active: true };
    try { return await confirmations.run(context, work); } finally { context.active = false; }
  });
}
/** Called from the fresh authoritative draft, before any ontology action. */
export function checkedStockOrganizationRevision(userId: string, plan: OntologyFormationPlan, revision: number): number | undefined {
  const context = confirmations.getStore();
  return context?.active && context.userId === userId && context.revision === revision && isDeepStrictEqual(context.plan, plan)
    ? context.revision : undefined;
}
