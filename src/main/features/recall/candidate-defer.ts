import { safeId } from '../../storage';
import { readRecallCandidate, withRecallCandidatePromotionLock, type RecallCandidateRecord } from './candidate-service';
import { getRecallCandidateCapabilities, RecallCandidateStateError, RECALL_CANDIDATE_TERMINAL_ERROR_CODE } from './candidate-capabilities';
import { updateRecallJsonRecord } from './store';

/** “稍后”只标记处理顺序，不改变生命周期或把建议移出需要关注。 */
export async function deferRecallCandidate(userId: string, candidateId: string): Promise<RecallCandidateRecord> {
  if (!safeId(candidateId)) throw new Error('invalid recall candidate id');
  return withRecallCandidatePromotionLock(userId, async () => {
    await updateRecallJsonRecord(userId, 'candidates', candidateId, (current) => {
      if (!current) throw new Error('recall candidate not found');
      const candidate = current as RecallCandidateRecord;
      if (!getRecallCandidateCapabilities(candidate).canReject) {
        throw new RecallCandidateStateError(RECALL_CANDIDATE_TERMINAL_ERROR_CODE, 'recall candidate is terminal', candidate.status);
      }
      // 重复点击幂等；不更改来源时间或触发旧 deferred 静音迁移。
      if (typeof current.activityDeferredAt === 'string') return current;
      const at = new Date().toISOString();
      return { ...current, activityDeferredAt: at, updatedAt: at };
    });
    return readRecallCandidate(userId, candidateId);
  });
}
