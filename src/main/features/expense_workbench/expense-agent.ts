import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { Mutex } from 'async-mutex';

import { createLogger } from '../../logger';
import {
  userExpenseAgentCaseFile,
  userExpenseAgentConfigFile,
  userLegacyExpenseWorkbenchConfigFile,
} from '../../paths';
import { nowIso, readJson, safeId, writeJson } from '../../storage';
import { decryptLocalSecret, encryptLocalSecret, isEncryptedSecret } from '../../util/local-secret-store';
import { listAttachments, type AttachmentInfo } from '../chat_attachments';

const log = createLogger('expense-agent');
const CONFIG_VERSION = 3;
const CASE_VERSION = 1;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_TEXT_LENGTH = 2_000;
const MAX_DESCRIPTION_LENGTH = 8_000;
const MAX_TEMPLATE_LENGTH = 32_000;
const MAX_CASE_EVENTS = 40;
const APPROVAL_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OPEN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const SUPPORTED_RECEIVER_TYPES = new Set(['open_id', 'chat_id']);
const ALLOWED_TEMPLATE_TOKENS = new Set([
  '{{title}}', '{{amount}}', '{{currency}}', '{{merchant}}', '{{expense_date}}', '{{description}}', '{{materials}}',
]);

export type ExpenseConfigurationState = 'unconfigured' | 'invalid' | 'ready';
export type ExpenseNotificationReceiverType = 'open_id' | 'chat_id';
export type ExpenseCaseStatus = 'draft' | 'precheck_failed' | 'ready_to_submit' | 'submitting' | 'submitted' | 'submission_uncertain' | 'submission_failed';

export interface ExpenseConfigurationInput {
  api_base_url: string;
  app_id: string;
  app_secret: string;
  approval_code: string;
  applicant_open_id: string;
  approval_node_label: string;
  approval_form_template: string;
  notification_receiver_type: ExpenseNotificationReceiverType;
  notification_receiver_id: string;
}

interface StoredExpenseConfiguration {
  version: typeof CONFIG_VERSION;
  api_base_url: string;
  app_id: string;
  approval_code: string;
  applicant_open_id: string;
  approval_node_label: string;
  approval_form_template: string;
  notification_receiver_type: ExpenseNotificationReceiverType;
  notification_receiver_id: string;
  secret_enc: string;
  saved_at: string;
  validation: {
    state: Exclude<ExpenseConfigurationState, 'unconfigured'>;
    checked_at: string;
    approval_name?: string;
    error_code?: string;
  };
}

export interface ExpenseConfigurationStatus {
  state: ExpenseConfigurationState;
  configured: boolean;
  ready: boolean;
  /** A retired local-project configuration was found but is deliberately not reused. */
  legacy_local_configuration_detected?: boolean;
  api_base_url?: string;
  app_id_suffix?: string;
  approval_code?: string;
  approval_node_label?: string;
  notification_receiver_type?: ExpenseNotificationReceiverType;
  notification_receiver_id_suffix?: string;
  approval_name?: string;
  checked_at?: string;
  error_code?: string;
}

export interface ExpensePrecheckInput {
  case_id?: string;
  title: string;
  expense_type: string;
  amount: number;
  currency: string;
  merchant: string;
  expense_date: string;
  description: string;
  attachment_names?: string[];
}

interface ExpenseCaseMaterial {
  name: string;
  kind: AttachmentInfo['kind'];
  bytes: number;
  mtime: number;
}

interface ExpenseCaseEvent {
  at: string;
  type: string;
  detail?: string;
}

interface ExpenseCaseRecord {
  version: typeof CASE_VERSION;
  case_id: string;
  user_id: string;
  conversation_id: string;
  title: string;
  expense_type: string;
  amount: number;
  currency: string;
  merchant: string;
  expense_date: string;
  description: string;
  materials: ExpenseCaseMaterial[];
  payload_hash: string;
  precheck: {
    status: 'ready' | 'needs_correction';
    reasons: string[];
    checked_at: string;
  };
  status: ExpenseCaseStatus;
  created_at: string;
  updated_at: string;
  submission?: {
    idempotency_key_hash: string;
    started_at: string;
    submitted_at?: string;
    approval_instance_code?: string;
    notification_status?: 'sent' | 'failed' | 'not_attempted';
    error_code?: string;
  };
  events: ExpenseCaseEvent[];
}

