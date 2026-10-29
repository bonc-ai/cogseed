import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(), applied: vi.fn(), listUsage: vi.fn(),
}));
vi.mock('../../../../src/main/features/recall/asset-usage-receipt', () => ({
  listAssetUsageReceipts: mocks.list,
  listAppliedUsageReceipts: mocks.applied,
}));
vi.mock('../../../../src/main/features/recall/usage-service', () => ({ listRecallUsage: mocks.listUsage }));

beforeEach(() => vi.clearAllMocks());

describe('asset catalog adoption stats', () => {
  it('reads the receipt stream once and lets listAppliedUsageReceipts apply the sole adoption verdict to preloaded rows', async () => {
    const receipts = [
      { id: 'r1', assetId: 'aa-one', assetVersion: '1', taskRunId: 'task-1', status: 'applied', boundary: 'real', createdAt: '2026-10-01T00:00:00Z', evidenceRefs: [] },
      { id: 'r2', assetId: 'aa-one', assetVersion: '1', taskRunId: 'task-1', status: 'contradicted', boundary: 'real', createdAt: '2026-10-02T00:00:00Z', evidenceRefs: [] },
    ];
    mocks.list.mockResolvedValue(receipts);
    mocks.applied.mockImplementation(async (_userId: string, _query: unknown, preloaded: unknown[]) => preloaded === receipts
      ? [receipts[0]] : []);
    const { loadAssetAdoptionStats } = await import('../../../../src/main/features/recall/asset-catalog');

    const stats = await loadAssetAdoptionStats('catalog-user');

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.applied).toHaveBeenCalledWith('catalog-user', { taskRunIds: ['task-1'] }, receipts);
    expect(stats.get('aa-one')).toMatchObject({ appliedCount: 1, contradictedCount: 1 });
  });
});
