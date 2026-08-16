import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
}));

vi.mock('../../../src/main/features/kb_embed', () => ({
  embedTexts: async (texts: string[]) => texts.map(() => new Array(512).fill(0)),
  embedQuery: async () => new Array(512).fill(0),
  closeEmbedder: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'uLibraryWrite';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-library-write-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  try {
    const vec = await import('../../../src/main/features/vec_store');
    vec.closeAllVecStores();
  } catch { /* ignore */ }
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctx(userId = TEST_UID): any {
  return {
    userId,
    user: { user_id: userId, created_at: new Date(0).toISOString() },
    sender: {},
  };
}

describe('library.writeText', () => {
  it('recovers an orphaned space processing row and completes it', async () => {
    const spaces = await import('../../../src/main/features/spaces');
    const spaceLibrary = await import('../../../src/main/features/project_library_indexer');
    const vec = await import('../../../src/main/features/vec_store');
    const { spaceFilesDir, spaceLibraryVectorDbPath } = await import('../../../src/main/paths');
    const space = await spaces.createSpace(TEST_UID, { name: 'Recovery Project' });
    if (!space.ok) throw new Error('space precondition failed');
    const spaceId = space.space.space_id;
    const name = 'orphan.md';
    const body = 'space crash recovery';
    const source = path.join(spaceFilesDir(TEST_UID, spaceId), name);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, body, 'utf8');
    const stat = fs.statSync(source);
    const store = vec.openVecStore(path.dirname(spaceLibraryVectorDbPath(TEST_UID, spaceId)));
    await store.setFileStatus(name, 'processing', {
      kind: 'text',
      bytes: stat.size,
      mtime: stat.mtimeMs / 1000,
      sha1: crypto.createHash('sha1').update(body).digest('hex'),
    });

    const result = await spaceLibrary.reconcile(TEST_UID, spaceId);
    expect(result.recoveredProcessing).toBe(1);
    await spaceLibrary.drain(TEST_UID);
    expect(spaceLibrary.getFileByPath(TEST_UID, spaceId, name)?.status).toBe('ready');
  });

  it('keeps space vectors when a reconcile snapshot is temporarily unreadable', async () => {
    const spaces = await import('../../../src/main/features/spaces');
    const spaceLibrary = await import('../../../src/main/features/project_library_indexer');
    const { spaceFilesDir } = await import('../../../src/main/paths');
    const space = await spaces.createSpace(TEST_UID, { name: 'Incomplete Snapshot' });
    if (!space.ok) throw new Error('space precondition failed');
    const spaceId = space.space.space_id;
    const root = spaceFilesDir(TEST_UID, spaceId);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'keep.md'), 'keep indexed data', 'utf8');
    await spaceLibrary.reconcile(TEST_UID, spaceId);
    await spaceLibrary.drain(TEST_UID);
    expect(spaceLibrary.getFileByPath(TEST_UID, spaceId, 'keep.md')?.status).toBe('ready');

    const backup = `${root}.backup`;
    fs.renameSync(root, backup);
    fs.writeFileSync(root, 'not a directory', 'utf8');
    try {
      const result = await spaceLibrary.reconcile(TEST_UID, spaceId);
      expect(result).toMatchObject({ incomplete: true, enqueuedDelete: 0 });
      expect(spaceLibrary.getFileByPath(TEST_UID, spaceId, 'keep.md')?.status).toBe('ready');
    } finally {
      fs.rmSync(root, { force: true });
      fs.renameSync(backup, root);
    }
  });

  it('writes archived chat text into the owning space Library when cid is space-scoped', async () => {
    const spaces = await import('../../../src/main/features/spaces');
    const chats = await import('../../../src/main/features/chats');
    const spaceLibrary = await import('../../../src/main/features/project_library_indexer');
    const { spaceFilesDir, userContextsDir } = await import('../../../src/main/paths');
    const { _libraryWriteTextForTest } = await import('../../../src/main/ipc/index');

    const space = await spaces.createSpace(TEST_UID, { name: 'Project Library' });
    if (!space.ok) throw new Error('space precondition failed');
    const spaceId = space.space.space_id;
    const conv = await chats.createConversation(TEST_UID, { spaceId });

    const res = await _libraryWriteTextForTest({
      cid: conv.conversation_id,
      targetPath: 'notes/message.md',
      content: 'space-scoped message',
    }, ctx());

    expect(res.ok).toBe(true);
    expect(res.scope).toBe('space');
    expect(res.spaceId).toBe(spaceId);
    const spaceFile = path.join(spaceFilesDir(TEST_UID, spaceId), 'notes', 'message.md');
    expect(fs.readFileSync(spaceFile, 'utf8')).toBe('space-scoped message');
    expect(fs.existsSync(path.join(userContextsDir(TEST_UID), 'notes', 'message.md'))).toBe(false);

    await spaceLibrary.drain(TEST_UID);
  });

  it('keeps archived chat text in the global Library when no space scope exists', async () => {
    const chats = await import('../../../src/main/features/chats');
    const { userContextsDir } = await import('../../../src/main/paths');
    const { _libraryWriteTextForTest } = await import('../../../src/main/ipc/index');

    const conv = await chats.createConversation(TEST_UID);
    const res = await _libraryWriteTextForTest({
      cid: conv.conversation_id,
      targetPath: 'messages/global.md',
      content: 'global message',
    }, ctx());

    expect(res.ok).toBe(true);
    expect(res.scope).toBe('global');
    expect(fs.readFileSync(path.join(userContextsDir(TEST_UID), 'messages', 'global.md'), 'utf8')).toBe('global message');
  });
});

