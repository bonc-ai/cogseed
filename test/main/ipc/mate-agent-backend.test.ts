import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (event: unknown, req: { channel: string; payload?: unknown }) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;
type StreamFn = (event: unknown, req: { requestId: string; channel: string; payload?: unknown }) => Promise<void>;

const TEST_UID = 'mate-user-ipc';
let invokeHandler: InvokeFn | null = null;
let streamHandler: StreamFn | null = null;

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: InvokeFn) => {
      if (channel === 'orkas.invoke') invokeHandler = fn;
    },
    on: (channel: string, fn: StreamFn) => {
      if (channel === 'orkas.streamStart') streamHandler = fn;
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
  taskId: 'mate-task-ipc',
  requestId: 'req-ipc',
  sessionId: 'mate-session-ipc',
  status,
  title: 'Do work.',
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:01.000Z',
  actions: { retry: status === 'failed' || status === 'cancelled', skip: false, resume: status === 'recoverable', abort: status !== 'completed' && status !== 'failed' && status !== 'cancelled' },
});

const mateService = {
  start: vi.fn(async () => taskSummary()),
  read: vi.fn(async () => taskSummary()),
  cancel: vi.fn(async () => taskSummary('cancelled')),
  abort: vi.fn(async () => taskSummary('cancelled')),
  retry: vi.fn(async () => ({ ...taskSummary('created'), taskId: 'mate-task-retry', requestId: 'req-ipc-retry' })),
  resume: vi.fn(async () => taskSummary('recoverable')),
  action: vi.fn(async () => ({ schemaVersion: 1, sessionId: 'mate-session-ipc', updatedAt: '2026-08-05T00:00:04.000Z', session: { sessionId: 'mate-session-ipc' }, task: taskSummary('running'), actors: [], tasks: [], workflow: { childTaskIds: [], steps: [] }, recovery: { recoverable: false, taskIds: [] }, timeline: [], actions: taskSummary('running').actions })),
  events: vi.fn(async () => ({ events: [{ eventId: 'mate-event-1', taskId: 'mate-task-ipc', sessionId: 'mate-session-ipc', sequence: 1, type: 'task.started', createdAt: '2026-08-05T00:00:00.000Z', payload: { summary: 'started' } }], afterSequence: 0 })),
  streamEvents: vi.fn(async function* () {
    yield { type: 'event', event: { eventId: 'mate-event-1', taskId: 'mate-task-ipc', sessionId: 'mate-session-ipc', sequence: 1 } };
  }),
  sessions: vi.fn(async () => [{ sessionId: 'mate-session-ipc', createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:01.000Z', taskCount: 1, activeTaskCount: 1, latestStatus: 'running', hasRecovery: false }]),
  session: vi.fn(async () => ({
    session: { sessionId: 'mate-session-ipc', createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:01.000Z', taskCount: 1, activeTaskCount: 1, latestStatus: 'running', hasRecovery: false },
    collaboration: { schemaVersion: 1, sessionId: 'mate-session-ipc', updatedAt: '2026-08-05T00:00:01.000Z', session: { sessionId: 'mate-session-ipc' }, task: taskSummary(), actors: [], tasks: [], workflow: { childTaskIds: [], steps: [] }, recovery: { recoverable: false, taskIds: [] }, timeline: [], actions: taskSummary().actions },
  })),
  runtimeStatus: vi.fn(async () => ({ backend: 'mate', uid: TEST_UID })),
  restartRuntime: vi.fn(async () => ({ restarted: true, uid: TEST_UID })),
  recover: vi.fn(async () => ({ recoveredCount: 0, dispatchedCount: 0, taskIds: [] })),
};

beforeEach(async () => {
  invokeHandler = null;
  streamHandler = null;
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock('../../../src/main/features/mate_agent_backend', () => ({ mateIpcService: mateService }));
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
  await streamHandler({ sender }, { requestId: 'req-mate-ipc-stream', channel, payload });
  return sent;
}

describe('Mate Agent backend IPC channels', () => {
  it('routes task invoke operations through the active user scoped Mate service', async () => {
    await expect(call('mate_agent.task.start', { requestId: 'req-ipc', task: 'Do work.', uid: 'attacker' })).resolves.toMatchObject({ ok: true, taskId: 'mate-task-ipc', requestId: 'req-ipc' });
    await expect(call('mate_agent.task.read', { taskId: 'mate-task-ipc', uid: 'attacker' })).resolves.toMatchObject({ ok: true, taskId: 'mate-task-ipc', status: 'running' });
    await expect(call('mate_agent.task.cancel', { taskId: 'mate-task-ipc', uid: 'attacker' })).resolves.toMatchObject({ ok: true, taskId: 'mate-task-ipc', status: 'cancelled' });
    await expect(call('mate_agent.task.retry', { taskId: 'mate-task-ipc', requestId: 'req-ipc-retry', uid: 'attacker' })).resolves.toMatchObject({ ok: true, taskId: 'mate-task-retry' });
    await expect(call('mate_agent.task.resume', { taskId: 'mate-task-ipc', requestId: 'req-ipc-resume', continuation: 'Continue.', uid: 'attacker' })).resolves.toMatchObject({ ok: true, taskId: 'mate-task-ipc', status: 'recoverable' });
    await expect(call('mate_agent.task.events', { taskId: 'mate-task-ipc', afterSequence: 0, uid: 'attacker' })).resolves.toMatchObject({ ok: true, events: [expect.objectContaining({ eventId: 'mate-event-1' })] });
    await expect(call('mate_agent.task.action', { action: 'abort', taskId: 'mate-task-ipc', uid: 'attacker' })).resolves.toMatchObject({ ok: true, sessionId: 'mate-session-ipc', workflow: expect.objectContaining({ childTaskIds: [] }) });

    expect(mateService.start).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ requestId: 'req-ipc', task: 'Do work.', uid: 'attacker' }));
    expect(mateService.read).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ taskId: 'mate-task-ipc', uid: 'attacker' }));
    expect(mateService.cancel).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ taskId: 'mate-task-ipc', uid: 'attacker' }));
    expect(mateService.retry).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ requestId: 'req-ipc-retry', uid: 'attacker' }));
    expect(mateService.resume).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ taskId: 'mate-task-ipc', requestId: 'req-ipc-resume', continuation: 'Continue.', uid: 'attacker' }));
    expect(mateService.events).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ taskId: 'mate-task-ipc', uid: 'attacker' }));
    expect(mateService.action).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ action: 'abort', taskId: 'mate-task-ipc', uid: 'attacker' }));
  });

  it('streams Mate task events over the existing orkas.stream transport', async () => {
    const sent = await stream('mate_agent.task.events', { taskId: 'mate-task-ipc', afterSequence: 0, uid: 'attacker' });

    expect(mateService.streamEvents).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ taskId: 'mate-task-ipc', uid: 'attacker' }), expect.any(AbortSignal));
    expect(sent).toEqual([
      { type: 'event', event: expect.objectContaining({ eventId: 'mate-event-1' }) },
      { type: 'done' },
    ]);
  });

  it('does not expose hidden Core or fallback controls as IPC channels', async () => {
    await expect(call('mate_agent.task.startWithFallback', {})).resolves.toMatchObject({ ok: false, error: expect.stringContaining('unknown channel') });
    await expect(call('mate_agent.runtime.coreFallback', {})).resolves.toMatchObject({ ok: false, error: expect.stringContaining('unknown channel') });
  });

  it('routes independent session and runtime channels without touching Orkas state', async () => {
    await expect(call('mate_agent.session.list', { uid: 'attacker' })).resolves.toMatchObject({ ok: true, sessions: [{ sessionId: 'mate-session-ipc' }] });
    await expect(call('mate_agent.session.read', { sessionId: 'mate-session-ipc', uid: 'attacker' })).resolves.toMatchObject({ ok: true, session: expect.objectContaining({ sessionId: 'mate-session-ipc' }), collaboration: expect.objectContaining({ sessionId: 'mate-session-ipc' }) });
    await expect(call('mate_agent.runtime.status', { uid: 'attacker' })).resolves.toMatchObject({ ok: true, backend: 'mate', uid: TEST_UID });
    await expect(call('mate_agent.runtime.restart', { uid: 'attacker' })).resolves.toMatchObject({ ok: true, restarted: true, uid: TEST_UID });
    expect(mateService.sessions).toHaveBeenCalledWith(TEST_UID);
    expect(mateService.session).toHaveBeenCalledWith(TEST_UID, expect.objectContaining({ sessionId: 'mate-session-ipc', uid: 'attacker' }));
    expect(mateService.runtimeStatus).toHaveBeenCalledWith(TEST_UID);
    expect(mateService.restartRuntime).toHaveBeenCalledWith(TEST_UID);
  });
});
