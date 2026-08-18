import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-group-chat-projection-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
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
      sessionId: 'cogseed-session-projection-state',
    };

    await expect(bridge.project({ ...base, event: { eventId: 'cogseed-event-delta', type: 'model.delta', payload: { text: 'working' } } })).resolves.toBe('projected');
    await expect(bridge.project({ ...base, event: { eventId: 'cogseed-event-terminal', type: 'task.completed', payload: { text: 'done' } } })).resolves.toBe('projected');
    await expect(bridge.project({ ...base, event: { eventId: 'cogseed-event-terminal', type: 'task.completed', payload: { text: 'done' } } })).resolves.toBe('duplicate');
    await expect(bridge.project({ ...base, event: { eventId: 'cogseed-event-late', type: 'model.delta', payload: { text: 'late' } } })).resolves.toBe('dropped');

    expect(processEvents).toHaveLength(1);
    expect(messages).toEqual([expect.objectContaining({
      agentId: 'agent-projection-state',
      text: 'done',
      process: [{ type: 'progress', text: 'working' }],
    })]);
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
