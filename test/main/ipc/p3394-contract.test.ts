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

describe('p3394 contract unchanged after evolution overlay', () => {
  it('p3394 关键通道仍注册（invoke 不返回 unknown channel）', async () => {
    for (const ch of [
      'p3394.listKstarCompatProjections',
      'p3394.reviewKstarCompatProjection',
      'p3394.listProtocolEvents',
      'p3394.decideExperienceCandidate',
    ]) {
      const r = await probe(ch);
      // 通道存在时错误来自参数校验（如 invalid cid），绝不会是 "unknown channel"。
      expect(r.error ?? '').not.toContain('unknown channel');
    }
  });

  it('evolution 通道也已注册且与 p3394 无碰撞', async () => {
    const evo = await probe('evolution.dashboard');
    expect(evo.error ?? '').not.toContain('unknown channel');
    // 一个真正不存在的通道应报 unknown channel（反向验证探测方法有效）。
    const bogus = await probe('evolution.__nonexistent__');
    expect(bogus.error ?? '').toContain('unknown channel');
  });
});
