import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeResult = { ok: boolean; error?: string } & Record<string, unknown>;
type InvokeFn = (event: unknown, req: { channel: string; payload?: unknown }) => Promise<InvokeResult>;

let invokeHandler: InvokeFn | null = null;
const TEST_UID = 'uCognitionIpc';
const dialogMock = vi.hoisted(() => vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })));
const saveDialogMock = vi.hoisted(() => vi.fn(async () => ({ canceled: true, filePath: undefined as string | undefined })));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: InvokeFn) => {
      if (channel === 'cogseed.invoke') invokeHandler = fn;
    },
    on: vi.fn(),
  },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: dialogMock, showSaveDialog: saveDialogMock },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

vi.mock('../../../src/main/features/cognition', () => ({
  DEFAULT_COGNITION_PAGE_SIZE: 50,
  MAX_COGNITION_PAGE_SIZE: 100,
  listCognitionAssets: vi.fn(async () => ([{ id: 'asset_1', title: '能力资产', type: 'knowledge' }])),
  listCognitionAssetPage: vi.fn(async (_uid: string, page: number, pageSize: number) => ({
    items: [{ id: 'cog_1', title: '认知', stage: 'seed', evidenceCount: 0, reuseCount: 0 }],
    page,
    pageSize,
    total: 1,
    totalPages: 1,
  })),
  getSkillCognitionSummary: vi.fn(async (_uid: string, skillId: string) => ({
    skillId,
    version: '2',
    baselineStatus: 'available',
    recentReceipts: [],
    versions: [{ version: '2', canRollback: true, rollbackScope: 'full_tree' }],
  })),
  diffSkillCognitionVersions: vi.fn(async () => ({
    added: 1, modified: 1, deleted: 0, unchanged: 2,
    files: [{ path: 'SKILL.md', status: 'modified', lines: [{ type: 'context', text: 'ok' }] }],
  })),
  previewSkillCognitionRollback: vi.fn(async (_uid: string, skillId: string, version: string) => ({
    skillId,
    currentVersion: '2',
    currentRevisionId: 'revision-2',
    currentManifestHash: 'a'.repeat(64),
    targetVersion: version,
    targetRevisionId: 'revision-1',
    targetManifestHash: 'b'.repeat(64),
    rollbackScope: 'full_tree',
  })),
  rollbackSkillCognitionVersion: vi.fn(async (_uid: string, skillId: string, version: string) => ({
    ok: true, skillId, version: '3', restoredFromVersion: version, rollbackScope: 'full_tree',
  })),
}));

