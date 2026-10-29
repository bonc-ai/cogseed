import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listFormalAssets: vi.fn(),
  listRecallCandidates: vi.fn(),
  listCognitionSources: vi.fn(),
  readInstalledSkillForAsset: vi.fn(),
  readSkillBinding: vi.fn(),
  listAbilityAssetVersions: vi.fn(),
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
vi.mock('../../../../src/main/features/recall/skill-binding-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/features/recall/skill-binding-service')>()),
  readSkillBinding: mocks.readSkillBinding,
}));
vi.mock('../../../../src/main/features/recall/asset-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/features/recall/asset-service')>()),
  listAbilityAssetVersions: mocks.listAbilityAssetVersions,
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

/** 版本流记录夹具：两版正文不同 → latestAssetVersionDiff 产出 statement 类 diff。 */
function versionRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    ownerId: 'user-1',
    id: 'asset-skill-v1',
    assetId: 'asset-skill',
    version: '1',
    at: '2026-08-16T00:00:00.000Z',
    reason: 'edited',
    actor: 'system',
    snapshot: {
      title: '需求评审方法',
      statement: '先确认目标，再拆分需求。',
      type: 'skill_method',
      scope: 'product',
      status: 'active',
      maturity: 'bud',
    },
    ...overrides,
  };
}

describe('cognition inbox adapter', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.listFormalAssets.mockResolvedValue([skillAsset()]);
    mocks.listRecallCandidates.mockResolvedValue([]);
    mocks.listCognitionSources.mockResolvedValue([]);
    mocks.readSkillBinding.mockResolvedValue(undefined);
    mocks.listAbilityAssetVersions.mockResolvedValue([]);
  });

  it('does not suggest creating a Skill when installed-state lookup fails', async () => {
    mocks.readInstalledSkillForAsset.mockRejectedValue(new Error('draft store unavailable'));

    await expect(listCognitionInbox('user-1')).resolves.toEqual([]);
  });

  /**
   * binding 读取降级进 unknown 集（2026-10-01 质检 P-r1-13）：已生成 Skill 的
   * 方法在生成后又改过正文，binding 却读不到——追平/拒绝状态未知，不能反推成
   * 「待升版」。修复前 binding 降级只 log.warn、哪个集合都不进，已追平/已拒绝
   * 的升级以假待办复活。正对照组证明夹具真的会产出升版待办，抑制才是抑制。
   */
  it('does not revive an upgrade todo when the skill binding read degrades (P-r1-13)', async () => {
    mocks.readInstalledSkillForAsset.mockResolvedValue('skill-1');
    mocks.listAbilityAssetVersions.mockResolvedValue([
      versionRecord(),
      versionRecord({
        id: 'asset-skill-v2',
        version: '2',
        at: '2026-08-17T00:00:00.000Z',
        snapshot: {
          title: '需求评审方法',
          statement: '先确认目标，再拆分需求，再写验收标准。',
          type: 'skill_method',
          scope: 'product',
          status: 'active',
          maturity: 'bud',
        },
      }),
    ]);

    // 正对照：binding 读得到（undefined = 从未绑定）→ 方法改过就该报升版。
    mocks.readSkillBinding.mockResolvedValue(undefined);
    const control = await listCognitionInbox('user-1');
    expect(control.map((item) => item.kind)).toContain('skill_upgrade_suggested');

    // 修复组：binding 读失败 → unknown 集 → 不产升版待办（不放假警报）。
    mocks.readSkillBinding.mockRejectedValue(new Error('binding store unavailable'));
    const items = await listCognitionInbox('user-1');
    expect(items.map((item) => item.kind)).not.toContain('skill_upgrade_suggested');
  });
});
