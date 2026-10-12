/**
 * specs/015 T015：`kstar.improvement.outcomes.list` 只读 IPC 契约。
 *
 * 这一层只验「参数形状收口 + 透传 + 空态」：limit 必须是 1..100 的整数
 * （缺省 50），conclusion 必须是四类结论之一；判定与排序全在
 * `improvement-outcome.ts`（那里已有本体测试），这里只 mock 它的读取。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (event: unknown, request: { channel: string; payload?: unknown }) => Promise<{ ok: boolean } & Record<string, unknown>>;
let invokeHandler: InvokeFn | null = null;
const UID = 'uImprovementIpc';

const outcomeMock = vi.hoisted(() => ({
  listKstarImprovementOutcomes: vi.fn(async () => [] as unknown[]),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: InvokeFn) => { if (channel === 'cogseed.invoke') invokeHandler = fn; }, on: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }), logFromRenderer: vi.fn() }));
// 只换读取，保留常量导出（IPC 层的枚举校验用的就是同一份常量，防两处名单漂移）。
vi.mock('../../../src/main/features/kstar/improvement-outcome', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/features/kstar/improvement-outcome')>()),
  listKstarImprovementOutcomes: outcomeMock.listKstarImprovementOutcomes,
}));

beforeEach(async () => {
  // Keep the isolated workspace assigned by test/setup-env.ts.
  invokeHandler = null;
  vi.resetModules();
  vi.clearAllMocks();
  outcomeMock.listKstarImprovementOutcomes.mockResolvedValue([]);
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
  (await import('../../../src/main/ipc/index')).register();
});
afterEach(() => vi.resetModules());

function call(channel: string, payload: unknown = {}) {
  if (!invokeHandler) throw new Error('missing handler');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

describe('ipc › kstar.improvement.outcomes.list', () => {
  it('缺省入参：透传 limit=50、不筛结论；结果原样返回', async () => {
    outcomeMock.listKstarImprovementOutcomes.mockResolvedValue([
      { id: 'kio-kse-a', conclusion: 'no_update', updatedAt: '2026-09-25T10:00:00.000Z' },
    ]);
    const res = await call('kstar.improvement.outcomes.list');
    expect(res.ok).toBe(true);
    expect((res.outcomes as unknown[]).length).toBe(1);
    expect(outcomeMock.listKstarImprovementOutcomes).toHaveBeenCalledWith(UID, { limit: 50, conclusion: undefined });
  });

  it('合法入参：limit 与 conclusion 原样透传', async () => {
    await call('kstar.improvement.outcomes.list', { limit: 10, conclusion: 'insufficient_evidence' });
    expect(outcomeMock.listKstarImprovementOutcomes).toHaveBeenCalledWith(UID, { limit: 10, conclusion: 'insufficient_evidence' });
  });

  it('limit 越界或非整数一律拒绝（0 / 101 / 1.5 / 字符串）', async () => {
    for (const bad of [0, -1, 101, 1.5, 'many']) {
      const res = await call('kstar.improvement.outcomes.list', { limit: bad });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/^invalid kstar improvement outcome limit$/);
    }
    expect(outcomeMock.listKstarImprovementOutcomes).not.toHaveBeenCalled();
  });

  it('conclusion 不在四类结论里一律拒绝，不透传', async () => {
    const res = await call('kstar.improvement.outcomes.list', { conclusion: 'applied' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^invalid kstar improvement outcome conclusion$/);
    expect(outcomeMock.listKstarImprovementOutcomes).not.toHaveBeenCalled();
  });

  it('空态：没有结论记录时返回空列表而不是报错', async () => {
    await expect(call('kstar.improvement.outcomes.list')).resolves.toMatchObject({ ok: true, outcomes: [] });
  });

  it('feature 层抛错时不炸通道：ok:false 带原因', async () => {
    outcomeMock.listKstarImprovementOutcomes.mockRejectedValue(new Error('boom'));
    const res = await call('kstar.improvement.outcomes.list');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('boom');
  });
});
