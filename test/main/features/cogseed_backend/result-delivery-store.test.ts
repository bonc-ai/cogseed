// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'cogseed-result-store-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-result-delivery-store-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function deliveryInput(executionId: string, overrides: Record<string, unknown> = {}) {
  return {
    taskId: `cogseed-task-${executionId.slice('cogseed-exec-'.length)}`,
    executionId,
    conversationId: 'cid-result-store',
    agentId: 'agent-result-store',
    sessionId: 'cogseed-session-result-store',
    destinationGeneration: 'cogseed-generation-result-store',
    event: {
      eventId: `cogseed-event-${executionId.slice('cogseed-exec-'.length)}`,
      type: 'task.completed' as const,
      payload: { text: 'original retained result' },
    },
    ...overrides,
  };
}

async function backend() {
  return import('../../../../src/main/features/cogseed_backend/result-delivery-store');
}

describe('CogSeed result delivery store', () => {
  it('keeps the first retained result immutable and treats an identical save as a no-op', async () => {
    const { cogseedResultDeliveryStore } = await backend();
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const input = deliveryInput('cogseed-exec-idempotent');

    const first = await cogseedResultDeliveryStore.save(USER, input);
    const file = paths.cogseedPendingResultDeliveryFile(USER, input.executionId);
    const firstStat = fs.statSync(file, { bigint: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const replayed = await cogseedResultDeliveryStore.save(USER, structuredClone(input));
    const replayedStat = fs.statSync(file, { bigint: true });

    expect(replayed).toEqual(first);
    expect(replayedStat.ino).toBe(firstStat.ino);
    expect(replayedStat.mtimeNs).toBe(firstStat.mtimeNs);
  });

  it.each([
    ['task', { taskId: 'cogseed-task-conflicting' }],
    ['conversation', { conversationId: 'cid-conflicting' }],
    ['agent', { agentId: 'agent-conflicting' }],
    ['runtime session', { sessionId: 'cogseed-session-conflicting' }],
    ['terminal event identity', {
      event: {
        eventId: 'cogseed-event-conflicting',
        type: 'task.completed',
        payload: { text: 'original retained result' },
      },
    }],
    ['terminal output', {
      event: {
        eventId: 'cogseed-event-conflict-output',
        type: 'task.completed',
        payload: { text: 'private-result-sentinel-should-not-leak' },
      },
    }],
  ])('rejects conflicting %s data without replacing the first result', async (_label, override) => {
    const { cogseedResultDeliveryStore } = await backend();
    const executionId = `cogseed-exec-conflict-${String(_label).replaceAll(' ', '-')}`;
    const original = deliveryInput(executionId);
    const first = await cogseedResultDeliveryStore.save(USER, original);

    let caught: unknown;
    try {
      await cogseedResultDeliveryStore.save(USER, deliveryInput(executionId, override));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain('conflicting CogSeed pending result delivery');
    expect(String(caught)).not.toContain('private-result-sentinel-should-not-leak');
    await expect(cogseedResultDeliveryStore.read(USER, executionId)).resolves.toEqual(first);
  });

  it('allows only one winner when conflicting results are retained concurrently', async () => {
    const { cogseedResultDeliveryStore } = await backend();
    const executionId = 'cogseed-exec-concurrent-conflict';
    const firstCandidate = deliveryInput(executionId, {
      event: {
        eventId: 'cogseed-event-concurrent-a',
        type: 'task.completed',
        payload: { text: 'candidate A' },
      },
    });
    const secondCandidate = deliveryInput(executionId, {
      event: {
        eventId: 'cogseed-event-concurrent-b',
        type: 'task.completed',
        payload: { text: 'candidate B' },
      },
    });

    const settled = await Promise.allSettled([
      cogseedResultDeliveryStore.save(USER, firstCandidate),
      cogseedResultDeliveryStore.save(USER, secondCandidate),
    ]);

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const winner = settled.find((result) => result.status === 'fulfilled');
    await expect(cogseedResultDeliveryStore.read(USER, executionId)).resolves.toEqual(
      winner && winner.status === 'fulfilled' ? winner.value : null,
    );
  });

  it('serializes save, remove, and conversation cleanup through the same per-user lock', async () => {
    const { cogseedResultDeliveryStore } = await backend();
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const { fileEditLock } = await import('../../../../src/main/util/locks');
    const lock = fileEditLock(paths.cogseedPendingResultDeliveriesDirectory(USER));
    const release = await lock.acquire();

    const savePromise = cogseedResultDeliveryStore.save(USER, deliveryInput('cogseed-exec-locked-save'));
    const removePromise = cogseedResultDeliveryStore.remove(USER, 'cogseed-exec-locked-remove');
    const clearPromise = cogseedResultDeliveryStore.clearForConversation(USER, 'cid-result-store');
    let settled = false;
    void Promise.all([savePromise, removePromise, clearPromise]).then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(settled).toBe(false);
    release();
    await expect(Promise.all([savePromise, removePromise, clearPromise])).resolves.toBeDefined();
  });

  it('clears only records for the selected conversation', async () => {
    const { cogseedResultDeliveryStore } = await backend();
    await cogseedResultDeliveryStore.save(USER, deliveryInput('cogseed-exec-clear-a'));
    await cogseedResultDeliveryStore.save(USER, deliveryInput('cogseed-exec-clear-b', {
      conversationId: 'cid-result-store-other',
    }));

    await cogseedResultDeliveryStore.clearForConversation(USER, 'cid-result-store');

    await expect(cogseedResultDeliveryStore.read(USER, 'cogseed-exec-clear-a')).resolves.toBeNull();
    await expect(cogseedResultDeliveryStore.read(USER, 'cogseed-exec-clear-b')).resolves.toMatchObject({
      conversationId: 'cid-result-store-other',
    });
  });

  it('fails closed when a v1 record cannot prove its original conversation generation', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const reconciler = await import('../../../../src/main/features/cogseed_backend/result-delivery-reconciler');
    const conversation = await chats.createConversation(USER, { title: 'legacy generation' });
    const task = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-v1-generation-unverified',
      task: 'Never project into a possibly replaced destination.',
      conversationId: conversation.conversation_id,
      agentId: 'agent-v1-generation-unverified',
    })).task;
    const timestamp = new Date().toISOString();
    const legacy = {
      schemaVersion: 1,
      ownerId: USER,
      taskId: task.taskId,
      executionId: task.executionId,
      conversationId: task.conversationId,
      agentId: task.agentId,
      sessionId: task.sessionId,
      event: {
        eventId: `cogseed-event-terminal-${task.taskId}`,
        type: 'task.completed',
        payload: { text: 'legacy private payload' },
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    fs.mkdirSync(paths.cogseedPendingResultDeliveriesDirectory(USER), { recursive: true });
    fs.writeFileSync(paths.cogseedPendingResultDeliveryFile(USER, task.executionId!), JSON.stringify(legacy));
    const projectTaskEvent = vi.fn(async () => 'projected');

    await expect(reconciler.reconcileCogSeedExecutionResult(USER, task.executionId!, {
      projectTaskEvent,
      allowInactiveExecutionRecovery: true,
    })).resolves.toMatchObject({ status: 'quarantined', reason: 'legacy-generation-unverified' });
    expect(projectTaskEvent).not.toHaveBeenCalled();
    await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
      status: 'completed',
      resultDeliveryState: 'not-applicable',
    });
    expect(JSON.parse(fs.readFileSync(
      paths.cogseedUndeliverableResultFile(USER, task.executionId!), 'utf8'))).toMatchObject({
      reason: 'legacy-generation-unverified',
      payload: legacy,
    });
  });

  it('retries the quarantine-write-to-pending-remove window idempotently', async () => {
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const deliveries = await backend();
    const reconciler = await import('../../../../src/main/features/cogseed_backend/result-delivery-reconciler');
    const task = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-quarantine-remove-window',
      task: 'Archive before pending cleanup.',
      conversationId: 'cid-quarantine-remove-window',
      agentId: 'agent-quarantine-remove-window',
    })).task;
    await deliveries.cogseedResultDeliveryStore.save(USER, {
      taskId: task.taskId,
      executionId: task.executionId!,
      conversationId: task.conversationId!,
      agentId: task.agentId!,
      sessionId: task.sessionId,
      destinationGeneration: 'cogseed-generation-quarantine-remove-window',
      event: {
        eventId: `cogseed-event-terminal-${task.taskId}`,
        type: 'task.completed',
        payload: { text: 'payload survives quarantine cleanup interruption' },
      },
    });
    let removeAttempts = 0;
    const store = {
      ...deliveries.cogseedResultDeliveryStore,
      removePendingFile: vi.fn(async (...args: Parameters<typeof deliveries.cogseedResultDeliveryStore.removePendingFile>) => {
        removeAttempts += 1;
        if (removeAttempts === 1) throw new Error('pending removal interrupted');
        await deliveries.cogseedResultDeliveryStore.removePendingFile(...args);
      }),
    };

    await expect(reconciler.reconcileCogSeedExecutionResult(USER, task.executionId!, { store }))
      .rejects.toThrow(/pending removal interrupted/i);
    await expect(deliveries.cogseedResultDeliveryStore.read(USER, task.executionId!)).resolves.not.toBeNull();
    expect(JSON.parse(fs.readFileSync(
      paths.cogseedUndeliverableResultFile(USER, task.executionId!), 'utf8'))).toMatchObject({
      reason: 'conversation-missing',
      payload: { event: { payload: { text: 'payload survives quarantine cleanup interruption' } } },
    });
    await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
      resultDeliveryState: 'not-applicable',
    });

    await expect(reconciler.reconcileCogSeedExecutionResult(USER, task.executionId!, { store }))
      .resolves.toMatchObject({ status: 'quarantined' });
    await expect(deliveries.cogseedResultDeliveryStore.read(USER, task.executionId!)).resolves.toBeNull();
    expect(removeAttempts).toBe(2);
  });

  it('quarantines a binding conflict without mutating either possibly unrelated task', async () => {
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const reconciler = await import('../../../../src/main/features/cogseed_backend/result-delivery-reconciler');
    const deliveries = await backend();
    const first = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-binding-conflict-first',
      task: 'First unrelated task.',
      conversationId: 'cid-binding-conflict',
      agentId: 'agent-binding-conflict',
    })).task;
    const second = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-binding-conflict-second',
      task: 'Second unrelated task.',
      conversationId: 'cid-binding-conflict',
      agentId: 'agent-binding-conflict',
    })).task;
    await deliveries.cogseedResultDeliveryStore.save(USER, {
      taskId: second.taskId,
      executionId: first.executionId!,
      conversationId: first.conversationId!,
      agentId: first.agentId!,
      sessionId: first.sessionId,
      destinationGeneration: 'cogseed-generation-binding-conflict',
      event: {
        eventId: `cogseed-event-terminal-${second.taskId}`,
        type: 'task.completed',
        payload: { text: 'must not choose a task to mutate' },
      },
    });

    await expect(reconciler.reconcileCogSeedExecutionResult(USER, first.executionId!))
      .resolves.toMatchObject({ status: 'quarantined', reason: 'task-binding-mismatch' });
    await expect(tasks.readCogSeedTask(USER, first.taskId)).resolves.toEqual(first);
    await expect(tasks.readCogSeedTask(USER, second.taskId)).resolves.toEqual(second);
  });
});
