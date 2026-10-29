import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

/**
 * po.* v2 通道 IPC 契约测试（2026-09-30 补断层；对照旧 personalOntology.*
 * 通道的同款契约模式，见 personal-ontology-candidates.test.ts）。
 *
 * 覆盖 src/main/ipc/index.ts 全部 po.* 通道。2026-10-06 起通道分两类：
 * ① 8 条只读/无害通道保持薄转发契约（snapshot / deleted / templates.status
 *    / archiveInfo / history.list / candidates.reject / data.export /
 *    data.importPreview）：IPC 只校验转调 features（Constitution II）——
 *    payload 塞 uid 不改入参、非法参数被拒、合法参数透传且返回形状不增删字段。
 * ② 18 条结构化写通道（groups/fields/values/entries/templates 安装卸载/
 *    history.restore/importApply）与 candidates.confirm 同口径收口：旧页面
 *    已停驻，直写绕过共同本体命令服务一律拒绝并指向治理入口。
 */

type InvokeFn = (event: unknown, req: { channel: string; payload?: unknown }) => Promise<any>;
let invokeHandler: InvokeFn | null = null;
const TEST_UID = 'uPoChannelsIpc';
const ATTACKER_UID = 'attacker';

const poApi = {
  getPoSnapshot: vi.fn(() => ({ groups: [] })),
  poCreateGroup: vi.fn(async () => ({ ok: true })),
  poRenameGroup: vi.fn(async () => ({ ok: true })),
  poDeleteGroup: vi.fn(async () => ({ ok: true })),
  poRestoreDeletedGroup: vi.fn(async () => ({ ok: true })),
  poListDeletedGroups: vi.fn(() => []),
  poCreateField: vi.fn(async () => ({ ok: true })),
  poRenameField: vi.fn(async () => ({ ok: true })),
  poDeleteField: vi.fn(async () => ({ ok: true })),
  poSetFieldRelationFlag: vi.fn(async () => ({ ok: true })),
  poAddValue: vi.fn(async () => ({ ok: true })),
  poUpdateValue: vi.fn(async () => ({ ok: true })),
  poDeleteValue: vi.fn(async () => ({ ok: true })),
  poAddEntry: vi.fn(async () => ({ ok: true })),
  poDeleteEntry: vi.fn(async () => ({ ok: true })),
  poPromoteEntry: vi.fn(async () => ({ ok: true })),
  poListTemplateStatus: vi.fn(async () => []),
  poInstallTemplate: vi.fn(async () => ({ ok: true })),
  poUninstallTemplate: vi.fn(async () => ({ ok: true })),
  poTemplateArchiveInfo: vi.fn(async () => ({ ok: true })),
  poListHistory: vi.fn(() => []),
  poExportMarkdown: vi.fn(() => ''),
  poImportPreview: vi.fn(() => ({ items: [] })),
  poImportApply: vi.fn(async () => ({ ok: true, applied: 0 })),
};
const candidatesFeature = {
  confirmCandidate: vi.fn(async () => ({ ok: true })),
  rejectCandidate: vi.fn(async () => ({ ok: true })),
};
const groupsFeature = {
  // po.history.restore 动态 import 触达的 seam；真实行为由
  // personal_ontology_groups.test.ts 覆盖，这里只钉 IPC 契约。
  restoreGroupSnapshot: vi.fn(async () => ({ ok: true })),
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
vi.mock('../../../src/main/features/po/api', () => poApi);
vi.mock('../../../src/main/features/personal_ontology_candidates', () => candidatesFeature);
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

const GID = 'grp0123456789';

/** 只读/无害通道的合法样本：channel → { payload, 目标 mock, 期望转发参数（不含首参 uid）。
 *  wrapKey = IPC handler 把 features 返回包进固定形状的通道（如 po.deleted.list → { deleted }）。 */
const CASES: Array<{ channel: string; payload: any; target: () => any; args: any[]; wrapKey?: string }> = [
  { channel: 'po.snapshot', payload: {}, target: () => poApi.getPoSnapshot, args: [] },
  { channel: 'po.deleted.list', payload: {}, target: () => poApi.poListDeletedGroups, args: [], wrapKey: 'deleted' },
  { channel: 'po.templates.status', payload: {}, target: () => poApi.poListTemplateStatus, args: [], wrapKey: 'templates' },
  { channel: 'po.templates.archiveInfo', payload: { templateId: 'student' }, target: () => poApi.poTemplateArchiveInfo, args: ['student'] },
  { channel: 'po.history.list', payload: { groupId: GID }, target: () => poApi.poListHistory, args: [GID], wrapKey: 'history' },
  { channel: 'po.candidates.reject', payload: { candidateId: 'cand1' }, target: () => candidatesFeature.rejectCandidate, args: ['cand1'] },
  { channel: 'po.data.export', payload: {}, target: () => poApi.poExportMarkdown, args: [], wrapKey: 'markdown' },
  { channel: 'po.data.importPreview', payload: { text: '## 组' }, target: () => poApi.poImportPreview, args: ['## 组'] },
];

/** 已收口的结构化写通道：无论参数形状，一律治理拒绝且不触达 features。 */
const CLOSED_WRITE_CHANNELS = [
  'po.groups.create', 'po.groups.rename', 'po.groups.delete', 'po.groups.restore',
  'po.fields.create', 'po.fields.rename', 'po.fields.delete', 'po.fields.setRelation',
  'po.values.add', 'po.values.update', 'po.values.delete',
  'po.entries.add', 'po.entries.delete', 'po.entries.promote',
  'po.templates.install', 'po.templates.uninstall',
  'po.history.restore', 'po.data.importApply',
];

describe('ipc › po.* v2 通道（8 条只读薄转发 + 18 条写通道治理收口）', () => {
  it('只读通道全部已注册（不是 unknown channel）', async () => {
    expect(CASES.length).toBe(8);
    for (const c of CASES) {
      const res = await call(c.channel, c.payload);
      expect(res, c.channel).not.toEqual({ ok: false, error: `unknown channel: ${c.channel}` });
      expect(res.ok, c.channel).toBe(true);
    }
  });

  it('不允许旧本体候选绕过共同审核直接写入旧记忆', async () => {
    const result = await call('po.candidates.confirm', { candidateId: 'cand-legacy', dest: { toGlobalMemory: true } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('transfer it to the common Recall review');
    expect(candidatesFeature.confirmCandidate).not.toHaveBeenCalled();
  });

  it('结构化写通道一律治理拒绝：不触达 features，错误指向本体工作台命令入口', async () => {
    expect(CLOSED_WRITE_CHANNELS.length).toBe(18);
    const featureMocks = [
      ...Object.values(poApi), candidatesFeature.confirmCandidate, groupsFeature.restoreGroupSnapshot,
    ].map(fn => fn.mockClear());
    for (const channel of CLOSED_WRITE_CHANNELS) {
      const res = await call(channel, {});
      expect(res.ok, channel).toBe(false);
      expect(res.error, channel).toContain('legacy personal ontology writes are closed');
    }
    for (const fn of featureMocks) expect(fn).not.toHaveBeenCalled();
  });

  it('payload 塞 uid 不改变转调入参：身份只来自 ctx.userId', async () => {
    for (const c of CASES) {
      const fn = c.target();
      fn.mockClear();
      await call(c.channel, { ...c.payload, uid: ATTACKER_UID });
      expect(fn, c.channel).toHaveBeenCalledTimes(1);
      const callArgs = fn.mock.calls[0];
      expect(callArgs[0], c.channel).toBe(TEST_UID);
      expect(JSON.stringify(callArgs), c.channel).not.toContain(ATTACKER_UID);
    }
  });

  it('非法参数被拒（bad id / 空文本 / 类型不符）', async () => {
    const invalid: Array<{ channel: string; payload: any }> = [
      { channel: 'po.templates.archiveInfo', payload: { templateId: 'bad id!' } },
      { channel: 'po.history.list', payload: { groupId: '../evil' } },
      { channel: 'po.candidates.confirm', payload: { candidateId: '' } },
      { channel: 'po.candidates.reject', payload: { candidateId: 42 } },
      { channel: 'po.data.importPreview', payload: { text: 123 } },
    ];
    for (const c of invalid) {
      const res = await call(c.channel, c.payload);
      expect(res.ok, `${c.channel} ${JSON.stringify(c.payload)}`).toBe(false);
      expect(typeof res.error).toBe('string');
      expect(res.error.length, `${c.channel} ${JSON.stringify(c.payload)}`).toBeGreaterThan(0);
    }
  });

  it('合法参数透传（首参 ctx.userId）且返回形状不增删字段', async () => {
    for (const c of CASES) {
      const marker = { ok: true, marker: `via:${c.channel}` };
      const fn = c.target();
      fn.mockClear();
      fn.mockImplementation(() => marker);
      const res = await call(c.channel, c.payload);
      expect(fn, c.channel).toHaveBeenCalledTimes(1);
      const callArgs = fn.mock.calls[0];
      expect(callArgs[0], c.channel).toBe(TEST_UID);
      for (let i = 0; i < c.args.length; i++) {
        expect(callArgs[i + 1], `${c.channel} arg#${i}`).toEqual(c.args[i]);
      }
      // IPC 层只做 { ok:true, ...result }（包装通道多一层固定键）：键集钉住
      expect(res, c.channel).toEqual(c.wrapKey ? { ok: true, [c.wrapKey]: marker } : marker);
      expect(Object.keys(res).sort(), c.channel).toEqual(c.wrapKey ? [c.wrapKey, 'ok'].sort() : ['marker', 'ok']);
    }
  });
});
