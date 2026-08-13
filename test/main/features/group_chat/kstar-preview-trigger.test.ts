import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const previewAssetIds = vi.hoisted(() => ({ value: ['asset-a'] as string[] }));
const previewProjectionIds = vi.hoisted(() => ({ values: ['proj-a'] as string[], index: 0 }));
const projectionMock = vi.hoisted(() => ({
  previewContextProjection: vi.fn(async (_uid: string, input: unknown) => ({ id: previewProjectionIds.values[previewProjectionIds.index++] || `proj-${previewProjectionIds.index}`, status: 'preview', assetIds: [...previewAssetIds.value], ...(input as Record<string, unknown>) })),
}));
const projectionMessageMock = vi.hoisted(() => ({
  postProjectionCardMessage: vi.fn(async (userId: string, input: { cid: string; projectionId: string }, port: { send: (payload: unknown) => Promise<{ id: string }> }) => {
    const card = { kind: 'recall_projection_card', projectionId: input.projectionId, taskRunId: 'kst-a', purpose: 'review', status: 'preview' };
    const msg = await port.send({ userId, cid: input.cid, text: 'Found 0 reusable ability assets for this task; omitted 0.', card });
    return { ok: true, msg, card };
  }),
}));

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/main/features/recall/context-projection', () => projectionMock);
vi.mock('../../../../src/main/features/recall/projection-message', () => projectionMessageMock);
vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel() { yield { type: 'final', text: '' }; yield { type: 'done' }; },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
  abortActiveSessionsForConversation: vi.fn(() => 0),
}));

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kstar-preview-trigger-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  projectionMock.previewContextProjection.mockClear();
  projectionMessageMock.postProjectionCardMessage.mockClear();
  previewProjectionIds.values = ['proj-a'];
  previewProjectionIds.index = 0;
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});


async function waitForMessages(loader: () => Promise<unknown[]>): Promise<unknown[]> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const messages = await loader();
    if (messages.length >= 2) return messages;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('messages not posted');
}

