import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

/**
 * personalOntology.groups.deleted.list 契约测试（spec 009 D5b / T026，
 * contracts/ipc.md §2）：IPC 只校验转调 features（Constitution II）——
 * ① 通道注册存在（不是 unknown channel）；② 无参通道不接受 payload 塞 uid
 * （用户身份只来自 ctx）；③ 空态 `{ ok:true, deleted: [] }`；④ 返回形状
 * `{ ok:true, deleted:[{groupId,title,deletedAt,snapshotCount}] }`。
 */

type InvokeFn = (event: unknown, req: { channel: string; payload?: unknown }) => Promise<any>;
let invokeHandler: InvokeFn | null = null;
const TEST_UID = 'uDeletedGroupsIpc';

const groupsFeature = {
  // 只 mock 本通道触达的 seam；listDeletedGroups 的真实行为由
  // personal_ontology_groups.test.ts 覆盖（T028），这里钉 IPC 契约。
  listDeletedGroups: vi.fn(),
};

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: InvokeFn) => { if (channel === 'cogseed.invoke') invokeHandler = fn; }, on: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));
vi.mock('../../../src/main/features/personal_ontology_groups', () => groupsFeature);
// 同款可载入性隔离（见 personal-ontology-candidates.test.ts 的 mock 理由）。
vi.mock('../../../src/main/features/personal_ontology_template_files', () => ({
  installTemplateFile: vi.fn(async () => ({ ok: true })),
  templateHasArchive: vi.fn(() => false),
  templateHasMemoryArchive: vi.fn(() => false),
  uninstallTemplateFile: vi.fn(async () => ({ ok: true })),
}));

beforeEach(async () => {
  // Keep the isolated workspace assigned by test/setup-env.ts.
  invokeHandler = null;
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

function call(channel: string, payload: unknown = {}) {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

describe('ipc › personalOntology.groups.deleted.list (D5b / T026)', () => {
  it('registers the channel and forwards to features with the ctx userId only', async () => {
    groupsFeature.listDeletedGroups.mockReturnValue([]);
    // 参数校验①：通道已注册（不是 unknown channel）。
    const res = await call('personalOntology.groups.deleted.list', {});
    expect(res).not.toEqual({ ok: false, error: 'unknown channel: personalOntology.groups.deleted.list' });

    // 参数校验②：无参通道——payload 里塞 uid 不改变转调入参（身份只来自 ctx）。
    await call('personalOntology.groups.deleted.list', { uid: 'attacker' });
    await call('personalOntology.groups.deleted.list', null);
    expect(groupsFeature.listDeletedGroups).toHaveBeenNthCalledWith(2, TEST_UID);
    expect(groupsFeature.listDeletedGroups).toHaveBeenNthCalledWith(3, TEST_UID);
    expect(groupsFeature.listDeletedGroups).not.toHaveBeenCalledWith('attacker');
  });

  it('returns the empty state as { ok:true, deleted: [] } when nothing is restorable', async () => {
    groupsFeature.listDeletedGroups.mockReturnValue([]);
    await expect(call('personalOntology.groups.deleted.list', {})).resolves.toEqual({ ok: true, deleted: [] });
  });

  it('passes through the entry shape { groupId, title, deletedAt, snapshotCount }', async () => {
    groupsFeature.listDeletedGroups.mockReturnValue([
      { groupId: 'g1', title: '基本情况', deletedAt: '2026-09-25T10:00:00.000Z', snapshotCount: 3 },
    ]);
    const res = await call('personalOntology.groups.deleted.list', {});
    expect(res.ok).toBe(true);
    expect(res.deleted).toEqual([
      { groupId: 'g1', title: '基本情况', deletedAt: '2026-09-25T10:00:00.000Z', snapshotCount: 3 },
    ]);
    // 形状钉住：四个字段一个不多一个不少（IPC 层不重组、不增删字段）。
    expect(Object.keys(res.deleted[0]).sort()).toEqual(['deletedAt', 'groupId', 'snapshotCount', 'title']);
  });
});
