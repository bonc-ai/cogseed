import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

let invokeHandler: any = null;
let streamRequests: any[] = [];

vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, f: any) => { if (c === 'cogseed.invoke') invokeHandler = f; },
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

let root = '';
const UID = 'asideIpcUser';

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-ipc-'));
  process.env.COGSEED_WORKSPACE_ROOT = root;
  invokeHandler = null;
  streamRequests = [];
  vi.resetModules();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
  (await import('../../../src/main/ipc/index')).register();
});
afterEach(() => {
  delete process.env.COGSEED_WORKSPACE_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

const call = (channel: string, payload: any = {}) =>
  invokeHandler({ sender: trustedIpcSender() }, { channel, payload });

async function makeConversation(): Promise<string> {
  const chats = await import('../../../src/main/features/chats');
  const conv = await chats.createConversation(UID, { title: 'Task' });
  return conv.conversation_id;
}

describe('IPC aside', () => {
  it('returns an empty thread for a fresh conversation', async () => {
    const cid = await makeConversation();
    const res = await call('aside.list', { cid });
    expect(res.ok).toBe(true);
    expect(res.turns).toEqual([]);
  });

  it('lists persisted turns', async () => {
    const cid = await makeConversation();
    const aside = await import('../../../src/main/features/conversation_aside');
    await aside.appendAsideTurn(UID, cid, {
      anchorIndex: 2, anchorExcerpt: 'x', question: 'why?', answer: 'because',
      agentId: 'agent-x', model: 'm',
    });

    const res = await call('aside.list', { cid });
    expect(res.turns).toHaveLength(1);
    expect(res.turns[0].question).toBe('why?');
  });

  it('clears a thread without touching the conversation', async () => {
    const cid = await makeConversation();
    const chats = await import('../../../src/main/features/chats');
    const aside = await import('../../../src/main/features/conversation_aside');
    await aside.appendAsideTurn(UID, cid, {
      anchorIndex: 0, anchorExcerpt: 'x', question: 'q', answer: 'a',
      agentId: 'agent-x', model: 'm',
    });

    await call('aside.clear', { cid });

    expect((await call('aside.list', { cid })).turns).toEqual([]);
    // The conversation itself survives.
    await expect(chats.getConversation(UID, cid, null)).resolves.toBeTruthy();
  });

  it('rejects a malformed cid at the boundary', async () => {
    const res = await call('aside.list', { cid: '../escape' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/invalid cid/);
  });
});

describe('IPC aside — bus isolation', () => {  it('does not route asides through the group-chat bus', async () => {
    // The read-only guarantee is structural: an aside must never reach
    // bus.enqueue, which is what would append to the main transcript and
    // introduce a second dispatch path.
    const bus = await import('../../../src/main/features/group_chat/bus');
    const enqueue = vi.spyOn(bus, 'enqueue');
    const cid = await makeConversation();
    const aside = await import('../../../src/main/features/conversation_aside');

    await aside.appendAsideTurn(UID, cid, {
      anchorIndex: 1, anchorExcerpt: 'x', question: 'q', answer: 'a',
      agentId: 'agent-x', model: 'm',
    });
    await call('aside.list', { cid });

    expect(enqueue).not.toHaveBeenCalled();
    enqueue.mockRestore();
  });

  it('keeps aside storage out of the main transcript file', async () => {
    const cid = await makeConversation();
    const aside = await import('../../../src/main/features/conversation_aside');
    const { conversationMessageFile } = await import('../../../src/main/util/project-layout');

    await aside.appendAsideTurn(UID, cid, {
      anchorIndex: 1, anchorExcerpt: 'secret-anchor', question: 'secret-question',
      answer: 'secret-answer', agentId: 'agent-x', model: 'm',
    });

    const transcript = conversationMessageFile(UID, cid, null);
    const text = fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8') : '';
    expect(text).not.toContain('secret-question');
    expect(text).not.toContain('secret-answer');
  });
});
