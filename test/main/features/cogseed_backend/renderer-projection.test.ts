import { describe, expect, it, vi } from 'vitest';

import { createMateIpcService } from '../../../../src/main/features/cogseed_backend/ipc-service';

const session = {
  schemaVersion: 1 as const,
  sessionId: 'mate-session-root',
  runtimeSessionId: 'mruntime-root',
  ownerId: 'renderer-user',
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:01:00.000Z',
};

const parentTask = {
  schemaVersion: 1 as const,
  taskId: 'mate-task-root',
  sessionId: session.sessionId,
  runtimeSessionId: session.runtimeSessionId,
  requestId: 'req-root',
  ownerId: 'renderer-user',
  status: 'recoverable' as const,
  task: 'Coordinate the release plan.',
  coordinationId: 'mate-coord-root',
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:01:00.000Z',
};

const childTask = {
  schemaVersion: 1 as const,
  taskId: 'mate-task-child',
  sessionId: 'mate-session-child',
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
    eventId: 'mate-event-1',
    taskId: parentTask.taskId,
    sessionId: parentTask.sessionId,
    sequence: 1,
    type: 'task.recoverable' as const,
    createdAt: '2026-08-05T00:01:00.000Z',
    payload: { summary: 'Worker restarted at /Users/secret/project', secret: 'token=do-not-leak' },
  },
  {
    schemaVersion: 1 as const,
    eventId: 'mate-event-2',
    taskId: parentTask.taskId,
    sessionId: parentTask.sessionId,
    sequence: 2,
    type: 'task.failed' as const,
    createdAt: '2026-08-05T00:01:01.000Z',
    payload: { name: 'Authorization: Bearer do-not-leak', outputPath: '/Users/secret/output.txt' },
  },
];

describe('Mate renderer-safe projections', () => {
  it('projects sessions without owner/runtime identifiers and includes task counts', async () => {
    const service = createMateIpcService({
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
  });



  it('accepts a gconv compatibility id and reads the canonical Mate session', async () => {
    const canonicalSession = { ...session, sessionId: 'mate-session-gconv-conversation-a' };
    const readSession = vi.fn(async (_userId: string, sessionId: string) => sessionId === canonicalSession.sessionId ? canonicalSession : null);
    const service = createMateIpcService({
      readSession,
      listTasks: vi.fn(async () => []),
    } as any);

    await expect(service.session('renderer-user', { sessionId: 'gconv-conversation-a' })).resolves.toMatchObject({
      session: expect.objectContaining({ sessionId: canonicalSession.sessionId }),
      collaboration: null,
    });
    expect(readSession).toHaveBeenCalledWith('renderer-user', canonicalSession.sessionId);
  });



  it('returns an empty projection when a conversation has no Mate session yet', async () => {
    const service = createMateIpcService({
      readSession: vi.fn(async () => null),
    } as any);

    await expect(service.session('renderer-user', { sessionId: 'gconv-conversation-without-mate' })).resolves.toEqual({
      session: null,
      collaboration: null,
    });
  });

  it('builds a collaboration snapshot with actor roster, child tree, recovery timeline, and redacted event summaries', async () => {
    const service = createMateIpcService({
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
  });
});
