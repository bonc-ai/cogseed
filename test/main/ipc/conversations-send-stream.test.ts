import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type StreamStartFn = (
  event: { sender: { getURL: () => string; isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void } },
  req: { requestId: string; channel: string; payload?: unknown },
) => Promise<void>;
type StreamCancelFn = (
  event: { sender: { getURL: () => string } },
  requestId: unknown,
) => void;
type InvokeFn = (
  event: { sender: { getURL: () => string } },
  req: { channel: string; payload?: unknown },
) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

let streamStartHandler: StreamStartFn | null = null;
let streamCancelHandler: StreamCancelFn | null = null;
let invokeHandler: InvokeFn | null = null;

const groupChatMock = vi.hoisted(() => ({
  subscribers: new Set<(ev: unknown) => void>(),
  quiescent: false,
  releaseSend: null as null | (() => void),
  resolveSendStarted: null as null | (() => void),
  resolveSendFinished: null as null | (() => void),
  sendStarted: Promise.resolve(),
  sendFinished: Promise.resolve(),
  sendCalls: [] as unknown[],
  sendResult: { ok: true } as Record<string, unknown>,
  retryCalls: [] as unknown[],
  editCalls: [] as unknown[],
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: InvokeFn) => {
      if (channel === 'cogseed.invoke') invokeHandler = fn;
    },
    on: (channel: string, fn: StreamStartFn | StreamCancelFn) => {
      if (channel === 'cogseed.streamStart') streamStartHandler = fn as StreamStartFn;
      if (channel === 'cogseed.streamCancel') streamCancelHandler = fn as StreamCancelFn;
    },
  },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
}));

