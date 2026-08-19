import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listFormalAssets: vi.fn(),
  listRecallCandidates: vi.fn(),
  listCognitionSources: vi.fn(),
  readInstalledSkillForAsset: vi.fn(),
}));

vi.mock('../../../../src/main/features/recall/formal-assets', () => ({
  listFormalAssets: mocks.listFormalAssets,
}));
vi.mock('../../../../src/main/features/recall/candidate-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/features/recall/candidate-service')>()),
  listRecallCandidates: mocks.listRecallCandidates,
}));
vi.mock('../../../../src/main/features/recall/source-catalog', () => ({
  listCognitionSources: mocks.listCognitionSources,
}));
vi.mock('../../../../src/main/features/recall/skill-draft-service', () => ({
  readInstalledSkillForAsset: mocks.readInstalledSkillForAsset,
}));

import { listCognitionInbox } from '../../../../src/main/features/cognition/inbox-adapter';

function skillAsset() {
  return {
    assetId: 'asset-skill',
    assetType: 'skill_method' as const,
    owner: 'user-1',
    version: '1',
    lifecycleStatus: 'user_confirmed_unverified' as const,
    maturity: 'bud' as const,
    status: 'active' as const,
    title: '需求评审方法',
    statement: '先确认目标，再拆分需求。',
    scope: 'product',
    evidenceRefs: [],
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    payload: { kind: 'skill_method' as const },
    record: {} as any,
  };
}

describe('cognition inbox adapter', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.listFormalAssets.mockResolvedValue([skillAsset()]);
    mocks.listRecallCandidates.mockResolvedValue([]);
    mocks.listCognitionSources.mockResolvedValue([]);
  });

  it('does not suggest creating a Skill when installed-state lookup fails', async () => {
    mocks.readInstalledSkillForAsset.mockRejectedValue(new Error('draft store unavailable'));

    await expect(listCognitionInbox('user-1')).resolves.toEqual([]);
  });
});
