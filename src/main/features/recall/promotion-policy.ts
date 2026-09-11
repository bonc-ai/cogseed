import type { RecallCandidateRecord } from './candidate-service';

export type PromotionPolicyAction = 'promote' | 'hold' | 'pause';

export interface PromotionPolicyDecision {
  action: PromotionPolicyAction;
  reason: string;
}

export function evaluatePromotionPolicy(candidate: Pick<RecallCandidateRecord, 'risk' | 'validationCount' | 'consecutiveFailures' | 'status'>): PromotionPolicyDecision {
  if ((candidate.consecutiveFailures || 0) >= 3) return { action: 'pause', reason: 'three consecutive validation failures' };
  if (candidate.risk === 'high') return { action: 'hold', reason: 'high-risk candidate requires user confirmation' };
  if (candidate.status === 'confirmed' || (candidate.validationCount || 0) >= 1) return { action: 'promote', reason: 'candidate meets automatic promotion policy' };
  return { action: 'hold', reason: 'candidate has not established validation evidence' };
}
