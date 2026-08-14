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
    expect(isAssetScopeAllowed({ projectIds: ['project-x'] }, { workspaceId: 'project-x' })).toBe(true);
    expect(isAssetScopeAllowed({ projectIds: ['project-x'] }, { workspaceId: 'project-y' })).toBe(false);
  });

  it('enforces conversationKinds fail-closed when the kind is unknown', () => {
    const policy = { conversationKinds: ['normal'] };
    expect(isAssetScopeAllowed(policy, { conversationKind: 'normal' })).toBe(true);
    expect(isAssetScopeAllowed(policy, { conversationKind: 'gconv' })).toBe(false);
    expect(isAssetScopeAllowed(policy, {})).toBe(false);
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
});
