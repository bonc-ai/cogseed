import { describe, expect, it, vi } from 'vitest';

import { createCogSeedIpcService } from '../../../../src/main/features/cogseed_backend/ipc-service';

const session = {
  schemaVersion: 1 as const,
  sessionId: 'cogseed-session-root',
  runtimeSessionId: 'mruntime-root',
  ownerId: 'renderer-user',
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:01:00.000Z',
  displayName: 'Private session alice@example.internal 10.1.12.6',
};

const parentTask = {
  schemaVersion: 1 as const,
  taskId: 'cogseed-task-root',
  sessionId: session.sessionId,
  runtimeSessionId: session.runtimeSessionId,
  requestId: 'req-root',
  ownerId: 'renderer-user',
  status: 'recoverable' as const,
  task: 'Coordinate the release plan.',
  coordinationId: 'cogseed-coord-root',
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:01:00.000Z',
};

const childTask = {
  schemaVersion: 1 as const,
  taskId: 'cogseed-task-child',
  sessionId: 'cogseed-session-child',
  runtimeSessionId: 'mruntime-child',
  requestId: 'req-child',
  ownerId: 'renderer-user',
  status: 'completed' as const,
  task: 'Inspect /Users/secret/project and report the token=do-not-leak result.',
  parentTaskId: parentTask.taskId,
  coordinationId: parentTask.coordinationId,
  createdAt: '2026-08-05T00:00:10.000Z',
  updatedAt: '2026-08-05T00:00:50.000Z',
};

const events = [
  {
    schemaVersion: 1 as const,
    eventId: 'cogseed-event-1',
    taskId: parentTask.taskId,
    sessionId: parentTask.sessionId,
    sequence: 1,
    type: 'task.recoverable' as const,
    createdAt: '2026-08-05T00:01:00.000Z',
    payload: { summary: 'Worker restarted at /Users/secret/project', secret: 'token=do-not-leak' },
  },
  {
    schemaVersion: 1 as const,
    eventId: 'cogseed-event-2',
    taskId: parentTask.taskId,
    sessionId: parentTask.sessionId,
    sequence: 2,
    type: 'task.failed' as const,
    createdAt: '2026-08-05T00:01:01.000Z',
    payload: { name: 'Authorization: Bearer do-not-leak', outputPath: '/Users/secret/output.txt' },
  },
];

