import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const showMessageBox = vi.fn(async () => ({ response: 1 }));
const showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] as string[] }));
const electronDialog: {
  showMessageBox?: typeof showMessageBox;
  showOpenDialog: typeof showOpenDialog;
} = { showMessageBox, showOpenDialog };

type HostHandler = (
  event: { sender: typeof ipcSender },
  request: unknown,
) => Promise<Record<string, unknown>>;

const authRuntime = vi.hoisted(() => ({
  activeUserId: 'u-ipc',
  assertCanonical: vi.fn(async (_userId: string, agentId: string) => {
    if (agentId !== 'c045605cb916') throw new Error('agent does not expose the canonical expense workbench');
    return { agent_id: agentId };
  }),
}));

let hostPrepareOpenHandler: HostHandler | null = null;
let hostOpenHandler: HostHandler | null = null;
const ipcSender = {
  getURL: () => 'file:///trusted-renderer/index.html',
  once: vi.fn(),
  on: vi.fn(),
};
const ownerWindow = {
  isDestroyed: vi.fn(() => false),
};

vi.mock('electron', () => ({
  dialog: electronDialog,
  ipcMain: {
    handle: vi.fn((channel: string, handler: HostHandler) => {
      if (channel === 'orkas.expenseWorkbenchHost.prepareOpen') hostPrepareOpenHandler = handler;
      if (channel === 'orkas.expenseWorkbenchHost.open') hostOpenHandler = handler;
    }),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => ownerWindow),
  },
}));

vi.mock('../../../src/main/features/users', () => ({
  getActiveUserId: () => authRuntime.activeUserId,
}));

vi.mock('../../../src/main/features/expense_workbench/canonical-agent', () => ({
  assertCanonicalExpenseWorkbenchAgent: authRuntime.assertCanonical,
}));

vi.mock('../../../src/main/ipc/security', () => ({
  isTrustedIpcSender: () => true,
}));

const adapter = {
  callExpenseWorkbench: vi.fn(async () => ({ applications: [] })),
  closeExpenseWorkbenchSessions: vi.fn(async () => undefined),
  configureExpenseProject: vi.fn(async () => ({ configured: true, project_name: 'expense', platform: 'posix' as const })),
  getExpenseProjectStatus: vi.fn(() => ({ configured: false, platform: 'posix' as const })),
};
const submission = {
  confirmAndSubmitExpenseWorkbench: vi.fn(async () => ({ submitted: { application: { oa_status: 'submitted' } } })),
};
let materialRoot: string;
let hostCapability = '';
let pageInstance = '';
let requestNonceCounter = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function requestContext(userId = authRuntime.activeUserId) {
  return { userId, sender: ipcSender as never };
}

function authorized<T extends Record<string, unknown>>(
  payload: T,
  operationScope: string,
  requestNonce = `ewreq_testnonce_${++requestNonceCounter}`,
): T & {
    host_capability: string;
    page_instance: string;
    request_nonce: string;
    operation_scope: string;
  } {
  return {
    host_capability: hostCapability,
    page_instance: pageInstance,
    request_nonce: requestNonce,
    operation_scope: operationScope,
    ...payload,
  };
}

