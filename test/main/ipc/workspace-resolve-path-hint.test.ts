import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    askForMediaAccess: vi.fn(async () => true),
  },
}));

vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: vi.fn(),
  kbEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));
vi.mock('../../../src/main/features/search', () => ({ upsertContext: vi.fn(), dropContext: vi.fn(), invalidateChatDisplayCatalog: vi.fn() }));
vi.mock('../../../src/main/features/kb_vector', () => ({ findBySha1: vi.fn(() => null) }));

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;
const TEST_UID = 'uResolvePathHint';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-path-hint-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const userWorkspace = await import('../../../src/main/features/user_workspace');
  userWorkspace.setWorkspacePath(TEST_UID, tmpDir);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function invoke(hints: string[], extra: Record<string, unknown> = {}): Promise<any> {
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const registered = electron.ipcMain.handle.mock.calls.find(([name]: [string]) => name === 'cogseed.invoke');
  expect(registered).toBeTruthy();
  return registered[1](
    { sender: trustedIpcSender() },
    { channel: 'workspace.resolvePathHints', payload: { hints, ...extra } },
  );
}

describe('workspace.resolvePathHints', () => {
  it('resolves shortened and bare file hints in one batch, null for misses', async () => {
    const dir = path.join(tmpDir, '跟进下下午和张浩的会议-4');
    fs.mkdirSync(dir);
    const list = path.join(dir, '2026-10-14_下午_张浩会议_任务清单_v001.md');
    const root = path.join(tmpDir, 'root-note.md');
    fs.writeFileSync(list, '# 清单');
    fs.writeFileSync(root, 'x');

    const result = await invoke([
      '.../跟进下下午和张浩的会议-4/2026-10-14_下午_张浩会议_任务清单_v001.md',
      'root-note.md',
      '.../nowhere/missing.md',
    ]);

    expect(result).toMatchObject({
      ok: true,
      results: {
        '.../跟进下下午和张浩的会议-4/2026-10-14_下午_张浩会议_任务清单_v001.md': list,
        'root-note.md': root,
        '.../nowhere/missing.md': null,
      },
    });
  });

  it('resolves a bare file name inside the conversation workspace dir', async () => {
    const chats = await import('../../../src/main/features/chats');
    const conv = await chats.createConversation(TEST_UID, { title: '张浩会议' });
    const cid = conv.conversation_id;
    const { getConversationWorkspacePath } = await import('../../../src/main/features/group_chat/conv_workspace');
    const dir = await getConversationWorkspacePath(TEST_UID, cid);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '2026-10-14_下午_张浩会议_会议纪要_v001.md');
    fs.writeFileSync(file, '# 纪要');

    const result = await invoke(['2026-10-14_下午_张浩会议_会议纪要_v001.md'], { cid });

    expect(result.results['2026-10-14_下午_张浩会议_会议纪要_v001.md']).toBe(file);
  });

  it('does not resolve directories', async () => {
    fs.mkdirSync(path.join(tmpDir, 'folder.md'));
    expect((await invoke(['folder.md'])).results).toEqual({ 'folder.md': null });
  });

  it('never resolves an absolute file outside the workspace sandbox', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-path-hint-outside-'));
    const file = path.join(outside, 'secret.md');
    fs.writeFileSync(file, 'x');
    try {
      expect((await invoke([file])).results).toEqual({ [file]: null });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ignores non-string hints and caps the batch', async () => {
    const hints = Array.from({ length: 80 }, (_, i) => `f${i}.md`);
    const result = await invoke([...hints, 42 as any]);
    expect(Object.keys(result.results)).toHaveLength(50);
  });
});
