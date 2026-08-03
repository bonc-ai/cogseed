export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const EXPENSE_WORKBENCH_SURFACE = 'expense_workbench' as const;

export const EXPENSE_WORKBENCH_READ_OPERATIONS = [
  'manifest',
  'health.get',
  'identity.get',
  'overview.stats',
  'applications.list',
  'applications.get',
  'materials.list',
  'reviews.list',
  'audit.list',
  'settings.get',
  'settings.models',
] as const;

export const EXPENSE_WORKBENCH_DRAFT_OPERATIONS = [
  'applications.create',
  'applications.draft',
  'applications.precheck',
  'applications.report',
  'materials.add',
  'materials.addAndBind',
  'materials.delete',
  'assistant.inspect',
  'assistant.propose',
] as const;

// These operations cross the local process boundary to OA or Feishu. They
// never share the generic workbench invoke route, even when the remote call is
// primarily a query, because several of them also persist or synchronize the
// observed result.
export const EXPENSE_WORKBENCH_EXTERNAL_QUERY_OPERATIONS = [
  'applications.submitStatus',
  'applications.refreshStatus',
  'settings.preflight',
  'settings.test',
] as const;

export const EXPENSE_WORKBENCH_EXTERNAL_SIDE_EFFECT_OPERATIONS = [
  'applications.recoverSubmission',
  'applications.retryFeishu',
] as const;

export const EXPENSE_WORKBENCH_EXTERNAL_OPERATIONS = [
  ...EXPENSE_WORKBENCH_EXTERNAL_QUERY_OPERATIONS,
  ...EXPENSE_WORKBENCH_EXTERNAL_SIDE_EFFECT_OPERATIONS,
] as const;

// Only operations with a dedicated, explanatory renderer action may reach
// the external IPC route. The legacy aliases below intentionally fail closed
// until a safe UI flow exists for them.
export const EXPENSE_WORKBENCH_EXPLICIT_EXTERNAL_OPERATIONS = [
  'applications.submitStatus',
  'applications.recoverSubmission',
  'applications.retryFeishu',
  'settings.preflight',
] as const;

export const EXPENSE_WORKBENCH_REVIEW_OPERATIONS = [
  'reviews.approve',
  'reviews.reject',
] as const;

export const EXPENSE_WORKBENCH_HOST_CONFIRMATION_OPERATIONS = [
  'applications.confirm',
  'applications.submit',
] as const;

export const EXPENSE_WORKBENCH_UNSUPPORTED_OPERATIONS = [
  'settings.update',
] as const;

export type ExpenseWorkbenchOperation =
  | 'manifest'
  | 'health.get'
  | 'identity.get'
  | 'overview.stats'
  | 'applications.list'
  | 'applications.get'
  | 'applications.create'
  | 'applications.draft'
  | 'applications.precheck'
  | 'applications.confirm'
  | 'applications.submit'
  | 'applications.report'
  | 'applications.refreshStatus'
  | 'applications.recoverSubmission'
  | 'applications.retryFeishu'
  | 'applications.submitStatus'
  | 'materials.list'
  | 'materials.add'
  | 'materials.addAndBind'
  | 'materials.delete'
  | 'reviews.list'
  | 'reviews.approve'
  | 'reviews.reject'
  | 'audit.list'
  | 'settings.get'
  | 'settings.update'
  | 'settings.test'
  | 'settings.preflight'
  | 'settings.models'
  | 'assistant.inspect'
  | 'assistant.propose';

export type ExpenseWorkbenchExternalOperation = typeof EXPENSE_WORKBENCH_EXTERNAL_OPERATIONS[number];

export interface ExpenseWorkbenchRequest {
  request_id: string;
  operation: ExpenseWorkbenchOperation;
  user_id: string;
  payload: JsonObject;
  host_capability_id?: string;
}

export interface ExpenseWorkbenchError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ExpenseWorkbenchResponse {
  request_id: string;
  ok: boolean;
  result?: JsonObject;
  error?: ExpenseWorkbenchError;
}

export interface ExpenseWorkbenchProjectConfig {
  version: 1;
  project_root: string;
}

export interface ExpenseWorkbenchProjectStatus {
  configured: boolean;
  project_name?: string;
  platform: 'posix' | 'windows';
}

export const EXPENSE_WORKBENCH_OPERATIONS: readonly ExpenseWorkbenchOperation[] = [
  ...EXPENSE_WORKBENCH_READ_OPERATIONS,
  ...EXPENSE_WORKBENCH_DRAFT_OPERATIONS,
  ...EXPENSE_WORKBENCH_EXTERNAL_OPERATIONS,
  ...EXPENSE_WORKBENCH_REVIEW_OPERATIONS,
  ...EXPENSE_WORKBENCH_HOST_CONFIRMATION_OPERATIONS,
  ...EXPENSE_WORKBENCH_UNSUPPORTED_OPERATIONS,
];

export const EXPENSE_WORKBENCH_EMPLOYEE_OPERATIONS: readonly ExpenseWorkbenchOperation[] =
  EXPENSE_WORKBENCH_OPERATIONS.filter((operation) => !isExpenseWorkbenchReviewOperation(operation)
    && !isExpenseWorkbenchUnsupportedOperation(operation));

export function isExpenseWorkbenchOperation(value: string): value is ExpenseWorkbenchOperation {
  return (EXPENSE_WORKBENCH_OPERATIONS as readonly string[]).includes(value);
}

export function isExpenseWorkbenchExternalOperation(
  value: ExpenseWorkbenchOperation,
): value is ExpenseWorkbenchExternalOperation {
  return (EXPENSE_WORKBENCH_EXTERNAL_OPERATIONS as readonly string[]).includes(value);
}

export function isExpenseWorkbenchExplicitExternalOperation(
  value: ExpenseWorkbenchExternalOperation,
): boolean {
  return (EXPENSE_WORKBENCH_EXPLICIT_EXTERNAL_OPERATIONS as readonly string[]).includes(value);
}

export function isExpenseWorkbenchExternalSideEffectOperation(
  value: ExpenseWorkbenchExternalOperation,
): boolean {
  return (EXPENSE_WORKBENCH_EXTERNAL_SIDE_EFFECT_OPERATIONS as readonly string[]).includes(value);
}

export function isExpenseWorkbenchReviewOperation(value: ExpenseWorkbenchOperation): boolean {
  return (EXPENSE_WORKBENCH_REVIEW_OPERATIONS as readonly string[]).includes(value);
}

export function isExpenseWorkbenchHostConfirmationOperation(value: ExpenseWorkbenchOperation): boolean {
  return (EXPENSE_WORKBENCH_HOST_CONFIRMATION_OPERATIONS as readonly string[]).includes(value);
}

export function isExpenseWorkbenchUnsupportedOperation(value: ExpenseWorkbenchOperation): boolean {
  return (EXPENSE_WORKBENCH_UNSUPPORTED_OPERATIONS as readonly string[]).includes(value);
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
