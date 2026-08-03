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
      if (channel === 'orkas.invoke') invokeHandler = fn;
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
  listCognitionAssets: vi.fn(async () => ([{ id: 'cog_1', title: '认知', stage: 'seed' }])),
  listCognitionAssetPage: vi.fn(async (_uid: string, page: number, pageSize: number) => ({
    items: [{ id: 'cog_1', title: '认知', stage: 'seed', evidenceCount: 0, reuseCount: 0 }],
    page,
    pageSize,
    total: 1,
    totalPages: 1,
  })),
  getCognitionAsset: vi.fn(async (_uid: string, assetId: string) => ({ id: assetId, title: '认知', stage: 'seed' })),
  createCognitionAsset: vi.fn(async (_uid: string, input: { title: string; summary: string }) => ({ id: 'cog_new', ...input, stage: 'seed' })),
  createCognitionAssetWithEvidence: vi.fn(async (_uid: string, input: { title: string; summary: string; evidence: Record<string, unknown> }) => ({ id: 'cog_capture', ...input, stage: 'sprout' })),
  addCognitionEvidence: vi.fn(async (_uid: string, assetId: string) => ({ id: assetId, title: '认知', stage: 'sprout' })),
  confirmCognitionAsset: vi.fn(async (_uid: string, assetId: string) => ({ id: assetId, title: '认知', stage: 'growing' })),
  deferCognitionAsset: vi.fn(async (_uid: string, assetId: string) => ({ id: assetId, title: '认知', stage: 'sprout' })),
  recordCognitionReuse: vi.fn(async (_uid: string, assetId: string) => ({ id: assetId, title: '认知', stage: 'bright' })),
}));

beforeEach(async () => {
  process.env.ORKAS_WORKSPACE_ROOT = os.tmpdir();
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
  it('列表与创建使用当前用户，并校验必填文本', async () => {
    expect((await call('cognition.assets.list')).assets).toEqual([
      expect.objectContaining({ id: 'cog_1' }),
    ]);
    expect((await call('cognition.assets.create', { title: '认知' })).ok).toBe(false);
    const created = await call('cognition.assets.create', { title: '认知', summary: '工作方式' });
    expect(created.ok).toBe(true);
    expect((created.asset as { id: string }).id).toBe('cog_new');
  });

  it('分页摘要校验边界并保留旧列表 channel', async () => {
    const result = await call('cognition.assets.page', { page: '2', pageSize: '20' });
    expect(result.ok).toBe(true);
    expect(result.page).toEqual(expect.objectContaining({ page: 2, pageSize: 20 }));
    expect((await call('cognition.assets.page', { page: 0, pageSize: 20 })).ok).toBe(false);
    expect((await call('cognition.assets.page', { page: 1, pageSize: 101 })).ok).toBe(false);
    expect((await call('cognition.assets.list')).ok).toBe(true);
  });

  it('从对话捕获要求完整证据且拒绝路径型 id', async () => {
    expect((await call('cognition.assets.capture', { title: '认知', summary: '工作方式' })).ok).toBe(false);
    const captured = await call('cognition.assets.capture', {
      title: '先确认边界再执行',
      summary: '先明确验收标准。',
      evidence: {
        kind: 'conversation',
        summary: '本次先确认了方案。',
        sourceLabel: '方案设计会话',
        conversationId: 'c_capture',
      },
    });
    expect(captured.ok).toBe(true);
    expect((captured.asset as { id: string }).id).toBe('cog_capture');
    expect((await call('cognition.assets.confirm', { assetId: '../outside' })).ok).toBe(false);
  });

  it('拒绝空证据来源和无效证据类型', async () => {
    expect((await call('cognition.assets.evidence.add', {
      assetId: 'cog_1',
      kind: 'manual',
      summary: '补充证据',
      sourceLabel: '   ',
    })).ok).toBe(false);
    expect((await call('cognition.assets.evidence.add', {
      assetId: 'cog_1',
      kind: 'unknown',
      summary: '补充证据',
      sourceLabel: '手工输入',
    })).ok).toBe(false);
  });
});
