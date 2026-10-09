import { safeId } from '../../storage';
import type { RecallCandidateAction } from '../recall/candidate-service';
import type { KstarCandidateProposal } from './types';

const MUTATING_ACTIONS = new Set<RecallCandidateAction>(['update', 'limit_scope', 'pause']);
const ACTIONS = new Set<RecallCandidateAction>(['create', 'update', 'limit_scope', 'pause', 'keep_current', 'reject']);

/**
 * KSTAR is allowed to describe an asset mutation, but it must not smuggle an
 * invalid or targetless mutation into Recall. Keeping this check at the
 * KSTAR/Recall boundary makes both precipitation paths obey the same contract.
 */
export function recallFieldsForKstarProposal(proposal: KstarCandidateProposal): {
  suggestedAction: RecallCandidateAction;
  targetAssetId?: string;
} {
  const suggestedAction = proposal.suggestedAction || 'create';
  if (!ACTIONS.has(suggestedAction)) throw new Error('invalid KSTAR candidate action');

  const targetAssetId = proposal.targetAssetId?.trim();
  if (MUTATING_ACTIONS.has(suggestedAction)) {
    if (!targetAssetId || !safeId(targetAssetId)) {
      throw new Error('KSTAR asset mutation requires a valid target asset');
    }
    return { suggestedAction, targetAssetId };
  }

  if (targetAssetId) throw new Error('KSTAR non-mutating action cannot target an asset');
  return { suggestedAction };
}
