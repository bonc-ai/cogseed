import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

/**
 * 过期暂存必须在主进程的确认边界被拒绝，而不是靠 UI 不显示按钮。
 *
 * 这里走真实的 `a2a.reception.confirm` handler + 真实 reception-service，只把
 * 模型运行（runReception）换成计数替身：过期时必须 0 次；正对照 9 分钟时恰好 1 次。
 *
 * P2-10 起同一 handler 还负责把 `expectedMessageId` 透传给 reception-service，并在
 * 入参不是非空字符串时直接拒绝（不猜、不落库）：多余字段绝不会被当成问题内容。
 */
const U = 'cs_receiver_ipc';
const CID = 'a2a-0123456789abcdef0202';
const LIVE_CID = 'a2a-0123456789abcdef0203';
const DECLINE_CID = 'a2a-0123456789abcdef0204';
const PEER = 'cs_alice';
const TEXT = '你们的标准折扣是多少？';
const MINUTE = 60 * 1000;

let invokeHandler: ((event: unknown, request: { channel: string; payload?: unknown }) => Promise<any>) | null = null;
let tmp = '';
let previous: string | undefined;

const runReceptionMock = vi.hoisted(() => vi.fn(async () => ({ status: 'answered' })));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      if (channel === 'cogseed.invoke') invokeHandler = fn;
    },
    on: vi.fn(),
  },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));
vi.mock('../../../src/main/features/a2a/reception-run', () => ({ runReception: runReceptionMock }));
vi.mock('../../../src/main/features/a2a/reception-nudge', () => ({
  scheduleReceptionNudge: vi.fn(),
  cancelReceptionNudge: vi.fn(),
}));
vi.mock('../../../src/main/features/a2a/relay-pump', () => ({ startRelayPump: vi.fn(() => vi.fn()) }));
vi.mock('../../../src/main/features/contacts/presence', () => ({ startPresenceHeartbeat: vi.fn() }));

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-expired-ipc-')));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  invokeHandler = null;
  runReceptionMock.mockClear();
  vi.resetModules();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../src/main/features/users');
  users.activateUser(U);
  const { writeJson } = await import('../../../src/main/storage');
  const { userContactsFile } = await import('../../../src/main/paths');
  await writeJson(userContactsFile(U), {
    version: 1,
    contacts: [{ userId: PEER, name: 'Alice', addedAt: new Date().toISOString() }],
  });
  (await import('../../../src/main/ipc/index')).register();
});

afterEach(() => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.resetModules();
});

