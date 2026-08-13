/**
 * Canonical KSTAR dispatch metadata selected before a delegated Agent turn.
 *
 * This contract belongs to the active KSTAR task lifecycle. It may be bound to
 * a generic wake request so an approved dispatch resumes with the same expected
 * result, but it is not a legacy Engine snapshot or Compat Review record.
 */
export interface KStarExpectation {
  k_snapshot_ref?: string;
  situation?: string;
  task?: string;
  action_hat?: string;
  result_hat?: string;
}

export interface KStarDecisionRecord {
  required: boolean;
  reason: string;
  expectation: KStarExpectation;
  source?: 'commander';
  commander_mode?: 'required' | 'skip';
}
