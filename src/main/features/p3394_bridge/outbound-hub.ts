/**
 * P3394 outbound hub — CogSeed's active calls to registered peers.
 *
 * Agent collaboration goes through the CogSeed agent itself: a host tool
 * (p3394_send) builds an envelope here, delivers it to a registered peer
 * endpoint, and waits for the peer's reply. Replies come back through the
 * inbound pipeline and are matched by session id (see tryResolveReply).
 */

import { createLogger } from '../../logger';
import { P3394HttpChannel } from './http-channel';
import { P3394A2AChannel } from './a2a-channel';
import { P3394ModelRuntimeAdapter } from './model-runtime-adapter';
import type { P3394ChannelAdapter } from './channel-adapter';
import { P3394OutboundClient } from './outbound';
import { outboxListForReplay, outboxMarkCompleted, outboxMarkFailed, outboxMarkSent, outboxRecordSubmitted } from './outbound-outbox';
import { buildP3394MappingReport, validateP3394MappingReport, type P3394MappingReport, type P3394ReducedTarget } from './reduced-profiles';
import type { P3394Envelope } from './envelope';
import type { P3394PeerRecord } from './registry';

const log = createLogger('p3394-bridge:outbound-hub');

/** §12 流帧词表：四种中间帧都走流路径（刷超时 + onStream 回调 + 不结算
 *  waiter）。白名单外或未知帧名一律返回 null——由调用方按终态处理，绝不
 *  把"不认识的帧"当流帧吞掉，也不把已知流帧误判成终态提前结算。 */
const P3394_STREAM_EVENT_KINDS: ReadonlySet<string> = new Set(['delta', 'progress', 'status', 'artifact']);

export interface P3394OutboundReply {
  text: string;
  envelope: P3394Envelope;
}

export interface P3394OutboundStreamEvent {
  text: string;
  /** 'delta' → 正文增量（可见气泡）；'progress' → 过程日志（工具调用等）；
   *  'status' → 状态通报（阶段切换等）；'artifact' → 产物/中间产物通报。
   *  status/artifact 与 delta/progress 同路径：不结算 waiter、回调 onStream。 */
  kind: 'delta' | 'progress' | 'status' | 'artifact';
  /** 结构化过程事件（stream:'tool' / item reasoning 等，网关 claude 流解析
   *  产出）——宿主过程栏按 event 词表渲染；旧网关只有 text。 */
  event?: Record<string, unknown>;
  envelope: P3394Envelope;
  sequence?: number;
  sourceMessageId?: string;
}

interface PendingReply {
  resolve: (reply: P3394OutboundReply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** 出站信封的 message_id —— 回复到达时据此把 outbox 记录标为 completed。 */
  outboundMessageId: string;
  onStream?: (event: P3394OutboundStreamEvent) => void;
  lastStreamSequence?: number;
}

/** Per-peer 出站 TLS 材料（PEM 字符串或文件路径）：remote-nodes 显式配置
 *  的 https 节点携带的信任材料，dial 时透传给 https 客户端（§15）。 */
export interface P3394OutboundTlsMaterial {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}

export interface P3394OutboundHubDeps {
  /** Live peer lookup — the app bridge registry. */
  listPeers: () => P3394PeerRecord[];
  /** Maximum idle period while waiting for the peer's reply. */
  replyTimeoutMs?: number;
  /** 按 peer 查出站 TLS 材料（app-wiring 从 remote-nodes 注入；可选）。 */
  tlsForPeer?: (peer: P3394PeerRecord) => P3394OutboundTlsMaterial | undefined;
  /** §16-14 reduced-profile 映射报告工厂（默认 §12 表；测试可注入坏报告）。 */
  mappingReportFor?: (target: P3394ReducedTarget) => P3394MappingReport;
}

export class P3394OutboundHub {
  private readonly listPeers: () => P3394PeerRecord[];
  private readonly replyTimeoutMs: number;
  private readonly tlsForPeer: (peer: P3394PeerRecord) => P3394OutboundTlsMaterial | undefined;
  private readonly mappingReportFor: (target: P3394ReducedTarget) => P3394MappingReport;
  private readonly channels = new Map<string, { signature: string; channel: P3394ChannelAdapter; report?: P3394MappingReport }>();
  private readonly pending = new Map<string, PendingReply>();

