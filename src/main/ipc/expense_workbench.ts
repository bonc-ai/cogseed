import { dialog, type MessageBoxOptions } from 'electron';

import { assertCanonicalExpenseWorkbenchAgent } from '../features/expense_workbench/canonical-agent';
import {
  confirmAndSubmitExpenseCase,
  getExpenseCase,
  getExpenseConfigurationStatus,
  saveAndValidateExpenseConfiguration,
  type ExpenseConfigurationInput,
  type ExpenseNotificationReceiverType,
} from '../features/expense_workbench/expense-agent';
import { t } from '../i18n';

interface ExpenseContext {
  userId: string;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface ExpenseConfigurationPayload {
  agent_id?: JsonValue;
  api_base_url?: JsonValue;
  app_id?: JsonValue;
  app_secret?: JsonValue;
  approval_code?: JsonValue;
  applicant_open_id?: JsonValue;
  approval_node_label?: JsonValue;
  approval_form_template?: JsonValue;
  notification_receiver_type?: JsonValue;
  notification_receiver_id?: JsonValue;
}

interface ExpenseCasePayload {
  agent_id?: JsonValue;
  cid?: JsonValue;
  case_id?: JsonValue;
}

function localized(key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}

function requireAgentId(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('invalid agent_id');
  }
  return value;
}

function requireText(value: JsonValue | undefined, field: string, max: number, optional = false): string {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value.trim();
}

function requireCaseId(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('invalid expense case id');
  }
  return value;
}

function requireExpenseConfiguration(payload: ExpenseConfigurationPayload): ExpenseConfigurationInput {
  const receiverType = payload.notification_receiver_type;
  if (receiverType !== 'open_id' && receiverType !== 'chat_id') {
    throw new Error('invalid notification_receiver_type');
  }
  return {
    api_base_url: requireText(payload.api_base_url, 'api_base_url', 512),
    app_id: requireText(payload.app_id, 'app_id', 256),
    app_secret: requireText(payload.app_secret, 'app_secret', 1_024),
    approval_code: requireText(payload.approval_code, 'approval_code', 128),
    applicant_open_id: requireText(payload.applicant_open_id, 'applicant_open_id', 256),
    approval_node_label: requireText(payload.approval_node_label, 'approval_node_label', 256, true),
    approval_form_template: requireText(payload.approval_form_template, 'approval_form_template', 32_000),
    notification_receiver_type: receiverType as ExpenseNotificationReceiverType,
    notification_receiver_id: requireText(payload.notification_receiver_id, 'notification_receiver_id', 256),
  };
}

function submissionConfirmationOptions(caseId: string, payloadHash: string): MessageBoxOptions {
  const target = localized('expense_agent.submit.target', 'Feishu approval');
  return {
    type: 'warning',
    buttons: [
      localized('expense_agent.submit.cancel', 'Cancel'),
      localized('expense_agent.submit.confirm', 'Submit for approval'),
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: localized('expense_agent.submit.title', 'Confirm reimbursement submission'),
    message: localized('expense_agent.submit.message', 'Submit this reimbursement to {target}?')
      .replace('{target}', target),
    detail: localized(
      'expense_agent.submit.detail',
      'Case: {case}\nMaterial fingerprint: {hash}\n\nThis creates a Feishu approval request. It does not approve payment; designated human approvers review it in Feishu.',
    )
      .replace('{case}', caseId)
      .replace('{hash}', `${payloadHash.slice(0, 12)}...${payloadHash.slice(-12)}`),
  };
}

async function requireSubmissionConfirmation(caseId: string, payloadHash: string): Promise<void> {
  let result: Awaited<ReturnType<typeof dialog.showMessageBox>>;
  try {
    result = await dialog.showMessageBox(submissionConfirmationOptions(caseId, payloadHash));
  } catch (cause) {
    throw new Error(localized('expense_agent.submit.unavailable', 'Unable to show submission confirmation; nothing was submitted.'), { cause });
  }
  if (!result || result.response !== 1) {
    throw new Error(localized('expense_agent.submit.cancelled', 'Submission was cancelled; no data was sent to Feishu.'));
  }
}

/** Renderer calls are intentionally limited to configuration status, secret-safe
 * setup, case lookup, and the host-confirmed final submission. All Feishu and
 * reimbursement business logic remains in the feature module. */
export const invokeHandlers = {
  'expenseAgent.status': async (payload: Pick<ExpenseConfigurationPayload, 'agent_id'>, ctx: ExpenseContext) => {
    if (payload?.agent_id !== undefined) {
      await assertCanonicalExpenseWorkbenchAgent(requireAgentId(payload.agent_id));
    }
    return getExpenseConfigurationStatus(ctx.userId);
  },

  'expenseAgent.saveConfiguration': async (payload: ExpenseConfigurationPayload, ctx: ExpenseContext) => {
    await assertCanonicalExpenseWorkbenchAgent(requireAgentId(payload?.agent_id));
    return saveAndValidateExpenseConfiguration(ctx.userId, requireExpenseConfiguration(payload));
  },

  'expenseAgent.caseStatus': async (payload: ExpenseCasePayload, ctx: ExpenseContext) => {
    await assertCanonicalExpenseWorkbenchAgent(requireAgentId(payload?.agent_id));
    return getExpenseCase(
      ctx.userId,
      requireText(payload?.cid, 'conversation id', 128),
      requireCaseId(payload?.case_id),
    );
  },

  'expenseAgent.confirmAndSubmit': async (payload: ExpenseCasePayload, ctx: ExpenseContext) => {
    await assertCanonicalExpenseWorkbenchAgent(requireAgentId(payload?.agent_id));
    const cid = requireText(payload?.cid, 'conversation id', 128);
    const caseId = requireCaseId(payload?.case_id);
    const current = await getExpenseCase(ctx.userId, cid, caseId);
    await requireSubmissionConfirmation(caseId, current.payload_hash);
    return confirmAndSubmitExpenseCase(ctx.userId, cid, caseId, current.payload_hash);
  },
};