describe('CogSeed renderer-safe projections', () => {
  it('projects sessions without owner/runtime identifiers and includes task counts', async () => {
    const service = createCogSeedIpcService({
      listSessions: vi.fn(async () => [session]),
      listTasks: vi.fn(async () => [parentTask, childTask]),
    } as any);

    await expect(service.sessionListProjection('renderer-user')).resolves.toEqual([
      expect.objectContaining({
        sessionId: session.sessionId,
        taskCount: 1,
        activeTaskCount: 1,
        latestStatus: 'recoverable',
      }),
    ]);

    const result = await service.sessionListProjection('renderer-user');
    expect(result[0]).not.toHaveProperty('ownerId');
    expect(result[0]).not.toHaveProperty('runtimeSessionId');
    expect(result[0]).toMatchObject({ title: 'CogSeed task', titleKey: 'run_center.task_kind_cogseed' });
    expect(JSON.stringify(result)).not.toContain('Private session');
    expect(JSON.stringify(result)).not.toContain('alice@example.internal');
  });



  it('accepts a gconv compatibility id and reads the canonical CogSeed session', async () => {
    const canonicalSession = { ...session, sessionId: 'cogseed-session-gconv-conversation-a' };
    const readSession = vi.fn(async (_userId: string, sessionId: string) => sessionId === canonicalSession.sessionId ? canonicalSession : null);
    const service = createCogSeedIpcService({
      readSession,
      listTasks: vi.fn(async () => []),
    } as any);

    await expect(service.session('renderer-user', { sessionId: 'gconv-conversation-a' })).resolves.toMatchObject({
      session: expect.objectContaining({ sessionId: canonicalSession.sessionId }),
      collaboration: null,
    });
    expect(readSession).toHaveBeenCalledWith('renderer-user', canonicalSession.sessionId);
  });



  it('returns an empty projection when a conversation has no CogSeed session yet', async () => {
    const service = createCogSeedIpcService({
      readSession: vi.fn(async () => null),
    } as any);

    await expect(service.session('renderer-user', { sessionId: 'gconv-conversation-without-cogseed' })).resolves.toEqual({
      session: null,
      collaboration: null,
    });
  });

  it('builds a collaboration snapshot with actor roster, child tree, recovery timeline, and redacted event summaries', async () => {
    const service = createCogSeedIpcService({
      readTask: vi.fn(async (_userId: string, taskId: string) => taskId === parentTask.taskId ? parentTask : taskId === childTask.taskId ? childTask : null),
      listTasks: vi.fn(async () => [parentTask, childTask]),
      listSessions: vi.fn(async () => [session]),
      readSession: vi.fn(async (_userId: string, sessionId: string) => sessionId === session.sessionId ? session : null),
      readEvents: vi.fn(async (_userId: string, taskId: string) => taskId === parentTask.taskId ? events : []),
      readCoordination: vi.fn(async () => ({
        schemaVersion: 1,
        coordinationId: parentTask.coordinationId,
        ownerId: 'renderer-user',
        parentTaskId: parentTask.taskId,
        parentRuntimeSessionId: parentTask.runtimeSessionId,
        status: 'running',
        childTaskIds: [childTask.taskId],
        maxChildren: 4,
        maxDepth: 1,
        createdAt: parentTask.createdAt,
        updatedAt: parentTask.updatedAt,
      })),
    } as any);

    const result = await service.collaborationSnapshot('renderer-user', { taskId: parentTask.taskId });

    expect(result).toMatchObject({
      schemaVersion: 1,
      sessionId: parentTask.sessionId,
      task: expect.objectContaining({ taskId: parentTask.taskId, status: 'recoverable' }),
      recovery: expect.objectContaining({ recoverable: true }),
      workflow: expect.objectContaining({ childTaskIds: [childTask.taskId] }),
    });
    expect(result.actors).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'commander' }),
      expect.objectContaining({ role: 'member_agent', taskId: childTask.taskId }),
    ]));
    expect(result.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: childTask.taskId, parentTaskId: parentTask.taskId }),
    ]));
    expect(result.timeline[0]).toMatchObject({ type: 'task.recoverable', summary: 'Task requires recovery.' });
    expect(result.timeline[1]).toMatchObject({ type: 'task.failed', summary: 'Task failed.' });
    expect(JSON.stringify(result.timeline)).not.toContain('/Users/secret');
    expect(JSON.stringify(result.timeline)).not.toContain('do-not-leak');
    expect(JSON.stringify(result)).not.toContain('renderer-user');
    expect(JSON.stringify(result)).not.toContain('mruntime-');
    expect(JSON.stringify(result)).not.toContain('private.txt');
    expect(JSON.stringify(result)).not.toContain('arguments');
    expect(JSON.stringify(result)).not.toContain('"output":');
    expect(JSON.stringify(result)).not.toContain('Coordinate the release plan.');
    expect(JSON.stringify(result)).not.toContain('Inspect /Users/secret/project');
  });

  it('projects Group Chat parents as runs and deduplicates repeated actor turns', async () => {
    const groupSession = {
      ...session,
      sessionId: 'cogseed-session-gconv-actor-test',
      runtimeSessionId: 'mruntime-gconv-actor-test',
      displayName: 'Confidential customer launch user@example.internal',
    };
    const groupParent = {
      ...parentTask,
      taskId: 'cogseed-task-group-parent',
      sessionId: groupSession.sessionId,
      runtimeSessionId: groupSession.runtimeSessionId,
      requestId: 'req-groupchat-run-actor-test',
      status: 'failed' as const,
      executionKind: 'group-chat' as const,
      coordinationId: undefined,
      agentId: undefined,
      conversationId: 'actor-test',
      groupChatRunId: 'run-actor-test',
    };
    const commanderFirst = {
      ...groupParent,
      taskId: 'cogseed-task-group-commander-first',
      requestId: 'req-groupchat-turn-commander-first',
      task: 'Commander turn',
      parentTaskId: groupParent.taskId,
      groupChatTurnId: 'turn-commander-first',
      groupChatActorKind: 'commander' as const,
      updatedAt: '2026-08-05T00:01:01.000Z',
    };
    const commanderLatest = {
      ...commanderFirst,
      taskId: 'cogseed-task-group-commander-latest',
      requestId: 'req-groupchat-turn-commander-latest',
      groupChatTurnId: 'turn-commander-latest',
      status: 'completed' as const,
      updatedAt: '2026-08-05T00:01:03.000Z',
    };
    const reviewer = {
      ...commanderFirst,
      taskId: 'cogseed-task-group-reviewer',
      requestId: 'req-groupchat-turn-reviewer',
      task: 'Reviewer turn',
      groupChatTurnId: 'turn-reviewer',
      groupChatActorKind: 'agent' as const,
      agentId: 'agent-reviewer',
      groupChatWorkflowRunId: 'wf-actor-test',
      groupChatWorkflowStepId: 'wstep-reviewer',
      status: 'completed' as const,
      updatedAt: '2026-08-05T00:01:02.000Z',
    };
    const worker = {
      ...commanderFirst,
      taskId: 'cogseed-task-group-worker',
      requestId: 'req-groupchat-turn-worker',
      task: 'Worker turn',
      groupChatTurnId: 'turn-worker',
      groupChatActorKind: 'worker' as const,
      agentId: 'worker-ephemeral',
      status: 'completed' as const,
      updatedAt: '2026-08-05T00:01:02.500Z',
    };
    const tasks = [groupParent, commanderFirst, reviewer, worker, commanderLatest];
    const groupChatToolEvent = {
      schemaVersion: 1 as const,
      eventId: 'cogseed-event-group-tool',
      taskId: reviewer.taskId,
      sessionId: reviewer.sessionId,
      sequence: 1,
      type: 'tool.finished' as const,
      createdAt: reviewer.updatedAt,
      payload: { toolName: 'read_file', isError: false },
    };
    const service = createCogSeedIpcService({
      readTask: vi.fn(async (_userId: string, taskId: string) => tasks.find((task) => task.taskId === taskId) ?? null),
      listTasks: vi.fn(async () => tasks),
      listSessions: vi.fn(async () => [groupSession]),
      readSession: vi.fn(async (_userId: string, sessionId: string) => sessionId === groupSession.sessionId ? groupSession : null),
      readEvents: vi.fn(async (_userId: string, taskId: string) => taskId === reviewer.taskId ? [groupChatToolEvent] : []),
      isConversationAvailable: vi.fn(async () => true),
      readGroupChatWorkflowRun: vi.fn(async () => ({
        version: 1,
        id: 'wf-actor-test',
        cid: 'actor-test',
        objective: 'Coordinate confidential release review for user@example.internal',
        kind: 'review',
        status: 'completed',
        phase: 'quality',
        context_id: 'wctx-actor-test',
        created_by: 'commander',
        created_at: groupParent.createdAt,
        updated_at: reviewer.updatedAt,
        steps: [{
          id: 'wstep-reviewer',
          run_id: 'wf-actor-test',
          title: 'Review private acquisition plan',
          actor_id: reviewer.agentId,
          type: 'review',
          status: 'completed',
          depends_on: ['wstep-build'],
          attempts: [],
          result_summary: 'Customer secret output must stay private',
        }],
      })),
      readGroupChatWorkflowContext: vi.fn(async () => ({
        version: 1,
        id: 'wctx-actor-test',
        cid: 'actor-test',
        run_id: 'wf-actor-test',
        revision: 1,
        facts: [], decisions: [], risks: [], artifacts: [], agent_outputs: [], proposals: [], conflicts: [],
        gates: [{ id: 'gate-actor-test', step_id: 'wstep-reviewer', name: 'Private customer approval', status: 'passed', checks: [], created_at: reviewer.updatedAt }],
        created_at: groupParent.createdAt,
        updated_at: reviewer.updatedAt,
      })),
      readGroupChatWorkflowEvents: vi.fn(async () => [{
        version: 1,
        id: 'wevt-actor-test',
        cid: 'actor-test',
        run_id: 'wf-actor-test',
        type: 'step_completed',
        step_id: 'wstep-reviewer',
        created_at: reviewer.updatedAt,
      }]),
    } as any);

    const result = await service.collaborationSnapshot('renderer-user', { taskId: groupParent.taskId });

    expect(result.actors).toEqual([
      expect.objectContaining({
        actorId: 'commander',
        role: 'commander',
        taskId: commanderLatest.taskId,
        status: 'completed',
      }),
      expect.objectContaining({
        actorId: reviewer.agentId,
        role: 'member_agent',
        taskId: reviewer.taskId,
        status: 'completed',
      }),
      expect.objectContaining({
        actorId: worker.agentId,
        role: 'child_agent',
        taskId: worker.taskId,
        status: 'completed',
      }),
    ]);
    expect(JSON.stringify(result.actors)).not.toContain(`member:${groupParent.taskId}`);
    expect(JSON.stringify(result.actors)).not.toContain(commanderFirst.taskId);
    expect(result.timeline).toEqual([
      expect.objectContaining({
        taskId: reviewer.taskId,
        type: 'tool.finished',
        toolName: 'read_file',
        isError: false,
      }),
    ]);
    expect(result.workflow.steps).toEqual([
      expect.objectContaining({ stepId: 'wstep-reviewer', dependsOn: ['wstep-build'], status: 'completed' }),
    ]);
    expect(result.reviews).toEqual([expect.objectContaining({ gateId: 'gate-actor-test', status: 'passed' })]);
    expect(result.activity).toEqual([expect.objectContaining({ eventId: 'wevt-actor-test', type: 'step_completed' })]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Confidential customer launch');
    expect(serialized).not.toContain('Coordinate confidential release review');
    expect(serialized).not.toContain('Review private acquisition plan');
    expect(serialized).not.toContain('Customer secret output');
    expect(serialized).not.toContain('Private customer approval');
    expect(result.workflow).not.toHaveProperty('objective');
    expect(result.workflow.steps[0]).not.toHaveProperty('resultSummary');
    expect(result.timeline[0]).toHaveProperty('summaryKey');

    const board = await service.boardProjection('renderer-user');
    expect(board.groups).toEqual([
      expect.objectContaining({ groupId: groupParent.taskId, parentTaskId: groupParent.taskId, progress: { total: 5, completed: 3, failed: 2, active: 0, attention: 0 } }),
    ]);
    expect(board.tasks.every((task) => task.groupId === groupParent.taskId)).toBe(true);
  });

  it('hides deleted Group Chat conversations while keeping non-chat tasks visible', async () => {
    const deletedSession = { ...session, sessionId: 'cogseed-session-gconv-deleted', conversationId: 'deleted-conversation' };
    const deletedTask = {
      ...parentTask,
      taskId: 'cogseed-task-deleted-conversation',
      sessionId: deletedSession.sessionId,
      runtimeSessionId: deletedSession.runtimeSessionId,
      executionKind: 'group-chat' as const,
      conversationId: deletedSession.conversationId,
      groupChatRunId: 'run-deleted-conversation',
    };
    const service = createCogSeedIpcService({
      listSessions: vi.fn(async () => [deletedSession, session]),
      listTasks: vi.fn(async () => [deletedTask, parentTask]),
      readSession: vi.fn(async (_userId: string, sessionId: string) => sessionId === deletedSession.sessionId ? deletedSession : null),
      readTask: vi.fn(async () => deletedTask),
      isConversationAvailable: vi.fn(async () => false),
    } as any);

    await expect(service.boardProjection('renderer-user')).resolves.toMatchObject({
      tasks: [expect.objectContaining({ taskId: parentTask.taskId })],
    });
    await expect(service.sessionListProjection('renderer-user')).resolves.toEqual([
      expect.objectContaining({ sessionId: session.sessionId }),
    ]);
    await expect(service.sessionProjection('renderer-user', { sessionId: deletedSession.sessionId })).resolves.toEqual({
      session: null,
      collaboration: null,
    });
  });

  it('omits sessions without tasks and sorts real runs by latest task activity', async () => {
    const emptySession = { ...session, sessionId: 'cogseed-session-empty', displayName: 'Empty' };
    const olderSession = {
      ...session,
      sessionId: 'cogseed-session-older',
      displayName: undefined,
      conversationId: undefined,
      updatedAt: '2026-08-04T00:00:00.000Z',
    };
    const olderTask = {
      ...parentTask,
      sessionId: olderSession.sessionId,
      taskId: 'cogseed-task-older',
      task: 'Older task title',
      updatedAt: '2026-08-04T00:00:00.000Z',
    };
    const service = createCogSeedIpcService({
      listSessions: vi.fn(async () => [olderSession, emptySession, session]),
      listTasks: vi.fn(async () => [olderTask, parentTask]),
    } as any);

    const result = await service.sessionListProjection('renderer-user');
    expect(result.map((item) => item.sessionId)).toEqual([session.sessionId, olderSession.sessionId]);
    expect(result[1]).toEqual(expect.objectContaining({
      title: 'CogSeed task',
      titleKey: 'run_center.task_kind_cogseed',
      latestTaskId: olderTask.taskId,
    }));
    expect(JSON.stringify(result)).not.toContain('Older task title');
  });
});
