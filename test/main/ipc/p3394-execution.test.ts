import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (event: unknown, req: { channel: string; payload?: unknown }) => Promise<any>;
let invokeHandler: InvokeFn | null = null;

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: InvokeFn) => { if (channel === 'cogseed.invoke') invokeHandler = fn; }, on: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }), logFromRenderer: vi.fn(),
}));

let root = '';
const UID = 'p3394ExecutionIpcUser';
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-execution-ipc-'));
  process.env.COGSEED_WORKSPACE_ROOT = root;
  invokeHandler = null;
  vi.resetModules();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});
afterEach(async () => {
  const p3394 = await import('../../../src/main/features/p3394');
  p3394._setBehaviorContrastExecutorForTest(null);
  delete process.env.COGSEED_WORKSPACE_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});
function call(channel: string, payload: unknown = {}) {
  if (!invokeHandler) throw new Error('invoke handler missing');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

describe('IPC P3394 execution observability', () => {
  it('starts and reads a contrast, receipt, and execution summaries', async () => {
    const p3394 = await import('../../../src/main/features/p3394');
    await p3394.prepareReceipt(UID, {
      receiptId: 'receipt-ipc-1', executionId: 'receipt-exec-ipc-1',
      targetSessionId: 'gmember-target', targetContextId: 'ctx-target',
      reusedRefs: ['memory:one'], omittedRefs: ['memory:private'], permissionMode: 'workspace-write',
      allowedScopes: ['workspace:read'], boundary: 'test-double',
    }, { sessionId: 'gmember-target', contextId: 'ctx-target' });
    p3394._setBehaviorContrastExecutorForTest(async (request) => ({
      status: 'completed', output: `${request.contextMode}-output`, artifacts: [],
    }));

    const started = await call('p3394.behaviorContrast.start', {
      contrastId: 'contrast-ipc-1', receiptExecutionId: 'receipt-exec-ipc-1', task: 'same task',
      attachmentIds: [], conversationId: 'conversation-ipc-1', executionKind: 'core-agent',
    });
    expect(started.ok).toBe(true);
    expect(started.contrast.boundary).toBe('test-double');

    const listed = await call('p3394.execution.list');
    expect(listed.executions).toHaveLength(2);
    const readExecution = await call('p3394.execution.read', { executionId: started.contrast.baselineExecutionId });
    expect(readExecution.execution.status).toBe('completed');
    const readReceipt = await call('p3394.contextReuseReceipt.read', { executionId: 'receipt-exec-ipc-1' });
    expect(readReceipt.receipt).toMatchObject({ status: 'completed', baselineExecutionId: started.contrast.baselineExecutionId });
    const readContrast = await call('p3394.behaviorContrast.read', { contrastId: 'contrast-ipc-1' });
    expect(readContrast.contrast).toEqual(started.contrast);
  });

  it('rejects invalid execution and contrast ids', async () => {
    expect((await call('p3394.execution.read', { executionId: '../escape' })).ok).toBe(false);
    expect((await call('p3394.behaviorContrast.read', { contrastId: '../escape' })).ok).toBe(false);
  });
});
