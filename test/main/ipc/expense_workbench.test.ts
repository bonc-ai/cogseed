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

vi.mock('electron', () => ({
  dialog: electronDialog,
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
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

beforeEach(() => {
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
  vi.doMock('../../../src/main/features/expense_workbench/adapter', () => adapter);
  vi.doMock('../../../src/main/features/expense_workbench/submission', () => submission);
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
  it('binds status to the active user context', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const out = await invokeHandlers['expenseWorkbench.status']({}, { userId: 'u-ipc' });
    expect(out).toEqual({ configured: false, platform: 'posix' });
    expect(adapter.getExpenseProjectStatus).toHaveBeenCalledWith('u-ipc');
  });

  it('selects and configures the project entirely in the main process', async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/project'] });
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const out = await invokeHandlers['expenseWorkbench.pickAndConfigure'](
      { agent_id: 'ordinary-agent' },
      { userId: 'u-ipc' },
    );
    expect(out).toEqual({ cancelled: false, configured: true, project_name: 'expense', platform: 'posix' });
    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ properties: ['openDirectory'] }));
    expect(adapter.configureExpenseProject).toHaveBeenCalledWith('u-ipc', '/tmp/project', 'ordinary-agent');
  });

  it('cancels project configuration without exposing a selected path', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const out = await invokeHandlers['expenseWorkbench.pickAndConfigure'](
      { agent_id: 'expense-agent' },
      { userId: 'u-ipc' },
    );
    expect(out).toEqual({ cancelled: true, configured: false, platform: 'posix' });
    expect(adapter.configureExpenseProject).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain('path');
  });

  it('validates the operation before dispatching the bridge', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await expect(invokeHandlers['expenseWorkbench.invoke'](
      { agent_id: 'expense-agent', operation: 'legacy-command', payload: {} },
      { userId: 'u-ipc' },
    )).rejects.toThrow('invalid expense workbench operation');
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('passes only the active user, agent, operation, and object payload', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const out = await invokeHandlers['expenseWorkbench.invoke'](
      { agent_id: 'expense-agent', operation: 'overview.stats', payload: { limit: 10 } },
      { userId: 'u-ipc' },
    );
    expect(out).toEqual({ applications: [] });
    expect(adapter.callExpenseWorkbench).toHaveBeenCalledWith('u-ipc', 'expense-agent', 'overview.stats', { limit: 10 });
  });

  it('cancels material selection without reading or registering files', async () => {
    prepareMaterialTarget();
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const out = await invokeHandlers['expenseWorkbench.pickAndAddMaterials'](
      { agent_id: 'expense-agent', application_id: 'APP-1' },
      { userId: 'u-ipc' },
    );

    expect(out).toEqual({ cancelled: true, materials: [], failed: [] });
    expect(showOpenDialog).toHaveBeenCalledOnce();
    expect(adapter.callExpenseWorkbench).toHaveBeenCalledTimes(1);
    expect(adapter.callExpenseWorkbench).toHaveBeenCalledWith(
      'u-ipc', 'expense-agent', 'applications.get', { application_id: 'APP-1' },
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
      { agent_id: 'expense-agent', application_id: 'APP-1' },
      { userId: 'u-ipc' },
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
      'expense-agent',
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
      { agent_id: 'expense-agent', operation: 'applications.submit', payload: { application_id: 'APP-1' } },
      { userId: 'u-ipc' },
    )).rejects.toThrow('人工确认');
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('does not allow renderer-provided material bytes through the generic route', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await expect(invokeHandlers['expenseWorkbench.invoke'](
      {
        agent_id: 'expense-agent',
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
      },
      { userId: 'u-ipc' },
    )).rejects.toThrow('主进程专用选择入口');
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('does not allow renderer payloads to invoke atomic material binding directly', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await expect(invokeHandlers['expenseWorkbench.invoke'](
      {
        agent_id: 'expense-agent',
        operation: 'materials.addAndBind',
        payload: {
          application_id: 'APP-1', expected_version: 0, mutation_id: 'renderer-controlled',
          material: {
            name: 'receipt.pdf', media_type: 'application/pdf',
            data_base64: Buffer.from('%PDF-untrusted').toString('base64'),
            material_category: 'expense_receipt',
          },
        },
      },
      { userId: 'u-ipc' },
    )).rejects.toThrow('主进程专用选择入口');
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it.each([
    'applications.submitStatus',
    'applications.refreshStatus',
    'applications.recoverSubmission',
    'applications.retryFeishu',
    'applications.retryFeishuNotifications',
    'settings.preflight',
    'settings.test',
  ] as const)('blocks %s on the generic invoke route', async (operation) => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await expect(invokeHandlers['expenseWorkbench.invoke'](
      { agent_id: 'expense-agent', operation, payload: operation.startsWith('applications.') ? { application_id: 'APP-1' } : {} },
      { userId: 'u-ipc' },
    )).rejects.toThrow('显式确认入口');
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('does not allow personnel approval through the generic renderer route', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await expect(invokeHandlers['expenseWorkbench.invoke'](
      { agent_id: 'expense-agent', operation: 'applications.approve', payload: { application_id: 'APP-1' } },
      { userId: 'u-ipc' },
    )).rejects.toThrow('人工复核决策需要独立的身份与确认入口');
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('discloses the external target before a status query and dispatches only after consent', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await invokeHandlers['expenseWorkbench.invokeExternal'](
      { agent_id: 'expense-agent', operation: 'applications.submitStatus', payload: { application_id: 'APP-1' } },
      { userId: 'u-ipc' },
    );
    expect(showMessageBox).toHaveBeenCalledOnce();
    expect(showMessageBox.mock.calls[0][0]).toEqual(expect.objectContaining({
      defaultId: 0,
      cancelId: 0,
      message: expect.stringContaining('飞书 / OA'),
      detail: expect.stringContaining('APP-1'),
    }));
    expect(adapter.callExpenseWorkbench).toHaveBeenCalledWith(
      'u-ipc', 'expense-agent', 'applications.submitStatus', { application_id: 'APP-1' },
    );
  });

  it('does not dispatch an external request when the user cancels', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 });
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await expect(invokeHandlers['expenseWorkbench.invokeExternal'](
      { agent_id: 'expense-agent', operation: 'settings.preflight', payload: {} },
      { userId: 'u-ipc' },
    )).rejects.toThrow('用户已取消');
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it.each([
    ['applications.recoverSubmission', 'OA'],
    ['applications.retryFeishu', '飞书'],
    ['applications.retryFeishuNotifications', '飞书'],
  ] as const)('requires a second confirmation before %s', async (operation, target) => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await invokeHandlers['expenseWorkbench.invokeExternal'](
      { agent_id: 'expense-agent', operation, payload: { application_id: 'APP-1' } },
      { userId: 'u-ipc' },
    );
    expect(showMessageBox).toHaveBeenCalledTimes(2);
    expect(showMessageBox.mock.calls[0][0].message).toContain(target);
    expect(showMessageBox.mock.calls[1][0]).toEqual(expect.objectContaining({
      type: 'warning',
      title: '外部操作二次确认',
      defaultId: 0,
    }));
    expect(adapter.callExpenseWorkbench).toHaveBeenCalledWith(
      'u-ipc', 'expense-agent', operation, { application_id: 'APP-1' },
    );
  });

  it('fails closed when an external operation has no safe renderer entry', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    for (const operation of ['applications.refreshStatus', 'settings.test'] as const) {
      await expect(invokeHandlers['expenseWorkbench.invokeExternal'](
        { agent_id: 'expense-agent', operation, payload: operation.startsWith('applications.') ? { application_id: 'APP-1' } : {} },
        { userId: 'u-ipc' },
      )).rejects.toThrow('尚无安全界面入口');
    }
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('rejects extra renderer-controlled fields on external calls', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    await expect(invokeHandlers['expenseWorkbench.invokeExternal'](
      { agent_id: 'expense-agent', operation: 'applications.submitStatus', payload: { application_id: 'APP-1', force: true } },
      { userId: 'u-ipc' },
    )).rejects.toThrow('accepts only application_id');
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('fails closed without a native submission confirmation dialog', async () => {
    electronDialog.showMessageBox = undefined;
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');

    await expect(invokeHandlers['expenseWorkbench.confirmAndSubmit'](
      { agent_id: 'expense-agent', application_id: 'APP-1', version: 2, payload_hash: 'a'.repeat(64) },
      { userId: 'u-ipc' },
    )).rejects.toThrow('secure submission confirmation could not be displayed');
    expect(submission.confirmAndSubmitExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('does not submit when the user cancels the native confirmation', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 });
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');

    await expect(invokeHandlers['expenseWorkbench.confirmAndSubmit'](
      { agent_id: 'expense-agent', application_id: 'APP-1', version: 2, payload_hash: 'a'.repeat(64) },
      { userId: 'u-ipc' },
    )).rejects.toThrow('Submission was cancelled');
    expect(showMessageBox).toHaveBeenCalledOnce();
    expect(showMessageBox.mock.calls[0][0]).toEqual(expect.objectContaining({
      type: 'warning',
      defaultId: 0,
      cancelId: 0,
      buttons: ['Cancel', 'Submit to Feishu / OA'],
      message: expect.stringContaining('Feishu / OA'),
      detail: expect.stringMatching(/APP-1[\s\S]*v2[\s\S]*aaaaaaaaaaaa…aaaaaaaaaaaa[\s\S]*Human approval/),
    }));
    expect(submission.confirmAndSubmitExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('submits only after the native confirmation discloses the exact draft and external effects', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/expense_workbench');
    const out = await invokeHandlers['expenseWorkbench.confirmAndSubmit'](
      { agent_id: 'expense-agent', application_id: 'APP-1', version: 2, payload_hash: 'a'.repeat(64) },
      { userId: 'u-ipc' },
    );
    expect(out).toEqual(expect.objectContaining({ submitted: expect.objectContaining({ application: expect.objectContaining({ oa_status: 'submitted' }) }) }));
    expect(showMessageBox).toHaveBeenCalledOnce();
    const options = showMessageBox.mock.calls[0][0];
    expect(options).toEqual(expect.objectContaining({ defaultId: 0, cancelId: 0 }));
    expect(options.detail).toContain('External target: Feishu / OA');
    expect(options.detail).toContain('Expense application: APP-1');
    expect(options.detail).toContain('Version: v2');
    expect(options.detail).toContain('Payload fingerprint: aaaaaaaaaaaa…aaaaaaaaaaaa');
    expect(options.detail).toContain('does not approve the request or make a payment');
    expect(submission.confirmAndSubmitExpenseWorkbench).toHaveBeenCalledWith('u-ipc', {
      agentId: 'expense-agent', applicationId: 'APP-1', version: 2, payloadHash: 'a'.repeat(64),
    });
    expect(showMessageBox.mock.invocationCallOrder[0]).toBeLessThan(
      submission.confirmAndSubmitExpenseWorkbench.mock.invocationCallOrder[0],
    );
  });
});