beforeEach(async () => {
  // Keep the isolated workspace assigned by test/setup-env.ts.
  invokeHandler = null;
  dialogMock.mockReset().mockResolvedValue({ canceled: true, filePaths: [] });
  saveDialogMock.mockReset().mockResolvedValue({ canceled: true, filePath: undefined });
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

afterEach(() => {
  vi.resetModules();
});

function call(channel: string, payload: unknown = {}): Promise<InvokeResult> {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

describe('ipc cognition channels', () => {
  it('手动认知草稿与保存通道退休，完整参数也无法重新触发形成', async () => {
    for (const channel of ['cognition.capture.draft', 'cognition.capture.save', 'recall.candidates.save', 'cognition.ontology.import.submit']) {
      const result = await call(channel, { conversationId: 'conv_1', messageId: 'msg_2', text: '旧手动草稿请求', judgment: '可复用方法', summary: '方法', suggestedType: 'personal', suggestedScope: 'general' });
      expect(result.ok).toBe(false);
    }
  });

  it('能力资产列表返回当前用户数据', async () => {
    expect((await call('cognition.assets.list')).assets).toEqual([
      expect.objectContaining({ id: 'asset_1' }),
    ]);
  });

  it('资产列表的类型过滤收四类正式资产，不收上一代分类（N-6）', async () => {
    // 曾经这里收的是 skill/knowledge/ontology/evaluation，与适配器实际过滤的
    // personal/rule/template/skill_method **完全不相交**：传合法类型抛错、
    // 传能过校验的类型恒返回空列表。渲染层当时不传该参数，所以一直潜伏。
    for (const type of ['personal', 'rule', 'template', 'skill_method']) {
      expect((await call('cognition.assets.list', { type })).ok).toBe(true);
    }
    for (const stale of ['skill', 'knowledge', 'ontology', 'evaluation']) {
      expect((await call('cognition.assets.list', { type: stale })).ok).toBe(false);
    }
  });

  it('保留资产列表 channel；旧版分页读入口已随死路由下线', async () => {
    expect((await call('cognition.assets.page', { page: '2', pageSize: '20' })).ok).toBe(false);
    expect((await call('cognition.assets.list')).ok).toBe(true);
  });

  it('本体历史归档接受零边界并拒绝负数、小数与超限', async () => {
    expect(await call('cognition.ontology.history.archive', { keepHistory: 0, keepReceipts: 0 }))
      .toMatchObject({ ok: true, archivedHistory: 0, archivedReceipts: 0 });
    for (const payload of [
      { keepHistory: -1 }, { keepHistory: 1.5 }, { keepHistory: 100001 },
      { keepReceipts: -1 }, { keepReceipts: 1.5 }, { keepReceipts: 20001 },
    ]) {
      const result = await call('cognition.ontology.history.archive', payload);
      expect(result.ok, JSON.stringify(payload)).toBe(false);
      expect(result.code).toBe('invalid_input');
    }
  });

  it('本体错误详情只转发固定计数与已知 remedy，不带路径或消息', async () => {
    const { ontologyErrorDetails } = await import('../../../src/main/ipc/cognition');
    const details = {
      limit: 100000, current: 3, receipts: 2, history: 4, entries: 1, submitted: 0,
      remedy: 'archive_history', path: '/private/store.json', message: 'secret', recordIds: ['rec-1'],
    };
    expect(ontologyErrorDetails('recall.assets.list', { details })).toBeUndefined();
    expect(ontologyErrorDetails('cognition.ontology.history.archive', { details })).toEqual({
      limit: 100000, current: 3, receipts: 2, history: 4, entries: 1, submitted: 0, remedy: 'archive_history',
    });
    expect(ontologyErrorDetails('cognition.ontology.history.archive', { details: {
      current: -1, limit: 1.5, remedy: 'delete_everything', path: '/x',
    } })).toBeUndefined();
  });

  it('导出对话框标题走当前界面语言的本地化表', async () => {
    const i18n = await import('../../../src/main/i18n');
    const expected = i18n.getRendererTables()[i18n.getCurrentUiLang()]['ontologyWorkspace.exportDialogTitle'];
    expect(typeof expected).toBe('string');
    expect(await call('cognition.ontology.export', {})).toMatchObject({ ok: true, canceled: true });
    expect(saveDialogMock).toHaveBeenCalledTimes(1);
    expect(saveDialogMock.mock.calls[0][0]).toMatchObject({ title: expected });
  });

  it('旧版 CognitionAsset 写通道已全部下线', async () => {
    for (const channel of [
      'cognition.assets.capture',
      'cognition.assets.get',
      'cognition.assets.create',
      'cognition.assets.evidence.add',
      'cognition.assets.confirm',
      'cognition.assets.defer',
      'cognition.assets.reuse',
    ]) {
      expect((await call(channel, { assetId: 'cog_1', title: '认知', summary: '工作方式' })).ok).toBe(false);
    }
  });

  it('通过认知 Skill IPC 提供摘要、完整 diff 和带并发校验的回退', async () => {
    const summary = await call('cognition.skills.summary', { skillId: 'skill-a' });
    expect(summary).toMatchObject({ ok: true, summary: { skillId: 'skill-a', version: '2' } });

    const diff = await call('cognition.skills.diff', { skillId: 'skill-a', fromVersion: '1', toVersion: '2' });
    expect(diff).toMatchObject({ ok: true, diff: { added: 1, modified: 1 } });

    const preview = await call('cognition.skills.rollback.preview', { skillId: 'skill-a', version: '1' });
    expect(preview).toMatchObject({ ok: true, preview: { targetVersion: '1', rollbackScope: 'full_tree' } });
    const rollback = await call('cognition.skills.rollback', {
      skillId: 'skill-a', version: '1', expectedRevisionId: 'revision-2', expectedManifestHash: 'a'.repeat(64),
    });
    expect(rollback).toMatchObject({ ok: true, result: { restoredFromVersion: '1' } });
  });

  it('拒绝不安全的 Skill diff 和回退参数', async () => {
    expect((await call('cognition.skills.diff', { skillId: '../escape', fromVersion: '1', toVersion: '2' })).ok).toBe(false);
    expect((await call('cognition.skills.rollback.preview', { skillId: 'skill-a', version: '../escape' })).ok).toBe(false);
    expect((await call('cognition.skills.rollback', { skillId: 'skill-a', version: '1', expectedManifestHash: 'x' })).ok).toBe(false);
  });
});
