// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';

import { createCogSeedIpcService } from '../../../../src/main/features/cogseed_backend/ipc-service';
import type { CogSeedSessionRecord, CogSeedTaskRecord } from '../../../../src/main/features/cogseed_backend/types';

const session: CogSeedSessionRecord = {
  schemaVersion: 1,
  sessionId: 'cogseed-session-gconv-conv-a',
  runtimeSessionId: 'mruntime-conv-a',
  ownerId: 'user-a',
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
  sessionKind: 'commander',
  actorRole: 'commander',
  actorId: 'commander',
  conversationId: 'conv-a',
  displayName: 'Release task',
  lifecycleState: 'active',
  roster: [],
};

function task(status: CogSeedTaskRecord['status']): CogSeedTaskRecord {
  return {
    schemaVersion: 1,
    taskId: 'cogseed-task-group-chat',
    sessionId: session.sessionId,
    runtimeSessionId: session.runtimeSessionId,
    requestId: 'req-groupchat-run-run-a',
    ownerId: 'user-a',
    status,
    task: 'Release task',
    conversationId: 'conv-a',
    executionKind: 'group-chat',
    groupChatRunId: 'run-a',
    groupChatMessageId: 'msg-failed-a',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:01:00.000Z',
  };
}

function serviceFor(current: CogSeedTaskRecord, overrides: Record<string, unknown> = {}) {
  const runtimeController = {
    startCogSeedTask: vi.fn(),
    cancelCogSeedTask: vi.fn(),
    retryCogSeedTask: vi.fn(),
    resumeCogSeedTask: vi.fn(),
    runtimeStatus: vi.fn(),
    restartRuntime: vi.fn(),
  };
  let stored = current;
  const service = createCogSeedIpcService({
    controller: runtimeController as never,
    readTask: (async () => stored) as never,
    listTasks: (async () => [stored]) as never,
    listSessions: (async () => [session]) as never,
    readSession: (async () => session) as never,
    readEvents: (async () => []) as never,
    readCoordination: (async () => null) as never,
    readWorkflowRun: async () => null,
    readWorkflowContext: async () => null,
    readWorkflowEvents: async () => [],
    abortGroupChat: (async () => { stored = { ...stored, status: 'cancelled' }; }) as never,
    retryGroupChat: (async () => ({ ok: true })) as never,
    ...overrides,
  });
  return { service, runtimeController };
}

describe('Group Chat Dashboard actions', () => {
  it('routes abort to the authoritative Group Chat runtime', async () => {
    const abortGroupChat = vi.fn(async () => undefined);
    const { service, runtimeController } = serviceFor(task('running'), { abortGroupChat });

    await service.action('user-a', { action: 'abort', taskId: 'cogseed-task-group-chat' });

    expect(abortGroupChat).toHaveBeenCalledWith('user-a', 'conv-a');
    expect(runtimeController.cancelCogSeedTask).not.toHaveBeenCalled();
  });

  it('routes retry to the failed Group Chat message without launching CogSeed Runtime', async () => {
    const retryGroupChat = vi.fn(async () => ({ ok: true }));
    const { service, runtimeController } = serviceFor(task('failed'), { retryGroupChat });

    await service.action('user-a', {
      action: 'retry',
      taskId: 'cogseed-task-group-chat',
      requestId: 'req-dashboard-retry-a',
    });

    expect(retryGroupChat).toHaveBeenCalledWith({
      userId: 'user-a',
      cid: 'conv-a',
      failedMessageId: 'msg-failed-a',
      visibleText: expect.any(String),
      requestId: 'req-dashboard-retry-a',
    });
    expect(runtimeController.retryCogSeedTask).not.toHaveBeenCalled();
  });
});
