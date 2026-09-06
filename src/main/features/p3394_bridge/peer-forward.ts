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
  resolveAgent(id: string): { ok: true; value: { identity: { agent_id: string }; endpoints?: string[]; node_kind?: string; dial_token?: string; expected_identity?: string } } | { ok: false; error: unknown };
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
   *  endpoints (cross-host). Default (absent) = builtin trust policy: only
   *  explicitly trusted targets are allowed (registered channel_bridge nodes
   *  or remote-injected peers carrying dial_token/expected_identity). */
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
const SELF_NODE_IDS = new Set(['cogseed', 'cogseed', 'cogseed']);

/** Default forward-hop budget (a forwarded envelope carries extensions.hop_count,
 *  incremented each leg). Guards against A↔B ping-pong loops. */
export const MAX_FORWARD_HOPS = 4;

// ── 渠道节点分流（X-4）────────────────────────────────────────────────
// channel_bridge 节点（node_kind='channel_bridge'）是进程内虚拟节点：没有网
// 络端点、不经 outbound-hub 的 HTTP dial。对它的 forward 分流到渠道投递
// 回调（deliverToChannelBridge 的包装），投递回执作为"目标回复"回发原
// sender。回调经 registerChannelBridgeForwarder 注入——peer-forward 保持
// 纯协议层（不静态依赖 messaging 运行时），app/测试各自注册实现。

/** 渠道节点投递请求：原信封（sender=原始发送方，白名单语义依赖它）+ 目标
 *  渠道节点 agent_id（channel-<instanceId>）。 */
export interface P3394ChannelBridgeForwardRequest {
  envelope: P3394Envelope;
  targetAgentId: string;
}

export type P3394ChannelBridgeForwarder = (
  request: P3394ChannelBridgeForwardRequest,
) => Promise<{ ok: true; receiptText: string } | { ok: false; error: string }>;

let channelBridgeForwarder: P3394ChannelBridgeForwarder | null = null;

/** 注册/清除渠道节点投递回调。null = 显式禁用（转发到渠道节点返回
 *  p3394_channel_bridge_forwarder_unavailable）。 */
export function registerChannelBridgeForwarder(handler: P3394ChannelBridgeForwarder | null): void {
  channelBridgeForwarder = handler;
}

/** 生产默认回调：懒加载 messaging 投递链（deliverToChannelBridge +
 *  sendProactive + getInstanceWithSecret 的 owner 解析），与
 *  core-agent/p3394-tools 的本机路径同一套装配。uid 取当前活跃用户
 * （跨机 forward 无对话上下文，渠道实例归属本机用户）。 */
export function createMessagingChannelBridgeForwarder(): P3394ChannelBridgeForwarder {
  return async (request) => {
    const { deliverToChannelBridge, instanceIdFromChannelBridgeAgentId } = await import('../messaging/channel-bridge');
    const { sendProactive, sendProactiveFile } = await import('../messaging/manager');
    const { getInstanceWithSecret } = await import('../messaging/registry');
    const { getActiveUserId } = await import('../users');
    const uid = getActiveUserId();
    const instanceId = instanceIdFromChannelBridgeAgentId(request.targetAgentId) || '';
    // 白名单（与 p3394-tools 的本机路径同源）：实例策略
    // channelBridgeSenderAllowlist；undefined = 全放行，数组 = 仅名单内 sender。
    const policyLoaded = instanceId
      ? await getInstanceWithSecret(uid, instanceId).catch(() => null)
      : null;
    const allowlist = (policyLoaded?.instance as { policy?: { channelBridgeSenderAllowlist?: string[] } } | undefined)
      ?.policy?.channelBridgeSenderAllowlist;
    const delivered = await deliverToChannelBridge(
      uid,
      request.targetAgentId,
      request.envelope,
      sendProactive,
      async (uid2, instanceId2) => {
        const loaded = await getInstanceWithSecret(uid2, instanceId2);
        const ownerExternalUserId = (loaded?.instance as { ownerExternalUserId?: string } | undefined)?.ownerExternalUserId;
        return ownerExternalUserId ? { recipientId: ownerExternalUserId } : null;
      },
      {
        ...(Array.isArray(allowlist) ? { allowedSenders: allowlist } : {}),
        sendFile: async (uid2, fileInput) => {
          const name = fileInput.name || fileInput.path.split('/').pop() || 'file';
          await sendProactiveFile(uid2, {
            instanceId: fileInput.instanceId,
            recipientId: fileInput.recipientId,
            filePath: fileInput.path,
            fileName: name,
            sourceKey: fileInput.sourceKey,
          });
        },
      },
    );
    if (delivered.ok) {
      const receiptText = (delivered.receipt.payload?.parts || [])
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join(' ')
        .trim();
      return { ok: true, receiptText: receiptText || 'channel bridge delivered' };
    }
    // 与 core-agent/p3394-tools 相同的收窄写法（联合类型在泛型包装后不被
    // ok 判别式自动收窄）。
    const deliverFailure = delivered as Extract<typeof delivered, { ok: false }>;
    return { ok: false, error: deliverFailure.error };
  };
}

// 模块加载即注册生产默认（动态 import 惰性触发，不拉起 messaging 运行时）。
// 外部可用 registerChannelBridgeForwarder 覆盖，或传 null 显式禁用（测试
// no-handler 分支 / 无 messaging 的嵌入环境）。
registerChannelBridgeForwarder(createMessagingChannelBridgeForwarder());

