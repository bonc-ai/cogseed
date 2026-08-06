import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { isJsonObject, type JsonObject } from '../../../src/main/features/expense_workbench/contracts';

const fileOpenState = vi.hoisted(() => ({ beforeOpen: null as (() => void) | null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const beforeOpen = fileOpenState.beforeOpen;
      fileOpenState.beforeOpen = null;
      beforeOpen?.();
      return actual.open(...args);
    },
  };
});

const adapter = {
  callExpenseWorkbench: vi.fn(),
};

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ew-material-feature-'));
  fileOpenState.beforeOpen = null;
  adapter.callExpenseWorkbench.mockReset();
  vi.resetModules();
  vi.doMock('../../../src/main/features/expense_workbench/adapter', () => adapter);
});

function registerMaterialsSuccessfully(): void {
  let sequence = 0;
  let version = 0;
  adapter.callExpenseWorkbench.mockImplementation(async (
    _userId: string,
    _agentId: string,
    operation: string,
    payload: JsonObject,
  ): Promise<JsonObject> => {
    if (operation !== 'materials.addAndBind' || !isJsonObject(payload.material)) {
      throw new Error(`unexpected operation: ${operation}`);
    }
    const material = payload.material;
    if (typeof material.name !== 'string'
      || typeof material.media_type !== 'string'
      || typeof material.data_base64 !== 'string') {
      throw new Error('invalid test material payload');
    }
    const content = Buffer.from(material.data_base64, 'base64');
    sequence += 1;
    const expectedVersion = payload.expected_version;
    if (expectedVersion !== version || typeof payload.mutation_id !== 'string') {
      throw new Error('invalid atomic binding request');
    }
    version += 1;
    return {
      material: {
        ref: `workspace://mat-${sequence.toString(16).padStart(32, '0')}`,
        name: material.name,
        media_type: material.media_type,
        size: content.length,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        material_category: 'expense_receipt',
        },
      application: { application_id: 'APP-1', current_version: version },
      draft: { version },
    };
  });
}

