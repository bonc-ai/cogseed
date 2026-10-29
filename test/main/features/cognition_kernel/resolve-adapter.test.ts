import { describe, it, expect, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  doc: {
    schemaVersion: 2,
    groups: [
      {
        id: 'g1',
        title: '身份与角色',
        kind: 'user',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
        fields: [
          { id: 'f1', name: '姓名', origin: 'user', createdAt: '2026-09-01T00:00:00Z' },
          { id: 'f2', name: '银行卡号', origin: 'user', createdAt: '2026-09-01T00:00:00Z' },
        ],
        values: [
          { id: 'v1', fieldId: 'f1', text: '示例用户甲', source: 'manual', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
          { id: 'v2', fieldId: 'f2', text: '陈旧的投影副本', source: 'candidate', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', assetId: 'a1' },
        ],
        entries: [],
      },
    ],
    trash: [],
  },
  assets: [
    { id: 'a1', type: 'personal', title: '银行卡', statement: '6217-live', version: '3', status: 'active', updatedAt: '2026-09-20T00:00:00Z', ontologyRefs: [] },
    { id: 'a2', type: 'personal', title: '审批人', statement: '示例审批人', version: '1', status: 'paused', updatedAt: '2026-09-10T00:00:00Z', ontologyRefs: [{ groupId: 'g1', field: '审批人' }] },
    { id: 'r1', type: 'rule', title: '不该被当作个人字段', statement: '规则', version: '1', status: 'active', updatedAt: '2026-09-10T00:00:00Z', ontologyRefs: [{ groupId: 'g1', field: '审批人' }] },
  ],
}));

vi.mock('../../../../src/main/features/po/store', () => ({
  loadPoDocSync: () => fixtures.doc,
}));
vi.mock('../../../../src/main/features/recall/asset-service', () => ({
  listAbilityAssets: async () => fixtures.assets,
}));
vi.mock('../../../../src/main/features/recall/prompt-injection', () => ({
  filterRecallAssetsForAgentRead: async (_uid: string, assets: Array<{ status: string }>) =>
    assets.filter((a) => a.status === 'active'),
}));

import { resolvePersonalFields } from '../../../../src/main/features/cognition_kernel/resolve';

describe('cognition_kernel/resolve — 装配层（对真实数据形状）', () => {
  it('一次调用同时返回：本体值 / 资产 live 值 / 缺值原因', async () => {
    const r = await resolvePersonalFields('u1', {
      fields: [
        { fieldName: '姓名' },
        { fieldName: '银行卡号' },
        { fieldName: '审批人' },
        { fieldName: '开户行' },
      ],
    });

    expect(r.bound.map((f) => [f.fieldName, f.value, f.source])).toEqual([
      ['姓名', '示例用户甲', 'ontology_value'],
      ['银行卡号', '6217-live', 'personal_asset'],
    ]);
    expect(r.missing.map((f) => [f.fieldName, f.reason])).toEqual([
      ['审批人', 'not_authorized'],
      ['开户行', 'no_value'],
    ]);
    expect(r.policyVersion).toBe('kernel-1');
  });

  it('只把 personal 类型资产当作个人字段来源（rule/template 不参与）', async () => {
    const r = await resolvePersonalFields('u1', { fields: [{ fieldName: '审批人' }] });
    expect(r.bound).toHaveLength(0);
  });
});
