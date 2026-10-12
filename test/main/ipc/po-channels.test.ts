import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

/**
 * po.* v2 通道 IPC 契约测试（2026-09-30 补断层；对照旧 personalOntology.*
 * 通道的同款契约模式，见 personal-ontology-candidates.test.ts）。
 *
 * 覆盖 src/main/ipc/index.ts 全部 27 条薄转发通道（po.snapshot / groups /
 * deleted / fields / values / entries / templates / history / candidates /
 * data）。IPC 只校验转调 features（Constitution II）：
 * ① 通道已注册（不是 unknown channel）；
 * ② payload 塞 uid 不改变转调入参（用户身份只来自 ctx.userId）；
 * ③ 非法参数被拒（bad id / 空文本 / 枚举外 ruleKind / 类型不符）；
 * ④ 合法参数透传（首参 ctx.userId，其余按通道转发形状）且返回形状
 *    不增删字段（IPC 层只做 `{ ok:true, ...result }` 展开）。
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
const FID = 'fld0123456789';
const VID = 'val0123456789';
const EID = 'ent0123456789';

/** 27 条通道的合法样本：channel → { payload, 目标 mock, 期望转发参数（不含首参 uid）。
 *  wrapKey = IPC handler 把 features 返回包进固定形状的通道（如 po.deleted.list → { deleted }）。 */
const CASES: Array<{ channel: string; payload: any; target: () => any; args: any[]; wrapKey?: string }> = [
  { channel: 'po.snapshot', payload: {}, target: () => poApi.getPoSnapshot, args: [] },
  { channel: 'po.groups.create', payload: { title: '测试组' }, target: () => poApi.poCreateGroup, args: ['测试组'] },
  { channel: 'po.groups.rename', payload: { groupId: GID, title: '新名' }, target: () => poApi.poRenameGroup, args: [GID, '新名'] },
  { channel: 'po.groups.delete', payload: { groupId: GID }, target: () => poApi.poDeleteGroup, args: [GID] },
  { channel: 'po.groups.restore', payload: { groupId: GID }, target: () => poApi.poRestoreDeletedGroup, args: [GID] },
  { channel: 'po.deleted.list', payload: {}, target: () => poApi.poListDeletedGroups, args: [], wrapKey: 'deleted' },
  { channel: 'po.fields.create', payload: { groupId: GID, name: '字段', isRelation: true }, target: () => poApi.poCreateField, args: [GID, '字段', { isRelation: true }] },
  { channel: 'po.fields.rename', payload: { groupId: GID, fieldId: FID, name: '新字段' }, target: () => poApi.poRenameField, args: [GID, FID, '新字段'] },
  { channel: 'po.fields.delete', payload: { groupId: GID, fieldId: FID }, target: () => poApi.poDeleteField, args: [GID, FID] },
  { channel: 'po.fields.setRelation', payload: { groupId: GID, fieldId: FID, isRelation: true }, target: () => poApi.poSetFieldRelationFlag, args: [GID, FID, true] },
  { channel: 'po.values.add', payload: { groupId: GID, fieldId: FID, text: '值', asOf: '2026-09', ruleKind: 'operation' }, target: () => poApi.poAddValue, args: [GID, FID, { text: '值', asOf: '2026-09', ruleKind: 'operation' }] },
  { channel: 'po.values.update', payload: { groupId: GID, valueId: VID, patch: { text: '新值' } }, target: () => poApi.poUpdateValue, args: [GID, VID, { text: '新值' }] },
  { channel: 'po.values.delete', payload: { groupId: GID, valueId: VID }, target: () => poApi.poDeleteValue, args: [GID, VID] },
  { channel: 'po.entries.add', payload: { groupId: GID, text: '一笔', section: '分节' }, target: () => poApi.poAddEntry, args: [GID, '一笔', { section: '分节' }] },
  { channel: 'po.entries.delete', payload: { groupId: GID, entryId: EID }, target: () => poApi.poDeleteEntry, args: [GID, EID] },
  { channel: 'po.entries.promote', payload: { groupId: GID, entryId: EID, fieldName: '字段' }, target: () => poApi.poPromoteEntry, args: [GID, EID, '字段'] },
  { channel: 'po.templates.status', payload: {}, target: () => poApi.poListTemplateStatus, args: [], wrapKey: 'templates' },
  { channel: 'po.templates.install', payload: { templateId: 'student', restoreData: true }, target: () => poApi.poInstallTemplate, args: ['student', true] },
  { channel: 'po.templates.uninstall', payload: { templateId: 'student', archiveMemory: true }, target: () => poApi.poUninstallTemplate, args: ['student', true] },
  { channel: 'po.templates.archiveInfo', payload: { templateId: 'student' }, target: () => poApi.poTemplateArchiveInfo, args: ['student'] },
  { channel: 'po.history.list', payload: { groupId: GID }, target: () => poApi.poListHistory, args: [GID], wrapKey: 'history' },
  { channel: 'po.history.restore', payload: { groupId: GID, snapshotId: 'snap001' }, target: () => groupsFeature.restoreGroupSnapshot, args: [GID, 'snap001'] },
  { channel: 'po.candidates.confirm', payload: { candidateId: 'cand1', dest: {}, acknowledgeConflict: true }, target: () => candidatesFeature.confirmCandidate, args: ['cand1', {}, { acknowledgeConflict: true }] },
  { channel: 'po.candidates.reject', payload: { candidateId: 'cand1' }, target: () => candidatesFeature.rejectCandidate, args: ['cand1'] },
  { channel: 'po.data.export', payload: {}, target: () => poApi.poExportMarkdown, args: [], wrapKey: 'markdown' },
  { channel: 'po.data.importPreview', payload: { text: '## 组' }, target: () => poApi.poImportPreview, args: ['## 组'] },
  { channel: 'po.data.importApply', payload: { items: [] }, target: () => poApi.poImportApply, args: [[]] },
];

