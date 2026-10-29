import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  scan: vi.fn(), readAsset: vi.fn(), filter: vi.fn(), snapshot: vi.fn(),
}));
vi.mock('../../../../src/main/features/recall/context-projection', () => ({
  listContextProjections: mocks.scan,
}));
vi.mock('../../../../src/main/features/recall/asset-service', () => ({
  readAbilityAsset: mocks.readAsset,
  abilityAssetActiveVersion: (asset: { activeVersion?: string; version?: string }) => asset.activeVersion || asset.version,
  listAbilityAssets: async () => [],
}));
vi.mock('../../../../src/main/features/recall/catalog-engine', () => ({
  catalogSnapshot: mocks.snapshot,
  filterCatalogAssetsForAgentRead: mocks.filter,
  catalogRankedForTurn: () => new Map(),
  resetCatalogEngineForTest: () => {},
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
  mocks.scan.mockReset().mockResolvedValue([{
    authorization: 'model_selected', conversationId: 'other-conversation',
    assetIds: ['aa-1'], decidedAt: '2026-10-19T00:00:00Z',
  }]);
  mocks.readAsset.mockReset().mockResolvedValue({ id: 'aa-1', title: '会议纪要模板', status: 'active', version: '1' });
  mocks.filter.mockReset().mockImplementation(async (_userId: string, assets: unknown[]) => assets);
  mocks.snapshot.mockReset().mockResolvedValue({
    userId: 'user', cid: 'cid', turnId: '', at: Date.now(), assets: [], ranked: [], byId: new Map(),
    matches: new Map(), stars: new Set(), adoption: new Map(),
  });
});
afterEach(() => vi.useRealTimers());

describe('catalog hint projection cache', () => {
  it('scans cross-conversation projections once per TTL but rechecks asset admission on every call', async () => {
    const hint = await import('../../../../src/main/features/recall/asset-catalog-hint');
    hint.resetAssetCatalogHintCacheForTest();

    expect(await hint.assetCatalogForPrompt('user', 'cid')).toContain('Recently attached in another conversation');
    expect(await hint.assetCatalogForPrompt('user', 'cid')).toContain('Recently attached in another conversation');
    expect(mocks.scan).toHaveBeenCalledTimes(1);
    // The TTL only covers the directory scan; authorization still runs per call.
    expect(mocks.filter).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-10-20T10:00:31Z'));
    await hint.assetCatalogForPrompt('user', 'cid');
    expect(mocks.scan).toHaveBeenCalledTimes(2);
  });
});
