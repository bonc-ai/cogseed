import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CogSeedAgentRuntimeFacade } from '../../../../src/main/features/cogseed_runtime';
import type { RuntimeEventEnvelope } from '../../../../src/main/features/cogseed_runtime/protocol';

const USER = 'cogseed-controller-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-runtime-controller-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();

});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function eventually(assertion: () => Promise<void> | void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation did not settle before deadline')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function createConversation(conversationId: string): Promise<void> {
  const chats = await import('../../../../src/main/features/chats');
  await chats.createConversation(USER, { conversationId, title: conversationId });
}

async function holdConversationAdmission(conversationId: string): Promise<{
  waitForAttempt(attempt: number): Promise<void>;
  release(): void;
}> {
  const { fileEditLock } = await import('../../../../src/main/util/locks');
  const mutex = fileEditLock(`cogseed-conversation-operation:${USER}:${conversationId}`);
  const releaseLock = await mutex.acquire();
  const runExclusive = mutex.runExclusive.bind(mutex);
  let attempts = 0;
  const waiters = new Map<number, () => void>();
  const runExclusiveSpy = vi.spyOn(mutex, 'runExclusive').mockImplementation((worker, priority?: number) => {
    attempts += 1;
    waiters.get(attempts)?.();
    return runExclusive(worker, priority);
  });
  let released = false;
  return {
    waitForAttempt(attempt) {
      if (attempts >= attempt) return Promise.resolve();
      return new Promise<void>((resolve) => { waiters.set(attempt, resolve); });
    },
    release() {
      if (released) return;
      released = true;
      runExclusiveSpy.mockRestore();
      releaseLock();
    },
  };
}

function runtimeFrom(events: RuntimeEventEnvelope[]): CogSeedAgentRuntimeFacade & { inputs: unknown[] } {
  const inputs: unknown[] = [];
  return {
    inputs,
    async *run(_userId: string, input: unknown) {
      inputs.push(input);
      for (const event of events) yield event;
    },
    async shutdown() {},
  } as CogSeedAgentRuntimeFacade & { inputs: unknown[] };
}