/** H-03 无回调时的内置默认放行判据：显式信任来源才放行跨机目标。
 *  - 注册表内 channel_bridge 节点（进程内虚拟节点，本机用户配置的渠道）；
 *  - 带非回环端点且携带 dial_token / expected_identity 的 peer——注册表里
 *    非回环端点只能来自 remote-nodes 显式注入（hello 自报的非回环在
 *    app-wiring S-02 层已丢弃），而注入要求 expected_identity（否则跳过）
 *    且 token 必填，两个标记即"用户显式添加"的信任特征。其余（含任何
 *    假想路径进来的无标记非回环端点）保持拒绝——防 SSRF 语义不放松。 */
function isExplicitlyTrustedForwardTarget(peer: {
  node_kind?: string;
  endpoints?: string[];
  dial_token?: string;
  expected_identity?: string;
}): boolean {
  if (peer.node_kind === 'channel_bridge') return true;
  if (!peer.dial_token && !peer.expected_identity) return false;
  return (peer.endpoints ?? []).some((endpoint) => !isP3394LoopbackEndpoint(endpoint));
}

/** 渠道节点分流执行：markPending → 投递回调 → 回执回发原 sender（终端
 *  消息，delivery-only sendOnce，P1-3 同一纪律）→ markCompleted。 */
async function forwardToChannelBridge(
  envelope: P3394Envelope,
  targetId: string,
  senderId: string,
  idemKey: string,
  deps: P3394PeerForwardDeps,
): Promise<P3394PeerForwardResult> {
  const handler = channelBridgeForwarder;
  if (!handler) {
    deps.audit({ event: 'peer.forward.reject', actor_id: senderId, status: 'rejected', metadata: { target: targetId, reason: 'channel_bridge_forwarder_unavailable' } });
    return { ok: false, error: 'p3394_channel_bridge_forwarder_unavailable' };
  }
  deps.markPending(idemKey);
  deps.audit({ event: 'peer.forward.channel_bridge', actor_id: senderId, status: 'accepted', metadata: { target: targetId, message_id: envelope.message_id } });
  try {
    const delivered = await handler({ envelope, targetAgentId: targetId });
    if (delivered.ok === false) {
      deps.markFailed(idemKey);
      deps.audit({ event: 'peer.forward.failed', actor_id: senderId, status: 'rejected', metadata: { target: targetId, channel_bridge: true, error: delivered.error } });
      log.warn('P3394 channel-bridge forward failed', { from: senderId, to: targetId, error: delivered.error });
      return { ok: false, error: delivered.error };
    }
    // 投递回执作为"目标回复"回发原 sender：终端消息（sender 不会再回），
    // 走 delivery-only 的 sendOnce——不登记回复 waiter、不留 outbox 重放。
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
      payload: { parts: [{ type: 'text', text: delivered.receiptText }] },
      reply_to: envelope.message_id,
      idempotency_key: `forward-reply:${envelope.idempotency_key}`,
    };
    await deps.sendOnce(senderId, relay);
    deps.markCompleted(idemKey);
    deps.audit({
      event: 'peer.forward.reply',
      actor_id: senderId,
      status: 'accepted',
      metadata: { target: targetId, reply_to: envelope.message_id, channel_bridge: true },
    });
    log.info('P3394 channel-bridge forward completed', { from: senderId, to: targetId });
    return { ok: true };
  } catch (error) {
    deps.markFailed(idemKey);
    deps.audit({
      event: 'peer.forward.failed',
      actor_id: senderId,
      status: 'rejected',
      metadata: { target: targetId, channel_bridge: true, error: error instanceof Error ? error.message : String(error) },
    });
    log.warn('P3394 channel-bridge forward failed', { from: senderId, to: targetId, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

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
  if (!peer.ok) {
    deps.audit({ event: 'peer.forward.reject', actor_id: senderId, status: 'rejected', metadata: { target: targetId, reason: 'target_not_registered' } });
    return { ok: false, error: 'p3394_forward_target_not_registered' };
  }

  // 渠道节点分流（X-4）：channel_bridge 是进程内虚拟节点（endpoints 恒空，
  // 走不到下面的端点检查），不经 outbound-hub HTTP dial，交给注册的渠道
  // 投递回调。B 机 CLI 经 forward_to 触达本机飞书渠道即走这条路。
  if (peer.value.node_kind === 'channel_bridge') {
    return forwardToChannelBridge(envelope, targetId, senderId, idemKey, deps);
  }

  if (!peer.value.endpoints || peer.value.endpoints.length === 0) {
    deps.audit({ event: 'peer.forward.reject', actor_id: senderId, status: 'rejected', metadata: { target: targetId, reason: 'target_not_registered' } });
    return { ok: false, error: 'p3394_forward_target_not_registered' };
  }
  // H-03: local-first forwarding — loopback targets always allowed; a target
  // with any non-loopback endpoint needs explicit sign-off (no implied
  // cross-host trust). Otherwise a low-trust peer could pivot work / replies
  // to arbitrary registered hosts. 显式授权有两个来源：调用方注入的
  // isForwardTargetAllowed 回调（有回调则完全以其判定为准）；无回调时用
  // 内置默认策略（仅显式信任来源：channel_bridge 节点 / remote-nodes 注入
  // 的带信任标记 peer）。
  const allLoopback = (peer.value.endpoints ?? []).every((endpoint) => isP3394LoopbackEndpoint(endpoint));
  if (!allLoopback) {
    const allowed = deps.isForwardTargetAllowed
      ? deps.isForwardTargetAllowed(targetId)
      : isExplicitlyTrustedForwardTarget(peer.value);
    if (!allowed) {
      deps.audit({ event: 'peer.forward.reject', actor_id: senderId, status: 'rejected', metadata: { target: targetId, reason: 'target_remote_not_authorized' } });
      return { ok: false, error: 'p3394_forward_target_remote_not_authorized' };
    }
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
