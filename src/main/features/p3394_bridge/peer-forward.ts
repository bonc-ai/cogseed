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
  audit(record: { event: string; actor_id: string; status: 'accepted' | 'rejected'; metadata?: Record<string, unknown> }): void;
  isDuplicate(key: string): boolean;
  markDuplicate(key: string): void;
  /** H-03: explicit sign-off for forwarding to a target with non-loopback
   *  endpoints (cross-host). Default (absent) = reject. Loopback targets
   *  are always allowed. */
  isForwardTargetAllowed?: (target: string) => boolean;
  /** Local bridge endpoint/token injected into the forwarded envelope so
   *  the target's auto-reply lands back on this bridge. */
  bridgeInfo: { endpoint: string; token: string } | null;
}

export type P3394PeerForwardResult =
  | { ok: true }
  | { ok: false; error: string };

/** Node ids that address this bridge itself and must never be forward targets. */
const SELF_NODE_IDS = new Set(['cogseed', 'mate', 'orkas']);

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

  deps.markDuplicate(idemKey);

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
    await deps.sendAndWait(senderId, relay);
    deps.audit({
      event: 'peer.forward.reply',
      actor_id: senderId,
      status: 'accepted',
      metadata: { target: targetId, reply_to: envelope.message_id, session_id: envelope.session_id },
    });
    log.info('P3394 peer forward completed', { from: senderId, to: targetId, session_id: envelope.session_id });
    return { ok: true };
  } catch (error) {
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
