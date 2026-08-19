import { randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { logErrorSummary } from '../../util/log-redact';
import * as manager from './manager';
import * as registry from './registry';
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
const ALLOWED_QR_HOSTS = new Set([
  // The official SDK serves its launcher QR from open.feishu.cn; the
  // accounts.* hosts are kept for historical/verification fixtures.
  'accounts.feishu.cn',
  'accounts.larksuite.com',
  'open.feishu.cn',
  'open.larksuite.com',
]);
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
  | 'network_unreachable'
  | 'network_timeout'
  | 'network_tls'
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

/** Shape of the official QR result that activation needs. Secrets stay in
 * main; the public flow never carries them. */
interface RegistrationResultLike {
  client_id: string;
  client_secret: string;
  user_info?: { tenant_brand?: string; open_id?: string; name?: string };
}

interface RegistrationActivation {
  /** Attach QR-issued credentials and return the active instance. Throws on
   * rejection so the whole flow fails instead of leaving a half-bound robot. */
  apply(flow: RegistrationFlow, result: RegistrationResultLike): Promise<MessagingInstanceClient>;
  /** Compensate a partially applied activation on cancel/expiry/race. The
   * draft itself must survive; only credentials/created instances are undone. */
  discard(flow: RegistrationFlow, instance: MessagingInstanceClient): Promise<void>;
}

interface RegistrationFlow {
  readonly uid: string;
  readonly flowId: string;
  readonly draft: FeishuRegistrationDraft;
  readonly controller: AbortController;
  /** Tenant selected by the settings channel. Draft-bound registration must
   * stay on this brand instead of silently moving between Feishu and Lark. */
  readonly tenantBrand: FeishuTenantBrand;
  /** Draft-bound flows register against an existing unbound instance. */
  readonly instanceId?: string;
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

/** Protocol-level failure (non-JSON response, unexpected payload) that must
 * surface as `invalid_response` instead of being misread as a network error
 * by the generic classification below. */
class RegistrationProtocolError extends Error {
  readonly code: FeishuRegistrationErrorCode = 'invalid_response';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RegistrationProtocolError';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Registration protocol (mirrors hermes-agent plugins/platforms/feishu/
// adapter.py _begin_registration/_poll_registration).
//
// The official node-sdk registerApp() polls without a `tp` parameter, and
// apps it creates come up without the event subscription configured, so the
// bot never receives messages. Hermes' flow carries `tp=ob_app` on the poll
// and marks the QR with `from=hermes&tp=hermes` (no addons preset); the
// platform then creates a fully configured bot application (event
// subscription included) and the scan-to-create flow is ready to use without
// touching the developer console.
// ────────────────────────────────────────────────────────────────────────────

const REGISTRATION_ACCOUNTS = {
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com',
} as const;

const REGISTRATION_ENDPOINT = '/oauth/v1/app/registration';

interface RegistrationBeginResult {
  deviceCode: string;
  verificationUriComplete: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

interface RegistrationPollResult {
  clientId?: string;
  clientSecret?: string;
  userInfo?: RegistrationResultLike['user_info'];
  error?: string;
  intervalSeconds?: number;
}

async function registrationFormPost(
  flow: RegistrationFlow,
  baseUrl: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetch(baseUrl + REGISTRATION_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: flow.controller.signal,
  });
  // The registration endpoint returns JSON even on 4xx (authorization_pending
  // comes back as HTTP 400), but a 5xx gateway/error page does not. Parse the
  // body explicitly so a non-JSON response surfaces as invalid_response
  // instead of a SyntaxError being misread as a network failure.
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RegistrationProtocolError('Feishu registration returned a non-JSON response', { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RegistrationProtocolError('Feishu registration returned an unexpected payload');
  }
  return parsed as Record<string, unknown>;
}

/** Verify the environment supports client_secret auth (mirrors hermes-agent
 * `_init_registration`). Raises if not supported. */
async function registrationInit(flow: RegistrationFlow): Promise<void> {
  const res = await _feishuRegistrationProtocol.formPost(flow, REGISTRATION_ACCOUNTS.feishu, {
    action: 'init',
  });
  const methods = Array.isArray(res.supported_auth_methods) ? res.supported_auth_methods : [];
  if (!methods.includes('client_secret')) {
    throw new Error('Feishu / Lark registration environment does not support client_secret auth');
  }
}

async function registrationBegin(flow: RegistrationFlow): Promise<RegistrationBeginResult> {
  const res = await _feishuRegistrationProtocol.formPost(flow, REGISTRATION_ACCOUNTS.feishu, {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  });
  const deviceCode = typeof res.device_code === 'string' ? res.device_code : '';
  const verificationUriComplete = typeof res.verification_uri_complete === 'string' ? res.verification_uri_complete : '';
  if (!deviceCode || !verificationUriComplete) {
    throw new Error('Feishu registration did not return a device_code');
  }
  return {
    deviceCode,
    verificationUriComplete,
    expiresInSeconds: typeof res.expires_in === 'number' ? res.expires_in : 600,
    intervalSeconds: typeof res.interval === 'number' ? res.interval : 5,
  };
}

async function registrationPoll(
  flow: RegistrationFlow,
  deviceCode: string,
  domain: keyof typeof REGISTRATION_ACCOUNTS,
): Promise<RegistrationPollResult> {
  const res = await _feishuRegistrationProtocol.formPost(flow, REGISTRATION_ACCOUNTS[domain], {
    action: 'poll',
    device_code: deviceCode,
    tp: 'ob_app',
  });
  return {
    clientId: typeof res.client_id === 'string' ? res.client_id : undefined,
    clientSecret: typeof res.client_secret === 'string' ? res.client_secret : undefined,
    userInfo: res.user_info as RegistrationResultLike['user_info'] | undefined,
    error: typeof res.error === 'string' ? res.error : undefined,
    intervalSeconds: typeof res.interval === 'number' ? res.interval : undefined,
  };
}

/** Replaceable transport for tests. */
export const _feishuRegistrationProtocol = {
  formPost: registrationFormPost,
  init: registrationInit,
  begin: registrationBegin,
  poll: registrationPoll,
};

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
  if (error instanceof Error) {
    if (error.name === 'AbortError') code = 'abort';
    else if (error instanceof RegistrationProtocolError) code = error.code;
    else {
      // A bare `TypeError: fetch failed` (cause lost through a wrapper) is
      // still a connectivity symptom; any other plain error is a
      // local/protocol failure, not a network one.
      code = classifyNetworkError(error)
        || (error.name === 'TypeError' && /fetch failed/.test(error.message) ? 'network_error' : 'registration_failed');
    }
  } else if (typeof error === 'object' && error !== null && 'code' in error) {
    const candidate = (error as SdkErrorLike).code;
    if (typeof candidate === 'string') code = candidate;
  }
  if (code === 'access_denied' || code === 'expired_token' || code === 'abort') return code;
  if (code === 'activation_failed' || code === 'invalid_response') return code;
  if (code === 'network_error' || code === 'network_unreachable' || code === 'network_timeout' || code === 'network_tls') {
    return code;
  }
  // Unknown or missing SDK code: a generic registration failure. The network
  // buckets are only reachable through explicit classification above.
  return 'registration_failed';
}

/** Classify undici/node network failures from the cause chain into a
 * user-visible hint. A bare `TypeError: fetch failed` carries the real cause
 * on `err.cause` (ENOTFOUND, ECONNREFUSED, ETIMEDOUT, UND_ERR_CONNECT_TIMEOUT,
 * CERT_HAS_EXPIRED, …); pi-ai-style wrappers may nest it one level deeper. */
function classifyNetworkError(error: unknown): FeishuRegistrationErrorCode | '' {
  let cause: unknown = error;
  const seen = new Set<unknown>();
  while (cause !== undefined && cause !== null && !seen.has(cause)) {
    seen.add(cause);
    const candidate = cause as { code?: unknown };
    const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
    if (code) {
      if (code.includes('CERT') || code.startsWith('DEPTH_') || code.startsWith('SELF_SIGNED') || code.startsWith('ERR_TLS')) {
        return 'network_tls';
      }
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED'
        || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENETDOWN'
        || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
        return 'network_unreachable';
      }
      if (code === 'ETIMEDOUT' || code.startsWith('UND_ERR_CONNECT') || code.startsWith('UND_ERR_HEADERS')
        || code.startsWith('UND_ERR_BODY') || code.startsWith('UND_ERR_RESPONSE')) {
        return 'network_timeout';
      }
      if (code.startsWith('UND_ERR_')) return 'network_error';
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return '';
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

function registrationBrand(brand: FeishuTenantBrand | undefined): FeishuTenantBrand {
  return brand === 'lark' ? 'lark' : 'feishu';
}

function activatedBrand(flow: RegistrationFlow, result: RegistrationResultLike): FeishuTenantBrand {
  const reported = result.user_info?.tenant_brand;
  const brand = reported === 'feishu' || reported === 'lark' ? reported : flow.tenantBrand;
  if (flow.instanceId && brand !== flow.tenantBrand) {
    throw new Error(`registration tenant brand mismatch: expected ${flow.tenantBrand}, received ${brand}`);
  }
  return brand;
}

function registrationOwner(result: RegistrationResultLike): { ownerExternalUserId: string; ownerExternalUserName?: string } {
  const ownerExternalUserId = typeof result.user_info?.open_id === 'string' ? result.user_info.open_id.trim() : '';
  if (!ownerExternalUserId) throw new Error('Feishu registration account identifier missing');
  const ownerExternalUserName = typeof result.user_info?.name === 'string' ? result.user_info.name.trim() : '';
  return {
    ownerExternalUserId,
    ...(ownerExternalUserName ? { ownerExternalUserName } : {}),
  };
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

async function discardCreatedInstance(
  flow: RegistrationFlow,
  instance: MessagingInstanceClient,
  activation: RegistrationActivation,
): Promise<boolean> {
  try {
    await activation.discard(flow, instance);
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
    flow.instance = instance;
    finish(flow, 'failed', 'activation_failed');
    // A superseded flow still keeps its terminal state queryable, so the
    // renderer can surface the cleanup failure after a newer flow took over.
    if (!isCurrent(flow)) retainFlow(flow);
    return false;
  }
}

/** Historical activation: the QR flow owns a brand-new instance. */
function newInstanceActivation(): RegistrationActivation {
  return {
    async apply(flow, result) {
      const tenantBrand = activatedBrand(flow, result);
      const owner = registrationOwner(result);
      return manager.createInstance(flow.uid, {
        platform: 'feishu_lark',
        feishuTenantBrand: tenantBrand,
        displayName: flow.draft.displayName,
        workspace: flow.draft.workspace,
        policy: flow.draft.policy,
        secret: { appId: result.client_id.trim(), appSecret: result.client_secret.trim() },
        ...owner,
        ownerIdentitySource: 'qr',
      });
    },
    async discard(flow, instance) {
      await removeStaleInstance(flow.uid, instance.id);
    },
  };
}

/** Draft-bound activation: bind credentials to the exact existing draft and
 * authorize the scanning account as the first allowed user. */
function draftActivation(uid: string, instanceId: string): RegistrationActivation {
  let boundSecret: { appId: string; appSecret: string } | null = null;
  return {
    async apply(flow, result) {
      const tenantBrand = activatedBrand(flow, result);
      const owner = registrationOwner(result);
      const secret = { appId: result.client_id.trim(), appSecret: result.client_secret.trim() };
      const bound = await registry.bindFeishuDraft(uid, instanceId, {
        feishuTenantBrand: tenantBrand,
        secret,
        initialAllowUserId: owner.ownerExternalUserId,
        ...owner,
      });
      boundSecret = secret;
      return bound;
    },
    async discard() {
      if (!boundSecret) return;
      await registry.revokeFeishuDraftCredentials(uid, instanceId, boundSecret);
    },
  };
}

async function runRegistration(flow: RegistrationFlow, activation: RegistrationActivation): Promise<void> {
  try {
    await _feishuRegistrationProtocol.init(flow);
    const begin = await _feishuRegistrationProtocol.begin(flow);
    // Present the QR: the official launcher URL tagged exactly like
    // hermes-agent (`from=hermes&tp=hermes`, no addons preset). The platform
    // creates a fully configured bot application from that tag; keep both
    // entry points on the official landing page: "立即创建" (create a fresh
    // app) and "已有应用" (reuse an app the scanning account already manages).
    // Omitting createOnly leaves the existing-app option enabled; either path
    // yields the same client_id/client_secret result that the activation
    // binds.
    const qrUrlValue = begin.verificationUriComplete.includes('?')
      ? `${begin.verificationUriComplete}&from=hermes&tp=hermes`
      : `${begin.verificationUriComplete}?from=hermes&tp=hermes`;
    if (!isCurrent(flow) || !isAwaitingAuthorization(flow)) return;
    try {
      flow.qrUrl = qrUrl(qrUrlValue);
      const expiresAt = Date.now() + lifetimeSeconds(begin.expiresInSeconds) * 1000;
      flow.expiresAt = expiresAt;
      flow.authorizationExpiresAt = expiresAt;
      flow.state = 'awaiting_scan';
    } catch (error) {
      finish(flow, 'failed', 'invalid_response');
      abortFlow(flow, 'invalid_qr_response');
      return;
    }

    // Poll until the scan is authorized. The poll carries `tp=ob_app` so the
    // platform creates a fully configured bot (event subscription included) —
    // mirrors hermes-agent. A Lark (global) tenant is detected through
    // user_info.tenant_brand; the poll then switches to the Lark accounts
    // domain once and keeps checking the same response (fall-through), so a
    // successful scan is never dropped.
    let domain: keyof typeof REGISTRATION_ACCOUNTS = 'feishu';
    let domainSwitched = false;
    let intervalMs = Math.max(1000, begin.intervalSeconds * 1000);
    while (isCurrent(flow) && isAwaitingAuthorization(flow) && !expireIfNeeded(flow)) {
      let result: RegistrationPollResult;
      try {
        result = await _feishuRegistrationProtocol.poll(flow, begin.deviceCode, domain);
      } catch (error) {
        // Transient network failure: keep polling until the authorization
        // deadline (expireIfNeeded above) stops the loop.
        if (!isCurrent(flow) || !isAwaitingAuthorization(flow) || expireIfNeeded(flow)) return;
        await wait(intervalMs);
        continue;
      }

      if (result.userInfo?.tenant_brand === 'lark' && !domainSwitched) {
        domain = 'lark';
        domainSwitched = true;
        if (!isCurrent(flow) || !isAwaitingAuthorization(flow)) return;
        flow.state = 'domain_switched';
      }

      // Success: the scanning account authorized the app creation.
      if (typeof result.clientId === 'string' && typeof result.clientSecret === 'string') {
        if (!isCurrent(flow) || !isAwaitingAuthorization(flow)) return;
        if (expireIfNeeded(flow)) return;
        if (!isValidFeishuAppId(result.clientId.trim()) || !result.clientSecret.trim()) {
          finish(flow, 'failed', 'invalid_response');
          return;
        }
        await activateCreatedApp(flow, activation, {
          client_id: result.clientId.trim(),
          client_secret: result.clientSecret.trim(),
          user_info: result.userInfo,
        });
        return;
      }

      switch (result.error) {
        case 'authorization_pending':
          if (!isCurrent(flow) || !isAwaitingAuthorization(flow)) return;
          flow.state = 'polling';
          break;
        case 'slow_down':
          intervalMs += 5000;
          if (!isCurrent(flow) || !isAwaitingAuthorization(flow)) return;
          flow.state = 'slow_down';
          flow.intervalSeconds = Math.max(1, Math.min(600, Math.floor(intervalMs / 1000)));
          break;
        case 'access_denied':
          finish(flow, 'denied', 'access_denied');
          return;
        case 'expired_token':
          finish(flow, 'expired', 'expired_token');
          return;
        default:
          if (result.error) {
            finish(flow, 'failed', 'registration_failed');
            return;
          }
          break;
      }
      await wait(intervalMs);
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

async function activateCreatedApp(
  flow: RegistrationFlow,
  activation: RegistrationActivation,
  result: RegistrationResultLike,
): Promise<void> {
  flow.state = 'activating';
  clearSensitiveFlowState(flow);
  let created: MessagingInstanceClient | undefined;
  try {
    if (!canActivate(flow)) return;
    created = await activation.apply(flow, result);
    flow.instance = created;
    if (!canActivate(flow)) {
      await discardCreatedInstance(flow, created, activation);
      return;
    }
    const enabled = await manager.setEnabled(flow.uid, created.id, true);
    flow.instance = enabled;
    if (!canActivate(flow)) {
      await discardCreatedInstance(flow, enabled, activation);
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
      const discarded = await discardCreatedInstance(flow, created, activation);
      if (!discarded) return;
    }
    if (isCurrent(flow) && flow.state === 'activating' && !expired) {
      finish(flow, 'failed', 'activation_failed');
    }
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
    tenantBrand: 'feishu',
    state: 'starting',
  };
  flows.set(uid, flow);
  void runRegistration(flow, newInstanceActivation());
  return publicStatus(flow);
}

/**
 * Start QR onboarding for an existing unbound Feishu/Lark draft. On success
 * the credentials are encrypted onto that exact draft and the scanning
 * account's open id is seeded as the first allowed user; cancel/expiry keep
 * the draft and only revoke credentials issued by this flow.
 */
export async function startFeishuQrRegistrationForInstance(
  uid: string,
  instanceId: string,
): Promise<FeishuRegistrationStatus> {
  assertUserId(uid);
  if (!registry.isValidInstanceId(instanceId)) throw new Error('invalid messaging instance id');
  const draftInstance = await registry.getInstance(uid, instanceId);
  if (!draftInstance) throw new Error('messaging draft not found');
  if (draftInstance.platform !== 'feishu_lark') throw new Error('messaging draft is not a Feishu/Lark robot');
  if (draftInstance.enabled || await registry.getInstanceWithSecret(uid, instanceId)) {
    throw new Error('messaging instance already has credentials');
  }
  const previous = pruneFlow(uid);
  if (previous) {
    const previousPending = isPending(previous);
    cancelFlow(previous);
    if (previousPending || previous.instance) retainFlow(previous);
  }
  const flow: RegistrationFlow = {
    uid,
    flowId: randomUUID(),
    draft: {
      displayName: draftInstance.displayName,
      workspace: draftInstance.workspace,
      policy: draftInstance.policy,
    },
    controller: new AbortController(),
    tenantBrand: registrationBrand(draftInstance.feishuTenantBrand),
    state: 'starting',
    instanceId,
  };
  flows.set(uid, flow);
  void runRegistration(flow, draftActivation(uid, instanceId));
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
