import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (event: unknown, request: { channel: string; payload?: unknown }) => Promise<{ ok: boolean } & Record<string, unknown>>;
let invokeHandler: InvokeFn | null = null;
const UID = 'uRecallIpc';

const recallMock = vi.hoisted(() => ({
  listRecallCandidates: vi.fn(async () => []),
  readRecallCandidate: vi.fn(async (_uid: string, id: string) => ({ id })),
  saveRecallCandidate: vi.fn(async (_uid: string, input: unknown) => input),
  deferRecallCandidate: vi.fn(async (_uid: string, id: string, note?: string) => ({ id, note, status: 'deferred' })),
  resumeRecallCandidate: vi.fn(async (_uid: string, id: string) => ({ id, status: 'pending' })),
  rejectRecallCandidate: vi.fn(async (_uid: string, id: string, note?: string) => ({ id, note, status: 'rejected' })),
  promoteRecallCandidate: vi.fn(async (_uid: string, id: string) => ({ candidate: { id }, asset: { id: 'aa-a' } })),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: InvokeFn) => { if (channel === 'orkas.invoke') invokeHandler = fn; }, on: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }), logFromRenderer: vi.fn() }));
vi.mock('../../../src/main/features/recall/candidate-service', () => recallMock);

beforeEach(async () => {
  process.env.ORKAS_WORKSPACE_ROOT = os.tmpdir();
  invokeHandler = null;
  vi.resetModules(); vi.clearAllMocks();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../src/main/features/users'); users.activateUser(UID);
  (await import('../../../src/main/ipc/index')).register();
});
afterEach(() => vi.resetModules());
function call(channel: string, payload: unknown = {}) { if (!invokeHandler) throw new Error('missing handler'); return invokeHandler({ sender: trustedIpcSender() }, { channel, payload }); }

describe('ipc › recall candidate governance', () => {
  it('routes validated save and governance actions with the active uid', async () => {
    await expect(call('recall.candidates.save', { judgment: 'Use decision logs', suggestedType: 'rule', suggestedScope: 'architecture', sourceRefs: [{ kind: 'execution', id: 'exec-a' }] })).resolves.toMatchObject({ ok: true });
    expect(recallMock.saveRecallCandidate).toHaveBeenCalledWith(UID, expect.objectContaining({ judgment: 'Use decision logs', suggestedType: 'rule' }));
    await expect(call('recall.candidates.promote', { candidateId: 'cand-a' })).resolves.toMatchObject({ ok: true, asset: { id: 'aa-a' } });
    expect(recallMock.promoteRecallCandidate).toHaveBeenCalledWith(UID, 'cand-a');
  });

  it('rejects invalid ids, enums, oversized text, and missing source refs before feature calls', async () => {
    await expect(call('recall.candidates.save', { judgment: 'x', suggestedType: 'unknown', suggestedScope: 'a', sourceRefs: [] })).resolves.toMatchObject({ ok: false });
    await expect(call('recall.candidates.promote', { candidateId: '../bad' })).resolves.toMatchObject({ ok: false });
    await expect(call('recall.candidates.defer', { candidateId: 'cand-a', note: 'x'.repeat(1_001) })).resolves.toMatchObject({ ok: false });
    expect(recallMock.promoteRecallCandidate).not.toHaveBeenCalled();
  });
});
