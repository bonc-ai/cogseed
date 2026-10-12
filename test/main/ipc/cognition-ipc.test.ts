import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeResult = { ok: boolean; error?: string } & Record<string, unknown>;
type InvokeFn = (event: unknown, req: { channel: string; payload?: unknown }) => Promise<InvokeResult>;

let invokeHandler: InvokeFn | null = null;
const TEST_UID = 'uCognitionIpc';

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: InvokeFn) => {
      if (channel === 'cogseed.invoke') invokeHandler = fn;
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
    pendingCandidateCount: 1,
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

vi.mock('../../../src/main/features/cognition/capture-draft', () => ({
  generateCognitionDraft: vi.fn(async (_uid: string, request: { conversationId: string; messageId: string }) => ({
    status: 'ready',
    draft: {
      title: '模型草稿',
      summary: '可复用方法',
      evidenceSummary: '本次证据',
      sourceLabel: '当前会话',
      conversationId: request.conversationId,
      messageId: request.messageId,
    },
    context: { messageCount: 3, characterCount: 100 },
  })),
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

afterEach(() => {
  vi.resetModules();
});

function call(channel: string, payload: unknown = {}): Promise<InvokeResult> {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

describe('ipc cognition channels', () => {
  it('只接受会话和消息 ID，并把生成请求交给主进程 feature', async () => {
    expect((await call('cognition.capture.draft', { conversationId: 'conv_1' })).ok).toBe(false);
    const result = await call('cognition.capture.draft', {
      conversationId: 'conv_1',
      messageId: 'msg_2',
      text: 'renderer 不应提交对话正文',
    });
    expect(result.ok).toBe(true);
    expect(result.draft).toEqual(expect.objectContaining({ conversationId: 'conv_1', messageId: 'msg_2' }));
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

  it('分页摘要校验边界并保留资产列表 channel', async () => {
    const result = await call('cognition.assets.page', { page: '2', pageSize: '20' });
    expect(result.ok).toBe(true);
    expect(result.page).toEqual(expect.objectContaining({ page: 2, pageSize: 20 }));
    expect((await call('cognition.assets.page', { page: 0, pageSize: 20 })).ok).toBe(false);
    expect((await call('cognition.assets.page', { page: 1, pageSize: 101 })).ok).toBe(false);
    expect((await call('cognition.assets.list')).ok).toBe(true);
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