  constructor(deps: P3394OutboundHubDeps) {
    this.listPeers = deps.listPeers;
    this.replyTimeoutMs = deps.replyTimeoutMs ?? 5 * 60 * 1000;
    this.tlsForPeer = deps.tlsForPeer ?? (() => undefined);
    this.mappingReportFor = deps.mappingReportFor ?? buildP3394MappingReport;
  }

  /** 最近一次非原生绑定（a2a/model_runtime）生成的 mapping report（§16-14
   *  审计/日志用）；按 agent_id 查，未生成或原生绑定为 undefined。 */
  mappingReportForPeer(agentId: string): P3394MappingReport | undefined {
    return this.channels.get(agentId)?.report;
  }

  private refreshReplyTimeout(sessionId: string, waiter: PendingReply): void {
    clearTimeout(waiter.timer);
    waiter.timer = setTimeout(() => {
      if (this.pending.get(sessionId) !== waiter) return;
      this.pending.delete(sessionId);
      // sent but no longer producing activity: keep it replayable rather than
      // marking a potentially still-running peer execution as delivery-failed.
      waiter.reject(new Error('p3394_reply_timeout'));
    }, this.replyTimeoutMs);
  }

  /** Builds the right outbound binding for a peer (guide §12 reduced-profile
   *  table): native P3394 HTTP by default, A2A for p3394+a2a endpoints, and a
   *  reduced model-runtime binding for model_runtime nodes / openai+ endpoints.
   *  Non-native bindings loop their reply envelopes back into the inbound
   *  matcher so sendAndWait waiters resolve normally.
   *  §16-14：降级绑定必须先生成并通过 mapping report 校验——required UMF
   *  字段被 drop 的绑定在此拒绝（fail-loud），不静默降级。 */
  private buildChannelFor(peer: P3394PeerRecord): { channel: P3394ChannelAdapter; report?: P3394MappingReport } {
    const endpoint = peer.endpoints?.[0] ?? '';
    if (endpoint.startsWith('p3394+a2a')) {
      const report = this.validatedMappingReport('a2a', peer);
      const channel = new P3394A2AChannel('cogseed-outbound-a2a', { endpoint: endpoint.slice('p3394+a2a:'.length) });
      channel.subscribe((envelope) => { this.tryResolveReply(envelope); });
      return { channel, report };
    }
    if (endpoint.startsWith('openai+') || peer.node_kind === 'model_runtime') {
      const report = this.validatedMappingReport('openai-model', peer);
      const channel = new P3394ModelRuntimeAdapter('cogseed-outbound-model', {
        endpoint,
        model: process.env.COGSEED_P3394_MODEL_MODEL || 'auto',
      });
      channel.subscribe((envelope) => { this.tryResolveReply(envelope); });
      return { channel, report };
    }
    return { channel: this.buildHttpChannelFor(peer) };
  }

  /** §16-14 reduced-profile 报告：生成 + 校验，required 字段被 drop 即抛
   *  p3394_reduced_profile_invalid（绑定拒绝），绝不带着坏映射上线。 */
  private validatedMappingReport(target: P3394ReducedTarget, peer: P3394PeerRecord): P3394MappingReport {
    const report = this.mappingReportFor(target);
    const validated = validateP3394MappingReport(report);
    if (validated.ok === false) {
      log.warn('P3394 reduced-profile binding rejected (required field dropped)', {
        peer: peer.identity.agent_id, target, field: validated.error.field,
      });
      throw new Error('p3394_reduced_profile_invalid:' + validated.error.field);
    }
    log.info('P3394 reduced-profile binding validated', {
      peer: peer.identity.agent_id, target, session_semantics: report.session_semantics,
    });
    return report;
  }

