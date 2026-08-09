import type { AgentTool, ToolResult } from '#core-agent';

import {
  getExpenseCase,
  getExpenseConfigurationStatus,
  precheckExpenseCase,
  type ExpensePrecheckInput,
} from '../../features/expense_workbench/expense-agent';

export interface ExpenseAgentToolOptions {
  userId: string;
  cid?: string;
}

function content(value: unknown): ToolResult {
  return { content: JSON.stringify(value) };
}

function toolError(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : 'expense_operation_failed';
  return { content: JSON.stringify({ ok: false, error_code: message }), isError: true };
}

function text(input: Record<string, unknown>, key: string): string {
  return typeof input[key] === 'string' ? input[key] : '';
}

export function createExpenseAgentTools(options: ExpenseAgentToolOptions): AgentTool[] {
  if (!options.cid) return [];
  const cid = options.cid;

  return [
    {
      name: 'expense_configuration_status',
      description: 'Read the current user\'s redacted reimbursement configuration status. Use this before asking for reimbursement details. If ready is false, do not attempt material precheck or submit a Feishu approval; explain the missing setup and render exactly `<expense-setup-form />` in your final response. If legacy_local_configuration_detected is true, explain that the retired local-project setup is intentionally not reused and secure Feishu setup must be completed again. Never ask the user to paste an app secret into a chat message.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute(): Promise<ToolResult> {
        try { return content({ ok: true, configuration: await getExpenseConfigurationStatus(options.userId) }); }
        catch (error) { return toolError(error); }
      },
    },
    {
      name: 'expense_precheck_case',
      description: 'Create or update a reimbursement case from the details you have verified from the current conversation and its attachments, then run deterministic completeness and consistency precheck. This tool sees only the current conversation attachment directory. Before calling it, inspect receipt or itinerary attachments with the normal file tools when their contents matter. A ready result is a material/data precheck only, never an approval or payment. Do not call it until expense_configuration_status reports ready=true.',
      inputSchema: {
        type: 'object',
        properties: {
          case_id: { type: 'string', description: 'Optional case id returned by an earlier call in this same conversation, when updating that draft.' },
          title: { type: 'string', description: 'Short reimbursement subject.' },
          expense_type: { type: 'string', description: 'Expense category such as travel, meals, or supplies.' },
          amount: { type: 'number', description: 'Positive reimbursement amount.' },
          currency: { type: 'string', description: 'Three-letter ISO currency code.' },
          merchant: { type: 'string', description: 'Merchant or payee shown by the materials.' },
          expense_date: { type: 'string', description: 'Expense date in YYYY-MM-DD.' },
          description: { type: 'string', description: 'Concise business purpose and material reconciliation notes.' },
          attachment_names: { type: 'array', items: { type: 'string' }, description: 'Optional exact filenames from the current conversation to bind. Omit to bind all current attachments.' },
        },
        required: ['title', 'expense_type', 'amount', 'currency', 'merchant', 'expense_date', 'description'],
        additionalProperties: false,
      },
      async execute(input): Promise<ToolResult> {
        try {
          const raw = input as Record<string, unknown>;
          const request: ExpensePrecheckInput = {
            ...(typeof raw.case_id === 'string' && raw.case_id ? { case_id: raw.case_id } : {}),
            title: text(raw, 'title'),
            expense_type: text(raw, 'expense_type'),
            amount: typeof raw.amount === 'number' ? raw.amount : Number.NaN,
            currency: text(raw, 'currency'),
            merchant: text(raw, 'merchant'),
            expense_date: text(raw, 'expense_date'),
            description: text(raw, 'description'),
            ...(Array.isArray(raw.attachment_names) ? { attachment_names: raw.attachment_names.filter((name): name is string => typeof name === 'string') } : {}),
          };
          return content({ ok: true, case: await precheckExpenseCase(options.userId, cid, request) });
        } catch (error) { return toolError(error); }
      },
    },
    {
      name: 'expense_case_status',
      description: 'Read the current reimbursement case status by a case id previously returned in this conversation. If the case is ready_to_submit and the user explicitly asks to submit it, render exactly `<expense-submit-form case_id="THE_CASE_ID" />` in your final response. Never claim a case is submitted unless this tool reports status=submitted and returns an approval_instance_code.',
      inputSchema: {
        type: 'object',
        properties: { case_id: { type: 'string', description: 'Case id returned by expense_precheck_case.' } },
        required: ['case_id'],
        additionalProperties: false,
      },
      async execute(input): Promise<ToolResult> {
        try {
          const caseId = text(input as Record<string, unknown>, 'case_id');
          return content({ ok: true, case: await getExpenseCase(options.userId, cid, caseId) });
        } catch (error) { return toolError(error); }
      },
    },
  ];
}
