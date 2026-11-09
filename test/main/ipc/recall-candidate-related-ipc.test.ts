/**
 * `recall.candidates.resolveRelated` 的 IPC 形状与权限边界。
 *
 * 归并预检、版本/边界判定与重判都在 candidate-service；这一层只验参数收口、
 * 当前用户寻址、结果体形状与失败透出。真实服务路径由
 * `test/main/features/recall/related-formation-resolution.test.ts` 覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (event: unknown, request: { channel: string; payload?: unknown }) => Promise<{ ok: boolean } & Record<string, unknown>>;
let invokeHandler: InvokeFn | null = null;
const UID = 'uRelatedFormationIpc';

const serviceMock = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

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
// 只替换处置入口；候选读模型/能力判据仍走真实实现（本用例的候选是内存对象）。
vi.mock('../../../src/main/features/recall/candidate-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/features/recall/candidate-service')>()),
  resolveRelatedFormationCandidate: serviceMock.resolve,
}));

const candidate = {
  id: 'cand-related-1',
  status: 'pending_review',
  judgment: '合并后的旧内容仍按同一套发布核对流程执行。',
  summary: '合并后的发布核对',
  value: '合并后仍按同一套核对流程执行。',
  suggestedType: 'rule',
  suggestedScope: 'general',
  suggestedAction: 'create',
  sourceRefs: [{ kind: 'memory', id: 'mem-related' }],
  evidenceRefs: [{ kind: 'memory', id: 'mem-related' }],
  expiresAt: '2099-01-01T00:00:00.000Z',
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z',
};

beforeEach(async () => {
  invokeHandler = null;
  vi.resetModules();
  vi.clearAllMocks();
  serviceMock.resolve.mockResolvedValue({
    resolved: true, candidate, receipts: [{ sourceAssetId: 'aa-2', status: 'merged', targetVersion: '3' }],
    resolution: 'merged',
    reformation: { captureId: 'cap-1', status: 'running', action: 'merged', targetAssetId: 'aa-1', retryable: false },
  });
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
  (await import('../../../src/main/ipc/index')).register();
});
afterEach(() => vi.resetModules());

function call(payload: unknown = {}) {
  if (!invokeHandler) throw new Error('missing handler');
  return invokeHandler({ sender: trustedIpcSender() }, { channel: 'recall.candidates.resolveRelated', payload });
}

describe('ipc › recall.candidates.resolveRelated', () => {
  it('合并：按当前用户寻址，回传候选/逐条回执/重判状态', async () => {
    const res = await call({ candidateId: 'cand-related-1', action: 'merge', targetAssetId: 'aa-1' });
    expect(res.ok).toBe(true);
    expect(res.resolved).toBe(true);
    expect(res.receipts).toEqual([{ sourceAssetId: 'aa-2', status: 'merged', targetVersion: '3' }]);
    expect(res.resolution).toBe('merged');
    expect(res.reformation).toMatchObject({ captureId: 'cap-1', status: 'running' });
    expect((res.candidate as Record<string, unknown>).capabilities).toBeTruthy();
    expect(serviceMock.resolve).toHaveBeenCalledWith(UID, 'cand-related-1', { action: 'merge', targetAssetId: 'aa-1' });
  });

  it('保留全部：不携带目标，也不接受伪造的 userId', async () => {
    const res = await call({ candidateId: 'cand-related-1', action: 'keep', userId: 'someone-else' });
    expect(res.ok).toBe(true);
    expect(serviceMock.resolve).toHaveBeenCalledWith(UID, 'cand-related-1', { action: 'keep' });
  });

  it('参数形状不合法一律拒绝且不进服务层', async () => {
    for (const payload of [
      {},
      { candidateId: 'bad id', action: 'merge', targetAssetId: 'aa-1' },
      { candidateId: 'cand-related-1', action: 'delete' },
      { candidateId: 'cand-related-1', action: 'merge', targetAssetId: 'bad id' },
      { candidateId: 'cand-related-1', action: 'keep', targetAssetId: 'aa-1' },
    ]) {
      const res = await call(payload);
      expect(res.ok).toBe(false);
    }
    expect(serviceMock.resolve).not.toHaveBeenCalled();
  });

  it('服务层拒绝时透出稳定错误码与原因', async () => {
    serviceMock.resolve.mockRejectedValueOnce(Object.assign(new Error('candidate is terminal'), {
      code: 'recall_candidate_terminal', status: 'superseded',
    }));
    const res = await call({ candidateId: 'cand-related-1', action: 'keep' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('recall_candidate_terminal');
  });
});