async function waitForMessagesAtLeast(loader: () => Promise<unknown[]>, minimum: number): Promise<unknown[]> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const messages = await loader();
    if (messages.length >= minimum) return messages;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected at least ${minimum} messages`);
}

async function waitForProjectionMessage(
  groupChat: { readMessages: (userId: string, cid: string) => Promise<unknown[]> },
  userId: string,
  cid: string,
  projectionId: string,
): Promise<unknown[]> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const messages = await groupChat.readMessages(userId, cid);
    if (messages.some((message) => (message as { recall_projection_card?: { projectionId?: string } }).recall_projection_card?.projectionId === projectionId)) return messages;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`projection message not posted: ${projectionId}`);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not met');
}

describe('KSTAR requirement preview trigger', () => {
  it('requests a task-scoped preview without workspace id when the user message has none', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('user-a');
    const state = await import('../../../../src/main/features/kstar/requirement-state');

    const result = await state.routeKstarUserMessage('user-a', {
      conversationId: 'cid-a',
      messageId: 'msg-a',
      text: '修复 OAuth callback',
    }, {
      routerOptions: {
        classify: async () => ({
          intent: 'new',
          confidence: 1,
          reason: 'fake route',
          requirementText: '修复 OAuth callback',
        }),
      },
    });

    expect(projectionMock.previewContextProjection).toHaveBeenCalledWith('user-a', expect.objectContaining({
      taskRunId: expect.stringMatching(/^kst-/),
      purpose: '修复 OAuth callback',
      taskText: '修复 OAuth callback',
    }));
    expect(projectionMock.previewContextProjection.mock.calls[0][1]).not.toHaveProperty('workspaceId');
    expect(result.projectionPreviewCreated).toEqual({ projectionId: 'proj-a' });
  });

  it('posts a visible Recall projection card even when no assets match automatically', async () => {
    previewAssetIds.value = [];
    const users = await import('../../../../src/main/features/users');
    users.activateUser('user-a');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');

    await bus.enqueue({ uid: 'user-a', cid: 'cid-empty', fromActorId: 'user', text: '整理 OAuth 回调流程' });

    await waitFor(() => projectionMessageMock.postProjectionCardMessage.mock.calls.length > 0);
    expect(projectionMock.previewContextProjection).toHaveBeenCalledWith('user-a', expect.objectContaining({
      purpose: expect.any(String),
      taskText: '整理 OAuth 回调流程',
    }));
    expect(projectionMessageMock.postProjectionCardMessage).toHaveBeenCalledWith(
      'user-a',
      { cid: 'cid-empty', projectionId: 'proj-a' },
      expect.objectContaining({ send: expect.any(Function) }),
    );
    const messages = await waitForMessages(() => groupChat.readMessages('user-a', 'cid-empty'));
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: 'commander',
        to: ['user'],
        recall_projection_card: { projectionId: 'proj-a' },
      }),
    ]));
  });

  it('posts a fresh visible Recall projection card for a continued user message', async () => {
    previewProjectionIds.values = ['proj-a', 'proj-b'];
    const users = await import('../../../../src/main/features/users');
    users.activateUser('user-a');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');

    await bus.enqueue({ uid: 'user-a', cid: 'cid-continue', fromActorId: 'user', text: '修复 OAuth callback' });
    await waitFor(() => projectionMessageMock.postProjectionCardMessage.mock.calls.length === 1);

    await bus.enqueue({ uid: 'user-a', cid: 'cid-continue', fromActorId: 'user', text: '继续检查 refresh token' });
    await waitFor(() => projectionMessageMock.postProjectionCardMessage.mock.calls.length === 2);

    expect(projectionMock.previewContextProjection).toHaveBeenCalledTimes(2);
    expect(projectionMock.previewContextProjection.mock.calls[1][1]).toEqual(expect.objectContaining({
      taskText: '继续检查 refresh token',
      purpose: expect.any(String),
    }));
    expect(projectionMessageMock.postProjectionCardMessage).toHaveBeenLastCalledWith(
      'user-a',
      { cid: 'cid-continue', projectionId: 'proj-b' },
      expect.objectContaining({ send: expect.any(Function) }),
    );
    const messages = await waitForProjectionMessage(groupChat, 'user-a', 'cid-continue', 'proj-b');
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: 'commander',
        to: ['user'],
        recall_projection_card: { projectionId: 'proj-b' },
      }),
    ]));
  });

  it('blocks the Commander dispatch until the projection is confirmed', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('user-a');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const state = await import('../../../../src/main/features/group_chat/state');
    const groupChat = await import('../../../../src/main/features/group_chat');

    const msg = await bus.enqueue({ uid: 'user-a', cid: 'cid-block', fromActorId: 'user', text: '修复 OAuth callback' });

    // User message is visible but routed to the human-only sink, not commander.
    expect(msg.to).toEqual(['user']);

    const stateFile = await state.readState('user-a', 'cid-block');
    expect(stateFile.pending_projection_dispatch).toMatchObject({
      projectionId: 'proj-a',
      userMessageId: msg.id,
      userMessageText: '修复 OAuth callback',
    });

    // Confirm resumes the commander dispatch.
    const resumed = await bus.resumePendingProjectionDispatch('user-a', 'cid-block');
    expect(resumed).toBe(true);
    const cleared = await state.readState('user-a', 'cid-block');
    expect(cleared.pending_projection_dispatch).toBeUndefined();

    const messages = await waitForMessagesAtLeast(() => groupChat.readMessages('user-a', 'cid-block'), 4);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'user', text: '修复 OAuth callback', dispatch: true, to: ['commander'] }),
    ]));
  });

  it('posts a visible Recall projection card when a normal user message creates a KSTAR task', async () => {
    const users = await import('../../../../src/main/features/users');
    users.activateUser('user-a');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');

    await bus.enqueue({ uid: 'user-a', cid: 'cid-post', fromActorId: 'user', text: '修复 OAuth callback' });

    await waitFor(() => projectionMessageMock.postProjectionCardMessage.mock.calls.length > 0);
    expect(projectionMessageMock.postProjectionCardMessage).toHaveBeenCalledWith(
      'user-a',
      { cid: 'cid-post', projectionId: 'proj-a' },
      expect.objectContaining({ send: expect.any(Function) }),
    );
    const messages = await waitForMessages(() => groupChat.readMessages('user-a', 'cid-post'));
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: 'commander',
        to: ['user'],
        recall_projection_card: { projectionId: 'proj-a' },
      }),
    ]));
  });
});
