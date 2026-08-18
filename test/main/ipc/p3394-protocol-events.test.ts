import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (
  event: unknown,
  req: { channel: string; payload?: unknown },
) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

let invokeHandler: InvokeFn | null = null;

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: InvokeFn) => {
      if (channel === 'cogseed.invoke') invokeHandler = fn;
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

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'uP3394ProtocolEvents';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-p3394-protocol-ipc-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
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
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function call(channel: string, payload: unknown = {}): ReturnType<InvokeFn> {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

async function seedProtocolEvent(conversationId: string) {
  const paths = await import('../../../src/main/paths');
  const storage = await import('../../../src/main/storage');
  fs.mkdirSync(paths.userChatsDir(TEST_UID), { recursive: true });
  await storage.appendJsonlAtomic(path.join(paths.userChatsDir(TEST_UID), `${conversationId}.jsonl`), {
    id: 'msg-agent', from: 'agent-writer', text: 'done', turn_id: 'turn-1',
    process: [{ type: 'event', event: { stream: 'p3394', data: { phase: 'normalized', ok: true } } }],
  });
}

describe('ipc › p3394 protocol event routes', () => {
  it('lists protocol events for the active user and requested conversation', async () => {
    await seedProtocolEvent('gconv-protocol-a');
    await seedProtocolEvent('gconv-protocol-b');

    const listed = await call('p3394.listProtocolEvents', { cid: 'gconv-protocol-a' });

    expect(listed.ok).toBe(true);
    expect(listed.protocol_events).toEqual([
      {
        conversation_id: 'gconv-protocol-a',
        message_id: 'msg-agent',
        agent_id: 'agent-writer',
        turn_id: 'turn-1',
        index: 0,
        data: { phase: 'normalized', ok: true },
      },
    ]);

    const invalid = await call('p3394.listProtocolEvents', { cid: '../bad' });
    expect(invalid.ok).toBe(false);
    expect(String(invalid.error)).toMatch(/invalid cid/i);
  });
});
