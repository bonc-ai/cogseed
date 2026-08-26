// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// RC-P1-09 — link a retry's new task to the failed one it replaces.
//
// Scope note (revised 2026-08-26): the original spec framed this as a
// group-chat plumbing gap. Re-checking the code found two independent holes:
//
//   (a) write side — the group-chat retry path (`retryFailedTurn` → `enqueue` →
//       `startRun`) never passed `retryOfTaskId`, so the new parent task had no
//       link at all;
//   (b) projection side — `taskSummary()` never exposed `retryOfTaskId` for ANY
//       executionKind. CogSeed-native retry has been writing that field all
//       along (`lifecycle.ts`), so even native retries were invisible.
//
// No schema change was needed: `retryOfTaskId` already existed end to end in
// `types.ts` and `task-store.ts`. These tests cover both holes.

import { describe, expect, it, vi } from 'vitest';

import { createCogSeedIpcService } from '../../../../src/main/features/cogseed_backend/ipc-service';
import { createGroupChatTaskBridge } from '../../../../src/main/features/cogseed_backend/group-chat-task-bridge';
import type { CogSeedTaskRecord } from '../../../../src/main/features/cogseed_backend/types';

function task(overrides: Partial<CogSeedTaskRecord> & { taskId: string }): CogSeedTaskRecord {
  const at = overrides.updatedAt ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    taskId: overrides.taskId,
    sessionId: 'cogseed-session-1',
    requestId: `req-${overrides.taskId}`,
    userId: 'u-1',
    status: 'failed',
    createdAt: at,
    updatedAt: at,
    ...overrides,
  } as CogSeedTaskRecord;
}

describe('RC-P1-09 (b) projection exposes retryOfTaskId', () => {
  const build = (record: CogSeedTaskRecord) => createCogSeedIpcService({
    readTask: async () => record,
    listTasks: async () => [record],
    listSessions: async () => [] as never,
    isConversationAvailable: async () => true,
  });

  it('surfaces the link for a group-chat task', async () => {
    const summary = await build(task({
      taskId: 'cogseed-task-new1',
      status: 'running',
      executionKind: 'group-chat',
      conversationId: 'conv-1',
      retryOfTaskId: 'cogseed-task-old1',
    })).read('u-1', { taskId: 'cogseed-task-new1' });

    expect(summary.retryOfTaskId).toBe('cogseed-task-old1');
  });

  // The half of the bug that was invisible until now: native retry already
  // wrote the field, but nothing ever projected it.
  it('surfaces the link for a cogseed-native task too', async () => {
    const summary = await build(task({
      taskId: 'cogseed-task-new1',
      status: 'running',
      executionKind: 'cogseed-native',
      retryOfTaskId: 'cogseed-task-old1',
    })).read('u-1', { taskId: 'cogseed-task-new1' });

    expect(summary.retryOfTaskId).toBe('cogseed-task-old1');
  });

  it('omits the field entirely when the task is not a retry', async () => {
    const summary = await build(task({ taskId: 'cogseed-task-plain', status: 'running' }))
      .read('u-1', { taskId: 'cogseed-task-plain' });
    expect(summary).not.toHaveProperty('retryOfTaskId');
  });
});

