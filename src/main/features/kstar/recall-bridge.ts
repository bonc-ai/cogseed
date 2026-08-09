import {
  saveRecallCandidate,
  type RecallCandidateRecord,
} from '../recall/candidate-service';
import type { KstarCandidateProposal } from './types';

/** Save proposals into Recall's pending review queue. Promotion is intentionally not part of this bridge. */
export async function saveKstarCandidateProposals(
  userId: string,
  proposals: KstarCandidateProposal[],
): Promise<RecallCandidateRecord[]> {
  const candidates: RecallCandidateRecord[] = [];
  for (const proposal of proposals.slice(0, 3)) {
    candidates.push(await saveRecallCandidate(userId, {
      judgment: proposal.judgment,
      ...(proposal.summary ? { summary: proposal.summary } : {}),
      ...(proposal.uncertainty ? { uncertainty: proposal.uncertainty } : {}),
      suggestedType: proposal.suggestedType,
      suggestedScope: proposal.suggestedScope,
      sourceRefs: proposal.sourceRefs,
      ...(proposal.learningSignal ? { learningSignal: proposal.learningSignal } : {}),
    }));
  }
  return candidates;
}
