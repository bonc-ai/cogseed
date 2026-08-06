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
type HostFn = (
  event: { sender: typeof sender },
  request: Record<string, unknown>,
) => Promise<InvokeResult>;

let invokeHandler: InvokeFn | null = null;
let hostPrepareOpenHandler: HostFn | null = null;
let hostOpenHandler: HostFn | null = null;
let workspaceRoot = '';
let previousWorkspaceRoot: string | undefined;

const TEST_UID = 'u-module-integration';
const CANONICAL_EXPENSE_AGENT_ID = 'c045605cb916';
const sender = trustedIpcSender({
  once: vi.fn(),
  on: vi.fn(),
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: InvokeFn | HostFn) => {
      if (channel === 'orkas.invoke') invokeHandler = handler;
      if (channel === 'orkas.expenseWorkbenchHost.prepareOpen') hostPrepareOpenHandler = handler;
      if (channel === 'orkas.expenseWorkbenchHost.open') hostOpenHandler = handler;
    },
    on: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 0 })),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));

vi.mock('../../../src/main/features/expense_workbench/canonical-agent', () => ({
  assertCanonicalExpenseWorkbenchAgent: vi.fn(async (_userId: string, agentId: string) => {
    if (agentId !== CANONICAL_EXPENSE_AGENT_ID) {
      throw new Error('agent does not expose the canonical expense workbench');
    }
    return { agent_id: agentId };
  }),
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

vi.mock('../../../src/main/features/cognition', () => ({
  DEFAULT_COGNITION_PAGE_SIZE: 50,
  MAX_COGNITION_PAGE_SIZE: 100,
  listCognitionAssets: vi.fn(async (userId: string) => ([{
    id: 'cog-integration',
    title: `cognition-for-${userId}`,
    stage: 'seed',
  }])),
  listCognitionAssetPage: vi.fn(),
  getCognitionAsset: vi.fn(),
  createCognitionAsset: vi.fn(),
  createCognitionAssetWithEvidence: vi.fn(),
  addCognitionEvidence: vi.fn(),
  confirmCognitionAsset: vi.fn(),
  deferCognitionAsset: vi.fn(),
  recordCognitionReuse: vi.fn(),
}));

vi.mock('../../../src/main/features/expense_workbench/adapter', () => ({
  callExpenseWorkbench: vi.fn(async () => ({ applications: [] })),
  closeExpenseWorkbenchSessions: vi.fn(async () => undefined),
  configureExpenseProject: vi.fn(),
  getExpenseProjectStatus: vi.fn(() => ({ configured: false, platform: 'posix' })),
}));

vi.mock('../../../src/main/features/expense_workbench/submission', () => ({
  confirmAndSubmitExpenseWorkbench: vi.fn(),
}));

vi.mock('../../../src/main/features/expense_workbench/material-import', () => ({
  addAndBindExpenseMaterialsFromPaths: vi.fn(),
  assertExpenseMaterialTarget: vi.fn(),
}));

beforeEach(async () => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-module-integration-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = workspaceRoot;
  invokeHandler = null;
  hostPrepareOpenHandler = null;
  hostOpenHandler = null;
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));

  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  vi.resetModules();
});

function call(channel: string, payload: unknown = {}): Promise<InvokeResult> {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender }, { channel, payload });
}

async function openExpenseWorkbench(): Promise<{ hostCapability: string; pageInstance: string }> {
  if (!hostPrepareOpenHandler || !hostOpenHandler) {
    throw new Error('expense host-open handlers not registered');
  }
  const prepared = await hostPrepareOpenHandler(
    { sender },
    { agent_id: CANONICAL_EXPENSE_AGENT_ID, gesture: 'agent_detail' },
  );
  if (prepared.ok !== true
      || typeof prepared.open_ticket !== 'string'
      || typeof prepared.page_instance !== 'string') {
    throw new Error(`expense management surface could not prepare: ${String(prepared.error || '')}`);
  }
  const result = await hostOpenHandler(
    { sender },
    { open_ticket: prepared.open_ticket, page_instance: prepared.page_instance },
  );
  if (result.ok !== true || typeof result.host_capability !== 'string') {
    throw new Error(`expense management surface could not open: ${String(result.error || '')}`);
  }
  return { hostCapability: result.host_capability, pageInstance: prepared.page_instance };
}

describe('cognition and expense IPC integration', () => {
  it('registers both modules, binds the active user, and keeps their calls isolated', async () => {
    const cognition = await import('../../../src/main/features/cognition');
    const expense = await import('../../../src/main/features/expense_workbench/adapter');

    const cognitionResult = await call('cognition.assets.list');
    expect(cognitionResult).toMatchObject({
      ok: true,
      assets: [expect.objectContaining({ id: 'cog-integration' })],
    });
    expect(cognition.listCognitionAssets).toHaveBeenCalledWith(TEST_UID);
    expect(expense.callExpenseWorkbench).not.toHaveBeenCalled();

    vi.mocked(cognition.listCognitionAssets).mockClear();
    const { hostCapability, pageInstance } = await openExpenseWorkbench();
    const expenseResult = await call('expenseWorkbench.invoke', {
      host_capability: hostCapability,
      page_instance: pageInstance,
      request_nonce: 'ewreq_integration_001',
      operation_scope: 'invoke:overview.stats',
      operation: 'overview.stats',
      payload: {},
    });
    expect(expenseResult).toMatchObject({ ok: true, applications: [] });
    expect(expense.callExpenseWorkbench).toHaveBeenCalledWith(
      TEST_UID,
      CANONICAL_EXPENSE_AGENT_ID,
      'overview.stats',
      {},
    );
    expect(cognition.listCognitionAssets).not.toHaveBeenCalled();
  });
});
