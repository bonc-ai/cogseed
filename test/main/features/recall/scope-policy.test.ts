import { describe, expect, it } from 'vitest';
import { isAssetScopeAllowed } from '../../../../src/main/features/recall/scope-policy';

describe('recall scope policy gate', () => {
  it('allows everything when no policy is present', () => {
    expect(isAssetScopeAllowed(undefined, {})).toBe(true);
  });

  it('matches purposeTags against the projection purpose', () => {
    const policy = { purposeTags: ['review'] };
    expect(isAssetScopeAllowed(policy, { purpose: 'Review OAuth callback' })).toBe(true);
    expect(isAssetScopeAllowed(policy, { purpose: 'Plan database migration' })).toBe(false);
  });

  it('requires a workspace when workspaceIds or projectIds restrict', () => {
    expect(isAssetScopeAllowed({ workspaceIds: ['workspace-a'] }, { workspaceId: 'workspace-a' })).toBe(true);
    expect(isAssetScopeAllowed({ workspaceIds: ['workspace-a'] }, { workspaceId: 'workspace-b' })).toBe(false);
    expect(isAssetScopeAllowed({ workspaceIds: ['workspace-a'] }, {})).toBe(false);
    expect(isAssetScopeAllowed({ projectIds: ['project-x'] }, { projectId: 'project-x' })).toBe(true);
    expect(isAssetScopeAllowed({ projectIds: ['project-x'] }, { projectId: 'project-y' })).toBe(false);
  });

  it('enforces conversationKinds fail-closed when the kind is unknown', () => {
    const policy = { conversationKinds: ['normal'] };
    expect(isAssetScopeAllowed(policy, { conversationKind: 'normal' })).toBe(true);
    expect(isAssetScopeAllowed(policy, { conversationKind: 'gconv' })).toBe(false);
    expect(isAssetScopeAllowed(policy, {})).toBe(false);
  });

  it('matches scope tokens as whole words only (shared with asset.scope)', () => {
    const policy = { purposeTags: ['review'] };
    expect(isAssetScopeAllowed(policy, { purpose: 'Use frozen OAuth review knowledge' })).toBe(true);
    expect(isAssetScopeAllowed(policy, { purpose: 'reviewing the callback flow' })).toBe(false);
    expect(isAssetScopeAllowed(policy, { purpose: 'Research plan' })).toBe(false);
    expect(isAssetScopeAllowed(policy, { purpose: '做 review 检查' })).toBe(true);
  });

  it('fails closed when a restricted conversation kind is unknown', () => {
    const policy = { conversationKinds: ['normal'] };
    expect(isAssetScopeAllowed(policy, { conversationKind: 'normal' })).toBe(true);
    expect(isAssetScopeAllowed(policy, { conversationKind: 'gconv' })).toBe(false);
    expect(isAssetScopeAllowed(policy, {})).toBe(false);
  });

  it('enforces agent, role, project and file dimensions with fail-closed semantics', () => {
    const policy = {
      agentIds: ['agent-a'],
      roleIds: ['reviewer'],
      projectIds: ['project-a'],
      fileKinds: ['pdf', 'docx'],
    };
    expect(isAssetScopeAllowed(policy, {
      agentId: 'agent-a', roleId: 'reviewer', projectId: 'project-a', fileKinds: ['pdf'],
    })).toBe(true);
    expect(isAssetScopeAllowed(policy, {
      agentId: 'agent-a', roleId: 'reviewer', projectId: 'project-a', fileKinds: ['pdf', 'image'],
    })).toBe(false);
    expect(isAssetScopeAllowed(policy, {
      agentId: 'agent-a', projectId: 'project-a', fileKinds: ['pdf'],
    })).toBe(false);
  });

  it('combines dimensions with AND semantics', () => {
    const policy = { purposeTags: ['review'], workspaceIds: ['workspace-a'], conversationKinds: ['normal'] };
    expect(isAssetScopeAllowed(policy, {
      purpose: 'Review', workspaceId: 'workspace-a', conversationKind: 'normal',
    })).toBe(true);
    expect(isAssetScopeAllowed(policy, {
      purpose: 'Review', workspaceId: 'workspace-b', conversationKind: 'normal',
    })).toBe(false);
    expect(isAssetScopeAllowed(policy, {
      purpose: 'Build', workspaceId: 'workspace-a', conversationKind: 'normal',
    })).toBe(false);
  });

  it('treats empty projection allowlists as deny-all at runtime', () => {
    const context = {
      purpose: 'Review',
      workspaceId: 'workspace-a',
      conversationKind: 'normal',
    };
    for (const field of ['purposeTags', 'workspaceIds', 'projectIds', 'conversationKinds'] as const) {
      expect(isAssetScopeAllowed({ [field]: [] }, context)).toBe(false);
    }
    expect(isAssetScopeAllowed(
      { conversationKinds: [] },
      {},
    )).toBe(false);
  });
});

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
