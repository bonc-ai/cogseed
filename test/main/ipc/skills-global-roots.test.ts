/**
 * S4「我的技能」全局技能文件夹总开关（specs/009 FR-020、T029）：
 * IPC 只校验参数、读写 `global_skill_roots_enabled` 偏好，写后使技能缓存失效；不碰任何文件夹里的文件。
 */
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
vi.mock('../../../src/main/features/search', () => ({ upsertContext: vi.fn(), dropContext: vi.fn() }));
vi.mock('../../../src/main/features/kb_vector', () => ({ findBySha1: vi.fn(() => null) }));
const invalidateSkills = vi.fn();
vi.mock('../../../src/main/model/core-agent/skill-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invalidateSkills: () => invalidateSkills(),
}));

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;
const TEST_UID = 'uGlobalRoots';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-global-roots-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function invoke(channel: string, payload?: unknown): Promise<any> {
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const registered = electron.ipcMain.handle.mock.calls.find(([name]: [string]) => name === 'cogseed.invoke');
  expect(registered).toBeTruthy();
  return registered[1]({ sender: trustedIpcSender() }, { channel, payload });
}

describe('skills.getGlobalRootsEnabled / skills.setGlobalRootsEnabled', () => {
  it('默认开启', async () => {
    expect(await invoke('skills.getGlobalRootsEnabled')).toMatchObject({ enabled: true });
  });

  it('关闭后写入偏好、使技能缓存失效，读回为关闭；再打开恢复', async () => {
    expect(await invoke('skills.setGlobalRootsEnabled', { enabled: false })).toMatchObject({ ok: true, enabled: false });
    expect(invalidateSkills).toHaveBeenCalledTimes(1);
    const config = await import('../../../src/main/features/config');
    expect(config.readPreferences().global_skill_roots_enabled).toBe(false);
    expect(await invoke('skills.getGlobalRootsEnabled')).toMatchObject({ enabled: false });

    expect(await invoke('skills.setGlobalRootsEnabled', { enabled: true })).toMatchObject({ ok: true, enabled: true });
    expect(await invoke('skills.getGlobalRootsEnabled')).toMatchObject({ enabled: true });
  });

  it('enabled 不是布尔：报错且不写偏好', async () => {
    for (const payload of [{}, { enabled: 'false' }, { enabled: 0 }, null]) {
      const res = await invoke('skills.setGlobalRootsEnabled', payload).catch((err: Error) => ({ thrown: err.message }));
      expect(JSON.stringify(res)).toMatch(/enabled must be boolean/);
    }
    expect(invalidateSkills).not.toHaveBeenCalled();
    const config = await import('../../../src/main/features/config');
    expect(config.readPreferences().global_skill_roots_enabled).toBeUndefined();
  });
});