describe('RC-P1-09 (a) group-chat retry threads the link through', () => {
  it('passes the failed taskId into the group-chat retry call', async () => {
    const failed = task({
      taskId: 'cogseed-task-old1',
      status: 'failed',
      executionKind: 'group-chat',
      conversationId: 'conv-1',
      groupChatMessageId: 'msg-1',
    });
    const retryGroupChat = vi.fn(async () => ({ ok: true }));
    const service = createCogSeedIpcService({
      readTask: async () => failed,
      listTasks: async () => [failed],
      listSessions: async () => [] as never,
      isConversationAvailable: async () => true,
      retryGroupChat,
    });

    await service.action('u-1', { taskId: 'cogseed-task-old1', action: 'retry', requestId: 'req-run-center-1' })
      .catch(() => undefined); // snapshot build is out of scope here

    expect(retryGroupChat).toHaveBeenCalledTimes(1);
    expect(retryGroupChat.mock.calls[0][0]).toMatchObject({
      cid: 'conv-1',
      failedMessageId: 'msg-1',
      requestId: 'req-run-center-1',
      retryOfCogSeedTaskId: 'cogseed-task-old1',
    });
  });

  it('records retryOfTaskId on the parent task the retried run creates', async () => {
    const created: Array<Record<string, unknown>> = [];
    const bridge = createGroupChatTaskBridge({
      createTask: (async (_userId: string, input: Record<string, unknown>) => {
        created.push(input);
        return { task: task({ taskId: 'cogseed-task-new1', status: 'created' }), created: true };
      }) as never,
      updateTask: (async (_u: string, _id: string, fn: (t: CogSeedTaskRecord) => CogSeedTaskRecord) =>
        fn(task({ taskId: 'cogseed-task-new1', status: 'created' }))) as never,
      transitionTask: (async () => task({ taskId: 'cogseed-task-new1', status: 'running' })) as never,
      appendEvent: (async () => undefined) as never,
      setSessionDisplayName: (async () => undefined) as never,
    });

    await bridge.startRun({
      userId: 'u-1',
      conversationId: 'conv-1',
      runId: 'run-1',
      sourceMessageId: 'msg-2',
      retryOfTaskId: 'cogseed-task-old1',
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      requestId: 'req-groupchat-run-run-1',
      executionKind: 'group-chat',
      retryOfTaskId: 'cogseed-task-old1',
    });
  });

  it('leaves the field off a run that is not a retry', async () => {
    const created: Array<Record<string, unknown>> = [];
    const bridge = createGroupChatTaskBridge({
      createTask: (async (_userId: string, input: Record<string, unknown>) => {
        created.push(input);
        return { task: task({ taskId: 'cogseed-task-new1', status: 'created' }), created: true };
      }) as never,
      updateTask: (async (_u: string, _id: string, fn: (t: CogSeedTaskRecord) => CogSeedTaskRecord) =>
        fn(task({ taskId: 'cogseed-task-new1', status: 'created' }))) as never,
      transitionTask: (async () => task({ taskId: 'cogseed-task-new1', status: 'running' })) as never,
      appendEvent: (async () => undefined) as never,
      setSessionDisplayName: (async () => undefined) as never,
    });

    await bridge.startRun({
      userId: 'u-1',
      conversationId: 'conv-1',
      runId: 'run-1',
      sourceMessageId: 'msg-2',
    });

    expect(created[0]).not.toHaveProperty('retryOfTaskId');
  });

  it('rejects a retryOfTaskId that is not a safe identifier', async () => {
    const created: Array<Record<string, unknown>> = [];
    const bridge = createGroupChatTaskBridge({
      createTask: (async (_userId: string, input: Record<string, unknown>) => {
        created.push(input);
        return { task: task({ taskId: 'cogseed-task-new1', status: 'created' }), created: true };
      }) as never,
      updateTask: (async (_u: string, _id: string, fn: (t: CogSeedTaskRecord) => CogSeedTaskRecord) =>
        fn(task({ taskId: 'cogseed-task-new1', status: 'created' }))) as never,
      transitionTask: (async () => task({ taskId: 'cogseed-task-new1', status: 'running' })) as never,
      appendEvent: (async () => undefined) as never,
      setSessionDisplayName: (async () => undefined) as never,
    });

    await bridge.startRun({
      userId: 'u-1',
      conversationId: 'conv-1',
      runId: 'run-1',
      sourceMessageId: 'msg-2',
      retryOfTaskId: '../../etc/passwd',
    });

    // Same whitelist every other correlation id goes through — a malformed
    // link is dropped rather than persisted.
    expect(created[0]).not.toHaveProperty('retryOfTaskId');
  });
});