  /** 原生 P3394 HTTP 出站通道；https 端点按 per-peer TLS 材料（remote-nodes
   *  注入的 CA/客户端证书）dial（§15）。 */
  private buildHttpChannelFor(peer: P3394PeerRecord): P3394ChannelAdapter {
    const endpoints = [...(peer.endpoints ?? [])];
    const peerTls = this.tlsForPeer(peer);
    const wantsTls = !!peerTls || endpoints.some((endpoint) => endpoint.startsWith('https'));
    return new P3394HttpChannel('cogseed-outbound', {
      dial: {
        endpoints,
        // Registry expected_identity → dial-time identity verification.
        ...(peer.expected_identity ? { expected_identity: peer.expected_identity } : {}),
        // Per-peer outbound credential (dial_token, optional) — the outbound
        // hub must be able to reach authenticated peers.
        ...(peer.dial_token ? { bearerToken: peer.dial_token } : {}),
        ...(wantsTls ? { tls: { ...peerTls } } : {}),
      },
    });
  }

  private channelFor(peer: P3394PeerRecord): P3394ChannelAdapter {
    if (!peer.endpoints || peer.endpoints.length === 0) {
      throw new Error('p3394_peer_has_no_endpoint');
    }
    const signature = [...peer.endpoints].sort().join('|');
    const existing = this.channels.get(peer.identity.agent_id);
    if (existing && existing.signature === signature) return existing.channel;
    // Endpoint set changed → rebuild the channel so the new endpoints are used.
    if (existing) void existing.channel.close().catch(() => {});
    const built = this.buildChannelFor(peer);
    this.channels.set(peer.identity.agent_id, { signature, channel: built.channel, ...(built.report ? { report: built.report } : {}) });
    return built.channel;
  }

