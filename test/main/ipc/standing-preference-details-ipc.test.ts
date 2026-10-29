import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type Invoke = (event: unknown, request: { channel: string; payload: unknown }) => Promise<Record<string, unknown>>;
let invoke: Invoke | undefined;
const uid = 'standing-details-ipc';
const saves = vi.hoisted(() => ({
  update: vi.fn(async (_uid: string, _id: string, _input: Record<string, unknown>) => ({ id: 'aa-standing', version: '2' })),
  details: vi.fn(async (_uid: string, _id: string, _input: Record<string, unknown>) => ({ id: 'aa-standing', version: '2' })),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Invoke) => { if (channel === 'cogseed.invoke') invoke = handler; }, on: vi.fn() },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }), logFromRenderer: vi.fn() }));
vi.mock('../../../src/main/features/recall/asset-service', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/main/features/recall/asset-service')>()),
  updateAbilityAsset: saves.update,
  saveUserStandingPreferenceDetails: saves.details,
}));

beforeEach(async () => {
  invoke = undefined; vi.resetModules(); vi.clearAllMocks();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  (await import('../../../src/main/features/users')).activateUser(uid);
  (await import('../../../src/main/ipc/index')).register();
});
afterEach(() => vi.resetModules());
function call(payload: unknown) {
  if (!invoke) throw new Error('missing IPC handler');
  return invoke({ sender: trustedIpcSender() }, { channel: 'recall.assets.update', payload });
}
const complete = () => ({ assetId: 'aa-standing', statement: '解释复杂问题先写结论，随后列出关键原因。',
  applicableWhen: ['解释复杂问题'], forbiddenWhen: [], expectedVersion: '1', expectedActiveVersion: '1', reason: '保存完整详情' });

describe('complete user details save IPC boundary', () => {
  it('uses the trusted complete-details path with both baselines and ignores caller identity/proof fields', async () => {
    expect(await call({ ...complete(), reviewedDetails: true, actor: 'system', userId: 'other-user', standingPreferenceContinuation: { forged: true } })).toMatchObject({ ok: true });
    expect(saves.update).not.toHaveBeenCalled();
    expect(saves.details).toHaveBeenCalledWith(uid, 'aa-standing', expect.objectContaining({
      statement: complete().statement, applicableWhen: ['解释复杂问题'], forbiddenWhen: [],
      expectedVersion: '1', expectedActiveVersion: '1', actor: 'user',
    }));
    expect(saves.details.mock.calls[0]?.[2]).not.toHaveProperty('standingPreferenceContinuation');
    expect(saves.details.mock.calls[0]?.[2]).not.toHaveProperty('reviewedDetails');
  });

  it.each([undefined, false])('does not infer a new review from a complete payload when marker is %s', async reviewedDetails => {
    expect(await call({ ...complete(), reviewedDetails })).toMatchObject({ ok: true });
    expect(saves.details).not.toHaveBeenCalled(); expect(saves.update).toHaveBeenCalledOnce();
  });

  it.each(['statement', 'applicableWhen', 'forbiddenWhen', 'expectedVersion', 'expectedActiveVersion'])('rejects reviewed save missing %s before any mutation', async field => {
    const payload: Record<string, unknown> = { ...complete(), reviewedDetails: true }; delete payload[field];
    expect(await call(payload)).toMatchObject({ ok: false });
    expect(saves.details).not.toHaveBeenCalled(); expect(saves.update).not.toHaveBeenCalled();
  });

  it('rejects nonboolean review assertions before any mutation', async () => {
    expect(await call({ ...complete(), reviewedDetails: 'true' })).toMatchObject({ ok: false });
    expect(saves.details).not.toHaveBeenCalled(); expect(saves.update).not.toHaveBeenCalled();
  });

  it('preserves the metadata-only generic path', async () => {
    expect(await call({ assetId: 'aa-standing', title: '更清楚的标题', tags: ['常用'], reason: '整理标题', expectedVersion: '1', expectedActiveVersion: '1' })).toMatchObject({ ok: true });
    expect(saves.details).not.toHaveBeenCalled();
    expect(saves.update).toHaveBeenCalledWith(uid, 'aa-standing', expect.objectContaining({ title: '更清楚的标题', tags: ['常用'], actor: 'user' }));
    expect(saves.update.mock.calls[0]?.[2]).not.toHaveProperty('statement');
  });
});
