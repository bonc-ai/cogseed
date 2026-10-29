import { describe, it, expect } from 'vitest';

import { resolveFromSnapshot } from '../../../../src/main/features/cognition_kernel/resolve';
import type { PersonalSourceSnapshot } from '../../../../src/main/features/cognition_kernel/types';

const snapshot: PersonalSourceSnapshot = {
  values: [
    { id: 'v1', groupId: 'g1', fieldId: 'f1', fieldName: '姓名', text: '示例用户甲', source: 'manual', updatedAt: '2026-09-01T00:00:00Z' },
    { id: 'v2', groupId: 'g1', fieldId: 'f2', fieldName: '银行卡号', text: '陈旧的投影副本', source: 'candidate', updatedAt: '2026-09-01T00:00:00Z', assetId: 'a1' },
    { id: 'v3', groupId: 'g1', fieldId: 'f3', fieldName: '身份证号', text: '110101', source: 'manual', updatedAt: '2026-09-01T00:00:00Z', restricted: true },
    { id: 'v4', groupId: 'g1', fieldId: 'f4', fieldName: '部门', text: '旧部门', source: 'manual', updatedAt: '2026-08-01T00:00:00Z' },
    { id: 'v5', groupId: 'g1', fieldId: 'f4', fieldName: '部门', text: '新部门', source: 'manual', updatedAt: '2026-09-30T00:00:00Z' },
    { id: 'v6', groupId: 'g1', fieldId: 'f5', fieldName: '离职日期', text: 'x', source: 'manual', updatedAt: '2026-09-01T00:00:00Z', assetId: 'gone' },
  ],
  assets: [
    { id: 'a1', title: '银行卡', statement: '6217-live', version: '3', status: 'active', updatedAt: '2026-09-20T00:00:00Z', ontologyRefs: [], eligible: true },
    { id: 'a2', title: '审批人', statement: '示例审批人', version: '1', status: 'paused', updatedAt: '2026-09-10T00:00:00Z', ontologyRefs: [{ groupId: 'g1', field: '审批人' }], eligible: false },
    { id: 'a3', title: '英文名', statement: 'ExampleUserA', version: '2', status: 'active', updatedAt: '2026-09-11T00:00:00Z', ontologyRefs: [{ groupId: 'g1', field: '英文名' }], eligible: true },
  ],
};

function one(fieldName: string, required?: boolean) {
  return resolveFromSnapshot({ fields: [{ fieldName, ...(required === undefined ? {} : { required }) }] }, snapshot);
}

describe('cognition_kernel/resolve — 统一读接口（纯函数核心）', () => {
  it('本体手编值 → 直接取到，带来源 id', () => {
    const r = one('姓名');
    expect(r.bound).toHaveLength(1);
    expect(r.bound[0]).toMatchObject({ value: '示例用户甲', source: 'ontology_value', sourceId: 'v1' });
    expect(r.missing).toHaveLength(0);
  });

  it('引用态的值取来源资产的 live 正文，而不是副本', () => {
    const r = one('银行卡号');
    expect(r.bound[0]).toMatchObject({ value: '6217-live', source: 'personal_asset', sourceId: 'a1', version: '3' });
  });

  it('标了"仅自己可见"的值不进任务读取', () => {
    const r = one('身份证号');
    expect(r.missing[0]).toMatchObject({ fieldName: '身份证号', reason: 'restricted' });
  });

  it('同一字段多条可用值 → 取最新并标矛盾', () => {
    const r = one('部门');
    expect(r.bound[0].value).toBe('新部门');
    expect(r.bound[0].disputed).toBe(true);
    expect(r.bound[0].conflictsWith).toEqual(['旧部门']);
  });

  it('本体值指向已不存在的来源资产 → stale（要修引用）', () => {
    const r = one('离职日期');
    expect(r.missing[0]).toMatchObject({ reason: 'stale' });
  });

  it('资产显式声明了落点但被暂停 → not_authorized（先治理）', () => {
    const r = one('审批人');
    expect(r.missing[0]).toMatchObject({ reason: 'not_authorized' });
  });

  it('本体没有、资产显式声明了落点 → 取资产', () => {
    const r = one('英文名');
    expect(r.bound[0]).toMatchObject({ value: 'ExampleUserA', source: 'personal_asset', sourceId: 'a3', version: '2' });
  });

  it('档案里根本没有 → no_value（对应"该提问并回填"）', () => {
    const r = one('开户行');
    expect(r.missing[0]).toMatchObject({ fieldName: '开户行', reason: 'no_value', required: true });
  });

  it('required:false 仍如实报缺，但标记为非必需', () => {
    const r = one('开户行', false);
    expect(r.missing[0].required).toBe(false);
  });

  it('空请求返回空结果，不抛错', () => {
    const r = resolveFromSnapshot({ fields: [] }, snapshot);
    expect(r.bound).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.policyVersion).toBe('kernel-1');
  });
});
