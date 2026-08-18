import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (
  event: unknown,
  req: { channel: string; payload?: unknown },
) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

let invokeHandler: InvokeFn | null = null;
const registered = new Set<string>();
const TEST_UID = 'uP3394Contract';

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, _fn: InvokeFn) => {
      registered.add(channel);
      if (channel === 'orkas.invoke') invokeHandler = _fn;
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

// probeHandlers 收集 invokeHandlers 的键：把 orkas.invoke 换成对 unknown channel
// 的探测——所有已注册 channel 名可通过对每个候选发一次 invoke 判断 error 是否为
// "unknown channel"。更直接：用一个已知会被验证拒绝的 payload 断言 handler 存在。
let probe: (channel: string) => Promise<{ ok: boolean; error?: string }>;

beforeEach(async () => {
  process.env.ORKAS_WORKSPACE_ROOT = os.tmpdir();
  invokeHandler = null;
  registered.clear();
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
  probe = (channel: string) =>
    invokeHandler!({ sender: trustedIpcSender() }, { channel, payload: {} });
});

afterEach(() => { vi.resetModules(); });

describe('p3394 contract after legacy KSTAR removal', () => {
  it('keeps the generic wake and protocol channels registered', async () => {
    for (const channel of [
      'p3394.listWakeRequests',
      'p3394.decideWakeRequest',
      'p3394.listProtocolEvents',
    ]) {
      const result = await probe(channel);
      expect(result.error ?? '').not.toContain('unknown channel');
    }
  });
});
