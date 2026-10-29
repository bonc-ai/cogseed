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
import {
  outboxBackgroundResultDelivered,
  outboxBackgroundResultStatus,
  outboxListForReplay,
  outboxMarkBackgroundResultDelivered,
  outboxMarkBackgroundResultIsolated,
  outboxMarkCompleted,
  outboxMarkFailed,
  outboxMarkIsolated,
  outboxMarkSent,
  outboxRecordBackgroundResult,
  outboxRecordBackgroundResultFailure,
  outboxRecordReplayFailure,
  outboxRecordSubmitted,
  outboxReplayDecision,
} from './outbound-outbox';
import {
  P3394_BACKGROUND_JOB_DEADLINE_MS,
  parseBackgroundAccepted,
  parseBackgroundFinished,
  type P3394BackgroundAccepted,
  type P3394BackgroundFinished,
} from './background-jobs';
import {
  backgroundTimeoutResult,
  getBackgroundJob,
  listUndeliveredBackgroundJobs,
  patchBackgroundJob,
  putBackgroundJob,
  type P3394BackgroundJobRecord,
} from './background-job-store';
import type { P3394Envelope } from './envelope';
import type { P3394PeerRecord } from './registry';

const log = createLogger('p3394-bridge:outbound-hub');

export interface P3394OutboundReply {
  text: string;
  envelope: P3394Envelope;
  /** `background` when the peer answered phase 1 (`accepted`) instead of
   *  holding the request open. No further reply is expected on this waiter;
   *  the result arrives later as its own `background.finished` message. */
  kind?: 'reply' | 'background';
  background?: P3394BackgroundAccepted;
}

export interface P3394BackgroundResultInput {
  result: P3394BackgroundFinished;
  job: P3394BackgroundJobRecord;
  /** Present for a live phase-2 message, absent on a startup replay. */
  envelope?: P3394Envelope;
}

export interface P3394OutboundStreamEvent {
  text: string;
  /** 'delta' → 正文增量（可见气泡）；'progress' → process rail 过程日志（工具调用等）。 */
  kind: 'delta' | 'progress';
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
  /** Peer node id and the exact envelope we sent: phase 1 needs both to build
   *  the durable background-job record (reply target + session/task ids). */
  agentId: string;
  outboundEnvelope: P3394Envelope;
  onStream?: (event: P3394OutboundStreamEvent) => void;
  lastStreamSequence?: number;
}

export interface P3394OutboundHubDeps {
  /** Live peer lookup — the app bridge registry. */
  listPeers: () => P3394PeerRecord[];
  /** Maximum idle period while waiting for the peer's reply. */
  replyTimeoutMs?: number;
  /** Active uid. Background jobs are user-scoped machine-private state; without
   *  it the hub can still resolve phase 1 but cannot persist/replay the job. */
  userId?: () => string;
  /** Independent ceiling for a promoted job (default 60 min). */
  backgroundJobDeadlineMs?: number;
  /** Delivery attempts before a phase-2 result is isolated (default 3). */
  isolateAfterAttempts?: number;
  /** Sink for a phase-2 result into the originating conversation. Returns
   *  `discarded` when that conversation no longer exists (drop, no retry). */
  deliverBackgroundResult?: (input: P3394BackgroundResultInput) => Promise<'delivered' | 'discarded'> | 'delivered' | 'discarded';
  now?: () => number;
  /** Retry backoff for a failed conversation delivery (test seam). */
  backgroundRetryDelayMs?: (attempt: number) => number;
  /** Maps a P3394 session id to the user-visible conversation it belongs to.
   *  Recorded with the job so replay after a restart still reaches the right
   *  conversation even though the in-memory binding is gone. */
  conversationIdFor?: (sessionId: string) => string | undefined;
}

