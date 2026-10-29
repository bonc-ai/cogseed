/** Read compatibility for historical automatic review receipts. No execution or approval policy. */
export interface AutomaticCandidateReview {
  policyVersion: 1;
  eligible: boolean;
  reasons: string[];
  checkedAt: string;
  policyEpoch?: string;
}
