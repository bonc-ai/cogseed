/**
 * P3394 Bridge inbound execution pipeline (Phase 2).
 *
 * Turns a validated, de-duplicated envelope into a real CogSeed runtime
 * execution:
 *
 *   bridge.send(envelope)            → validation / peer resolve / replay /
 *                                      idempotency / audit (existing kernel)
 *   sessions.open / runtime.openSession → real CogSeed session
 *   runtime.deliver(envelope)        → real task admission
 *   tasks.submit + attachTask        → bridge-side lifecycle tracking
 *   forward(): runtime.stream        → real events → onEvent sink
 *   closeSession                     → runtime.closeSession (Recall/KSTAR
 *                                      recording) + contract close hook
 *
 * The executor is additive: P3394InboundServer keeps its existing receive()
 * semantics; consumers that want real execution construct the executor with
 * their own kernel/runtime wiring.
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { P3394BridgeKernel, type P3394BridgeSendResult } from './bridge';
import { P3394BridgeKstarCloseHook } from './kstar-close-hook';
import { P3394BridgeSessionManager } from './session-manager';
import { P3394BridgeTaskManager } from './task-manager';
import type { P3394Envelope, P3394PayloadPart } from './envelope';
import { normalizeDigest } from './artifact-parts';
import type { P3394RuntimeAdapter, P3394RuntimeEvent } from './runtime-adapter';

export type P3394BridgeExecutorResult =
  | { ok: true; receipt: Extract<P3394BridgeSendResult, { ok: true }>['receipt']; executed: boolean; task_id?: string; session_id?: string }
  | { ok: false; error: Extract<P3394BridgeSendResult, { ok: false }>['error'] };

export interface P3394BridgeExecutorDeps {
  bridge: P3394BridgeKernel;
  runtime: P3394RuntimeAdapter;
  sessions?: P3394BridgeSessionManager;
  tasks?: P3394BridgeTaskManager;
  kstar?: P3394BridgeKstarCloseHook;
  /** Outbound reply matcher: called when an inbound envelope may be a peer's reply. */
  outboundHub?: { tryResolveReply(envelope: P3394Envelope): boolean };
  /** KSTAR episode sink: called once per task terminal state (guide §5.4). */
  recordEpisode?: (episode: {
    session_id: string;
    task_id: string;
    goal: string;
    agent_id: string;
    status: 'completed' | 'failed' | 'cancelled';
    result?: string;
    actions: Array<{ sequence: number; kind: string; at: string; text?: string; error?: string }>;
    created_at?: string;
  }) => void;
  /** Sink for streamed runtime events (channel reply / caller hook). */
  onEvent?: (sessionId: string, event: P3394RuntimeEvent) => void | Promise<void>;
  /** §11 result auto-reply: when the peer speaks first and its envelope
   *  carries extensions.reply_endpoint/reply_token, the CogSeed answer is
   *  POSTed back automatically on task completion/failure. */
  autoReply?: P3394AutoReplyOptions;
  /** Durable session-state file per session id (SDK design §6: the six-state
   *  machine survives restarts). When absent, sessions stay in-memory. */
  sessionFileFor?: (sessionId: string) => string | null;
  /** Clock for lifecycle records. */
  now?: () => string;
}

export interface P3394AutoReplyOptions {
  /** Master switch (default: enabled). */
  enabled?: boolean;
  /** Endpoint allow-list beyond loopback (which is always allowed).
   *  Return true when the endpoint may receive an auto reply. */
  allowEndpoint?: (endpoint: string) => boolean;
  /** HTTP POST seam (tests inject a fake; default posts to /p3394/envelope). */
  post?: (endpoint: string, token: string, envelope: P3394Envelope) => Promise<void>;
}

const EXECUTABLE_KINDS = new Set(['task', 'message']);

export class P3394BridgeExecutor {
  readonly bridge: P3394BridgeKernel;
  readonly runtime: P3394RuntimeAdapter;
  readonly sessions: P3394BridgeSessionManager;
  readonly tasks: P3394BridgeTaskManager;
  readonly kstar: P3394BridgeKstarCloseHook;
  private readonly onEvent: ((sessionId: string, event: P3394RuntimeEvent) => void | Promise<void>) | undefined;
  private readonly outboundHub: { tryResolveReply(envelope: P3394Envelope): boolean } | undefined;
  private readonly recordEpisode: P3394BridgeExecutorDeps['recordEpisode'];
  private readonly autoReply: P3394AutoReplyOptions;
  private readonly now: () => string;
  private readonly forwards = new Map<string, Promise<void>>();

