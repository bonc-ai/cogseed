import { randomUUID } from 'node:crypto';

import * as lark from '@larksuiteoapi/node-sdk';

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { logErrorSummary } from '../../util/log-redact';
import * as manager from './manager';
import type {
  FeishuTenantBrand,
  MessagingInstanceClient,
  MessagingPolicy,
  WorkspaceScope,
} from './types';
import { isValidFeishuAppId } from './types';

const log = createLogger('messaging:feishu-registration');
const FLOW_RETENTION_MS = 10 * 60 * 1000;
const QR_MIN_LIFETIME_SECONDS = 30;
const QR_MAX_LIFETIME_SECONDS = 60 * 60;
const ALLOWED_QR_HOSTS = new Set(['accounts.feishu.cn', 'accounts.larksuite.com']);
const STALE_INSTANCE_CLEANUP_DELAYS_MS = [0, 50, 150] as const;

export type FeishuRegistrationState =
  | 'starting'
  | 'awaiting_scan'
  | 'polling'
  | 'slow_down'
  | 'domain_switched'
  | 'activating'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'denied'
  | 'failed';

export type FeishuRegistrationErrorCode =
  | 'access_denied'
  | 'expired_token'
  | 'abort'
  | 'activation_failed'
  | 'invalid_response'
  | 'network_error'
  | 'registration_failed';

export interface FeishuRegistrationDraft {
  displayName: string;
  workspace?: WorkspaceScope;
  policy?: Partial<MessagingPolicy>;
}

export interface FeishuRegistrationStatus {
  flowId: string;
  state: FeishuRegistrationState;
  qrUrl?: string;
  expiresAt?: string;
  intervalSeconds?: number;
  errorCode?: FeishuRegistrationErrorCode;
  instance?: MessagingInstanceClient;
}

interface RegistrationFlow {
  readonly uid: string;
  readonly flowId: string;
  readonly draft: FeishuRegistrationDraft;
  readonly controller: AbortController;
  state: FeishuRegistrationState;
  qrUrl?: string;
  expiresAt?: number;
  // Keep the authorization deadline after the QR presentation fields are
  // cleared. Activation can still be in flight when the QR expires.
  authorizationExpiresAt?: number;
  intervalSeconds?: number;
  errorCode?: FeishuRegistrationErrorCode;
  instance?: MessagingInstanceClient;
  finishedAt?: number;
}

interface SdkErrorLike {
  code?: string;
}

const APP_ADDONS = {
  // The minimal official preset is enough for this local two-way gateway:
  // send bot messages and receive the event over Feishu's persistent channel.
  preset: false,
  scopes: { tenant: ['im:message:send_as_bot'] },
  events: { items: { tenant: ['im.message.receive_v1'] } },
} satisfies lark.AppAddons;

const flows = new Map<string, RegistrationFlow>();
const retiredFlows = new Map<string, RegistrationFlow>();

function flowKey(uid: string, flowId: string): string {
  return `${uid}\u0000${flowId}`;
}

function pruneRetiredFlows(): void {
  const cutoff = Date.now() - FLOW_RETENTION_MS;
  for (const [key, flow] of retiredFlows) {
    if (flow.finishedAt !== undefined && flow.finishedAt < cutoff) retiredFlows.delete(key);
  }
}

function retainFlow(flow: RegistrationFlow): void {
  retiredFlows.set(flowKey(flow.uid, flow.flowId), flow);
}

function releaseRetainedFlow(flow: RegistrationFlow): void {
  retiredFlows.delete(flowKey(flow.uid, flow.flowId));
}

function assertUserId(uid: string): void {
  if (!safeId(uid)) throw new Error('invalid user id');
}

