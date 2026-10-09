import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER_ID = 'expense-user-1';
const CID = 'expense-conversation-1';
const OTHER_CID = 'expense-conversation-2';
const APP_SECRET = 'app-secret-must-never-reach-chat';

let workspaceRoot: string;
let previousWorkspaceRoot: string | undefined;
const fetchMock = vi.fn();

const configuration = {
  api_base_url: 'https://open.feishu.cn',
  app_id: 'cli_expense_agent',
  app_secret: APP_SECRET,
  approval_code: 'expense_approval',
  applicant_open_id: 'ou_applicant_1',
  approval_node_label: 'Finance review',
  approval_form_template: JSON.stringify([{ id: 'title', value: '{{title}}' }]),
  notification_receiver_type: 'open_id' as const,
  notification_receiver_id: 'ou_receiver_1',
};

const caseInput = {
  title: 'Client visit meals',
  expense_type: 'meals',
  amount: 128.5,
  currency: 'CNY',
  merchant: 'Example Restaurant',
  expense_date: new Date().toISOString().slice(0, 10),
  description: 'Meals during the client visit.',
};

function feishuResponse(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ code: 0, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installSuccessfulFeishuMock(): void {
  fetchMock.mockImplementation(async (url: string | URL) => {
    const value = String(url);
    if (value.endsWith('/open-apis/auth/v3/app_access_token/internal')) {
      return feishuResponse({ app_access_token: 'redacted-token' });
    }
    if (value.includes('/open-apis/approval/v4/approvals/')) {
      return feishuResponse({ approval_name: 'Expense approval' });
    }
    throw new Error(`unexpected Feishu request: ${value}`);
  });
}

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-expense-agent-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = workspaceRoot;
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  installSuccessfulFeishuMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

async function configureReadyAgent() {
  const expenseAgent = await import('../../../src/main/features/expense_workbench/expense-agent');
  await expect(expenseAgent.saveAndValidateExpenseConfiguration(USER_ID, configuration)).resolves.toMatchObject({
    state: 'ready', configured: true, ready: true,
  });
  return expenseAgent;
}

async function attachReceipt(cid = CID): Promise<void> {
  const attachments = await import('../../../src/main/features/chat_attachments');
  const result = await attachments.uploadAttachment(USER_ID, cid, 'receipt.txt', Buffer.from('receipt', 'utf8'));
  expect(result.ok).toBe(true);
}

describe('expense agent configuration and cases', () => {
  it('encrypts the app secret locally and reports only redacted configuration status', async () => {
    const expenseAgent = await configureReadyAgent();
    const paths = await import('../../../src/main/paths');
    const storedText = fs.readFileSync(paths.userExpenseAgentConfigFile(USER_ID), 'utf8');
    const stored = JSON.parse(storedText) as { secret_enc?: string };

    expect(storedText).not.toContain(APP_SECRET);
    expect(stored.secret_enc).toBeTruthy();
    expect(stored.secret_enc).not.toContain(APP_SECRET);
    await expect(expenseAgent.getExpenseConfigurationStatus(USER_ID)).resolves.toEqual(expect.objectContaining({
      ready: true,
      app_id_suffix: '***gent',
      notification_receiver_id_suffix: '***er_1',
    }));
  });

  it('marks the retired local-project configuration as unusable without reading it', async () => {
    const paths = await import('../../../src/main/paths');
    fs.mkdirSync(path.dirname(paths.userLegacyExpenseWorkbenchConfigFile(USER_ID)), { recursive: true });
    fs.writeFileSync(paths.userLegacyExpenseWorkbenchConfigFile(USER_ID), JSON.stringify({ project_root: '/private/legacy' }));

    const expenseAgent = await import('../../../src/main/features/expense_workbench/expense-agent');
    await expect(expenseAgent.getExpenseConfigurationStatus(USER_ID)).resolves.toEqual({
      state: 'unconfigured',
      configured: false,
      ready: false,
      legacy_local_configuration_detected: true,
      error_code: 'legacy_local_configuration_not_supported',
    });
  });

  it('binds materials to the current conversation and rejects a stale confirmation or retry after an uncertain submission', async () => {
    const expenseAgent = await configureReadyAgent();
    await attachReceipt();
    await attachReceipt(OTHER_CID);

    const created = await expenseAgent.precheckExpenseCase(USER_ID, CID, caseInput);
    expect(created).toMatchObject({ status: 'ready_to_submit', material_count: 1, precheck_status: 'ready' });
    await expect(expenseAgent.getExpenseCase(USER_ID, OTHER_CID, created.case_id)).rejects.toThrow('expense_case_not_found');
    await expect(expenseAgent.precheckExpenseCase(USER_ID, CID, {
      ...caseInput,
      attachment_names: ['receipt.txt', 'other-receipt.txt'],
    })).rejects.toThrow('an attachment is unavailable');

    const revised = await expenseAgent.precheckExpenseCase(USER_ID, CID, {
      ...caseInput,
      case_id: created.case_id,
      amount: 256,
    });
    expect(revised.payload_hash).not.toBe(created.payload_hash);

    fetchMock.mockClear();
    await expect(expenseAgent.confirmAndSubmitExpenseCase(USER_ID, CID, revised.case_id, created.payload_hash))
      .rejects.toThrow('expense_submission_confirmation_stale');
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockImplementation(async () => { throw new Error('network unavailable'); });
    await expect(expenseAgent.confirmAndSubmitExpenseCase(USER_ID, CID, revised.case_id, revised.payload_hash))
      .rejects.toThrow('expense_submission_uncertain');
    await expect(expenseAgent.getExpenseCase(USER_ID, CID, revised.case_id)).resolves.toMatchObject({
      status: 'submission_uncertain',
    });
    await expect(expenseAgent.confirmAndSubmitExpenseCase(USER_ID, CID, revised.case_id, revised.payload_hash))
      .rejects.toThrow('expense_submission_requires_reconciliation');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
