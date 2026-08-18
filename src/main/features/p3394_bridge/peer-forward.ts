/**
 * P3394 peer forwarding — the CogSeed-hosted half of "gateway A calls
 * gateway B" (Agent-to-Agent interop without widening the gateway's
 * trust surface).
 *
 * A registered local node (e.g. the Claude gateway) sends a task envelope
 * to the CogSeed bridge with `extensions.forward_to = "<target>"`. The
 * bridge validates both identities against the registry, forwards the
 * envelope to the target's endpoint via the existing outbound hub, waits
 * for the target's auto-reply (which lands back on this bridge through
 * `reply_endpoint`), then relays the reply to the original sender.
 *
 * Security boundary (guide §15):
 *  - sender must be a registered peer (hello-registered or preset);
 *  - target must be a registered peer with at least one endpoint;
 *  - `forward_to` may not address this node or the sender itself;
 *  - H-03: forwarding is LOCAL-ONLY by default — a target whose endpoints
 *    are all loopback may receive forwarded work without extra sign-off;
 *    forwarding to a remote-endpoint target requires an explicit
 *    `isForwardTargetAllowed` decision (no implied cross-host trust);
 *  - forwarding is idempotent per (target, idempotency_key);
 *  - every hop is audited.
 *
 * The gateway never learns other peers' endpoints — it only ever talks
 * to the CogSeed bridge, which keeps identity/authorization/audit on one
 * boundary.
 */

import { createLogger } from '../../logger';
import { isP3394LoopbackEndpoint } from './executor';
import type { P3394Envelope } from './envelope';

const log = createLogger('p3394-bridge:peer-forward');

export interface P3394ForwardReply {
  text: string;
}

export interface P3394PeerForwardDeps {
  resolveAgent(id: string): { ok: true; value: { identity: { agent_id: string }; endpoints?: string[] } } | { ok: false; error: unknown };
  sendAndWait(agentId: string, envelope: P3394Envelope): Promise<P3394ForwardReply>;
  /** Delivery-only send: relay legs back to the original sender are terminal —
   *  no reply is expected, so they must NOT register a pending reply waiter or
   *  linger in the outbox replay set (P1-3). Required: using sendAndWait for a
   *  terminal relay would leak a waiter and replay forever. */
  sendOnce(agentId: string, envelope: P3394Envelope): Promise<void>;
  audit(record: { event: string; actor_id: string; status: 'accepted' | 'rejected'; metadata?: Record<string, unknown> }): void;
  /** Idempotency ledger for (target, idempotency_key) — a pending/completed
   *  state machine (P1-2). isDuplicate must only be true once the same key is
   *  genuinely in-flight or already completed; a FAILED attempt must be
   *  cleared (markFailed) so the sender can retry the same key instead of
   *  being silently acked as a duplicate forever. */
  isDuplicate(key: string): boolean;
  /** Reserve an in-flight (target, idempotency_key) — concurrent duplicate
   *  forwards are not double-sent; while pending, isDuplicate is true. */
  markPending(key: string): void;
  /** Record a completed forward — later attempts with the same key are acked. */
  markCompleted(key: string): void;
  /** Clear an in-flight/pending reservation after a failed attempt is returned
   *  to the sender, so the same key can be retried. */
  markFailed(key: string): void;
  /** H-03: explicit sign-off for forwarding to a target with non-loopback
   *  endpoints (cross-host). Default (absent) = reject. Loopback targets
   *  are always allowed. */
  isForwardTargetAllowed?: (target: string) => boolean;
  /** Local bridge endpoint/token injected into the forwarded envelope so
   *  the target's auto-reply lands back on this bridge. */
  bridgeInfo: { endpoint: string; token: string } | null;
  /** Upper bound on forward hops (A→B→C…). A forwarded leg may itself carry
   *  forward_to; without a budget two peers could ping-pong a task forever
   *  (A→B→A→B…). Defaults to MAX_FORWARD_HOPS. */
  maxForwardHops?: number;
}

export type P3394PeerForwardResult =
  | { ok: true }
  | { ok: false; error: string };

/** Node ids that address this bridge itself and must never be forward targets. */
const SELF_NODE_IDS = new Set(['cogseed', 'mate', 'orkas']);

/** Default forward-hop budget (a forwarded envelope carries extensions.hop_count,
 *  incremented each leg). Guards against A↔B ping-pong loops. */
export const MAX_FORWARD_HOPS = 4;

/**
 * Forwards one inbound envelope to another registered peer and relays the
 * reply back to the original sender. Returns ok even when the same
 * (target, idempotency_key) was already forwarded (idempotent ack).
 */