beforeEach(async () => {
  materialRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ew-material-'));
  vi.resetModules();
  adapter.callExpenseWorkbench.mockClear();
  adapter.closeExpenseWorkbenchSessions.mockClear();
  adapter.configureExpenseProject.mockClear();
  adapter.getExpenseProjectStatus.mockClear();
  submission.confirmAndSubmitExpenseWorkbench.mockClear();
  showMessageBox.mockReset();
  showMessageBox.mockResolvedValue({ response: 1 });
  showOpenDialog.mockReset();
  showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
  electronDialog.showMessageBox = showMessageBox;
  authRuntime.activeUserId = 'u-ipc';
  authRuntime.assertCanonical.mockClear();
  hostPrepareOpenHandler = null;
  hostOpenHandler = null;
  hostCapability = '';
  pageInstance = '';
  requestNonceCounter = 0;
  ipcSender.once.mockClear();
  ipcSender.on.mockClear();
  ownerWindow.isDestroyed.mockReturnValue(false);
  vi.doMock('../../../src/main/features/expense_workbench/adapter', () => adapter);
  vi.doMock('../../../src/main/features/expense_workbench/submission', () => submission);
  const expenseIpc = await import('../../../src/main/ipc/expense_workbench');
  expenseIpc.registerExpenseWorkbenchHostIpc();
  if (!hostPrepareOpenHandler || !hostOpenHandler) {
    throw new Error('expense workbench host IPC was not registered');
  }
  const prepared = await hostPrepareOpenHandler(
    { sender: ipcSender },
    { agent_id: 'c045605cb916', gesture: 'agent_detail' },
  );
  if (prepared.ok !== true
      || typeof prepared.open_ticket !== 'string'
      || typeof prepared.page_instance !== 'string') {
    throw new Error(`failed to issue test open ticket: ${String(prepared.error || '')}`);
  }
  const opened = await hostOpenHandler(
    { sender: ipcSender },
    { open_ticket: prepared.open_ticket, page_instance: prepared.page_instance },
  );
  if (opened.ok !== true || typeof opened.host_capability !== 'string') {
    throw new Error(`failed to issue test host capability: ${String(opened.error || '')}`);
  }
  hostCapability = opened.host_capability;
  pageInstance = prepared.page_instance;
});

afterEach(() => {
  vi.doUnmock('../../../src/main/features/expense_workbench/adapter');
  vi.doUnmock('../../../src/main/features/expense_workbench/submission');
  fs.rmSync(materialRoot, { recursive: true, force: true });
});

function materialResponse(name: string, content: Buffer, mediaType: string) {
  return {
    material: {
      ref: `workspace://mat-${'a'.repeat(32)}`,
      name,
      media_type: mediaType,
      size: content.length,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      material_category: 'expense_receipt',
    },
  };
}

function prepareMaterialTarget(): void {
  adapter.callExpenseWorkbench.mockImplementation(async (_userId, _agentId, operation, payload) => {
    if (operation === 'applications.get') {
      return {
        application: { application_id: payload.application_id, current_version: 0 },
        draft: { version: 0 },
      };
    }
    if (operation === 'materials.addAndBind') {
      const material = payload.material as Record<string, string>;
      const content = Buffer.from(material.data_base64, 'base64');
      return {
        ...materialResponse(material.name, content, material.media_type),
        application: { application_id: payload.application_id, current_version: 1 },
        draft: { version: 1 },
      };
    }
    return { applications: [] };
  });
}