describe('ipc › po.* v2 通道（27 条薄转发）', () => {
  it('全部通道已注册（不是 unknown channel）', async () => {
    expect(CASES.length).toBe(27);
    for (const c of CASES) {
      const res = await call(c.channel, c.payload);
      expect(res, c.channel).not.toEqual({ ok: false, error: `unknown channel: ${c.channel}` });
      expect(res.ok, c.channel).toBe(true);
    }
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

  it('非法参数被拒（bad id / 空文本 / 枚举外 ruleKind / 类型不符）', async () => {
    const invalid: Array<{ channel: string; payload: any }> = [
      { channel: 'po.groups.create', payload: { title: '   ' } },
      { channel: 'po.groups.rename', payload: { groupId: '../evil', title: 'x' } },
      { channel: 'po.groups.delete', payload: { groupId: '' } },
      { channel: 'po.groups.restore', payload: { groupId: 'bad id!' } },
      { channel: 'po.fields.create', payload: { groupId: GID, name: '' } },
      { channel: 'po.fields.rename', payload: { groupId: GID, fieldId: '../evil', name: 'x' } },
      { channel: 'po.fields.delete', payload: { groupId: GID, fieldId: null } },
      { channel: 'po.fields.setRelation', payload: { groupId: GID, fieldId: '../evil' } },
      { channel: 'po.values.add', payload: { groupId: GID, fieldId: FID, text: '  ' } },
      { channel: 'po.values.add', payload: { groupId: GID, fieldId: FID, text: '值', ruleKind: 'evil_kind' } },
      { channel: 'po.values.update', payload: { groupId: GID, valueId: 'bad id!', patch: {} } },
      { channel: 'po.values.update', payload: { groupId: GID, valueId: VID, patch: null } },
      { channel: 'po.values.delete', payload: { groupId: GID, valueId: '../evil' } },
      { channel: 'po.entries.add', payload: { groupId: GID, text: '' } },
      { channel: 'po.entries.delete', payload: { groupId: GID, entryId: 'bad id!' } },
      { channel: 'po.entries.promote', payload: { groupId: GID, entryId: EID, fieldName: ' ' } },
      { channel: 'po.templates.install', payload: { templateId: '../evil' } },
      { channel: 'po.templates.uninstall', payload: { templateId: '' } },
      { channel: 'po.templates.archiveInfo', payload: { templateId: 'bad id!' } },
      { channel: 'po.history.list', payload: { groupId: '../evil' } },
      { channel: 'po.history.restore', payload: { groupId: GID, snapshotId: '' } },
      { channel: 'po.candidates.confirm', payload: { candidateId: '' } },
      { channel: 'po.candidates.reject', payload: { candidateId: 42 } },
      { channel: 'po.data.importPreview', payload: { text: 123 } },
      { channel: 'po.data.importApply', payload: { items: 'not-array' } },
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