  /** Sends an envelope to a registered peer and waits for its reply.
   *  Transactional outbox（指南 §12）：信封先落盘（submitted），送达后 sent，
   *  收到回复 completed，投递失败 failed——重启后 submitted/sent 可重放。 */
  async sendAndWait(
    agentId: string,
    envelope: P3394Envelope,
    onStream?: (event: P3394OutboundStreamEvent) => void,
  ): Promise<P3394OutboundReply> {
    const peer = this.listPeers().find((candidate) => candidate.identity.agent_id === agentId && !candidate.disabled);
    if (!peer) throw new Error('p3394_peer_not_registered');
    if (this.pending.has(envelope.session_id)) {
      throw new Error('p3394_session_conflict');
    }
    outboxRecordSubmitted(envelope, agentId);
    const channel = this.channelFor(peer);
    const reply = new Promise<P3394OutboundReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelope.session_id);
        // sent 但未收到回复：保持 sent（可重放），不标 failed。
        reject(new Error('p3394_reply_timeout'));
      }, this.replyTimeoutMs);
      this.pending.set(envelope.session_id, {
        resolve,
        reject,
        timer,
        outboundMessageId: envelope.message_id,
        ...(onStream ? { onStream } : {}),
      });
    });
    try {
      await channel.dial(agentId);
      await new P3394OutboundClient(channel).send(envelope);
      outboxMarkSent(envelope.message_id);
    } catch (error) {
      // Delivery failed: drop the waiter so it cannot leak past this call.
      const waiter = this.pending.get(envelope.session_id);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.pending.delete(envelope.session_id);
      }
      outboxMarkFailed(envelope.message_id, error instanceof Error ? error.message : String(error));
      throw error;
    }
    log.info('P3394 outbound send', { peer: agentId, session_id: envelope.session_id, message_id: envelope.message_id });
    return reply;
  }

  /**
   * Delivery-only send: delivers an envelope to a registered peer and
   * resolves on the delivery receipt — no reply is expected and no pending
   * reply waiter is registered (P1-3).
   *
   * Why this exists: some outbound envelopes are terminal confirmations
   * (the peer-forward relay carries the final result back to the original
   * sender, an error relay, …). Older code routed those through sendAndWait,
   * which registered a reply waiter keyed on session_id and held a `sent`
   * outbox record until a reply arrived. The sender never replies to a
   * terminal confirmation, so every such relay leaked a waiter for the full
   * replyTimeoutMs AND stayed in the outbox replay set — the bridge re-sent
   * it on every restart. sendOnce completes the outbox record as soon as the
   * delivery receipt is observed, so nothing lingers and nothing replays.
   */
  async sendOnce(agentId: string, envelope: P3394Envelope): Promise<void> {
    const peer = this.listPeers().find((candidate) => candidate.identity.agent_id === agentId && !candidate.disabled);
    if (!peer) throw new Error('p3394_peer_not_registered');
    // Same transactional outbox discipline as sendAndWait: persist the
    // envelope before the wire write so a crash before delivery can replay it.
    outboxRecordSubmitted(envelope, agentId);
    try {
      const channel = this.channelFor(peer);
      await channel.dial(agentId);
      await new P3394OutboundClient(channel).send(envelope);
      outboxMarkSent(envelope.message_id);
      // Delivery receipt IS the terminal confirmation for this envelope (no
      // reply is expected). Complete the record so it leaves the replay set.
      outboxMarkCompleted(envelope.message_id);
    } catch (error) {
      // Delivery failed: fail-closed. The record stays submitted/sent-in-progress
      // (outboxMarkFailed) so recovery can retry; the caller sees the error.
      outboxMarkFailed(envelope.message_id, error instanceof Error ? error.message : String(error));
      throw error;
    }
    log.info('P3394 outbound sendOnce (delivery receipt)', { peer: agentId, session_id: envelope.session_id, message_id: envelope.message_id });
  }

  /** 桥启动重放：把 outbox 里 submitted/sent 的信封重发给对应 peer
   *  （at-least-once；对端按 idempotency_key 幂等）。不等待回复——
   *  回复到达时若没有 waiter，会照常进入会话流程。 */
  async replayOutbox(): Promise<{ replayed: number; failed: number }> {
    let replayed = 0;
    let failed = 0;
    for (const record of outboxListForReplay()) {
      try {
        const peer = this.listPeers().find((candidate) => candidate.identity.agent_id === record.peer && !candidate.disabled);
        if (!peer) throw new Error('p3394_peer_not_registered');
        const channel = this.channelFor(peer);
        await channel.dial(record.peer);
        await new P3394OutboundClient(channel).send(record.envelope);
        outboxMarkSent(record.message_id);
        replayed += 1;
        log.info('P3394 outbox replayed', { peer: record.peer, message_id: record.message_id });
      } catch (error) {
        // Replay is a recovery attempt, not a terminal delivery decision. Keep
        // submitted/sent in the replay set so a temporarily unavailable peer
        // can be retried on the next bridge recovery cycle.
        failed += 1;
        log.warn('P3394 outbox replay deferred', { peer: record.peer, message_id: record.message_id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { replayed, failed };
  }

  /** Whether a reply waiter is currently registered for this outbound session.
   *  A stable session (per scope+peer+goal) has at most one in-flight envelope;
   *  while it awaits its reply, a second sendAndWait on the same session throws
   *  `p3394_session_conflict`. Callers that want to append another message to a
   *  busy session can wait for it to drain instead of failing instantly. */
  isSessionBusy(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  /** Bounded wait until the session's in-flight waiter drains (i.e. its reply
   *  matched or its timeout released it). Resolves true when free, false on
   *  timeout or abort. Used by the conversation turn path so a second message
   *  to the same (conversation, agent, goal) session waits for the previous
   *  turn to settle instead of failing with p3394_session_conflict. */
  async waitForSessionFree(sessionId: string, timeoutMs: number = this.replyTimeoutMs, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.has(sessionId)) {
      // 用户主动取消必须立即放行：等待中的调用方据此返回 aborted，
      // 而不是把取消拖到超时窗口结束。
      if (signal?.aborted) return false;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return true;
  }

  /** Inbound-pipeline hook: resolves the waiting call when the reply arrives. */
  tryResolveReply(envelope: P3394Envelope): boolean {
    const waiter = this.pending.get(envelope.session_id);
    if (!waiter) return false;
    // 匹配粒度细化（S-03/S-04）：入站若带 reply_to，必须回指向本 waiter 期待
    // 的出站消息才算"回复"；否则它是同 session 上的新 task/另一条消息，不应
    // 被当回复消费（否则会被 executor 短路吞掉、不进 UI）。Older gateways
    // omit reply_to, so the check is only strict when the field is present.
    if (typeof envelope.reply_to === 'string' && envelope.reply_to && waiter.outboundMessageId !== envelope.reply_to) {
      return false;
    }
    const streamEvent = p3394EnvelopeStreamEvent(envelope);
    if (streamEvent) {
      if (streamEvent.sourceMessageId && streamEvent.sourceMessageId !== waiter.outboundMessageId) return false;
      if (
        streamEvent.sequence !== undefined
        && waiter.lastStreamSequence !== undefined
        && streamEvent.sequence <= waiter.lastStreamSequence
      ) {
        return true;
      }
      if (streamEvent.sequence !== undefined) waiter.lastStreamSequence = streamEvent.sequence;
      // Streaming peers can legitimately run longer than replyTimeoutMs. Treat
      // the timeout as an inactivity watchdog so live output keeps the turn
      // attached until its terminal envelope arrives.
      this.refreshReplyTimeout(envelope.session_id, waiter);
      try {
        waiter.onStream?.(streamEvent);
      } catch (error) {
        log.warn('P3394 outbound stream listener failed', {
          session_id: envelope.session_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // Stream frames are intermediate events. Keep the waiter alive until
      // the terminal message arrives, and never feed them to the executor.
      return true;
    }
    clearTimeout(waiter.timer);
    this.pending.delete(envelope.session_id);
    const text = envelopeText(envelope);
    log.info('P3394 outbound reply matched', { session_id: envelope.session_id, from: envelope.sender.agent_id });
    waiter.resolve({ text, envelope });
    // 回复到达：该出站信封在 outbox 里完成闭环。
    outboxMarkCompleted(waiter.outboundMessageId);
    return true;
  }

  /** Best-effort cleanup on app quit. */
  async close(): Promise<void> {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('p3394_bridge_closing'));
    }
    this.pending.clear();
    await Promise.all([...this.channels.values()].map((entry) => entry.channel.close().catch(() => {})));
    this.channels.clear();
  }
}

/** Joins the text parts of an envelope into a plain reply string. */
export function p3394EnvelopeReplyText(envelope: P3394Envelope): string {
  const texts: string[] = [];
  for (const part of envelope.payload.parts) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      texts.push(part.text);
    }
  }
  return texts.join('\n').trim();
}

function envelopeText(envelope: P3394Envelope): string {
  return p3394EnvelopeReplyText(envelope);
}

function p3394EnvelopeStreamEvent(envelope: P3394Envelope): P3394OutboundStreamEvent | null {
  if (envelope.kind !== 'event') return null;
  const metadata = envelope.payload.metadata;
  const streamEvent = metadata && metadata.stream_event;
  // 帧白名单（§12）：delta/progress/status/artifact 四种中间帧。白名单外的
  // 未知帧名返回 null 走终态路径——但绝不把四种已知流帧漏进终态（否则
  // waiter 被提前结算，后续真实终态到达时 session 已无人等待）。
  if (typeof streamEvent !== 'string' || !P3394_STREAM_EVENT_KINDS.has(streamEvent)) return null;
  // Do not trim deltas: a chunk can intentionally end with a space or a
  // newline, and the renderer appends it directly to the visible bubble.
  const text = envelope.payload.parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
  // status/artifact 帧允许无 text parts：内容可整体位于 stream_data（结构化
  // 状态/产物事件），只认帧名即可，不能因 text 为空掉回终态分支。
  if (!text && streamEvent !== 'status' && streamEvent !== 'artifact') return null;
  const sequence = typeof metadata.stream_seq === 'number' ? metadata.stream_seq : undefined;
  const sourceMessageId = typeof metadata.stream_source_message_id === 'string'
    ? metadata.stream_source_message_id
    : undefined;
  // 网关 claude 流解析产出的结构化过程事件（工具调用/思考起止）。
  const structuredEvent = (metadata.stream_data && typeof metadata.stream_data === 'object')
    ? (metadata.stream_data as Record<string, unknown>)
    : undefined;
  return {
    text,
    kind: streamEvent as P3394OutboundStreamEvent['kind'],
    ...(structuredEvent ? { event: structuredEvent } : {}),
    envelope,
    ...(sequence !== undefined ? { sequence } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}),
  };
}
