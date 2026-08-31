// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'cogseed-boot-recovery-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-boot-recovery-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CogSeed cold-start recovery', () => {
  it('repairs every durable task status after process death without fabricating intermediate states', async () => {
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const boot = await import('../../../../src/main/features/cogseed_backend/boot-recovery');
    const cases = [
      { status: 'queued', expected: ['task.created', 'task.queued', 'task.recoverable'] },
      { status: 'running', expected: ['task.created', 'task.started', 'task.recoverable'] },
      { status: 'waiting_user', expected: ['task.created', 'task.waiting_user', 'task.recoverable'] },
      { status: 'recoverable', errorCode: 'worker_restart', expected: ['task.created', 'task.recoverable'] },
      { status: 'failed', errorCode: 'worker_failed', expected: ['task.created', 'task.failed'] },
      { status: 'cancelled', expected: ['task.created', 'task.cancelled'] },
      { status: 'completed', expected: ['task.created', 'task.completed'] },
    ] as const;

    const records = [];
    for (const [index, entry] of cases.entries()) {
      const task = (await tasks.createCogSeedTask(USER, {
        requestId: `req-boot-crash-window-${index}`,
        task: `Repair ${entry.status} after task JSON rename.`,
      })).task;
      const taskFile = paths.cogseedTaskFile(USER, task.taskId);
      const persisted = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
      persisted.status = entry.status;
      persisted.updatedAt = new Date(Date.now() + index + 1).toISOString();
      if (entry.status === 'completed' || entry.status === 'failed' || entry.status === 'cancelled') {
        persisted.terminalAt = persisted.updatedAt;
      }
      if ('errorCode' in entry) persisted.errorCode = entry.errorCode;
      fs.writeFileSync(taskFile, JSON.stringify(persisted));
      records.push({ task, entry });
    }

    const first = await boot.recoverCogSeedTasksAtBoot(USER);
    const second = await boot.recoverCogSeedTasksAtBoot(USER);

    expect(first.recoveredCount).toBe(3);
    expect(second.recoveredCount).toBe(0);
    for (const { task, entry } of records) {
      expect((await events.readCogSeedTaskEvents(USER, task.taskId, 0, 20)).map((event) => event.type))
        .toEqual(entry.expected);
    }
  });

  it('marks every persisted non-terminal task recoverable before the first window is created', async () => {
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const boot = await import('../../../../src/main/features/cogseed_backend/boot-recovery');

    const created = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-boot-created',
      task: 'Recover a task admitted before process exit.',
    })).task;
    const queued = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-boot-queued',
      task: 'Recover queued work.',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, queued.taskId, 'queued');
    const running = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-boot-running',
      task: 'Recover running work.',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, running.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, running.taskId, 'running');
    const waiting = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-boot-waiting',
      task: 'Recover work waiting on a vanished process.',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, waiting.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, waiting.taskId, 'running');
    await lifecycle.transitionCogSeedTask(USER, waiting.taskId, 'waiting_user');
    const completed = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-boot-completed',
      task: 'Do not alter completed history.',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, completed.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, completed.taskId, 'running');
    await lifecycle.transitionCogSeedTask(USER, completed.taskId, 'completed');

    // Model a crash after the task record was written but before its creation
    // event became durable. Boot recovery must repair that boundary first.
    fs.rmSync(paths.cogseedTaskEventsFile(USER, created.taskId), { force: true });

    const report = await boot.recoverCogSeedTasksAtBoot(USER);
    const recoveredIds = [created, queued, running, waiting].map((task) => task.taskId).sort();

    expect(report).toMatchObject({
      recoveredCount: 4,
      dispatchedCount: 0,
      taskIds: recoveredIds,
    });
    for (const task of [created, queued, running, waiting]) {
      await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
        status: 'recoverable',
        errorCode: 'worker_restart',
      });
      const storedEvents = await events.readCogSeedTaskEvents(USER, task.taskId, 0, 20);
      expect(storedEvents.filter((event) => event.type === 'task.recoverable')).toEqual([
        expect.objectContaining({ payload: { errorCode: 'worker_restart' } }),
      ]);
      if (task.taskId === created.taskId) {
        expect(storedEvents.map((event) => event.type)).toEqual(['task.created', 'task.recoverable']);
      }
    }
    await expect(tasks.readCogSeedTask(USER, completed.taskId)).resolves.toMatchObject({ status: 'completed' });
  });

  it('delivers a retained terminal result before generic orphan-task recovery', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const deliveries = await import('../../../../src/main/features/cogseed_backend/result-delivery-store');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const boot = await import('../../../../src/main/features/cogseed_backend/boot-recovery');
    const conversation = await chats.createConversation(USER, { title: 'Retained boot result' });
    const task = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-boot-retained-result',
      task: 'Finish before the process exits.',
      conversationId: conversation.conversation_id,
      agentId: 'agent-boot-retained-result',
    })).task;
    await deliveries.cogseedResultDeliveryStore.save(USER, {
      taskId: task.taskId,
      executionId: task.executionId!,
      conversationId: conversation.conversation_id,
      agentId: 'agent-boot-retained-result',
      sessionId: task.sessionId,
      destinationGeneration: conversation._cogseed_result_generation!,
      event: {
        eventId: `cogseed-event-terminal-${task.taskId}`,
        type: 'task.completed',
        payload: { text: 'Recovered exactly once at boot.' },
      },
    });
    // Model process death after the completed task JSON rename but before its
    // terminal event append. Retained-result recovery sees the same status and
    // must append only task.completed, never synthetic queued/running events.
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const taskFile = paths.cogseedTaskFile(USER, task.taskId);
    const persisted = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    persisted.status = 'completed';
    persisted.resultDeliveryState = 'pending-recovery';
    persisted.terminalAt = new Date().toISOString();
    persisted.updatedAt = persisted.terminalAt;
    fs.writeFileSync(taskFile, JSON.stringify(persisted));

    const report = await boot.recoverCogSeedTasksAtBoot(USER);

    expect(report).toMatchObject({
      retainedResultsRecovered: 1,
      retainedResultsPending: 0,
      recoveredCount: 0,
    });
    await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
      status: 'completed',
      resultDeliveryState: 'delivered',
    });
    await expect(deliveries.cogseedResultDeliveryStore.read(USER, task.executionId!)).resolves.toBeNull();
    expect((await events.readCogSeedTaskEvents(USER, task.taskId, 0, 20)).map((event) => event.type)).toEqual([
      'task.created',
      'task.completed',
    ]);
    expect(await groupChat.readMessages(USER, conversation.conversation_id)).toEqual([
      expect.objectContaining({
        from: 'agent-boot-retained-result',
        turn_id: task.executionId,
        text: 'Recovered exactly once at boot.',
      }),
    ]);
    await groupChat.dropConv(USER, conversation.conversation_id);
  });

  it('counts stale delivered-result cleanup as recovered', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const deliveries = await import('../../../../src/main/features/cogseed_backend/result-delivery-store');
    const boot = await import('../../../../src/main/features/cogseed_backend/boot-recovery');
    const conversation = await chats.createConversation(USER, { title: 'Delivered cleanup at boot' });
    const task = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-boot-delivered-cleanup',
      task: 'Clean the retained result left after delivery.',
      conversationId: conversation.conversation_id,
      agentId: 'agent-boot-delivered-cleanup',
    })).task;
    await deliveries.cogseedResultDeliveryStore.save(USER, {
      taskId: task.taskId,
      executionId: task.executionId!,
      conversationId: conversation.conversation_id,
      agentId: task.agentId!,
      sessionId: task.sessionId,
      destinationGeneration: conversation._cogseed_result_generation!,
      event: {
        eventId: `cogseed-event-terminal-${task.taskId}`,
        type: 'task.completed',
        payload: { text: 'Already projected before process exit.' },
      },
    });
    await lifecycle.transitionCogSeedTask(USER, task.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, task.taskId, 'running');
    await lifecycle.transitionCogSeedTask(USER, task.taskId, 'completed');
    await tasks.updateCogSeedTask(USER, task.taskId, (current) => ({
      ...current,
      resultDeliveryState: 'delivered',
    }));

    await expect(boot.recoverCogSeedTasksAtBoot(USER)).resolves.toMatchObject({
      retainedResultsRecovered: 1,
      retainedResultsPending: 0,
      retainedResultsQuarantined: 0,
    });
    await expect(deliveries.cogseedResultDeliveryStore.read(USER, task.executionId!)).resolves.toBeNull();
  });

  it('quarantines an unreadable retained result and continues boot recovery', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const deliveries = await import('../../../../src/main/features/cogseed_backend/result-delivery-store');
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const boot = await import('../../../../src/main/features/cogseed_backend/boot-recovery');
    const task = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-boot-corrupt-retained-result',
      task: 'Do not start with an untrusted retained result.',
    })).task;
    fs.mkdirSync(paths.cogseedPendingResultDeliveriesDirectory(USER), { recursive: true });
    fs.writeFileSync(path.join(
      paths.cogseedPendingResultDeliveriesDirectory(USER),
      `${task.executionId}.json`,
    ), '{not-json');
    const conversation = await chats.createConversation(USER, { title: 'valid result after malformed entry' });
    const validTask = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-boot-valid-after-malformed',
      task: 'This result must still recover.',
      conversationId: conversation.conversation_id,
      agentId: 'agent-boot-valid-after-malformed',
    })).task;
    await deliveries.cogseedResultDeliveryStore.save(USER, {
      taskId: validTask.taskId,
      executionId: validTask.executionId!,
      conversationId: validTask.conversationId!,
      agentId: validTask.agentId!,
      sessionId: validTask.sessionId,
      destinationGeneration: conversation._cogseed_result_generation!,
      event: {
        eventId: `cogseed-event-terminal-${validTask.taskId}`,
        type: 'task.completed',
        payload: { text: 'valid result recovered after malformed entry' },
      },
    });

    await expect(boot.recoverCogSeedTasksAtBoot(USER)).resolves.toMatchObject({
      retainedResultsRecovered: 1,
      retainedResultsPending: 0,
      retainedResultsQuarantined: 1,
      recoveredCount: 1,
    });
    await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({ status: 'recoverable' });
    await expect(tasks.readCogSeedTask(USER, validTask.taskId)).resolves.toMatchObject({
      status: 'completed',
      resultDeliveryState: 'delivered',
    });
    expect(JSON.parse(fs.readFileSync(
      paths.cogseedUndeliverableResultFile(USER, task.executionId!), 'utf8'))).toMatchObject({
      reason: 'malformed-record',
      rawPayload: '{not-json',
    });
  });

  it('quarantines an undeliverable retained result while recovering unrelated orphan tasks', async () => {
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const deliveries = await import('../../../../src/main/features/cogseed_backend/result-delivery-store');
    const boot = await import('../../../../src/main/features/cogseed_backend/boot-recovery');
    const retainedTask = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-boot-retained-missing-conversation',
      task: 'Preserve the terminal result.',
      conversationId: 'cid-boot-missing-conversation',
      agentId: 'agent-boot-missing-conversation',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, retainedTask.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, retainedTask.taskId, 'running');
    await lifecycle.markCogSeedTaskRecoverable(USER, retainedTask.taskId, 'worker_restart');
    await deliveries.cogseedResultDeliveryStore.save(USER, {
      taskId: retainedTask.taskId,
      executionId: retainedTask.executionId!,
      conversationId: retainedTask.conversationId!,
      agentId: retainedTask.agentId!,
      sessionId: retainedTask.sessionId,
      destinationGeneration: 'cogseed-generation-missing-conversation',
      event: {
        eventId: `cogseed-event-terminal-${retainedTask.taskId}`,
        type: 'task.completed',
        payload: { text: 'Keep this result until its destination is recoverable.' },
      },
    });
    const orphan = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-boot-unrelated-orphan',
      task: 'Recover independently.',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, orphan.taskId, 'queued');

    const report = await boot.recoverCogSeedTasksAtBoot(USER);

    expect(report).toMatchObject({
      retainedResultsRecovered: 0,
      retainedResultsPending: 0,
      retainedResultsQuarantined: 1,
      recoveredCount: 1,
      taskIds: [orphan.taskId],
    });
    await expect(tasks.readCogSeedTask(USER, retainedTask.taskId)).resolves.toMatchObject({
      status: 'completed',
      resultDeliveryState: 'not-applicable',
    });
    await expect(deliveries.cogseedResultDeliveryStore.read(USER, retainedTask.executionId!)).resolves.toBeNull();
    await expect(tasks.readCogSeedTask(USER, orphan.taskId)).resolves.toMatchObject({
      status: 'recoverable',
      errorCode: 'worker_restart',
    });
  });
});
