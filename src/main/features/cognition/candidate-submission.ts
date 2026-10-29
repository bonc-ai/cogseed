/** 类型是生产者建议；候选保存不把建议转换为确定的内容归属。 */
import { saveRecallCandidate, type SaveRecallCandidateInput, type RecallCandidateRecord } from '../recall/candidate-service';
import { isKstarCognitionSource } from './integration-boundary';
export async function submitCognitionCandidate(userId: string, input: SaveRecallCandidateInput): Promise<RecallCandidateRecord> {
  if (isKstarCognitionSource(input)) throw new Error('KSTAR cognition integration isolated');
  return saveRecallCandidate(userId, input);
}