export interface ExpenseCaseSummary {
  case_id: string;
  title: string;
  amount: number;
  currency: string;
  status: ExpenseCaseStatus;
  precheck_status: ExpenseCaseRecord['precheck']['status'];
  precheck_reasons: string[];
  material_count: number;
  payload_hash: string;
  approval_instance_code?: string;
  notification_status?: 'sent' | 'failed' | 'not_attempted';
  updated_at: string;
}

interface FeishuTokenResponse {
  app_access_token: string;
}

const caseLocks = new Map<string, Mutex>();

function expenseSecretContext(userId: string) {
  return { namespace: 'expense-agent-configuration', ownerId: userId, recordId: 'v3' };
}

function configurationFile(userId: string): string {
  if (!safeId(userId)) throw new Error('invalid expense user id');
  return userExpenseAgentConfigFile(userId);
}

function caseLock(userId: string, caseId: string): Mutex {
  const key = `${userId}\u0000${caseId}`;
  let lock = caseLocks.get(key);
  if (!lock) {
    lock = new Mutex();
    caseLocks.set(key, lock);
  }
  return lock;
}

function requireText(value: unknown, field: string, max = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string') throw new Error(`${field} is required`);
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${field} is invalid`);
  return text;
}

function requireOptionalText(value: unknown, field: string, max = MAX_TEXT_LENGTH): string {
  if (value === undefined || value === null || value === '') return '';
  return requireText(value, field, max);
}

function normalizeApiBase(value: unknown): string {
  const text = requireText(value, 'api_base_url', 512);
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new Error('api_base_url is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('api_base_url must be an HTTPS origin');
  }
  const hostname = parsed.hostname.toLowerCase();
  // Limit secret-bearing requests to official Feishu/Lark host families.
  if (!(hostname === 'feishu.cn' || hostname.endsWith('.feishu.cn')
    || hostname === 'larksuite.com' || hostname.endsWith('.larksuite.com'))) {
    throw new Error('api_base_url must use an official Feishu or Lark host');
  }
  return parsed.origin;
}

function normalizeTemplate(value: unknown): string {
  const text = requireText(value, 'approval_form_template', MAX_TEMPLATE_LENGTH);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('approval_form_template must be valid JSON'); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 80) {
    throw new Error('approval_form_template must be a non-empty JSON array');
  }
  validateTemplateValue(parsed, 0);
  return JSON.stringify(parsed);
}

function validateTemplateValue(value: unknown, depth: number): void {
  if (depth > 8) throw new Error('approval_form_template is too deeply nested');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    if (value.length > 4_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      throw new Error('approval_form_template contains invalid text');
    }
    const tokens = value.match(/\{\{[^}]+\}\}/g) || [];
    if (tokens.some((token) => !ALLOWED_TEMPLATE_TOKENS.has(token))) {
      throw new Error('approval_form_template contains an unsupported placeholder');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error('approval_form_template contains too many values');
    value.forEach((entry) => validateTemplateValue(entry, depth + 1));
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('approval_form_template contains an unsupported value');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) throw new Error('approval_form_template contains too many fields');
  for (const [key, entry] of entries) {
    if (!key || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key)) {
      throw new Error('approval_form_template contains an invalid field');
    }
    validateTemplateValue(entry, depth + 1);
  }
}

function normalizeConfiguration(input: ExpenseConfigurationInput): Omit<StoredExpenseConfiguration, 'version' | 'secret_enc' | 'saved_at' | 'validation'> & { app_secret: string } {
  const api_base_url = normalizeApiBase(input.api_base_url);
  const app_id = requireText(input.app_id, 'app_id', 256);
  const app_secret = requireText(input.app_secret, 'app_secret', 1_024);
  const approval_code = requireText(input.approval_code, 'approval_code', 128);
  if (!APPROVAL_CODE.test(approval_code)) throw new Error('approval_code is invalid');
  const applicant_open_id = requireText(input.applicant_open_id, 'applicant_open_id', 256);
  if (!OPEN_ID.test(applicant_open_id)) throw new Error('applicant_open_id is invalid');
  const approval_node_label = requireOptionalText(input.approval_node_label, 'approval_node_label', 256);
  const approval_form_template = normalizeTemplate(input.approval_form_template);
  const notification_receiver_type = input.notification_receiver_type;
  if (!SUPPORTED_RECEIVER_TYPES.has(notification_receiver_type)) throw new Error('notification_receiver_type is invalid');
  const notification_receiver_id = requireText(input.notification_receiver_id, 'notification_receiver_id', 256);
  if (!OPEN_ID.test(notification_receiver_id)) throw new Error('notification_receiver_id is invalid');
  return {
    api_base_url,
    app_id,
    app_secret,
    approval_code,
    applicant_open_id,
    approval_node_label,
    approval_form_template,
    notification_receiver_type,
    notification_receiver_id,
  };
}

function parseStoredConfiguration(value: unknown): StoredExpenseConfiguration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<StoredExpenseConfiguration>;
  if (raw.version !== CONFIG_VERSION || typeof raw.secret_enc !== 'string' || !isEncryptedSecret(raw.secret_enc)
    || !raw.validation || (raw.validation.state !== 'ready' && raw.validation.state !== 'invalid')) return null;
  try {
    const normalized = normalizeConfiguration({
      api_base_url: raw.api_base_url || '', app_id: raw.app_id || '', app_secret: 'stored-secret',
      approval_code: raw.approval_code || '', applicant_open_id: raw.applicant_open_id || '',
      approval_node_label: raw.approval_node_label || '', approval_form_template: raw.approval_form_template || '',
      notification_receiver_type: raw.notification_receiver_type as ExpenseNotificationReceiverType,
      notification_receiver_id: raw.notification_receiver_id || '',
    });
    return {
      version: CONFIG_VERSION,
      api_base_url: normalized.api_base_url,
      app_id: normalized.app_id,
      approval_code: normalized.approval_code,
      applicant_open_id: normalized.applicant_open_id,
      approval_node_label: normalized.approval_node_label,
      approval_form_template: normalized.approval_form_template,
      notification_receiver_type: normalized.notification_receiver_type,
      notification_receiver_id: normalized.notification_receiver_id,
      secret_enc: raw.secret_enc,
      saved_at: typeof raw.saved_at === 'string' ? raw.saved_at : '',
      validation: {
        state: raw.validation.state,
        checked_at: typeof raw.validation.checked_at === 'string' ? raw.validation.checked_at : '',
        ...(typeof raw.validation.approval_name === 'string' ? { approval_name: raw.validation.approval_name } : {}),
        ...(typeof raw.validation.error_code === 'string' ? { error_code: raw.validation.error_code } : {}),
      },
    };
  } catch {
    return null;
  }
}

function publicConfigurationStatus(config: StoredExpenseConfiguration | null): ExpenseConfigurationStatus {
  if (!config) return { state: 'unconfigured', configured: false, ready: false };
  const state = config.validation.state;
  return {
    state,
    configured: true,
    ready: state === 'ready',
    api_base_url: config.api_base_url,
    app_id_suffix: mask(config.app_id),
    approval_code: config.approval_code,
    approval_node_label: config.approval_node_label || undefined,
    notification_receiver_type: config.notification_receiver_type,
    notification_receiver_id_suffix: mask(config.notification_receiver_id),
    approval_name: config.validation.approval_name,
    checked_at: config.validation.checked_at || undefined,
    error_code: config.validation.error_code,
  };
}

function mask(value: string): string {
  if (value.length <= 4) return '****';
  return `***${value.slice(-4)}`;
}

async function readConfiguration(userId: string): Promise<StoredExpenseConfiguration | null> {
  return parseStoredConfiguration(await readJson<unknown>(configurationFile(userId)));
}

async function hasLegacyLocalConfiguration(userId: string): Promise<boolean> {
  // Validate the uid through the normal configuration path before constructing
  // the migration-marker path. The retired configuration is never parsed.
  configurationFile(userId);
  try {
    await fsp.access(userLegacyExpenseWorkbenchConfigFile(userId));
    return true;
  } catch {
    return false;
  }
}

function decodeSecret(userId: string, config: StoredExpenseConfiguration): string {
  try {
    return decryptLocalSecret(expenseSecretContext(userId), config.secret_enc);
  } catch (error) {
    throw new Error('expense configuration secret is unavailable', { cause: error instanceof Error ? error : undefined });
  }
}

async function feishuRequest<T>(
  baseUrl: string,
  path: string,
  options: { method: 'GET' | 'POST'; token?: string; body?: Record<string, unknown> },
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`feishu_http_${response.status}`);
    const raw = await response.text();
    if (raw.length > 512 * 1024) throw new Error('feishu_response_too_large');
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { throw new Error('feishu_response_invalid'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('feishu_response_invalid');
    const envelope = payload as { code?: unknown; data?: unknown };
    if (envelope.code !== 0) throw new Error(`feishu_api_${String(envelope.code ?? 'unknown')}`);
    return (envelope.data || {}) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('feishu_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getAppAccessToken(config: StoredExpenseConfiguration, appSecret: string): Promise<string> {
  const data = await feishuRequest<FeishuTokenResponse>(config.api_base_url, '/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST', body: { app_id: config.app_id, app_secret: appSecret },
  });
  if (!data || typeof data.app_access_token !== 'string' || !data.app_access_token) {
    throw new Error('feishu_token_response_invalid');
  }
  return data.app_access_token;
}

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown';
  return /^[a-z0-9_:-]{1,128}$/i.test(message) ? message : 'feishu_request_failed';
}

export async function getExpenseConfigurationStatus(userId: string): Promise<ExpenseConfigurationStatus> {
  const config = await readConfiguration(userId);
  const status = publicConfigurationStatus(config);
  if (config || !(await hasLegacyLocalConfiguration(userId))) return status;
  return {
    ...status,
    legacy_local_configuration_detected: true,
    error_code: 'legacy_local_configuration_not_supported',
  };
}

export async function saveAndValidateExpenseConfiguration(
  userId: string,
  input: ExpenseConfigurationInput,
): Promise<ExpenseConfigurationStatus> {
  const normalized = normalizeConfiguration(input);
  const checkedAt = nowIso();
  let validation: StoredExpenseConfiguration['validation'];
  try {
    const provisional: StoredExpenseConfiguration = {
      version: CONFIG_VERSION,
      ...normalized,
      secret_enc: '',
      saved_at: checkedAt,
      validation: { state: 'invalid', checked_at: checkedAt },
    };
    const token = await getAppAccessToken(provisional, normalized.app_secret);
    const approval = await feishuRequest<Record<string, unknown>>(
      provisional.api_base_url,
      `/open-apis/approval/v4/approvals/${encodeURIComponent(provisional.approval_code)}`,
      { method: 'GET', token },
    );
    const approvalName = typeof approval.approval_name === 'string' && approval.approval_name.length <= 256
      ? approval.approval_name : undefined;
    validation = { state: 'ready', checked_at: checkedAt, ...(approvalName ? { approval_name: approvalName } : {}) };
  } catch (error) {
    validation = { state: 'invalid', checked_at: checkedAt, error_code: failureCode(error) };
    log.warn('expense configuration validation failed', { user_id: userId, error_code: validation.error_code });
  }

  const stored: StoredExpenseConfiguration = {
    version: CONFIG_VERSION,
    api_base_url: normalized.api_base_url,
    app_id: normalized.app_id,
    approval_code: normalized.approval_code,
    applicant_open_id: normalized.applicant_open_id,
    approval_node_label: normalized.approval_node_label,
    approval_form_template: normalized.approval_form_template,
    notification_receiver_type: normalized.notification_receiver_type,
    notification_receiver_id: normalized.notification_receiver_id,
    secret_enc: encryptLocalSecret(expenseSecretContext(userId), normalized.app_secret),
    saved_at: checkedAt,
    validation,
  };
  await writeJson(configurationFile(userId), stored);
  return publicConfigurationStatus(stored);
}

function requireReadyConfiguration(config: StoredExpenseConfiguration | null): StoredExpenseConfiguration {
  if (!config || config.validation.state !== 'ready') {
    throw new Error('expense_configuration_required');
  }
  return config;
}

function validatePrecheckInput(input: ExpensePrecheckInput): Omit<ExpensePrecheckInput, 'case_id' | 'attachment_names'> {
  const title = requireText(input.title, 'title', 256);
  const expense_type = requireText(input.expense_type, 'expense_type', 128);
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) throw new Error('amount is invalid');
  const currency = requireText(input.currency, 'currency', 16).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency is invalid');
  const merchant = requireText(input.merchant, 'merchant', 256);
  const expense_date = requireText(input.expense_date, 'expense_date', 32);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expense_date) || Number.isNaN(Date.parse(`${expense_date}T00:00:00Z`))) {
    throw new Error('expense_date is invalid');
  }
  const description = requireText(input.description, 'description', MAX_DESCRIPTION_LENGTH);
  return { title, expense_type, amount, currency, merchant, expense_date, description };
}

function selectedMaterials(userId: string, cid: string, names: unknown): ExpenseCaseMaterial[] {
  if (!safeId(cid)) throw new Error('invalid conversation id');
  const all = listAttachments(userId, cid);
  const requested = Array.isArray(names) ? names : all.map((item) => item.name);
  if (requested.length === 0 || requested.length > 20 || requested.some((name) => typeof name !== 'string')) {
    throw new Error('attachment_names are invalid');
  }
  const unique = Array.from(new Set(requested.map((name) => String(name))));
  if (unique.length !== requested.length) throw new Error('attachment_names contain duplicates');
  const index = new Map(all.map((item) => [item.name, item]));
  const selected = unique.map((name) => index.get(name));
  if (selected.some((item) => !item)) throw new Error('an attachment is unavailable');
  return (selected as AttachmentInfo[]).map((item) => ({
    name: item.name, kind: item.kind, bytes: item.bytes, mtime: item.mtime,
  }));
}

function precheckReasons(input: Omit<ExpensePrecheckInput, 'case_id' | 'attachment_names'>, materials: ExpenseCaseMaterial[]): string[] {
  const reasons: string[] = [];
  if (!materials.length) reasons.push('missing_materials');
  if (materials.some((material) => material.kind === 'video' || material.kind === 'audio')) reasons.push('unsupported_material_type');
  const dateMs = Date.parse(`${input.expense_date}T00:00:00Z`);
  const now = Date.now();
  if (dateMs > now + 24 * 60 * 60 * 1000) reasons.push('expense_date_in_future');
  if (dateMs < now - 5 * 366 * 24 * 60 * 60 * 1000) reasons.push('expense_date_out_of_range');
  return reasons;
}

function payloadHash(input: Omit<ExpensePrecheckInput, 'case_id' | 'attachment_names'>, materials: ExpenseCaseMaterial[]): string {
  return crypto.createHash('sha256').update(JSON.stringify({ ...input, materials })).digest('hex');
}

function createCaseId(): string {
  return `exp_${crypto.randomBytes(12).toString('hex')}`;
}

function summarizeCase(record: ExpenseCaseRecord): ExpenseCaseSummary {
  return {
    case_id: record.case_id,
    title: record.title,
    amount: record.amount,
    currency: record.currency,
    status: record.status,
    precheck_status: record.precheck.status,
    precheck_reasons: record.precheck.reasons.slice(),
    material_count: record.materials.length,
    payload_hash: record.payload_hash,
    ...(record.submission?.approval_instance_code ? { approval_instance_code: record.submission.approval_instance_code } : {}),
    ...(record.submission?.notification_status ? { notification_status: record.submission.notification_status } : {}),
    updated_at: record.updated_at,
  };
}

function parseCase(value: unknown, userId: string, cid?: string): ExpenseCaseRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<ExpenseCaseRecord>;
  if (record.version !== CASE_VERSION || !safeId(record.case_id) || record.user_id !== userId || !safeId(record.conversation_id)
    || (cid && record.conversation_id !== cid) || !Array.isArray(record.materials) || !record.precheck || !Array.isArray(record.events)) return null;
  if (!['draft', 'precheck_failed', 'ready_to_submit', 'submitting', 'submitted', 'submission_uncertain', 'submission_failed'].includes(record.status || '')) return null;
  if (record.precheck.status !== 'ready' && record.precheck.status !== 'needs_correction') return null;
  return record as ExpenseCaseRecord;
}

async function readCase(userId: string, caseId: string, cid?: string): Promise<ExpenseCaseRecord> {
  if (!safeId(caseId)) throw new Error('invalid expense case id');
  const record = parseCase(await readJson<unknown>(userExpenseAgentCaseFile(userId, caseId)), userId, cid);
  if (!record) throw new Error('expense_case_not_found');
  return record;
}

function appendEvent(record: ExpenseCaseRecord, type: string, detail?: string): void {
  record.events.push({ at: nowIso(), type, ...(detail ? { detail } : {}) });
  if (record.events.length > MAX_CASE_EVENTS) record.events.splice(0, record.events.length - MAX_CASE_EVENTS);
}

export async function precheckExpenseCase(userId: string, cid: string, input: ExpensePrecheckInput): Promise<ExpenseCaseSummary> {
  const config = requireReadyConfiguration(await readConfiguration(userId));
  void config;
  const normalized = validatePrecheckInput(input);
  const materials = selectedMaterials(userId, cid, input.attachment_names);
  const reasons = precheckReasons(normalized, materials);
  const caseId = input.case_id ? String(input.case_id) : createCaseId();
  if (!safeId(caseId)) throw new Error('invalid expense case id');
  const lock = caseLock(userId, caseId);
  return lock.runExclusive(async () => {
    const previous = await readJson<unknown>(userExpenseAgentCaseFile(userId, caseId));
    const existing = parseCase(previous, userId, cid);
    if (existing && existing.status === 'submitted') return summarizeCase(existing);
    const timestamp = nowIso();
    const hash = payloadHash(normalized, materials);
    const record: ExpenseCaseRecord = {
      version: CASE_VERSION,
      case_id: caseId,
      user_id: userId,
      conversation_id: cid,
      ...normalized,
      materials,
      payload_hash: hash,
      precheck: { status: reasons.length ? 'needs_correction' : 'ready', reasons, checked_at: timestamp },
      status: reasons.length ? 'precheck_failed' : 'ready_to_submit',
      created_at: existing?.created_at || timestamp,
      updated_at: timestamp,
      events: existing?.events || [],
    };
    appendEvent(record, reasons.length ? 'precheck_failed' : 'precheck_ready');
    await writeJson(userExpenseAgentCaseFile(userId, caseId), record);
    return summarizeCase(record);
  });
}

export async function getExpenseCase(userId: string, cid: string, caseId: string): Promise<ExpenseCaseSummary> {
  return summarizeCase(await readCase(userId, caseId, cid));
}

function renderTemplate(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{(?:title|amount|currency|merchant|expense_date|description|materials)\}\}/g, (token) => values[token] || token);
  }
  if (Array.isArray(value)) return value.map((entry) => renderTemplate(entry, values));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, renderTemplate(entry, values)]));
  }
  return value;
}

function approvalForm(config: StoredExpenseConfiguration, record: ExpenseCaseRecord): string {
  const template = JSON.parse(config.approval_form_template) as unknown;
  const values: Record<string, string> = {
    '{{title}}': record.title,
    '{{amount}}': String(record.amount),
    '{{currency}}': record.currency,
    '{{merchant}}': record.merchant,
    '{{expense_date}}': record.expense_date,
    '{{description}}': record.description,
    '{{materials}}': record.materials.map((material) => material.name).join(', '),
  };
  return JSON.stringify(renderTemplate(template, values));
}

function idempotencyKey(record: ExpenseCaseRecord, config: StoredExpenseConfiguration): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    case_id: record.case_id,
    payload_hash: record.payload_hash,
    approval_code: config.approval_code,
    applicant_open_id: config.applicant_open_id,
  })).digest('hex');
}

async function notifySubmission(config: StoredExpenseConfiguration, token: string, record: ExpenseCaseRecord): Promise<'sent' | 'failed'> {
  const instanceCode = record.submission?.approval_instance_code || '';
  try {
    await feishuRequest(config.api_base_url, `/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(config.notification_receiver_type)}`, {
      method: 'POST', token,
      body: {
        receive_id: config.notification_receiver_id,
        msg_type: 'text',
        content: JSON.stringify({ text: `Expense approval submitted: ${record.title} (${record.currency} ${record.amount})${instanceCode ? `, ${instanceCode}` : ''}` }),
      },
    });
    return 'sent';
  } catch (error) {
    log.warn('expense submission notification failed', { user_id: record.user_id, case_id: record.case_id, error_code: failureCode(error) });
    return 'failed';
  }
}

export async function confirmAndSubmitExpenseCase(
  userId: string,
  cid: string,
  caseId: string,
  expectedPayloadHash: string,
): Promise<ExpenseCaseSummary> {
  const config = requireReadyConfiguration(await readConfiguration(userId));
  const secret = decodeSecret(userId, config);
  if (!/^[a-f0-9]{64}$/.test(expectedPayloadHash)) {
    throw new Error('invalid expense confirmation fingerprint');
  }
  const lock = caseLock(userId, caseId);
  return lock.runExclusive(async () => {
    const record = await readCase(userId, caseId, cid);
    if (record.payload_hash !== expectedPayloadHash) {
      throw new Error('expense_submission_confirmation_stale');
    }
    if (record.status === 'submitted') return summarizeCase(record);
    if (record.status === 'submission_uncertain' || record.status === 'submitting') {
      throw new Error('expense_submission_requires_reconciliation');
    }
    if (record.status !== 'ready_to_submit' || record.precheck.status !== 'ready') {
      throw new Error('expense_case_not_ready_for_submission');
    }
    const key = idempotencyKey(record, config);
    const startedAt = nowIso();
    record.status = 'submitting';
    record.submission = { idempotency_key_hash: key, started_at: startedAt, notification_status: 'not_attempted' };
    record.updated_at = startedAt;
    appendEvent(record, 'submission_started');
    await writeJson(userExpenseAgentCaseFile(userId, caseId), record);

    let token: string;
    try {
      token = await getAppAccessToken(config, secret);
      const data = await feishuRequest<{ instance_code?: unknown }>(config.api_base_url, '/open-apis/approval/v4/instances', {
        method: 'POST', token,
        body: {
          approval_code: config.approval_code,
          user_id: config.applicant_open_id,
          form: approvalForm(config, record),
        },
      });
      if (typeof data.instance_code !== 'string' || !data.instance_code) throw new Error('feishu_instance_response_invalid');
      record.status = 'submitted';
      record.submission = {
        idempotency_key_hash: key,
        started_at: startedAt,
        submitted_at: nowIso(),
        approval_instance_code: data.instance_code,
        notification_status: 'not_attempted',
      };
      appendEvent(record, 'submission_succeeded');
    } catch (error) {
      record.status = 'submission_uncertain';
      record.submission = {
        idempotency_key_hash: key,
        started_at: startedAt,
        notification_status: 'not_attempted',
        error_code: failureCode(error),
      };
      appendEvent(record, 'submission_uncertain', record.submission.error_code);
      record.updated_at = nowIso();
      await writeJson(userExpenseAgentCaseFile(userId, caseId), record);
      throw new Error('expense_submission_uncertain');
    }

    record.submission.notification_status = await notifySubmission(config, token!, record);
    record.updated_at = nowIso();
    await writeJson(userExpenseAgentCaseFile(userId, caseId), record);
    return summarizeCase(record);
  });
}
