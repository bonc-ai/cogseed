import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (event: unknown, req: { channel: string; payload?: unknown }) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;
type StreamFn = (event: unknown, req: { requestId: string; channel: string; payload?: unknown }) => Promise<void>;

const TEST_UID = 'cogseed-user-ipc';
let invokeHandler: InvokeFn | null = null;
let streamHandler: StreamFn | null = null;

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: InvokeFn) => {
      if (channel === 'cogseed.invoke') invokeHandler = fn;
    },
    on: (channel: string, fn: StreamFn) => {
      if (channel === 'cogseed.streamStart') streamHandler = fn;
    },
  },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

const taskSummary = (status = 'running') => ({
  taskId: 'cogseed-task-ipc',
  requestId: 'req-ipc',
  sessionId: 'cogseed-session-ipc',
  status,
  title: 'Do work.',
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:01.000Z',
  actions: { retry: status === 'failed' || status === 'cancelled', skip: false, resume: status === 'recoverable', abort: status !== 'completed' && status !== 'failed' && status !== 'cancelled' },
});

const cogseedService = {
  start: vi.fn(async () => taskSummary()),
  read: vi.fn(async () => taskSummary()),
  cancel: vi.fn(async () => taskSummary('cancelled')),
  abort: vi.fn(async () => taskSummary('cancelled')),
  retry: vi.fn(async () => ({ ...taskSummary('created'), taskId: 'cogseed-task-retry', requestId: 'req-ipc-retry' })),
  resume: vi.fn(async () => taskSummary('recoverable')),
  action: vi.fn(async () => ({ schemaVersion: 1, sessionId: 'cogseed-session-ipc', updatedAt: '2026-08-05T00:00:04.000Z', session: { sessionId: 'cogseed-session-ipc' }, task: taskSummary('running'), actors: [], tasks: [], workflow: { childTaskIds: [], steps: [] }, recovery: { recoverable: false, taskIds: [] }, timeline: [], actions: taskSummary('running').actions })),
  events: vi.fn(async () => ({ events: [{ eventId: 'cogseed-event-1', taskId: 'cogseed-task-ipc', sessionId: 'cogseed-session-ipc', sequence: 1, type: 'task.started', createdAt: '2026-08-05T00:00:00.000Z', payload: { summary: 'started' } }], afterSequence: 0 })),
  streamEvents: vi.fn(async function* () {
    yield { type: 'event', event: { eventId: 'cogseed-event-1', taskId: 'cogseed-task-ipc', sessionId: 'cogseed-session-ipc', sequence: 1 } };
  }),
  board: vi.fn(async () => ({
    schemaVersion: 1,
    tasks: [{ ...taskSummary(), column: 'running', sessionTitle: 'IPC run' }],
    groups: [],
  })),
  sessions: vi.fn(async () => [{ sessionId: 'cogseed-session-ipc', createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:01.000Z', taskCount: 1, activeTaskCount: 1, latestStatus: 'running', hasRecovery: false }]),
  session: vi.fn(async () => ({
    session: { sessionId: 'cogseed-session-ipc', createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:01.000Z', taskCount: 1, activeTaskCount: 1, latestStatus: 'running', hasRecovery: false },
    collaboration: { schemaVersion: 1, sessionId: 'cogseed-session-ipc', updatedAt: '2026-08-05T00:00:01.000Z', session: { sessionId: 'cogseed-session-ipc' }, task: taskSummary(), actors: [], tasks: [], workflow: { childTaskIds: [], steps: [] }, recovery: { recoverable: false, taskIds: [] }, timeline: [], actions: taskSummary().actions },
  })),
  runtimeStatus: vi.fn(async () => ({ backend: 'cogseed', uid: TEST_UID })),
  restartRuntime: vi.fn(async () => ({ restarted: true, uid: TEST_UID })),
  recover: vi.fn(async () => ({ recoveredCount: 0, dispatchedCount: 0, taskIds: [] })),
};

beforeEach(async () => {
  invokeHandler = null;
  streamHandler = null;
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock('../../../src/main/features/cogseed_backend', () => ({ cogseedIpcService: cogseedService }));
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

async function stream(channel: string, payload: unknown = {}) {
  if (!streamHandler) throw new Error('stream handler not registered');
  const sent: unknown[] = [];
  const sender = { ...trustedIpcSender(), isDestroyed: () => false, send: (_channel: string, event: unknown) => { sent.push(event); } };
  await streamHandler({ sender }, { requestId: 'req-cogseed-ipc-stream', channel, payload });
  return sent;
}

describe('Mate Agent backend IPC channels', () => {
  it('routes task invoke operations through the active user scoped Mate service', async () => {
    await expect(call('cogseed.task.start', { requestId: 'req-ipc', task: 'Do work.', uid: 'attacker' })).resolves.toMatchObject({ ok: true, taskId: 'cogseed-task-ipc', requestId: 'req-ipc' });
    await expect(call('cogseed.task.read', { taskId: 'cogseed-task-ipc', uid: 'attacker' })).resolves.toMatchObject({ ok: true, taskId: 'cogseed-task-ipc', status: 'running' });
    await expect(call('cogseed.task.cancel', { taskId: 'cogseed-task-ipc', uid: 'attacker' })).resolves.toMatchObject({ ok: true, taskId: 'cogseed-task-ipc', status: 'cancelled' });
    await expect(call('cogseed.task.retry', { taskId: 'cogseed-task-ipc', requestId: 'req-ipc-retry', uid: 'attacker' })).resolves.toMatchObject({ ok: true, taskId: 'cogseed-task-retry' });
    await expect(call('cogseed.task.resume', { taskId: 'cogseed-task-ipc', requestId: 'req-ipc-resume', continuation: 'Continue.', uid: 'attacker' })).resolves.toMatchObject({ ok: true, taskId: 'cogseed-task-ipc', status: 'recoverable' });
    await expect(call('cogseed.task.events', { taskId: 'cogseed-task-ipc', afterSequence: 0, uid: 'attacker' })).resolves.toMatchObject({ ok: true, events: [expect.objectContaining({ eventId: 'cogseed-event-1' })] });
    await expect(call('cogseed.task.list', { uid: 'attacker' })).resolves.toMatchObject({ ok: true, schemaVersion: 1, tasks: [expect.objectContaining({ column: 'running' })] });
    await expect(call('cogseed.task.action', { action: 'abort', taskId: 'cogseed-task-ipc', uid: 'attacker' })).resolves.toMatchObject({ ok: true, sessionId: 'cogseed-session-ipc', workflow: expect.objectContaining({ childTaskIds: [] }) });

    expect(cogseedService.start).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ requestId: 'req-ipc', task: 'Do work.', uid: 'attacker' }));
    expect(cogseedService.read).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ taskId: 'cogseed-task-ipc', uid: 'attacker' }));
    expect(cogseedService.cancel).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ taskId: 'cogseed-task-ipc', uid: 'attacker' }));
    expect(cogseedService.retry).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ requestId: 'req-ipc-retry', uid: 'attacker' }));
    expect(cogseedService.resume).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ taskId: 'cogseed-task-ipc', requestId: 'req-ipc-resume', continuation: 'Continue.', uid: 'attacker' }));
    expect(cogseedService.events).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ taskId: 'cogseed-task-ipc', uid: 'attacker' }));
    expect(cogseedService.board).toHaveBeenCalledWith(TEST_UID);
    expect(cogseedService.action).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ action: 'abort', taskId: 'cogseed-task-ipc', uid: 'attacker' }));
  });

  it('streams Mate task events over the existing cogseed.stream transport', async () => {
    const sent = await stream('cogseed.task.events', { taskId: 'cogseed-task-ipc', afterSequence: 0, uid: 'attacker' });

    expect(cogseedService.streamEvents).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ taskId: 'cogseed-task-ipc', uid: 'attacker' }), expect.any(AbortSignal));
    expect(sent).toEqual([
      { type: 'event', event: expect.objectContaining({ eventId: 'cogseed-event-1' }) },
      { type: 'done' },
    ]);
  });

  it('does not expose hidden Core or fallback controls as IPC channels', async () => {
    await expect(call('cogseed.task.startWithFallback', {})).resolves.toMatchObject({ ok: false, error: expect.stringContaining('unknown channel') });
    await expect(call('cogseed.runtime.coreFallback', {})).resolves.toMatchObject({ ok: false, error: expect.stringContaining('unknown channel') });
  });

  it('routes independent session and runtime channels without touching CogSeed state', async () => {
    await expect(call('cogseed.session.list', { uid: 'attacker' })).resolves.toMatchObject({ ok: true, sessions: [{ sessionId: 'cogseed-session-ipc' }] });
    await expect(call('cogseed.session.read', { sessionId: 'cogseed-session-ipc', uid: 'attacker' })).resolves.toMatchObject({ ok: true, session: expect.objectContaining({ sessionId: 'cogseed-session-ipc' }), collaboration: expect.objectContaining({ sessionId: 'cogseed-session-ipc' }) });
    await expect(call('cogseed.runtime.status', { uid: 'attacker' })).resolves.toMatchObject({ ok: true, backend: 'cogseed', uid: TEST_UID });
    await expect(call('cogseed.runtime.restart', { uid: 'attacker' })).resolves.toMatchObject({ ok: true, restarted: true, uid: TEST_UID });
    expect(cogseedService.sessions).toHaveBeenCalledWith(TEST_UID);
    expect(cogseedService.session).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ sessionId: 'cogseed-session-ipc', uid: 'attacker' }));
    expect(cogseedService.runtimeStatus).toHaveBeenCalledWith(TEST_UID);
    expect(cogseedService.restartRuntime).toHaveBeenCalledWith(TEST_UID);
  });
});
