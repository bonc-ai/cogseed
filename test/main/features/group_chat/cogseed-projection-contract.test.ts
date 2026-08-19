import { describe, expect, it, vi } from 'vitest';

const enqueue = vi.fn();
vi.mock('../../../../src/main/features/group_chat/bus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/group_chat/bus')>();
  return { ...actual, enqueue };
});

describe('CogSeed to Group Chat projection contract', () => {
  it('projects process events and one terminal Agent message without executing through the Group Chat bus', async () => {
    const processEvents: unknown[] = [];
    const terminalMessages: unknown[] = [];
    const { createCogSeedGroupChatProjection } = await import(
      '../../../../src/main/features/cogseed_backend/group-chat-projection'
    );
    const projection = createCogSeedGroupChatProjection({
      conversationExists: vi.fn(async () => true),
      appendProcessEvent: vi.fn(async (input: unknown) => { processEvents.push(input); }),
      appendTerminalMessage: vi.fn(async (input: unknown) => { terminalMessages.push(input); }),
    });
    const base = {
      userId: 'projection-user',
      conversationId: 'cid-projection',
      agentId: 'agent-projection',
      taskId: 'cogseed-task-projection',
      sessionId: 'cogseed-session-gmember-cid-projection-agent-projection',
    };
    const events = [
      { eventId: 'cogseed-event-delta', type: 'model.delta', payload: { text: 'working' } },
      { eventId: 'cogseed-event-tool-start', type: 'tool.started', payload: { name: 'read_file' } },
      { eventId: 'cogseed-event-tool-finish', type: 'tool.finished', payload: { name: 'read_file' } },
      { eventId: 'cogseed-event-complete', type: 'task.completed', payload: { text: 'final answer' } },
      { eventId: 'cogseed-event-failed-late', type: 'task.failed', payload: { error: 'late failure' } },
    ];

    for (const event of events) await projection.project({ ...base, event } as any);
    await projection.project({ ...base, event: events[3] } as any);

    expect(processEvents).toEqual([
      expect.objectContaining({ conversationId: 'cid-projection', agentId: 'agent-projection', kind: 'model.delta' }),
      expect.objectContaining({ conversationId: 'cid-projection', agentId: 'agent-projection', kind: 'tool.started' }),
      expect.objectContaining({ conversationId: 'cid-projection', agentId: 'agent-projection', kind: 'tool.finished' }),
    ]);
    expect(terminalMessages).toEqual([
      expect.objectContaining({
        conversationId: 'cid-projection',
        agentId: 'agent-projection',
        text: 'final answer',
      }),
    ]);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
