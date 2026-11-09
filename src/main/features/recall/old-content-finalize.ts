/** Two-phase candidate finalization: old assets first, then the new suggestion.
 * The phases are durable but intentionally not one transaction. */
import { promoteRecallCandidate, readRecallCandidate, type RecallCandidateRecord } from './candidate-service';
import { executeOldContentPlan, readOldContentPlan, reconcileOldContentExecution,
  recordOldContentFinalization, type OldContentUnitResult } from './old-content-plan-service';
import type { OldContentPlanRecord } from './old-content-plan-contract';
import type { RecallCandidatePromotionResult } from './candidate-service';

export type OldContentFinalizeMode = 'old_then_new' | 'old_only' | 'new_only';
export interface OldContentFinalizeOptions {
  forceCreateSimilar?: boolean;
  riskAcknowledged?: boolean;
  confirmBaselineVersion?: string;
}
export interface OldContentFinalizeResult {
  ok: boolean;
  phase: 'old_committed' | 'new_saved' | 'new_failed' | 'old_failed' | 'skipped';
  candidate: RecallCandidateRecord;
  plan?: OldContentPlanRecord;
  promotion?: RecallCandidatePromotionResult;
  unitResults?: OldContentUnitResult[];
  error?: { code: string; message: string; versionConflict?: unknown };
}
export class OldContentFinalizeError extends Error {
  constructor(public readonly result: OldContentFinalizeResult) {
    super(result.error?.message || 'old-content finalize failed');
    this.name = 'OldContentFinalizeError';
  }
}
function errorDetail(error: unknown): { code: string; message: string; versionConflict?: unknown } {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  const conflict = error && typeof error === 'object' && 'versionConflict' in error
    ? (error as { versionConflict?: unknown }).versionConflict : undefined;
  return { code: code || 'old_content_finalize_failed',
    message: error instanceof Error ? error.message : String(error),
    ...(conflict !== undefined ? { versionConflict: conflict } : {}) };
}
function resultCandidate(userId: string, candidateId: string): Promise<RecallCandidateRecord> {
  return readRecallCandidate(userId, candidateId);
}
/** Execute the plan phase, then promote the candidate. A new-content failure
 * leaves the old plan applied and the candidate reviewable. */
export async function finalizeCandidate(userId: string, candidateId: string,
  mode: OldContentFinalizeMode = 'old_then_new',
  options: OldContentFinalizeOptions = {}): Promise<OldContentFinalizeResult> {
  const candidate = await readRecallCandidate(userId, candidateId);
  const retryNewOnly = mode === 'new_only' && candidate.status === 'failed';
  if (!['pending_review', 'deferred'].includes(candidate.status) && !retryNewOnly)
    throw new Error('candidate is not finalizable');
  if (candidate.proposalTarget === 'ontology') {
    throw Object.assign(new Error('ontology candidate must be confirmed through promote, not old-content finalize'), {
      code: 'invalid_candidate_route',
    });
  }
  const planId = candidate.oldContentPlanId;
  let plan = planId ? await readOldContentPlan(userId, planId) : undefined;
  // A crash during the previous save leaves the plan `executing`; recover from
  // its fingerprints before deciding that the save must stay blocked.
  if (plan?.status === 'executing' && plan.prepared) {
    plan = await reconcileOldContentExecution(userId, plan.id).catch(() => plan);
  }
  if (mode === 'new_only' && plan?.status === 'ready')
    throw new Error('old-content plan must be committed before saving the new suggestion');
  if (mode !== 'new_only' && plan && ['needs_review', 'blocked', 'executing'].includes(plan.status)) {
    throw new OldContentFinalizeError({ ok: false, phase: 'old_failed',
      candidate: await resultCandidate(userId, candidateId), plan,
      error: { code: `plan_${plan.status}`, message: 'old-content plan is not ready' } });
  }
  if (mode !== 'new_only' && plan?.status === 'ready') {
    try {
      const executed = await executeOldContentPlan(userId, plan.id, { candidateId });
      const failed = executed.results.filter(result => result.status === 'failed');
      if (failed.length) {
        const detail = { code: failed[0].code || 'old_content_unit_failed',
          message: failed.map(result => `${result.unitId}: ${result.code || 'failed'}`).join('; ') };
        if (plan) await recordOldContentFinalization(userId, plan.id, candidateId, 'old_failed', { errorCode: detail.code });
        throw new OldContentFinalizeError({ ok: false, phase: 'old_failed',
          candidate: await resultCandidate(userId, candidateId), plan: executed.plan,
          unitResults: executed.results, error: detail });
      }
      if (!executed.execution) throw new Error('old-content execution produced no receipt');
      plan = executed.plan;
      await recordOldContentFinalization(userId, plan.id, candidateId, 'old_committed',
        { executionId: executed.execution.executionId });
    } catch (error) {
      if (error instanceof OldContentFinalizeError) throw error;
      const detail = errorDetail(error);
      if (plan) await recordOldContentFinalization(userId, plan.id, candidateId, 'old_failed', { errorCode: detail.code });
      const result = { ok: false, phase: 'old_failed' as const, candidate: await resultCandidate(userId, candidateId),
        ...(plan ? { plan: await readOldContentPlan(userId, plan.id) } : {}), error: detail };
      throw new OldContentFinalizeError(result);
    }
  }
  if (mode === 'old_only') {
    return { ok: true, phase: plan?.status === 'applied' ? 'old_committed' : 'skipped',
      candidate: await resultCandidate(userId, candidateId), ...(plan ? { plan } : {}) };
  }
  try {
    const promotion = await promoteRecallCandidate(userId, candidateId, { actor: 'user',
      ...(options.forceCreateSimilar ? { forceCreateSimilar: true } : {}),
      ...(options.riskAcknowledged ? { riskAcknowledged: true } : {}),
      ...(options.confirmBaselineVersion ? { confirmBaselineVersion: options.confirmBaselineVersion } : {}) });
    if (plan && plan.status === 'applied')
      plan = await recordOldContentFinalization(userId, plan.id, candidateId, 'new_saved',
        { newDecisionId: promotion.candidate.reviewDecisionId });
    return { ok: true, phase: 'new_saved', candidate: await resultCandidate(userId, candidateId),
      ...(plan ? { plan } : {}), promotion };
  } catch (error) {
    const detail = errorDetail(error);
    if (plan) plan = await recordOldContentFinalization(userId, plan.id, candidateId, 'new_failed', { errorCode: detail.code });
    const result = { ok: false, phase: 'new_failed' as const, candidate: await resultCandidate(userId, candidateId),
      ...(plan ? { plan } : {}), error: detail };
    throw new OldContentFinalizeError(result);
  }
}
