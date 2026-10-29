import type { RecallCandidateRecord } from '../recall/candidate-service';
import type { KstarCandidateProposal } from './types';

/** Historical bridge compatibility. KSTAR proposals remain in KSTAR's task
 * records and cannot create Recall candidates, regardless of settings. */
export async function saveKstarCandidateProposals(
  _userId: string,
  _proposals: KstarCandidateProposal[],
  _options: { spaceId?: string } = {},
): Promise<RecallCandidateRecord[]> {
  return [];
}
