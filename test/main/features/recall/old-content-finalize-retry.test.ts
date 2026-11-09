import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readRecallCandidate: vi.fn(),
  promoteRecallCandidate: vi.fn(),
  readOldContentPlan: vi.fn(),
  executeOldContentPlan: vi.fn(),
  reconcileOldContentExecution: vi.fn(),
  recordOldContentFinalization: vi.fn(),
}));

vi.mock('../../../../src/main/features/recall/candidate-service', () => ({
  readRecallCandidate: mocks.readRecallCandidate,
  promoteRecallCandidate: mocks.promoteRecallCandidate,
}));
vi.mock('../../../../src/main/features/recall/old-content-plan-service', () => ({
  executeOldContentPlan: mocks.executeOldContentPlan,
  readOldContentPlan: mocks.readOldContentPlan,
  reconcileOldContentExecution: mocks.reconcileOldContentExecution,
  recordOldContentFinalization: mocks.recordOldContentFinalization,
}));

import { finalizeCandidate } from '../../../../src/main/features/recall/old-content-finalize';

const userId = 'old-content-retry-user';
const baseCandidate = {
  id: 'cand-retry', status: 'failed', reviewDecisionId: 'rd-retry', proposalTarget: 'cognition',
  oldContentPlanId: 'plan-1', targetAssetId: 'asset-1',
};
const appliedPlan = { id: 'plan-1', status: 'applied' };

beforeEach(() => {
  mocks.readRecallCandidate.mockReset().mockResolvedValue({ ...baseCandidate });
  mocks.promoteRecallCandidate.mockReset().mockResolvedValue({
    candidate: { ...baseCandidate, status: 'confirmed', promotedAssetId: 'asset-1' },
    asset: { id: 'asset-1' },
  });
  mocks.readOldContentPlan.mockReset().mockResolvedValue({ ...appliedPlan });
  mocks.executeOldContentPlan.mockReset();
  mocks.reconcileOldContentExecution.mockReset();
  mocks.recordOldContentFinalization.mockReset().mockImplementation(async (_uid, _planId, _candidateId, status) => ({
    ...appliedPlan, finalization: { status },
  }));
});

describe('old-content finalize recovery', () => {
  it('retries only the new content for a failed candidate without re-running old content', async () => {
    const result = await finalizeCandidate(userId, 'cand-retry', 'new_only');
    expect(result).toMatchObject({ ok: true, phase: 'new_saved' });
    expect(mocks.executeOldContentPlan).not.toHaveBeenCalled();
    expect(mocks.promoteRecallCandidate).toHaveBeenCalledWith(userId, 'cand-retry', expect.objectContaining({
      actor: 'user',
    }));
    expect(mocks.recordOldContentFinalization).toHaveBeenCalledWith(
      userId, 'plan-1', 'cand-retry', 'new_saved', expect.any(Object),
    );
  });

  it('still rejects a failed candidate when the caller asks to redo old content', async () => {
    await expect(finalizeCandidate(userId, 'cand-retry', 'old_then_new'))
      .rejects.toThrow('candidate is not finalizable');
    expect(mocks.promoteRecallCandidate).not.toHaveBeenCalled();
  });

  it('rejects an ontology-only candidate with an old-content plan instead of routing it to assets', async () => {
    mocks.readRecallCandidate.mockResolvedValue({
      ...baseCandidate, status: 'pending_review', proposalTarget: 'ontology',
    });
    await expect(finalizeCandidate(userId, 'cand-retry', 'old_then_new'))
      .rejects.toMatchObject({ code: 'invalid_candidate_route' });
    expect(mocks.promoteRecallCandidate).not.toHaveBeenCalled();
    expect(mocks.executeOldContentPlan).not.toHaveBeenCalled();
  });
});
