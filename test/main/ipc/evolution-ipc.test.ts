import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (
  event: unknown,
  req: { channel: string; payload?: unknown },
) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

let invokeHandler: InvokeFn | null = null;
const TEST_UID = 'uEvolutionIpc';

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

vi.mock('../../../src/main/features/evolution', () => ({
  buildDashboard: vi.fn(async (_uid: string) => ({ skillCount: 1, enabledSkillCount: 1, pendingReviewCount: 0, evolutionRunCount: 0, runningEvolutionCount: 0, degraded: false })),
  startEvolutionRun: vi.fn(async (_uid: string, input: any) => ({ runId: 'r1', skillId: input.skillId, steps: [] })),
  stepEvolutionRun: vi.fn(async (_uid: string, runId: string) => ({ runId, steps: [] })),
  abortEvolutionRun: vi.fn(async (_uid: string, runId: string) => ({ runId, status: 'aborted' })),
  readEvolutionRun: vi.fn(async (_uid: string, runId: string) => ({ runId })),
  listEvolutionRuns: vi.fn(async () => ([{ runId: 'r1' }])),
  readEvalRecord: vi.fn(async (_uid: string, skillId: string) => ({ skillId, cases: [], runs: [] })),
  upsertEvalCase: vi.fn(async (_uid: string, skillId: string) => ({ skillId, cases: [{ id: 1 }], runs: [] })),
  extractAndSaveOntology: vi.fn(async () => ({ slice: { tbox: [], rbox: [], abox: [] }, degraded: false })),
  listSkillOntologies: vi.fn(async () => ([])),
  applyPatchToSkill: vi.fn(async (_uid: string, input: any) => ({ ok: true, newVersion: '0.1.1', skillId: input.skillId })),
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

function call(channel: string, payload: unknown = {}) {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

describe('ipc › evolution channels', () => {
  it('evolution.dashboard 转发并返回聚合', async () => {
    const r = await call('evolution.dashboard');
    expect(r.ok).toBe(true);
    expect(r.skillCount).toBe(1);
  });
  it('evolution.evolve.start 校验 skillId 缺失时 ok:false', async () => {
    const r = await call('evolution.evolve.start', {});
    expect(r.ok).toBe(false);
  });
  it('evolution.evolve.step 转发 runId', async () => {
    const r = await call('evolution.evolve.step', { runId: 'r1' });
    expect(r.ok).toBe(true);
    expect(r.runId).toBe('r1');
  });
  it('evolution.ontology.extract 返回 degraded 标记', async () => {
    const r = await call('evolution.ontology.extract', { skillId: 'sk1', text: 't' });
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(false);
  });
  it('evolution.patches.apply 缺 newContent 时 ok:false', async () => {
    const r = await call('evolution.patches.apply', { skillId: 'sk1' });
    expect(r.ok).toBe(false);
  });
});
