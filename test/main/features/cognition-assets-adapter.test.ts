import { beforeEach, describe, expect, it, vi } from 'vitest';

// 资产列表不派生已退役的候选与复用计数，也不读取或迁移 skill 草稿。
// 返回值保留渲染消费的字段，不恢复已删除的空字段与计数字段。

const { listCognitionCandidates, listCognitionReuseReceipts, readInstalledSkillForAsset, readRecallSkillDraft } = vi.hoisted(() => ({
  listCognitionCandidates: vi.fn(),
  listCognitionReuseReceipts: vi.fn(),
  readInstalledSkillForAsset: vi.fn(),
  readRecallSkillDraft: vi.fn(),
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: (scope: string) => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/main/features/cognition/candidates-adapter', () => ({
  listCognitionCandidates,
}));

vi.mock('../../../src/main/features/cognition/receipts-adapter', () => ({
  listCognitionReuseReceipts,
}));

vi.mock('../../../src/main/features/recall/skill-draft-service', () => ({
  readInstalledSkillForAsset,
  readRecallSkillDraft,
}));

vi.mock('../../../src/main/features/recall/formal-assets', () => ({
  // 一条 rule + 一条 skill_method：skill_method 是原读盘副作用的触发面。
  listFormalAssets: vi.fn(async () => [
    { record: {
      id: 'CA-RULE', type: 'rule', title: '回归用规则资产', statement: 'statement',
      version: 1, status: 'active', maturity: 'seed', ownerId: 'uRegress', scope: 'project',
      lifecycleStatus: 'user_confirmed', candidateId: 'cand-rule', evidenceRefs: [],
    } },
    { record: {
      id: 'CA-SKILL', type: 'skill_method', title: '回归用技能资产', statement: 'statement',
      version: 2, status: 'active', maturity: 'seed', ownerId: 'uRegress', scope: 'project',
      lifecycleStatus: 'user_confirmed', candidateId: 'cand-skill', evidenceRefs: [],
    } },
  ]),
}));

beforeEach(() => {
  listCognitionCandidates.mockClear();
  listCognitionReuseReceipts.mockClear();
  readInstalledSkillForAsset.mockClear();
  readRecallSkillDraft.mockClear();
});

describe('cognition assets-adapter 死代码真删后的形状', () => {
  it('列表不再做候选池/回执关联读，也不触发 skill 草稿读盘', async () => {
    const { listCognitionAssets } = await import('../../../src/main/features/cognition/assets-adapter');

    const assets = await listCognitionAssets('uRegress');

    expect(assets).toHaveLength(2);
    expect(listCognitionCandidates).not.toHaveBeenCalled();
    expect(listCognitionReuseReceipts).not.toHaveBeenCalled();
    expect(readInstalledSkillForAsset).not.toHaveBeenCalled();
    expect(readRecallSkillDraft).not.toHaveBeenCalled();
  });

  it('输出形状不含已删字段，保留渲染消费的 7 个基础字段面', async () => {
    const { listCognitionAssets } = await import('../../../src/main/features/cognition/assets-adapter');

    const assets = await listCognitionAssets('uRegress');
    const rule = assets.find((asset) => asset.id === 'CA-RULE')!;

    for (const removed of [
      'lifecycleStatus', 'candidateCount', 'reuseCount', 'lastReusedAt',
      'workspaceRefs', 'receiptRefs', 'baselineSkillRef',
      'generatedSkillId', 'recallSkillDraftStatus', 'recallSkillDraftErrorCode', 'recallSkillDraft',
    ]) {
      expect(rule).not.toHaveProperty(removed);
    }
    // 渲染层唯一消费方（conversation-info.js 认知资产段）在用的字段面保持不变。
    expect(rule).toMatchObject({
      id: 'CA-RULE', type: 'rule', category: 'rule', title: '回归用规则资产',
      summary: 'statement', source: 'recall_ability_asset', candidateRefs: ['cand-rule'],
    });
    expect(Array.isArray(rule.relationRefs)).toBe(true);
  });
});
