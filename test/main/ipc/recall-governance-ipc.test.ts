/**
 * 治理待办 IPC 契约（specs/010 T012 / T021）。
 *
 *   - `cognition.inbox.list`：返回体加法携带 `groups`（组序恒定、与 items 同源）；
 *   - `cognition.inbox.resolve`：写路径把乐观版本撞车翻译成稳定码
 *     `version_conflict`（不静默覆盖、不落终态）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (event: unknown, request: { channel: string; payload?: unknown }) => Promise<{ ok: boolean } & Record<string, unknown>>;
let invokeHandler: InvokeFn | null = null;
const UID = 'uGovernanceIpc';

const inboxMock = vi.hoisted(() => ({
  listCognitionInbox: vi.fn(async () => [] as unknown[]),
  resolveCognitionInboxItem: vi.fn(async () => ({ ok: true, target: 'asset', status: 'boundary_set' })),
  groupCognitionInbox: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: InvokeFn) => { if (channel === 'cogseed.invoke') invokeHandler = fn; }, on: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }), logFromRenderer: vi.fn() }));
vi.mock('../../../src/main/features/cognition', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/main/features/cognition')>();
  return { ...original, listCognitionInbox: inboxMock.listCognitionInbox, resolveCognitionInboxItem: inboxMock.resolveCognitionInboxItem };
});

beforeEach(async () => {
  // Keep the isolated workspace assigned by test/setup-env.ts.
  invokeHandler = null;
  vi.resetModules();
  vi.clearAllMocks();
  // clearAllMocks 只清调用记录，不清实现——上一条用例的 mockRejectedValue
  // 会漏到下一条，这里显式恢复默认实现。
  inboxMock.listCognitionInbox.mockImplementation(async () => [] as unknown[]);
  inboxMock.resolveCognitionInboxItem.mockImplementation(async () => ({ ok: true, target: 'asset', status: 'boundary_set' }));
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

describe('ipc › cognition.inbox.list（groups 加法扩展，specs/010 T012）', () => {
  it('返回体同时带 items/total/groups，缺省不报错', async () => {
    inboxMock.listCognitionInbox.mockResolvedValue([]);
    const res = await call('cognition.inbox.list');
    expect(res.ok).toBe(true);
    expect(res.total).toBe(0);
    expect(res.groups).toEqual([]);
  });

  it('groups 的分区顺序恒定、flatMap 与 items 同源', async () => {
    const items = [
      { id: 'conflict:c1', kind: 'classification_conflict', urgency: 'confirm', title: 'A' },
      { id: 'rule-boundary:aa-1', kind: 'rule_boundary_missing', urgency: 'low_disturbance', title: 'a1', assetId: 'aa-1' },
      { id: 'candidate:c2', kind: 'candidate_pending_review', urgency: 'low_disturbance', title: 'b' },
    ];
    inboxMock.listCognitionInbox.mockResolvedValue(items);
    const res = await call('cognition.inbox.list');
    expect(res.ok).toBe(true);
    expect(res.total).toBe(3);
    const groups = res.groups as Array<{ category: string; count: number; total: number; items: Array<{ id: string }> }>;
    // 组序恒为 conflict → boundary → other（出现的那些）。
    const order = ['conflict', 'boundary', 'other'];
    const indexes = groups.map((group) => order.indexOf(group.category));
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    expect(groups[0].category).toBe('conflict');
    // items 与 groups 的关系：条目逐一直达。
    const flatIds = groups.flatMap((group) => group.items).map((item) => item.id);
    for (const id of items.map((item) => item.id)) expect(flatIds).toContain(id);
  });
});

describe('ipc › cognition.inbox.resolve（specs/010 T021：版本冲突的稳定码）', () => {
  it('写路径的乐观版本撞车翻译成 version_conflict，不静默覆盖', async () => {
    // 模拟真实适配器的 settle() 产物：错误码挂在 Error 上（inboxResolveError），
    // IPC 包装层负责透出成 { ok:false, code }。
    const conflict = Object.assign(new Error('ability asset version conflict: expected v2, current v3'), { code: 'version_conflict' });
    inboxMock.resolveCognitionInboxItem.mockRejectedValue(conflict);
    await expect(call('cognition.inbox.resolve', { id: 'rule-boundary:aa-1', action: 'set_boundary', applicableWhen: ['x'], forbiddenWhen: ['y'] }))
      .resolves.toMatchObject({ ok: false, code: 'version_conflict' });
  });

  it('新参数形状：条件列表 ≤32、targetAssetId 过 safeId；合法形态透传', async () => {
    await expect(call('cognition.inbox.resolve', { id: 'rule-boundary:aa-1', action: 'set_boundary', applicableWhen: Array(33).fill('x') }))
      .resolves.toMatchObject({ ok: false });
    await expect(call('cognition.inbox.resolve', { id: 'inspection:k', action: 'keep', targetAssetId: '../bad' }))
      .resolves.toMatchObject({ ok: false });
    // 合法形态透传（条件原样到达 features 层）。
    await expect(call('cognition.inbox.resolve', {
      id: 'rule-boundary:aa-1', action: 'set_boundary',
      applicableWhen: ['发布窗口内做接口变更'], forbiddenWhen: ['紧急回滚时的直接修补'],
    })).resolves.toMatchObject({ ok: true });
    expect(inboxMock.resolveCognitionInboxItem).toHaveBeenCalledWith(UID, expect.objectContaining({
      applicableWhen: ['发布窗口内做接口变更'], forbiddenWhen: ['紧急回滚时的直接修补'],
    }));
  });
});