describe('library.importProduced', () => {
  it('preserves target folders when importing a produced file into a space Library', async () => {
    const spaces = await import('../../../src/main/features/spaces');
    const chats = await import('../../../src/main/features/chats');
    const userWorkspace = await import('../../../src/main/features/user_workspace');
    const spaceLibrary = await import('../../../src/main/features/project_library_indexer');
    const { spaceFilesDir } = await import('../../../src/main/paths');
    const { _libraryImportProducedForTest } = await import('../../../src/main/ipc/index');

    const space = await spaces.createSpace(TEST_UID, { name: 'Produced Import' });
    if (!space.ok) throw new Error('space precondition failed');
    const spaceId = space.space.space_id;
    const conv = await chats.createConversation(TEST_UID, { spaceId });

    const ws = userWorkspace.getWorkspacePath(TEST_UID, spaceId);
    fs.mkdirSync(ws, { recursive: true });
    const source = path.join(ws, 'result.txt');
    fs.writeFileSync(source, 'produced body', 'utf8');

    const res = await _libraryImportProducedForTest({
      cid: conv.conversation_id,
      path: source,
      targetPath: 'reports/result.txt',
    }, ctx());

    expect(res.ok).toBe(true);
    expect(res.scope).toBe('space');
    expect(fs.readFileSync(path.join(spaceFilesDir(TEST_UID, spaceId), 'reports', 'result.txt'), 'utf8')).toBe('produced body');

    await spaceLibrary.drain(TEST_UID);
  });

  it('imports a produced video into a space Library but not the global Library', async () => {
    const spaces = await import('../../../src/main/features/spaces');
    const chats = await import('../../../src/main/features/chats');
    const userWorkspace = await import('../../../src/main/features/user_workspace');
    const spaceLibrary = await import('../../../src/main/features/project_library_indexer');
    const { spaceFilesDir, userContextsDir } = await import('../../../src/main/paths');
    const { _libraryImportProducedForTest } = await import('../../../src/main/ipc/index');

    const space = await spaces.createSpace(TEST_UID, { name: 'Produced Video Import' });
    if (!space.ok) throw new Error('space precondition failed');
    const spaceId = space.space.space_id;
    const spaceConversation = await chats.createConversation(TEST_UID, { spaceId });
    const spaceWorkspace = userWorkspace.getWorkspacePath(TEST_UID, spaceId);
    fs.mkdirSync(spaceWorkspace, { recursive: true });
    const spaceVideo = path.join(spaceWorkspace, 'demo.mp4');
    fs.writeFileSync(spaceVideo, 'fake video bytes');

    const spaceResult = await _libraryImportProducedForTest({
      cid: spaceConversation.conversation_id,
      path: spaceVideo,
    }, ctx());
    expect(spaceResult).toMatchObject({ ok: true, scope: 'space', spaceId });
    expect(fs.readFileSync(path.join(spaceFilesDir(TEST_UID, spaceId), 'demo.mp4'), 'utf8')).toBe('fake video bytes');

    const globalConversation = await chats.createConversation(TEST_UID);
    const globalWorkspace = userWorkspace.getWorkspacePath(TEST_UID);
    fs.mkdirSync(globalWorkspace, { recursive: true });
    const globalVideo = path.join(globalWorkspace, 'global.mp4');
    fs.writeFileSync(globalVideo, 'global video bytes');
    const globalResult = await _libraryImportProducedForTest({
      cid: globalConversation.conversation_id,
      path: globalVideo,
    }, ctx());
    expect(globalResult.ok).toBe(false);
    expect(fs.existsSync(path.join(userContextsDir(TEST_UID), 'global.mp4'))).toBe(false);

    await spaceLibrary.drain(TEST_UID);
  });

  it('rejects unsupported produced files before importing into a space Library', async () => {
    const spaces = await import('../../../src/main/features/spaces');
    const chats = await import('../../../src/main/features/chats');
    const userWorkspace = await import('../../../src/main/features/user_workspace');
    const { spaceFilesDir } = await import('../../../src/main/paths');
    const { _libraryImportProducedForTest } = await import('../../../src/main/ipc/index');

    const space = await spaces.createSpace(TEST_UID, { name: 'Produced Import Filter' });
    if (!space.ok) throw new Error('space precondition failed');
    const spaceId = space.space.space_id;
    const conv = await chats.createConversation(TEST_UID, { spaceId });

    const ws = userWorkspace.getWorkspacePath(TEST_UID, spaceId);
    fs.mkdirSync(ws, { recursive: true });
    const source = path.join(ws, 'archive.zip');
    fs.writeFileSync(source, 'zip-ish bytes', 'utf8');

    const res = await _libraryImportProducedForTest({
      cid: conv.conversation_id,
      path: source,
    }, ctx());

    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/Unsupported file type|不支持的文件类型|未対応/);
    expect(fs.existsSync(path.join(spaceFilesDir(TEST_UID, spaceId), 'archive.zip'))).toBe(false);
  });
});