describe('expense workbench IPC', () => {
  it('rejects host opening without a prepared one-use ticket', async () => {
    if (!hostOpenHandler) throw new Error('expense workbench host-open IPC was not registered');
    const result = await hostOpenHandler(
      { sender: ipcSender },
      {
        open_ticket: `ewopen_${'a'.repeat(43)}`,
        page_instance: `ewpage_${'b'.repeat(43)}`,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'E_EXPENSE_WORKBENCH_CAPABILITY',
    });
  });

  it('consumes an open ticket exactly once', async () => {
    if (!hostPrepareOpenHandler || !hostOpenHandler) {
      throw new Error('expense workbench host IPC was not registered');
    }
    const prepared = await hostPrepareOpenHandler(
      { sender: ipcSender },
      { agent_id: 'c045605cb916', gesture: 'agent_card' },
    );
    const request = {
      open_ticket: prepared.open_ticket,
      page_instance: prepared.page_instance,
    };

    await expect(hostOpenHandler({ sender: ipcSender }, request)).resolves.toMatchObject({ ok: true });
    await expect(hostOpenHandler({ sender: ipcSender }, request)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('already used'),
    });
  });

  it('does not issue a capability when navigation starts during open validation', async () => {
    if (!hostPrepareOpenHandler || !hostOpenHandler) {
      throw new Error('expense workbench host IPC was not registered');
    }
    const prepared = await hostPrepareOpenHandler(
      { sender: ipcSender },
      { agent_id: 'c045605cb916', gesture: 'agent_detail' },
    );
    const validation = deferred<void>();
    const callsBeforeOpen = authRuntime.assertCanonical.mock.calls.length;
    authRuntime.assertCanonical.mockImplementationOnce(async () => {
      await validation.promise;
      return { agent_id: 'c045605cb916' };
    });
    const opening = hostOpenHandler(
      { sender: ipcSender },
      { open_ticket: prepared.open_ticket, page_instance: prepared.page_instance },
    );
    await vi.waitFor(() => {
      expect(authRuntime.assertCanonical).toHaveBeenCalledTimes(callsBeforeOpen + 1);
    });
    const navigationListener = ipcSender.on.mock.calls.find(
      ([eventName]) => eventName === 'did-start-navigation',
    )?.[1] as ((event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void) | undefined;
    if (!navigationListener) throw new Error('renderer navigation cleanup listener was not bound');
    navigationListener({}, 'file:///trusted-renderer/next.html', false, true);
    validation.resolve();

    await expect(opening).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('revoked during validation'),
    });
  });

  it('consumes and rejects an open ticket presented by another renderer', async () => {
    if (!hostPrepareOpenHandler || !hostOpenHandler) {
      throw new Error('expense workbench host IPC was not registered');
    }
    const prepared = await hostPrepareOpenHandler(
      { sender: ipcSender },
      { agent_id: 'c045605cb916', gesture: 'agent_detail' },
    );
    const otherSender = { ...ipcSender, getURL: () => 'file:///trusted-renderer/other.html' };
    const result = await hostOpenHandler(
      { sender: otherSender },
      { open_ticket: prepared.open_ticket, page_instance: prepared.page_instance },
    );

    expect(result).toMatchObject({ ok: false, code: 'E_EXPENSE_WORKBENCH_CAPABILITY' });
    await expect(hostOpenHandler(
      { sender: ipcSender },
      { open_ticket: prepared.open_ticket, page_instance: prepared.page_instance },
    )).resolves.toMatchObject({ ok: false });
  });

  it('consumes and rejects an open ticket with the wrong page instance', async () => {
    if (!hostPrepareOpenHandler || !hostOpenHandler) {
      throw new Error('expense workbench host IPC was not registered');
    }
    const prepared = await hostPrepareOpenHandler(
      { sender: ipcSender },
      { agent_id: 'c045605cb916', gesture: 'agent_detail' },
    );
    const result = await hostOpenHandler(
      { sender: ipcSender },
      {
        open_ticket: prepared.open_ticket,
        page_instance: `ewpage_${'x'.repeat(43)}`,
      },
    );

    expect(result).toMatchObject({ ok: false, code: 'E_EXPENSE_WORKBENCH_CAPABILITY' });
    await expect(hostOpenHandler(
      { sender: ipcSender },
      { open_ticket: prepared.open_ticket, page_instance: prepared.page_instance },
    )).resolves.toMatchObject({ ok: false });
  });

  it('consumes and rejects an open ticket after the active user changes', async () => {
    if (!hostPrepareOpenHandler || !hostOpenHandler) {
      throw new Error('expense workbench host IPC was not registered');
    }
    const prepared = await hostPrepareOpenHandler(
      { sender: ipcSender },
      { agent_id: 'c045605cb916', gesture: 'agent_detail' },
    );
    authRuntime.activeUserId = 'u-other';
    const result = await hostOpenHandler(
      { sender: ipcSender },
      { open_ticket: prepared.open_ticket, page_instance: prepared.page_instance },
    );

    expect(result).toMatchObject({ ok: false, code: 'E_EXPENSE_WORKBENCH_CAPABILITY' });
    expect(result.error).toContain('another user');
  });

  it('rejects direct generic IPC use without a host-issued management capability', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');

    await expect(invokeHandlers['expenseWorkbench.invoke'](
      { operation: 'overview.stats', payload: {} },
      requestContext(),
    )).rejects.toMatchObject({ code: 'E_EXPENSE_WORKBENCH_CAPABILITY' });
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('rejects a capability replayed by a different renderer sender', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const otherSender = { ...ipcSender, getURL: () => 'file:///trusted-renderer/index.html' };

    await expect(invokeHandlers['expenseWorkbench.status'](
      authorized({}, 'status'),
      { userId: 'u-ipc', sender: otherSender as never },
    )).rejects.toMatchObject({ code: 'E_EXPENSE_WORKBENCH_CAPABILITY' });
    expect(adapter.getExpenseProjectStatus).not.toHaveBeenCalled();
  });

  it('rejects reuse of a request nonce within one capability', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const request = authorized({}, 'status', 'ewreq_replay_nonce_001');

    await expect(invokeHandlers['expenseWorkbench.status'](
      request,
      requestContext(),
    )).resolves.toEqual({ configured: false, platform: 'posix' });
    await expect(invokeHandlers['expenseWorkbench.status'](
      request,
      requestContext(),
    )).rejects.toThrow('already been used');
  });

  it('does not dispatch a request revoked by navigation during Agent validation', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const validation = deferred<void>();
    const callsBeforeRequest = authRuntime.assertCanonical.mock.calls.length;
    authRuntime.assertCanonical.mockImplementationOnce(async () => {
      await validation.promise;
      return { agent_id: 'c045605cb916' };
    });
    const request = invokeHandlers['expenseWorkbench.status'](
      authorized({}, 'status'),
      requestContext(),
    );
    await vi.waitFor(() => {
      expect(authRuntime.assertCanonical).toHaveBeenCalledTimes(callsBeforeRequest + 1);
    });
    const navigationListener = ipcSender.on.mock.calls.find(
      ([eventName]) => eventName === 'did-start-navigation',
    )?.[1] as ((event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void) | undefined;
    if (!navigationListener) throw new Error('renderer navigation cleanup listener was not bound');
    navigationListener({}, 'file:///trusted-renderer/next.html', false, true);
    validation.resolve();

    await expect(request).rejects.toThrow('invalid or revoked');
    expect(adapter.getExpenseProjectStatus).not.toHaveBeenCalled();
  });

  it('rejects an operation scope that does not match the requested handler', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');

    await expect(invokeHandlers['expenseWorkbench.status'](
      authorized({}, 'configure'),
      requestContext(),
    )).rejects.toThrow('scope does not match');
    expect(adapter.getExpenseProjectStatus).not.toHaveBeenCalled();
  });

  it('uses a fixed capability expiry that successful requests do not extend', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const issuedAtUpperBound = Date.now();
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(issuedAtUpperBound + (9 * 60 * 1000));
      await expect(invokeHandlers['expenseWorkbench.status'](
        authorized({}, 'status'),
        requestContext(),
      )).resolves.toEqual({ configured: false, platform: 'posix' });

      now.mockReturnValue(issuedAtUpperBound + (10 * 60 * 1000) + 1);
      await expect(invokeHandlers['expenseWorkbench.status'](
        authorized({}, 'status'),
        requestContext(),
      )).rejects.toThrow('has expired');
      expect(adapter.closeExpenseWorkbenchSessions).toHaveBeenCalledWith('u-ipc');
    } finally {
      now.mockRestore();
    }
  });

  it('revokes the old user capability and closes its sessions after an account switch', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    authRuntime.activeUserId = 'u-other';

    await expect(invokeHandlers['expenseWorkbench.status'](
      authorized({}, 'status'),
      requestContext('u-other'),
    )).rejects.toThrow('different active user');
    expect(adapter.closeExpenseWorkbenchSessions).toHaveBeenCalledWith('u-ipc');
    await expect(invokeHandlers['expenseWorkbench.status'](
      authorized({}, 'status'),
      requestContext('u-other'),
    )).rejects.toThrow('invalid or revoked');
  });

  it('binds host opening to the fixed builtin management Agent', async () => {
    if (!hostPrepareOpenHandler) throw new Error('expense workbench host IPC was not registered');
    const result = await hostPrepareOpenHandler(
      { sender: ipcSender },
      { agent_id: 'ordinary-agent', gesture: 'agent_detail' },
    );

    expect(result).toMatchObject({ ok: false });
    expect(authRuntime.assertCanonical).toHaveBeenLastCalledWith('u-ipc', 'ordinary-agent');
  });

  it('binds status to the active user context', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const out = await invokeHandlers['expenseWorkbench.status'](
      authorized({}, 'status'),
      requestContext(),
    );
    expect(out).toEqual({ configured: false, platform: 'posix' });
    expect(adapter.getExpenseProjectStatus).toHaveBeenCalledWith('u-ipc');
  });

  it('selects and configures the project entirely in the main process', async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/project'] });
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const out = await invokeHandlers['expenseWorkbench.pickAndConfigure'](
      authorized({}, 'configure'),
      requestContext(),
    );
    expect(out).toEqual({ cancelled: false, configured: true, project_name: 'expense', platform: 'posix' });
    expect(showOpenDialog).toHaveBeenCalledWith(
      ownerWindow,
      expect.objectContaining({ properties: ['openDirectory'] }),
    );
    expect(adapter.configureExpenseProject).toHaveBeenCalledWith('u-ipc', '/tmp/project', 'c045605cb916');
  });

  it('cancels project configuration without exposing a selected path', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const out = await invokeHandlers['expenseWorkbench.pickAndConfigure'](
      authorized({}, 'configure'),
      requestContext(),
    );
    expect(out).toEqual({ cancelled: true, configured: false, platform: 'posix' });
    expect(adapter.configureExpenseProject).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain('path');
  });

  it('validates the operation before dispatching the bridge', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await expect(invokeHandlers['expenseWorkbench.invoke'](
      authorized({ operation: 'legacy-command', payload: {} }, 'invoke:legacy-command'),
      requestContext(),
    )).rejects.toThrow('invalid expense workbench operation');
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('passes only the active user, agent, operation, and object payload', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const out = await invokeHandlers['expenseWorkbench.invoke'](
      authorized(
        { operation: 'overview.stats', payload: { limit: 10 } },
        'invoke:overview.stats',
      ),
      requestContext(),
    );
    expect(out).toEqual({ applications: [] });
    expect(adapter.callExpenseWorkbench).toHaveBeenCalledWith('u-ipc', 'c045605cb916', 'overview.stats', { limit: 10 });
  });

  it('cancels material selection without reading or registering files', async () => {
    prepareMaterialTarget();
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const out = await invokeHandlers['expenseWorkbench.pickAndAddMaterials'](
      authorized({ application_id: 'APP-1' }, 'materials:add:APP-1'),
      requestContext(),
    );

    expect(out).toEqual({ cancelled: true, materials: [], failed: [] });
    expect(showOpenDialog).toHaveBeenCalledOnce();
    expect(adapter.callExpenseWorkbench).toHaveBeenCalledTimes(1);
    expect(adapter.callExpenseWorkbench).toHaveBeenCalledWith(
      'u-ipc', 'c045605cb916', 'applications.get', { application_id: 'APP-1' },
    );
  });

  it('registers a bounded material and returns no path or original bytes', async () => {
    prepareMaterialTarget();
    const content = Buffer.from('%PDF-1.7\nreceipt');
    const filePath = path.join(materialRoot, 'receipt.pdf');
    fs.writeFileSync(filePath, content);
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [filePath] });
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const out = await invokeHandlers['expenseWorkbench.pickAndAddMaterials'](
      authorized({ application_id: 'APP-1' }, 'materials:add:APP-1'),
      requestContext(),
    );

    expect(out).toEqual({
      cancelled: false,
      materials: [materialResponse('receipt.pdf', content, 'application/pdf').material],
      failed: [],
      application: {
        ...materialResponse('receipt.pdf', content, 'application/pdf'),
        application: { application_id: 'APP-1', current_version: 1 },
        draft: { version: 1 },
      },
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(materialRoot);
    expect(serialized).not.toContain(content.toString('base64'));
    expect(adapter.callExpenseWorkbench).toHaveBeenLastCalledWith(
      'u-ipc',
      'c045605cb916',
      'materials.addAndBind',
      expect.objectContaining({
        application_id: 'APP-1',
        expected_version: 0,
        mutation_id: expect.stringMatching(/^material-[0-9a-f]{32}$/),
        material: {
          name: 'receipt.pdf',
          media_type: 'application/pdf',
          data_base64: content.toString('base64'),
          material_category: 'expense_receipt',
        },
      }),
    );
  });

  it('does not allow renderer payloads to invoke confirmation or submission directly', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await expect(invokeHandlers['expenseWorkbench.invoke'](
      authorized(
        { operation: 'applications.submit', payload: { application_id: 'APP-1' } },
        'invoke:applications.submit',
      ),
      requestContext(),
    )).rejects.toThrow('人工确认');
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('does not allow renderer-provided material bytes through the generic route', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await expect(invokeHandlers['expenseWorkbench.invoke'](
      authorized({
        operation: 'materials.add',
        payload: {
          application_id: 'APP-1',
          material: {
            name: 'receipt.pdf',
            media_type: 'application/pdf',
            data_base64: Buffer.from('%PDF-untrusted').toString('base64'),
            material_category: 'expense_receipt',
          },
        },
      }, 'invoke:materials.add'),
      requestContext(),
    )).rejects.toThrow('主进程专用选择入口');
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('does not allow renderer payloads to invoke atomic material binding directly', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await expect(invokeHandlers['expenseWorkbench.invoke'](
      authorized({
        operation: 'materials.addAndBind',
        payload: {
          application_id: 'APP-1', expected_version: 0, mutation_id: 'renderer-controlled',
          material: {
            name: 'receipt.pdf', media_type: 'application/pdf',
            data_base64: Buffer.from('%PDF-untrusted').toString('base64'),
            material_category: 'expense_receipt',
          },
        },
      }, 'invoke:materials.addAndBind'),
      requestContext(),
    )).rejects.toThrow('主进程专用选择入口');
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it.each([
    'applications.submitStatus',
    'applications.refreshStatus',
    'applications.recoverSubmission',
    'applications.retryFeishu',
    'settings.preflight',
    'settings.test',
  ] as const)('blocks %s on the generic invoke route', async (operation) => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await expect(invokeHandlers['expenseWorkbench.invoke'](
      authorized(
        { operation, payload: operation.startsWith('applications.') ? { application_id: 'APP-1' } : {} },
        `invoke:${operation}`,
      ),
      requestContext(),
    )).rejects.toThrow('显式确认入口');
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('discloses the external target before a status query and dispatches only after consent', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await invokeHandlers['expenseWorkbench.invokeExternal'](
      authorized(
        { operation: 'applications.submitStatus', payload: { application_id: 'APP-1' } },
        'external:applications.submitStatus',
      ),
      requestContext(),
    );
    expect(showMessageBox).toHaveBeenCalledOnce();
    expect(showMessageBox.mock.calls[0][1]).toEqual(expect.objectContaining({
      defaultId: 0,
      cancelId: 0,
      message: expect.stringContaining('飞书 / OA'),
      detail: expect.stringContaining('APP-1'),
    }));
    expect(adapter.callExpenseWorkbench).toHaveBeenCalledWith(
      'u-ipc', 'c045605cb916', 'applications.submitStatus', { application_id: 'APP-1' },
    );
  });

  it('does not dispatch an external request when the user cancels', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 });
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await expect(invokeHandlers['expenseWorkbench.invokeExternal'](
      authorized(
        { operation: 'settings.preflight', payload: {} },
        'external:settings.preflight',
      ),
      requestContext(),
    )).rejects.toThrow('用户已取消');
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it.each([
    ['applications.recoverSubmission', 'OA'],
    ['applications.retryFeishu', '飞书'],
  ] as const)('requires a second confirmation before %s', async (operation, target) => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await invokeHandlers['expenseWorkbench.invokeExternal'](
      authorized(
        { operation, payload: { application_id: 'APP-1' } },
        `external:${operation}`,
      ),
      requestContext(),
    );
    expect(showMessageBox).toHaveBeenCalledTimes(2);
    expect(showMessageBox.mock.calls[0][1].message).toContain(target);
    expect(showMessageBox.mock.calls[1][1]).toEqual(expect.objectContaining({
      type: 'warning',
      title: '外部操作二次确认',
      defaultId: 0,
    }));
    expect(adapter.callExpenseWorkbench).toHaveBeenCalledWith(
      'u-ipc', 'c045605cb916', operation, { application_id: 'APP-1' },
    );
  });

  it('fails closed when an external operation has no safe renderer entry', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    for (const operation of ['applications.refreshStatus', 'settings.test'] as const) {
      await expect(invokeHandlers['expenseWorkbench.invokeExternal'](
        authorized(
          { operation, payload: operation.startsWith('applications.') ? { application_id: 'APP-1' } : {} },
          `external:${operation}`,
        ),
        requestContext(),
      )).rejects.toThrow('尚无安全界面入口');
    }
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('rejects extra renderer-controlled fields on external calls', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await expect(invokeHandlers['expenseWorkbench.invokeExternal'](
      authorized(
        { operation: 'applications.submitStatus', payload: { application_id: 'APP-1', force: true } },
        'external:applications.submitStatus',
      ),
      requestContext(),
    )).rejects.toThrow('accepts only application_id');
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('fails closed without a native submission confirmation dialog', async () => {
    electronDialog.showMessageBox = undefined;
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');

    await expect(invokeHandlers['expenseWorkbench.confirmAndSubmit'](
      authorized(
        { application_id: 'APP-1', version: 2, payload_hash: 'a'.repeat(64) },
        `submit:APP-1:2:${'a'.repeat(64)}`,
      ),
      requestContext(),
    )).rejects.toThrow('secure submission confirmation could not be displayed');
    expect(submission.confirmAndSubmitExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('does not submit when the user cancels the native confirmation', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 });
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');

    await expect(invokeHandlers['expenseWorkbench.confirmAndSubmit'](
      authorized(
        { application_id: 'APP-1', version: 2, payload_hash: 'a'.repeat(64) },
        `submit:APP-1:2:${'a'.repeat(64)}`,
      ),
      requestContext(),
    )).rejects.toThrow('Submission was cancelled');
    expect(showMessageBox).toHaveBeenCalledOnce();
    expect(showMessageBox.mock.calls[0][1]).toEqual(expect.objectContaining({
      type: 'warning',
      defaultId: 0,
      cancelId: 0,
      buttons: ['Cancel', 'Submit to Feishu / OA'],
      message: expect.stringContaining('Feishu / OA'),
      detail: expect.stringMatching(/APP-1[\s\S]*v2[\s\S]*aaaaaaaaaaaa…aaaaaaaaaaaa[\s\S]*Human approval/),
    }));
    expect(submission.confirmAndSubmitExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('does not submit when the active user changes during native confirmation', async () => {
    const confirmation = deferred<{ response: number }>();
    showMessageBox.mockImplementationOnce(() => confirmation.promise);
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const submitting = invokeHandlers['expenseWorkbench.confirmAndSubmit'](
      authorized(
        { application_id: 'APP-1', version: 2, payload_hash: 'a'.repeat(64) },
        `submit:APP-1:2:${'a'.repeat(64)}`,
      ),
      requestContext(),
    );
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledOnce());
    authRuntime.activeUserId = 'u-other';
    confirmation.resolve({ response: 1 });

    await expect(submitting).rejects.toThrow('different active user');
    expect(submission.confirmAndSubmitExpenseWorkbench).not.toHaveBeenCalled();
    expect(adapter.closeExpenseWorkbenchSessions).toHaveBeenCalledWith('u-ipc');
  });

  it('submits only after the native confirmation discloses the exact draft and external effects', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const out = await invokeHandlers['expenseWorkbench.confirmAndSubmit'](
      authorized(
        { application_id: 'APP-1', version: 2, payload_hash: 'a'.repeat(64) },
        `submit:APP-1:2:${'a'.repeat(64)}`,
      ),
      requestContext(),
    );
    expect(out).toEqual(expect.objectContaining({ submitted: expect.objectContaining({ application: expect.objectContaining({ oa_status: 'submitted' }) }) }));
    expect(showMessageBox).toHaveBeenCalledOnce();
    const options = showMessageBox.mock.calls[0][1];
    expect(options).toEqual(expect.objectContaining({ defaultId: 0, cancelId: 0 }));
    expect(options.detail).toContain('External target: Feishu / OA');
    expect(options.detail).toContain('Expense application: APP-1');
    expect(options.detail).toContain('Version: v2');
    expect(options.detail).toContain('Payload fingerprint: aaaaaaaaaaaa…aaaaaaaaaaaa');
    expect(options.detail).toContain('does not approve the request or make a payment');
    expect(submission.confirmAndSubmitExpenseWorkbench).toHaveBeenCalledWith('u-ipc', {
      agentId: 'c045605cb916', applicationId: 'APP-1', version: 2, payloadHash: 'a'.repeat(64),
    });
    expect(showMessageBox.mock.invocationCallOrder[0]).toBeLessThan(
      submission.confirmAndSubmitExpenseWorkbench.mock.invocationCallOrder[0],
    );
  });
});
