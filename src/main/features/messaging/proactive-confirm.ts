/**
 * Confirmation gate for proactive messaging sends.
 *
 * The Commander (Core Agent or Mate Runtime top level) asks to send a message
 * to the configured Feishu/Lark owner. Main pushes `messaging:send-confirm`
 * to the renderer with the bot name, target label, and full text (the consent
 * surface), and resolves only when the user answers through the
 * `messaging.send_confirm_response` IPC. No answer within the timeout, no
 * renderer, a cancelled conversation, or an aborted tool call all decline.
 *
 * Mirrors features/connectors/install_confirm.ts; kept separate because
 * messaging and connectors are different feature domains.
 */

import * as crypto from 'node:crypto';

import { createLogger } from '../../logger';

const log = createLogger('messaging:proactive-confirm');

// Human-in-the-loop window. Unanswered requests decline, but the user may be
// away mid-turn; keep the same generous default as connector installs.
const RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;

export const PROACTIVE_SEND_CONFIRM_CHANNEL = 'messaging:send-confirm';

export type ProactiveConfirmVerdict = 'approved' | 'denied' | 'timed_out' | 'no_renderer' | 'aborted';

export interface SendConfirmInfo {
  request_id: string;
  cid: string;
  instance_name: string;
  owner_label: string;
  text: string;
}

interface Pending {
  resolve: (verdict: ProactiveConfirmVerdict) => void;
  timer: NodeJS.Timeout;
  cid: string;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const _pending = new Map<string, Pending>();

function _broadcast(channel: string, payload: unknown): boolean {
  if (_broadcastOverride) return _broadcastOverride(channel, payload) === true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => void };
    if (!ipc.broadcastToRenderer) return false;
    ipc.broadcastToRenderer(channel, payload);
    return true;
  } catch {
    return false;
  }
}

let _broadcastOverride: ((channel: string, payload: unknown) => boolean | void) | null = null;
export function _setBroadcastForTest(fn: ((channel: string, payload: unknown) => boolean | void) | null): void {
  _broadcastOverride = fn;
}

function settle(requestId: string, verdict: ProactiveConfirmVerdict): void {
  const pending = _pending.get(requestId);
  if (!pending) return;
  _pending.delete(requestId);
  clearTimeout(pending.timer);
  if (pending.onAbort && pending.signal) {
    pending.signal.removeEventListener('abort', pending.onAbort as EventListener);
  }
  pending.resolve(verdict);
}

/** Ask the user to approve one proactive send. Never sends on its own. */
export function requestSendConfirm(opts: {
  cid: string;
  instanceName: string;
  ownerLabel: string;
  text: string;
  signal?: AbortSignal | null;
  timeoutMs?: number;
}): Promise<ProactiveConfirmVerdict> {
  const requestId = crypto.randomBytes(8).toString('hex');
  const info: SendConfirmInfo = {
    request_id: requestId,
    cid: opts.cid,
    instance_name: opts.instanceName,
    owner_label: opts.ownerLabel,
    text: opts.text,
  };
  const timeoutMs = typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)
    ? Math.max(0, opts.timeoutMs)
    : RESPONSE_TIMEOUT_MS;
  return new Promise<ProactiveConfirmVerdict>((resolve) => {
    const timer = setTimeout(() => {
      log.warn('proactive send confirm timed out → declined', { requestId });
      settle(requestId, 'timed_out');
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const onAbort = (): void => settle(requestId, 'aborted');
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timer);
        resolve('aborted');
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    _pending.set(requestId, {
      resolve,
      timer,
      cid: opts.cid,
      ...(opts.signal ? { signal: opts.signal, onAbort } : {}),
    });
    if (!_broadcast(PROACTIVE_SEND_CONFIRM_CHANNEL, info)) {
      log.warn('no renderer broadcast — proactive send will decline', { requestId });
      settle(requestId, 'no_renderer');
    }
  });
}

/** Renderer answer via `messaging.send_confirm_response`. Unknown ids
 * (stale dialog after timeout) return false. */
export function respondSendConfirm(requestId: string, approved: boolean): boolean {
  if (!_pending.has(requestId)) return false;
  settle(requestId, approved ? 'approved' : 'denied');
  return true;
}

/** Abandon every pending confirmation of a conversation (group abort). */
export function cancelForCid(cid: string): void {
  for (const [id, pending] of _pending) {
    if (pending.cid !== cid) continue;
    settle(id, 'aborted');
  }
}
