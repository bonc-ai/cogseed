import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (
  event: unknown,
  req: { channel: string; payload?: unknown },
) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

let invokeHandler: InvokeFn | null = null;
const TEST_UID = 'uCognitionIpc';

const cognitionMock = vi.hoisted(() => ({
  buildCognitionDashboard: vi.fn(async (_uid: string) => ({ counts: { skills: 1, pendingCandidates: 0, receipts: 0, assets: 1 }, pendingCandidates: [], recentReceipts: [], warnings: [], degraded: false })),
  listCognitionCandidates: vi.fn(async (_uid: string, filter: any) => ([{ id: 'c1', filter }])),
  decideCognitionCandidate: vi.fn(async (_uid: string, input: any) => ({ decided: input })),
  listCognitionReuseReceipts: vi.fn(async (_uid: string, filter: any) => ([{ executionId: 'exec-a', filter }])),
  readCognitionReuseReceipt: vi.fn(async (_uid: string, executionId: string) => ({ executionId })),
  listCognitionAssets: vi.fn(async (_uid: string, filter: any) => ([{ id: 'asset-a', filter }])),
  getSkillCognitionSummary: vi.fn(async (_uid: string, skillId: string) => ({ skillId, pendingCandidateCount: 0, recentReceipts: [], versions: [], baselineStatus: 'unversioned' })),
  rollbackSkillCognitionVersion: vi.fn(async (_uid: string, skillId: string, version: string) => ({ ok: true, skillId, version })),
}));

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

vi.mock('../../../src/main/features/cognition', () => cognitionMock);

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

function call(channel: string, payload: unknown = {}) {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

describe('ipc › cognition channels', () => {
  it('routes candidate list filters to the cognition feature with the active uid', async () => {
    const result = await call('cognition.candidates.list', {
      status: 'pending',
      type: 'skill_evolution',
      conversationId: 'gconv-a',
      skillId: 'skill-a',
      limit: 20,
    });

    expect(result.ok).toBe(true);
    expect(cognitionMock.listCognitionCandidates).toHaveBeenCalledWith(TEST_UID, {
      status: 'pending',
      type: 'skill_evolution',
      conversationId: 'gconv-a',
      skillId: 'skill-a',
      limit: 20,
    });
  });

  it('rejects invalid cognition list filters at the IPC boundary', async () => {
    await expect(call('cognition.candidates.list', { status: 'deferred' })).resolves.toMatchObject({ ok: false });
    await expect(call('cognition.assets.list', { type: 'secret' })).resolves.toMatchObject({ ok: false });
    expect(cognitionMock.listCognitionCandidates).not.toHaveBeenCalled();
    expect(cognitionMock.listCognitionAssets).not.toHaveBeenCalled();
  });

  it('routes personal ontology candidate decisions without accepting arbitrary sources', async () => {
    const accepted = await call('cognition.candidates.decide', {
      source: 'personal_ontology',
      candidateId: 'cand-a',
      decision: 'accept',
      toGlobalMemory: true,
      toGroupIds: ['group-a'],
    });
    expect(accepted.ok).toBe(true);
    expect(cognitionMock.decideCognitionCandidate).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({
      source: 'personal_ontology',
      candidateId: 'cand-a',
      decision: 'accept',
      toGlobalMemory: true,
      toGroupIds: ['group-a'],
    }));

    await expect(call('cognition.candidates.decide', { source: 'evil', candidateId: 'cand-a', decision: 'accept' })).resolves.toMatchObject({ ok: false });
  });

  it('routes receipts, assets, dashboard, and skill summary channels', async () => {
    await expect(call('cognition.dashboard.read')).resolves.toMatchObject({ ok: true, dashboard: expect.any(Object) });
    await expect(call('cognition.receipts.list', { status: 'succeeded', skillId: 'skill-a', limit: 5 })).resolves.toMatchObject({ ok: true, receipts: expect.any(Array) });
    await expect(call('cognition.receipts.read', { executionId: 'exec-a' })).resolves.toMatchObject({ ok: true, receipt: expect.objectContaining({ executionId: 'exec-a' }) });
    await expect(call('cognition.assets.list', { type: 'ontology', limit: 5 })).resolves.toMatchObject({ ok: true, assets: expect.any(Array) });
    await expect(call('cognition.skills.summary', { skillId: 'skill-a' })).resolves.toMatchObject({ ok: true, summary: expect.objectContaining({ skillId: 'skill-a' }) });
  });

  it('routes skill rollback through cognition with validated ids', async () => {
    await expect(call('cognition.skills.rollback', { skillId: 'skill-a', version: '0.1.1' })).resolves.toMatchObject({ ok: true, result: expect.objectContaining({ skillId: 'skill-a', version: '0.1.1' }) });
    expect(cognitionMock.rollbackSkillCognitionVersion).toHaveBeenCalledWith(TEST_UID, 'skill-a', '0.1.1');
    await expect(call('cognition.skills.rollback', { skillId: '../bad', version: '0.1.1' })).resolves.toMatchObject({ ok: false });
  });
});