export class P3394OutboundHub {
  private readonly listPeers: () => P3394PeerRecord[];
  private readonly replyTimeoutMs: number;
  private readonly userId?: () => string;
  private readonly deliverBackgroundResultToConversation?: P3394OutboundHubDeps['deliverBackgroundResult'];
  private readonly backgroundJobDeadlineMs: number;
  private readonly isolateAfterAttempts: number;
  private readonly now: () => number;
  private readonly backgroundRetryDelayMs: (attempt: number) => number;
  private readonly conversationIdFor?: (sessionId: string) => string | undefined;
  private readonly channels = new Map<string, { signature: string; channel: P3394ChannelAdapter }>();
  private readonly pending = new Map<string, PendingReply>();
  private readonly backgroundTimers = new Map<string, NodeJS.Timeout>();
  private readonly backgroundRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly backgroundDeliveries = new Map<string, Promise<void>>();

  constructor(deps: P3394OutboundHubDeps) {
    this.listPeers = deps.listPeers;
    // Must stay comfortably ABOVE the managed gateway's agent timeout
    // (`P3394_AGENT_TIMEOUT_MS`, 8 min) so a deadline promotion still lands
    // inside this window instead of racing the hub into a timeout.
    this.replyTimeoutMs = deps.replyTimeoutMs ?? 12 * 60 * 1000;
    this.userId = deps.userId;
    this.deliverBackgroundResultToConversation = deps.deliverBackgroundResult;
    this.backgroundJobDeadlineMs = deps.backgroundJobDeadlineMs ?? P3394_BACKGROUND_JOB_DEADLINE_MS;
    this.isolateAfterAttempts = Math.max(1, Math.floor(deps.isolateAfterAttempts ?? 3));
    this.now = deps.now ?? (() => Date.now());
    this.backgroundRetryDelayMs = deps.backgroundRetryDelayMs ?? ((attempt) => Math.min(30_000, 1000 * Math.max(1, attempt)));
    this.conversationIdFor = deps.conversationIdFor;
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
   *  matcher so sendAndWait waiters resolve normally. */
  private buildChannelFor(peer: P3394PeerRecord): P3394ChannelAdapter {
    const endpoint = peer.endpoints?.[0] ?? '';
    if (endpoint.startsWith('p3394+a2a')) {
      const channel = new P3394A2AChannel('cogseed-outbound-a2a', { endpoint: endpoint.slice('p3394+a2a:'.length) });
      channel.subscribe((envelope) => { this.tryResolveReply(envelope); });
      return channel;
    }
    if (endpoint.startsWith('openai+') || peer.node_kind === 'model_runtime') {
      const channel = new P3394ModelRuntimeAdapter('cogseed-outbound-model', {
        endpoint,
        model: process.env.COGSEED_P3394_MODEL_MODEL || 'auto',
      });
      channel.subscribe((envelope) => { this.tryResolveReply(envelope); });
      return channel;
    }
    return new P3394HttpChannel('cogseed-outbound', {
      dial: {
        endpoints: [...(peer.endpoints ?? [])],
        // Registry expected_identity → dial-time identity verification.
        ...(peer.expected_identity ? { expected_identity: peer.expected_identity } : {}),
        // Per-peer outbound credential (dial_token, optional) — the outbound
        // hub must be able to reach authenticated peers.
        ...(peer.dial_token ? { bearerToken: peer.dial_token } : {}),
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
    const channel = this.buildChannelFor(peer);
    this.channels.set(peer.identity.agent_id, { signature, channel });
    return channel;
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
        agentId,
        outboundEnvelope: envelope,
        ...(onStream ? { onStream } : {}),
      });
    });
    try {
      await channel.dial(agentId);
      await new P3394OutboundClient(channel).send(envelope);
      // A fast phase-1 ack can settle the waiter before the send receipt is
      // observed. Do not re-open the outbox record with a later `sent` event:
      // that would put an already-acknowledged request back in the replay set.
      if (this.pending.has(envelope.session_id)) outboxMarkSent(envelope.message_id);
      else outboxMarkCompleted(envelope.message_id);
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

  /**
   * Phase 1 (`extensions.background.phase === 'accepted'`) resolved inside
   * `tryResolveReply`. Persist the job *before* the caller can observe the
   * resolution, so a crash between accepted and finished still leaves a
   * replayable record.
   */
  private acceptBackground(waiter: PendingReply, accepted: P3394BackgroundAccepted): void {
    const uid = this.backgroundUid();
    if (!uid) {
      log.warn('P3394 background accepted without an active user; job not persisted', { job_id: accepted.job_id });
      return;
    }
    try {
      const existing = getBackgroundJob(uid, accepted.job_id);
      if (existing) {
        // Gateway retried phase 1 (at-least-once): keep the original deadline
        // and watchdog instead of extending it on every duplicate.
        if (existing.state === 'pending') this.armBackgroundWatchdog(existing);
        return;
      }
      const acceptedAt = new Date(this.now()).toISOString();
      const ext = waiter.outboundEnvelope.extensions ?? {};
      let conversationId: string | undefined;
      try { conversationId = this.conversationIdFor?.(waiter.outboundEnvelope.session_id) || undefined; } catch { /* optional */ }
      const job: P3394BackgroundJobRecord = {
        job_id: accepted.job_id,
        peer: waiter.agentId,
        reply_endpoint: typeof ext.reply_endpoint === 'string' ? ext.reply_endpoint : '',
        reply_token: typeof ext.reply_token === 'string' ? ext.reply_token : '',
        deadline: new Date(this.now() + this.backgroundJobDeadlineMs).toISOString(),
        state: 'pending',
        accepted_at: acceptedAt,
        updated_at: acceptedAt,
        session_id: waiter.outboundEnvelope.session_id,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        ...(typeof waiter.outboundEnvelope.task_id === 'string' ? { task_id: waiter.outboundEnvelope.task_id } : {}),
        ...(accepted.eta_seconds ? { eta_seconds: accepted.eta_seconds } : {}),
      };
      const saved = putBackgroundJob(uid, job);
      this.armBackgroundWatchdog(saved);
      log.info('P3394 background job accepted', {
        job_id: saved.job_id,
        peer: saved.peer,
        deadline: saved.deadline,
      });
    } catch (error) {
      // Persistence failure must not turn an accepted task into a rejected
      // turn; it only loses replay (the live phase-2 path can still deliver).
      log.warn('P3394 background job could not be recorded', {
        job_id: accepted.job_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private backgroundUid(): string | null {
    try {
      const uid = this.userId?.();
      return uid ? String(uid) : null;
    } catch {
      return null;
    }
  }

  private armBackgroundWatchdog(job: P3394BackgroundJobRecord): void {
    this.clearBackgroundTimer(job.job_id);
    const deadline = Date.parse(job.deadline);
    const delay = Number.isFinite(deadline) ? Math.max(0, deadline - this.now()) : 0;
    const timer = setTimeout(() => { this.onBackgroundDeadline(job.job_id); }, delay);
    timer.unref?.();
    this.backgroundTimers.set(job.job_id, timer);
  }

  private clearBackgroundTimer(jobId: string): void {
    const timer = this.backgroundTimers.get(jobId);
    if (!timer) return;
    clearTimeout(timer);
    this.backgroundTimers.delete(jobId);
  }

  private clearBackgroundRetryTimer(jobId: string): void {
    const timer = this.backgroundRetryTimers.get(jobId);
    if (!timer) return;
    clearTimeout(timer);
    this.backgroundRetryTimers.delete(jobId);
  }

  private onBackgroundDeadline(jobId: string): void {
    this.backgroundTimers.delete(jobId);
    const uid = this.backgroundUid();
    if (!uid) return;
    const job = getBackgroundJob(uid, jobId);
    if (!job || job.state !== 'pending') return;
    const result = backgroundTimeoutResult(jobId);
    const updated = patchBackgroundJob(uid, jobId, { state: 'timeout', result }) ?? job;
    log.warn('P3394 background job timed out locally', { job_id: jobId, peer: job.peer });
    void this.startBackgroundDelivery(updated, result);
  }

  /** Phase 2 (`background.finished`). Returns true when the envelope was a
   *  background result and must not continue through the normal inbound task
   *  path; false when it is an ordinary envelope. Idempotent by job_id.
   *
   *  Delivery itself is asynchronous (it can be a conversation write), but the
   *  inbound pipeline is synchronous: the terminal payload is persisted before
   *  this returns, and the actual sink write runs through
   *  `startBackgroundDelivery` so a crash cannot lose the result. */
  deliverBackgroundResult(envelope: P3394Envelope): boolean {
    const result = parseBackgroundFinished(envelope.extensions?.background);
    if (!result) return false;
    const uid = this.backgroundUid();
    if (!uid) {
      log.warn('P3394 background result dropped: no active user', { job_id: result.job_id, peer: envelope.sender.agent_id });
      return true;
    }
    let job = getBackgroundJob(uid, result.job_id);
    if (!job) {
      // Ledger missing (fresh install/corrupt file): adopt the result so a
      // duplicate can still be deduped by the outbox job_id marker.
      const now = new Date(this.now()).toISOString();
      job = putBackgroundJob(uid, {
        job_id: result.job_id,
        peer: envelope.sender.agent_id,
        reply_endpoint: '',
        reply_token: '',
        deadline: now,
        state: 'finished',
        accepted_at: now,
        updated_at: now,
        session_id: envelope.session_id,
        ...(typeof envelope.task_id === 'string' ? { task_id: envelope.task_id } : {}),
        result,
      });
    } else {
      if (job.state === 'delivered' || job.state === 'discarded' || job.state === 'isolated') {
        log.info('P3394 background result already settled; duplicate ignored', { job_id: result.job_id, state: job.state });
        return true;
      }
      if (outboxBackgroundResultDelivered(job.job_id)) {
        this.markBackgroundDelivered(uid, job.job_id);
        return true;
      }
      // A finished frame supersedes a pending watchdog: the gateway reported
      // the real outcome before our local ceiling.
      this.clearBackgroundTimer(job.job_id);
      job = patchBackgroundJob(uid, job.job_id, { state: 'finished', result }) ?? job;
    }
    void this.startBackgroundDelivery(job, result);
    return true;
  }

  /** Dedupe in-flight conversation writes per job_id (a duplicate phase 2 must
   *  not race the first delivery). */
  private startBackgroundDelivery(job: P3394BackgroundJobRecord, result: P3394BackgroundFinished): Promise<void> {
    const existing = this.backgroundDeliveries.get(job.job_id);
    if (existing) return existing;
    const run = this.deliverBackgroundJob(job, result)
      .catch((error) => {
        // Never let a disk/sink failure become an unhandled rejection: the job
        // stays `finished` and the next boot replay retries it.
        log.warn('P3394 background delivery failed unexpectedly', {
          job_id: job.job_id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.backgroundDeliveries.delete(job.job_id);
      });
    this.backgroundDeliveries.set(job.job_id, run);
    return run;
  }

  /** Await every in-flight background delivery (tests / graceful shutdown). */
  async flushBackgroundDeliveries(): Promise<void> {
    await Promise.all([...this.backgroundDeliveries.values()]);
  }

  private markBackgroundDelivered(uid: string, jobId: string): void {
    const job = getBackgroundJob(uid, jobId);
    if (!job || job.state === 'delivered') return;
    patchBackgroundJob(uid, jobId, {
      state: 'delivered',
      delivered_at: new Date(this.now()).toISOString(),
      last_error: undefined,
    });
    outboxMarkBackgroundResultDelivered(jobId);
  }

  private async deliverBackgroundJob(job: P3394BackgroundJobRecord, result: P3394BackgroundFinished): Promise<void> {
    const uid = this.backgroundUid();
    if (!uid) return;
    // Terminal dedupe (job_id is the idempotency key): a duplicate phase 2 or
    // a restart replay after success must never enter the conversation twice.
    if (outboxBackgroundResultDelivered(job.job_id)) {
      this.markBackgroundDelivered(uid, job.job_id);
      return;
    }
    if (outboxBackgroundResultStatus(job.job_id) === 'isolated') {
      patchBackgroundJob(uid, job.job_id, { state: 'isolated' });
      return;
    }
    if (!outboxRecordBackgroundResult(job.job_id, job.peer)) {
      if (outboxBackgroundResultDelivered(job.job_id)) this.markBackgroundDelivered(uid, job.job_id);
      return;
    }
    const sink = this.deliverBackgroundResultToConversation;
    try {
      if (!sink) throw new Error('p3394_background_delivery_sink_missing');
      const outcome = await sink({ result, job });
      if (outcome === 'discarded') {
        // Failure-mode table: the originating conversation was deleted → drop
        // with a warning and never retry.
        patchBackgroundJob(uid, job.job_id, {
          state: 'discarded',
          delivered_at: new Date(this.now()).toISOString(),
        });
        outboxMarkBackgroundResultDelivered(job.job_id);
        log.warn('P3394 background result discarded (conversation gone)', { job_id: job.job_id, peer: job.peer });
        return;
      }
      this.markBackgroundDelivered(uid, job.job_id);
      log.info('P3394 background result delivered', { job_id: job.job_id, peer: job.peer, outcome: result.outcome });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = outboxRecordBackgroundResultFailure(job.job_id, message);
      const updated = patchBackgroundJob(uid, job.job_id, { attempts, last_error: message }) ?? job;
      if (attempts >= this.isolateAfterAttempts) {
        patchBackgroundJob(uid, job.job_id, { state: 'isolated' });
        outboxMarkBackgroundResultIsolated(job.job_id, message);
        log.warn('P3394 background result isolated', { job_id: job.job_id, attempts, error: message });
        return;
      }
      log.warn('P3394 background result delivery deferred', { job_id: job.job_id, attempts, error: message });
      this.scheduleBackgroundRetry(updated, result, attempts);
    }
  }

  private scheduleBackgroundRetry(job: P3394BackgroundJobRecord, result: P3394BackgroundFinished, attempts: number): void {
    this.clearBackgroundRetryTimer(job.job_id);
    const delay = Math.max(0, this.backgroundRetryDelayMs(attempts));
    const timer = setTimeout(() => {
      this.backgroundRetryTimers.delete(job.job_id);
      const uid = this.backgroundUid();
      if (!uid) return;
      const current = getBackgroundJob(uid, job.job_id);
      if (!current || (current.state !== 'finished' && current.state !== 'timeout')) return;
      void this.deliverBackgroundJob(current, current.result ?? result);
    }, delay);
    timer.unref?.();
    this.backgroundRetryTimers.set(job.job_id, timer);
  }

  /** Startup replay (decision 2, step 4): every job that has not entered the
   *  conversation is revisited exactly once per boot.
   *
   *  - finished/timeout with a recorded result → deliver (idempotent);
   *  - pending past its ceiling → synthesize `timeout` and deliver;
   *  - pending within its ceiling → re-arm the watchdog.
   */
  async replayBackgroundJobs(): Promise<{ replayed: number; timedOut: number; delivered: number; isolated: number; deferred: number }> {
    const uid = this.backgroundUid();
    const outcome = { replayed: 0, timedOut: 0, delivered: 0, isolated: 0, deferred: 0 };
    if (!uid) return outcome;
    const replayedJobIds = listUndeliveredBackgroundJobs(uid).map((job) => job.job_id);
    for (const job of listUndeliveredBackgroundJobs(uid)) {
      try {
        if (job.state === 'pending') {
          const deadline = Date.parse(job.deadline);
          if (!Number.isFinite(deadline) || deadline <= this.now()) {
            const result = backgroundTimeoutResult(job.job_id);
            const updated = patchBackgroundJob(uid, job.job_id, { state: 'timeout', result });
            if (updated) {
              outcome.timedOut += 1;
              await this.startBackgroundDelivery(updated, result);
            }
          } else {
            this.armBackgroundWatchdog(job);
            outcome.deferred += 1;
          }
          continue;
        }
        if (job.result) {
          outcome.replayed += 1;
          await this.startBackgroundDelivery(job, job.result);
        }
      } catch (error) {
        log.warn('P3394 background job replay failed', {
          job_id: job.job_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const jobId of replayedJobIds) {
      const current = getBackgroundJob(uid, jobId);
      if (current?.state === 'delivered') outcome.delivered += 1;
      else if (current?.state === 'isolated') outcome.isolated += 1;
    }
    return outcome;
  }

  /** 桥启动重放：把 outbox 里 submitted/sent 的信封重发给对应 peer
   *  （at-least-once；对端按 idempotency_key 幂等）。不等待回复——
   *  回复到达时若没有 waiter，会照常进入会话流程。 */
  async replayOutbox(options: { isolateAfterAttempts?: number } = {}): Promise<{ replayed: number; failed: number; isolated: number }> {
    const isolateAfterAttempts = options.isolateAfterAttempts ?? 3;
    let replayed = 0;
    let failed = 0;
    let isolated = 0;
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
        const message = error instanceof Error ? error.message : String(error);
        // Replay is a recovery attempt, not a terminal delivery decision: a
        // transiently unavailable peer stays in the replay set and never
        // consumes the record's budget. Configuration-level unreachability
        // (peer gone / no endpoint) never succeeds by retrying, so after the
        // configured attempts it is isolated — kept on disk, out of replay.
        const configLevel = message === 'p3394_peer_not_registered' || message === 'p3394_peer_has_no_endpoint';
        const attempts = configLevel ? outboxRecordReplayFailure(record.message_id, message) : 0;
        if (outboxReplayDecision(message, attempts, isolateAfterAttempts) === 'isolate') {
          outboxMarkIsolated(record.message_id, message);
          isolated += 1;
          log.warn('P3394 outbox record isolated', { peer: record.peer, message_id: record.message_id, attempts, error: message });
        } else {
          failed += 1;
          log.warn('P3394 outbox replay deferred', { peer: record.peer, message_id: record.message_id, attempts, error: message });
        }
      }
    }
    return { replayed, failed, isolated };
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
    // Phase 2 is a terminal notification with no waiter. It is consumed by
    // `deliverBackgroundResult` in the executor; never let a duplicate fall
    // through into the task path (an empty/boilerplate message would wake the
    // Commander for nothing).
    const accepted = parseBackgroundAccepted(envelope.extensions?.background);
    const finished = parseBackgroundFinished(envelope.extensions?.background);
    if (finished) return true;
    if (accepted) {
      if (!waiter) {
        log.info('P3394 duplicate background accepted ignored', { job_id: accepted.job_id, session_id: envelope.session_id });
        return true;
      }
      if (typeof envelope.reply_to === 'string' && envelope.reply_to && waiter.outboundMessageId !== envelope.reply_to) {
        return false;
      }
      clearTimeout(waiter.timer);
      this.pending.delete(envelope.session_id);
      this.acceptBackground(waiter, accepted);
      const text = envelopeText(envelope);
      log.info('P3394 outbound background accepted', {
        session_id: envelope.session_id,
        from: envelope.sender.agent_id,
        job_id: accepted.job_id,
      });
      waiter.resolve({ text, envelope, kind: 'background', background: accepted });
      // Phase 1 is the terminal acknowledgement for this outbound envelope:
      // the original request is done. The result is tracked as a separate job.
      outboxMarkCompleted(waiter.outboundMessageId);
      return true;
    }
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
    for (const timer of this.backgroundTimers.values()) clearTimeout(timer);
    this.backgroundTimers.clear();
    for (const timer of this.backgroundRetryTimers.values()) clearTimeout(timer);
    this.backgroundRetryTimers.clear();
    await Promise.allSettled([...this.backgroundDeliveries.values()]);
    this.backgroundDeliveries.clear();
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
  if (streamEvent !== 'delta' && streamEvent !== 'progress') return null;
  // Do not trim deltas: a chunk can intentionally end with a space or a
  // newline, and the renderer appends it directly to the visible bubble.
  const text = envelope.payload.parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
  if (!text) return null;
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
    kind: streamEvent,
    ...(structuredEvent ? { event: structuredEvent } : {}),
    envelope,
    ...(sequence !== undefined ? { sequence } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}),
  };
}
