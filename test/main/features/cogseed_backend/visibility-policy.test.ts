import { describe, expect, it } from 'vitest';

describe('cogseed_backend visibility policy', () => {
  it('allows same-user commander access to user, actor, task, and workflow scopes for non-sensitive items', async () => {
    const v = await import('../../../../src/main/features/cogseed_backend/visibility-policy');

    const principal = {
      userId: 'u-1',
      role: 'commander' as const,
      actorId: 'actor-commander',
      taskId: 'task-1',
      workflowId: 'flow-1',
    };

    expect(v.canSeeVisibility(principal, {
      ownerUserId: 'u-1',
      scope: { kind: 'user', userId: 'u-1' },
      kind: 'message',
    })).toBe(true);

    expect(v.canSeeVisibility(principal, {
      ownerUserId: 'u-1',
      scope: { kind: 'actor', actorId: 'actor-2' },
      kind: 'message',
      actorId: 'actor-2',
    })).toBe(true);

    expect(v.canSeeVisibility(principal, {
      ownerUserId: 'u-1',
      scope: { kind: 'task', taskId: 'task-1' },
      kind: 'message',
      taskId: 'task-1',
    })).toBe(true);

    expect(v.canSeeVisibility(principal, {
      ownerUserId: 'u-1',
      scope: { kind: 'workflow', workflowId: 'flow-1' },
      kind: 'message',
      workflowId: 'flow-1',
    })).toBe(true);
  });

  it('defaults secret, path, tool, artifact, gate, and conflict records to deny unless explicitly shared', async () => {
    const v = await import('../../../../src/main/features/cogseed_backend/visibility-policy');

    const principal = { userId: 'u-1', role: 'agent' as const, actorId: 'actor-a', taskId: 'task-a', workflowId: 'flow-a' };
    for (const kind of ['secret', 'path', 'tool', 'artifact', 'gate', 'conflict', 'tool.call', 'artifact.preview'] as const) {
      expect(v.canSeeVisibility(principal, {
        ownerUserId: 'u-1',
        scope: { kind: 'task', taskId: 'task-a' },
        kind,
      })).toBe(false);
    }

    expect(v.canSeeVisibility(principal, {
      ownerUserId: 'u-1',
      scope: { kind: 'task', taskId: 'task-a' },
      kind: 'tool',
      allowedRoles: ['agent'],
    })).toBe(true);
  });

  it('denies cross-user access even when the scope matches', async () => {
    const v = await import('../../../../src/main/features/cogseed_backend/visibility-policy');
    expect(v.canSeeVisibility({ userId: 'u-1', role: 'commander' }, {
      ownerUserId: 'u-2',
      scope: { kind: 'workflow', workflowId: 'flow-2' },
      kind: 'message',
    })).toBe(false);
  });

  it('exposes a structured decision and normalizes scopes safely', async () => {
    const v = await import('../../../../src/main/features/cogseed_backend/visibility-policy');
    const decision = v.decideVisibility({ userId: 'u-1', role: 'member', actorId: 'actor-b' }, {
      ownerUserId: 'u-1',
      scope: { kind: 'actor', actorId: 'actor-b' },
      kind: 'message',
      allowedActorIds: ['actor-b'],
    });
    expect(decision).toEqual(expect.objectContaining({ allowed: true }));
    expect(v.normalizeVisibilityScope({ kind: 'workflow', workflowId: 'flow-x' })).toEqual({ kind: 'workflow', workflowId: 'flow-x' });
    expect(v.normalizeVisibilityScope(undefined)).toEqual({ kind: 'unknown' });
  });

  it('treats missing identities and malformed inputs as deny by default', async () => {
    const v = await import('../../../../src/main/features/cogseed_backend/visibility-policy');
    expect(v.canSeeVisibility(null, null)).toBe(false);
    expect(v.canSeeVisibility({ userId: 'u-1' }, { ownerUserId: 'u-1', scope: { kind: 'task' }, kind: 'message' })).toBe(false);
  });
});
