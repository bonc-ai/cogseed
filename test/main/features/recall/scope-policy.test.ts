import { describe, expect, it } from 'vitest';

import {
  normalizeAbilityAssetScopePolicy,
} from '../../../../src/main/features/recall/scope-policy';

describe('作用域白名单的三态', () => {
  it('缺失 = 没有限制', () => {
    expect(normalizeAbilityAssetScopePolicy(undefined)).toBeUndefined();
    // 整个 policy 对象存在但没写 agentIds，也算这一项没设限。
    expect(normalizeAbilityAssetScopePolicy({ purposeTags: ['review'] }))
      .toEqual({ purposeTags: ['review'] });
  });

  it('空数组 = 明确一个都不允许，不许塌成「没有限制」', () => {
    // 这是权限语义：塌了之后过滤方只能二选一，放行会外发本该拦死的资产，
    // 拦死会让所有没设限的资产一起失效。
    expect(normalizeAbilityAssetScopePolicy({ agentIds: [] })).toEqual({ agentIds: [] });
    const policy = normalizeAbilityAssetScopePolicy({ agentIds: [], purposeTags: ['review'] });
    expect(policy!.agentIds).toEqual([]);
    expect(policy!.agentIds).not.toBeUndefined();
  });

  it('非空 = 只允许列出的这些', () => {
    expect(normalizeAbilityAssetScopePolicy({ agentIds: ['ag-a', 'ag-b'] }))
      .toEqual({ agentIds: ['ag-a', 'ag-b'] });
  });

  it('三态在同一个 policy 里可以并存，互不干扰', () => {
    const policy = normalizeAbilityAssetScopePolicy({
      agentIds: [],
      roleIds: ['role-a'],
    })!;
    expect(policy.agentIds).toEqual([]);       // 一个 Agent 都不给
    expect(policy.roleIds).toEqual(['role-a']); // 只给这个角色
    expect(policy.projectIds).toBeUndefined();  // 不限项目
  });

  it('每个白名单字段都适用同一套三态，不只 agentIds', () => {
    for (const field of ['purposeTags', 'roleIds', 'projectIds', 'workspaceIds', 'conversationKinds', 'fileKinds']) {
      const policy = normalizeAbilityAssetScopePolicy({ [field]: [] })!;
      expect(policy[field as keyof typeof policy]).toEqual([]);
    }
  });

  it('空 policy 对象仍然是 undefined——一个字段都没写就是没设过策略', () => {
    expect(normalizeAbilityAssetScopePolicy({})).toBeUndefined();
  });

  it('去重、去空白，越界与非法 id 一律拒绝', () => {
    expect(normalizeAbilityAssetScopePolicy({ agentIds: ['ag-a', '  ag-a  ', 'ag-b'] }))
      .toEqual({ agentIds: ['ag-a', 'ag-b'] });
    expect(() => normalizeAbilityAssetScopePolicy({ agentIds: ['../escape'] }))
      .toThrow('invalid ability asset scope policy agentIds');
    expect(() => normalizeAbilityAssetScopePolicy({ agentIds: Array.from({ length: 51 }, (_, i) => `ag-${i}`) }))
      .toThrow('invalid ability asset scope policy agentIds');
    expect(() => normalizeAbilityAssetScopePolicy({ unknownField: ['x'] }))
      .toThrow('invalid ability asset scope policy');
  });
});
