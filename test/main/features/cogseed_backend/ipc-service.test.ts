import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

import {
  cogSeedRunCenterConversationId,
  createCogSeedIpcService,
} from '../../../../src/main/features/cogseed_backend/ipc-service';
import { spaceWorkspaceDir } from '../../../../src/main/paths';

describe('CogSeed IPC service', () => {
  it('delegates the user-scoped Agent Registry projection unchanged', async () => {
    const registry = {
      schemaVersion: 1 as const,
      updatedAt: '2026-08-27T00:00:00.000Z',
      agents: [],
      runtimes: [],
      channels: [],
    };
    const calls: string[] = [];
    const reconcileAgentDirectory = vi.fn(async () => { calls.push('reconcile'); });
    const listAgentRegistry = vi.fn(async () => {
      calls.push('list');
      return registry;
    });
    const service = createCogSeedIpcService({ listAgentRegistry, reconcileAgentDirectory });

    await expect(service.agents('ipc-user')).resolves.toBe(registry);
    expect(calls).toEqual(['reconcile', 'list']);
    expect(reconcileAgentDirectory).toHaveBeenCalledTimes(1);
    expect(listAgentRegistry).toHaveBeenCalledWith('ipc-user');
  });

  it('keeps the Agent Registry available when external directory reconciliation fails', async () => {
    const registry = {
      schemaVersion: 1 as const,
      updatedAt: '2026-08-27T00:00:00.000Z',
      agents: [],
      runtimes: [],
      channels: [],
    };
    const listAgentRegistry = vi.fn(async () => registry);
    const service = createCogSeedIpcService({
      listAgentRegistry,
      reconcileAgentDirectory: vi.fn(async () => { throw new Error('bridge unavailable'); }),
    });

    await expect(service.agents('ipc-user')).resolves.toBe(registry);
    expect(listAgentRegistry).toHaveBeenCalledWith('ipc-user');
  });

  it('lists only sessions backed by CogSeed tasks and ignores unrelated external-session lookalikes', async () => {
    const baseSession = {
      schemaVersion: 1, ownerId: 'ipc-user', runtimeSessionId: 'mruntime-owned',
      createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:01:00.000Z',
      sessionKind: 'generic', actorRole: 'commander', lifecycleState: 'active',
    } as const;
    const owned = { ...baseSession, sessionId: 'cogseed-session-owned' };
    const externalLookalike = { ...baseSession, sessionId: 'cogseed-session-external-lookalike', runtimeSessionId: 'mruntime-external' };
    const task = {
      schemaVersion: 1, taskId: 'cogseed-task-owned', sessionId: owned.sessionId,
      runtimeSessionId: owned.runtimeSessionId, executionId: 'cogseed-exec-owned', requestId: 'req-owned',
      ownerId: 'ipc-user', status: 'completed', task: 'Private body',
      createdAt: owned.createdAt, updatedAt: owned.updatedAt,
    } as any;
    const service = createCogSeedIpcService({
      listSessions: vi.fn(async () => [owned, externalLookalike] as any),
      listTasks: vi.fn(async () => [task]),
    });

    await expect(service.sessions('ipc-user')).resolves.toEqual([
      expect.objectContaining({ sessionId: 'cogseed-session-owned', taskCount: 1 }),
    ]);
  });

  it('delegates explicit Worktree operations to the active user scope without accepting a repository override', async () => {
    const worktreeManager = {
      resolve: vi.fn(async () => '/safe/cogseed-worktree-dev-user'),
      list: vi.fn(async () => ({ schemaVersion: 1 as const, repository: { path: '/safe/repo', branch: 'develop' }, worktrees: [] })),
      create: vi.fn(async () => ({ path: '/safe/cogseed-worktree-dev-user', name: 'cogseed-worktree-dev-user', branch: 'dev/user', head: 'abc', dirty: false, verifiable: true })),
      remove: vi.fn(async () => ({ removed: true as const, path: '/safe/cogseed-worktree-dev-user', branch: 'dev/user' })),
    };
    const service = createCogSeedIpcService({ worktreeManager });

    await expect(service.worktrees('ipc-user')).resolves.toMatchObject({ repository: { branch: 'develop' } });
    await expect(service.createWorktree('ipc-user', {
      branch: 'dev/user', baseRef: 'develop', repositoryPath: '/attacker/repo',
    })).resolves.toMatchObject({ branch: 'dev/user' });
    await expect(service.removeWorktree('ipc-user', {
      path: '/safe/cogseed-worktree-dev-user', expectedBranch: 'dev/user', repositoryPath: '/attacker/repo',
    })).resolves.toMatchObject({ removed: true });

    expect(worktreeManager.list).toHaveBeenCalledWith('ipc-user');
    expect(worktreeManager.create).toHaveBeenCalledWith('ipc-user', { branch: 'dev/user', baseRef: 'develop' });
    expect(worktreeManager.remove).toHaveBeenCalledWith('ipc-user', {
      path: '/safe/cogseed-worktree-dev-user', expectedBranch: 'dev/user',
    });
  });

  it('saves a planned task without launching Runtime and keeps deferred execution fields out of the DTO', async () => {
    const planned = {
      schemaVersion: 1,
      taskId: 'cogseed-task-planned-ipc',
      sessionId: 'cogseed-session-planned-ipc',
      runtimeSessionId: 'mruntime-planned-ipc',
      requestId: 'req-planned-ipc',
      conversationId: cogSeedRunCenterConversationId('req-planned-ipc'),
      ownerId: 'ipc-user',
      status: 'planned',
      task: 'Private deferred task body.',
      plannedAt: '2026-09-02T00:00:00.000Z',
      spaceId: 'sp_private',
      worktreeName: 'cogseed-worktree-private',
      resultDeliveryState: 'not-applicable',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    } as any;
    const admitTask = vi.fn(async () => ({ task: planned, created: true }));
    const ensureRunCenterConversation = vi.fn(async () => undefined);
    const controller = {
      startCogSeedTask: vi.fn(),
      startPlannedCogSeedTask: vi.fn(),
    } as any;
    const service = createCogSeedIpcService({
      admitTask,
      controller,
      spaceExists: vi.fn(async () => true),
      ensureRunCenterConversation,
    });

    const dto = await service.create('ipc-user', {
      requestId: planned.requestId,
      task: planned.task,
      spaceId: planned.spaceId,
    });

    expect(admitTask).toHaveBeenCalledWith('ipc-user', expect.objectContaining({
      requestId: planned.requestId,
      initialStatus: 'planned',
      spaceId: planned.spaceId,
    }));
    expect(controller.startCogSeedTask).not.toHaveBeenCalled();
    expect(controller.startPlannedCogSeedTask).not.toHaveBeenCalled();
    expect(ensureRunCenterConversation).toHaveBeenCalledWith({
      userId: 'ipc-user',
      conversationId: planned.conversationId,
      requestId: planned.requestId,
      task: planned.task,
      spaceId: planned.spaceId,
    });
    expect(admitTask).toHaveBeenCalledWith('ipc-user', expect.objectContaining({
      conversationId: planned.conversationId,
    }));
    expect(dto).toMatchObject({
      taskId: planned.taskId,
      conversationId: planned.conversationId,
      status: 'planned',
      actions: expect.objectContaining({ start: true, archive: true }),
    });
    expect(dto).not.toHaveProperty('task');
    expect(dto).not.toHaveProperty('plannedAt');
    expect(dto).not.toHaveProperty('spaceId');
    expect(dto).not.toHaveProperty('worktreeName');
  });

  it('rejects execution-only input instead of silently dropping it when saving a planned task', async () => {
    const admitTask = vi.fn();
    const service = createCogSeedIpcService({ admitTask });
    const unsupportedFields = {
      sessionId: 'cogseed-session-planned-input',
      profileId: 'profile-planned-input',
      context: [],
      attachments: [],
      conversationId: 'conversation-planned-input',
    };

    for (const [field, value] of Object.entries(unsupportedFields)) {
      await expect(service.create('ipc-user', {
        requestId: `req-planned-${field}`,
        task: 'Save only supported task settings.',
        [field]: value,
      })).rejects.toThrow(`E_RUN_CENTER_PLANNED_FIELD_UNSUPPORTED:${field}`);
    }

    expect(admitTask).not.toHaveBeenCalled();
  });

  it('revalidates a planned task before start and leaves it planned when its workspace is gone', async () => {
    const planned = {
      schemaVersion: 1,
      taskId: 'cogseed-task-stale-space',
      sessionId: 'cogseed-session-stale-space',
      runtimeSessionId: 'mruntime-stale-space',
      requestId: 'req-stale-space',
      ownerId: 'ipc-user',
      status: 'planned',
      task: 'Run only in the selected workspace.',
      plannedAt: '2026-09-02T00:00:00.000Z',
      spaceId: 'sp_deleted',
      resultDeliveryState: 'not-applicable',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    } as any;
    const controller = {
      startCogSeedTask: vi.fn(),
      startPlannedCogSeedTask: vi.fn(),
    } as any;
    const service = createCogSeedIpcService({
      controller,
      readTask: vi.fn(async () => planned),
      spaceExists: vi.fn(async () => false),
    });

    await expect(service.action('ipc-user', {
      taskId: planned.taskId,
      action: 'start',
      requestId: 'req-start-stale-space',
    })).rejects.toThrow('E_RUN_CENTER_SPACE_UNAVAILABLE');
    expect(planned.status).toBe('planned');
    expect(controller.startPlannedCogSeedTask).not.toHaveBeenCalled();
  });

  it('rejects a planned task whose resolved workspace escapes its selected space', async () => {
    const planned = {
      schemaVersion: 1,
      taskId: 'cogseed-task-planned-outside-space',
      sessionId: 'cogseed-session-planned-outside-space',
      runtimeSessionId: 'mruntime-planned-outside-space',
      requestId: 'req-planned-outside-space',
      ownerId: 'ipc-user',
      status: 'planned',
      task: 'Stay within the selected workspace.',
      spaceId: 'sp_project',
      conversationId: 'run-center-planned-outside-space',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    } as any;
    const controller = {
      startPlannedCogSeedTask: vi.fn(),
    } as any;
    const service = createCogSeedIpcService({
      controller,
      readTask: vi.fn(async () => planned),
      spaceExists: vi.fn(async () => true),
      isConversationAvailable: vi.fn(async () => true),
      readConversationSpaceBinding: vi.fn(async () => ({ exists: true, spaceId: planned.spaceId })),
      resolveConversationWorkspace: vi.fn(async () => path.join(spaceWorkspaceDir('ipc-user', 'sp_other'), 'run-center-task')),
    });

    await expect(service.action('ipc-user', {
      taskId: planned.taskId,
      action: 'start',
      requestId: 'req-start-planned-outside-space',
    })).rejects.toThrow('E_RUN_CENTER_SPACE_WORKSPACE_MISMATCH');
    expect(controller.startPlannedCogSeedTask).not.toHaveBeenCalled();
  });

  it('delegates validated user-scoped task operations without exposing backend selection or fallback fields', async () => {
    const controller = {
      startCogSeedTask: vi.fn(async (_userId: string, input: { requestId: string; task: string }) => ({ taskId: 'cogseed-task-ipc', status: 'running', ...input })),
      cancelCogSeedTask: vi.fn(async (_userId: string, taskId: string) => ({ taskId, status: 'cancelled' })),
    };
    const worktreeManager = {
      resolve: vi.fn(async (_userId: string, name: string) => `/safe/${name}`),
      list: vi.fn(), create: vi.fn(), remove: vi.fn(),
    };
    const ensureRunCenterConversation = vi.fn(async () => undefined);
    const service = createCogSeedIpcService({
      controller,
      readTaskByRequestId: vi.fn(async () => null),
      ensureRunCenterConversation,
      readTask: vi.fn(async () => ({ taskId: 'cogseed-task-ipc', status: 'running' })),
      retryTask: vi.fn(async () => ({ taskId: 'cogseed-task-retry', status: 'created' })),
      readEvents: vi.fn(async () => []),
      worktreeManager,
    });

    await expect(service.start('ipc-user', { requestId: 'req-ipc', task: 'Do work.', allowFallback: true })).rejects.toThrow(/fallback/i);
    await expect(service.start('ipc-user', { requestId: 'req-ipc', task: 'Do work.' })).resolves.toMatchObject({ taskId: 'cogseed-task-ipc', status: 'running' });
    await expect(service.start('ipc-user', { requestId: 'req-worktree', task: 'Isolated work.', worktreeName: 'cogseed-worktree-dev-user' })).resolves.toMatchObject({
      taskId: 'cogseed-task-ipc', worktreeName: 'cogseed-worktree-dev-user',
    });
    await expect(service.start('ipc-user', { requestId: 'req-path', task: 'Unsafe work.', workingDir: '/private/path' })).rejects.toThrow(/worktreeName/);
    await expect(service.cancel('ipc-user', 'cogseed-task-ipc')).resolves.toMatchObject({ status: 'cancelled' });
    expect(controller.startCogSeedTask).toHaveBeenNthCalledWith(1, 'ipc-user', {
      requestId: 'req-ipc', task: 'Do work.',
      conversationId: cogSeedRunCenterConversationId('req-ipc'),
    });
    expect(controller.startCogSeedTask).toHaveBeenNthCalledWith(2, 'ipc-user', {
      requestId: 'req-worktree', task: 'Isolated work.', workingDir: '/safe/cogseed-worktree-dev-user',
      conversationId: cogSeedRunCenterConversationId('req-worktree'),
    });
    expect(ensureRunCenterConversation).toHaveBeenNthCalledWith(1, expect.objectContaining({
      userId: 'ipc-user', requestId: 'req-ipc', conversationId: cogSeedRunCenterConversationId('req-ipc'),
    }));
    expect(ensureRunCenterConversation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      userId: 'ipc-user', requestId: 'req-worktree', conversationId: cogSeedRunCenterConversationId('req-worktree'),
    }));
    expect(worktreeManager.resolve).toHaveBeenCalledWith('ipc-user', 'cogseed-worktree-dev-user');
  });

  it('binds a selected CogSeed workspace before resolving its trusted execution directory', async () => {
    const order: string[] = [];
    let binding = { exists: false, spaceId: '' };
    const workspace = path.join(spaceWorkspaceDir('ipc-user', 'sp_project'), 'run-center-task');
    const controller = {
      startCogSeedTask: vi.fn(async (_userId: string, input: any) => {
        order.push('runtime');
        return {
          taskId: 'cogseed-task-space', sessionId: 'cogseed-session-space', runtimeSessionId: 'mruntime-space',
          executionId: 'cogseed-exec-space', ownerId: 'ipc-user', status: 'running',
          createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
          ...input,
        };
      }),
    } as any;
    const spaceExists = vi.fn(async () => {
      order.push('space');
      return true;
    });
    const ensureRunCenterConversation = vi.fn(async (input: any) => {
      order.push('conversation');
      binding = { exists: true, spaceId: input.spaceId };
    });
    const resolveConversationWorkspace = vi.fn(async () => {
      order.push('workspace');
      return workspace;
    });
    const service = createCogSeedIpcService({
      controller,
      readTaskByRequestId: vi.fn(async () => null),
      spaceExists,
      ensureRunCenterConversation,
      readConversationSpaceBinding: vi.fn(async () => binding),
      resolveConversationWorkspace,
    });

    await expect(service.start('ipc-user', {
      requestId: 'req-space-start', task: 'Run in the selected workspace.', spaceId: 'sp_project',
    })).resolves.toMatchObject({ taskId: 'cogseed-task-space', conversationId: cogSeedRunCenterConversationId('req-space-start') });

    expect(order).toEqual(['space', 'conversation', 'workspace', 'runtime']);
    expect(spaceExists).toHaveBeenCalledWith('ipc-user', 'sp_project');
    expect(ensureRunCenterConversation).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'ipc-user', conversationId: cogSeedRunCenterConversationId('req-space-start'),
      requestId: 'req-space-start', task: 'Run in the selected workspace.', spaceId: 'sp_project',
    }));
    expect(ensureRunCenterConversation.mock.calls[0]?.[0]).not.toHaveProperty('agentId');
    expect(resolveConversationWorkspace).toHaveBeenCalledWith('ipc-user', cogSeedRunCenterConversationId('req-space-start'));
    expect(controller.startCogSeedTask).toHaveBeenCalledWith('ipc-user', expect.objectContaining({
      conversationId: cogSeedRunCenterConversationId('req-space-start'),
      workingDir: workspace,
    }));
    expect(controller.startCogSeedTask.mock.calls[0]?.[1]).not.toHaveProperty('spaceId');
  });

  it('rejects an immediate task whose resolved workspace escapes its selected space', async () => {
    const controller = { startCogSeedTask: vi.fn() } as any;
    const service = createCogSeedIpcService({
      controller,
      readTaskByRequestId: vi.fn(async () => null),
      spaceExists: vi.fn(async () => true),
      ensureRunCenterConversation: vi.fn(async () => undefined),
      readConversationSpaceBinding: vi.fn(async () => ({ exists: true, spaceId: 'sp_project' })),
      resolveConversationWorkspace: vi.fn(async () => path.join(spaceWorkspaceDir('ipc-user', 'sp_other'), 'run-center-task')),
    });

    await expect(service.start('ipc-user', {
      requestId: 'req-immediate-outside-space',
      task: 'Do not leave the selected space.',
      spaceId: 'sp_project',
    })).rejects.toThrow('E_RUN_CENTER_SPACE_WORKSPACE_MISMATCH');
    expect(controller.startCogSeedTask).not.toHaveBeenCalled();
  });

  it('rejects stale, unsafe, cross-space, and Worktree-conflicting workspace starts before launch', async () => {
    const existing = {
      taskId: 'cogseed-task-existing-space', sessionId: 'cogseed-session-existing-space',
      runtimeSessionId: 'mruntime-existing-space', executionId: 'cogseed-exec-existing-space',
      requestId: 'req-existing-space', ownerId: 'ipc-user', status: 'completed', task: 'Historical task.',
      conversationId: cogSeedRunCenterConversationId('req-existing-space'),
      workingDir: '/safe/sp_alpha/workspace/historical-task',
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:01:00.000Z',
    } as any;
    const controller = { startCogSeedTask: vi.fn(async () => existing) } as any;
    const ensureRunCenterConversation = vi.fn(async () => undefined);
    const worktreeManager = {
      resolve: vi.fn(async () => '/safe/worktree'), list: vi.fn(), create: vi.fn(), remove: vi.fn(),
    };
    const service = createCogSeedIpcService({
      controller,
      readTaskByRequestId: vi.fn(async (_userId, requestId) => requestId === existing.requestId ? existing : null),
      spaceExists: vi.fn(async (_userId, spaceId) => spaceId !== 'sp_deleted'),
      ensureRunCenterConversation,
      readConversationSpaceBinding: vi.fn(async () => ({ exists: true, spaceId: 'sp_alpha' })),
      resolveConversationWorkspace: vi.fn(async () => existing.workingDir),
      worktreeManager,
    });

    await expect(service.start('ipc-user', {
      requestId: 'req-unsafe-space', task: 'Unsafe.', spaceId: '../private',
    })).rejects.toThrow(/invalid spaceId/);
    await expect(service.start('ipc-user', {
      requestId: 'req-deleted-space', task: 'Deleted.', spaceId: 'sp_deleted',
    })).rejects.toThrow(/E_RUN_CENTER_SPACE_UNAVAILABLE/);
    await expect(service.start('ipc-user', {
      requestId: 'req-space-worktree', task: 'Conflicting.', spaceId: 'sp_alpha',
      worktreeName: 'cogseed-worktree-feature',
    })).rejects.toThrow(/E_RUN_CENTER_SPACE_WORKTREE_CONFLICT/);
    await expect(service.start('ipc-user', {
      requestId: existing.requestId, task: existing.task, spaceId: 'sp_beta',
    })).rejects.toThrow(/payload conflict/i);

    expect(controller.startCogSeedTask).not.toHaveBeenCalled();
    expect(ensureRunCenterConversation).not.toHaveBeenCalled();
    expect(worktreeManager.resolve).not.toHaveBeenCalled();
  });

  it('routes recover-result actions to the Runtime controller without requiring a new request ID', async () => {
    const task = {
      schemaVersion: 1,
      taskId: 'cogseed-task-recover-result',
      sessionId: 'cogseed-session-recover-result',
      runtimeSessionId: 'mruntime-recover-result',
      executionId: 'cogseed-exec-recover-result',
      requestId: 'req-recover-result-original',
      ownerId: 'ipc-user',
      status: 'completed',
      task: 'Deliver the retained result.',
      conversationId: 'cid-recover-result',
      agentId: 'agent-recover-result',
      executionKind: 'local-cli',
      resultDeliveryState: 'pending-recovery',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:01:00.000Z',
    } as any;
    const session = {
      schemaVersion: 1,
      sessionId: task.sessionId,
      runtimeSessionId: task.runtimeSessionId,
      ownerId: task.ownerId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      sessionKind: 'agent',
      actorRole: 'member',
      actorId: task.agentId,
      conversationId: task.conversationId,
      lifecycleState: 'active',
    } as any;
    const retryCogSeedResultDelivery = vi.fn(async () => ({
      ...task,
      resultDeliveryState: 'delivered',
    }));
    const controller = {
      startCogSeedTask: vi.fn(),
      cancelCogSeedTask: vi.fn(),
      retryCogSeedTask: vi.fn(),
      resumeCogSeedTask: vi.fn(),
      retryCogSeedResultDelivery,
    } as any;
    const service = createCogSeedIpcService({
      controller,
      readTask: vi.fn(async () => task),
      listTasks: vi.fn(async () => [task]),
      readSession: vi.fn(async () => session),
      listSessions: vi.fn(async () => [session]),
      readEvents: vi.fn(async () => []),
      readCoordination: vi.fn(async () => null),
    });

    await expect(service.action('ipc-user', {
      action: 'recover-result',
      taskId: task.taskId,
    })).resolves.toMatchObject({ task: { taskId: task.taskId } });

    expect(retryCogSeedResultDelivery).toHaveBeenCalledTimes(1);
    expect(retryCogSeedResultDelivery).toHaveBeenCalledWith('ipc-user', task.taskId);
    expect(controller.cancelCogSeedTask).not.toHaveBeenCalled();
    expect(controller.retryCogSeedTask).not.toHaveBeenCalled();
    expect(controller.resumeCogSeedTask).not.toHaveBeenCalled();
  });

  it('archives completed runs through the existing task action and preserves their completed status', async () => {
    let task = {
      schemaVersion: 1,
      taskId: 'cogseed-task-archive',
      sessionId: 'cogseed-session-archive',
      runtimeSessionId: 'mruntime-archive',
      executionId: 'cogseed-exec-archive',
      requestId: 'req-archive',
      ownerId: 'ipc-user',
      status: 'completed',
      task: 'Private completed task body.',
      resultDeliveryState: 'delivered',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:01:00.000Z',
    } as any;
    const session = {
      schemaVersion: 1,
      sessionId: task.sessionId,
      runtimeSessionId: task.runtimeSessionId,
      ownerId: task.ownerId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      sessionKind: 'generic',
      actorRole: 'commander',
      lifecycleState: 'terminal',
    } as any;
    const archiveTask = vi.fn(async (_userId: string, _taskId: string) => {
      task = { ...task, archivedAt: '2026-08-27T00:02:00.000Z', updatedAt: '2026-08-27T00:02:00.000Z' };
      return task;
    });
    const service = createCogSeedIpcService({
      archiveTask,
      readTask: vi.fn(async () => task),
      listTasks: vi.fn(async () => [task]),
      readSession: vi.fn(async () => session),
      listSessions: vi.fn(async () => [session]),
      readEvents: vi.fn(async () => []),
      readCoordination: vi.fn(async () => null),
    });

    await expect(service.board('ipc-user')).resolves.toMatchObject({
      tasks: [expect.objectContaining({
        taskId: task.taskId,
        status: 'completed',
        column: 'completed',
        actions: expect.objectContaining({ archive: true }),
      })],
    });
    await expect(service.action('ipc-user', {
      action: 'archive',
      taskId: task.taskId,
    })).resolves.toMatchObject({
      task: expect.objectContaining({ taskId: task.taskId, status: 'completed' }),
    });
    await expect(service.board('ipc-user')).resolves.toMatchObject({
      tasks: [expect.objectContaining({
        taskId: task.taskId,
        status: 'completed',
        column: 'archived',
        actions: expect.objectContaining({ archive: false }),
      })],
      counts: expect.objectContaining({ completed: 0, archived: 1 }),
    });
    expect(archiveTask).toHaveBeenCalledWith('ipc-user', task.taskId);
  });

  it('purges archived records through a user-scoped store operation', async () => {
    const purgeArchivedTasks = vi.fn(async () => ({
      purgedTaskIds: ['cogseed-task-archived'],
      retainedTaskIds: ['cogseed-task-result-pending'],
      failedTaskIds: [],
    }));
    const service = createCogSeedIpcService({ purgeArchivedTasks });

    await expect(service.purgeArchived('ipc-user')).resolves.toEqual({
      purgedTaskIds: ['cogseed-task-archived'],
      retainedTaskIds: ['cogseed-task-result-pending'],
      failedTaskIds: [],
    });
    expect(purgeArchivedTasks).toHaveBeenCalledWith('ipc-user');
  });

  it('resolves Agent execution on the main side and creates linked reassignment tasks', async () => {
    const controller = {
      startCogSeedTask: vi.fn(async (_userId: string, input: any) => ({
        taskId: input.retryOfTaskId ? 'cogseed-task-linked' : 'cogseed-task-agent',
        sessionId: 'cogseed-session-agent',
        status: 'running',
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
        ...input,
      })),
      cancelCogSeedTask: vi.fn(),
    };
    const resolveAgentExecutionContext = vi.fn(async (_userId: string, agentId: string) => ({
      agentId,
      agentName: 'External reviewer',
      workflow: 'Review carefully.',
      skillList: ['review-skill'],
      interactive: true as const,
      runtime: { kind: 'p3394-gateway' as const, cli: 'codex', model: 'review-model' },
      knowhow: [],
      standards: [],
    }));
    const readTask = vi.fn(async () => ({
      taskId: 'cogseed-task-original',
      sessionId: 'cogseed-session-original',
      requestId: 'req-original',
      ownerId: 'ipc-user',
      runtimeSessionId: 'mruntime-original',
      status: 'failed',
      task: 'Private original task body',
      workingDir: '/safe/cogseed-worktree-dev-user',
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:01.000Z',
    } as any));
    const ensureRunCenterConversation = vi.fn(async () => undefined);
    const service = createCogSeedIpcService({
      controller,
      readTask,
      resolveAgentExecutionContext,
      ensureRunCenterConversation,
    });

    await expect(service.start('ipc-user', {
      requestId: 'req-agent-start',
      task: 'Review the change.',
      agentId: 'review-agent',
      executionKind: 'group-chat',
      localCli: { cli: 'attacker-controlled' },
    })).resolves.toMatchObject({
      taskId: 'cogseed-task-agent',
      sourceKind: 'p3394-gateway',
      agentId: 'review-agent',
    });
    expect(controller.startCogSeedTask).toHaveBeenLastCalledWith('ipc-user', expect.objectContaining({
      agentId: 'review-agent',
      conversationId: cogSeedRunCenterConversationId('req-agent-start'),
      executionKind: 'local-cli',
      allowedSkillIds: ['review-skill'],
      localCli: expect.objectContaining({ cli: 'codex', model: 'review-model', viaP3394Gateway: true }),
      context: [expect.objectContaining({ label: 'Formal Agent execution context' })],
    }));
    expect(controller.startCogSeedTask.mock.calls[0]?.[1]).not.toHaveProperty('localCli.cli', 'attacker-controlled');
    expect(ensureRunCenterConversation).toHaveBeenNthCalledWith(1, expect.objectContaining({
      userId: 'ipc-user',
      conversationId: cogSeedRunCenterConversationId('req-agent-start'),
      requestId: 'req-agent-start',
      task: 'Review the change.',
      agentId: 'review-agent',
    }));

    await expect(service.reassign('ipc-user', {
      taskId: 'cogseed-task-original',
      requestId: 'req-agent-linked',
      agentId: 'review-agent',
    })).resolves.toMatchObject({ taskId: 'cogseed-task-linked', sourceKind: 'p3394-gateway' });
    expect(controller.startCogSeedTask).toHaveBeenLastCalledWith('ipc-user', expect.objectContaining({
      requestId: 'req-agent-linked',
      task: 'Private original task body',
      retryOfTaskId: 'cogseed-task-original',
      agentId: 'review-agent',
      conversationId: cogSeedRunCenterConversationId('req-agent-linked'),
      workingDir: '/safe/cogseed-worktree-dev-user',
    }));
    expect(ensureRunCenterConversation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      conversationId: cogSeedRunCenterConversationId('req-agent-linked'),
      requestId: 'req-agent-linked',
      agentId: 'review-agent',
    }));
  });

  it('creates the Conversation before launching a CLI and single-flights concurrent start replays', async () => {
    const order: string[] = [];
    let releaseConversation!: () => void;
    let conversationEntered!: () => void;
    const conversationGate = new Promise<void>((resolve) => { releaseConversation = resolve; });
    const conversationStarted = new Promise<void>((resolve) => { conversationEntered = resolve; });
    const task = {
      taskId: 'cogseed-task-ordered-start', sessionId: 'cogseed-session-ordered-start',
      runtimeSessionId: 'mruntime-ordered-start', executionId: 'cogseed-exec-ordered-start',
      requestId: 'req-ordered-start', ownerId: 'ipc-user', status: 'running', task: 'Run after conversation.',
      conversationId: cogSeedRunCenterConversationId('req-ordered-start'), agentId: 'ordered-agent',
      executionKind: 'local-cli', createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
    } as any;
    const ensureRunCenterConversation = vi.fn(async () => {
      order.push('conversation');
      conversationEntered();
      await conversationGate;
    });
    const controller = {
      startCogSeedTask: vi.fn(async () => {
        order.push('cli');
        return task;
      }),
    } as any;
    const service = createCogSeedIpcService({
      controller,
      readTaskByRequestId: vi.fn(async () => null),
      ensureRunCenterConversation,
      resolveAgentExecutionContext: vi.fn(async () => ({
        agentId: 'ordered-agent', agentName: 'Ordered Agent', workflow: '', skillList: [], interactive: true,
        runtime: { kind: 'local_cli', cli: 'codex' }, knowhow: [], standards: [],
      } as any)),
    });

    const first = service.start('ipc-user', { requestId: 'req-ordered-start', task: 'Run after conversation.', agentId: 'ordered-agent' });
    await conversationStarted;
    const duplicate = service.start('ipc-user', { requestId: 'req-ordered-start', task: 'Run after conversation.', agentId: 'ordered-agent' });
    await expect(service.start('ipc-user', {
      requestId: 'req-ordered-start', task: 'Conflicting payload.', agentId: 'ordered-agent',
    })).rejects.toThrow(/payload conflict/i);
    expect(controller.startCogSeedTask).not.toHaveBeenCalled();
    releaseConversation();

    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(firstResult).toEqual(duplicateResult);
    expect(order).toEqual(['conversation', 'cli']);
    expect(ensureRunCenterConversation).toHaveBeenCalledTimes(1);
    expect(controller.startCogSeedTask).toHaveBeenCalledTimes(1);
  });

  it('claims a start request before operation code can synchronously re-enter the service', async () => {
    const payload = { requestId: 'req-sync-reentry', task: 'Run exactly once.' };
    const task = {
      taskId: 'cogseed-task-sync-reentry', sessionId: 'cogseed-session-sync-reentry',
      runtimeSessionId: 'mruntime-sync-reentry', executionId: 'cogseed-exec-sync-reentry',
      requestId: payload.requestId, ownerId: 'ipc-user', status: 'running', task: payload.task,
      createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
    } as any;
    const startCogSeedTask = vi.fn(async () => task);
    const controller = { startCogSeedTask } as any;
    type Service = ReturnType<typeof createCogSeedIpcService>;
    let service!: Service;
    let operationEntries = 0;
    let didReenter = false;
    let duplicate: ReturnType<Service['start']> | undefined;
    let conflict: ReturnType<Service['start']> | undefined;
    const deps: NonNullable<Parameters<typeof createCogSeedIpcService>[0]> = {
      readTaskByRequestId: vi.fn(async () => null),
      ensureRunCenterConversation: vi.fn(async () => undefined),
    };
    Object.defineProperty(deps, 'controller', {
      get() {
        operationEntries += 1;
        if (!didReenter) {
          didReenter = true;
          duplicate = service.start('ipc-user', payload);
          conflict = service.start('ipc-user', { ...payload, task: 'Conflicting payload.' });
          void conflict.catch(() => undefined);
        }
        return controller;
      },
    });
    service = createCogSeedIpcService(deps);

    const first = service.start('ipc-user', payload);
    await Promise.resolve();
    if (!duplicate || !conflict) throw new Error('synchronous re-entry did not run');

    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(firstResult).toEqual(duplicateResult);
    await expect(conflict).rejects.toThrow(/payload conflict/i);
    expect(operationEntries).toBe(1);
    expect(startCogSeedTask).toHaveBeenCalledTimes(1);
  });

  it('does not recreate a deleted Conversation when a durable start request is replayed', async () => {
    const existing = {
      taskId: 'cogseed-task-deleted-replay', sessionId: 'cogseed-session-deleted-replay',
      runtimeSessionId: 'mruntime-deleted-replay', executionId: 'cogseed-exec-deleted-replay',
      requestId: 'req-deleted-replay', ownerId: 'ipc-user', status: 'cancelled', task: 'Historical task.',
      conversationId: cogSeedRunCenterConversationId('req-deleted-replay'), agentId: 'deleted-agent',
      executionKind: 'local-cli', createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:01:00.000Z',
    } as any;
    const ensureRunCenterConversation = vi.fn(async () => undefined);
    const controller = { startCogSeedTask: vi.fn(async () => existing) } as any;
    const service = createCogSeedIpcService({
      controller,
      readTaskByRequestId: vi.fn(async () => existing),
      ensureRunCenterConversation,
      isConversationAvailable: vi.fn(async () => false),
      resolveAgentExecutionContext: vi.fn(async () => ({
        agentId: 'deleted-agent', agentName: 'Deleted Agent', workflow: '', skillList: [], interactive: true,
        runtime: { kind: 'local_cli', cli: 'codex' }, knowhow: [], standards: [],
      } as any)),
    });

    await expect(service.start('ipc-user', {
      requestId: 'req-deleted-replay', task: 'Historical task.', agentId: 'deleted-agent',
    })).resolves.toMatchObject({ taskId: existing.taskId, status: 'cancelled' });

    expect(ensureRunCenterConversation).not.toHaveBeenCalled();
    expect(controller.startCogSeedTask).toHaveBeenCalledTimes(1);
  });

  it('excludes live controller tasks from manual and post-restart recovery', async () => {
    const recovery = { recoveredCount: 0, dispatchedCount: 0 as const, taskIds: [] };
    const controller = {
      runtimeStatus: vi.fn(async () => ({ backend: 'cogseed' as const, activeTaskCount: 1, activeTaskIds: ['cogseed-task-live'] })),
      restartRuntime: vi.fn(async () => ({ restarted: true as const })),
      recoverOrphanedTasks: vi.fn(async () => recovery),
    } as any;
    const service = createCogSeedIpcService({ controller });

    await expect(service.recover('ipc-user')).resolves.toMatchObject({ recoveredCount: 0 });
    await expect(service.restartRuntime('ipc-user')).resolves.toMatchObject({ restarted: true });

    expect(controller.recoverOrphanedTasks).toHaveBeenNthCalledWith(1, 'ipc-user');
    expect(controller.recoverOrphanedTasks).toHaveBeenNthCalledWith(2, 'ipc-user');
    expect(controller.runtimeStatus).not.toHaveBeenCalled();
  });

  it('delegates recovery to the controller atomic launch boundary instead of taking a runtime snapshot', async () => {
    const controller = {
      runtimeStatus: vi.fn(async () => ({ backend: 'cogseed' as const, activeTaskCount: 0, activeTaskIds: [] })),
      recoverOrphanedTasks: vi.fn(async () => ({
        recoveredCount: 0,
        dispatchedCount: 0 as const,
        taskIds: [],
      })),
    } as any;
    const service = createCogSeedIpcService({ controller });

    await expect(service.recover('ipc-user')).resolves.toEqual({
      recoveredCount: 0,
      dispatchedCount: 0,
      taskIds: [],
    });
    expect(controller.recoverOrphanedTasks).toHaveBeenCalledWith('ipc-user');
    expect(controller.runtimeStatus).not.toHaveBeenCalled();
  });

  it('builds diagnostics from sanitized summaries without exposing task content', async () => {
    const task = {
      taskId: 'cogseed-task-diagnostic', sessionId: 'cogseed-session-diagnostic', runtimeSessionId: 'mruntime-diagnostic',
      requestId: 'req-diagnostic', ownerId: 'ipc-user', status: 'running', task: 'Private prompt with /Users/private/secret.txt',
      executionKind: 'local-cli', agentId: 'review-agent', localCli: { cli: 'codex', viaP3394Gateway: true }, errorCode: 'E_SAFE_CODE',
      createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:01.000Z',
    } as any;
    const service = createCogSeedIpcService({
      controller: { runtimeStatus: vi.fn(async () => ({ backend: 'cogseed' as const, activeTaskCount: 1, activeTaskIds: [task.taskId] })) } as any,
      listTasks: vi.fn(async () => [task]),
      isConversationAvailable: vi.fn(async () => true),
    });

    const result = await service.diagnostics('ipc-user');

    expect(result).toMatchObject({
      taskCount: 1,
      sessionCount: 1,
      activeTaskCount: 1,
      sourceCounts: { 'p3394-gateway': 1 },
      runtime: { activeTaskCount: 1, stateMatchesProjection: true },
      errorCodes: [{ code: 'E_SAFE_CODE', count: 1 }],
    });
    expect(JSON.stringify(result)).not.toContain('Private prompt');
    expect(JSON.stringify(result)).not.toContain('/Users/');
    expect(JSON.stringify(result)).not.toContain('codex');
  });
});