function call(channel: string, payload: unknown = {}) {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

async function seedWaiting(cid: string, receivedAt: string): Promise<void> {
  const chats = await import('../../../src/main/features/chats');
  await chats.createConversation(U, { conversationId: cid, title: 'Alice 的来访' });
  await chats.updateConversation(U, cid, {
    a2a: { inbound: true, peer_user_id: PEER, peer_name: 'Alice', state: 'waiting', exchange_id: cid },
    a2a_pending_reception: {
      messageId: `amsg-${cid}`,
      conversationId: cid,
      peerUserId: PEER,
      peerName: 'Alice',
      text: TEXT,
      receivedAt,
      state: 'pending',
    },
  });
}

describe('ipc > A2A reception staging expiry', () => {
  it('refuses a stale confirmation in main and never starts a provider run', async () => {
    // 相对当前挂钟：绝对时间种子会随运行时刻漂移，早于该时刻的运行会误判。
    await seedWaiting(CID, new Date(Date.now() - 11 * MINUTE).toISOString());

    const result = await call('a2a.reception.confirm', { conversationId: CID });

    expect(result).toMatchObject({ ok: true, confirmed: false, error: 'reception_expired' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(runReceptionMock).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('marker');
  });

  it('cleans expired staging before the inbox projection is read', async () => {
    const receivedAt = new Date(Date.now() - 11 * MINUTE).toISOString();
    await seedWaiting(CID, receivedAt);

    const result = await call('a2a.reception.pending', {});

    expect(result).toMatchObject({ ok: true, pending: [] });
    expect(runReceptionMock).not.toHaveBeenCalled();
    const chats = await import('../../../src/main/features/chats');
    const conversation = await chats.getConversation(U, CID);
    expect(conversation?.a2a?.state).toBe('expired');
    expect(conversation?.a2a_pending_reception).toMatchObject({
      text: '', expired_reason: 'stale', receivedAt,
    });
  });

  it('still starts exactly one reception for an unbound legacy confirmation inside the deadline', async () => {
    await seedWaiting(LIVE_CID, new Date(Date.now() - 9 * MINUTE).toISOString());
    const preview = await call('a2a.reception.preview', { conversationId: LIVE_CID });
    expect(preview.ok).toBe(true);

    // 缺省 expectedMessageId：旧渲染层/旧调用方的行为保持不变（不绑定 pending 身份）。
    const result = await call('a2a.reception.confirm', {
      conversationId: LIVE_CID,
      expectedPreview: preview.preview,
    });

    expect(result).toMatchObject({ ok: true, confirmed: true, started: true });
    await vi.waitFor(() => expect(runReceptionMock).toHaveBeenCalledTimes(1));
    expect(runReceptionMock).toHaveBeenCalledWith(U, expect.objectContaining({
      conversationId: LIVE_CID,
      messageId: `amsg-${LIVE_CID}`,
      text: TEXT,
    }));
  });
});

describe('ipc > A2A reception decision binding (P2-10)', () => {
  it('rejects a confirmation bound to a different pending message without starting a run', async () => {
    await seedWaiting(CID, new Date(Date.now() - MINUTE).toISOString());
    const preview = await call('a2a.reception.preview', { conversationId: CID });

    const result = await call('a2a.reception.confirm', {
      conversationId: CID,
      expectedPreview: preview.preview,
      expectedMessageId: 'amsg-someone-else',
    });

    expect(result).toMatchObject({ ok: true, confirmed: false, error: 'reception_stale_pending' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(runReceptionMock).not.toHaveBeenCalled();
    const chats = await import('../../../src/main/features/chats');
    const conversation = await chats.getConversation(U, CID);
    expect(conversation?.a2a?.state).toBe('waiting');
    expect(conversation?.a2a_pending_reception).toMatchObject({ messageId: `amsg-${CID}` });
  });

  it('passes the bound id through and confirms only the pending message the user saw', async () => {
    await seedWaiting(LIVE_CID, new Date(Date.now() - 9 * MINUTE).toISOString());
    const preview = await call('a2a.reception.preview', { conversationId: LIVE_CID });

    const stale = await call('a2a.reception.confirm', {
      conversationId: LIVE_CID,
      expectedPreview: preview.preview,
      expectedMessageId: 'amsg-foreign',
    });
    expect(stale).toMatchObject({ confirmed: false, error: 'reception_stale_pending' });
    expect(runReceptionMock).not.toHaveBeenCalled();

    const result = await call('a2a.reception.confirm', {
      conversationId: LIVE_CID,
      expectedPreview: preview.preview,
      expectedMessageId: `amsg-${LIVE_CID}`,
    });

    expect(result).toMatchObject({ ok: true, confirmed: true, started: true });
    await vi.waitFor(() => expect(runReceptionMock).toHaveBeenCalledTimes(1));
    expect(runReceptionMock).toHaveBeenCalledWith(U, expect.objectContaining({
      conversationId: LIVE_CID,
      messageId: `amsg-${LIVE_CID}`,
    }));
  });

  it('refuses to guess a malformed expected id on confirm and decline', async () => {
    await seedWaiting(CID, new Date(Date.now() - MINUTE).toISOString());

    for (const expectedMessageId of [42, '', '   ', null, {}, []]) {
      expect(await call('a2a.reception.confirm', { conversationId: CID, expectedMessageId }))
        .toMatchObject({ ok: true, confirmed: false, error: 'invalid expected message id' });
      expect(await call('a2a.reception.decline', { conversationId: CID, expectedMessageId }))
        .toMatchObject({ ok: true, declined: false, error: 'invalid expected message id' });
    }
    // 入参校验失败不允许触碰会话，更不允许起模型。
    expect(runReceptionMock).not.toHaveBeenCalled();
    const chats = await import('../../../src/main/features/chats');
    const conversation = await chats.getConversation(U, CID);
    expect(conversation?.a2a?.state).toBe('waiting');
    expect(conversation?.a2a_pending_reception).toMatchObject({
      messageId: `amsg-${CID}`, text: TEXT, state: 'pending',
    });
  });

  it('rejects a decline bound to a different pending message and passes the matching id through', async () => {
    await seedWaiting(DECLINE_CID, new Date(Date.now() - MINUTE).toISOString());

    const stale = await call('a2a.reception.decline', {
      conversationId: DECLINE_CID,
      expectedMessageId: 'amsg-foreign',
    });
    expect(stale).toMatchObject({ ok: true, declined: false, error: 'reception_stale_pending' });
    const chats = await import('../../../src/main/features/chats');
    let conversation = await chats.getConversation(U, DECLINE_CID);
    expect(conversation?.a2a?.state).toBe('waiting');
    expect(conversation?.a2a_pending_reception).toMatchObject({ messageId: `amsg-${DECLINE_CID}` });

    const declined = await call('a2a.reception.decline', {
      conversationId: DECLINE_CID,
      expectedMessageId: `amsg-${DECLINE_CID}`,
    });
    expect(declined).toMatchObject({ ok: true, declined: true });
    conversation = await chats.getConversation(U, DECLINE_CID);
    expect(conversation?.a2a?.state).toBe('refused');
    expect(conversation?.a2a_pending_reception).toBeUndefined();
  });

  it('keeps an unbound legacy decline working when no id is supplied', async () => {
    await seedWaiting(DECLINE_CID, new Date(Date.now() - MINUTE).toISOString());

    expect(await call('a2a.reception.decline', { conversationId: DECLINE_CID }))
      .toMatchObject({ ok: true, declined: true });
  });
});
