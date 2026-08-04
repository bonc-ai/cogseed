import * as crypto from 'node:crypto';

import {
  BrowserWindow,
  dialog,
  ipcMain,
  type MessageBoxOptions,
  type WebContents,
} from 'electron';

import {
  callExpenseWorkbench,
  closeExpenseWorkbenchSessions,
  configureExpenseProject,
  getExpenseProjectStatus,
} from '../features/expense_workbench/adapter';
import { confirmAndSubmitExpenseWorkbench } from '../features/expense_workbench/submission';
import {
  addAndBindExpenseMaterialsFromPaths,
  assertExpenseMaterialTarget,
} from '../features/expense_workbench/material-import';
import {
  EXPENSE_WORKBENCH_SURFACE,
  isExpenseWorkbenchOperation,
  isExpenseWorkbenchExplicitExternalOperation,
  isExpenseWorkbenchExternalOperation,
  isExpenseWorkbenchExternalSideEffectOperation,
  isExpenseWorkbenchHostConfirmationOperation,
  isExpenseWorkbenchReviewOperation,
  isExpenseWorkbenchUnsupportedOperation,
  type ExpenseWorkbenchExternalOperation,
  type JsonObject,
  type JsonValue,
} from '../features/expense_workbench/contracts';
import { assertCanonicalExpenseWorkbenchAgent } from '../features/expense_workbench/canonical-agent';
import { getActiveUserId } from '../features/users';
import { t } from '../i18n';
import { createLogger } from '../logger';
import { isTrustedIpcSender } from './security';

interface ExpenseContext {
  userId: string;
  sender: WebContents;
}

interface CapabilityPayload {
  host_capability?: JsonValue;
  page_instance?: JsonValue;
  request_nonce?: JsonValue;
  operation_scope?: JsonValue;
}

interface InvokePayload extends CapabilityPayload {
  operation?: JsonValue;
  payload?: JsonValue;
}

interface ConfirmAndSubmitPayload extends CapabilityPayload {
  application_id?: JsonValue;
  version?: JsonValue;
  payload_hash?: JsonValue;
}

interface PickAndAddMaterialsPayload extends CapabilityPayload {
  application_id?: JsonValue;
}

type PickAndConfigurePayload = CapabilityPayload;

type ExpenseWorkbenchOpenGesture = 'agent_card' | 'agent_detail';

interface ExpenseWorkbenchOpenTicket {
  token: string;
  pageInstanceId: string;
  userId: string;
  agentId: string;
  gesture: ExpenseWorkbenchOpenGesture;
  sender: WebContents;
  senderGeneration: number;
  expiresAt: number;
  expiryTimer: NodeJS.Timeout;
}

interface ExpenseWorkbenchCapability {
  token: string;
  pageInstanceId: string;
  userId: string;
  agentId: string;
  managementSurface: typeof EXPENSE_WORKBENCH_SURFACE;
  sender: WebContents;
  expiresAt: number;
  expiryTimer: NodeJS.Timeout;
  usedRequestNonces: Set<string>;
}

interface ExternalOperationNotice {
  targetKey: string;
  targetFallback: string;
  actionKey: string;
  actionFallback: string;
  consequenceKey: string;
  consequenceFallback: string;
}

