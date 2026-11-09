/** Compatibility adapter for the former candidate-embedded execution rail.
 * New writes use the independent plan service; this keeps the existing IPC name
 * available while the renderer moves to plan ids. */
import { readRecallCandidate } from './candidate-service';
import { executeOldContentPlan, oldContentPlanProjection, readOldContentPlan } from './old-content-plan-service';
import type { OldContentReceipt } from './formation-old-content';

export async function confirmOldContentPlan(userId: string, candidateId: string): Promise<{
  candidate: Awaited<ReturnType<typeof readRecallCandidate>>; receipt: OldContentReceipt; duplicate?: true;
}> {
  const candidate = await readRecallCandidate(userId, candidateId);
  if (!candidate.oldContentPlanId) throw new Error('old-content plan is not linked to this candidate');
  const result = await executeOldContentPlan(userId, candidate.oldContentPlanId, { candidateId });
  const failed = result.results.find(row => row.status === 'failed');
  if (failed) throw new Error(failed.code || `old-content unit failed: ${failed.unitId}`);
  const projection = oldContentPlanProjection(await readOldContentPlan(userId, candidate.oldContentPlanId));
  if (!projection.oldContentReceipt) throw new Error('old-content receipt unavailable');
  return { candidate: await readRecallCandidate(userId, candidateId), receipt: projection.oldContentReceipt,
    ...(result.duplicate ? { duplicate: true as const } : {}) };
}