describe('CogSeed Runtime controller', () => {
  it('projects persisted Runtime lifecycle events back to the original Group Chat conversation', async () => {
    await createConversation('cid-projection');
    const runtime = runtimeFrom([
      { type: 'event', request_id: 'req-projection', runtime_session_id: 'mruntime-projection', status: 'running', text: 'working' },
      { type: 'event', request_id: 'req-projection', runtime_session_id: 'mruntime-projection', status: 'running', metadata: { kernel_event: 'tool_call', name: 'read_file' } },
      { type: 'event', request_id: 'req-projection', runtime_session_id: 'mruntime-projection', status: 'running', metadata: { kernel_event: 'tool_result', name: 'read_file', isError: false } },
      { type: 'result', request_id: 'req-projection', runtime_session_id: 'mruntime-projection', status: 'completed', text: 'projected answer' },
    ]);
    const projected: any[] = [];
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createCogSeedRuntimeController({
      runtime,
      projectTaskEvent: vi.fn(async (input) => { projected.push(input); }),
    } as any);

    await controller.startCogSeedTask(USER, {
      requestId: 'req-projection',
      task: 'Project this run.',
      conversationId: 'cid-projection',
      agentId: 'agent-projection',
    });

    await eventually(() => {
      expect(projected.map((item) => item.event.type)).toEqual([
        'task.started',
        'model.delta',
        'tool.started',
        'tool.finished',
        'task.completed',
      ]);
    });
    expect(projected.at(-1)).toMatchObject({
      conversationId: 'cid-projection',
      agentId: 'agent-projection',
      event: { payload: { text: 'projected answer' } },
    });
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, projected.at(-1).taskId)).resolves.toMatchObject({
        status: 'completed',
        resultDeliveryState: 'delivered',
      });
    });
  });

  it('accepts only the first of two completion envelopes for one execution', async () => {
    await createConversation('cid-duplicate-completion');
    const runtime = runtimeFrom([
      { type: 'result', request_id: 'req-duplicate-completion', runtime_session_id: 'mruntime-duplicate-completion', status: 'completed', text: 'first answer wins' },
      { type: 'result', request_id: 'req-duplicate-completion', runtime_session_id: 'mruntime-duplicate-completion', status: 'completed', text: 'duplicate answer must be ignored' },
    ]);
    const deliveries = await import('../../../../src/main/features/cogseed_backend/result-delivery-store');
    const eventsStore = await import('../../../../src/main/features/cogseed_backend/event-store');
    const resultDeliveryStore = {
      ...deliveries.cogseedResultDeliveryStore,
      save: vi.fn((...args: Parameters<typeof deliveries.cogseedResultDeliveryStore.save>) => (
        deliveries.cogseedResultDeliveryStore.save(...args)
      )),
    };
    const projectTaskEvent = vi.fn(async () => 'projected');
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent, resultDeliveryStore } as any);

    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-duplicate-completion',
      task: 'Keep exactly one final answer.',
      conversationId: 'cid-duplicate-completion',
      agentId: 'agent-duplicate-completion',
    });

    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
        status: 'completed',
        resultDeliveryState: 'delivered',
      });
      await expect(controller.runtimeStatus()).resolves.toMatchObject({ activeTaskCount: 0 });
    });
    expect(resultDeliveryStore.save).toHaveBeenCalledTimes(1);
    expect(resultDeliveryStore.save.mock.calls[0]?.[1]).toMatchObject({
      event: { type: 'task.completed', payload: { text: 'first answer wins' } },
    });
    expect(projectTaskEvent.mock.calls
      .filter(([input]) => input.event.type === 'task.completed')).toHaveLength(1);
    const events = await eventsStore.readCogSeedTaskEvents(USER, task.taskId, 0, 100);
    expect(events.filter((event) => event.type === 'task.completed')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('duplicate answer must be ignored');
    await expect(deliveries.cogseedResultDeliveryStore.read(USER, task.executionId!)).resolves.toBeNull();
  });

  it('keeps completion authoritative when the same execution later emits failure', async () => {
    await createConversation('cid-completion-before-failure');
    const runtime = runtimeFrom([
      { type: 'result', request_id: 'req-completion-before-failure', runtime_session_id: 'mruntime-completion-before-failure', status: 'completed', text: 'completed answer' },
      { type: 'error', request_id: 'req-completion-before-failure', runtime_session_id: 'mruntime-completion-before-failure', status: 'failed', error: 'late conflicting failure', metadata: { code: 'late_failure' } },
    ]);
    const deliveries = await import('../../../../src/main/features/cogseed_backend/result-delivery-store');
    const eventsStore = await import('../../../../src/main/features/cogseed_backend/event-store');
    const resultDeliveryStore = {
      ...deliveries.cogseedResultDeliveryStore,
      save: vi.fn((...args: Parameters<typeof deliveries.cogseedResultDeliveryStore.save>) => (
        deliveries.cogseedResultDeliveryStore.save(...args)
      )),
    };
    const projectTaskEvent = vi.fn(async () => 'projected');
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent, resultDeliveryStore } as any);

    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-completion-before-failure',
      task: 'Do not flip a completed execution to failed.',
      conversationId: 'cid-completion-before-failure',
      agentId: 'agent-completion-before-failure',
    });

    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
        status: 'completed',
        resultDeliveryState: 'delivered',
      });
      await expect(controller.runtimeStatus()).resolves.toMatchObject({ activeTaskCount: 0 });
    });
    expect(resultDeliveryStore.save).toHaveBeenCalledTimes(1);
    expect(projectTaskEvent.mock.calls
      .filter(([input]) => input.event.type === 'task.completed')).toHaveLength(1);
    expect(projectTaskEvent.mock.calls
      .some(([input]) => input.event.type === 'task.failed')).toBe(false);
    const events = await eventsStore.readCogSeedTaskEvents(USER, task.taskId, 0, 100);
    expect(events.filter((event) => event.type === 'task.completed')).toHaveLength(1);
    expect(events.some((event) => event.type === 'task.failed')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('late conflicting failure');
    await expect(deliveries.cogseedResultDeliveryStore.read(USER, task.executionId!)).resolves.toBeNull();
  });

  it('retains a terminal result as pending recovery when conversation writeback fails', async () => {
    await createConversation('cid-projection-recovery');
    const runtime = runtimeFrom([
      { type: 'result', request_id: 'req-projection-recovery', runtime_session_id: 'mruntime-projection-recovery', status: 'completed', text: 'retained answer' },
    ]);
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const deliveries = await import('../../../../src/main/features/cogseed_backend/result-delivery-store');
    let writebackAvailable = false;
    let rejectInitialWriteback!: () => void;
    const initialWritebackRejected = new Promise<void>((resolve) => { rejectInitialWriteback = resolve; });
    const projectTaskEvent = vi.fn(async (input: any) => {
      if (input.event.type === 'task.completed' && !writebackAvailable) {
        rejectInitialWriteback();
        throw new Error('writeback unavailable');
      }
      return 'projected';
    });
    const controller = createCogSeedRuntimeController({
      runtime,
      projectTaskEvent,
    } as any);

    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-projection-recovery',
      task: 'Retain this result.',
      conversationId: 'cid-projection-recovery',
      agentId: 'agent-projection-recovery',
    });

    await initialWritebackRejected;
    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
        status: 'completed',
        resultDeliveryState: 'pending-recovery',
      });
    });
    const pending = await deliveries.cogseedResultDeliveryStore.read(USER, task.executionId!);
    expect(pending).toMatchObject({
      taskId: task.taskId,
      executionId: task.executionId,
      conversationId: 'cid-projection-recovery',
      event: { type: 'task.completed', payload: { text: 'retained answer' } },
    });

    writebackAvailable = true;
    const [firstRecovery, duplicateRecovery] = await Promise.all([
      controller.retryCogSeedResultDelivery(USER, task.taskId),
      controller.retryCogSeedResultDelivery(USER, task.taskId),
    ]);
    expect(firstRecovery).toMatchObject({ status: 'completed', resultDeliveryState: 'delivered' });
    expect(duplicateRecovery).toEqual(firstRecovery);
    await expect(controller.retryCogSeedResultDelivery(USER, task.taskId)).resolves.toMatchObject({ resultDeliveryState: 'delivered' });
    await expect(deliveries.cogseedResultDeliveryStore.read(USER, task.executionId!)).resolves.toBeNull();
    expect(projectTaskEvent.mock.calls.filter(([input]) => input.event.type === 'task.completed')).toHaveLength(2);
  });

  it('single-flights retained-result recovery against cancellation and retry', async () => {
    await createConversation('cid-result-recovery-race');
    const runtime = runtimeFrom([
      { type: 'result', request_id: 'req-result-recovery-race', runtime_session_id: 'mruntime-result-recovery-race', status: 'completed', text: 'authoritative retained answer' },
    ]);
    const deliveries = await import('../../../../src/main/features/cogseed_backend/result-delivery-store');
    let outboxReads = 0;
    let retryObservedOutbox!: () => void;
    const retryRead = new Promise<void>((resolve) => { retryObservedOutbox = resolve; });
    const resultDeliveryStore = {
      ...deliveries.cogseedResultDeliveryStore,
      read: vi.fn(async (...args: Parameters<typeof deliveries.cogseedResultDeliveryStore.read>) => {
        const pending = await deliveries.cogseedResultDeliveryStore.read(...args);
        outboxReads += 1;
        if (outboxReads === 2) retryObservedOutbox();
        return pending;
      }),
    };
    let initialWritebackFailed = false;
    let recoveryEntered!: () => void;
    let releaseRecovery!: () => void;
    const entered = new Promise<void>((resolve) => { recoveryEntered = resolve; });
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const projectTaskEvent = vi.fn(async (input: any) => {
      if (input.event.type !== 'task.completed') return 'projected';
      if (!initialWritebackFailed) {
        initialWritebackFailed = true;
        throw new Error('initial conversation writeback failed');
      }
      recoveryEntered();
      await recoveryGate;
      return 'projected';
    });
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent, resultDeliveryStore } as any);

    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-result-recovery-race',
      task: 'Recover this retained result once.',
      conversationId: 'cid-result-recovery-race',
      agentId: 'agent-result-recovery-race',
    });
    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
        status: 'completed',
        resultDeliveryState: 'pending-recovery',
      });
      await expect(controller.runtimeStatus()).resolves.toMatchObject({ activeTaskCount: 0 });
    });

    const recovering = controller.retryCogSeedResultDelivery(USER, task.taskId);
    await entered;
    const retrying = controller.retryCogSeedTask(USER, task.taskId, 'req-result-recovery-race-retry');
    await retryRead;
    const cancelling = controller.cancelCogSeedTask(USER, task.taskId);
    await new Promise((resolve) => setImmediate(resolve));
    releaseRecovery();

    const [recovered, retried, cancelled] = await Promise.all([recovering, retrying, cancelling]);
    expect(recovered).toMatchObject({ taskId: task.taskId, status: 'completed', resultDeliveryState: 'delivered' });
    expect(retried).toEqual(recovered);
    expect(cancelled).toEqual(recovered);
    await expect(tasks.listCogSeedTasks(USER)).resolves.toHaveLength(1);
    expect(runtime.inputs).toHaveLength(1);
    expect(projectTaskEvent.mock.calls
      .filter(([input]) => input.event.type === 'task.completed')).toHaveLength(2);
    expect(projectTaskEvent.mock.calls
      .some(([input]) => input.event.type === 'task.cancelled')).toBe(false);
    await expect(deliveries.cogseedResultDeliveryStore.read(USER, task.executionId!)).resolves.toBeNull();
  });

  it('recovers a retained result after terminal lifecycle persistence fails', async () => {
    await createConversation('cid-terminal-persistence-recovery');
    const storagePath = '../../../../src/main/storage';
    const actualStorage = await vi.importActual<typeof import('../../../../src/main/storage')>(storagePath);
    let failureInjected = false;
    const appendJsonlAtomic = vi.fn(async (...args: Parameters<typeof actualStorage.appendJsonlAtomic>) => {
      const record = args[1] as { type?: unknown };
      if (!failureInjected && record?.type === 'task.completed') {
        failureInjected = true;
        throw new Error('terminal lifecycle append interrupted');
      }
      return actualStorage.appendJsonlAtomic(...args);
    });
    vi.doMock(storagePath, () => ({ ...actualStorage, appendJsonlAtomic }));

    try {
      const runtime = runtimeFrom([
        { type: 'result', request_id: 'req-terminal-persistence-recovery', runtime_session_id: 'mruntime-terminal-persistence-recovery', status: 'completed', text: 'retained across lifecycle failure' },
      ]);
      const projectTaskEvent = vi.fn(async () => 'projected');
      const deliveries = await import('../../../../src/main/features/cogseed_backend/result-delivery-store');
      const eventsStore = await import('../../../../src/main/features/cogseed_backend/event-store');
      const resultDeliveryStore = {
        ...deliveries.cogseedResultDeliveryStore,
        save: vi.fn((...args: Parameters<typeof deliveries.cogseedResultDeliveryStore.save>) => (
          deliveries.cogseedResultDeliveryStore.save(...args)
        )),
      };
      const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
      const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
      const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent, resultDeliveryStore } as any);

      const task = await controller.startCogSeedTask(USER, {
        requestId: 'req-terminal-persistence-recovery',
        task: 'Retain the result before the terminal lifecycle write.',
        conversationId: 'cid-terminal-persistence-recovery',
        agentId: 'agent-terminal-persistence-recovery',
      });
      await eventually(async () => {
        await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
          status: 'recoverable',
          resultDeliveryState: 'pending',
        });
        await expect(controller.runtimeStatus()).resolves.toMatchObject({ activeTaskCount: 0 });
      });
      expect(failureInjected).toBe(true);
      expect(resultDeliveryStore.save).toHaveBeenCalledTimes(1);
      await expect(deliveries.cogseedResultDeliveryStore.read(USER, task.executionId!)).resolves.toMatchObject({
        taskId: task.taskId,
        event: { type: 'task.completed', payload: { text: 'retained across lifecycle failure' } },
      });
      expect(projectTaskEvent.mock.calls
        .some(([input]) => input.event.type === 'task.completed')).toBe(false);

      const recovered = await controller.retryCogSeedResultDelivery(USER, task.taskId);
      expect(recovered).toMatchObject({
        taskId: task.taskId,
        status: 'completed',
        resultDeliveryState: 'delivered',
      });
      await expect(controller.retryCogSeedResultDelivery(USER, task.taskId)).resolves.toEqual(recovered);
      await expect(deliveries.cogseedResultDeliveryStore.read(USER, task.executionId!)).resolves.toBeNull();
      expect(projectTaskEvent.mock.calls
        .filter(([input]) => input.event.type === 'task.completed')).toHaveLength(1);
      const events = await eventsStore.readCogSeedTaskEvents(USER, task.taskId, 0, 100);
      expect(events.filter((event) => event.type === 'task.completed')).toHaveLength(1);
    } finally {
      vi.doUnmock(storagePath);
    }
  });

  it('does not mark a terminal task complete when its result cannot be retained', async () => {
    const runtime = runtimeFrom([
      { type: 'result', request_id: 'req-retention-failure', runtime_session_id: 'mruntime-retention-failure', status: 'completed', text: 'must stay recoverable' },
    ]);
    const projectTaskEvent = vi.fn(async () => 'projected');
    const resultDeliveryStore = {
      save: vi.fn(async () => { throw new Error('disk unavailable'); }),
      read: vi.fn(async () => null),
      remove: vi.fn(async () => undefined),
      clearForConversation: vi.fn(async () => undefined),
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent, resultDeliveryStore } as any);

    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-retention-failure',
      task: 'Retain before completing.',
      conversationId: 'cid-retention-failure',
      agentId: 'agent-retention-failure',
    });

    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
        status: 'recoverable',
        errorCode: 'result_retention_failed',
      });
    });
    expect(projectTaskEvent.mock.calls.some(([input]) => input.event.type === 'task.completed')).toBe(false);
  });

  it('marks delivery complete before cleanup and retries leftover cleanup without writing a second reply', async () => {
    await createConversation('cid-cleanup-order');
    const runtime = runtimeFrom([
      { type: 'result', request_id: 'req-cleanup-order', runtime_session_id: 'mruntime-cleanup-order', status: 'completed', text: 'one visible reply' },
    ]);
    const deliveries = await import('../../../../src/main/features/cogseed_backend/result-delivery-store');
    let removeAttempts = 0;
    const resultDeliveryStore = {
      ...deliveries.cogseedResultDeliveryStore,
      remove: vi.fn(async (userId: string, executionId: string) => {
        removeAttempts += 1;
        if (removeAttempts === 1) throw new Error('cleanup interrupted');
        await deliveries.cogseedResultDeliveryStore.remove(userId, executionId);
      }),
    };
    const projectTaskEvent = vi.fn(async () => 'projected');
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent, resultDeliveryStore } as any);

    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-cleanup-order',
      task: 'Deliver once.',
      conversationId: 'cid-cleanup-order',
      agentId: 'agent-cleanup-order',
    });

    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({ resultDeliveryState: 'delivered' });
    });
    await expect(deliveries.cogseedResultDeliveryStore.read(USER, task.executionId!)).resolves.not.toBeNull();
    await expect(controller.retryCogSeedResultDelivery(USER, task.taskId)).resolves.toMatchObject({ resultDeliveryState: 'delivered' });
    await expect(deliveries.cogseedResultDeliveryStore.read(USER, task.executionId!)).resolves.toBeNull();
    expect(projectTaskEvent.mock.calls.filter(([input]) => input.event.type === 'task.completed')).toHaveLength(1);
  });

  it('replays project-to-delivered interruption without duplicating the visible result', async () => {
    await createConversation('cid-project-delivered-window');
    const taskStorePath = '../../../../src/main/features/cogseed_backend/task-store';
    const actualTaskStore = await vi.importActual<typeof import('../../../../src/main/features/cogseed_backend/task-store')>(taskStorePath);
    let failDeliveredWrite = true;
    vi.doMock(taskStorePath, () => ({
      ...actualTaskStore,
      updateCogSeedTask: vi.fn(async (userId: string, taskId: string, mutate: any) => {
        const current = await actualTaskStore.readCogSeedTask(userId, taskId);
        if (!current) throw new Error('CogSeed task not found');
        const next = await mutate(current);
        if (failDeliveredWrite && next.resultDeliveryState === 'delivered') {
          failDeliveredWrite = false;
          throw new Error('delivered task write interrupted');
        }
        return actualTaskStore.updateCogSeedTask(userId, taskId, () => next);
      }),
    }));

    try {
      const visibleEventIds = new Set<string>();
      const visibleResults: string[] = [];
      const projectTaskEvent = vi.fn(async (input: any) => {
        if (input.event.type === 'task.completed' && !visibleEventIds.has(input.event.eventId)) {
          visibleEventIds.add(input.event.eventId);
          visibleResults.push(input.event.payload.text);
        }
        return 'projected';
      });
      const runtime = runtimeFrom([
        { type: 'result', request_id: 'req-project-delivered-window', runtime_session_id: 'mruntime-project-delivered-window', status: 'completed', text: 'one idempotent result' },
      ]);
      const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
      const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent });
      const task = await controller.startCogSeedTask(USER, {
        requestId: 'req-project-delivered-window',
        task: 'Recover after projection before delivery state.',
        conversationId: 'cid-project-delivered-window',
        agentId: 'agent-project-delivered-window',
      });
      await eventually(async () => {
        await expect(actualTaskStore.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
          status: 'completed',
          resultDeliveryState: 'pending-recovery',
        });
      });

      await expect(controller.retryCogSeedResultDelivery(USER, task.taskId)).resolves.toMatchObject({
        resultDeliveryState: 'delivered',
      });
      expect(projectTaskEvent.mock.calls.filter(([input]) => input.event.type === 'task.completed')).toHaveLength(2);
      expect(visibleResults).toEqual(['one idempotent result']);
    } finally {
      vi.doUnmock(taskStorePath);
    }
  });

  it('serializes completion against cancellation and never deletes an already retained final result', async () => {
    await createConversation('cid-complete-cancel');
    const runtime = runtimeFrom([
      { type: 'result', request_id: 'req-complete-cancel', runtime_session_id: 'mruntime-complete-cancel', status: 'completed', text: 'retained winner' },
    ]);
    const deliveries = await import('../../../../src/main/features/cogseed_backend/result-delivery-store');
    let saveEntered!: () => void;
    let releaseSave!: () => void;
    const entered = new Promise<void>((resolve) => { saveEntered = resolve; });
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    const resultDeliveryStore = {
      ...deliveries.cogseedResultDeliveryStore,
      save: vi.fn(async (...args: Parameters<typeof deliveries.cogseedResultDeliveryStore.save>) => {
        saveEntered();
        await saveGate;
        return deliveries.cogseedResultDeliveryStore.save(...args);
      }),
    };
    const projectTaskEvent = vi.fn(async (input: any) => {
      if (input.event.type === 'task.completed') throw new Error('writeback remains unavailable');
      return 'projected';
    });
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent, resultDeliveryStore } as any);

    const started = await controller.startCogSeedTask(USER, {
      requestId: 'req-complete-cancel',
      task: 'Retain the final result before choosing a terminal state.',
      conversationId: 'cid-complete-cancel',
      agentId: 'agent-complete-cancel',
    });
    await entered;
    const cancelling = controller.cancelCogSeedTask(USER, started.taskId);
    releaseSave();

    await expect(cancelling).resolves.toMatchObject({ status: 'completed' });
    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, started.taskId)).resolves.toMatchObject({
        status: 'completed',
        resultDeliveryState: 'pending-recovery',
      });
    });
    await expect(deliveries.cogseedResultDeliveryStore.read(USER, started.executionId!)).resolves.toMatchObject({
      taskId: started.taskId,
      event: { type: 'task.completed', payload: { text: 'retained winner' } },
    });
    expect(projectTaskEvent.mock.calls.some(([input]) => input.event.type === 'task.cancelled')).toBe(false);
  });

  it('does not recover or project a retained result while its executor is still running', async () => {
    await createConversation('cid-no-early-recovery');
    let signalSeen: AbortSignal | null = null;
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, _input, options) {
        signalSeen = options?.signal ?? null;
        await new Promise<void>((resolve) => signalSeen?.addEventListener('abort', () => resolve(), { once: true }));
      },
      async shutdown() {},
    } as CogSeedAgentRuntimeFacade;
    const deliveries = await import('../../../../src/main/features/cogseed_backend/result-delivery-store');
    const projectTaskEvent = vi.fn(async () => 'projected');
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent });
    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-no-early-recovery',
      task: 'Remain active until cancelled.',
      conversationId: 'cid-no-early-recovery',
      agentId: 'agent-no-early-recovery',
    });
    await eventually(() => expect(signalSeen).not.toBeNull());
    await deliveries.cogseedResultDeliveryStore.save(USER, {
      taskId: task.taskId,
      executionId: task.executionId!,
      conversationId: task.conversationId!,
      agentId: task.agentId!,
      sessionId: task.sessionId,
      destinationGeneration: (await (await import('../../../../src/main/features/chats'))
        .ensureCogSeedConversationDeliveryGeneration(USER, task.conversationId!))!,
      event: {
        eventId: `cogseed-event-terminal-${task.taskId}`,
        type: 'task.completed',
        payload: { text: 'must not be delivered early' },
      },
    });

    await expect(controller.retryCogSeedResultDelivery(USER, task.taskId))
      .rejects.toThrow(/before execution is recoverable/i);
    expect(projectTaskEvent.mock.calls.some(([input]) => input.event.type === 'task.completed')).toBe(false);
    await controller.cancelCogSeedTask(USER, task.taskId);
  });

  it('finalizes a recoverable task from its retained result before writing the reply', async () => {
    await createConversation('cid-finalize-retained');
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run() { throw new Error('terminal transition was interrupted'); },
      async shutdown() {},
    } as CogSeedAgentRuntimeFacade;
    const deliveries = await import('../../../../src/main/features/cogseed_backend/result-delivery-store');
    const projectTaskEvent = vi.fn(async () => 'projected');
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent });
    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-finalize-retained',
      task: 'Recover the retained completion.',
      conversationId: 'cid-finalize-retained',
      agentId: 'agent-finalize-retained',
    });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, task.taskId)).toMatchObject({ status: 'recoverable' }));
    await deliveries.cogseedResultDeliveryStore.save(USER, {
      taskId: task.taskId,
      executionId: task.executionId!,
      conversationId: task.conversationId!,
      agentId: task.agentId!,
      sessionId: task.sessionId,
      destinationGeneration: (await (await import('../../../../src/main/features/chats'))
        .ensureCogSeedConversationDeliveryGeneration(USER, task.conversationId!))!,
      event: {
        eventId: `cogseed-event-terminal-${task.taskId}`,
        type: 'task.completed',
        payload: { text: 'retained completion' },
      },
    });

    await expect(controller.retryCogSeedResultDelivery(USER, task.taskId)).resolves.toMatchObject({
      status: 'completed',
      resultDeliveryState: 'delivered',
    });
    await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
      status: 'completed',
      resultDeliveryState: 'delivered',
    });
    expect(projectTaskEvent.mock.calls.filter(([input]) => input.event.type === 'task.completed')).toHaveLength(1);
  });

  it('routes local-cli tasks through the Backend adapter without invoking native Runtime', async () => {
    const runtime = runtimeFrom([]);
    const localCliAdapter = {
      async *run(input: any) {
        yield { type: 'event', request_id: input.requestId, runtime_session_id: input.runtimeSessionId, status: 'running', text: 'cli working' };
        yield { type: 'result', request_id: input.requestId, runtime_session_id: input.runtimeSessionId, status: 'completed', text: 'cli done' };
      },
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime, localCliAdapter } as any);
    await createConversation('cid-cli-controller');

    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-cli-controller',
      task: 'Run the CLI Agent.',
      conversationId: 'cid-cli-controller',
      agentId: 'agent-cli-controller',
      executionKind: 'local-cli',
      localCli: { cli: 'claude' },
    } as any);

    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({ status: 'completed' });
    });
    expect(runtime.inputs).toEqual([]);
  });

  it('rejects a local CLI execution unless its Conversation actually exists', async () => {
    let adapterRuns = 0;
    const localCliAdapter = {
      async *run() {
        adapterRuns += 1;
        yield { type: 'result', request_id: 'req-cli-no-conversation', runtime_session_id: 'mruntime-cli-no-conversation', status: 'completed', text: 'must not run' };
      },
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime: runtimeFrom([]), localCliAdapter } as any);

    await expect(controller.startCogSeedTask(USER, {
      requestId: 'req-cli-no-conversation',
      task: 'A CLI requires a Conversation.',
      conversationId: 'cid-cli-missing',
      agentId: 'agent-cli-no-conversation',
      executionKind: 'local-cli',
      localCli: { cli: 'codex' },
    })).rejects.toThrow(/conversation is unavailable/i);

    await expect(tasks.listCogSeedTasks(USER)).resolves.toEqual([]);
    expect(adapterRuns).toBe(0);
  });

  it('admits a session-derived local CLI Conversation and persists the binding', async () => {
    const adapterInputs: any[] = [];
    const localCliAdapter = {
      async *run(input: any) {
        adapterInputs.push(input);
        yield {
          type: 'result',
          request_id: input.requestId,
          runtime_session_id: input.runtimeSessionId,
          status: 'completed',
          text: 'session-derived run completed',
        };
      },
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime: runtimeFrom([]), localCliAdapter } as any);
    await createConversation('cid-session-derived');

    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-cli-session-derived',
      task: 'Use the Conversation encoded by the member Session.',
      sessionId: 'gmember-cid-session-derived-agentderived',
      agentId: 'agentderived',
      executionKind: 'local-cli',
      localCli: { cli: 'codex' },
    });

    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
        status: 'completed',
        conversationId: 'cid-session-derived',
      });
    });
    expect(adapterInputs).toEqual([expect.objectContaining({ conversationId: 'cid-session-derived' })]);
  });

  it('does not let session-derived admission bypass an in-progress Conversation deletion', async () => {
    let adapterRuns = 0;
    const localCliAdapter = {
      async *run() {
        adapterRuns += 1;
        yield {
          type: 'result',
          request_id: 'req-cli-session-deleting',
          runtime_session_id: 'mruntime-cli-session-deleting',
          status: 'completed',
          text: 'must not run',
        };
      },
    };
    const guards = await import('../../../../src/main/features/cogseed_backend/conversation-operation-guard');
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime: runtimeFrom([]), localCliAdapter } as any);
    await createConversation('cid-session-deleting');
    let releaseDeletion!: () => void;
    let deletionEntered!: () => void;
    const deletionGate = new Promise<void>((resolve) => { releaseDeletion = resolve; });
    const entered = new Promise<void>((resolve) => { deletionEntered = resolve; });
    const deleting = guards.withCogSeedConversationDeletion(USER, 'cid-session-deleting', async () => {
      deletionEntered();
      await deletionGate;
      return true;
    });
    await entered;

    const starting = controller.startCogSeedTask(USER, {
      requestId: 'req-cli-session-deleting',
      task: 'Do not cross the deletion boundary.',
      sessionId: 'gmember-cid-session-deleting-agentdeleting',
      agentId: 'agentdeleting',
      executionKind: 'local-cli',
      localCli: { cli: 'codex' },
    });
    releaseDeletion();

    await expect(deleting).resolves.toBe(true);
    await expect(starting).rejects.toThrow(/conversation is unavailable/i);
    await expect(tasks.listCogSeedTasks(USER)).resolves.toEqual([]);
    expect(adapterRuns).toBe(0);
  });

  it('rechecks local CLI Conversation admission immediately before the deferred executor starts', async () => {
    let adapterRuns = 0;
    const localCliAdapter = {
      async *run() {
        adapterRuns += 1;
        yield {
          type: 'result',
          request_id: 'req-cli-deleted-before-run',
          runtime_session_id: 'mruntime-cli-deleted-before-run',
          status: 'completed',
          text: 'must not run',
        };
      },
    };
    const guards = await import('../../../../src/main/features/cogseed_backend/conversation-operation-guard');
    const projectTaskEvent = vi.fn(async (input: any) => {
      if (input.event.type === 'task.started') {
        await guards.withCogSeedConversationDeletion(USER, 'cid-deleted-before-run', async () => true);
      }
      return 'projected';
    });
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({
      runtime: runtimeFrom([]),
      localCliAdapter,
      projectTaskEvent,
    } as any);
    await createConversation('cid-deleted-before-run');

    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-cli-deleted-before-run',
      task: 'Recheck admission at execution time.',
      conversationId: 'cid-deleted-before-run',
      agentId: 'agent-deleted-before-run',
      executionKind: 'local-cli',
      localCli: { cli: 'codex' },
    });

    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
        status: 'recoverable',
        errorCode: 'runtime_worker_error',
      });
    });
    expect(adapterRuns).toBe(0);
  });

  it('persists and restores the explicit handoff execution context across retry', async () => {
    let runs = 0;
    const adapterInputs: any[] = [];
    const localCliAdapter = {
      async *run(input: any) {
        adapterInputs.push(input);
        runs += 1;
        if (runs === 1) throw new Error('wake worker crashed');
        yield {
          type: 'result',
          request_id: input.requestId,
          runtime_session_id: input.runtimeSessionId,
          status: 'completed',
          text: 'retried gateway task',
        };
      },
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime: runtimeFrom([]), localCliAdapter } as any);
    await createConversation('cid-wake-context');

    const original = await controller.startCogSeedTask(USER, {
      requestId: 'req-wake-context-original',
      task: 'Use the approved handoff context.',
      conversationId: 'cid-wake-context',
      agentId: 'agent-wake-context',
      executionKind: 'local-cli',
      localCli: { cli: 'claude', viaP3394Gateway: true },
      abilityAssetIds: ['asset-approved', 'asset-approved'],
      workingDir: '/tmp/approved-handoff-workspace',
    } as any);

    await eventually(async () => expect(await tasks.readCogSeedTask(USER, original.taskId)).toMatchObject({ status: 'recoverable' }));
    expect(await tasks.readCogSeedTask(USER, original.taskId)).toMatchObject({
      abilityAssetIds: ['asset-approved'],
      workingDir: '/tmp/approved-handoff-workspace',
    });

    const retried = await controller.retryCogSeedTask(USER, original.taskId, 'req-wake-context-retry');
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, retried.taskId)).toMatchObject({ status: 'completed' }));
    expect(adapterInputs).toHaveLength(2);
    expect(adapterInputs[0]).toMatchObject({
      abilityAssetIds: ['asset-approved'],
      workingDir: '/tmp/approved-handoff-workspace',
    });
    expect(adapterInputs[1]).toMatchObject({
      abilityAssetIds: ['asset-approved'],
      workingDir: '/tmp/approved-handoff-workspace',
    });
  });

  it('keeps Agent identity separate from the optional model profile', async () => {
    const runtime = runtimeFrom([
      { type: 'result', request_id: 'req-agent-identity', runtime_session_id: 'mruntime-agent-identity', status: 'completed', text: 'done' },
    ]);
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createCogSeedRuntimeController({ runtime });

    await controller.startCogSeedTask(USER, {
      requestId: 'req-agent-identity',
      task: 'Use the formal Agent identity.',
      agentId: 'agent-identity',
    });

    await eventually(() => {
      expect(runtime.inputs).toEqual([expect.objectContaining({ agent_id: 'agent-identity' })]);
      expect(runtime.inputs[0]).not.toHaveProperty('model_profile');
    });
  });

  it('returns a running task immediately, consumes Runtime events in the background, and never re-runs a duplicate request', async () => {
    const runtime = runtimeFrom([
      { type: 'event', request_id: 'req-controller', runtime_session_id: 'mruntime-controller', status: 'started' },
      { type: 'event', request_id: 'req-controller', runtime_session_id: 'mruntime-controller', status: 'running', text: 'thinking' },
      { type: 'event', request_id: 'req-controller', runtime_session_id: 'mruntime-controller', status: 'running', metadata: { kernel_event: 'tool_call', name: 'read_file' } },
      { type: 'event', request_id: 'req-controller', runtime_session_id: 'mruntime-controller', status: 'running', metadata: { kernel_event: 'artifact', uri: 'p3394-object:sha256:abc', digest: 'abc', name: 'report.md', media_type: 'text/markdown', secret: 'must-not-cross' } },
      { type: 'result', request_id: 'req-controller', runtime_session_id: 'mruntime-controller', status: 'completed', text: 'final answer' },
    ]);
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });

    const first = await controller.startCogSeedTask(USER, {
      requestId: 'req-controller',
      task: 'Read the file.',
      agentId: 'agent-controller',
      profileId: 'openai-compatible:cogseed',
    });
    const duplicate = await controller.startCogSeedTask(USER, {
      requestId: 'req-controller',
      task: 'Read the file.',
      agentId: 'agent-controller',
      profileId: 'openai-compatible:cogseed',
    });

    expect(first.status).toBe('running');
    expect(duplicate.taskId).toBe(first.taskId);
    expect(runtime.inputs).toEqual([expect.objectContaining({
      task: 'Read the file.',
      agent_id: 'agent-controller',
      model_profile: 'openai-compatible:cogseed',
    })]);
    await expect(controller.startCogSeedTask(USER, {
      requestId: 'req-controller',
      task: 'This must not execute again.',
    })).rejects.toThrow(/payload conflict/i);

    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, first.taskId)).resolves.toMatchObject({ status: 'completed' });
    });
    await eventually(async () => {
      await expect(events.readCogSeedTaskEvents(USER, first.taskId, 0, 20)).resolves.toEqual([
        expect.objectContaining({ type: 'task.created' }),
        expect.objectContaining({ type: 'task.queued' }),
        expect.objectContaining({ type: 'task.started' }),
        expect.objectContaining({ type: 'model.delta', payload: { text: 'thinking' } }),
        expect.objectContaining({ type: 'tool.started', payload: { name: 'read_file' } }),
        expect.objectContaining({ type: 'artifact', payload: { uri: 'p3394-object:sha256:abc', digest: 'abc', name: 'report.md', media_type: 'text/markdown' } }),
        expect.objectContaining({ type: 'task.completed', payload: { outputChars: 12 } }),
      ]);
    });
  });

  it('does not launch after cancellation wins while the started projection is still pending', async () => {
    const runtime = runtimeFrom([
      { type: 'result', request_id: 'req-cancel-launch', runtime_session_id: 'mruntime-cancel-launch', status: 'completed', text: 'must not run' },
    ]);
    let releaseStarted!: () => void;
    let startedProjectionEntered!: () => void;
    const startedEntered = new Promise<void>((resolve) => { startedProjectionEntered = resolve; });
    const startedGate = new Promise<void>((resolve) => { releaseStarted = resolve; });
    const projectTaskEvent = vi.fn(async (input: any) => {
      if (input.event.type === 'task.started') {
        startedProjectionEntered();
        await startedGate;
      }
      return 'projected';
    });
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent });

    const starting = controller.startCogSeedTask(USER, {
      requestId: 'req-cancel-launch',
      task: 'Cancel before process launch.',
      conversationId: 'cid-cancel-launch',
      agentId: 'agent-cancel-launch',
    });
    await startedEntered;
    const persisted = (await tasks.listCogSeedTasks(USER)).find((task) => task.requestId === 'req-cancel-launch');
    expect(persisted).toBeDefined();
    const cancelResult = await controller.cancelCogSeedTask(USER, persisted!.taskId);
    releaseStarted();

    const startResult = await starting;
    expect(startResult.status).toBe('cancelled');
    expect(cancelResult.status).toBe('cancelled');
    expect(runtime.inputs).toEqual([]);
    await expect(controller.runtimeStatus()).resolves.toMatchObject({ activeTaskCount: 0 });
  });

  it('marks a task recoverable when the Runtime stream exits without a terminal event', async () => {
    const runtime = runtimeFrom([]);
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });

    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-empty-stream',
      task: 'Do not remain running after process exit.',
    });

    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
        status: 'recoverable',
        errorCode: 'runtime_stream_ended',
      });
    });
  });

  it('cancels a background task through its own AbortController without fallback or retry', async () => {
    let signalSeen: AbortSignal | null = null;
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, _input, opts) {
        signalSeen = opts?.signal ?? null;
        await new Promise<void>((resolve) => signalSeen?.addEventListener('abort', () => resolve(), { once: true }));
        yield { type: 'error', request_id: 'req-cancel', runtime_session_id: 'mruntime-cancel', status: 'cancelled', error: 'cancelled' };
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const controller = createCogSeedRuntimeController({ runtime });

    const task = await controller.startCogSeedTask(USER, { requestId: 'req-cancel', task: 'Wait until cancelled.' });
    await eventually(() => expect(signalSeen).not.toBeNull());
    const cancelled = await controller.cancelCogSeedTask(USER, task.taskId);

    expect(cancelled.status).toBe('cancelled');
    expect(signalSeen?.aborted).toBe(true);
    await eventually(async () => {
      await expect(events.readCogSeedTaskEvents(USER, task.taskId, 0, 20)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'task.cancelled' }),
      ]));
    });
  });

  it('aborts the executor and returns cancellation without waiting for a hanging projection', async () => {
    let signalSeen: AbortSignal | null = null;
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, input: any, options) {
        signalSeen = options?.signal ?? null;
        await new Promise<void>((resolve) => signalSeen?.addEventListener('abort', () => resolve(), { once: true }));
        yield {
          type: 'error',
          request_id: input.request_id,
          runtime_session_id: input.runtime_session_id,
          status: 'cancelled',
          error: 'cancelled',
        };
      },
      async shutdown() {},
    };
    let cancellationProjectionEntered!: () => void;
    const projectionEntered = new Promise<void>((resolve) => { cancellationProjectionEntered = resolve; });
    const projectTaskEvent = vi.fn(async (input: any) => {
      if (input.event.type === 'task.cancelled') {
        cancellationProjectionEntered();
        await new Promise<void>(() => {});
      }
      return 'projected';
    });
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent });
    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-cancel-hanging-projection',
      task: 'Cancel without waiting for projection.',
      conversationId: 'cid-cancel-hanging-projection',
      agentId: 'agent-cancel-hanging-projection',
    });
    await eventually(() => expect(signalSeen).not.toBeNull());

    const cancelled = await controller.cancelCogSeedTask(USER, task.taskId);
    await projectionEntered;

    expect(cancelled.status).toBe('cancelled');
    expect(signalSeen?.aborted).toBe(true);
  });

  it('single-flights concurrent cancellation and drops Runtime activity that arrives after the terminal event', async () => {
    let signalSeen: AbortSignal | null = null;
    let releaseLateEvent!: () => void;
    const lateEventGate = new Promise<void>((resolve) => { releaseLateEvent = resolve; });
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, input: any, opts) {
        signalSeen = opts?.signal ?? null;
        await lateEventGate;
        yield {
          type: 'event',
          request_id: input.request_id,
          runtime_session_id: input.runtime_session_id,
          status: 'running',
          text: 'late activity must be dropped',
        };
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const projectTaskEvent = vi.fn(async () => 'projected');
    const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent });
    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-concurrent-cancel',
      task: 'Cancel exactly once.',
      conversationId: 'cid-concurrent-cancel',
      agentId: 'agent-concurrent-cancel',
    });
    await eventually(() => expect(signalSeen).not.toBeNull());

    const [first, duplicate] = await Promise.all([
      controller.cancelCogSeedTask(USER, task.taskId),
      controller.cancelCogSeedTask(USER, task.taskId),
    ]);
    releaseLateEvent();

    expect(first).toEqual(duplicate);
    expect(first.status).toBe('cancelled');
    await eventually(async () => {
      const stored = await events.readCogSeedTaskEvents(USER, task.taskId, 0, 20);
      expect(stored.filter((event) => event.type === 'task.cancelled')).toHaveLength(1);
      expect(stored.some((event) => event.type === 'model.delta')).toBe(false);
    });
    expect(projectTaskEvent.mock.calls.filter(([input]) => input.event.type === 'task.cancelled')).toHaveLength(1);
  });

  it('persists a safe runtime failure code for renderer task details', async () => {
    const runtime = runtimeFrom([
      {
        type: 'error',
        request_id: 'req-runtime-failure-code',
        runtime_session_id: 'mruntime-runtime-failure-code',
        status: 'failed',
        error: 'Provider request failed.',
        metadata: { code: 'provider_timeout' },
      },
    ]);
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });

    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-runtime-failure-code',
      task: 'This private prompt must not become the renderer title.',
    });

    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
        status: 'failed',
        errorCode: 'provider_timeout',
      });
    });
  });

  it('cancels every non-terminal Backend task for a conversation without touching other conversations', async () => {
    const signals = new Map<string, AbortSignal>();
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, input, opts) {
        signals.set(String((input as any).request_id), opts?.signal as AbortSignal);
        await new Promise<void>((resolve) => opts?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        yield { type: 'error', request_id: String((input as any).request_id), runtime_session_id: String((input as any).runtime_session_id), status: 'cancelled', error: 'cancelled' };
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent: vi.fn(async () => {}) });
    const first = await controller.startCogSeedTask(USER, { requestId: 'req-cancel-cid-a', task: 'A', conversationId: 'cid-cancel-all', agentId: 'agent-a' });
    const second = await controller.startCogSeedTask(USER, { requestId: 'req-cancel-cid-b', task: 'B', conversationId: 'cid-cancel-all', agentId: 'agent-b' });
    const other = await controller.startCogSeedTask(USER, { requestId: 'req-cancel-other', task: 'Other', conversationId: 'cid-other', agentId: 'agent-c' });

    const cancelled = await controller.cancelConversationTasks(USER, 'cid-cancel-all');

    expect(cancelled.map((task) => task.taskId).sort()).toEqual([first.taskId, second.taskId].sort());
    await expect(tasks.readCogSeedTask(USER, first.taskId)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(tasks.readCogSeedTask(USER, second.taskId)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(tasks.readCogSeedTask(USER, other.taskId)).resolves.toMatchObject({ status: 'running' });
    expect(signals.get('req-cancel-cid-a')?.aborted).toBe(true);
    expect(signals.get('req-cancel-cid-b')?.aborted).toBe(true);
    expect(signals.get('req-cancel-other')?.aborted).toBe(false);
    await controller.cancelCogSeedTask(USER, other.taskId);
  });
  it('schedules an explicit retry as a new CogSeed task after a worker failure', async () => {
    let runs = 0;
    const runtime: CogSeedAgentRuntimeFacade & { inputs: unknown[] } = {
      inputs: [],
      async *run(_userId, input) {
        this.inputs.push(input);
        runs += 1;
        if (runs === 1) throw new Error('worker crashed');
        yield { type: 'result', request_id: 'req-retry', runtime_session_id: 'mruntime-retry', status: 'completed', text: 'retried' };
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });

    const original = await controller.startCogSeedTask(USER, { requestId: 'req-original', task: 'Run once.' });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, original.taskId)).toMatchObject({ status: 'recoverable' }));

    const retried = await controller.retryCogSeedTask(USER, original.taskId, 'req-retry');
    expect(retried).toMatchObject({ status: 'running', retryOfTaskId: original.taskId, requestId: 'req-retry' });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, retried.taskId)).toMatchObject({ status: 'completed' }));
    expect(runtime.inputs).toHaveLength(2);
    expect(runtime.inputs[1]).toMatchObject({ task: 'Run once.' });
  });

  it('single-flights concurrent retries that use the same request ID', async () => {
    let runs = 0;
    let releaseRetry!: () => void;
    let retryEntered!: () => void;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const retryStarted = new Promise<void>((resolve) => { retryEntered = resolve; });
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, input: any) {
        runs += 1;
        if (runs === 1) throw new Error('first execution disappeared');
        retryEntered();
        await retryGate;
        yield { type: 'result', request_id: input.request_id, runtime_session_id: input.runtime_session_id, status: 'completed', text: 'retried once' };
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });
    const original = await controller.startCogSeedTask(USER, { requestId: 'req-concurrent-retry-original', task: 'Retry exactly once.' });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, original.taskId)).toMatchObject({ status: 'recoverable' }));

    const [first, duplicate] = await Promise.all([
      controller.retryCogSeedTask(USER, original.taskId, 'req-concurrent-retry'),
      controller.retryCogSeedTask(USER, original.taskId, 'req-concurrent-retry'),
    ]);
    await retryStarted;

    expect(first.taskId).toBe(duplicate.taskId);
    expect(runs).toBe(2);
    await expect(controller.retryCogSeedTask(USER, original.taskId, 'req-concurrent-retry-other'))
      .rejects.toThrow(/replacement|already/i);
    releaseRetry();
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, first.taskId)).toMatchObject({ status: 'completed' }));
  });

  it('lets cancellation win before retry or resume admission without launching another executor', async () => {
    let runs = 0;
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run() {
        runs += 1;
        throw new Error('executor disappeared');
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });
    const source = await controller.startCogSeedTask(USER, {
      requestId: 'req-cancel-before-recovery-action',
      task: 'Only cancellation may win.',
    });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, source.taskId)).toMatchObject({ status: 'recoverable' }));

    const cancelled = await controller.cancelCogSeedTask(USER, source.taskId);
    await expect(controller.retryCogSeedTask(USER, source.taskId, 'req-retry-after-cancel'))
      .rejects.toThrow(/not replaceable|not retryable/i);
    await expect(controller.resumeCogSeedTask(USER, source.taskId, {
      requestId: 'req-resume-after-cancel',
      continuation: 'Must not execute.',
    })).resolves.toMatchObject({ status: 'cancelled' });

    expect(cancelled.status).toBe('cancelled');
    expect(runs).toBe(1);
    await expect(tasks.listCogSeedTasks(USER)).resolves.toHaveLength(1);
  });

  it('keeps Conversation deletion and local CLI retry on one lock order without deadlock', async () => {
    let runs = 0;
    const localCliAdapter = {
      async *run() {
        runs += 1;
        throw new Error('local CLI disappeared');
      },
    };
    const guards = await import('../../../../src/main/features/cogseed_backend/conversation-operation-guard');
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime: runtimeFrom([]), localCliAdapter } as any);
    await createConversation('cid-delete-retry-order');
    const source = await controller.startCogSeedTask(USER, {
      requestId: 'req-delete-retry-source',
      task: 'Do not retry across deletion.',
      conversationId: 'cid-delete-retry-order',
      agentId: 'agent-delete-retry-order',
      executionKind: 'local-cli',
      localCli: { cli: 'codex' },
    });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, source.taskId)).toMatchObject({ status: 'recoverable' }));
    let deletionEntered!: () => void;
    let releaseDeletion!: () => void;
    const entered = new Promise<void>((resolve) => { deletionEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseDeletion = resolve; });
    const deleting = guards.withCogSeedConversationDeletion(USER, 'cid-delete-retry-order', async () => {
      deletionEntered();
      await gate;
      await controller.cancelCogSeedTask(USER, source.taskId);
      return true;
    });
    await entered;
    const retrying = expect(controller.retryCogSeedTask(USER, source.taskId, 'req-delete-retry'))
      .rejects.toThrow(/conversation is unavailable/i);
    releaseDeletion();

    await expect(deleting).resolves.toBe(true);
    await retrying;
    expect(runs).toBe(1);
    await expect(tasks.readCogSeedTask(USER, source.taskId)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('lets a scheduled local CLI consumer settle while Conversation deletion keeps late admission closed', async () => {
    let adapterRuns = 0;
    const localCliAdapter = {
      async *run() {
        adapterRuns += 1;
        yield {
          type: 'result',
          request_id: 'req-delete-scheduled-consumer',
          runtime_session_id: 'mruntime-delete-scheduled-consumer',
          status: 'completed',
          text: 'must not run',
        };
      },
    };
    const runtimeController = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const chats = await import('../../../../src/main/features/chats');
    await createConversation('cid-delete-scheduled-consumer');
    const controller = runtimeController.createCogSeedRuntimeController({
      runtime: runtimeFrom([]),
      localCliAdapter,
      projectTaskEvent: vi.fn(async () => 'projected'),
    } as any);
    const singleton = runtimeController.cogseedRuntimeController;
    const originalCancellation = singleton.cancelConversationTasksForDeletion;
    singleton.cancelConversationTasksForDeletion = (userId, conversationId) => (
      controller.cancelConversationTasksForDeletion(userId, conversationId)
    );

    try {
      const started = await controller.startCogSeedTask(USER, {
        requestId: 'req-delete-scheduled-consumer',
        task: 'Do not deadlock deletion.',
        conversationId: 'cid-delete-scheduled-consumer',
        agentId: 'agent-delete-scheduled-consumer',
        executionKind: 'local-cli',
        localCli: { cli: 'codex' },
      });

      // startCogSeedTask registers activeRunPromises before resolving. This
      // continuation runs before the setImmediate consumer, so deletion wins
      // the Conversation lock while still having a real run to settle.
      await expect(settleWithin(
        chats.deleteConversation(USER, 'cid-delete-scheduled-consumer'),
      )).resolves.toBe(true);
      await expect(tasks.readCogSeedTask(USER, started.taskId)).resolves.toMatchObject({ status: 'cancelled' });
      await expect(chats.getConversation(USER, 'cid-delete-scheduled-consumer')).resolves.toBeNull();
      expect(adapterRuns).toBe(0);
    } finally {
      singleton.cancelConversationTasksForDeletion = originalCancellation;
    }
  });

  it('single-flights reassignment-style replacements and rejects a competing Agent assignment', async () => {
    let runs = 0;
    let releaseReplacement!: () => void;
    const replacementGate = new Promise<void>((resolve) => { releaseReplacement = resolve; });
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, input: any) {
        runs += 1;
        if (runs === 1) throw new Error('original Agent failed');
        await replacementGate;
        yield {
          type: 'result',
          request_id: input.request_id,
          runtime_session_id: input.runtime_session_id,
          status: 'completed',
          text: 'reassigned once',
        };
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });
    const source = await controller.startCogSeedTask(USER, {
      requestId: 'req-reassign-source',
      task: 'Assign this work once.',
      agentId: 'agent-original',
    });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, source.taskId)).toMatchObject({ status: 'recoverable' }));
    const replacementInput = {
      requestId: 'req-reassign-once',
      task: source.task,
      agentId: 'agent-replacement',
      retryOfTaskId: source.taskId,
    };

    const firstStart = controller.startCogSeedTask(USER, replacementInput);
    const duplicateStart = controller.startCogSeedTask(USER, replacementInput);
    const conflictingPayload = expect(controller.startCogSeedTask(USER, {
      ...replacementInput,
      agentId: 'agent-conflicting-same-request',
    })).rejects.toThrow(/payload conflict/i);
    const [first, duplicate] = await Promise.all([firstStart, duplicateStart]);

    expect(first.taskId).toBe(duplicate.taskId);
    expect(first).toMatchObject({ retryOfTaskId: source.taskId, agentId: 'agent-replacement' });
    await conflictingPayload;
    await expect(controller.startCogSeedTask(USER, {
      ...replacementInput,
      requestId: 'req-reassign-conflict',
      agentId: 'agent-competing',
    })).rejects.toThrow(/replacement|already/i);
    await expect(controller.cancelCogSeedTask(USER, source.taskId)).rejects.toThrow(/replacement/i);
    expect(runs).toBe(2);
    releaseReplacement();
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, first.taskId)).toMatchObject({ status: 'completed' }));
  });

  it('resumes a recoverable task only with an explicit continuation and keeps the CogSeed runtime session', async () => {
    let runs = 0;
    const runtime: CogSeedAgentRuntimeFacade & { inputs: unknown[] } = {
      inputs: [],
      async *run(_userId, input) {
        this.inputs.push(input);
        runs += 1;
        if (runs === 1) throw new Error('worker crashed');
        yield { type: 'result', request_id: 'req-resume', runtime_session_id: 'mruntime-resume', status: 'completed', text: 'continued' };
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });

    const original = await controller.startCogSeedTask(USER, { requestId: 'req-resume-original', task: 'Original prompt must not be replayed.' });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, original.taskId)).toMatchObject({ status: 'recoverable' }));

    const resumed = await controller.resumeCogSeedTask(USER, original.taskId, {
      requestId: 'req-resume',
      continuation: 'Continue from the persisted runtime state.',
    });
    expect(resumed).toMatchObject({ taskId: original.taskId, status: 'running' });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, original.taskId)).toMatchObject({ status: 'completed' }));
    expect(runtime.inputs[1]).toMatchObject({
      task: 'Continue from the persisted runtime state.',
      request_id: 'req-resume',
      runtime_session_id: original.runtimeSessionId,
    });
    expect((runtime.inputs[1] as { task: string }).task).not.toContain('Original prompt');
    await expect(controller.resumeCogSeedTask(USER, original.taskId, {
      requestId: 'req-resume',
      continuation: 'Continue from the persisted runtime state.',
    })).resolves.toMatchObject({ taskId: original.taskId });
    await expect(controller.resumeCogSeedTask(USER, original.taskId, {
      requestId: 'req-resume',
      continuation: 'A conflicting continuation must not run.',
    })).rejects.toThrow(/payload conflict/i);
    expect(runtime.inputs).toHaveLength(2);
    const persisted = await tasks.readCogSeedTask(USER, original.taskId);
    expect(persisted?.lastResumeRequestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain('Continue from the persisted runtime state.');
  });

  it('single-flights an identical resume and rejects a second continuation while it is running', async () => {
    let runs = 0;
    let releaseResume!: () => void;
    let resumeEntered!: () => void;
    const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
    const resumeStarted = new Promise<void>((resolve) => { resumeEntered = resolve; });
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, input: any) {
        runs += 1;
        if (runs === 1) throw new Error('worker exited');
        resumeEntered();
        await resumeGate;
        yield { type: 'result', request_id: input.request_id, runtime_session_id: input.runtime_session_id, status: 'completed', text: 'resumed once' };
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });
    const task = await controller.startCogSeedTask(USER, { requestId: 'req-concurrent-resume-original', task: 'Resume once.' });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, task.taskId)).toMatchObject({ status: 'recoverable' }));

    const resumeInput = { requestId: 'req-concurrent-resume', continuation: 'Continue exactly once.' };
    const [first, duplicate] = await Promise.all([
      controller.resumeCogSeedTask(USER, task.taskId, resumeInput),
      controller.resumeCogSeedTask(USER, task.taskId, resumeInput),
    ]);
    await resumeStarted;

    expect(first).toEqual(duplicate);
    expect(first.status).toBe('running');
    expect(runs).toBe(2);
    await expect(controller.resumeCogSeedTask(USER, task.taskId, {
      requestId: 'req-concurrent-resume-other',
      continuation: 'A second continuation must wait.',
    })).rejects.toThrow(/not resumable/i);
    releaseResume();
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, task.taskId)).toMatchObject({ status: 'completed' }));
  });

  it('aborts a resumed executor that registers while cancellation is waiting for the task lock', async () => {
    let runs = 0;
    let resumedSignal: AbortSignal | null = null;
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, input: any, options) {
        runs += 1;
        if (runs === 1) throw new Error('first executor disappeared');
        resumedSignal = options?.signal ?? null;
        await new Promise<void>((resolve) => resumedSignal?.addEventListener('abort', () => resolve(), { once: true }));
        yield {
          type: 'error',
          request_id: input.request_id,
          runtime_session_id: input.runtime_session_id,
          status: 'cancelled',
          error: 'cancelled',
        };
      },
      async shutdown() {},
    };
    const locks = await import('../../../../src/main/util/locks');
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });
    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-resume-cancel-registration-source',
      task: 'Resume into a waiting cancellation.',
    });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, task.taskId)).toMatchObject({ status: 'recoverable' }));
    const release = await locks.fileEditLock(`cogseed-runtime-operation:${USER}:${task.taskId}`).acquire();
    const resuming = controller.resumeCogSeedTask(USER, task.taskId, {
      requestId: 'req-resume-cancel-registration',
      continuation: 'Register one resumed executor.',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelling = controller.cancelCogSeedTask(USER, task.taskId);
    release();

    await expect(resuming).resolves.toMatchObject({ status: 'running' });
    await expect(cancelling).resolves.toMatchObject({ status: 'cancelled' });
    await eventually(async () => {
      expect(resumedSignal?.aborted).toBe(true);
      await expect(controller.runtimeStatus()).resolves.toMatchObject({ activeTaskCount: 0, activeTaskIds: [] });
    });
    expect(runs).toBe(2);
  });

  it('does not resume a source task after retry has claimed a replacement execution', async () => {
    let runs = 0;
    let releaseReplacement!: () => void;
    const replacementGate = new Promise<void>((resolve) => { releaseReplacement = resolve; });
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, input: any) {
        runs += 1;
        if (runs === 1) throw new Error('source executor disappeared');
        await replacementGate;
        yield {
          type: 'result',
          request_id: input.request_id,
          runtime_session_id: input.runtime_session_id,
          status: 'completed',
          text: 'replacement completed',
        };
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });
    const source = await controller.startCogSeedTask(USER, {
      requestId: 'req-retry-resume-source',
      task: 'Run through only one recovery path.',
    });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, source.taskId)).toMatchObject({ status: 'recoverable' }));

    const retrying = controller.retryCogSeedTask(USER, source.taskId, 'req-retry-resume-replacement');
    await expect(controller.resumeCogSeedTask(USER, source.taskId, {
      requestId: 'req-retry-resume-conflict',
      continuation: 'This second execution must be rejected.',
    })).rejects.toThrow(/operation|replacement/i);
    const replacement = await retrying;
    await expect(controller.resumeCogSeedTask(USER, source.taskId, {
      requestId: 'req-retry-resume-after',
      continuation: 'A sequential second execution must also be rejected.',
    })).rejects.toThrow(/replacement/i);
    expect(runs).toBe(2);
    releaseReplacement();
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, replacement.taskId)).toMatchObject({ status: 'completed' }));
  });

  it('reserves retry synchronously so a later resume cannot overtake blocked Conversation admission', async () => {
    let runs = 0;
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, input: any) {
        runs += 1;
        if (runs === 1) throw new Error('source executor disappeared');
        await executionGate;
        yield { type: 'result', request_id: input.request_id, runtime_session_id: input.runtime_session_id, status: 'completed', text: 'retry won' };
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });
    const conversationId = 'cid-retry-source-reservation';
    const source = await controller.startCogSeedTask(USER, {
      requestId: 'req-retry-source-reservation',
      task: 'Only the first recovery action may win.',
      conversationId,
    });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, source.taskId)).toMatchObject({ status: 'recoverable' }));
    await eventually(async () => expect(await controller.runtimeStatus()).toMatchObject({ activeTaskCount: 0 }));
    const admission = await holdConversationAdmission(conversationId);
    try {
      const retrying = controller.retryCogSeedTask(USER, source.taskId, 'req-retry-source-reserved');
      await admission.waitForAttempt(1);
      const resuming = controller.resumeCogSeedTask(USER, source.taskId, {
        requestId: 'req-resume-after-retry-reservation',
        continuation: 'Must not overtake retry.',
      });
      const resumeSettled = resuming.then(() => undefined, () => undefined);
      await Promise.race([resumeSettled, admission.waitForAttempt(2)]);
      admission.release();

      const replacement = await retrying;
      await expect(resuming).rejects.toThrow(/operation|progress|replacement/i);
      expect(replacement).toMatchObject({ retryOfTaskId: source.taskId, requestId: 'req-retry-source-reserved' });
      await eventually(() => expect(runs).toBe(2));
      releaseExecution();
      await eventually(async () => expect(await tasks.readCogSeedTask(USER, replacement.taskId)).toMatchObject({ status: 'completed' }));
    } finally {
      admission.release();
      releaseExecution();
    }
  });

  it('reserves reassignment synchronously and keeps duplicate/conflicting requests deterministic', async () => {
    let runs = 0;
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, input: any) {
        runs += 1;
        if (runs === 1) throw new Error('source Agent disappeared');
        await executionGate;
        yield { type: 'result', request_id: input.request_id, runtime_session_id: input.runtime_session_id, status: 'completed', text: 'reassignment won' };
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });
    const conversationId = 'cid-reassign-source-reservation';
    const source = await controller.startCogSeedTask(USER, {
      requestId: 'req-reassign-source-reservation',
      task: 'Assign one replacement Agent.',
      conversationId,
      agentId: 'agent-source-reservation',
    });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, source.taskId)).toMatchObject({ status: 'recoverable' }));
    await eventually(async () => expect(await controller.runtimeStatus()).toMatchObject({ activeTaskCount: 0 }));
    const admission = await holdConversationAdmission(conversationId);
    const input = {
      requestId: 'req-reassign-source-reserved',
      task: source.task,
      conversationId,
      agentId: 'agent-reassigned-reservation',
      retryOfTaskId: source.taskId,
    };
    try {
      const reassigning = controller.startCogSeedTask(USER, input);
      const duplicate = controller.startCogSeedTask(USER, input);
      const payloadConflict = expect(controller.startCogSeedTask(USER, {
        ...input,
        agentId: 'agent-conflicting-reservation',
      })).rejects.toThrow(/payload conflict/i);
      await admission.waitForAttempt(1);
      const resuming = controller.resumeCogSeedTask(USER, source.taskId, {
        requestId: 'req-resume-after-reassign-reservation',
        continuation: 'Must not overtake reassignment.',
      });
      const resumeSettled = resuming.then(() => undefined, () => undefined);
      await Promise.race([resumeSettled, admission.waitForAttempt(2)]);
      admission.release();

      const [replacement, replay] = await Promise.all([reassigning, duplicate]);
      expect(replay.taskId).toBe(replacement.taskId);
      await payloadConflict;
      await expect(resuming).rejects.toThrow(/operation|progress|replacement/i);
      expect(replacement).toMatchObject({ retryOfTaskId: source.taskId, agentId: 'agent-reassigned-reservation' });
      await eventually(() => expect(runs).toBe(2));
      releaseExecution();
      await eventually(async () => expect(await tasks.readCogSeedTask(USER, replacement.taskId)).toMatchObject({ status: 'completed' }));
    } finally {
      admission.release();
      releaseExecution();
    }
  });

  it('keeps resume as the winner when it reserves the source before retry and reassignment', async () => {
    let runs = 0;
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, input: any) {
        runs += 1;
        if (runs === 1) throw new Error('source executor disappeared');
        await executionGate;
        yield { type: 'result', request_id: input.request_id, runtime_session_id: input.runtime_session_id, status: 'completed', text: 'resume won' };
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });
    const conversationId = 'cid-resume-first-reservation';
    const source = await controller.startCogSeedTask(USER, {
      requestId: 'req-resume-first-source',
      task: 'Resume this source exactly once.',
      conversationId,
    });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, source.taskId)).toMatchObject({ status: 'recoverable' }));
    await eventually(async () => expect(await controller.runtimeStatus()).toMatchObject({ activeTaskCount: 0 }));
    const admission = await holdConversationAdmission(conversationId);
    const resumeInput = { requestId: 'req-resume-first-winner', continuation: 'Continue as the first caller.' };
    try {
      const resuming = controller.resumeCogSeedTask(USER, source.taskId, resumeInput);
      const duplicate = controller.resumeCogSeedTask(USER, source.taskId, resumeInput);
      await admission.waitForAttempt(1);
      await expect(controller.retryCogSeedTask(USER, source.taskId, 'req-retry-after-resume-reservation'))
        .rejects.toThrow(/operation|progress/i);
      await expect(controller.startCogSeedTask(USER, {
        requestId: 'req-reassign-after-resume-reservation',
        task: source.task,
        conversationId,
        agentId: 'agent-after-resume-reservation',
        retryOfTaskId: source.taskId,
      })).rejects.toThrow(/operation|progress/i);
      await expect(controller.resumeCogSeedTask(USER, source.taskId, {
        requestId: resumeInput.requestId,
        continuation: 'Conflicting continuation.',
      })).rejects.toThrow(/payload conflict/i);
      admission.release();

      const [resumed, replay] = await Promise.all([resuming, duplicate]);
      expect(replay.taskId).toBe(resumed.taskId);
      expect(resumed).toMatchObject({ taskId: source.taskId, status: 'running' });
      await eventually(() => expect(runs).toBe(2));
      releaseExecution();
      await eventually(async () => expect(await tasks.readCogSeedTask(USER, source.taskId)).toMatchObject({ status: 'completed' }));
    } finally {
      admission.release();
      releaseExecution();
    }
  });

  it('fences stale late terminal events and starts recovery only after the old iterator settles', async () => {
    await createConversation('cid-stale-terminal-fence');
    let runs = 0;
    let firstRunActive = false;
    let releaseStaleResult!: () => void;
    const staleResultGate = new Promise<void>((resolve) => { releaseStaleResult = resolve; });
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, input: any) {
        runs += 1;
        if (runs === 1) {
          firstRunActive = true;
          try {
            await staleResultGate;
            yield {
              type: 'result',
              request_id: input.request_id,
              runtime_session_id: input.runtime_session_id,
              status: 'completed',
              text: 'stale result must be fenced',
            };
          } finally {
            firstRunActive = false;
          }
          return;
        }
        if (firstRunActive) throw new Error('recovery executor overlapped the stale executor');
        yield {
          type: 'result',
          request_id: input.request_id,
          runtime_session_id: input.runtime_session_id,
          status: 'completed',
          text: 'fresh recovered result',
        };
      },
      async shutdown() {},
    };
    const projectTaskEvent = vi.fn(async () => 'projected');
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const deliveries = await import('../../../../src/main/features/cogseed_backend/result-delivery-store');
    const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent });
    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-stale-terminal-fence',
      task: 'Fence the old attempt before recovery.',
      conversationId: 'cid-stale-terminal-fence',
      agentId: 'agent-stale-terminal-fence',
    });
    await eventually(() => expect(firstRunActive).toBe(true));
    await lifecycle.markCogSeedTaskRecoverable(USER, task.taskId, 'external_executor_lost');

    const resuming = controller.resumeCogSeedTask(USER, task.taskId, {
      requestId: 'req-stale-terminal-resume',
      continuation: 'Run the authoritative recovery attempt.',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runs).toBe(1);
    releaseStaleResult();

    await expect(settleWithin(resuming)).resolves.toMatchObject({ taskId: task.taskId, status: 'running' });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, task.taskId)).toMatchObject({
      status: 'completed',
      resultDeliveryState: 'delivered',
    }));
    expect(runs).toBe(2);
    const completions = projectTaskEvent.mock.calls
      .map(([input]) => input.event)
      .filter((event) => event.type === 'task.completed');
    expect(completions).toEqual([
      expect.objectContaining({ payload: { text: 'fresh recovered result' } }),
    ]);
    expect(JSON.stringify(projectTaskEvent.mock.calls)).not.toContain('stale result must be fenced');
    await expect(deliveries.cogseedResultDeliveryStore.read(USER, task.executionId!)).resolves.toBeNull();
  });

  it('drops a stale progress event when recoverable persists between map precheck and append', async () => {
    let releaseProgress!: () => void;
    let runtimeEntered!: () => void;
    const progressGate = new Promise<void>((resolve) => { releaseProgress = resolve; });
    const entered = new Promise<void>((resolve) => { runtimeEntered = resolve; });
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, input: any) {
        runtimeEntered();
        await progressGate;
        yield {
          type: 'event',
          request_id: input.request_id,
          runtime_session_id: input.runtime_session_id,
          status: 'running',
          text: 'stale progress must not persist',
        };
      },
      async shutdown() {},
    };
    const locks = await import('../../../../src/main/util/locks');
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const eventsStore = await import('../../../../src/main/features/cogseed_backend/event-store');
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const projectTaskEvent = vi.fn(async () => 'projected');
    const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent });
    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-stale-progress-fence',
      task: 'Do not retain progress from a fenced attempt.',
    });
    await entered;

    const mutex = locks.fileEditLock(paths.cogseedTaskFile(USER, task.taskId));
    const releaseTaskFile = await mutex.acquire();
    const runExclusive = mutex.runExclusive.bind(mutex);
    let attempts = 0;
    const waiters = new Map<number, () => void>();
    const waitForAttempt = (attempt: number): Promise<void> => {
      if (attempts >= attempt) return Promise.resolve();
      return new Promise<void>((resolve) => { waiters.set(attempt, resolve); });
    };
    const operationSpy = vi.spyOn(mutex, 'runExclusive').mockImplementation((worker, priority?: number) => {
      attempts += 1;
      waiters.get(attempts)?.();
      return runExclusive(worker, priority);
    });
    try {
      const markingRecoverable = lifecycle.markCogSeedTaskRecoverable(USER, task.taskId, 'attempt_fenced');
      await waitForAttempt(1);
      releaseProgress();
      await waitForAttempt(2);
      releaseTaskFile();
      await markingRecoverable;
      await eventually(async () => expect(await controller.runtimeStatus()).toMatchObject({ activeTaskCount: 0 }));
    } finally {
      operationSpy.mockRestore();
      releaseTaskFile();
      releaseProgress();
    }

    const events = await eventsStore.readCogSeedTaskEvents(USER, task.taskId, 0, 100);
    expect(events.some((event) => event.type === 'model.delta')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('stale progress must not persist');
    expect(projectTaskEvent.mock.calls.some(([input]) => input.event.type === 'model.delta')).toBe(false);
    await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({ status: 'recoverable' });
  });

  it('recovers an authoritative retained result instead of launching resume or reassignment', async () => {
    await createConversation('cid-retained-before-resume');
    await createConversation('cid-retained-before-reassign');
    let runs = 0;
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run() {
        runs += 1;
        throw new Error('executor exited after retaining its result');
      },
      async shutdown() {},
    };
    const projectTaskEvent = vi.fn(async () => 'projected');
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const deliveries = await import('../../../../src/main/features/cogseed_backend/result-delivery-store');
    const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent });

    const resumeSource = await controller.startCogSeedTask(USER, {
      requestId: 'req-retained-before-resume',
      task: 'Recover retained output before resume.',
      conversationId: 'cid-retained-before-resume',
      agentId: 'agent-retained-before-resume',
    });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, resumeSource.taskId)).toMatchObject({ status: 'recoverable' }));
    await deliveries.cogseedResultDeliveryStore.save(USER, {
      taskId: resumeSource.taskId,
      executionId: resumeSource.executionId!,
      conversationId: resumeSource.conversationId!,
      agentId: resumeSource.agentId!,
      sessionId: resumeSource.sessionId,
      destinationGeneration: (await (await import('../../../../src/main/features/chats'))
        .ensureCogSeedConversationDeliveryGeneration(USER, resumeSource.conversationId!))!,
      event: {
        eventId: `cogseed-event-terminal-${resumeSource.taskId}`,
        type: 'task.completed',
        payload: { text: 'authoritative retained resume result' },
      },
    });
    await expect(controller.resumeCogSeedTask(USER, resumeSource.taskId, {
      requestId: 'req-must-not-launch-resume',
      continuation: 'This executor must not launch.',
    })).resolves.toMatchObject({ taskId: resumeSource.taskId, status: 'completed', resultDeliveryState: 'delivered' });

    const reassignSource = await controller.startCogSeedTask(USER, {
      requestId: 'req-retained-before-reassign',
      task: 'Recover retained output before reassignment.',
      conversationId: 'cid-retained-before-reassign',
      agentId: 'agent-retained-before-reassign',
    });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, reassignSource.taskId)).toMatchObject({ status: 'recoverable' }));
    await deliveries.cogseedResultDeliveryStore.save(USER, {
      taskId: reassignSource.taskId,
      executionId: reassignSource.executionId!,
      conversationId: reassignSource.conversationId!,
      agentId: reassignSource.agentId!,
      sessionId: reassignSource.sessionId,
      destinationGeneration: (await (await import('../../../../src/main/features/chats'))
        .ensureCogSeedConversationDeliveryGeneration(USER, reassignSource.conversationId!))!,
      event: {
        eventId: `cogseed-event-terminal-${reassignSource.taskId}`,
        type: 'task.completed',
        payload: { text: 'authoritative retained reassignment result' },
      },
    });
    await expect(controller.startCogSeedTask(USER, {
      requestId: 'req-must-not-launch-reassign',
      task: reassignSource.task,
      conversationId: reassignSource.conversationId,
      agentId: 'agent-must-not-launch-reassign',
      retryOfTaskId: reassignSource.taskId,
    })).resolves.toMatchObject({ taskId: reassignSource.taskId, status: 'completed', resultDeliveryState: 'delivered' });

    expect(runs).toBe(2);
    await expect(tasks.listCogSeedTasks(USER)).resolves.toHaveLength(2);
    expect(projectTaskEvent.mock.calls
      .filter(([input]) => input.event.type === 'task.completed')).toHaveLength(2);
  });

  it('registers cancellation before AbortSignal synchronous re-entry', async () => {
    let signal: AbortSignal | null = null;
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, _input, options) {
        signal = options?.signal ?? null;
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      },
      async shutdown() {},
    } as CogSeedAgentRuntimeFacade;
    const locks = await import('../../../../src/main/util/locks');
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createCogSeedRuntimeController({ runtime });
    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-cancel-synchronous-reentry',
      task: 'Cancel through one operation claim.',
    });
    await eventually(() => expect(signal).not.toBeNull());
    const mutex = locks.fileEditLock(`cogseed-runtime-operation:${USER}:${task.taskId}`);
    const operationSpy = vi.spyOn(mutex, 'runExclusive');
    let reentrant: Promise<unknown> | undefined;
    signal!.addEventListener('abort', () => {
      reentrant = controller.cancelCogSeedTask(USER, task.taskId);
    }, { once: true });
    try {
      const cancellation = controller.cancelCogSeedTask(USER, task.taskId);
      await expect(cancellation).resolves.toMatchObject({ status: 'cancelled' });
      await expect(reentrant).resolves.toMatchObject({ status: 'cancelled' });
      expect(operationSpy).toHaveBeenCalledTimes(1);
    } finally {
      operationSpy.mockRestore();
    }
  });

  it('cancels Conversation replacements leaf-first and bypasses terminal replacement guards', async () => {
    let runs = 0;
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, _input, options) {
        runs += 1;
        if (runs === 1) throw new Error('source executor disappeared');
        await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const controller = createCogSeedRuntimeController({ runtime });
    const liveConversationId = 'cid-delete-live-replacement';
    const source = await controller.startCogSeedTask(USER, {
      requestId: 'req-delete-live-source',
      task: 'Cancel the replacement before this source.',
      conversationId: liveConversationId,
    });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, source.taskId)).toMatchObject({ status: 'recoverable' }));
    const replacement = await controller.startCogSeedTask(USER, {
      requestId: 'req-delete-live-replacement',
      task: source.task,
      conversationId: liveConversationId,
      retryOfTaskId: source.taskId,
    });
    const liveCancellation = await controller.cancelConversationTasksForDeletion(USER, liveConversationId);
    await settleWithin(liveCancellation.settled);
    expect(liveCancellation.cancelled.map((task) => task.taskId)).toEqual([replacement.taskId, source.taskId]);
    await expect(tasks.readCogSeedTask(USER, replacement.taskId)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(tasks.readCogSeedTask(USER, source.taskId)).resolves.toMatchObject({ status: 'cancelled' });

    const terminalConversationId = 'cid-delete-terminal-replacement';
    const terminalSource = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-delete-terminal-source',
      task: 'Cancel source despite terminal replacement.',
      conversationId: terminalConversationId,
    })).task;
    await lifecycle.markCogSeedTaskRecoverable(USER, terminalSource.taskId, 'executor_lost');
    const terminalReplacement = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-delete-terminal-replacement',
      task: terminalSource.task,
      conversationId: terminalConversationId,
      retryOfTaskId: terminalSource.taskId,
    })).task;
    await lifecycle.transitionCogSeedTask(USER, terminalReplacement.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, terminalReplacement.taskId, 'running');
    await lifecycle.transitionCogSeedTask(USER, terminalReplacement.taskId, 'failed', { errorCode: 'replacement_failed' });

    await expect(controller.cancelConversationTasks(USER, terminalConversationId)).resolves.toEqual([
      expect.objectContaining({ taskId: terminalSource.taskId, status: 'cancelled' }),
    ]);
    await expect(tasks.readCogSeedTask(USER, terminalReplacement.taskId)).resolves.toMatchObject({ status: 'failed' });
  });

  it('reports independent CogSeed runtime status and can restart its worker service', async () => {
    const shutdown = vi.fn(async () => undefined);
    const runtime = runtimeFrom([]);
    runtime.shutdown = shutdown;
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createCogSeedRuntimeController({ runtime });

    await expect(controller.runtimeStatus()).resolves.toMatchObject({ activeTaskCount: 0, backend: 'cogseed' });
    await expect(controller.restartRuntime()).resolves.toEqual({ restarted: true });
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('does not recover a task while launch admission is registering its live executor', async () => {
    let liveSignal: AbortSignal | null = null;
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, _input, options) {
        liveSignal = options?.signal ?? null;
        await new Promise<void>((resolve) => liveSignal?.addEventListener('abort', () => resolve(), { once: true }));
      },
      async shutdown() {},
    } as CogSeedAgentRuntimeFacade;
    const locks = await import('../../../../src/main/util/locks');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const input = { requestId: 'req-launch-recovery-atomic', task: 'Remain live during recovery.' };
    const seeded = (await tasks.createCogSeedTask(USER, input)).task;
    const release = await locks.fileEditLock(`cogseed-runtime-launch-recovery:${USER}:${seeded.taskId}`).acquire();
    const controller = createCogSeedRuntimeController({ runtime });
    const starting = controller.startCogSeedTask(USER, input);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const recovering = controller.recoverOrphanedTasks(USER);
    release();

    await expect(starting).resolves.toMatchObject({ status: 'running' });
    await expect(recovering).resolves.toMatchObject({ recoveredCount: 0, taskIds: [] });
    await eventually(() => expect(liveSignal).not.toBeNull());
    await expect(tasks.readCogSeedTask(USER, seeded.taskId)).resolves.toMatchObject({ status: 'running' });
    await controller.cancelCogSeedTask(USER, seeded.taskId);
  });

  it('benignly skips a stale recovery candidate that cancellation wins first', async () => {
    const locks = await import('../../../../src/main/util/locks');
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const seeded = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-cancel-recovery-race',
      task: 'Cancellation must win stale recovery.',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, seeded.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, seeded.taskId, 'running');
    const releaseTaskFile = await locks.fileEditLock(paths.cogseedTaskFile(USER, seeded.taskId)).acquire();
    const controller = createCogSeedRuntimeController({ runtime: runtimeFrom([]) });

    const cancelling = controller.cancelCogSeedTask(USER, seeded.taskId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const recovering = controller.recoverOrphanedTasks(USER);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseTaskFile();

    await expect(cancelling).resolves.toMatchObject({ status: 'cancelled' });
    await expect(recovering).resolves.toMatchObject({ recoveredCount: 0, taskIds: [] });
    await expect(tasks.readCogSeedTask(USER, seeded.taskId)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('recovers a watchdog-confirmed orphan once through the canonical lifecycle event', async () => {
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const seeded = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-watchdog-orphan',
      task: 'Recover only after process confirmation.',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, seeded.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, seeded.taskId, 'running');
    const controller = createCogSeedRuntimeController({
      runtime: runtimeFrom([]),
      runtimeHealthWatchdog: {
        orphanGraceMs: 0,
        intervalMs: 60_000,
        probeProcess: async () => 'missing',
      },
    });

    await expect(controller.scanRuntimeHealth(USER)).resolves.toMatchObject({
      recoveredCount: 1,
      states: { orphaned: 1 },
    });
    await expect(controller.scanRuntimeHealth(USER)).resolves.toMatchObject({
      scannedCount: 0,
      recoveredCount: 0,
    });
    await expect(tasks.readCogSeedTask(USER, seeded.taskId)).resolves.toMatchObject({
      status: 'recoverable',
      errorCode: 'runtime_watchdog_orphaned',
    });
    expect((await events.readCogSeedTaskEvents(USER, seeded.taskId, 0, 20))
      .filter((event) => event.type === 'task.recoverable')).toHaveLength(1);
    await controller.shutdown();
  });

  it('detaches a confirmed-dead stuck consumer so resume can proceed and fences its late exit', async () => {
    let runs = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, input) {
        runs += 1;
        if (runs === 1) {
          await firstGate;
          return;
        }
        await secondGate;
        yield {
          type: 'result',
          request_id: input.request_id!,
          runtime_session_id: input.runtime_session_id!,
          status: 'completed',
          text: 'resumed after watchdog recovery',
        };
      },
      async shutdown() {},
    };
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createCogSeedRuntimeController({
      runtime,
      runtimeHealthWatchdog: {
        orphanGraceMs: 0,
        intervalMs: 60_000,
        probeProcess: async () => 'missing',
      },
    });
    const started = await controller.startCogSeedTask(USER, {
      requestId: 'req-watchdog-stuck-source',
      task: 'Detach the stuck executor.',
    });
    await eventually(() => expect(runs).toBe(1));
    await expect(controller.scanRuntimeHealth(USER)).resolves.toMatchObject({ recoveredCount: 1 });

    const resumed = await settleWithin(controller.resumeCogSeedTask(USER, started.taskId, {
      requestId: 'req-watchdog-stuck-resume',
      continuation: 'Continue after recovery.',
    }));
    expect(resumed.status).toBe('running');
    await eventually(() => expect(runs).toBe(2));

    releaseFirst();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(tasks.readCogSeedTask(USER, started.taskId)).resolves.toMatchObject({ status: 'running' });
    releaseSecond();
    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, started.taskId)).resolves.toMatchObject({ status: 'completed' });
    });
    await controller.shutdown();
  });

  it('lets completion win after the watchdog scan snapshot but before recovery', async () => {
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const seeded = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-watchdog-completion-race',
      task: 'Completion must beat stale recovery.',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, seeded.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, seeded.taskId, 'running');
    let probes = 0;
    const controller = createCogSeedRuntimeController({
      runtime: runtimeFrom([]),
      runtimeHealthWatchdog: {
        orphanGraceMs: 0,
        intervalMs: 60_000,
        probeProcess: async () => {
          probes += 1;
          if (probes === 2) await lifecycle.transitionCogSeedTask(USER, seeded.taskId, 'completed');
          return 'missing';
        },
      },
    });

    await expect(controller.scanRuntimeHealth(USER)).resolves.toMatchObject({ recoveredCount: 0 });
    await expect(tasks.readCogSeedTask(USER, seeded.taskId)).resolves.toMatchObject({ status: 'completed' });
    await controller.shutdown();
  });

  it('waits for aborted executions to settle as recoverable during a Runtime restart', async () => {
    let runningSignal: AbortSignal | null = null;
    const shutdown = vi.fn(async () => undefined);
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, _input, options) {
        runningSignal = options?.signal ?? null;
        await new Promise<void>((resolve) => runningSignal?.addEventListener('abort', () => resolve(), { once: true }));
      },
      shutdown,
    } as CogSeedAgentRuntimeFacade;
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });
    const task = await controller.startCogSeedTask(USER, { requestId: 'req-restart-active', task: 'Recover after restart.' });
    await eventually(() => expect(runningSignal).not.toBeNull());

    await expect(controller.restartRuntime()).resolves.toEqual({ restarted: true });

    expect(runningSignal?.aborted).toBe(true);
    await expect(controller.runtimeStatus()).resolves.toMatchObject({ activeTaskCount: 0, activeTaskIds: [] });
    await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({ status: 'recoverable' });
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('holds new launches behind Runtime restart and maps a restart cancellation envelope to recoverable', async () => {
    let runs = 0;
    let firstSignal: AbortSignal | null = null;
    let releaseShutdown!: () => void;
    const shutdownGate = new Promise<void>((resolve) => { releaseShutdown = resolve; });
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, input: any, options) {
        runs += 1;
        if (runs === 1) {
          firstSignal = options?.signal ?? null;
          await new Promise<void>((resolve) => firstSignal?.addEventListener('abort', () => resolve(), { once: true }));
          yield {
            type: 'error',
            request_id: input.request_id,
            runtime_session_id: input.runtime_session_id,
            status: 'cancelled',
            error: 'worker restarted',
          };
          return;
        }
        yield {
          type: 'result',
          request_id: input.request_id,
          runtime_session_id: input.runtime_session_id,
          status: 'completed',
          text: 'started after restart',
        };
      },
      async shutdown() { await shutdownGate; },
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });
    const interrupted = await controller.startCogSeedTask(USER, {
      requestId: 'req-restart-envelope',
      task: 'Become recoverable on restart.',
    });
    await eventually(() => expect(firstSignal).not.toBeNull());

    const restarting = controller.restartRuntime();
    await eventually(() => expect(firstSignal?.aborted).toBe(true));
    const startingDuringRestart = controller.startCogSeedTask(USER, {
      requestId: 'req-start-during-restart',
      task: 'Wait until restart completes.',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(runs).toBe(1);

    releaseShutdown();
    await expect(restarting).resolves.toEqual({ restarted: true });
    const admitted = await startingDuringRestart;
    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, interrupted.taskId)).resolves.toMatchObject({
        status: 'recoverable',
        errorCode: 'runtime_restart',
      });
      await expect(tasks.readCogSeedTask(USER, admitted.taskId)).resolves.toMatchObject({ status: 'completed' });
    });
    expect(runs).toBe(2);
  });

  it('injects confirmed recall assets into the runtime context when a conversation is bound (M-1 / Decision 2)', async () => {
    // Seed a confirmed projection for the conversation, exactly like the
    // recall prompt-injection tests do.
    const [candidates, refs, projection, storage, layout] = await Promise.all([
      import('../../../../src/main/features/recall/candidate-service'),
      import('../../../../src/main/features/recall/workspace-refs'),
      import('../../../../src/main/features/recall/context-projection'),
      import('../../../../src/main/storage'),
      import('../../../../src/main/util/project-layout'),
    ]);
    const candidate = await candidates.saveRecallCandidate(USER, {
      judgment: 'Keep runtime boundaries explicit before changing them.',
      summary: 'Runtime boundary decision log',
      suggestedType: 'rule',
      suggestedScope: 'review,project',
      sourceRefs: [{ kind: 'execution', id: 'exec-m1' }],
    });
    const asset = await candidates.promoteRecallCandidate(USER, candidate.id, { actor: 'user' });
    await refs.addWorkspaceAssetReference(USER, { assetId: asset.asset.id, workspaceId: 'workspace-m1', scope: 'review' });
    const preview = await projection.previewContextProjection(USER, {
      taskRunId: 'task-m1', workspaceId: 'workspace-m1', purpose: 'review',
    });
    const confirmed = await projection.confirmContextProjection(USER, preview.id);
    const messageFile = layout.conversationMessageFile(USER, 'cid-m1');
    fs.mkdirSync(path.dirname(messageFile), { recursive: true });
    await storage.appendJsonlAtomic(messageFile, {
      id: 'msg-m1', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'preview',
      recall_projection_card: { projectionId: confirmed.id },
    });

    const runtime = runtimeFrom([
      { type: 'result', request_id: 'req-asset', runtime_session_id: 'mruntime-asset', status: 'completed', text: 'done' },
    ]);
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createCogSeedRuntimeController({ runtime });

    await controller.startCogSeedTask(USER, {
      requestId: 'req-asset',
      task: 'Apply the remembered rule.',
      conversationId: 'cid-m1',
    });

    await eventually(() => {
      expect(runtime.inputs).toHaveLength(1);
      const context = (runtime.inputs[0] as { context?: Array<{ type: string; content: string }> }).context ?? [];
      const assetItem = context.find((item) => item.type === 'text' && item.content.includes('<confirmed-ability-assets>'));
      expect(assetItem).toBeDefined();
      expect(assetItem!.content).toContain('Runtime boundary decision log');
    });
  });

  it('skips asset injection when no conversation is bound (soft degradation)', async () => {
    const runtime = runtimeFrom([
      { type: 'result', request_id: 'req-noasset', runtime_session_id: 'mruntime-noasset', status: 'completed', text: 'done' },
    ]);
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createCogSeedRuntimeController({ runtime });

    await controller.startCogSeedTask(USER, {
      requestId: 'req-noasset',
      task: 'Run without conversation context.',
    });

    await eventually(() => {
      expect(runtime.inputs).toHaveLength(1);
      const context = (runtime.inputs[0] as { context?: Array<{ type: string; content: string }> }).context ?? [];
      expect(context.some((item) => item.content.includes('<confirmed-ability-assets>'))).toBe(false);
    });
  });

  it('injects the live Commander-granted asset body into the runtime prompt', async () => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const candidate = await candidates.saveRecallCandidate(USER, {
      judgment: 'Always include the acceptance criteria in the implementation report.',
      summary: 'Implementation report acceptance criteria',
      suggestedType: 'rule',
      suggestedScope: 'project,review',
      sourceRefs: [{ kind: 'execution', id: 'exec-dispatched-asset' }],
    });
    const promoted = await candidates.promoteRecallCandidate(USER, candidate.id, { actor: 'user' });
    const runtime = runtimeFrom([
      { type: 'result', request_id: 'req-dispatched-asset', runtime_session_id: 'mruntime-dispatched-asset', status: 'completed', text: 'done' },
    ]);
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createCogSeedRuntimeController({ runtime });

    await controller.startCogSeedTask(USER, {
      requestId: 'req-dispatched-asset',
      task: 'Prepare the implementation report.',
      agentId: 'agent-dispatched-asset',
      abilityAssetIds: [promoted.asset.id],
    });

    await eventually(() => {
      const context = (runtime.inputs[0] as { context?: Array<{ type: string; content: string }> }).context ?? [];
      const dispatched = context.find((item) => item.content.includes('<commander-dispatched-assets>'));
      expect(dispatched).toBeDefined();
      expect(dispatched!.content).toContain('Always include the acceptance criteria');
    });
  });

});
