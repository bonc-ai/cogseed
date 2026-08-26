import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

const openPath = vi.fn(async () => '');

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder: vi.fn(), openPath },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    askForMediaAccess: vi.fn(async () => true),
  },
}));

vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: vi.fn(),
  kbEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));
vi.mock('../../../src/main/features/search', () => ({ upsertContext: vi.fn(), dropContext: vi.fn() }));
vi.mock('../../../src/main/features/kb_vector', () => ({ findBySha1: vi.fn(() => null) }));

let tmpDir: string;
let wsDir: string;
let previousWorkspaceRoot: string | undefined;
const TEST_UID = 'uOpenSpaceImport';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-open-import-'));
  // 用户工作区根独立于数据根：空间内容目录（数据根内）不落在工作区白名单，
  // 这样才能真实验证 spaceId 放行关（真实用户工作区 ≠ 数据目录）。
  wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-open-import-ws-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const userWorkspace = await import('../../../src/main/features/user_workspace');
  userWorkspace.setWorkspacePath(TEST_UID, wsDir);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(wsDir, { recursive: true, force: true });
});

async function makeSpaceWithImportedFile(): Promise<{ spaceId: string; filePath: string; outsidePath: string }> {
  const spaces = await import('../../../src/main/features/spaces');
  const created = await spaces.createSpace(TEST_UID, { name: '导入空间' });
  if (!created.ok) throw new Error('create space failed');
  const sid = created.space.space_id;
  const paths = await import('../../../src/main/paths');
  const contentDir = paths.spaceContentDir(TEST_UID, sid);
  const filePath = path.join(contentDir, 'imports', '资料夹', '说明.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'hello');
  // 空间内容目录之外的普通文件（用于验证 spaceId 不能越权放行）
  const outsidePath = path.join(tmpDir, 'outside.md');
  fs.writeFileSync(outsidePath, 'x');
  return { spaceId: sid, filePath, outsidePath };
}

async function invoke(payload: Record<string, unknown>): Promise<any> {
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const registered = electron.ipcMain.handle.mock.calls.find(([name]: [string]) => name === 'cogseed.invoke');
  expect(registered).toBeTruthy();
  return registered[1](
    { sender: trustedIpcSender() },
    { channel: 'workspace.openFile', payload },
  );
}

describe('ipc › workspace.openFile（COGSEED-18：空间导入产物打开）', () => {
  it('带 spaceId 且文件在空间内容目录内 → 放行并调用系统打开', async () => {
    const { spaceId, filePath } = await makeSpaceWithImportedFile();
    const res = await invoke({ path: filePath, cid: '', spaceId });
    expect(res.path).toBe(path.resolve(filePath));
    expect(openPath).toHaveBeenCalled();
  });

  it('无 spaceId → 拒绝（path is outside the user workspace）', async () => {
    const { filePath } = await makeSpaceWithImportedFile();
    const res = await invoke({ path: filePath, cid: '' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/outside the user workspace/);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('spaceId 不属于当前用户/不存在 → 拒绝', async () => {
    const { filePath } = await makeSpaceWithImportedFile();
    const res = await invoke({ path: filePath, cid: '', spaceId: 'sp_does_not_exist' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/outside the user workspace/);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('声明 spaceId 不能越权打开空间内容目录之外的文件', async () => {
    const { spaceId, outsidePath } = await makeSpaceWithImportedFile();
    const res = await invoke({ path: outsidePath, cid: '', spaceId });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/outside the user workspace/);
    expect(openPath).not.toHaveBeenCalled();
  });
});
