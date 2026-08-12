/**
 * Shared proactive-messaging service for the Commander paths (Core Agent and
 * Mate Runtime top level).
 *
 * All business functions take `userId` first and never accept arbitrary chat
 * ids, open ids, tokens, or secrets from the model. The model may only pass an
 * instance id (optional when unambiguous), the fixed `target: "self"`, and
 * text. The service re-checks instance state, resolves the configured owner,
 * asks the user for one-time confirmation, then sends through the existing
 * adapter + delivery ledger and waits for the terminal outcome.
 */

import { createLogger } from '../../logger';
import { t } from '../../i18n';
import * as manager from './manager';
import * as registry from './registry';
import type { MessagingInstanceClient } from './types';
import {
  requestSendConfirm,
} from './proactive-confirm';

const log = createLogger('messaging:proactive');

const MAX_PROACTIVE_TEXT_LENGTH = 12_000;

export type ProactiveTargetStatus = 'available' | 'not_connected' | 'owner_missing' | 'disabled';

export interface ProactiveTargetView {
  instance_id: string;
  display_name: string;
  platform: 'feishu_lark' | 'wechat_personal';
  tenant_brand?: string;
  status: ProactiveTargetStatus;
  target: 'self';
  owner_label?: string;
}

export interface ProactiveListResult {
  targets: ProactiveTargetView[];
  available_instance_ids: string[];
}

export type ProactiveErrorCode =
  | 'E_MESSAGING_TARGET_UNAVAILABLE'
  | 'E_MESSAGING_TARGET_AMBIGUOUS'
  | 'E_MESSAGING_OWNER_MISSING'
  | 'E_MESSAGING_INSTANCE_UNAVAILABLE'
  | 'E_MESSAGING_DELIVERY_FAILED'
  | 'E_MESSAGING_INVALID_INPUT';

export type ProactiveSendResult =
  | {
      status: 'sent';
      instance_id: string;
      owner_label?: string;
      text_length: number;
      attempts: number;
      delivery_id?: string;
    }
  | { status: 'not_sent'; reason: 'denied' | 'timed_out' | 'aborted' | 'no_renderer' }
  | {
      status: 'error';
      code: ProactiveErrorCode;
      message: string;
      candidates?: string[];
    };

function targetStatus(instance: MessagingInstanceClient): ProactiveTargetStatus {
  if (!instance.enabled) return 'disabled';
  // A missing owner identity is a configuration gap the user can act on, so
  // it outranks the transient runtime state in diagnostics.
  if (!instance.ownerConfigured) return 'owner_missing';
  if (instance.status.kind !== 'connected') return 'not_connected';
  return 'available';
}

/** iLink context tokens expire server-side; proactive sends to the owner are
 * only possible while the account has seen an inbound within this window. */
const WECHAT_PROACTIVE_TOKEN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Wechat-personal extra availability gate. Returns null when the target
 * passes; otherwise the status that explains why it is not sendable:
 * `not_connected` (no live owner peer in the state store) or `owner_missing`
 * (bound owner missing, or the last inbound is older than the 24h token
 * window). The base instance status is computed first and this gate only
 * downgrades it. */
async function wechatTargetGate(uid: string, instance: MessagingInstanceClient): Promise<ProactiveTargetStatus | null> {
  if (instance.platform !== 'wechat_personal') return null;
  // Registration binds the owner, but re-check through the internal view: the
  // gate must never send to an account without a bound owner identity.
  const loaded = await registry.getInstanceWithSecret(uid, instance.id);
  if (!loaded) return 'not_connected';
  const ownerExternalUserId = loaded.instance.ownerExternalUserId || '';
  const ilinkBotId = loaded.secret.ilinkBotId || '';
  if (!ownerExternalUserId) return 'owner_missing';
  if (!ilinkBotId) return 'not_connected';
  const stateStore = await import('./wechat-state-store');
  const fingerprint = stateStore.wechatCredentialFingerprint(ilinkBotId, ownerExternalUserId);
  const state = await stateStore.loadWechatState(uid, instance.id, fingerprint);
  const ownerPeer = state?.peers[ownerExternalUserId];
  if (!ownerPeer) return 'not_connected';
  if (Date.now() - ownerPeer.lastInboundAt > WECHAT_PROACTIVE_TOKEN_WINDOW_MS) return 'owner_missing';
  return null;
}

/** List every Feishu/Lark or WeChat instance of the user with sanitized
 * diagnostics. */
