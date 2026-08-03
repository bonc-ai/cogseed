import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (
  event: unknown,
  req: { channel: string; payload?: unknown },
) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

let invokeHandler: InvokeFn | null = null;
const TEST_UID = 'uConversationCopyMergeIpc';

const cloneConversation = vi.fn(async () => ({
  newConversation: { conversation_id: 'clone-new', title: 'Source (Copy)' },
  commanderSessionId: 'gconv-clone-new',
  memberSessionIds: [],
}));
const mergeConversations = vi.fn(async () => ({
  newConversation: { conversation_id: 'merge-new', title: 'Merged title' },
  summaryMessage: '已合并 2 个会话',
  agentSummaries: {
    agentA: { sourceCids: ['a', 'b'], markdown: 'Agent summary' },
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: InvokeFn) => {
      if (channel === 'orkas.invoke') invokeHandler = fn;
    },
    on: vi.fn(),
  },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

vi.mock('../../../src/main/features/conversation_copy_merge', () => ({
  cloneConversation,
  mergeConversations,
}));

beforeEach(async () => {
  invokeHandler = null;
  vi.resetModules();
  vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

afterEach(() => {
  vi.resetModules();
});

function invoke(channel: string, payload: unknown = {}) {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

describe('ipc › conversation copy and merge', () => {
  it('calls cloneConversation and returns the created conversation', async () => {
    const result = await invoke('conversations.clone', { cid: 'source-1', project_id: 'project-1' });

    expect(result).toEqual({
      ok: true,
      conversation: { conversation_id: 'clone-new', title: 'Source (Copy)' },
    });
    expect(cloneConversation).toHaveBeenCalledWith(TEST_UID, 'source-1', {
      projectIdHint: 'project-1',
    });
  });

  it('omits projectIdHint when clone has no project hint', async () => {
    await invoke('conversations.clone', { cid: 'source-1' });

    expect(cloneConversation).toHaveBeenCalledWith(TEST_UID, 'source-1', {});
  });

  it('calls mergeConversations and returns the conversation and summaries', async () => {
    const result = await invoke('conversations.merge', {
      cids: ['a', 'b'],
      title: 'Merged title',
      project_id: '',
    });

    expect(result).toEqual({
      ok: true,
      conversation: { conversation_id: 'merge-new', title: 'Merged title' },
      summary: '已合并 2 个会话',
      agent_summaries: {
        agentA: { sourceCids: ['a', 'b'], markdown: 'Agent summary' },
      },
    });
    expect(mergeConversations).toHaveBeenCalledWith(TEST_UID, ['a', 'b'], {
      title: 'Merged title',
      projectIdHint: null,
    });
  });


  it('treats null project_id as an explicit global merge destination', async () => {
    const result = await invoke('conversations.merge', {
      cids: ['a', 'b'],
      title: 'Merged title',
      project_id: null,
    });

    expect(result).toMatchObject({ ok: true, conversation: { conversation_id: 'merge-new' } });
    expect(mergeConversations).toHaveBeenCalledWith(TEST_UID, ['a', 'b'], {
      title: 'Merged title',
      projectIdHint: null,
    });
  });

  it('validates clone cid and merge cids with safeId before dispatch', async () => {
    const invalidClone = await invoke('conversations.clone', { cid: 'bad/cid' });
    const invalidMerge = await invoke('conversations.merge', { cids: ['ok', 'bad/cid'], title: 'Merged' });

    expect(invalidClone).toMatchObject({ ok: false, error: 'invalid cid' });
    expect(invalidMerge).toMatchObject({ ok: false, error: 'invalid cids' });
    expect(cloneConversation).not.toHaveBeenCalled();
    expect(mergeConversations).not.toHaveBeenCalled();
  });

  it('rejects fewer than two distinct merge sources before dispatch', async () => {
    const one = await invoke('conversations.merge', { cids: ['a'], title: 'Merged' });
    const duplicate = await invoke('conversations.merge', { cids: ['a', 'a'], title: 'Merged' });

    expect(one).toMatchObject({ ok: false, error: 'at least two source conversations are required' });
    expect(duplicate).toMatchObject({ ok: false, error: 'at least two source conversations are required' });
    expect(mergeConversations).not.toHaveBeenCalled();
  });

  it('rejects invalid project hints before dispatch', async () => {
    const result = await invoke('conversations.clone', {
      cid: 'source-1',
      project_id: 'bad/project',
    });

    expect(result).toMatchObject({ ok: false, error: 'invalid project id' });
    expect(cloneConversation).not.toHaveBeenCalled();
  });
});
