import { randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { nowIso, safeId } from '../../storage';
import { logErrorSummary } from '../../util/log-redact';
import * as manager from './manager';
import { createWechatInstance, deleteInstance, disableOtherWechatPersonalInstances, isTrustedIlinkBaseUrl } from './registry';
import type { MessagingInstanceClient } from './types';
import { clearWechatInstanceState } from './wechat-state-store';

const log = createLogger('messaging:wechat-registration');
const FLOW_RETENTION_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 1_000;
const QR_REFRESH_MAX = 3;
/** Hermes constants: QR requests are plain GETs identified by these two
 * headers (ILINK_APP_ID='bot', ILINK_APP_CLIENT_VERSION=(2<<16)|(2<<8)|0).
 * The status request long-polls, so its deadline is QR_TIMEOUT_MS=35s. */
const ILINK_APP_ID = 'bot';
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0);
const POLL_REQUEST_TIMEOUT_MS = 35_000;
const QR_GET_HEADERS = Object.freeze({
  'iLink-App-Id': ILINK_APP_ID,
  'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
});

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
  controller: AbortController;
  errorCode?: string;
  instanceId?: string;
  finishedAt?: number;
  updatedAt: string;
}

const flows = new Map<string, WechatRegistrationFlow>();

function assertUserId(uid: string): void {
  if (!safeId(uid)) throw new Error('invalid user id');
}

/** Cancel wins over any in-flight poll result: the poller re-checks the flow
 * after every await, so a `confirmed` response arriving after cancel can
 * never create an instance. */
function isCancelled(flow: WechatRegistrationFlow): boolean {
  return flow.state === 'cancelled';
}

/** Finished flows stay queryable for the retention window, then are pruned;
 * after that a flow is no longer queryable/cancellable. */
function pruneFinishedFlows(): void {
  const cutoff = Date.now() - FLOW_RETENTION_MS;
  for (const [flowId, flow] of flows) {
    if (flow.finishedAt !== undefined && flow.finishedAt < cutoff) flows.delete(flowId);
  }
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
  flow.finishedAt = Date.now();
  if (errorCode) flow.errorCode = errorCode;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pollSignal(flow: WechatRegistrationFlow): AbortSignal {
  return AbortSignal.any([flow.controller.signal, AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS)]);
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
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(flow.qrCode || '')}`, {
        method: 'GET',
        redirect: 'error',
        headers: QR_GET_HEADERS,
        signal: pollSignal(flow),
      });
    } catch (error) {
      // 取消（AbortError）或瞬时网络错误都只重试；循环条件在下一轮退出
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
    // 取消竞态：响应在途期间被取消 → 不应用任何状态、不创建实例
    if (isCancelled(flow)) return;
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
      headers: QR_GET_HEADERS,
      signal: pollSignal(flow),
    });
    const parsed = await response.json() as { ret?: number; qrcode?: string; qrcode_img_content?: string };
    if (isCancelled(flow)) return;
    if (typeof parsed.ret === 'number' && parsed.ret !== 0) {
      finish(flow, 'failed', `qr_ret_${parsed.ret}`);
      return;
    }
    // qrcode 只是轮询用的 hex token；qrcode_img_content 才是用户要扫的
    // 完整 liteapp URL（Hermes：WeChat needs to scan the full URL, not the
    // raw hex string）。qrcode_img_content 必须通过既有白名单校验才落库。
    flow.qrCode = typeof parsed.qrcode === 'string' ? parsed.qrcode : '';
    if (typeof parsed.qrcode_img_content === 'string' && parsed.qrcode_img_content
      && isTrustedIlinkBaseUrl(parsed.qrcode_img_content)) {
      flow.qrUrl = parsed.qrcode_img_content;
    }
    flow.updatedAt = nowIso();
  } catch (error) {
    log.warn('wechat qr refresh failed', { flowId: flow.flowId, error: logErrorSummary(error) });
  }
}

/** Cancel raced past instance creation: drop the just-created instance so a
 * cancelled flow never leaves an owner-bound orphan behind. */
async function cleanupCancelledInstance(flow: WechatRegistrationFlow, instanceId: string): Promise<void> {
  try {
    await deleteInstance(flow.uid, instanceId);
  } catch (error) {
    log.warn('wechat cancelled instance cleanup failed', { flowId: flow.flowId, instanceId, error: logErrorSummary(error) });
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
  let instance: MessagingInstanceClient;
  try {
    instance = await createWechatInstance(flow.uid, {
      displayName: '个人微信',
      ilinkBotToken: botToken,
      ilinkBaseUrl: baseUrl,
      ilinkBotId: botId,
      ownerExternalUserId: ownerId,
    });
  } catch (error) {
    log.warn('wechat instance creation failed', { flowId: flow.flowId, error: logErrorSummary(error) });
    finish(flow, 'failed', 'instance_create_failed');
    return;
  }
  if (isCancelled(flow)) {
    await cleanupCancelledInstance(flow, instance.id);
    return;
  }
  try {
    // 重绑语义：无论本 flow 之前是否存在旧状态，confirmed 后一律清空
    await clearWechatInstanceState(flow.uid, instance.id);
  } catch (error) {
    log.warn('wechat instance creation failed', { flowId: flow.flowId, error: logErrorSummary(error) });
    finish(flow, 'failed', 'instance_create_failed');
    return;
  }
  if (isCancelled(flow)) {
    await cleanupCancelledInstance(flow, instance.id);
    return;
  }
  // 重绑语义：同一 uid 只能有一个在跑的 wechat_personal 实例。新实例已
  // 创建（默认 disabled），这里先原子性禁用其他 wechat 实例（单次
  // per-user 锁写入，enabled=false 即拒绝其新入站），再逐个停掉它们的
  // runtime——顺序固定，保证任一时刻最多一个 bot 轮询，旧凭据不会继续
  // 消费 owner 消息造成重复回复。逐实例停跑是 best-effort：某个实例停
  // 失败不阻断本次重绑（flag 已翻转为禁用）。
  const disabledIds = await disableOtherWechatPersonalInstances(flow.uid, instance.id);
  for (const otherId of disabledIds) {
    try {
      await manager.stopInstance(flow.uid, otherId);
    } catch (error) {
      log.warn('wechat rebind stop previous instance failed', {
        flowId: flow.flowId,
        instanceId: otherId,
        error: logErrorSummary(error),
      });
    }
  }
  if (isCancelled(flow)) {
    await cleanupCancelledInstance(flow, instance.id);
    return;
  }
  flow.instanceId = instance.id;
  finish(flow, 'completed');
}

export async function startWechatQrRegistration(uid: string): Promise<WechatRegistrationStatus> {
  assertUserId(uid);
  pruneFinishedFlows();
  const flow: WechatRegistrationFlow = {
    uid,
    flowId: randomUUID(),
    state: 'starting',
    controller: new AbortController(),
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
  pruneFinishedFlows();
  const flow = flows.get(flowId);
  if (!flow || flow.uid !== uid) throw new Error('wechat registration flow not found');
  return publicStatus(flow);
}

export function cancelWechatQrRegistration(uid: string, flowId: string): WechatRegistrationStatus {
  assertUserId(uid);
  pruneFinishedFlows();
  const flow = flows.get(flowId);
  if (!flow || flow.uid !== uid) throw new Error('wechat registration flow not found');
  finish(flow, 'cancelled');
  flow.controller.abort();
  return publicStatus(flow);
}