afterEach(() => {
  vi.doUnmock('../../../src/main/features/expense_workbench/adapter');
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('expense workbench material import boundary', () => {
  it('reuses one host-generated mutation id when retrying an uncertain bridge response', async () => {
    const content = Buffer.from('%PDF-retry');
    const file = path.join(root, 'retry.pdf');
    fs.writeFileSync(file, content);
    let calls = 0;
    adapter.callExpenseWorkbench.mockImplementation(async (
      _userId: string, _agentId: string, operation: string, payload: JsonObject,
    ): Promise<JsonObject> => {
      expect(operation).toBe('materials.addAndBind');
      calls += 1;
      if (calls === 1) throw new Error('response lost after commit');
      return {
        material: {
          ref: `workspace://mat-${'a'.repeat(32)}`, name: 'retry.pdf', media_type: 'application/pdf',
          size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex'),
          material_category: 'expense_receipt',
        },
        application: { application_id: 'APP-1', current_version: 1 },
        draft: { version: 1 },
      };
    });
    const { addAndBindExpenseMaterialsFromPaths } = await import(
      '../../../src/main/features/expense_workbench/material-import'
    );

    const result = await addAndBindExpenseMaterialsFromPaths(
      'u-ipc', 'expense-agent', 'APP-1', [file],
      { application: {}, expectedVersion: 0 },
    );

    expect(result.materials).toHaveLength(1);
    expect(adapter.callExpenseWorkbench).toHaveBeenCalledTimes(2);
    expect(adapter.callExpenseWorkbench.mock.calls[0][3].mutation_id)
      .toBe(adapter.callExpenseWorkbench.mock.calls[1][3].mutation_id);
  });

  it('accepts the exact byte limit and rejects one byte over before registration', async () => {
    registerMaterialsSuccessfully();
    const { addAndBindExpenseMaterialsFromPaths, MAX_EXPENSE_MATERIAL_BYTES } = await import(
      '../../../src/main/features/expense_workbench/material-import'
    );
    const exact = path.join(root, 'exact.pdf');
    const oversized = path.join(root, 'oversized.pdf');
    fs.writeFileSync(exact, Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(MAX_EXPENSE_MATERIAL_BYTES - 4)]));
    fs.writeFileSync(oversized, Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(MAX_EXPENSE_MATERIAL_BYTES - 3)]));

    const result = await addAndBindExpenseMaterialsFromPaths(
      'u-ipc', 'expense-agent', 'APP-1', [exact, oversized],
      { application: { application: { application_id: 'APP-1', current_version: 0 } }, expectedVersion: 0 },
    );

    expect(result.materials).toHaveLength(1);
    expect(result.materials[0]).toEqual(expect.objectContaining({ name: 'exact.pdf', size: MAX_EXPENSE_MATERIAL_BYTES }));
    expect(result.failed).toContainEqual({ name: 'oversized.pdf', error: expect.stringContaining('176 KiB') });
    expect(adapter.callExpenseWorkbench).toHaveBeenCalledOnce();
    expect(adapter.callExpenseWorkbench).toHaveBeenCalledWith(
      'u-ipc', 'expense-agent', 'materials.addAndBind', expect.objectContaining({
        application_id: 'APP-1', expected_version: 0,
        mutation_id: expect.stringMatching(/^material-[0-9a-f]{32}$/),
      }),
    );
  });

  it('enforces the file-count limit before opening or registering any file', async () => {
    registerMaterialsSuccessfully();
    const { addAndBindExpenseMaterialsFromPaths, MAX_EXPENSE_MATERIAL_FILES } = await import(
      '../../../src/main/features/expense_workbench/material-import'
    );
    const accepted = Array.from({ length: MAX_EXPENSE_MATERIAL_FILES }, (_, index) => {
      const file = path.join(root, `receipt-${index}.pdf`);
      fs.writeFileSync(file, `%PDF-${index}`);
      return file;
    });

    const acceptedResult = await addAndBindExpenseMaterialsFromPaths(
      'u-ipc', 'expense-agent', 'APP-1', accepted,
      { application: { application: { application_id: 'APP-1', current_version: 0 } }, expectedVersion: 0 },
    );
    expect(acceptedResult.materials).toHaveLength(MAX_EXPENSE_MATERIAL_FILES);
    expect(acceptedResult.failed).toEqual([]);
    expect(adapter.callExpenseWorkbench).toHaveBeenCalledTimes(MAX_EXPENSE_MATERIAL_FILES);

    adapter.callExpenseWorkbench.mockClear();

    await expect(addAndBindExpenseMaterialsFromPaths(
      'u-ipc',
      'expense-agent',
      'APP-1',
      Array.from({ length: MAX_EXPENSE_MATERIAL_FILES + 1 }, (_, index) => path.join(root, `${index}.pdf`)),
      { application: { application: { application_id: 'APP-1', current_version: 20 } }, expectedVersion: 20 },
    )).rejects.toThrow('at most 20');
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('rejects symlinks before opening or registering their targets', async () => {
    const target = path.join(root, 'target.pdf');
    const link = path.join(root, 'linked.pdf');
    fs.writeFileSync(target, '%PDF-target');
    fs.symlinkSync(target, link);
    const { addAndBindExpenseMaterialsFromPaths } = await import(
      '../../../src/main/features/expense_workbench/material-import'
    );

    const result = await addAndBindExpenseMaterialsFromPaths(
      'u-ipc', 'expense-agent', 'APP-1', [link],
      { application: {}, expectedVersion: 0 },
    );

    expect(result.materials).toEqual([]);
    expect(result.failed).toEqual([{ name: 'linked.pdf', error: expect.stringContaining('Symbolic') }]);
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('rejects content whose magic bytes do not match its extension', async () => {
    const file = path.join(root, 'renamed.pdf');
    fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    const { addAndBindExpenseMaterialsFromPaths } = await import(
      '../../../src/main/features/expense_workbench/material-import'
    );

    const result = await addAndBindExpenseMaterialsFromPaths(
      'u-ipc', 'expense-agent', 'APP-1', [file],
      { application: {}, expectedVersion: 0 },
    );

    expect(result.materials).toEqual([]);
    expect(result.failed).toEqual([{ name: 'renamed.pdf', error: expect.stringContaining('do not match') }]);
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });

  it('rejects a file identity change between inspection and opening', async () => {
    const original = path.join(root, 'receipt.pdf');
    const replacement = path.join(root, 'replacement.pdf');
    fs.writeFileSync(original, '%PDF-original');
    fs.writeFileSync(replacement, '%PDF-replace!');
    fileOpenState.beforeOpen = () => fs.renameSync(replacement, original);
    const { addAndBindExpenseMaterialsFromPaths } = await import(
      '../../../src/main/features/expense_workbench/material-import'
    );

    const result = await addAndBindExpenseMaterialsFromPaths(
      'u-ipc', 'expense-agent', 'APP-1', [original],
      { application: {}, expectedVersion: 0 },
    );

    expect(result.materials).toEqual([]);
    expect(result.failed).toEqual([{ name: 'receipt.pdf', error: expect.stringContaining('changed') }]);
    expect(adapter.callExpenseWorkbench).not.toHaveBeenCalled();
  });
});
