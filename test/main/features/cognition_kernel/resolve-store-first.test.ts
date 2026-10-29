/** 统一读适配的库优先遮蔽：同槽旧值让位，空库保留原读取行为。 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const fixtures = vi.hoisted(() => {
  const state: { storeObjects: Record<string, unknown> } = { storeObjects: {} };
  return {
    state,
    doc: {
      schemaVersion: 2,
      groups: [
        {
          id: 'g1',
          title: '身份',
          kind: 'user',
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-01T00:00:00Z',
          fields: [
            { id: 'f1', name: '银行卡号', origin: 'user', createdAt: '2026-09-01T00:00:00Z' },
            { id: 'f2', name: '部门', origin: 'user', createdAt: '2026-09-01T00:00:00Z' },
          ],
          values: [
            { id: 'v1', fieldId: 'f1', text: '旧卡号-陈旧值', source: 'manual', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
            { id: 'v2', fieldId: 'f2', text: '开源项目组', source: 'manual', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
          ],
          entries: [],
        },
      ],
      trash: [],
    },
  };
});

vi.mock('../../../../src/main/features/po/store', () => ({
  loadPoDocSync: () => fixtures.doc,
}));
vi.mock('../../../../src/main/features/recall/asset-service', () => ({
  listAbilityAssets: async () => [],
}));
vi.mock('../../../../src/main/features/recall/prompt-injection', () => ({
  filterRecallAssetsForAgentRead: async () => [],
}));
vi.mock('../../../../src/main/features/cognition_kernel/store', () => ({
  loadCognitionStoreSync: () => ({
    schemaVersion: 1,
    objects: fixtures.state.storeObjects,
    homes: [],
    appliedDeltas: {},
    appliedOrder: [],
    updatedAt: '2026-10-02T00:00:00Z',
  }),
}));

beforeEach(() => {
  fixtures.state.storeObjects = {};
});

function snapshotMod() {
  return import('../../../../src/main/features/cognition_kernel/resolve');
}

describe('resolve 统一读：库优先遮蔽', () => {
  it('库空（未迁移）→ 旧账行为不变', async () => {
    const { loadPersonalSourceSnapshot } = await snapshotMod();
    const snap = await loadPersonalSourceSnapshot('u1');
    expect(snap.values.map((v) => v.text)).toEqual(['旧卡号-陈旧值', '开源项目组']);
  });

  it('库内同槽断言遮蔽旧值；无组断言按字段名遮蔽；无关旧值保留', async () => {
    fixtures.state.storeObjects = {
      'co-bank': {
        id: 'co-bank', kind: 'assertion', home: 'personal_fact', title: '银行卡号', statement: '6222-库内新值',
        origin: 'import', status: 'active', version: 2, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
        groupId: 'g1', fieldName: '银行卡号',
      },
      'co-city': {
        id: 'co-city', kind: 'assertion', home: 'personal_fact', title: '城市', statement: '北京',
        origin: 'user', status: 'active', version: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
        fieldName: '城市',
      },
    };
    const { loadPersonalSourceSnapshot } = await snapshotMod();
    const snap = await loadPersonalSourceSnapshot('u1');
    const texts = snap.values.map((v) => v.text);
    expect(texts).toContain('6222-库内新值');
    expect(texts).toContain('北京');
    expect(texts).toContain('开源项目组'); // 无冲突旧值保留
    expect(texts).not.toContain('旧卡号-陈旧值'); // 被同槽库值遮蔽
  });

  it('deleted 库对象不参与遮蔽', async () => {
    fixtures.state.storeObjects = {
      'co-bank': {
        id: 'co-bank', kind: 'assertion', home: 'personal_fact', title: '银行卡号', statement: '已删',
        origin: 'import', status: 'deleted', deletedAt: '2026-10-01T00:00:00Z', version: 2,
        createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', groupId: 'g1', fieldName: '银行卡号',
      },
    };
    const { loadPersonalSourceSnapshot } = await snapshotMod();
    const snap = await loadPersonalSourceSnapshot('u1');
    expect(snap.values.map((v) => v.text)).toContain('旧卡号-陈旧值');
  });

  it('paused/archived 断言占槽不供值（旧值不复活），restricted 随 active 值透传', async () => {
    // 统一库状态过滤：paused/archived 收回这条值，
    // 但槽位已归统一库——迁移前的旧值不能趁机复活；只有 deleted 释放槽位。
    fixtures.state.storeObjects = {
      'co-paused': {
        id: 'co-paused', kind: 'assertion', home: 'personal_fact', title: '银行卡号', statement: '已暂停值',
        origin: 'import', status: 'paused', version: 2, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
        groupId: 'g1', fieldName: '银行卡号',
      },
      'co-archived': {
        id: 'co-archived', kind: 'assertion', home: 'personal_fact', title: '部门', statement: '已归档值',
        origin: 'import', status: 'archived', version: 3, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
        groupId: 'g1', fieldName: '部门',
      },
      'co-restricted': {
        id: 'co-restricted', kind: 'assertion', home: 'personal_fact', title: '城市', statement: '北京',
        origin: 'user', status: 'active', restricted: true, version: 1,
        createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', fieldName: '城市',
      },
    };
    const { loadPersonalSourceSnapshot } = await snapshotMod();
    const snap = await loadPersonalSourceSnapshot('u1');
    const texts = snap.values.map((v) => v.text);
    // paused/archived 不供值，且被它们占住的槽不让旧值复活。
    expect(texts).not.toContain('已暂停值');
    expect(texts).not.toContain('已归档值');
    expect(texts).not.toContain('旧卡号-陈旧值');
    expect(texts).not.toContain('开源项目组');
    // active 值正常进场，治理标记随值透传。
    const restricted = snap.values.find((v) => v.text === '北京');
    expect(restricted).toMatchObject({ restricted: true });
  });
});
