// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';

import { createGroupChatTaskBridge } from '../../../../src/main/features/cogseed_backend/group-chat-task-bridge';
import type { CogSeedTaskRecord } from '../../../../src/main/features/cogseed_backend/types';

function record(overrides: Partial<CogSeedTaskRecord> = {}): CogSeedTaskRecord {
  return {
    schemaVersion: 1,
    taskId: 'cogseed-task-observed',
    sessionId: 'cogseed-session-gconv-conv-a',
    runtimeSessionId: 'mruntime-observed',
    requestId: 'req-groupchat-run-run-a',
    ownerId: 'user-a',
    status: 'created',
    task: 'Conversation task',
    conversationId: 'conv-a',
    executionKind: 'group-chat',
    groupChatRunId: 'run-a',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('Group Chat task bridge', () => {
  it('creates parent and actor tasks without copying prompts into the task store', async () => {
    const tasks = new Map<string, CogSeedTaskRecord>();
    let sequence = 0;
    const createTask = vi.fn(async (_userId: string, input: Record<string, unknown>) => {
      const taskId = `cogseed-task-observed-${++sequence}`;
      const task = record({
        taskId,
        requestId: String(input.requestId),
        task: String(input.task),
        groupChatRunId: String(input.groupChatRunId),
        groupChatTurnId: input.groupChatTurnId ? String(input.groupChatTurnId) : undefined,
        groupChatSourceMessageId: String(input.groupChatSourceMessageId),
        groupChatActorKind: input.groupChatActorKind as CogSeedTaskRecord['groupChatActorKind'],
        groupChatWorkflowRunId: input.groupChatWorkflowRunId ? String(input.groupChatWorkflowRunId) : undefined,
        groupChatWorkflowStepId: input.groupChatWorkflowStepId ? String(input.groupChatWorkflowStepId) : undefined,
        parentTaskId: input.parentTaskId ? String(input.parentTaskId) : undefined,
      });
      tasks.set(taskId, task);
      return { task, created: true };
    });
    const updateTask = vi.fn(async (_userId: string, taskId: string, mutate: (task: CogSeedTaskRecord) => CogSeedTaskRecord) => {
      const next = await mutate(tasks.get(taskId)!);
      tasks.set(taskId, next);
      return next;
    });
    const transitionTask = vi.fn(async (_userId: string, taskId: string, status: CogSeedTaskRecord['status']) => {
      const next = { ...tasks.get(taskId)!, status };
      tasks.set(taskId, next);
      return next;
    });
    const bridge = createGroupChatTaskBridge({
      createTask: createTask as never,
      readTask: (async (_userId: string, taskId: string) => tasks.get(taskId) || null) as never,
      updateTask: updateTask as never,
      transitionTask: transitionTask as never,
      appendEvent: vi.fn() as never,
      setSessionDisplayName: vi.fn(async () => record()) as never,
      readActiveGroupChatWorkflow: vi.fn(async () => ({
        version: 1,
        id: 'wf-release',
        cid: 'conv-a',
        objective: 'Release',
        kind: 'custom',
        status: 'running',
        phase: 'execution',
        context_id: 'wctx-release',
        created_by: 'commander',
        created_at: '2026-08-26T00:00:00.000Z',
        updated_at: '2026-08-26T00:00:00.000Z',
        steps: [{ id: 'wstep-review', run_id: 'wf-release', title: 'Review', actor_id: 'agent-review', type: 'review', status: 'pending', depends_on: [] }],
      })) as never,
    });

    const parent = await bridge.startRun({
      userId: 'user-a',
      conversationId: 'conv-a',
      runId: 'run-a',
      sourceMessageId: 'msg-user-a',
      displayTitle: 'Release Bearer real-token /Users/alice/private',
    });
    const child = await bridge.startTurn({
      userId: 'user-a',
      conversationId: 'conv-a',
      runId: 'run-a',
      turnId: 'turn-a',
      sourceMessageId: 'msg-user-a',
      parentTaskId: parent!.taskId,
      actorId: 'agent-review',
      actorName: 'Reviewer',
      actorKind: 'agent',
      workflowStepId: 'wstep-review',
    });

    expect(parent?.status).toBe('running');
    expect(child).toMatchObject({
      status: 'running',
      parentTaskId: parent?.taskId,
      agentId: 'agent-review',
      groupChatWorkflowRunId: 'wf-release',
      groupChatWorkflowStepId: 'wstep-review',
    });
    const worker = await bridge.startTurn({
      userId: 'user-a',
      conversationId: 'conv-a',
      runId: 'run-a',
      turnId: 'turn-worker',
      sourceMessageId: 'msg-user-a',
      parentTaskId: parent!.taskId,
      actorId: 'worker-a',
      actorName: 'Worker',
      actorKind: 'worker',
    });
    expect(worker).toMatchObject({
      status: 'running',
      agentId: 'worker-a',
      groupChatActorKind: 'worker',
    });
    const persistedInputs = JSON.stringify(createTask.mock.calls.map((call) => call[1]));
    expect(persistedInputs).toContain('Conversation task');
    expect(persistedInputs).toContain('Agent turn');
    expect(persistedInputs).not.toContain('Release');
    expect(persistedInputs).not.toContain('Reviewer');
    expect(persistedInputs).not.toContain('real-token');
    expect(persistedInputs).not.toContain('/Users/alice/private');
    expect(persistedInputs).not.toContain('prompt');
  });

  it('persists only whitelisted tool metadata and terminal correlation', async () => {
    let task = record({ status: 'running', groupChatTurnId: 'turn-a' });
    const appendEvent = vi.fn(async () => ({ eventId: 'event-a' }));
    const bridge = createGroupChatTaskBridge({
      createTask: vi.fn() as never,
      readTask: (async () => task) as never,
      updateTask: (async (_userId: string, _taskId: string, mutate: (current: CogSeedTaskRecord) => CogSeedTaskRecord) => {
        task = await mutate(task);
        return task;
      }) as never,
      transitionTask: (async (_userId: string, _taskId: string, status: CogSeedTaskRecord['status']) => {
        task = { ...task, status };
        return task;
      }) as never,
      appendEvent: appendEvent as never,
      setSessionDisplayName: vi.fn() as never,
    });

    const finished = await bridge.finishTask({
      userId: 'user-a',
      taskId: task.taskId,
      status: 'failed',
      messageId: 'msg-failed-a',
      errorCode: 'tool_failed',
      process: [
        { type: 'event', event: { stream: 'tool', data: { phase: 'start', name: 'read_file', arguments: { path: '/Users/alice/secret.txt', token: 'secret-value' } } } },
        { type: 'event', event: { stream: 'tool', data: { phase: 'error', name: 'read_file', error_code: 'E_READ', output: 'secret-output' } } },
      ],
    });

    expect(finished).toMatchObject({ status: 'failed', groupChatMessageId: 'msg-failed-a', errorCode: 'tool_failed' });
    expect(appendEvent.mock.calls.map((call) => [call[3], call[4]])).toEqual([
      ['tool.started', { toolName: 'read_file' }],
      ['tool.finished', { toolName: 'read_file', isError: true, errorCode: 'E_READ' }],
    ]);
    const storedEvents = JSON.stringify(appendEvent.mock.calls);
    expect(storedEvents).not.toContain('/Users/alice/secret.txt');
    expect(storedEvents).not.toContain('secret-value');
    expect(storedEvents).not.toContain('secret-output');
  });

  it('carries a genuine failure kind through to the persisted task', async () => {
    let task = record({ status: 'running', groupChatTurnId: 'turn-kind' });
    const transitionTask = vi.fn(async (
      _userId: string,
      _taskId: string,
      status: CogSeedTaskRecord['status'],
      payload: Record<string, unknown>,
    ) => {
      task = { ...task, status, ...(payload.errorCode ? { errorCode: String(payload.errorCode) } : {}) };
      return task;
    });
    const bridge = createGroupChatTaskBridge({
      createTask: vi.fn() as never,
      readTask: (async () => task) as never,
      updateTask: (async (_userId: string, _taskId: string, mutate: (current: CogSeedTaskRecord) => CogSeedTaskRecord) => {
        task = await mutate(task);
        return task;
      }) as never,
      transitionTask: transitionTask as never,
      appendEvent: (vi.fn(async () => ({ eventId: 'event-kind' }))) as never,
      setSessionDisplayName: vi.fn() as never,
    });

    await bridge.finishTask({
      userId: 'user-a',
      taskId: task.taskId,
      status: 'failed',
      errorCode: 'model_preflight',
      failureKind: 'config',
    });

    // Written on the record, and handed to the transition so the pair stays
    // together when the transition rewrites the failure fields.
    expect(task).toMatchObject({ errorCode: 'model_preflight', failureKind: 'config' });
    expect(transitionTask).toHaveBeenCalledWith('user-a', task.taskId, 'failed', {
      source: 'group-chat',
      errorCode: 'model_preflight',
      failureKind: 'config',
    });
  });

  it('drops a failure kind that is not part of the taxonomy', async () => {
    let task = record({ status: 'running', groupChatTurnId: 'turn-bogus' });
    const transitionTask = vi.fn(async (_userId: string, _taskId: string, status: CogSeedTaskRecord['status']) => {
      task = { ...task, status };
      return task;
    });
    const bridge = createGroupChatTaskBridge({
      createTask: vi.fn() as never,
      readTask: (async () => task) as never,
      updateTask: (async (_userId: string, _taskId: string, mutate: (current: CogSeedTaskRecord) => CogSeedTaskRecord) => {
        task = await mutate(task);
        return task;
      }) as never,
      transitionTask: transitionTask as never,
      appendEvent: (vi.fn(async () => ({ eventId: 'event-bogus' }))) as never,
      setSessionDisplayName: vi.fn() as never,
    });

    await bridge.finishTask({
      userId: 'user-a',
      taskId: task.taskId,
      status: 'failed',
      errorCode: 'group_chat_turn_failed',
      failureKind: 'made_up_kind' as never,
    });

    expect(task).not.toHaveProperty('failureKind');
    expect(transitionTask).toHaveBeenCalledWith('user-a', task.taskId, 'failed', {
      source: 'group-chat',
      errorCode: 'group_chat_turn_failed',
    });
  });

  it('leaves the kind unset for callers that only synthesise a code', async () => {
    let task = record({ status: 'running', groupChatTurnId: 'turn-codeonly' });
    const bridge = createGroupChatTaskBridge({
      createTask: vi.fn() as never,
      readTask: (async () => task) as never,
      updateTask: (async (_userId: string, _taskId: string, mutate: (current: CogSeedTaskRecord) => CogSeedTaskRecord) => {
        task = await mutate(task);
        return task;
      }) as never,
      transitionTask: (async (_userId: string, _taskId: string, status: CogSeedTaskRecord['status']) => {
        task = { ...task, status };
        return task;
      }) as never,
      appendEvent: (vi.fn(async () => ({ eventId: 'event-codeonly' }))) as never,
      setSessionDisplayName: vi.fn() as never,
    });

    // bus.ts:1602 and bus.ts:3919 have no real kind to give.
    await bridge.finishTask({
      userId: 'user-a',
      taskId: task.taskId,
      status: 'failed',
      errorCode: 'group_chat_run_failed',
    });

    expect(task).toMatchObject({ errorCode: 'group_chat_run_failed' });
    expect(task).not.toHaveProperty('failureKind');
  });
});
