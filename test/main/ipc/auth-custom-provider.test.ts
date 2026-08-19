import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeResult = { ok: boolean; error?: string } & Record<string, unknown>;
type InvokeFn = (
  event: unknown,
  request: { channel: string; payload?: unknown },
) => Promise<InvokeResult>;

const UID = 'custom-provider-ipc-user';
let invokeHandler: InvokeFn | null = null;
let root: string;
let previousRoot: string | undefined;

vi.mock('electron', () => ({
  app: { getName: vi.fn(() => 'CogSeed'), getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
  ipcMain: {
    handle: (channel: string, handler: InvokeFn) => {
      if (channel === 'cogseed.invoke') invokeHandler = handler;
    },
    on: vi.fn(),
  },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-provider-ipc-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  invokeHandler = null;
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));

  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

function invoke(channel: string, payload: unknown = {}): Promise<InvokeResult> {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

describe('custom provider auth IPC', () => {
  it('rejects adding an entry for a disabled provider without exposing its secret', async () => {
    const providers = await import('../../../src/main/features/custom_providers');
    const added = providers.addCustomProvider(UID, {
      name: 'Disabled IPC Relay',
      protocol: 'openai',
      baseUrl: 'https://ipc-relay.example/v1',
      apiKey: 'ipc-disabled-provider-secret',
      models: ['model-a', 'model-b'],
    });
    if (!added.ok) throw new Error(added.error);
    expect(providers.setCustomProviderEnabled(UID, added.id, false)).toEqual({ ok: true, enabled: false });

    const providerId = `cp:${added.id}`;
    const result = await invoke('auth.addEntry', {
      provider: providerId,
      profileId: providerId,
      model: 'model-b',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disabled/i);
    expect(result.error).toContain(providerId);
    expect(result.error).toContain('model-b');
    expect(JSON.stringify(result)).not.toContain('ipc-disabled-provider-secret');
    const auth = await import('../../../src/main/features/auth');
    expect((await auth.listEntries({ includeUnavailable: true })).entries.map((entry) => entry.model)).toEqual(['model-a']);
  });
});
