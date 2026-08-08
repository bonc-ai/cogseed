import { randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { nowIso, safeId } from '../../storage';
import { logErrorSummary } from '../../util/log-redact';
import { createWechatInstance, isTrustedIlinkBaseUrl } from './registry';
import { clearWechatInstanceState } from './wechat-state-store';

const log = createLogger('messaging:wechat-registration');
const FLOW_RETENTION_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 1_000;
const QR_REFRESH_MAX = 3;

export type WechatRegistrationState =
  | 'starting'
  | 'awaiting_scan'
  | 'scanned'
  | 'redirecting'
  | 'verification_required'
  | 'completed'
  | 'expired'
  | 'blocked'
  | 'cancelled'
  | 'failed';

export interface WechatRegistrationStatus {
  flowId: string;
  state: WechatRegistrationState;
  qrUrl?: string;
  qrCode?: string;
  errorCode?: string;
  instanceId?: string;
  updatedAt: string;
}

interface WechatRegistrationFlow {
  uid: string;
  flowId: string;
  state: WechatRegistrationState;
  qrUrl?: string;
  qrCode?: string;
  baseUrl: string;
  qrRefreshCount: number;
  errorCode?: string;
  instanceId?: string;
  updatedAt: string;
}

const flows = new Map<string, WechatRegistrationFlow>();

function assertUserId(uid: string): void {
  if (!safeId(uid)) throw new Error('invalid user id');
}

function publicStatus(flow: WechatRegistrationFlow): WechatRegistrationStatus {
  return {
    flowId: flow.flowId,
    state: flow.state,
    ...(flow.qrUrl ? { qrUrl: flow.qrUrl } : {}),
    ...(flow.qrCode ? { qrCode: flow.qrCode } : {}),
    ...(flow.errorCode ? { errorCode: flow.errorCode } : {}),
    ...(flow.instanceId ? { instanceId: flow.instanceId } : {}),
    updatedAt: flow.updatedAt,
  };
}

function finish(flow: WechatRegistrationFlow, state: WechatRegistrationState, errorCode?: string): void {
  flow.state = state;
  flow.updatedAt = nowIso();
  if (errorCode) flow.errorCode = errorCode;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapQrStatus(raw: string, flow: WechatRegistrationFlow): WechatRegistrationState | null {
  switch (raw) {
    case 'wait': return 'awaiting_scan';
    case 'scaned': return 'scanned';
    case 'scaned_but_redirect': return 'redirecting';
    case 'need_verifycode': return 'verification_required';
    case 'verify_code_blocked': return 'blocked';
    case 'binded_redirect': return 'redirecting';
    case 'expired': return 'expired';
    case 'confirmed': return 'completed';
    default: return null; // 未映射状态 → failed
  }
}

async function pollQrStatus(flow: WechatRegistrationFlow): Promise<void> {
  const baseUrl = flow.baseUrl.replace(/\/+$/, '');
  while (flow.state === 'starting' || flow.state === 'awaiting_scan' || flow.state === 'scanned' || flow.state === 'redirecting') {
    if (flow.state === 'cancelled' || flow.state === 'failed' || flow.state === 'completed') return;
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(flow.qrCode || '')}`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      log.warn('wechat qr status poll failed', { flowId: flow.flowId, error: logErrorSummary(error) });
      await wait(POLL_INTERVAL_MS);
      continue;
    }
    let parsed: { ret?: number; status?: string; bot_token?: string; baseurl?: string; ilink_bot_id?: string; ilink_user_id?: string };
    try {
      parsed = await response.json();
    } catch {
      await wait(POLL_INTERVAL_MS);
      continue;
    }
    if (typeof parsed.ret === 'number' && parsed.ret !== 0) {
      finish(flow, 'failed', `qr_ret_${parsed.ret}`);
      return;
    }
    const mapped = mapQrStatus(parsed.status || '', flow);
    if (mapped === null) {
      finish(flow, 'failed', 'unknown_qr_status');
      return;
    }
    if (mapped === 'expired') {
      flow.qrRefreshCount += 1;
      if (flow.qrRefreshCount > QR_REFRESH_MAX) {
        finish(flow, 'expired', 'qr_refresh_exhausted');
        return;
      }
      await refreshQrCode(flow);
      continue;
    }
    if (mapped === 'completed') {
      await completeConfirmed(flow, parsed);
      return;
    }
    flow.state = mapped;
    flow.updatedAt = nowIso();
    await wait(POLL_INTERVAL_MS);
  }
}

async function refreshQrCode(flow: WechatRegistrationFlow): Promise<void> {
  try {
    const response = await fetch(`${flow.baseUrl.replace(/\/+$/, '')}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const parsed = await response.json() as { ret?: number; qrcode?: string; url?: string };
    if (typeof parsed.ret === 'number' && parsed.ret !== 0) {
      finish(flow, 'failed', `qr_ret_${parsed.ret}`);
      return;
    }
    flow.qrCode = typeof parsed.qrcode === 'string' ? parsed.qrcode : '';
    if (typeof parsed.url === 'string' && parsed.url) {
      const url = new URL(parsed.url);
      if (isTrustedIlinkBaseUrl(url.origin)) flow.qrUrl = parsed.url;
    }
    flow.updatedAt = nowIso();
  } catch (error) {
    log.warn('wechat qr refresh failed', { flowId: flow.flowId, error: logErrorSummary(error) });
  }
}

async function completeConfirmed(
  flow: WechatRegistrationFlow,
  parsed: { bot_token?: string; baseurl?: string; ilink_bot_id?: string; ilink_user_id?: string },
): Promise<void> {
  const botToken = typeof parsed.bot_token === 'string' ? parsed.bot_token.trim() : '';
  const baseUrl = typeof parsed.baseurl === 'string' ? parsed.baseurl.trim() : '';
  const botId = typeof parsed.ilink_bot_id === 'string' ? parsed.ilink_bot_id.trim() : '';
  const ownerId = typeof parsed.ilink_user_id === 'string' ? parsed.ilink_user_id.trim() : '';
  // fail closed：任一核心字段缺失/非法 → 不创建实例
  if (!botToken || !baseUrl || !isTrustedIlinkBaseUrl(baseUrl) || !botId || !ownerId) {
    finish(flow, 'failed', 'confirmed_payload_invalid');
    return;
  }
  try {
    const instance = await createWechatInstance(flow.uid, {
      displayName: '个人微信',
      ilinkBotToken: botToken,
      ilinkBaseUrl: baseUrl,
      ilinkBotId: botId,
      ownerExternalUserId: ownerId,
    });
    // 重绑语义：无论本 flow 之前是否存在旧状态，confirmed 后一律清空
    await clearWechatInstanceState(flow.uid, instance.id);
    flow.instanceId = instance.id;
    finish(flow, 'completed');
  } catch (error) {
    log.warn('wechat instance creation failed', { flowId: flow.flowId, error: logErrorSummary(error) });
    finish(flow, 'failed', 'instance_create_failed');
  }
}

export async function startWechatQrRegistration(uid: string): Promise<WechatRegistrationStatus> {
  assertUserId(uid);
  const flow: WechatRegistrationFlow = {
    uid,
    flowId: randomUUID(),
    state: 'starting',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    qrRefreshCount: 0,
    updatedAt: nowIso(),
  };
  flows.set(flow.flowId, flow);
  await refreshQrCode(flow);
  if (flow.state === 'failed') return publicStatus(flow);
  flow.state = 'awaiting_scan';
  flow.updatedAt = nowIso();
  void pollQrStatus(flow);
  return publicStatus(flow);
}

export function getWechatQrRegistrationStatus(uid: string, flowId: string): WechatRegistrationStatus {
  assertUserId(uid);
  const flow = flows.get(flowId);
  if (!flow) throw new Error('wechat registration flow not found');
  return publicStatus(flow);
}

export function cancelWechatQrRegistration(uid: string, flowId: string): WechatRegistrationStatus {
  assertUserId(uid);
  const flow = flows.get(flowId);
  if (!flow) throw new Error('wechat registration flow not found');
  finish(flow, 'cancelled');
  return publicStatus(flow);
}
