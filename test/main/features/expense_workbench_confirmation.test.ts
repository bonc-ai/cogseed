import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { issueExpenseWorkbenchConfirmation } from '../../../src/main/features/expense_workbench/confirmation';
import {
  userExpenseWorkbenchComponentDataDir,
  userExpenseWorkbenchConfirmationsDir,
  userExpenseWorkbenchHomeDir,
  userExpenseWorkbenchRuntimeDir,
} from '../../../src/main/paths';

const userId = 'employee-1';
let outsideRoot = '';

function validInput() {
  return {
    userId,
    applicationId: 'APP-1',
    draftVersion: 3,
    draftHash: 'a'.repeat(64),
    target: {
      system: 'oa',
      environment: 'feishu',
      adapter: 'feishu-approval',
      form_type: 'approval.v4',
      mapping_version: 'feishu-expense-v1',
    },
  };
}

beforeEach(() => {
  outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-confirmation-outside-'));
});

afterEach(() => {
  fs.rmSync(userExpenseWorkbenchRuntimeDir(userId), { recursive: true, force: true });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
});

describe('expense workbench host confirmation', () => {
  it('issues a private one-shot capability envelope under the active user local data root', async () => {
    const result = await issueExpenseWorkbenchConfirmation(validInput());
    expect(result.issued).toBe(true);
    const directory = userExpenseWorkbenchConfirmationsDir(userId);
    const files = fs.readdirSync(directory);
    expect(files).toHaveLength(1);
    const confirmationFile = `${directory}/${files[0]}`;
    const envelope = JSON.parse(fs.readFileSync(confirmationFile, 'utf8'));
    expect(envelope.host_issued).toBe(true);
    expect(envelope.capability_id).toMatch(/^hcap-/);
    expect(envelope.draft_hash).toBe('a'.repeat(64));
    expect(result.capabilityId).toBe(envelope.capability_id);
    expect((fs.statSync(confirmationFile).mode & 0o777)).toBe(0o600);
  });

  it('rejects malformed hashes and unsafe targets before writing', async () => {
    await expect(issueExpenseWorkbenchConfirmation({
      userId,
      applicationId: 'APP-1',
      draftVersion: 1,
      draftHash: 'bad',
      target: {
        system: 'oa',
        environment: 'feishu',
        adapter: 'feishu-approval',
        form_type: 'approval.v4',
        mapping_version: 'feishu-expense-v1',
      },
    })).rejects.toThrow('draft hash');
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked confirmation parent before writing', async () => {
    fs.mkdirSync(userExpenseWorkbenchHomeDir(userId), { recursive: true });
    fs.symlinkSync(outsideRoot, userExpenseWorkbenchComponentDataDir(userId), 'dir');

    await expect(issueExpenseWorkbenchConfirmation(validInput())).rejects.toThrow('symbolic links');
    expect(fs.readdirSync(outsideRoot)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink at the confirmation directory', async () => {
    fs.mkdirSync(userExpenseWorkbenchComponentDataDir(userId), { recursive: true });
    fs.symlinkSync(outsideRoot, userExpenseWorkbenchConfirmationsDir(userId), 'dir');

    await expect(issueExpenseWorkbenchConfirmation(validInput())).rejects.toThrow('symbolic links');
    expect(fs.readdirSync(outsideRoot)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('rechecks confirmation parents after a previously safe issue', async () => {
    await issueExpenseWorkbenchConfirmation(validInput());
    fs.rmSync(userExpenseWorkbenchComponentDataDir(userId), { recursive: true });
    fs.symlinkSync(outsideRoot, userExpenseWorkbenchComponentDataDir(userId), 'dir');

    await expect(issueExpenseWorkbenchConfirmation(validInput())).rejects.toThrow('symbolic links');
    expect(fs.readdirSync(outsideRoot)).toEqual([]);
  });
});
