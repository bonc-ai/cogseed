/**
 * 资产管家 IPC 契约（specs/008 T007/T008）。
 *
 * 三条通道：
 *   - `recall.assets.deleted.list`（US-306 交付项）：保留期剩余天数与三个可用性是
 *     业务判断，必须在 feature 层现算——这里用**真实** `describeDeletedAbilityAsset`
 *     跑断言，只把数据源换成夹具，否则"几天后到期"这条最容易被算错；
 *   - `recall.assets.deleted.purgeNow`：只认 status=deleted，别处不能借它清 active；
 *   - `cognition.inbox.resolve`：只有落到对象上的处置才算成功；没有一键动作的
 *     类别必须回 ok:false + code，**不得计为成功**。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (event: unknown, request: { channel: string; payload?: unknown }) => Promise<{ ok: boolean } & Record<string, unknown>>;
let invokeHandler: InvokeFn | null = null;
const UID = 'uStewardIpc';

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const deletedRecent = {
  id: 'aa-deleted-recent', title: '两天前删的', type: 'rule', scope: 'architecture',
  status: 'deleted' as const, deletedAt: daysAgo(2),
};
/** 时间戳坏了：既不能恢复、也不会自动到期，列表必须单列一态。 */
const deletedBroken = {
  id: 'aa-deleted-broken', title: '时间戳坏了', type: 'rule', scope: 'architecture',
  status: 'deleted' as const,
};
const activeAsset = {
  id: 'aa-active', title: '在用资产', type: 'rule', scope: 'architecture',
  status: 'active' as const,
};

const assetMock = vi.hoisted(() => ({
  listAbilityAssets: vi.fn(async () => [] as unknown[]),
  readAbilityAsset: vi.fn(async (_uid: string, id: string) => ({ id, status: 'deleted' })),
  purgeAbilityAsset: vi.fn(async (_uid: string, id: string) => ({ id, status: 'purged' })),
}));

const candidateMock = vi.hoisted(() => ({
  promoteRecallCandidate: vi.fn(async (_uid: string, id: string) => ({ asset: { id: `aa-${id}` }, candidate: { id } })),
  rejectRecallCandidate: vi.fn(async (_uid: string, id: string) => ({ id, status: 'rejected' })),
  deferRecallCandidate: vi.fn(async (_uid: string, id: string) => ({ id, status: 'deferred' })),
  ignoreRecallCandidate: vi.fn(async (_uid: string, id: string) => ({ id, status: 'ignored' })),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: InvokeFn) => { if (channel === 'cogseed.invoke') invokeHandler = fn; }, on: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }), logFromRenderer: vi.fn() }));
// 只换数据源，保留 describeDeletedAbilityAsset 的真实体（保留期算错是这类功能最贵的缺陷）。
vi.mock('../../../src/main/features/recall/asset-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/features/recall/asset-service')>()),
  listAbilityAssets: assetMock.listAbilityAssets,
  readAbilityAsset: assetMock.readAbilityAsset,
  purgeAbilityAsset: assetMock.purgeAbilityAsset,
}));
// 候选处置换成桩：这一层验的是"分发到没到对的对象"，晋升闸门本身另有测试。
vi.mock('../../../src/main/features/recall/candidate-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/features/recall/candidate-service')>()),
  promoteRecallCandidate: candidateMock.promoteRecallCandidate,
  rejectRecallCandidate: candidateMock.rejectRecallCandidate,
  deferRecallCandidate: candidateMock.deferRecallCandidate,
  ignoreRecallCandidate: candidateMock.ignoreRecallCandidate,
}));