  constructor(deps: P3394BridgeExecutorDeps) {
    this.bridge = deps.bridge;
    this.runtime = deps.runtime;
    this.sessions = deps.sessions ?? new P3394BridgeSessionManager(deps.now, {
      filePathFor: deps.sessionFileFor,
    });
    this.tasks = deps.tasks ?? new P3394BridgeTaskManager(deps.now);
    this.kstar = deps.kstar ?? new P3394BridgeKstarCloseHook(deps.now);
    this.outboundHub = deps.outboundHub;
    this.recordEpisode = deps.recordEpisode;
    this.onEvent = deps.onEvent;
    this.autoReply = deps.autoReply ?? {};
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Runs the inbound pipeline for one envelope. Validation/duplicate/replay
   * handling stays in the kernel; only accepted envelopes reach the runtime.
   */
  execute(envelopeInput: unknown): P3394BridgeExecutorResult {
    const sent = this.bridge.send(envelopeInput);
    if (sent.ok === false) return { ok: false, error: sent.error };
    // Replayed duplicates are acknowledged but never executed again.
    if (sent.receipt.replay) {
      return { ok: true, receipt: sent.receipt, executed: false };
    }
    const envelope = sent.envelope;
    if (envelope.kind === 'control' && envelope.performative === 'cancel' && envelope.task_id) {
      // Cross-node cancellation: hand the task id to the runtime without
      // opening a session; the running forward observes the terminal event.
      void this.runtime.cancel(envelope.task_id).catch(() => {});
      return { ok: true, receipt: sent.receipt, executed: false, task_id: envelope.task_id };
    }
    // A peer's reply may resolve a waiting outbound call; it still flows
    // into the conversation below so the exchange stays visible in the UI.
    this.outboundHub?.tryResolveReply(envelope);

    if (!EXECUTABLE_KINDS.has(envelope.kind)) {
      return { ok: true, receipt: sent.receipt, executed: false };
    }

    const recipientAgentId = sent.receipt.recipient_ids[0] ?? envelope.recipients[0]?.agent_id ?? 'local';
    const goal = p3394EnvelopeGoal(envelope);
    // SDK design §7.1: sessions negotiate before work; the kernel above has
    // already verified identity + capability, so the session moves to active.
    // A waiting session (input-required) re-activates when a new message lands.
    const session = this.sessions.open({
      session_id: envelope.session_id,
      goal,
      agent_id: recipientAgentId,
    });
    this.sessions.accept(envelope.session_id);
    this.sessions.addParticipant(envelope.session_id, envelope.sender.agent_id);

    const p3394TaskId = envelope.task_id || `tsk-${envelope.message_id}`;
    this.tasks.submit({ task_id: p3394TaskId, session_id: envelope.session_id, message_id: envelope.message_id });
    session.task_ids.push(p3394TaskId);

    // Fire-and-forward: the runtime stream is drained in the background and
    // pushed to the onEvent sink; the receipt returns immediately.
    const forward = (async () => {
      const actions: Array<{ sequence: number; kind: string; at: string; text?: string; error?: string }> = [];
      let sequence = 0;
      let lastDelta = '';
      const pushAction = (kind: string, extra: { text?: string; error?: string } = {}) => {
        sequence += 1;
        actions.push({ sequence, kind, at: this.now(), ...extra });
      };
      try {
        await this.runtime.openSession({ session_id: envelope.session_id, agent_id: recipientAgentId });
        await this.runtime.deliver(envelope);
        for await (const event of this.runtime.stream(p3394TaskId)) {
          try {
            await this.onEvent?.(envelope.session_id, event);
          } catch (error) {
            this.tasks.markRecoverable(p3394TaskId);
            this.sessions.toWaiting(envelope.session_id);
            this.bridge.audit.append({ event: 'stream.pause', actor_id: envelope.sender.agent_id, status: 'accepted', metadata: { task_id: p3394TaskId, error: error instanceof Error ? error.message : String(error) } });
            return;
          }
          if (event.kind === 'artifact') {
            await this.postAutoArtifact(envelope, event.data ?? {});
          }
          if (event.kind === 'delta' && event.data && typeof event.data.text === 'string') {
            lastDelta = event.data.text;
          }
          pushAction(event.kind, event.data && typeof event.data.error === 'string' ? { error: event.data.error, text: lastDelta } : { text: lastDelta });
          // Task/session state advancement (SDK design §7.1): started → working,
          // input_required → waiting, further events → back to working/active.
          if (event.kind === 'started') {
            this.tasks.start(p3394TaskId);
          } else if (event.kind === 'input_required') {
            this.tasks.awaitInput(p3394TaskId);
            this.sessions.toWaiting(envelope.session_id);
          } else if (this.tasks.get(p3394TaskId)?.state === 'input-required') {
            this.tasks.start(p3394TaskId);
            this.sessions.activate(envelope.session_id);
          }
          if (event.kind === 'completed' || event.kind === 'failed' || event.kind === 'cancelled') {
            this.tasks.settle(p3394TaskId, event.kind);
            // KSTAR 闭环：每个任务终态产出一份 episode（goal/动作轨迹/结果/AAR）。
            this.recordEpisode?.({
              session_id: envelope.session_id,
              task_id: p3394TaskId,
              goal,
              agent_id: recipientAgentId,
              status: event.kind,
              result: lastDelta.slice(0, 24_000) || undefined,
              actions,
            });
            // §11 结果自动回发：对端先开口 → CogSeed 回答自动送回（若对端
            // 声明了 reply_endpoint）。失败也回发 error 信封。
            if (event.kind === 'completed' && lastDelta.trim()) {
              void this.postAutoReply(envelope, lastDelta.slice(0, 24_000), 'inform');
            } else if (event.kind === 'failed') {
              const failureText = event.data && typeof event.data.error === 'string'
                ? event.data.error
                : 'task failed';
              void this.postAutoReply(envelope, failureText.slice(0, 4_000), 'error');
            }
          }
        }
      } catch (error) {
        try {
          this.tasks.settle(p3394TaskId, 'failed');
        } catch {
          // Terminal already recorded — the failure is a late stream error.
        }
        const message = error instanceof Error ? error.message : String(error);
        if (this.onEvent) {
          await this.onEvent(envelope.session_id, { sequence: 0, task_id: p3394TaskId, kind: 'failed', data: { error: message } });
        }
        this.recordEpisode?.({
          session_id: envelope.session_id,
          task_id: p3394TaskId,
          goal,
          agent_id: recipientAgentId,
          status: 'failed',
          result: lastDelta.slice(0, 24_000) || undefined,
          actions: [...actions, { sequence: sequence + 1, kind: 'failed', at: this.now(), error: message }],
        });
      } finally {
        this.forwards.delete(p3394TaskId);
      }
    })();
    this.forwards.set(p3394TaskId, forward);

    return { ok: true, receipt: sent.receipt, executed: true, task_id: p3394TaskId, session_id: envelope.session_id };
  }

  private async postAutoArtifact(envelope: P3394Envelope, data: Record<string, unknown>): Promise<void> {
    if (this.autoReply.enabled === false) return;
    const ext = envelope.extensions;
    const endpoint = ext && typeof ext.reply_endpoint === 'string' ? ext.reply_endpoint.trim() : '';
    if (!endpoint) return;
    if (!this.autoReplyEndpointAllowed(endpoint)) {
      this.bridge.audit.append({ event: 'autoreply.reject', actor_id: envelope.sender.agent_id, status: 'rejected', metadata: { endpoint, kind: 'artifact' } });
      return;
    }
    const part: P3394PayloadPart = { type: 'artifact' };
    for (const key of ['uri', 'name', 'media_type'] as const) {
      if (typeof data[key] === 'string' && data[key].length <= 256) part[key] = data[key];
    }
    if (typeof data.digest === 'string') {
      const digest = normalizeDigest(data.digest);
      if (!digest) {
        this.bridge.audit.append({ event: 'autoreply.reject', actor_id: envelope.sender.agent_id, status: 'rejected', metadata: { endpoint, kind: 'artifact', reason: 'invalid_digest' } });
        return;
      }
      part.digest = digest;
    }
    if (!part.uri && part.data === undefined) return;
    const token = ext && typeof ext.reply_token === 'string' ? ext.reply_token : '';
    const reply: P3394Envelope = {
      spec_version: 'p3394/1.0',
      message_id: deriveAutoArtifactMessageId(envelope.message_id, part.digest),
      session_id: envelope.session_id,
      task_id: envelope.task_id,
      kind: 'artifact',
      performative: 'inform',
      role: 'responder',
      sender: { agent_id: 'cogseed', alias: 'CogSeed', channel_instance_id: 'cogseed-app' },
      recipients: [{ agent_id: envelope.sender.agent_id }],
      payload: { parts: [part] },
      reply_to: envelope.message_id,
      idempotency_key: 'auto-artifact:' + envelope.message_id + ':' + (part.digest ?? 'unknown'),
    };
    try {
      if (this.autoReply.post) await this.autoReply.post(endpoint, token, reply);
      else await postP3394AutoReplyHttp(endpoint, token, reply);
      this.bridge.audit.append({ event: 'autoreply.send', actor_id: envelope.sender.agent_id, status: 'accepted', metadata: { endpoint, reply_to: envelope.message_id, kind: 'artifact' } });
    } catch (error) {
      this.bridge.audit.append({ event: 'autoreply.send', actor_id: envelope.sender.agent_id, status: 'rejected', metadata: { endpoint, kind: 'artifact', error: error instanceof Error ? error.message : String(error) } });
    }
  }

  /**
   * §11 结果自动回发：向对端声明的 reply_endpoint POST 一个 reply 信封.
   * 安全边界（guide §15）：
   *  - 仅当入站信封 extensions.reply_endpoint 存在且通过 allow-list；
   *  - 默认允许 loopback（同机网关）；额外端点由 wiring 注入（已注册
   *    peer 的 endpoints）—— 绝不回发到任意外部地址；
   *  - idempotency_key 由入站 message_id 派生：重放不会重复回发。
   */
  private async postAutoReply(envelope: P3394Envelope, text: string, performative: 'inform' | 'error'): Promise<void> {
    if (this.autoReply.enabled === false) return;
    const ext = envelope.extensions;
    const endpoint = ext && typeof ext.reply_endpoint === 'string' ? ext.reply_endpoint.trim() : '';
    if (!endpoint) return;
    if (!this.autoReplyEndpointAllowed(endpoint)) {
      this.bridge.audit.append({
        event: 'autoreply.reject',
        actor_id: envelope.sender.agent_id,
        status: 'rejected',
        metadata: { endpoint },
      });
      return;
    }
    const token = ext && typeof ext.reply_token === 'string' ? ext.reply_token : '';
    const reply: P3394Envelope = {
      spec_version: 'p3394/1.0',
      message_id: deriveAutoReplyMessageId(envelope.message_id, performative),
      session_id: envelope.session_id,
      task_id: envelope.task_id,
      kind: performative === 'error' ? 'error' : 'message',
      performative,
      role: 'responder',
      sender: { agent_id: 'cogseed', alias: 'CogSeed', channel_instance_id: 'cogseed-app' },
      recipients: [{ agent_id: envelope.sender.agent_id }],
      payload: {
        parts: performative === 'error'
          ? [{ type: 'json', data: { error: text } }]
          : [{ type: 'text', text }],
      },
      reply_to: envelope.message_id,
      idempotency_key: 'auto-reply:' + envelope.message_id,
    };
    try {
      if (this.autoReply.post) {
        await this.autoReply.post(endpoint, token, reply);
      } else {
        await postP3394AutoReplyHttp(endpoint, token, reply);
      }
      this.bridge.audit.append({
        event: 'autoreply.send',
        actor_id: envelope.sender.agent_id,
        status: 'accepted',
        metadata: { endpoint, reply_to: envelope.message_id },
      });
    } catch (error) {
      this.bridge.audit.append({
        event: 'autoreply.send',
        actor_id: envelope.sender.agent_id,
        status: 'rejected',
        metadata: { endpoint, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private autoReplyEndpointAllowed(endpoint: string): boolean {
    if (isP3394LoopbackEndpoint(endpoint)) return true;
    if (this.autoReply.allowEndpoint) {
      try {
        return this.autoReply.allowEndpoint(endpoint);
      } catch {
        return false;
      }
    }
    return false;
  }

  /** Resumes forwarding persisted runtime events without re-admitting the task. */
  async resumeForward(taskId: string, sessionId: string, afterSequence = 0): Promise<void> {
    const resume = (async () => {
      this.sessions.activate(sessionId);
      for await (const event of this.runtime.stream(taskId, afterSequence)) {
        try {
          await this.onEvent?.(sessionId, event);
        } catch (error) {
          this.tasks.markRecoverable(taskId);
          this.sessions.toWaiting(sessionId);
          throw error;
        }
        if (event.kind === 'started') {
          this.tasks.start(taskId);
        }
        if (event.kind === 'completed' || event.kind === 'failed' || event.kind === 'cancelled') {
          this.tasks.settle(taskId, event.kind);
        }
      }
    })();
    this.forwards.set(taskId, resume);
    try {
      await resume;
    } finally {
      if (this.forwards.get(taskId) === resume) this.forwards.delete(taskId);
    }
  }

  /** Waits for in-flight forwarding of one task (test/diagnostic helper). */
  async awaitForward(taskId: string, timeoutMs = 30_000): Promise<void> {
    const forward = this.forwards.get(taskId);
    if (!forward) return;
    const timeout = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('p3394_forward_timeout')), timeoutMs);
    });
    await Promise.race([forward, timeout]);
  }

  /**
   * Closes a P3394 session: contract close hook first, then the real runtime
   * close (terminal-task Recall recording). Idempotent.
   */
  async closeSession(sessionId: string): Promise<unknown> {
    const session = this.sessions.require(sessionId);
    // closing → closed: the KSTAR close hook journals before commit.
    this.sessions.beginClose(sessionId);
    const record = this.kstar.close(this.sessions.close(sessionId));
    try {
      await this.runtime.closeSession(sessionId);
    } catch (error) {
      // Runtime close must not fail the audit record; Recall is best-effort.
      const message = error instanceof Error ? error.message : String(error);
      record.proposed_updates.push({ kind: 'close_error', message });
    }
    return record;
  }
}

export function deriveAutoArtifactMessageId(messageId: string, digest?: unknown): string {
  const value = typeof digest === 'string' ? digest : 'unknown';
  const hash = crypto.createHash('sha256').update(`p3394:auto-artifact:${messageId}:${value}`).digest('hex').slice(0, 32);
  return `msg-artifact-${hash}`;
}

export function deriveAutoReplyMessageId(messageId: string, performative: 'inform' | 'error'): string {
  const digest = crypto.createHash('sha256').update(`p3394:auto-reply:${performative}:${messageId}`).digest('hex').slice(0, 32);
  return `msg-reply-${digest}`;
}

function p3394EnvelopeGoal(envelope: P3394Envelope): string {
  const metadata = envelope.payload.metadata;
  if (metadata && typeof metadata === 'object' && typeof (metadata as Record<string, unknown>).goal === 'string') {
    return (metadata as Record<string, unknown>).goal as string;
  }
  return 'p3394-inbound-task';
}

/** Loopback hosts that may always receive auto replies (same-host gateway). */
export function isP3394LoopbackEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/** Default HTTP auto-reply transport: POST /p3394/envelope with Bearer token. */
export function postP3394AutoReplyHttp(endpoint: string, token: string, envelope: P3394Envelope): Promise<void> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(endpoint.replace(/\/$/, '') + '/p3394/envelope');
    } catch (error) {
      reject(error);
      return;
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const request = http.request(
      { hostname: url.hostname, port: url.port ? Number(url.port) : 80, path: url.pathname, method: 'POST', headers },
      (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode === 200) resolve();
          else reject(new Error('p3394_autoreply_http_' + res.statusCode));
        });
      },
    );
    request.setTimeout(10_000, () => request.destroy(new Error('p3394_autoreply_timeout')));
    request.on('error', reject);
    request.end(JSON.stringify({ envelope }), 'utf8');
  });
}
