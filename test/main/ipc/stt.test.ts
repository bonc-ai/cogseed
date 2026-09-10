import * as os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (
  event: unknown,
  request: { channel: string; payload?: unknown },
) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

const mocks = vi.hoisted(() => ({
  invokeHandler: null as InvokeFn | null,
  cancelSession: vi.fn(),
  startSession: vi.fn(),
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: InvokeFn) => {
      if (channel === 'cogseed.invoke') mocks.invokeHandler = handler;
    },
    on: vi.fn(),
  },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => mocks.log,
  logFromRenderer: vi.fn(),
}));

vi.mock('../../../src/main/features/users', () => ({
  getActiveUserId: () => 'user-1',
  getOrCreateSelfUser: async () => ({ user_id: 'user-1' }),
}));

vi.mock('../../../src/main/features/stt/stt-service', () => ({
  startSession: mocks.startSession,
  pushAudio: vi.fn(),
  stopSession: vi.fn(),
  cancelSession: mocks.cancelSession,
  currentPartial: vi.fn(),
  currentFinal: vi.fn(),
  isSessionDone: vi.fn(),
}));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.invokeHandler = null;
  const { register } = await import('../../../src/main/ipc/index');
  register();
});

async function invoke(channel: string, payload: unknown = {}) {
  if (!mocks.invokeHandler) throw new Error('invoke handler not registered');
  return mocks.invokeHandler(
    { sender: trustedIpcSender() },
    { channel, payload },
  );
}

describe('ipc › STT', () => {
  it('delegates stt.cancel to the owning user session', async () => {
    await expect(invoke('stt.cancel', { sessionId: 'stt-session-1' })).resolves.toEqual({ ok: true });

    expect(mocks.cancelSession).toHaveBeenCalledOnce();
    expect(mocks.cancelSession).toHaveBeenCalledWith('user-1', 'stt-session-1');
  });

  it('rejects an invalid cancel session id before delegation', async () => {
    await expect(invoke('stt.cancel', { sessionId: '../other-session' })).resolves.toMatchObject({
      ok: false,
      error: 'invalid session id',
    });

    expect(mocks.cancelSession).not.toHaveBeenCalled();
  });

  it('keeps the STT error for the UI but omits its raw message from catch logs', async () => {
    mocks.startSession.mockImplementationOnce(() => {
      throw Object.assign(new Error('private recognizer failure detail'), { code: 'E_STT_NATIVE' });
    });

    await expect(invoke('stt.start')).resolves.toMatchObject({
      ok: false,
      error: 'private recognizer failure detail',
      code: 'E_STT_NATIVE',
    });

    expect(mocks.log.error).toHaveBeenCalledWith(
      'invoke stt.start failed',
      { stage: 'invoke', code: 'E_STT_NATIVE' },
    );
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain('private recognizer failure detail');
  });
});