const EXTERNAL_OPERATION_NOTICES: Record<ExpenseWorkbenchExternalOperation, ExternalOperationNotice> = {
  'applications.submitStatus': {
    targetKey: 'expense_workbench.external.target.feishu_oa', targetFallback: '飞书 / OA',
    actionKey: 'expense_workbench.external.submit_status.action', actionFallback: '查询当前报销申请的外部审批状态',
    consequenceKey: 'expense_workbench.external.submit_status.consequence', consequenceFallback: '查询结果可能更新本地状态，并触发飞书同步或状态通知。',
  },
  'applications.refreshStatus': {
    targetKey: 'expense_workbench.external.target.feishu_oa', targetFallback: '飞书 / OA',
    actionKey: 'expense_workbench.external.refresh_status.action', actionFallback: '刷新当前报销申请的外部审批状态',
    consequenceKey: 'expense_workbench.external.unavailable.consequence', consequenceFallback: '该兼容操作没有独立的安全界面入口。',
  },
  'applications.recoverSubmission': {
    targetKey: 'expense_workbench.external.target.oa', targetFallback: 'OA',
    actionKey: 'expense_workbench.external.recover.action', actionFallback: '查询并恢复一次结果不确定的已有提交意图',
    consequenceKey: 'expense_workbench.external.recover.consequence', consequenceFallback: '不会新建提交，但可能写入恢复结果并触发飞书同步。',
  },
  'applications.retryFeishu': {
    targetKey: 'expense_workbench.external.target.feishu', targetFallback: '飞书',
    actionKey: 'expense_workbench.external.retry_feishu.action', actionFallback: '重试发送当前报销申请的失败同步',
    consequenceKey: 'expense_workbench.external.retry_feishu.consequence', consequenceFallback: '会向飞书重新发送数据，但不会重复提交 OA 审批。',
  },
  'settings.preflight': {
    targetKey: 'expense_workbench.external.target.feishu', targetFallback: '飞书',
    actionKey: 'expense_workbench.external.preflight.action', actionFallback: '检查租户身份、审批模板与连接权限',
    consequenceKey: 'expense_workbench.external.preflight.consequence', consequenceFallback: '会发起外部网络请求，但不会提交报销申请。',
  },
  'settings.test': {
    targetKey: 'expense_workbench.external.target.feishu', targetFallback: '飞书',
    actionKey: 'expense_workbench.external.test.action', actionFallback: '测试飞书连接',
    consequenceKey: 'expense_workbench.external.unavailable.consequence', consequenceFallback: '该兼容操作没有独立的安全界面入口。',
  },
};

const log = createLogger('expense_workbench_ipc');
const EXPENSE_WORKBENCH_HOST_PREPARE_OPEN_CHANNEL = 'orkas.expenseWorkbenchHost.prepareOpen';
const EXPENSE_WORKBENCH_HOST_OPEN_CHANNEL = 'orkas.expenseWorkbenchHost.open';
const EXPENSE_WORKBENCH_OPEN_TICKET_TTL_MS = 15 * 1000;
const EXPENSE_WORKBENCH_CAPABILITY_TTL_MS = 10 * 60 * 1000;
const EXPENSE_WORKBENCH_OPEN_TICKET_PATTERN = /^ewopen_[A-Za-z0-9_-]{43}$/;
const EXPENSE_WORKBENCH_CAPABILITY_PATTERN = /^ewcap_[A-Za-z0-9_-]{43}$/;
const EXPENSE_WORKBENCH_PAGE_INSTANCE_PATTERN = /^ewpage_[A-Za-z0-9_-]{43}$/;
const EXPENSE_WORKBENCH_REQUEST_NONCE_PATTERN = /^ewreq_[A-Za-z0-9_-]{8,96}$/;
const EXPENSE_WORKBENCH_OPERATION_SCOPE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,511}$/;
const MAX_CAPABILITY_REQUESTS = 4096;
const CAPABILITY_ENVELOPE_KEYS = [
  'host_capability',
  'page_instance',
  'request_nonce',
  'operation_scope',
] as const;
const openTickets = new Map<string, ExpenseWorkbenchOpenTicket>();
const capabilities = new Map<string, ExpenseWorkbenchCapability>();
const cleanupBoundSenders = new WeakSet<object>();
const senderAuthorizationGenerations = new WeakMap<object, number>();
let hostIpcRegistered = false;

function capabilityError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'E_EXPENSE_WORKBENCH_CAPABILITY' });
}

function clearCapability(token: string): ExpenseWorkbenchCapability | null {
  const capability = capabilities.get(token);
  if (!capability) return null;
  capabilities.delete(token);
  clearTimeout(capability.expiryTimer);
  return capability;
}

function clearOpenTicket(token: string): ExpenseWorkbenchOpenTicket | null {
  const ticket = openTickets.get(token);
  if (!ticket) return null;
  openTickets.delete(token);
  clearTimeout(ticket.expiryTimer);
  return ticket;
}

function expireOpenTicket(token: string): void {
  clearOpenTicket(token);
}