export async function listTargets(uid: string): Promise<ProactiveListResult> {
  const instances = await manager.listInstances(uid);
  const targets: ProactiveTargetView[] = [];
  for (const instance of instances) {
    if (instance.platform !== 'feishu_lark' && instance.platform !== 'wechat_personal') continue;
    const baseStatus = targetStatus(instance);
    // The wechat gate only downgrades an otherwise-available target: disabled
    // or not-connected instances keep their more specific base status.
    const status = baseStatus === 'available'
      ? (await wechatTargetGate(uid, instance)) ?? 'available'
      : baseStatus;
    targets.push({
      instance_id: instance.id,
      display_name: instance.displayName,
      platform: instance.platform,
      ...(instance.feishuTenantBrand ? { tenant_brand: instance.feishuTenantBrand } : {}),
      status,
      target: 'self',
      ...(instance.ownerLabel ? { owner_label: instance.ownerLabel } : {}),
    });
  }
  return {
    targets,
    available_instance_ids: targets.filter((target) => target.status === 'available').map((target) => target.instance_id),
  };
}

function error(code: ProactiveErrorCode, message: string, candidates?: string[]): ProactiveSendResult {
  return { status: 'error', code, message, ...(candidates ? { candidates } : {}) };
}

/** Confirm and send `text` to the configured owner of one Feishu or WeChat
 * instance. */
export async function sendToSelf(
  uid: string,
  input: { instance_id?: string; target: string; text: string },
  opts: { cid: string; sourceKey: string; signal?: AbortSignal | null },
): Promise<ProactiveSendResult> {
  if (input.target !== 'self') {
    return error('E_MESSAGING_TARGET_UNAVAILABLE', 'target must be "self"');
  }
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text || text.length > MAX_PROACTIVE_TEXT_LENGTH) {
    return error('E_MESSAGING_INVALID_INPUT', `text is required and at most ${MAX_PROACTIVE_TEXT_LENGTH} characters`);
  }

  const { targets, available_instance_ids: availableIds } = await listTargets(uid);
  let chosen = targets.find((target) => target.instance_id === input.instance_id);
  if (input.instance_id !== undefined) {
    if (!chosen) {
      return error('E_MESSAGING_INSTANCE_UNAVAILABLE', 'unknown messaging instance');
    }
    if (chosen.status !== 'available') {
      if (chosen.status === 'owner_missing') {
        return error('E_MESSAGING_OWNER_MISSING', 'this bot has no owner identity configured');
      }
      return error('E_MESSAGING_INSTANCE_UNAVAILABLE', `this bot is not available (${chosen.status})`);
    }
  } else {
    if (!availableIds.length) {
      if (!targets.length) {
        return error('E_MESSAGING_TARGET_UNAVAILABLE', 'no Feishu/Lark or WeChat bot is configured');
      }
      if (targets.some((target) => target.status === 'owner_missing')) {
        return error('E_MESSAGING_OWNER_MISSING', 'no configured bot has an owner identity');
      }
      return error('E_MESSAGING_INSTANCE_UNAVAILABLE', 'no configured bot is connected');
    }
    if (availableIds.length > 1) {
      return error('E_MESSAGING_TARGET_AMBIGUOUS', 'multiple bots are available; choose instance_id', availableIds);
    }
    chosen = targets.find((target) => target.instance_id === availableIds[0]);
  }
  if (!chosen) {
    return error('E_MESSAGING_INSTANCE_UNAVAILABLE', 'selected bot disappeared');
  }

  const instance = await registry.getInstance(uid, chosen.instance_id);
  if (!instance?.ownerExternalUserId) {
    return error('E_MESSAGING_OWNER_MISSING', 'this bot has no owner identity configured');
  }

  const verdict = await requestSendConfirm({
    cid: opts.cid,
    instanceName: chosen.display_name,
    ownerLabel: chosen.owner_label || t('messaging.owner_label_self'),
    text,
    signal: opts.signal ?? null,
  });
  if (verdict !== 'approved') {
    const reason = verdict === 'aborted' ? 'aborted'
      : verdict === 'denied' ? 'denied'
        : verdict === 'timed_out' ? 'timed_out'
          : 'no_renderer';
    log.info('proactive send declined before delivery', { reason, instanceId: chosen.instance_id });
    return { status: 'not_sent', reason };
  }

  try {
    const { entry } = await manager.sendProactive(uid, {
      instanceId: chosen.instance_id,
      recipientId: instance.ownerExternalUserId,
      text,
      sourceKey: opts.sourceKey,
      signal: opts.signal ?? null,
    });
    return {
      status: 'sent',
      instance_id: chosen.instance_id,
      ...(chosen.owner_label ? { owner_label: chosen.owner_label } : {}),
      text_length: text.length,
      attempts: entry.attempts,
      ...(entry.externalDeliveryId ? { delivery_id: entry.externalDeliveryId } : {}),
    };
  } catch (err) {
    // A session abort (turn signal) or an AbortError from the delivery wait
    // cancels the send; the tool must not report it as a delivery failure.
    if (opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      log.info('proactive send aborted mid-delivery', { instanceId: chosen.instance_id });
      return { status: 'not_sent', reason: 'aborted' };
    }
    const message = err instanceof Error ? err.message : String(err);
    log.warn('proactive send failed after approval', { instanceId: chosen.instance_id, error: message });
    return error('E_MESSAGING_DELIVERY_FAILED', message);
  }
}