vi.mock('../../../src/main/features/group_chat', () => ({
  subscribeBus: vi.fn((_userId: string, _cid: string, cb: (ev: unknown) => void) => {
    groupChatMock.subscribers.add(cb);
    return () => groupChatMock.subscribers.delete(cb);
  }),
  send: vi.fn(async (input: unknown) => {
    groupChatMock.sendCalls.push(input);
    groupChatMock.resolveSendStarted?.();
    await new Promise<void>((resolve) => { groupChatMock.releaseSend = resolve; });
    groupChatMock.resolveSendFinished?.();
    return groupChatMock.sendResult;
  }),
  retryFailedTurn: vi.fn(async (input: unknown) => {
    groupChatMock.retryCalls.push(input);
    groupChatMock.resolveSendStarted?.();
    await new Promise<void>((resolve) => { groupChatMock.releaseSend = resolve; });
    groupChatMock.resolveSendFinished?.();
    return { ok: true, mode: 'resume' };
  }),
  replaceUserMessage: vi.fn(async (input: unknown) => {
    groupChatMock.editCalls.push(input);
    groupChatMock.resolveSendStarted?.();
    await new Promise<void>((resolve) => { groupChatMock.releaseSend = resolve; });
    groupChatMock.resolveSendFinished?.();
    return { ok: true, msg: { id: 'replacement-msg', text: 'edited' } };
  }),
  busIsQuiescent: vi.fn(() => groupChatMock.quiescent),
  streamEvents: vi.fn(async function* () {}),
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-send-stream-ipc-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  streamStartHandler = null;
  streamCancelHandler = null;
  invokeHandler = null;
  groupChatMock.subscribers.clear();
  groupChatMock.quiescent = false;
  groupChatMock.releaseSend = null;
  groupChatMock.sendCalls.length = 0;
  groupChatMock.sendResult = { ok: true };
  groupChatMock.retryCalls.length = 0;
  groupChatMock.editCalls.length = 0;
  groupChatMock.sendStarted = new Promise<void>((resolve) => { groupChatMock.resolveSendStarted = resolve; });
  groupChatMock.sendFinished = new Promise<void>((resolve) => { groupChatMock.resolveSendFinished = resolve; });
  vi.resetModules();

  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

describe('ipc › conversations.sendStream', () => {
  it('forwards the server-owned active floor route through invoke and stream IPC', async () => {
    if (!invokeHandler || !streamStartHandler) throw new Error('ipc handlers not registered');
    const invokeRun = invokeHandler(
      { sender: trustedIpcSender() },
      {
        channel: 'groupChat.send',
        payload: {
          cid: 'c123abc',
          content: 'continue',
          recipient_agent_id: 'agent-floor-1',
          recipient_origin: 'active_floor',
        },
      },
    );
    await groupChatMock.sendStarted;
    expect(groupChatMock.sendCalls.at(-1)).toEqual({
      userId: TEST_UID,
      cid: 'c123abc',
      text: 'continue',
      recipient_agent_id: 'agent-floor-1',
      recipient_origin: 'active_floor',
    });
    groupChatMock.releaseSend?.();
    await expect(invokeRun).resolves.toMatchObject({ ok: true });

    groupChatMock.sendStarted = new Promise<void>((resolve) => { groupChatMock.resolveSendStarted = resolve; });
    const streamRun = streamStartHandler(
      { sender: trustedIpcSender({ isDestroyed: () => false, send: vi.fn() }) },
      {
        requestId: 'active-floor-request',
        channel: 'conversations.sendStream',
        payload: {
          cid: 'c123abc',
          content: 'continue',
          recipient_agent_id: 'agent-floor-1',
          recipient_origin: 'active_floor',
        },
      },
    );
    await groupChatMock.sendStarted;
    expect(groupChatMock.sendCalls.at(-1)).toEqual({
      userId: TEST_UID,
      cid: 'c123abc',
      text: 'continue',
      recipient_agent_id: 'agent-floor-1',
      recipient_origin: 'active_floor',
    });
    groupChatMock.quiescent = true;
    groupChatMock.releaseSend?.();
    await streamRun;
  });

  it('rejects an unknown recipient origin through invoke and stream IPC', async () => {
    if (!invokeHandler || !streamStartHandler) throw new Error('ipc handlers not registered');
    const invokeRes = await invokeHandler(
      { sender: trustedIpcSender() },
      {
        channel: 'groupChat.send',
        payload: {
          cid: 'c123abc',
          content: 'continue',
          recipient_agent_id: 'agent-floor-1',
          recipient_origin: 'invented',
        },
      },
    );
    expect(invokeRes).toMatchObject({ ok: false, error: 'invalid recipient route' });

    const sent = vi.fn();
    await streamStartHandler(
      { sender: trustedIpcSender({ isDestroyed: () => false, send: sent }) },
      {
        requestId: 'unknown-origin-request',
        channel: 'conversations.sendStream',
        payload: {
          cid: 'c123abc',
          content: 'continue',
          recipient_agent_id: 'agent-floor-1',
          recipient_origin: 'invented',
        },
      },
    );
    expect(groupChatMock.sendCalls).toEqual([]);
    expect(sent).toHaveBeenCalledWith(
      'stream:unknown-origin-request',
      expect.objectContaining({ type: 'error', text: 'invalid recipient route' }),
    );
  });

  it('forwards a validated structured Agent selection to the group-chat facade', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    const sender = trustedIpcSender({ isDestroyed: () => false, send: vi.fn() });
    const run = streamStartHandler(
      { sender },
      {
        requestId: 'selected-agent-request',
        channel: 'conversations.sendStream',
        payload: {
          cid: 'c123abc',
          content: '发热还',
          recipient_agent_id: 'agent-codex-1',
          recipient_origin: 'user_selection',
        },
      },
    );

    await groupChatMock.sendStarted;
    expect(groupChatMock.sendCalls).toEqual([{
      userId: TEST_UID,
      cid: 'c123abc',
      text: '发热还',
      recipient_agent_id: 'agent-codex-1',
      recipient_origin: 'user_selection',
    }]);

    groupChatMock.quiescent = true;
    groupChatMock.releaseSend?.();
    await run;
  });

  it('forwards a validated member / mention selection with per-source configs', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    const sender = trustedIpcSender({ isDestroyed: () => false, send: vi.fn() });
    const run = streamStartHandler(
      { sender },
      {
        requestId: 'member-selection-request',
        channel: 'conversations.sendStream',
        payload: {
          cid: 'c123abc',
          content: '@Codex 看这个',
          member_agent_ids: ['agent-codex-1', 'agent-task-2', 'agent-codex-1'],
          mention_agent_ids: ['agent-codex-1'],
          execution_configs: {
            internal: { provider: 'deepseek', model: 'deepseek-v4-pro', effort: 'high' },
            'agent-codex-1': { model: 'gpt-5.6-sol' },
          },
        },
      },
    );

    await groupChatMock.sendStarted;
    expect(groupChatMock.sendCalls).toEqual([{
      userId: TEST_UID,
      cid: 'c123abc',
      text: '@Codex 看这个',
      // 名单去重后原样下发；形状之外的语义校验由 group-chat facade 负责。
      member_agent_ids: ['agent-codex-1', 'agent-task-2'],
      mention_agent_ids: ['agent-codex-1'],
      execution_configs: {
        internal: { provider: 'deepseek', model: 'deepseek-v4-pro', effort: 'high' },
        'agent-codex-1': { model: 'gpt-5.6-sol' },
      },
    }]);

    groupChatMock.quiescent = true;
    groupChatMock.releaseSend?.();
    await run;
  });

  it('rejects malformed member selections before dispatch', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    for (const payload of [
      { member_agent_ids: ['../escape'] },
      { member_agent_ids: ['ok-agent', 42] },
      { mention_agent_ids: 'agent-codex-1' },
      { execution_configs: ['internal'] },
      { member_agent_ids: Array.from({ length: 21 }, (_, i) => `agent-${i}`) },
    ]) {
      groupChatMock.sendCalls.length = 0;
      await streamStartHandler(
        { sender: trustedIpcSender({ isDestroyed: () => false, send: vi.fn() }) },
        {
          requestId: `bad-member-${Math.random().toString(36).slice(2, 8)}`,
          channel: 'conversations.sendStream',
          payload: { cid: 'c123abc', content: 'hello', ...payload },
        },
      );
      expect(groupChatMock.sendCalls).toEqual([]);
    }
  });

  it('forwards a submit request id and rejects malformed ones (EC-07)', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    const run = streamStartHandler(
      { sender: trustedIpcSender({ isDestroyed: () => false, send: vi.fn() }) },
      {
        requestId: 'submit-id-request',
        channel: 'conversations.sendStream',
        payload: { cid: 'c123abc', content: 'hello', submit_request_id: 'req_abc12345' },
      },
    );
    await groupChatMock.sendStarted;
    expect(groupChatMock.sendCalls).toEqual([{
      userId: TEST_UID,
      cid: 'c123abc',
      text: 'hello',
      submit_request_id: 'req_abc12345',
    }]);
    groupChatMock.quiescent = true;
    groupChatMock.releaseSend?.();
    await run;

    for (const bad of ['has space', 'x'.repeat(65), 'req/../escape', 42]) {
      groupChatMock.sendCalls.length = 0;
      await streamStartHandler(
        { sender: trustedIpcSender({ isDestroyed: () => false, send: vi.fn() }) },
        {
          requestId: `bad-submit-${Math.random().toString(36).slice(2, 8)}`,
          channel: 'conversations.sendStream',
          payload: { cid: 'c123abc', content: 'hello', submit_request_id: bad },
        },
      );
      expect(groupChatMock.sendCalls).toEqual([]);
    }
  });

  it('relays the exact acceptance receipt on both first acceptance and replay', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    groupChatMock.quiescent = true;
    groupChatMock.sendResult = {
      ok: true,
      accepted: true,
      cid: 'c123abc',
      submit_request_id: 'req_receipt123',
    };

    for (const requestId of ['acceptance-first', 'acceptance-replay']) {
      groupChatMock.sendStarted = new Promise<void>((resolve) => { groupChatMock.resolveSendStarted = resolve; });
      const sent = vi.fn();
      const run = streamStartHandler(
        { sender: trustedIpcSender({ isDestroyed: () => false, send: sent }) },
        {
          requestId,
          channel: 'conversations.sendStream',
          payload: {
            cid: 'c123abc',
            content: 'hello',
            submit_request_id: 'req_receipt123',
          },
        },
      );
      await groupChatMock.sendStarted;
      groupChatMock.releaseSend?.();
      await run;
      expect(sent).toHaveBeenCalledWith(`stream:${requestId}`, {
        type: 'accepted',
        accepted: true,
        cid: 'c123abc',
        submit_request_id: 'req_receipt123',
      });
    }
  });

  it('rejects malformed structured Agent routes before dispatch', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    const sent = vi.fn();
    await streamStartHandler(
      { sender: trustedIpcSender({ isDestroyed: () => false, send: sent }) },
      {
        requestId: 'invalid-agent-request',
        channel: 'conversations.sendStream',
        payload: {
          cid: 'c123abc',
          content: 'hello',
          recipient_agent_id: '../agent',
          recipient_origin: 'cli_fallback',
        },
      },
    );

    expect(groupChatMock.sendCalls).toEqual([]);
    expect(sent).toHaveBeenCalledWith(
      'stream:invalid-agent-request',
      expect.objectContaining({ type: 'error', text: 'invalid recipient route' }),
    );
  });

  it('routes a failed-message retry to the smart retry path instead of a normal send', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    const sender = trustedIpcSender({ isDestroyed: () => false, send: vi.fn() });
    const run = streamStartHandler(
      { sender },
      {
        requestId: 'retry-request',
        channel: 'conversations.sendStream',
        payload: {
          cid: 'c123abc',
          content: 'Continue',
          retry_message_id: 'failed-message-1',
        },
      },
    );

    await groupChatMock.sendStarted;
    expect(groupChatMock.retryCalls).toEqual([{
      userId: TEST_UID,
      cid: 'c123abc',
      failedMessageId: 'failed-message-1',
      visibleText: 'Continue',
      requestId: expect.stringMatching(/^req-chat-retry-/),
    }]);
    expect(groupChatMock.sendCalls).toEqual([]);

    groupChatMock.quiescent = true;
    groupChatMock.releaseSend?.();
    await run;
  });

  it('routes edit_message_id to user-message replacement and keeps retry mutually exclusive', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    const sender = trustedIpcSender({ isDestroyed: () => false, send: vi.fn() });
    const run = streamStartHandler(
      { sender },
      {
        requestId: 'edit-request',
        channel: 'conversations.sendStream',
        payload: {
          cid: 'c123abc',
          content: 'edited content',
          edit_message_id: 'user-message-1',
          attachments: ['ignored-by-backend'],
        },
      },
    );

    await groupChatMock.sendStarted;
    expect(groupChatMock.editCalls).toEqual([{
      userId: TEST_UID,
      cid: 'c123abc',
      messageId: 'user-message-1',
      text: 'edited content',
    }]);
    expect(groupChatMock.sendCalls).toEqual([]);
    expect(groupChatMock.retryCalls).toEqual([]);
    groupChatMock.quiescent = true;
    groupChatMock.releaseSend?.();
    await run;
  });

  it('ignores stream starts from an untrusted sender', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    const sent = vi.fn();
    await streamStartHandler(
      {
        sender: {
          getURL: () => 'https://evil.example/index.html',
          isDestroyed: () => false,
          send: sent,
        },
      },
      {
        requestId: 'untrusted',
        channel: 'conversations.sendStream',
        payload: { cid: 'c123abc', content: 'go' },
      },
    );
    expect(sent).not.toHaveBeenCalled();
    expect(groupChatMock.subscribers.size).toBe(0);
  });

  it('does not let a second sender cancel another sender\'s stream', async () => {
    if (!streamStartHandler || !streamCancelHandler) throw new Error('stream handlers not registered');
    const owner = trustedIpcSender({ isDestroyed: () => false, send: vi.fn() });
    const other = trustedIpcSender({ isDestroyed: () => false, send: vi.fn() });
    let settled = false;
    const run = streamStartHandler(
      { sender: owner },
      {
        requestId: 'owned-stream',
        channel: 'conversations.sendStream',
        payload: { cid: 'c123abc', content: 'go' },
      },
    ).finally(() => { settled = true; });
    await groupChatMock.sendStarted;

    streamCancelHandler({ sender: other }, 'owned-stream');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    streamCancelHandler({ sender: owner }, 'owned-stream');
    await run;
    expect(settled).toBe(true);
    groupChatMock.releaseSend?.();
  });

  it('rejects a duplicate request id without replacing the original owner', async () => {
    if (!streamStartHandler || !streamCancelHandler) throw new Error('stream handlers not registered');
    const first = trustedIpcSender({ isDestroyed: () => false, send: vi.fn() });
    const duplicateSent = vi.fn();
    const second = trustedIpcSender({ isDestroyed: () => false, send: duplicateSent });
    const original = streamStartHandler(
      { sender: first },
      {
        requestId: 'same-id',
        channel: 'conversations.sendStream',
        payload: { cid: 'c123abc', content: 'go' },
      },
    );
    await groupChatMock.sendStarted;

    await streamStartHandler(
      { sender: second },
      {
        requestId: 'same-id',
        channel: 'conversations.sendStream',
        payload: { cid: 'c123abc', content: 'duplicate' },
      },
    );
    expect(duplicateSent).toHaveBeenNthCalledWith(1, 'stream:same-id', {
      type: 'error',
      text: 'duplicate stream request id',
    });
    expect(duplicateSent).toHaveBeenNthCalledWith(2, 'stream:same-id', { type: 'done' });

    streamCancelHandler({ sender: first }, 'same-id');
    await original;
    groupChatMock.releaseSend?.();
  });

  it('relays group bus events before groupChat.send resolves', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    const sent: Array<{ channel: string; payload: any }> = [];
    const sender = trustedIpcSender({
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    });

    const run = streamStartHandler(
      { sender },
      {
        requestId: 'req1',
        channel: 'conversations.sendStream',
        payload: { cid: 'c123abc', content: 'go' },
      },
    );
    await groupChatMock.sendStarted;

    const liveEvent = {
      type: 'process',
      cid: 'c123abc',
      actor: 'agent1',
      data: { type: 'delta', text: 'live' },
    };
    for (const cb of groupChatMock.subscribers) cb(liveEvent);

    await waitFor(() => sent.some((item) => item.channel === 'stream:req1' && item.payload?.event?.data === liveEvent));
    expect(sent.some((item) => item.payload?.type === 'done')).toBe(false);

    groupChatMock.quiescent = true;
    groupChatMock.releaseSend?.();
    await run;

    expect(sent.at(-1)).toEqual({ channel: 'stream:req1', payload: { type: 'done' } });
  });

  it('keeps relaying group bus events after groupChat.send resolves while the bus is still active', async () => {
    if (!streamStartHandler) throw new Error('stream handler not registered');
    const sent: Array<{ channel: string; payload: any }> = [];
    const sender = trustedIpcSender({
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    });

    const run = streamStartHandler(
      { sender },
      {
        requestId: 'req2',
        channel: 'conversations.sendStream',
        payload: { cid: 'c123abc', content: 'go' },
      },
    );
    await groupChatMock.sendStarted;
    groupChatMock.quiescent = false;
    groupChatMock.releaseSend?.();
    await groupChatMock.sendFinished;

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent.some((item) => item.payload?.type === 'done')).toBe(false);

    const liveEvent = {
      type: 'process',
      cid: 'c123abc',
      actor: 'agent1',
      data: { type: 'event', event: { stream: 'tool', data: { phase: 'start', id: 't1', name: 'web_search' } } },
    };
    for (const cb of groupChatMock.subscribers) cb(liveEvent);

    await waitFor(() => sent.some((item) => item.channel === 'stream:req2' && item.payload?.event?.data === liveEvent));
    groupChatMock.quiescent = true;
    for (const cb of groupChatMock.subscribers) cb({ type: 'state_changed', cid: 'c123abc', state: { status: 'idle', in_flight: [] } });
    await run;

    expect(sent.at(-1)).toEqual({ channel: 'stream:req2', payload: { type: 'done' } });
  });
});