function assertDraft(draft: FeishuRegistrationDraft): FeishuRegistrationDraft {
  if (!draft || typeof draft !== 'object') throw new Error('invalid Feishu registration draft');
  if (typeof draft.displayName !== 'string') throw new Error('display name required');
  const displayName = draft.displayName.trim();
  if (!displayName) throw new Error('display name required');
  if (displayName.length > 120) throw new Error('display name too long');
  if (draft.workspace !== undefined && (!draft.workspace || typeof draft.workspace !== 'object')) {
    throw new Error('invalid workspace');
  }
  if (draft.policy !== undefined && (!draft.policy || typeof draft.policy !== 'object')) {
    throw new Error('invalid policy');
  }
  return { ...draft, displayName };
}

function pruneFlow(uid: string): RegistrationFlow | undefined {
  pruneRetiredFlows();
  const flow = flows.get(uid);
  if (!flow) return undefined;
  if (flow.finishedAt !== undefined && Date.now() - flow.finishedAt > FLOW_RETENTION_MS) {
    flows.delete(uid);
    return undefined;
  }
  return flow;
}

function isCurrent(flow: RegistrationFlow): boolean {
  return flows.get(flow.uid) === flow;
}

function isAwaitingAuthorization(flow: RegistrationFlow): boolean {
  return flow.state === 'starting'
    || flow.state === 'awaiting_scan'
    || flow.state === 'polling'
    || flow.state === 'slow_down'
    || flow.state === 'domain_switched';
}

function isPending(flow: RegistrationFlow): boolean {
  return isAwaitingAuthorization(flow) || flow.state === 'activating';
}

function abortFlow(flow: RegistrationFlow, reason: string): void {
  try {
    flow.controller.abort();
  } catch (error) {
    log.warn('Feishu registration abort failed', {
      flowId: flow.flowId,
      reason,
      error: logErrorSummary(error),
    });
  }
}

/**
 * Move a still-running flow to the terminal expired state once its QR grant
 * is no longer valid. This is called at every async boundary in activation,
 * so a late SDK result can never create or enable a robot.
 */
function expireIfNeeded(flow: RegistrationFlow): boolean {
  if (!isCurrent(flow) || !isPending(flow) || flow.authorizationExpiresAt === undefined) return false;
  if (Date.now() < flow.authorizationExpiresAt) return false;
  finish(flow, 'expired', 'expired_token');
  abortFlow(flow, 'authorization_expired');
  return true;
}

function canActivate(flow: RegistrationFlow): boolean {
  if (!isCurrent(flow) || flow.state !== 'activating' || flow.controller.signal.aborted) return false;
  return !expireIfNeeded(flow);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearSensitiveFlowState(flow: RegistrationFlow): void {
  flow.qrUrl = undefined;
  flow.expiresAt = undefined;
  flow.intervalSeconds = undefined;
}

function finish(flow: RegistrationFlow, state: FeishuRegistrationState, errorCode?: FeishuRegistrationErrorCode): void {
  flow.state = state;
  flow.errorCode = errorCode;
  flow.finishedAt = Date.now();
  clearSensitiveFlowState(flow);
  flow.authorizationExpiresAt = undefined;
}

function cancelFlow(flow: RegistrationFlow): void {
  if (!isPending(flow)) return;
  finish(flow, 'cancelled');
  abortFlow(flow, 'user_cancelled');
}

function qrUrl(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('invalid QR URL');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error('invalid QR URL');
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_QR_HOSTS.has(parsed.hostname)
    || parsed.username || parsed.password || parsed.hash) {
    throw new Error('untrusted QR URL');
  }
  return parsed.toString();
}

function lifetimeSeconds(value: number): number {
  if (!Number.isFinite(value)) return 600;
  return Math.max(QR_MIN_LIFETIME_SECONDS, Math.min(QR_MAX_LIFETIME_SECONDS, Math.floor(value)));
}

function sdkErrorCode(error: unknown): FeishuRegistrationErrorCode {
  let code = '';
  if (error instanceof Error) code = error.name === 'AbortError' ? 'abort' : '';
  else if (typeof error === 'object' && error !== null && 'code' in error) {
    const candidate = (error as SdkErrorLike).code;
    if (typeof candidate === 'string') code = candidate;
  }
  if (code === 'access_denied' || code === 'expired_token' || code === 'abort') return code;
  if (code === 'activation_failed' || code === 'invalid_response' || code === 'network_error') return code;
  return code ? 'registration_failed' : 'network_error';
}