beforeEach(async () => {
  // Keep the isolated workspace assigned by test/setup-env.ts.
  invokeHandler = null;
  vi.resetModules();
  vi.clearAllMocks();
  assetMock.listAbilityAssets.mockResolvedValue([deletedRecent, deletedBroken, activeAsset]);
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

describe('ipc › recall.assets.deleted.list', () => {
  it('只列已删除，并给出保留期剩余天数与可用性', async () => {
    const res = await call('recall.assets.deleted.list');
    expect(res.ok).toBe(true);
    expect(res.total).toBe(2);
    const items = res.items as Array<Record<string, unknown>>;
    expect(items.map((item) => item.id)).toEqual(['aa-deleted-recent', 'aa-deleted-broken']);
    // 在用资产不进这个列表。
    expect(items.some((item) => item.id === 'aa-active')).toBe(false);
    // 2 天前删 + 30 天保留期 → 还剩 28 天，期内可恢复、也可立即彻底删除。
    expect(items[0].retentionDaysLeft).toBe(28);
    expect(items[0].restorable).toBe(true);
    expect(items[0].purgeable).toBe(true);
    // 时间戳不可解析：单列 retentionUnknown，不冒充"已过期"也不冒充"还能恢复"。
    expect(items[1].retentionUnknown).toBe(true);
    expect(items[1].retentionDaysLeft).toBeNull();
    expect(items[1].restorable).toBe(false);
  });

  it('分页只影响返回条数，total 始终是全量', async () => {
    const res = await call('recall.assets.deleted.list', { offset: 1, limit: 1 });
    expect((res.items as unknown[]).length).toBe(1);
    expect(res.total).toBe(2);
  });

  it('空态：没有已删除资产时返回空列表而不是报错', async () => {
    assetMock.listAbilityAssets.mockResolvedValue([activeAsset]);
    await expect(call('recall.assets.deleted.list')).resolves.toMatchObject({ ok: true, items: [], total: 0 });
  });

  it('拒绝非法分页参数', async () => {
    await expect(call('recall.assets.deleted.list', { offset: -1 })).resolves.toMatchObject({ ok: false });
    await expect(call('recall.assets.deleted.list', { offset: 1.5 })).resolves.toMatchObject({ ok: false });
    await expect(call('recall.assets.deleted.list', { limit: 0 })).resolves.toMatchObject({ ok: false });
    await expect(call('recall.assets.deleted.list', { limit: 201 })).resolves.toMatchObject({ ok: false });
  });
});

describe('ipc › recall.assets.deleted.purgeNow', () => {
  it('对已删除资产执行彻底清除', async () => {
    assetMock.readAbilityAsset.mockResolvedValue(deletedRecent);
    await expect(call('recall.assets.deleted.purgeNow', { assetId: deletedRecent.id }))
      .resolves.toMatchObject({ ok: true, asset: { status: 'purged' } });
    expect(assetMock.purgeAbilityAsset).toHaveBeenCalledWith(UID, deletedRecent.id, {
      actor: 'user',
      reason: 'user purged from the deleted list',
    });
  });

  it('不给出删除列表之外的资产当后门用', async () => {
    assetMock.readAbilityAsset.mockResolvedValue(activeAsset);
    await expect(call('recall.assets.deleted.purgeNow', { assetId: activeAsset.id }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('only a deleted') });
    expect(assetMock.purgeAbilityAsset).not.toHaveBeenCalled();

    assetMock.readAbilityAsset.mockResolvedValue({ id: 'aa-p', status: 'purged' });
    await expect(call('recall.assets.deleted.purgeNow', { assetId: 'aa-p' }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('already been purged') });
  });

  it('拒绝非法 assetId', async () => {
    await expect(call('recall.assets.deleted.purgeNow', { assetId: '../etc/passwd' }))
      .resolves.toMatchObject({ ok: false });
    expect(assetMock.readAbilityAsset).not.toHaveBeenCalled();
  });
});

describe('ipc › cognition.inbox.resolve', () => {
  it('候选类待办按动作落到对应处置函数', async () => {
    // 2026-09-29 第 2 批·一物一链：accept 直调晋升分支已删——candidate_pending_review
    // 停产，普通候选唯一确认入口是候选卡/详情（完整三选一）；这里再回 accept
    // 就是第二条不带冲突选项的确认链。
    await expect(call('cognition.inbox.resolve', { id: 'candidate:cand-1', action: 'accept' }))
      .resolves.toMatchObject({ ok: false, code: 'unsupported_action' });
    expect(candidateMock.promoteRecallCandidate).not.toHaveBeenCalled();

    await expect(call('cognition.inbox.resolve', { id: 'reject-me', action: 'reject' }))
      .resolves.toMatchObject({ ok: false, code: 'unsupported_item_kind' });

    await expect(call('cognition.inbox.resolve', { id: 'conflict:cand-2', action: 'defer', note: '回头再看' }))
      .resolves.toMatchObject({ ok: true, status: 'deferred' });
    expect(candidateMock.deferRecallCandidate).toHaveBeenCalledWith(UID, 'cand-2', '回头再看');

    await expect(call('cognition.inbox.resolve', { id: 'evidence:cand-3', action: 'ignore' }))
      .resolves.toMatchObject({ ok: true, status: 'ignored' });

    await expect(call('cognition.inbox.resolve', { id: 'ineligible:cand-4', action: 'reject' }))
      .resolves.toMatchObject({ ok: true, status: 'rejected' });
  });

  it('没有一键处置动作的类别回 ok:false 并说明去向，不计为成功', async () => {
    // specs/010 起 rule-boundary 有了就地处断（set_boundary），
    // 对它传**别的动作**回 unsupported_action；仍然没有一键动作的（来源失效 /
    // 模板改写 / Skill 生成）维持 unsupported_item_kind + 指明去资产详情。
    for (const id of ['source:aa-3', 'template:aa-4', 'skill:aa-5', 'skill-upgrade:aa-6', 'rule-scope:aa-7']) {
      const res = await call('cognition.inbox.resolve', { id, action: 'accept' });
      expect(res.ok, id).toBe(false);
      expect(res.code, id).toBe('unsupported_item_kind');
      expect(String(res.error), id).toContain('资产详情');
    }
    for (const id of ['rule-boundary:aa-2']) {
      const res = await call('cognition.inbox.resolve', { id, action: 'accept' });
      expect(res.ok, id).toBe(false);
      expect(res.code, id).toBe('unsupported_action');
    }
    expect(candidateMock.promoteRecallCandidate).not.toHaveBeenCalled();
  });

  it('候选类待办收到不适用的动作也要拒绝', async () => {
    await expect(call('cognition.inbox.resolve', { id: 'candidate:cand-9', action: 'promote' }))
      .resolves.toMatchObject({ ok: false, code: 'unsupported_action' });
    expect(candidateMock.promoteRecallCandidate).not.toHaveBeenCalled();
  });

  it('拒绝缺参、非法 id 与超长备注', async () => {
    await expect(call('cognition.inbox.resolve', { action: 'accept' })).resolves.toMatchObject({ ok: false });
    await expect(call('cognition.inbox.resolve', { id: 'candidate:cand-1' })).resolves.toMatchObject({ ok: false });
    await expect(call('cognition.inbox.resolve', { id: 'candidate:../bad', action: 'accept' }))
      .resolves.toMatchObject({ ok: false, code: 'invalid_item_id' });
    await expect(call('cognition.inbox.resolve', { id: 'candidate:cand-1', action: 'accept', note: 'x'.repeat(1_001) }))
      .resolves.toMatchObject({ ok: false });
  });
});
