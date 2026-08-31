import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const projectionStorageFaults = vi.hoisted(() => ({
  failCommitAfterSideEffect: false,
  sideEffectCompleted: false,
}));

vi.mock('../../../../src/main/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/storage')>();
  return {
    ...actual,
    writeJson: async (...args: Parameters<typeof actual.writeJson>) => {
      const [file] = args;
      if (projectionStorageFaults.failCommitAfterSideEffect
        && projectionStorageFaults.sideEffectCompleted
        && String(file).includes(`${path.sep}_projections${path.sep}`)) {
        projectionStorageFaults.failCommitAfterSideEffect = false;
        throw new Error('simulated projection state commit failure');
      }
      return actual.writeJson(...args);
    },
  };
});

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-group-chat-projection-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  projectionStorageFaults.failCommitAfterSideEffect = false;
  projectionStorageFaults.sideEffectCompleted = false;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CogSeed Group Chat projection bridge', () => {
  it('maps Backend event kinds to the existing Group Chat process schema used by renderer and messaging', async () => {
    const { groupChatProcessDataForProjection } = await import('../../../../src/main/features/cogseed_backend/group-chat-projection');
    expect(groupChatProcessDataForProjection('model.delta', { text: 'hello' })).toEqual({ type: 'delta', text: 'hello' });
    expect(groupChatProcessDataForProjection('tool.started', { name: 'read_file' })).toEqual({
      type: 'event',
      event: { stream: 'tool', data: { phase: 'start', name: 'read_file' } },
    });
    expect(groupChatProcessDataForProjection('tool.finished', { name: 'read_file', isError: false })).toEqual({
      type: 'event',
      event: { stream: 'tool', data: { phase: 'result', name: 'read_file', isError: false } },
    });
    expect(groupChatProcessDataForProjection('task.started', { kind: 'task.completed' })).toEqual({
      type: 'event',
      event: { stream: 'runtime', data: { kind: 'task.started' } },
    });
    expect(groupChatProcessDataForProjection('artifact', {
      uri: 'p3394-object:sha256:abc', digest: 'abc', name: 'report.md', media_type: 'text/markdown',
    })).toEqual({
      type: 'event',
      event: {
        stream: 'runtime',
        data: { uri: 'p3394-object:sha256:abc', digest: 'abc', name: 'report.md', media_type: 'text/markdown', kind: 'artifact' },
      },
    });
  });

  it('keeps the Group Chat event stream active for a projected Backend task until its terminal event', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const { cogseedGroupChatProjection } = await import('../../../../src/main/features/cogseed_backend/group-chat-projection');
    const conversation = await chats.createConversation('projection-live-user', { title: 'Projected task lifecycle' });
    const cid = conversation.conversation_id;
    const base = {
      userId: 'projection-live-user',
      conversationId: cid,
      agentId: 'agent-projection-live',
      taskId: 'cogseed-task-projection-live',
      sessionId: 'cogseed-session-projection-live',
    };

    await expect(cogseedGroupChatProjection.project({
      ...base,
      event: { eventId: 'cogseed-event-projection-started', type: 'task.started', payload: { kind: 'task.completed' } },
    })).resolves.toBe('projected');

    expect(bus.isQuiescent(base.userId, cid)).toBe(false);
    expect(bus.runtimeSnapshot(base.userId, cid)).toEqual(expect.objectContaining({
      processing: true,
      activeTurns: [expect.objectContaining({
        actor: base.agentId,
        turn_id: base.taskId,
      })],
    }));

    await expect(cogseedGroupChatProjection.project({
      ...base,
      event: { eventId: 'cogseed-event-projection-completed-empty', type: 'task.completed', payload: { text: '' } },
    })).resolves.toBe('projected');

    expect(bus.isQuiescent(base.userId, cid)).toBe(true);
    const groupChat = await import('../../../../src/main/features/group_chat');
    expect(await groupChat.readMessages(base.userId, cid)).toEqual([]);
    await bus.dropConv(base.userId, cid);
  });

  it('lets deletion finish while a detached projection waits, then rejects every late side effect', async () => {
    const userId = 'projection-delete-race-user';
    const taskId = 'cogseed-task-projection-delete-race';
    const chats = await import('../../../../src/main/features/chats');
    const { fileEditLock } = await import('../../../../src/main/util/locks');
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const { createCogSeedGroupChatProjection } = await import(
      '../../../../src/main/features/cogseed_backend/group-chat-projection'
    );
    const conversation = await chats.createConversation(userId, { title: 'Projection deletion race' });
    const stateFile = paths.cogseedTaskProjectionFile(userId, taskId);
    let releaseStateLock!: () => void;
    let stateLockEntered!: () => void;
    const stateLockGate = new Promise<void>((resolve) => { releaseStateLock = resolve; });
    const stateLockStarted = new Promise<void>((resolve) => { stateLockEntered = resolve; });
    const heldStateLock = fileEditLock(stateFile).runExclusive(async () => {
      stateLockEntered();
      await stateLockGate;
    });
    await stateLockStarted;

    let existenceChecked!: () => void;
    const checked = new Promise<void>((resolve) => { existenceChecked = resolve; });
    const appendProcessEvent = vi.fn(async () => undefined);
    const appendTerminalMessage = vi.fn(async () => true);
    const projection = createCogSeedGroupChatProjection({
      async conversationExists(input) {
        const exists = Boolean(await chats.getConversation(input.userId, input.conversationId));
        existenceChecked();
        return exists;
      },
      appendProcessEvent,
      appendTerminalMessage,
    });
    const projecting = projection.project({
      userId,
      conversationId: conversation.conversation_id,
      agentId: 'agent-projection-delete-race',
      taskId,
      sessionId: 'cogseed-session-projection-delete-race',
      event: {
        eventId: 'cogseed-event-projection-delete-race',
        type: 'task.started',
        payload: {},
      },
    });
    await checked;
    await new Promise((resolve) => setImmediate(resolve));

    const deleting = chats.deleteConversation(userId, conversation.conversation_id);
    try {
      const deletionFinishedPromptly = await Promise.race([
        deleting.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      expect(deletionFinishedPromptly).toBe(true);
      expect(await deleting).toBe(true);
    } finally {
      releaseStateLock();
      await heldStateLock;
    }

    await expect(projecting).resolves.toBe('dropped');
    expect(appendProcessEvent).not.toHaveBeenCalled();
    expect(appendTerminalMessage).not.toHaveBeenCalled();
    expect(fs.existsSync(stateFile)).toBe(false);
    await expect(chats.getConversation(userId, conversation.conversation_id)).resolves.toBeNull();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fs.existsSync(stateFile)).toBe(false);
  }, 10_000);

  it('does not duplicate a persisted terminal Agent message when projection retries after a partial failure', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const conversation = await chats.createConversation('projection-retry-user', { title: 'Projected terminal retry' });
    const cid = conversation.conversation_id;
    const messageEvents: any[] = [];
    const unsubscribe = bus.subscribe('projection-retry-user', cid, (event) => {
      if (event.type === 'message') messageEvents.push(event);
    });
    const input = {
      uid: 'projection-retry-user',
      cid,
      agentId: 'agent-projection-retry',
      turnId: 'cogseed-task-projection-retry',
      text: 'one terminal answer',
      terminalStatus: 'completed' as const,
    };

    await bus.appendProjectedAgentMessage(input);
    await bus.appendProjectedAgentMessage(input);

    const groupChat = await import('../../../../src/main/features/group_chat');
    const messages = await groupChat.readMessages(input.uid, cid);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      from: input.agentId,
      turn_id: input.turnId,
      text: input.text,
    });
    expect(messageEvents).toHaveLength(1);
    unsubscribe();
    await bus.dropConv(input.uid, cid);
  });

  it('treats a user-deleted terminal reply as durable evidence after the projection marker commit fails', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const layout = await import('../../../../src/main/util/project-layout');
    const { createCogSeedGroupChatProjection } = await import('../../../../src/main/features/cogseed_backend/group-chat-projection');
    const userId = 'projection-deleted-retry-user';
    const conversation = await chats.createConversation(userId, { title: 'Deleted projected terminal retry' });
    const cid = conversation.conversation_id;
    const messageEvents: unknown[] = [];
    const unsubscribe = bus.subscribe(userId, cid, (event) => {
      if (event.type === 'message') messageEvents.push(event);
    });
    const appendTerminalMessage = vi.fn(async (input: {
      userId: string;
      conversationId: string;
      agentId: string;
      turnId: string;
      text: string;
      terminalStatus?: 'completed' | 'failed';
    }) => {
      const appended = await bus.appendProjectedAgentMessage({
        uid: input.userId,
        cid: input.conversationId,
        agentId: input.agentId,
        turnId: input.turnId,
        text: input.text,
        ...(input.terminalStatus ? { terminalStatus: input.terminalStatus } : {}),
      });
      projectionStorageFaults.sideEffectCompleted = true;
      return Boolean(appended);
    });
    const projection = createCogSeedGroupChatProjection({ appendTerminalMessage });
    const input = {
      userId,
      conversationId: cid,
      agentId: 'agent-projection-deleted-retry',
      taskId: 'cogseed-task-projection-deleted-retry',
      executionId: 'cogseed-exec-projection-deleted-retry',
      sessionId: 'cogseed-session-projection-deleted-retry',
      event: {
        eventId: 'cogseed-event-projection-deleted-retry',
        type: 'task.completed' as const,
        payload: { text: 'one terminal answer' },
      },
    };

    projectionStorageFaults.failCommitAfterSideEffect = true;
    await expect(projection.project(input)).rejects.toThrow(/state commit failure/i);
    const visible = await groupChat.readMessages(userId, cid);
    expect(visible).toHaveLength(1);
    await expect(groupChat.deleteMessages(userId, cid, [visible[0].id])).resolves.toMatchObject({
      ok: true,
      deleted: [visible[0].id],
    });

    const afterDelete = fs.readFileSync(layout.conversationMessageFile(userId, cid), 'utf8')
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0]).toMatchObject({
      id: visible[0].id,
      text: '',
      deleted_by_user: true,
      turn_id: input.executionId,
    });
    expect(afterDelete[0]).not.toHaveProperty('process');

    await expect(projection.project(input)).resolves.toBe('projected');
    await expect(groupChat.readMessages(userId, cid)).resolves.toEqual([]);
    const afterRecovery = fs.readFileSync(layout.conversationMessageFile(userId, cid), 'utf8')
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    expect(afterRecovery).toEqual(afterDelete);
    expect(messageEvents).toHaveLength(1);
    expect(appendTerminalMessage).toHaveBeenCalledTimes(2);

    unsubscribe();
    await bus.dropConv(userId, cid);
  });

  it('persists a Run Center task as one idempotent user message without dispatching a second executor', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const visibility = await import('../../../../src/main/features/group_chat/visibility');
    const conversation = await chats.createConversation('projection-run-center-user', {
      conversationId: 'run-center-projection-task',
      title: 'Run Center task',
      agentId: 'agent-run-center',
    });
    const input = {
      uid: 'projection-run-center-user',
      cid: conversation.conversation_id,
      agentId: 'agent-run-center',
      requestId: 'req-run-center-projection-task',
      text: 'Inspect the current change.',
    };

    await Promise.all([
      bus.appendProjectedUserTaskMessage(input),
      bus.appendProjectedUserTaskMessage(input),
    ]);
    await expect(bus.appendProjectedUserTaskMessage({
      ...input,
      agentId: 'agent-run-center-conflict',
      text: 'Conflicting task body.',
    })).rejects.toThrow(/payload conflict/i);

    expect(await groupChat.readMessages(input.uid, input.cid)).toEqual([
      expect.objectContaining({
        from: 'user',
        to: [input.agentId],
        text: input.text,
        action_request_id: input.requestId,
      }),
    ]);
    expect(await visibility.readSlice(input.uid, input.cid, input.agentId)).toEqual([
      expect.objectContaining({ from: 'user', text: input.text }),
    ]);
    expect(bus.isQuiescent(input.uid, input.cid)).toBe(true);
    const state = await import('../../../../src/main/features/group_chat/state');
    expect((await state.readMembers(input.uid, input.cid)).actors.some((actor) => actor.id === 'agent-run-center-conflict')).toBe(false);
    await bus.dropConv(input.uid, input.cid);
  });

  it('retries a terminal projection after a visibility slice write fails', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const visibility = await import('../../../../src/main/features/group_chat/visibility');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const layout = await import('../../../../src/main/util/project-layout');
    const conversation = await chats.createConversation('projection-slice-retry-user', { title: 'Projected slice retry' });
    const cid = conversation.conversation_id;
    const base = {
      userId: 'projection-slice-retry-user',
      conversationId: cid,
      agentId: 'agent-projection-slice-retry',
      taskId: 'cogseed-task-projection-slice-retry',
      sessionId: 'cogseed-session-projection-slice-retry',
    };
    const bridge = (await import('../../../../src/main/features/cogseed_backend/group-chat-projection')).cogseedGroupChatProjection;

    await expect(bridge.project({
      ...base,
      event: { eventId: 'cogseed-event-slice-started', type: 'task.started', payload: {} },
    })).resolves.toBe('projected');

    const brokenSlice = layout.conversationLayout(base.userId, cid).visibilityFile(base.agentId);
    fs.mkdirSync(brokenSlice, { recursive: true });
    await expect(bridge.project({
      ...base,
      event: { eventId: 'cogseed-event-slice-completed', type: 'task.completed', payload: { text: 'retryable answer' } },
    })).rejects.toThrow();
    fs.rmSync(brokenSlice, { recursive: true, force: true });

    await expect(bridge.project({
      ...base,
      event: { eventId: 'cogseed-event-slice-completed', type: 'task.completed', payload: { text: 'retryable answer' } },
    })).resolves.toBe('projected');

    expect(await groupChat.readMessages(base.userId, cid)).toHaveLength(1);
    expect(await groupChat.readMessages(base.userId, cid)).toEqual([expect.objectContaining({ text: 'retryable answer' })]);
    expect(await visibility.readSlice(base.userId, cid, base.agentId)).toEqual([expect.objectContaining({ text: 'retryable answer' })]);
    await bus.dropConv(base.userId, cid);
  });

  it('persists idempotency, emits process events, and rejects late terminal output', async () => {
    const processEvents: any[] = [];
    const messages: any[] = [];
    const { createCogSeedGroupChatProjection } = await import('../../../../src/main/features/cogseed_backend/group-chat-projection');
    const bridge = createCogSeedGroupChatProjection({
      conversationExists: vi.fn(async () => true),
      appendProcessEvent: vi.fn(async (input) => { processEvents.push(input); }),
      appendTerminalMessage: vi.fn(async (input) => { messages.push(input); }),
    });
    const base = {
      userId: 'projection-state-user',
      conversationId: 'cid-projection-state',
      agentId: 'agent-projection-state',
      taskId: 'cogseed-task-projection-state',
      executionId: 'cogseed-exec-projection-state',
      sessionId: 'cogseed-session-projection-state',
    };

    await expect(bridge.project({ ...base, event: { eventId: 'cogseed-event-delta', type: 'model.delta', payload: { text: 'working' } } })).resolves.toBe('projected');
    await expect(bridge.project({ ...base, event: { eventId: 'cogseed-event-terminal', type: 'task.completed', payload: { text: 'done' } } })).resolves.toBe('projected');
    await expect(bridge.project({ ...base, event: { eventId: 'cogseed-event-terminal', type: 'task.completed', payload: { text: 'done' } } })).resolves.toBe('duplicate');
    await expect(bridge.project({ ...base, event: { eventId: 'cogseed-event-late', type: 'model.delta', payload: { text: 'late' } } })).resolves.toBe('dropped');

    expect(processEvents).toHaveLength(1);
    expect(messages).toEqual([expect.objectContaining({
      agentId: 'agent-projection-state',
      turnId: 'cogseed-exec-projection-state',
      text: 'done',
      process: [{ type: 'progress', text: 'working' }],
    })]);
    expect(processEvents).toEqual([expect.objectContaining({ turnId: 'cogseed-exec-projection-state' })]);
  });

  it('drops events for a deleted conversation without creating projection state', async () => {
    const { createCogSeedGroupChatProjection } = await import('../../../../src/main/features/cogseed_backend/group-chat-projection');
    const appendProcessEvent = vi.fn();
    const bridge = createCogSeedGroupChatProjection({
      conversationExists: vi.fn(async () => false),
      appendProcessEvent,
      appendTerminalMessage: vi.fn(),
    });
    await expect(bridge.project({
      userId: 'projection-deleted-user',
      conversationId: 'cid-deleted',
      agentId: 'agent-deleted',
      taskId: 'cogseed-task-deleted',
      sessionId: 'cogseed-session-deleted',
      event: { eventId: 'cogseed-event-deleted', type: 'model.delta', payload: { text: 'late' } },
    })).resolves.toBe('dropped');
    expect(appendProcessEvent).not.toHaveBeenCalled();
  });

  it('keeps a terminal event retryable when its Conversation disappears during append', async () => {
    const { createCogSeedGroupChatProjection } = await import('../../../../src/main/features/cogseed_backend/group-chat-projection');
    let destinationAvailable = false;
    const appendTerminalMessage = vi.fn(async () => destinationAvailable);
    const bridge = createCogSeedGroupChatProjection({
      conversationExists: vi.fn(async () => true),
      appendProcessEvent: vi.fn(async () => undefined),
      appendTerminalMessage,
    });
    const input = {
      userId: 'projection-delete-race-user',
      conversationId: 'cid-delete-race',
      agentId: 'agent-delete-race',
      taskId: 'cogseed-task-delete-race',
      executionId: 'cogseed-exec-delete-race',
      sessionId: 'cogseed-session-delete-race',
      event: { eventId: 'cogseed-event-delete-race', type: 'task.completed' as const, payload: { text: 'retained result' } },
    };

    await expect(bridge.project(input)).rejects.toThrow(/destination disappeared/i);
    destinationAvailable = true;
    await expect(bridge.project(input)).resolves.toBe('projected');
    expect(appendTerminalMessage).toHaveBeenCalledTimes(2);
  });

  it('commits a terminal event marker only after idempotent process and message side effects succeed', async () => {
    const { createCogSeedGroupChatProjection } = await import('../../../../src/main/features/cogseed_backend/group-chat-projection');
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const input = {
      userId: 'projection-commit-race-user',
      conversationId: 'cid-commit-race',
      agentId: 'agent-commit-race',
      taskId: 'cogseed-task-commit-race',
      executionId: 'cogseed-exec-commit-race',
      sessionId: 'cogseed-session-commit-race',
      event: {
        eventId: 'cogseed-event-commit-race',
        type: 'task.failed' as const,
        payload: { error: 'simulated failure' },
      },
    };
    const stateFile = paths.cogseedTaskProjectionFile(input.userId, input.taskId);
    const processSideEffects = new Set<string>();
    const terminalMessages = new Map<string, string>();
    let markerVisibleBeforeSideEffects = false;
    const readProcessedEventIds = () => {
      if (!fs.existsSync(stateFile)) return [] as string[];
      return (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { processedEventIds?: string[] }).processedEventIds ?? [];
    };
    const appendProcessEvent = vi.fn(async (event: { turnId: string; kind: string }) => {
      markerVisibleBeforeSideEffects ||= readProcessedEventIds().includes(input.event.eventId);
      processSideEffects.add(`${event.turnId}:${event.kind}`);
    });
    const appendTerminalMessage = vi.fn(async (message: { turnId: string; text: string }) => {
      markerVisibleBeforeSideEffects ||= readProcessedEventIds().includes(input.event.eventId);
      if (!terminalMessages.has(message.turnId)) terminalMessages.set(message.turnId, message.text);
      projectionStorageFaults.sideEffectCompleted = true;
      return true;
    });
    const bridge = createCogSeedGroupChatProjection({
      conversationExists: vi.fn(async () => true),
      appendProcessEvent,
      appendTerminalMessage,
    });

    projectionStorageFaults.failCommitAfterSideEffect = true;
    await expect(bridge.project(input)).rejects.toThrow(/state commit failure/i);

    expect(markerVisibleBeforeSideEffects).toBe(false);
    expect(readProcessedEventIds()).not.toContain(input.event.eventId);
    expect(processSideEffects).toEqual(new Set([`${input.executionId}:task.failed`]));
    expect(terminalMessages.size).toBe(1);

    await expect(bridge.project(input)).resolves.toBe('projected');
    await expect(bridge.project(input)).resolves.toBe('duplicate');
    expect(readProcessedEventIds()).toContain(input.event.eventId);
    expect(processSideEffects).toEqual(new Set([`${input.executionId}:task.failed`]));
    expect(terminalMessages.size).toBe(1);
    expect(appendProcessEvent).toHaveBeenCalledTimes(2);
    expect(appendTerminalMessage).toHaveBeenCalledTimes(2);
  });

  it('returns the floor to Commander only for an explicit projected handback marker', async () => {
    const state = await import('../../../../src/main/features/group_chat/state');
    const { applyCogSeedProjectedHandback } = await import('../../../../src/main/features/cogseed_backend/group-chat-projection');
    await state.commitHandoffState('projection-handback-user', 'cid-handback', {
      recipient_id: 'agent-handback',
      ledger: {
        status: 'waiting_for_agent',
        blocked_on: 'agent_handoff',
        source_tool: 'hand_off_to',
        owner_agent_id: 'agent-handback',
        user_goal: 'Finish interactively',
        handoff_message: 'Continue',
        resume_instruction: 'Resume after handback',
      },
    });

    await expect(applyCogSeedProjectedHandback(
      'projection-handback-user', 'cid-handback', 'agent-handback', 'Still interactive.',
    )).resolves.toEqual({ text: 'Still interactive.', handedBack: false });
    expect((await state.readState('projection-handback-user', 'cid-handback')).active_recipient).toBe('agent-handback');

    await expect(applyCogSeedProjectedHandback(
      'projection-handback-user', 'cid-handback', 'agent-handback', 'Finished.\n<handback />',
    )).resolves.toEqual({ text: 'Finished.', handedBack: true });
    const after = await state.readState('projection-handback-user', 'cid-handback');
    expect(after.active_recipient).toBeUndefined();
    expect(after.orchestration_ledger).toBeUndefined();
  });
});
