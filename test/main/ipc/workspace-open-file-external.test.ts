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
let previousWorkspaceRoot: string | undefined;
const TEST_UID = 'uOpenProducedFile';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-open-produced-'));
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

async function invoke(pathValue: string): Promise<any> {
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const registered = electron.ipcMain.handle.mock.calls.find(([name]: [string]) => name === 'cogseed.invoke');
  expect(registered).toBeTruthy();
  return registered[1](
    { sender: trustedIpcSender() },
    { channel: 'workspace.openFileExternal', payload: { path: pathValue } },
  );
}

describe('workspace.openFileExternal', () => {
  it('opens a file inside the active workspace with the OS default app', async () => {
    const file = path.join(tmpDir, 'archive.zip');
    fs.writeFileSync(file, 'zip');

    const result = await invoke(file);

    expect(result).toEqual({ ok: true, path: file });
    expect(openPath).toHaveBeenCalledWith(file);
  });

  it('rejects existing files outside the active workspace', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-open-outside-'));
    const file = path.join(outside, 'outside.zip');
    fs.writeFileSync(file, 'zip');
    try {
      const result = await invoke(file);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/outside/);
      expect(openPath).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects directories even when they are inside the workspace', async () => {
    const dir = path.join(tmpDir, 'folder');
    fs.mkdirSync(dir);

    const result = await invoke(dir);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a file/);
    expect(openPath).not.toHaveBeenCalled();
  });
});
