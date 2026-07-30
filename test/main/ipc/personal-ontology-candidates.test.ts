import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (event: unknown, req: { channel: string; payload?: unknown }) => Promise<any>;
let invokeHandler: InvokeFn | null = null;
const TEST_UID = 'uOntologyIpc';

const feature = {
  listCandidates: vi.fn(async (uid: string) => ({ candidate_updates: [], blocked_items: [], uid })),
  confirmCandidate: vi.fn(async (uid: string, candidateId: string) => ({ ok: true, uid, candidateId })),
  rejectCandidate: vi.fn(async (uid: string, candidateId: string, reason?: string) => ({ ok: true, uid, candidateId, reason })),
  confirmCandidates: vi.fn(async (uid: string, candidateIds: string[]) => ({ ok: true, uid, candidateIds })),
  rejectCandidates: vi.fn(async (uid: string, candidateIds: string[], reason?: string) => ({ ok: true, uid, candidateIds, reason })),
};

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: InvokeFn) => { if (channel === 'orkas.invoke') invokeHandler = fn; }, on: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));
vi.mock('../../../src/main/features/personal_ontology_candidates', () => feature);

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

function call(channel: string, payload: unknown = {}) {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

describe('ipc › personal ontology candidate channels', () => {
  it('uses the authenticated context user for list and ignores renderer uid', async () => {
    const result = await call('personalOntology.candidates.list', { uid: 'attacker' });
    expect(result.ok).toBe(true);
    expect(feature.listCandidates).toHaveBeenCalledWith(TEST_UID);
    expect(feature.listCandidates).not.toHaveBeenCalledWith('attacker');
  });

  it('validates single candidate ids', async () => {
    expect((await call('personalOntology.candidates.confirm', {})).ok).toBe(false);
    expect((await call('personalOntology.candidates.reject', { candidateId: 7 })).ok).toBe(false);
    expect(feature.confirmCandidate).not.toHaveBeenCalled();
    expect(feature.rejectCandidate).not.toHaveBeenCalled();
  });

  it('validates batch candidate ids and forwards user scope', async () => {
    expect((await call('personalOntology.candidates.confirmBatch', { candidateIds: 'bad' })).ok).toBe(false);
    expect((await call('personalOntology.candidates.rejectBatch', { candidateIds: {} })).ok).toBe(false);
    await call('personalOntology.candidates.confirmBatch', { candidateIds: ['a', 'b'], uid: 'attacker' });
    await call('personalOntology.candidates.rejectBatch', { candidateIds: ['c'], reason: 'no', uid: 'attacker' });
    expect(feature.confirmCandidates).toHaveBeenCalledWith(TEST_UID, ['a', 'b']);
    expect(feature.rejectCandidates).toHaveBeenCalledWith(TEST_UID, ['c'], 'no');
  });
});