function closeCapabilitySession(capability: ExpenseWorkbenchCapability, reason: string): void {
  void closeExpenseWorkbenchSessions(capability.userId).catch((error) => {
    log.warn('failed to close revoked expense workbench session', {
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function expireCapability(token: string): void {
  const capability = clearCapability(token);
  if (capability) closeCapabilitySession(capability, 'expired');
}

async function revokeSenderCapabilities(sender: WebContents, reason: string): Promise<void> {
  const revoked = [...capabilities.values()].filter((capability) => capability.sender === sender);
  for (const capability of revoked) clearCapability(capability.token);
  await Promise.all(revoked.map(async (capability) => {
    try {
      await closeExpenseWorkbenchSessions(capability.userId);
    } catch (error) {
      log.warn('failed to close revoked expense workbench session', {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));
}

function revokeSenderOpenTickets(sender: WebContents): void {
  for (const ticket of openTickets.values()) {
    if (ticket.sender === sender) clearOpenTicket(ticket.token);
  }
}

async function revokeSenderAuthorizations(sender: WebContents, reason: string): Promise<void> {
  senderAuthorizationGenerations.set(sender, senderAuthorizationGeneration(sender) + 1);
  revokeSenderOpenTickets(sender);
  await revokeSenderCapabilities(sender, reason);
}

function senderAuthorizationGeneration(sender: WebContents): number {
  return senderAuthorizationGenerations.get(sender) || 0;
}

function bindSenderCleanup(sender: WebContents): void {
  if (cleanupBoundSenders.has(sender)) return;
  cleanupBoundSenders.add(sender);
  sender.once('destroyed', () => {
    void revokeSenderAuthorizations(sender, 'renderer-destroyed');
  });
  sender.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) void revokeSenderAuthorizations(sender, 'renderer-navigation');
  });
  sender.on('render-process-gone', () => {
    void revokeSenderAuthorizations(sender, 'renderer-process-gone');
  });
}

function issueOpenTicket(
  userId: string,
  agentId: string,
  gesture: ExpenseWorkbenchOpenGesture,
  sender: WebContents,
  senderGeneration: number,
): ExpenseWorkbenchOpenTicket {
  const token = `ewopen_${crypto.randomBytes(32).toString('base64url')}`;
  const pageInstanceId = `ewpage_${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = Date.now() + EXPENSE_WORKBENCH_OPEN_TICKET_TTL_MS;
  const expiryTimer = setTimeout(() => expireOpenTicket(token), EXPENSE_WORKBENCH_OPEN_TICKET_TTL_MS);
  expiryTimer.unref?.();
  const ticket = {
    token,
    pageInstanceId,
    userId,
    agentId,
    gesture,
    sender,
    senderGeneration,
    expiresAt,
    expiryTimer,
  } satisfies ExpenseWorkbenchOpenTicket;
  openTickets.set(token, ticket);
  bindSenderCleanup(sender);
  return ticket;
}

function issueCapability(ticket: ExpenseWorkbenchOpenTicket): ExpenseWorkbenchCapability {
  const token = `ewcap_${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = Date.now() + EXPENSE_WORKBENCH_CAPABILITY_TTL_MS;
  const expiryTimer = setTimeout(() => expireCapability(token), EXPENSE_WORKBENCH_CAPABILITY_TTL_MS);
  expiryTimer.unref?.();
  const capability = {
    token,
    pageInstanceId: ticket.pageInstanceId,
    userId: ticket.userId,
    agentId: ticket.agentId,
    managementSurface: EXPENSE_WORKBENCH_SURFACE,
    sender: ticket.sender,
    expiresAt,
    expiryTimer,
    usedRequestNonces: new Set<string>(),
  } satisfies ExpenseWorkbenchCapability;
  capabilities.set(token, capability);
  return capability;
}

function requireOnlyKeys(payload: object, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(payload).some((key) => !allowedKeys.has(key))) {
    throw capabilityError('invalid expense workbench management-surface request');
  }
}

function requireCapabilityToken(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || !EXPENSE_WORKBENCH_CAPABILITY_PATTERN.test(value)) {
    throw capabilityError('expense workbench host capability is required');
  }
  return value;
}

function requirePattern(
  value: JsonValue | undefined,
  pattern: RegExp,
  message: string,
): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw capabilityError(message);
  return value;
}

function requireOpenGesture(value: JsonValue | undefined): ExpenseWorkbenchOpenGesture {
  if (value !== 'agent_card' && value !== 'agent_detail') {
    throw capabilityError('invalid expense workbench open gesture');
  }
  return value;
}

function requireCapabilityEnvelope(
  payload: CapabilityPayload,
  expectedOperationScope: string,
): { token: string; pageInstanceId: string; requestNonce: string } {
  const token = requireCapabilityToken(payload.host_capability);
  const pageInstanceId = requirePattern(
    payload.page_instance,
    EXPENSE_WORKBENCH_PAGE_INSTANCE_PATTERN,
    'expense workbench page instance is required',
  );
  const requestNonce = requirePattern(
    payload.request_nonce,
    EXPENSE_WORKBENCH_REQUEST_NONCE_PATTERN,
    'expense workbench request nonce is required',
  );
  const operationScope = requirePattern(
    payload.operation_scope,
    EXPENSE_WORKBENCH_OPERATION_SCOPE_PATTERN,
    'expense workbench operation scope is required',
  );
  if (operationScope !== expectedOperationScope) {
    throw capabilityError('expense workbench operation scope does not match the request');
  }
  return { token, pageInstanceId, requestNonce };
}

async function requireCapability(
  payload: CapabilityPayload,
  ctx: ExpenseContext,
  expectedOperationScope: string,
): Promise<ExpenseWorkbenchCapability> {
  const { token, pageInstanceId, requestNonce } = requireCapabilityEnvelope(
    payload,
    expectedOperationScope,
  );
  const capability = capabilities.get(token);
  if (!capability || capability.sender !== ctx.sender
      || capability.managementSurface !== EXPENSE_WORKBENCH_SURFACE
      || capability.pageInstanceId !== pageInstanceId) {
    throw capabilityError('expense workbench host capability is invalid or revoked');
  }
  await requireCapabilityStillCurrent(capability, ctx.userId);
  if (capability.usedRequestNonces.has(requestNonce)) {
    throw capabilityError('expense workbench request nonce has already been used');
  }
  if (capability.usedRequestNonces.size >= MAX_CAPABILITY_REQUESTS) {
    await invalidateCapability(capability, 'request-limit');
    throw capabilityError('expense workbench capability request limit was exceeded');
  }
  // Reserve before awaiting Agent validation so concurrent replays cannot
  // both pass the one-time request boundary.
  capability.usedRequestNonces.add(requestNonce);
  try {
    await assertCanonicalExpenseWorkbenchAgent(capability.userId, capability.agentId);
  } catch (error) {
    await invalidateCapability(capability, 'canonical-agent-invalid');
    throw error;
  }
  await requireCapabilityStillCurrent(capability, ctx.userId);
  return capability;
}

async function invalidateCapability(
  capability: ExpenseWorkbenchCapability,
  reason: string,
): Promise<void> {
  if (!clearCapability(capability.token)) return;
  try {
    await closeExpenseWorkbenchSessions(capability.userId);
  } catch (error) {
    log.warn('failed to close invalidated expense workbench session', {
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function requireCapabilityStillCurrent(
  capability: ExpenseWorkbenchCapability,
  contextUserId: string,
): Promise<void> {
  if (capabilities.get(capability.token) !== capability) {
    throw capabilityError('expense workbench host capability is invalid or revoked');
  }
  if (capability.userId !== contextUserId || getActiveUserId() !== capability.userId) {
    await invalidateCapability(capability, 'active-user-changed');
    throw capabilityError('expense workbench host capability belongs to a different active user');
  }
  if (capability.expiresAt <= Date.now()) {
    await invalidateCapability(capability, 'expired');
    throw capabilityError('expense workbench host capability has expired');
  }
}

async function revokeCapability(
  payload: CapabilityPayload,
  ctx: ExpenseContext,
): Promise<ExpenseWorkbenchCapability> {
  const { token, pageInstanceId, requestNonce } = requireCapabilityEnvelope(payload, 'close');
  const capability = capabilities.get(token);
  if (!capability || capability.sender !== ctx.sender
      || capability.pageInstanceId !== pageInstanceId
      || capability.usedRequestNonces.has(requestNonce)) {
    throw capabilityError('expense workbench host capability is invalid or revoked');
  }
  capability.usedRequestNonces.add(requestNonce);
  clearCapability(token);
  return capability;
}

function hostOpenError(error: unknown): { ok: false; error: string; code: string } {
  const message = error instanceof Error ? error.message : String(error);
  const rawCode = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return {
    ok: false,
    error: message,
    code: typeof rawCode === 'string' && rawCode ? rawCode : 'E_EXPENSE_WORKBENCH_OPEN',
  };
}

export function registerExpenseWorkbenchHostIpc(): void {
  if (hostIpcRegistered) return;
  hostIpcRegistered = true;
  ipcMain.handle(EXPENSE_WORKBENCH_HOST_PREPARE_OPEN_CHANNEL, async (event, request: unknown) => {
    if (!isTrustedIpcSender(event.sender)) {
      return { ok: false, error: 'untrusted ipc sender', code: 'E_IPC_SENDER' };
    }
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw capabilityError('invalid expense workbench open-ticket request');
      }
      requireOnlyKeys(request, ['agent_id', 'gesture']);
      const prepared = request as { agent_id?: JsonValue; gesture?: JsonValue };
      const agentId = requireAgentId(prepared.agent_id);
      const gesture = requireOpenGesture(prepared.gesture);
      const userId = getActiveUserId();
      bindSenderCleanup(event.sender);
      const senderGeneration = senderAuthorizationGeneration(event.sender);
      await assertCanonicalExpenseWorkbenchAgent(userId, agentId);
      if (senderAuthorizationGeneration(event.sender) !== senderGeneration
          || getActiveUserId() !== userId) {
        throw capabilityError('expense workbench open request was revoked during validation');
      }
      revokeSenderOpenTickets(event.sender);
      const ticket = issueOpenTicket(userId, agentId, gesture, event.sender, senderGeneration);
      return {
        ok: true,
        open_ticket: ticket.token,
        page_instance: ticket.pageInstanceId,
        expires_at: new Date(ticket.expiresAt).toISOString(),
      };
    } catch (error) {
      return hostOpenError(error);
    }
  });
  ipcMain.handle(EXPENSE_WORKBENCH_HOST_OPEN_CHANNEL, async (event, request: unknown) => {
    if (!isTrustedIpcSender(event.sender)) {
      return { ok: false, error: 'untrusted ipc sender', code: 'E_IPC_SENDER' };
    }
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw capabilityError('invalid expense workbench management-surface open request');
      }
      requireOnlyKeys(request, ['open_ticket', 'page_instance']);
      const prepared = request as { open_ticket?: JsonValue; page_instance?: JsonValue };
      const openTicketToken = requirePattern(
        prepared.open_ticket,
        EXPENSE_WORKBENCH_OPEN_TICKET_PATTERN,
        'expense workbench open ticket is required',
      );
      const pageInstanceId = requirePattern(
        prepared.page_instance,
        EXPENSE_WORKBENCH_PAGE_INSTANCE_PATTERN,
        'expense workbench page instance is required',
      );
      // Consume before asynchronous validation so a failed or concurrent open
      // can never replay the same user-gesture authorization.
      const ticket = clearOpenTicket(openTicketToken);
      if (!ticket || ticket.sender !== event.sender || ticket.pageInstanceId !== pageInstanceId) {
        throw capabilityError('expense workbench open ticket is invalid or already used');
      }
      if (ticket.senderGeneration !== senderAuthorizationGeneration(event.sender)) {
        throw capabilityError('expense workbench open ticket was revoked by renderer navigation');
      }
      const userId = getActiveUserId();
      if (ticket.expiresAt <= Date.now() || ticket.userId !== userId) {
        throw capabilityError('expense workbench open ticket has expired or belongs to another user');
      }
      await assertCanonicalExpenseWorkbenchAgent(userId, ticket.agentId);
      if (ticket.senderGeneration !== senderAuthorizationGeneration(event.sender)
          || getActiveUserId() !== userId) {
        throw capabilityError('expense workbench open request was revoked during validation');
      }
      await revokeSenderCapabilities(event.sender, 'management-surface-reopened');
      if (ticket.senderGeneration !== senderAuthorizationGeneration(event.sender)
          || getActiveUserId() !== userId) {
        throw capabilityError('expense workbench open request was revoked before activation');
      }
      const capability = issueCapability(ticket);
      return {
        ok: true,
        host_capability: capability.token,
        expires_at: new Date(capability.expiresAt).toISOString(),
        management_surface: capability.managementSurface,
      };
    } catch (error) {
      return hostOpenError(error);
    }
  });
}

function localized(key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}

function requireAgentId(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error('invalid agent_id');
  return value.trim();
}

function requirePayload(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('payload must be an object');
  return value;
}

function requireApplicationId(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error('invalid application_id');
  return value;
}

function requireVersion(value: JsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error('invalid application version');
  return value;
}

function requirePayloadHash(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) throw new Error('invalid payload hash');
  return value.toLowerCase();
}

function formatLocalized(
  key: string,
  fallback: string,
  replacements: Readonly<Record<string, string>>,
): string {
  let value = localized(key, fallback);
  for (const [name, replacement] of Object.entries(replacements)) {
    value = value.replaceAll(`{${name}}`, replacement);
  }
  return value;
}

function maskedPayloadHash(payloadHash: string): string {
  return `${payloadHash.slice(0, 12)}…${payloadHash.slice(-12)}`;
}

function requireExpenseWorkbenchWindow(sender: WebContents): BrowserWindow {
  const parent = BrowserWindow.fromWebContents(sender);
  if (!parent || parent.isDestroyed()) {
    throw new Error(localized(
      'expense_workbench.window.unavailable',
      '无法确认当前报销工作台窗口，本次操作已取消。',
    ));
  }
  return parent;
}

function submissionConfirmationOptions(
  applicationId: string,
  version: number,
  payloadHash: string,
): MessageBoxOptions {
  const target = localized('expense_workbench.submit_confirmation.target', 'Feishu / OA');
  const replacements = {
    target,
    application: applicationId,
    version: String(version),
    hash: maskedPayloadHash(payloadHash),
  };
  return {
    type: 'warning',
    buttons: [
      localized('expense_workbench.submit_confirmation.cancel', '取消'),
      localized('expense_workbench.submit_confirmation.confirm', '提交到飞书 / OA'),
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: localized('expense_workbench.submit_confirmation.title', '确认提交报销申请'),
    message: formatLocalized(
      'expense_workbench.submit_confirmation.message',
      '确认将这份报销申请提交到 {target}？',
      replacements,
    ),
    detail: formatLocalized(
      'expense_workbench.submit_confirmation.detail',
      '外部目标：{target}\n报销申请：{application}\n版本：v{version}\n负载指纹：{hash}\n\n外发影响：报销数据将离开本应用，并在飞书中新建或推进 OA 审批请求。\n人工审批：此操作不等于审批通过或付款，仍需人工审批人在飞书 / OA 中审核。',
      replacements,
    ),
  };
}

async function requireSubmissionConfirmation(
  applicationId: string,
  version: number,
  payloadHash: string,
  sender: WebContents,
): Promise<void> {
  if (!dialog || typeof dialog.showMessageBox !== 'function') {
    throw new Error(localized(
      'expense_workbench.submit_confirmation.unavailable',
      '无法显示安全提交确认，本次未提交。',
    ));
  }

  let response: Awaited<ReturnType<typeof dialog.showMessageBox>>;
  try {
    response = await dialog.showMessageBox(
      requireExpenseWorkbenchWindow(sender),
      submissionConfirmationOptions(applicationId, version, payloadHash),
    );
  } catch (cause) {
    throw new Error(localized(
      'expense_workbench.submit_confirmation.unavailable',
      '无法显示安全提交确认，本次未提交。',
    ), { cause });
  }

  if (!response || response.response !== 1) {
    throw new Error(localized(
      'expense_workbench.submit_confirmation.cancelled',
      '用户已取消提交，未向飞书 / OA 发送数据。',
    ));
  }
}

function requireExternalPayload(
  operation: ExpenseWorkbenchExternalOperation,
  value: JsonValue | undefined,
): JsonObject {
  const payload = requirePayload(value);
  if (operation.startsWith('applications.')) {
    if (Object.keys(payload).some((key) => key !== 'application_id')) {
      throw new Error('external application operation accepts only application_id');
    }
    return { application_id: requireApplicationId(payload.application_id) };
  }
  if (Object.keys(payload).length !== 0) throw new Error('external settings operation payload must be empty');
  return {};
}

function confirmationOptions(
  operation: ExpenseWorkbenchExternalOperation,
  applicationId: string | undefined,
  secondConfirmation: boolean,
): MessageBoxOptions {
  const notice = EXTERNAL_OPERATION_NOTICES[operation];
  const target = localized(notice.targetKey, notice.targetFallback);
  const action = localized(notice.actionKey, notice.actionFallback);
  const consequence = localized(notice.consequenceKey, notice.consequenceFallback);
  const subject = applicationId ? `\n${localized('expense_workbench.external.application', '报销申请')}：${applicationId}` : '';
  return {
    type: secondConfirmation ? 'warning' : 'info',
    buttons: [
      localized('expense_workbench.external.cancel', '取消'),
      secondConfirmation
        ? localized('expense_workbench.external.confirm_again', '再次确认执行')
        : localized('expense_workbench.external.allow', '允许访问'),
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: secondConfirmation
      ? localized('expense_workbench.external.second_title', '外部操作二次确认')
      : localized('expense_workbench.external.title', '确认访问外部系统'),
    message: secondConfirmation
      ? localized('expense_workbench.external.message_again', '请再次确认：将访问 {target}').replace('{target}', target)
      : localized('expense_workbench.external.message', '将访问 {target}').replace('{target}', target),
    detail: localized('expense_workbench.external.detail', '操作：{action}{subject}\n影响：{consequence}')
      .replace('{action}', action)
      .replace('{subject}', subject)
      .replace('{consequence}', consequence),
  };
}

async function confirmExternalOperation(
  operation: ExpenseWorkbenchExternalOperation,
  payload: JsonObject,
  sender: WebContents,
): Promise<boolean> {
  if (!dialog || typeof dialog.showMessageBox !== 'function') {
    throw new Error('无法显示外部访问确认，操作已取消');
  }
  const applicationId = typeof payload.application_id === 'string' ? payload.application_id : undefined;
  const parent = requireExpenseWorkbenchWindow(sender);
  const first = await dialog.showMessageBox(parent, confirmationOptions(operation, applicationId, false));
  if (first.response !== 1) return false;
  if (!isExpenseWorkbenchExternalSideEffectOperation(operation)) return true;
  const second = await dialog.showMessageBox(parent, confirmationOptions(operation, applicationId, true));
  return second.response === 1;
}

export const invokeHandlers = {
  'expenseWorkbench.status': async (payload: PickAndConfigurePayload, ctx: ExpenseContext) => {
    requireOnlyKeys(payload, CAPABILITY_ENVELOPE_KEYS);
    const capability = await requireCapability(payload, ctx, 'status');
    return getExpenseProjectStatus(capability.userId);
  },

  'expenseWorkbench.pickAndConfigure': async (payload: PickAndConfigurePayload, ctx: ExpenseContext) => {
    requireOnlyKeys(payload, CAPABILITY_ENVELOPE_KEYS);
    const capability = await requireCapability(payload, ctx, 'configure');
    const parent = requireExpenseWorkbenchWindow(ctx.sender);
    const options: Electron.OpenDialogOptions = {
      title: localized('expense_workbench.project.pick_title', '选择报销智能体项目目录'),
      properties: ['openDirectory'],
    };
    const selected = await dialog.showOpenDialog(parent, options);
    await requireCapabilityStillCurrent(capability, ctx.userId);
    if (selected.canceled || selected.filePaths.length !== 1) {
      return { cancelled: true, ...getExpenseProjectStatus(capability.userId) };
    }
    const status = await configureExpenseProject(
      capability.userId,
      selected.filePaths[0],
      capability.agentId,
    );
    return { cancelled: false, ...status };
  },

  'expenseWorkbench.invoke': async (payload: InvokePayload, ctx: ExpenseContext) => {
    requireOnlyKeys(payload, [...CAPABILITY_ENVELOPE_KEYS, 'operation', 'payload']);
    if (typeof payload?.operation !== 'string' || !isExpenseWorkbenchOperation(payload.operation)) {
      throw new Error('invalid expense workbench operation');
    }
    const capability = await requireCapability(payload, ctx, `invoke:${payload.operation}`);
    if (isExpenseWorkbenchHostConfirmationOperation(payload.operation)) {
      throw new Error('请使用人工确认后的显式提交入口');
    }
    if (isExpenseWorkbenchReviewOperation(payload.operation)) {
      throw new Error('人工复核决策需要独立的身份与确认入口');
    }
    if (isExpenseWorkbenchUnsupportedOperation(payload.operation)) {
      throw new Error('当前 Mate 工作台不允许修改报销连接配置');
    }
    if (isExpenseWorkbenchExternalOperation(payload.operation)) {
      throw new Error('外部系统操作必须使用显式确认入口');
    }
    if (payload.operation === 'materials.add' || payload.operation === 'materials.addAndBind') {
      throw new Error('报销材料必须通过主进程专用选择入口登记');
    }
    return callExpenseWorkbench(
      capability.userId,
      capability.agentId,
      payload.operation,
      requirePayload(payload?.payload),
    );
  },

  'expenseWorkbench.invokeExternal': async (payload: InvokePayload, ctx: ExpenseContext) => {
    requireOnlyKeys(payload, [...CAPABILITY_ENVELOPE_KEYS, 'operation', 'payload']);
    if (typeof payload?.operation !== 'string' || !isExpenseWorkbenchOperation(payload.operation)
      || !isExpenseWorkbenchExternalOperation(payload.operation)) {
      throw new Error('invalid external expense workbench operation');
    }
    const capability = await requireCapability(payload, ctx, `external:${payload.operation}`);
    if (!isExpenseWorkbenchExplicitExternalOperation(payload.operation)) {
      throw new Error('该外部操作尚无安全界面入口，已拒绝执行');
    }
    const externalPayload = requireExternalPayload(payload.operation, payload.payload);
    const confirmed = await confirmExternalOperation(payload.operation, externalPayload, ctx.sender);
    await requireCapabilityStillCurrent(capability, ctx.userId);
    if (!confirmed) {
      throw new Error('用户已取消外系统操作');
    }
    return callExpenseWorkbench(
      capability.userId,
      capability.agentId,
      payload.operation,
      externalPayload,
    );
  },

  'expenseWorkbench.pickAndAddMaterials': async (payload: PickAndAddMaterialsPayload, ctx: ExpenseContext) => {
    requireOnlyKeys(payload, [...CAPABILITY_ENVELOPE_KEYS, 'application_id']);
    const applicationId = requireApplicationId(payload?.application_id);
    const capability = await requireCapability(payload, ctx, `materials:add:${applicationId}`);
    const target = await assertExpenseMaterialTarget(
      capability.userId,
      capability.agentId,
      applicationId,
    );
    await requireCapabilityStillCurrent(capability, ctx.userId);

    const parent = requireExpenseWorkbenchWindow(ctx.sender);
    const options: Electron.OpenDialogOptions = {
      title: localized('expense_workbench.material.pick_title', '选择报销材料'),
      properties: ['openFile', 'multiSelections'],
      filters: [{
        name: localized('expense_workbench.material.filter_name', '报销材料'),
        extensions: ['pdf', 'png', 'jpg', 'jpeg', 'heic'],
      }],
    };
    const selected = await dialog.showOpenDialog(parent, options);
    await requireCapabilityStillCurrent(capability, ctx.userId);
    if (selected.canceled || !selected.filePaths.length) {
      return { cancelled: true, materials: [], failed: [] };
    }
    const result = await addAndBindExpenseMaterialsFromPaths(
      capability.userId,
      capability.agentId,
      applicationId,
      selected.filePaths,
      target,
    );
    return { cancelled: false, ...result };
  },

  'expenseWorkbench.confirmAndSubmit': async (payload: ConfirmAndSubmitPayload, ctx: ExpenseContext) => {
    requireOnlyKeys(payload, [
      ...CAPABILITY_ENVELOPE_KEYS,
      'application_id',
      'version',
      'payload_hash',
    ]);
    const applicationId = requireApplicationId(payload?.application_id);
    const version = requireVersion(payload?.version);
    const payloadHash = requirePayloadHash(payload?.payload_hash);
    const capability = await requireCapability(
      payload,
      ctx,
      `submit:${applicationId}:${version}:${payloadHash}`,
    );
    await requireSubmissionConfirmation(applicationId, version, payloadHash, ctx.sender);
    await requireCapabilityStillCurrent(capability, ctx.userId);
    return confirmAndSubmitExpenseWorkbench(capability.userId, {
      agentId: capability.agentId,
      applicationId,
      version,
      payloadHash,
    });
  },

  'expenseWorkbench.close': async (payload: PickAndConfigurePayload, ctx: ExpenseContext) => {
    requireOnlyKeys(payload, CAPABILITY_ENVELOPE_KEYS);
    const capability = await revokeCapability(payload, ctx);
    await closeExpenseWorkbenchSessions(capability.userId);
    return { closed: true };
  },
};