function publicStatus(flow: RegistrationFlow): FeishuRegistrationStatus {
  return {
    flowId: flow.flowId,
    state: flow.state,
    ...(flow.qrUrl ? { qrUrl: flow.qrUrl } : {}),
    ...(flow.expiresAt ? { expiresAt: new Date(flow.expiresAt).toISOString() } : {}),
    ...(flow.intervalSeconds ? { intervalSeconds: flow.intervalSeconds } : {}),
    ...(flow.errorCode ? { errorCode: flow.errorCode } : {}),
    ...(flow.instance ? { instance: flow.instance } : {}),
  };
}

function registrationDomain(brand: FeishuTenantBrand | undefined): FeishuTenantBrand {
  return brand === 'lark' ? 'lark' : 'feishu';
}

async function removeStaleInstance(uid: string, instanceId: string): Promise<void> {
  let lastError: unknown;
  for (const delay of STALE_INSTANCE_CLEANUP_DELAYS_MS) {
    if (delay) await wait(delay);
    try {
      await manager.deleteInstance(uid, instanceId);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  log.error('stale Feishu registration instance cleanup failed', {
    instanceId,
    error: logErrorSummary(lastError),
  });
  throw new Error('unable to remove stale Feishu registration instance', { cause: lastError });
}

async function discardCreatedInstance(flow: RegistrationFlow, instance: MessagingInstanceClient): Promise<boolean> {
  try {
    await removeStaleInstance(flow.uid, instance.id);
    if (isCurrent(flow) && flow.instance?.id === instance.id) flow.instance = undefined;
    if (!isCurrent(flow)) releaseRetainedFlow(flow);
    return true;
  } catch (error) {
    // Keep only the manager's metadata DTO in the public flow. The app secret
    // is never copied to a status object or included in the diagnostic log.
    log.error('Feishu registration compensation requires manual cleanup', {
      flowId: flow.flowId,
      instanceId: instance.id,
      current: isCurrent(flow),
      error: logErrorSummary(error),
    });
    if (isCurrent(flow)) {
      flow.instance = instance;
      finish(flow, 'failed', 'activation_failed');
    } else {
      flow.instance = instance;
      finish(flow, 'failed', 'activation_failed');
      retainFlow(flow);
    }
    return false;
  }
}

async function runRegistration(flow: RegistrationFlow): Promise<void> {
  try {
    const result = await lark.registerApp({
      source: 'desktop-messaging',
      signal: flow.controller.signal,
      createOnly: true,
      appPreset: { name: flow.draft.displayName },
      addons: APP_ADDONS,
      onQRCodeReady: (info) => {
        if (!isCurrent(flow) || !isAwaitingAuthorization(flow)) return;
        try {
          flow.qrUrl = qrUrl(info.url);
          const expiresAt = Date.now() + lifetimeSeconds(info.expireIn) * 1000;
          flow.expiresAt = expiresAt;
          flow.authorizationExpiresAt = expiresAt;
          flow.state = 'awaiting_scan';
        } catch (error) {
          finish(flow, 'failed', 'invalid_response');
          abortFlow(flow, 'invalid_qr_response');
        }
      },
      onStatusChange: (info) => {
        if (!isCurrent(flow) || !isAwaitingAuthorization(flow)) return;
        if (info.status === 'polling' || info.status === 'slow_down' || info.status === 'domain_switched') {
          flow.state = info.status;
          if (typeof info.interval === 'number' && Number.isFinite(info.interval)) {
            flow.intervalSeconds = Math.max(1, Math.min(600, Math.floor(info.interval)));
          }
        }
      },
    });

    if (!isCurrent(flow) || !isAwaitingAuthorization(flow)) return;
    if (expireIfNeeded(flow)) return;
    if (!result || typeof result.client_id !== 'string' || !isValidFeishuAppId(result.client_id.trim())
      || typeof result.client_secret !== 'string' || !result.client_secret.trim()) {
      finish(flow, 'failed', 'invalid_response');
      return;
    }

    const tenantBrand = registrationDomain(result.user_info?.tenant_brand);
    const appId = result.client_id.trim();
    const appSecret = result.client_secret.trim();
    flow.state = 'activating';
    clearSensitiveFlowState(flow);
    let created: MessagingInstanceClient | undefined;
    try {
      created = await manager.createInstance(flow.uid, {
        platform: 'feishu_lark',
        feishuTenantBrand: tenantBrand,
        displayName: flow.draft.displayName,
        workspace: flow.draft.workspace,
        policy: flow.draft.policy,
        secret: { appId, appSecret },
      });
      flow.instance = created;
      if (!canActivate(flow)) {
        await discardCreatedInstance(flow, created);
        return;
      }
      const enabled = await manager.setEnabled(flow.uid, created.id, true);
      flow.instance = enabled;
      if (!canActivate(flow)) {
        await discardCreatedInstance(flow, enabled);
        return;
      }
      finish(flow, 'completed');
    } catch (error) {
      const expired = expireIfNeeded(flow);
      log.warn('Feishu registration activation failed', {
        flowId: flow.flowId,
        expired,
        error: logErrorSummary(error),
      });
      if (created) {
        const discarded = await discardCreatedInstance(flow, created);
        if (!discarded) return;
      }
      if (isCurrent(flow) && flow.state === 'activating' && !expired) {
        finish(flow, 'failed', 'activation_failed');
      }
    }
  } catch (error) {
    if (!isCurrent(flow) || !isPending(flow)) return;
    if (expireIfNeeded(flow)) return;
    const code = sdkErrorCode(error);
    if (code === 'expired_token') finish(flow, 'expired', code);
    else if (code === 'access_denied') finish(flow, 'denied', code);
    else if (code === 'abort') finish(flow, 'cancelled');
    else finish(flow, 'failed', code);
    log.warn('Feishu QR registration failed', {
      flowId: flow.flowId,
      code,
      error: logErrorSummary(error),
    });
  }
}

export async function startFeishuQrRegistration(
  uid: string,
  draft: FeishuRegistrationDraft,
): Promise<FeishuRegistrationStatus> {
  assertUserId(uid);
  const normalizedDraft = assertDraft(draft);
  const previous = pruneFlow(uid);
  if (previous) {
    const previousPending = isPending(previous);
    cancelFlow(previous);
    if (previousPending || previous.instance) retainFlow(previous);
  }
  const flow: RegistrationFlow = {
    uid,
    flowId: randomUUID(),
    draft: normalizedDraft,
    controller: new AbortController(),
    state: 'starting',
  };
  flows.set(uid, flow);
  void runRegistration(flow);
  return publicStatus(flow);
}

export function getFeishuQrRegistrationStatus(uid: string, flowId: string): FeishuRegistrationStatus {
  assertUserId(uid);
  if (!safeId(flowId)) throw new Error('invalid Feishu registration flow id');
  const current = pruneFlow(uid);
  const flow = current?.flowId === flowId
    ? current
    : retiredFlows.get(flowKey(uid, flowId));
  if (!flow) throw new Error('Feishu registration flow not found');
  expireIfNeeded(flow);
  return publicStatus(flow);
}

export function cancelFeishuQrRegistration(uid: string, flowId: string): FeishuRegistrationStatus {
  assertUserId(uid);
  if (!safeId(flowId)) throw new Error('invalid Feishu registration flow id');
  const current = pruneFlow(uid);
  const flow = current?.flowId === flowId
    ? current
    : retiredFlows.get(flowKey(uid, flowId));
  if (!flow) throw new Error('Feishu registration flow not found');
  cancelFlow(flow);
  return publicStatus(flow);
}

export const _feishuRegistrationTestHooks = {
  flows,
  qrUrl,
  lifetimeSeconds,
  publicStatus,
};