export async function forwardEnvelopeToPeer(
  envelope: P3394Envelope,
  target: string,
  deps: P3394PeerForwardDeps,
): Promise<P3394PeerForwardResult> {
  const senderId = envelope.sender.agent_id;
  const targetId = String(target || '').trim();
  const idemKey = `${targetId}:${envelope.idempotency_key}`;

  if (!targetId || senderId === targetId || SELF_NODE_IDS.has(targetId)) {
    deps.audit({ event: 'peer.forward.reject', actor_id: senderId, status: 'rejected', metadata: { target: targetId, reason: 'invalid_target' } });
    return { ok: false, error: 'p3394_forward_invalid_target' };
  }

  // Loop budget: a forwarded leg may itself carry forward_to, so A↔B could
  // ping-pong a task forever. Each hop increments extensions.hop_count; past
  // the budget the forward is rejected (the sender gets an error reply).
  const incomingHops = Number((envelope.extensions as Record<string, unknown> | undefined)?.hop_count ?? 0);
  const maxHops = deps.maxForwardHops ?? MAX_FORWARD_HOPS;
  if (!Number.isInteger(incomingHops) || incomingHops < 0 || incomingHops >= maxHops) {
    deps.audit({ event: 'peer.forward.reject', actor_id: senderId, status: 'rejected', metadata: { target: targetId, reason: 'too_many_hops', hops: incomingHops } });
    return { ok: false, error: 'p3394_forward_too_many_hops' };
  }

  if (deps.isDuplicate(idemKey)) {
    // At-least-once delivery: the original forward already happened. Ack
    // without re-running the target (the target's own idempotency would
    // also reject the duplicate).
    deps.audit({ event: 'peer.forward.duplicate', actor_id: senderId, status: 'accepted', metadata: { target: targetId } });
    return { ok: true };
  }

  const sender = deps.resolveAgent(senderId);
  if (!sender.ok) {
    deps.audit({ event: 'peer.forward.reject', actor_id: senderId, status: 'rejected', metadata: { target: targetId, reason: 'sender_not_registered' } });
    return { ok: false, error: 'p3394_forward_sender_not_registered' };
  }

  const peer = deps.resolveAgent(targetId);
  if (!peer.ok || !peer.value.endpoints || peer.value.endpoints.length === 0) {
    deps.audit({ event: 'peer.forward.reject', actor_id: senderId, status: 'rejected', metadata: { target: targetId, reason: 'target_not_registered' } });
    return { ok: false, error: 'p3394_forward_target_not_registered' };
  }
  // H-03: local-first forwarding — loopback targets always allowed; a target
  // with any non-loopback endpoint needs explicit sign-off (no implied
  // cross-host trust). Otherwise a low-trust peer could pivot work / replies
  // to arbitrary registered hosts.
  const allLoopback = (peer.value.endpoints ?? []).every((endpoint) => isP3394LoopbackEndpoint(endpoint));
  if (!allLoopback && !(deps.isForwardTargetAllowed?.(targetId) ?? false)) {
    deps.audit({ event: 'peer.forward.reject', actor_id: senderId, status: 'rejected', metadata: { target: targetId, reason: 'target_remote_not_authorized' } });
    return { ok: false, error: 'p3394_forward_target_remote_not_authorized' };
  }

  // P1-2: reserve the (target, idempotency_key) as in-flight BEFORE the wire
  // write, but do NOT treat the key as completed here. A delivery failure /
  // timeout later must release the reservation (markFailed) so the sender can
  // retry the same key instead of being acked as a duplicate forever.
  deps.markPending(idemKey);

  // Forwarded envelope: same identity/task semantics, recipient rewritten to
  // the target, and the bridge's own reply endpoint injected so the target's
  // §11 auto-reply returns here for the outbound matcher. M-03: the forwarded
  // leg uses a derived session id so it never competes with the original
  // session's outbound waiter (sendAndWait keys on session_id), preventing
  // `p3394_session_conflict` when a forward and a direct send overlap.
  const forwarded: P3394Envelope = {
    ...envelope,
    session_id: `fwd:${envelope.session_id}`,
    recipients: [{ agent_id: targetId }],
    extensions: {
      ...(envelope.extensions ?? {}),
      ...(deps.bridgeInfo ? { reply_endpoint: deps.bridgeInfo.endpoint, reply_token: deps.bridgeInfo.token } : {}),
      forward_from: senderId,
      hop_count: incomingHops + 1,
    },
  };

  deps.audit({
    event: 'peer.forward.send',
    actor_id: senderId,
    status: 'accepted',
    metadata: { target: targetId, message_id: envelope.message_id, session_id: envelope.session_id },
  });

  try {
    const reply = await deps.sendAndWait(targetId, forwarded);

    // Relay the target's reply back to the original sender through the
    // same outbound channel (sender is a registered peer with an endpoint).
    const relay: P3394Envelope = {
      spec_version: 'p3394/1.0',
      message_id: `fwd-${envelope.message_id}`,
      session_id: envelope.session_id,
      task_id: envelope.task_id,
      kind: 'message',
      performative: 'inform',
      role: 'responder',
      sender: { agent_id: 'cogseed', alias: 'CogSeed' },
      recipients: [{ agent_id: senderId }],
      payload: { parts: [{ type: 'text', text: reply.text }] },
      reply_to: envelope.message_id,
      idempotency_key: `forward-reply:${envelope.idempotency_key}`,
    };
    // P1-3: the relay is terminal — the original sender already has its result
    // and will NOT reply to the relay. A sendAndWait here would register a
    // pending reply waiter for the full replyTimeoutMs AND leave the relay in
    // the outbox replay set (re-sent on every bridge restart). Use the
    // delivery-only send: it completes the outbox record on the delivery
    // receipt, so nothing lingers and nothing replays.
    await deps.sendOnce(senderId, relay);
    // P1-2: only now is the forward genuinely completed — from here on a
    // retry with the same (target, idempotency_key) is acked as a duplicate.
    deps.markCompleted(idemKey);
    deps.audit({
      event: 'peer.forward.reply',
      actor_id: senderId,
      status: 'accepted',
      metadata: { target: targetId, reply_to: envelope.message_id, session_id: envelope.session_id },
    });
    log.info('P3394 peer forward completed', { from: senderId, to: targetId, session_id: envelope.session_id });
    return { ok: true };
  } catch (error) {
    // P1-2: a failed attempt must NOT poison the idempotency key — release the
    // pending reservation so the sender can retry with the same key.
    deps.markFailed(idemKey);
    deps.audit({
      event: 'peer.forward.failed',
      actor_id: senderId,
      status: 'rejected',
      metadata: { target: targetId, session_id: envelope.session_id, error: error instanceof Error ? error.message : String(error) },
    });
    log.warn('P3394 peer forward failed', { from: senderId, to: targetId, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
