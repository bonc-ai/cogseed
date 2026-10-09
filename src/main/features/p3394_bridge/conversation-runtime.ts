/**
 * P3394 conversation-backed runtime adapter (Phase 2, path B).
 *
 * Routes inbound P3394 messages into CogSeed's normal daily conversation
 * flow (features/group_chat bus) instead of the separate cogseed-task backend:
 *
 *   deliver → ensureConversation (chats index row, so the exchange is visible
 *             in the sidebar) → register the peer as its own conversation
 *             actor (agent kind, named after the peer — never the user) →
 *             subscribe (BEFORE enqueue, so a fast reply is never missed) →
 *             bus.enqueue({ uid, cid, fromActorId: peerActorId, forceTo:
 *             [COMMANDER_ID], text }) — the external agent speaks into a real
 *             conversation under its own identity, and CogSeed answers with
 *             its normal model/tools/skills exactly like a human message.
 *   stream  → resolves the task's reply waiter: the next official end-of-turn
 *             (`turn_end: true`) non-user message in that conversation, which
 *             is handed to the FIFO-earliest task so concurrent tasks on the
 *             same conversation never steal each other's replies.
 *
 * The conversation id is derived deterministically from the P3394 session id
 * so sessions stay stable across restarts without extra state files.
 */

import { createLogger } from '../../logger';
import { COMMANDER_ID, USER_ID, addMember } from '../group_chat/state';
import { genId12 } from '../../storage';
import { attachmentDirForCid } from '../chat_attachments';
import { objectPartsToFiles, resourcePartsToFiles } from './artifact-parts';
import type { P3394Envelope } from './envelope';
import type {
  P3394RuntimeAdapter,
  P3394RuntimeEvent,
  P3394RuntimeSessionBinding,
  P3394RuntimeSnapshot,
} from './runtime-adapter';

const log = createLogger('p3394-bridge:conversation-runtime');

/** Minimal structural shape of a group-chat message event. */
export interface P3394ConversationMessageEvent {
  type: string;
  cid?: string;
  /**
   * `turn_end: true` ONLY when this message is the actor's own runTurn-end
   * output (the "official" end-of-turn reply). Tool-emitted side-effect
   * messages (plan announcements, dispatches) carry false/absent.
   */
  turn_end?: boolean;
  msg?: { from?: string; text?: string };
}

export interface P3394ConversationBus {
  enqueue(params: {
    uid: string;
    cid: string;
    fromActorId: string;
    text: string;
    /** External agent traffic skips the Recall projection-confirmation gate. */
    skipKstarRouting?: boolean;
    /** Attachment names (conversation attachment dir) carried on the message. */
    attachments?: string[];
    /** Route this message to explicit recipients instead of the router. */
    forceTo?: string[];
    /** Trusted external-channel inbound: keeps the abort-reset / task-run
     *  semantics of a user message while persisting the peer's own actor
     *  identity (only the bridge wiring sets this). */
    externalInbound?: boolean;
  }): Promise<unknown>;
  subscribe(uid: string, cid: string, listener: (ev: P3394ConversationMessageEvent) => void): () => void;
}

export interface P3394ConversationRuntimeDeps {
  userId?: () => string;
  bus?: P3394ConversationBus;
  /** P3394 session_id → conversation id; defaults to 'p3394-' + hash(session). */
  conversationForSession?: (sessionId: string) => string;
  /**
   * Registers the conversation in the chats index (idempotent) so it appears
   * in the sidebar. Defaults to chats.createConversation; tests inject a fake.
   */
  ensureConversation?: (uid: string, cid: string, title: string) => Promise<unknown>;
  /** Human-readable name for a peer agent (registry display name), used for
   *  the conversation title and the peer's roster entry. Falls back to the
   *  agent id when unknown. */
  displayNameFor?: (agentId: string) => string | undefined;
  /** Resolves the stable P3394 peer id to the projected AI-team Agent id.
   *  Unknown peers fall back to a temporary p3394_<peer> actor. */
  teamAgentIdForPeer?: (peerAgentId: string) => string | undefined;
  /** Registers the peer as a real conversation actor (agent kind) so its
   *  messages render under the peer's own identity, not the user's. Defaults
   *  to the group-chat roster writer. */
  ensurePeerActor?: (uid: string, cid: string, actor: { kind: 'agent'; id: string; name: string }) => Promise<unknown>;
  /** Fetches a p3394-object resource part from the sender's resource
   *  endpoint (§12). Receives the sender agent id + digest; returns content
   *  or null. */
  fetchObject?: (senderAgentId: string, digest: string) => Promise<Buffer | null>;
  now?: () => string;
  /** Upper bound waiting for the CogSeed reply. */
  replyTimeoutMs?: number;
}

export const P3394_CONVERSATION_DEFAULTS = {
  replyTimeoutMs: 5 * 60 * 1000,
} as const;

function hashString(value: string, seed: number): number {
  let hash = seed | 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function stableCid(sessionId: string): string {
  // Fully deterministic: two independent hashes of the session id. Restarts
  // map the same P3394 session to the SAME conversation (guide §5.3 会话恢复).
  return 'p3394-' + hashString(sessionId, 0).toString(36) + '-' + hashString(sessionId, 5381).toString(36);
}

/** Deterministic per-peer conversation actor id.
 *
 *  Prefixed + sanitized so a remote agent identity can never collide with
 *  reserved ids (`user`/`commander`) or local agent ids, and always passes
 *  the group-chat `safeId` gate. Same peer → same actor across sessions and
 *  restarts, so its roster entry and bubbles stay consistent. */
export function p3394PeerActorId(agentId: string): string {
  const sanitized = String(agentId || '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return `p3394_${sanitized || 'peer'}`;
}

/** Joins text payload parts into one conversation message. */
function p3394Text(envelope: P3394Envelope): string {
  const texts: string[] = [];
  for (const part of envelope.payload.parts) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      texts.push(part.text);
    }
  }
  return texts.join('\n').trim();
}

type ReplyResult = { ok: true; text: string } | { ok: false; error: string };

interface ReplyWaiter {
  taskId: string;
  cid: string;
  settled: boolean;
  timer: NodeJS.Timeout;
  promise: Promise<ReplyResult>;
  resolve: (result: ReplyResult) => void;
}

export class P3394ConversationRuntimeAdapter implements P3394RuntimeAdapter {
  private readonly userId: () => string;
  private readonly bus: P3394ConversationBus;
  private readonly conversationForSession: (sessionId: string) => string;
  private readonly ensureConversation: (uid: string, cid: string, title: string) => Promise<unknown>;
  private readonly displayNameFor: (agentId: string) => string | undefined;
  private readonly teamAgentIdForPeer: (peerAgentId: string) => string | undefined;
  private readonly ensurePeerActor: (uid: string, cid: string, actor: { kind: 'agent'; id: string; name: string }) => Promise<unknown>;
  private readonly fetchObject: ((senderAgentId: string, digest: string) => Promise<Buffer | null>) | undefined;
  private readonly now: () => string;
  private readonly replyTimeoutMs: number;

  /** p3394 session_id → conversation id. */
  private readonly sessionCidMap = new Map<string, string>();
  /** p3394 task_id → conversation id. */
  private readonly taskCidMap = new Map<string, string>();
  /** conversation id → live bus subscription. */
  private readonly cidSubscriptions = new Map<string, () => void>();
  /** conversation id → FIFO queue of tasks waiting for the next reply. */
  private readonly waitersByCid = new Map<string, ReplyWaiter[]>();
  /** p3394 task_id → its reply waiter. */
  private readonly taskWaiterMap = new Map<string, ReplyWaiter>();

  constructor(deps: P3394ConversationRuntimeDeps = {}) {
    this.userId = deps.userId ?? (() => '');
    if (!deps.bus) throw new Error('p3394_conversation_bus_unavailable');
    this.bus = deps.bus;
    this.conversationForSession = deps.conversationForSession ?? stableCid;
    this.ensureConversation =
      deps.ensureConversation ??
      (async (uid, cid, title) => {
        const chats = await import('../chats');
        await chats.createConversation(uid, { conversationId: cid, title });
      });
    this.displayNameFor = deps.displayNameFor ?? (() => undefined);
    this.teamAgentIdForPeer = deps.teamAgentIdForPeer ?? (() => undefined);
    this.ensurePeerActor =
      deps.ensurePeerActor ??
      (async (uid, cid, actor) => {
        await addMember(uid, cid, actor);
      });
    this.fetchObject = deps.fetchObject;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.replyTimeoutMs = deps.replyTimeoutMs ?? P3394_CONVERSATION_DEFAULTS.replyTimeoutMs;
  }

  /** 出站会话绑定：p3394_send 从当前对话发起时，把 session 显式绑定到
   *  该对话——对端的回复路由回同一个对话（不新建 [P3394] peer 独立对话）。 */
  bindSession(sessionId: string, cid: string): void {
    if (!sessionId || !cid) return;
    this.sessionCidMap.set(sessionId, cid);
  }

  private cidFor(sessionId: string): string {
    const existing = this.sessionCidMap.get(sessionId);
    if (existing) return existing;
    const cid = this.conversationForSession(sessionId);
    this.sessionCidMap.set(sessionId, cid);
    return cid;
  }

  /**
   * Per-conversation bus subscription, established lazily. `subscribe` on the
   * real bus is per-cid, so we keep one listener per cid and broadcast to
   * that cid's waiter queue.
   */
  private ensureCidSubscribed(uid: string, cid: string): void {
    if (this.cidSubscriptions.has(cid)) return;
    const unsubscribe = this.bus.subscribe(uid, cid, (ev) => this.onBusEvent(cid, ev));
    this.cidSubscriptions.set(cid, unsubscribe);
  }

  private onBusEvent(cid: string, ev: P3394ConversationMessageEvent): void {
    if (ev.type !== 'message' || !ev.msg) return;
    // Only official end-of-turn replies count; tool side-effects and
    // plan announcements (turn_end false/absent) must not consume a task.
    if (ev.turn_end !== true) return; // our own injected peer message has no turn_end
    if (ev.msg.from === USER_ID) return; // belt-and-suspenders: never treat the human as a reply
    const text = typeof ev.msg.text === 'string' ? ev.msg.text.trim() : '';
    if (!text) return;
    const queue = this.waitersByCid.get(cid);
    if (!queue || queue.length === 0) return;
    // FIFO: commander processes turns serially, so replies arrive in task
    // order; handing each reply to the earliest waiter keeps concurrent
    // tasks from stealing each other's replies.
    const waiter = queue[0];
    if (waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    this.dropWaiter(cid, waiter);
    log.info('P3394 conversation reply captured', { cid, from: ev.msg.from, task_id: waiter.taskId });
    waiter.resolve({ ok: true, text });
  }

  private dropWaiter(cid: string, waiter: ReplyWaiter): void {
    const queue = this.waitersByCid.get(cid);
    if (!queue) return;
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.waitersByCid.delete(cid);
    // taskWaiterMap is the authoritative task → waiter index; it survives
    // settlement so stream() can still resolve a reply that landed before
    // the stream started (dropped only on cancel/closeSession).
  }

  /** Queues a reply waiter for the task; resolves on reply, timeout, or cancel. */
  private armWaiter(taskId: string, cid: string): void {
    let waiter!: ReplyWaiter;
    const promise = new Promise<ReplyResult>((resolve) => {
      waiter = {
        taskId,
        cid,
        settled: false,
        timer: setTimeout(() => {
          if (waiter && !waiter.settled) {
            waiter.settled = true;
            this.dropWaiter(cid, waiter);
            resolve({ ok: false, error: 'p3394_reply_timeout' });
          }
        }, this.replyTimeoutMs),
        promise: undefined as never,
        resolve,
      };
    });
    // The executor above runs synchronously; patch the placeholder now that
    // `promise` is initialized (avoids TDZ on a back-reference).
    waiter.promise = promise;
    const queue = this.waitersByCid.get(cid) ?? [];
    queue.push(waiter);
    this.waitersByCid.set(cid, queue);
    this.taskWaiterMap.set(taskId, waiter);
  }
  async openSession(input: { session_id: string; agent_id: string }): Promise<P3394RuntimeSessionBinding> {
    const cid = this.cidFor(input.session_id);
    return { session_id: input.session_id, native_session_id: cid, agent_id: input.agent_id };
  }

  async deliver(envelope: P3394Envelope): Promise<{ task_id: string }> {
    const text = p3394Text(envelope);
    if (!text) throw new Error('p3394_message_has_no_text_part');
    const uid = this.userId();
    if (!uid) throw new Error('p3394_user_not_active');
    const cid = this.cidFor(envelope.session_id);
    const agentId = envelope.sender.agent_id || 'external-agent';
    // Protocol identity remains stable on the wire (`claude`, `hermes`, …),
    // while CogSeed's team/chat identity reuses the projected Agent id. This
    // keeps cards, permissions, avatars, mentions and message authorship on one
    // identity instead of creating a second `p3394_<peer>` actor.
    const actorId = this.teamAgentIdForPeer(agentId) || p3394PeerActorId(agentId);
    // Display-name precedence: the sender's self-declared alias (P3394's
    // human-readable participant name), then the registry display name,
    // then the agent id itself. User-built agents name themselves via alias.
    const senderAlias =
      typeof envelope.sender.alias === 'string' && envelope.sender.alias.trim()
        ? envelope.sender.alias.trim()
        : '';
    const displayName =
      (senderAlias || this.displayNameFor(agentId) || agentId).trim().slice(0, 60) || agentId;

    // Register the conversation in the chats index so the exchange is
    // visible in the sidebar (idempotent on an explicit cid).
    try {
      await this.ensureConversation(uid, cid, `[P3394] ${displayName}`);
    } catch (error) {
      log.warn('P3394 conversation index registration failed', {
        cid,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Give the peer its own conversation actor identity (agent kind, named
    // after the peer). Its messages must render under the peer's identity —
    // never the user's. Idempotent; failure must not block inbound delivery.
    try {
      await this.ensurePeerActor(uid, cid, { kind: 'agent', id: actorId, name: displayName });
    } catch (error) {
      log.warn('P3394 peer actor registration failed', {
        cid,
        actor_id: actorId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Subscribe BEFORE enqueue: a fast reply can arrive on the same
    // microtask cycle as enqueue returns, and must not be missed.
    this.ensureCidSubscribed(uid, cid);

    // Inline artifact parts → conversation attachment dir (digest-verified),
    // so the Commander's read tools and the UI can both reach the files.
    // p3394-object parts are pulled from the sender's resource endpoint (§12)
    // when a fetcher is wired, then verified by digest.
    let attachmentNames: string[] = [];
    let artifactNote = '';
    try {
      const decoded = resourcePartsToFiles(envelope.payload.parts, attachmentDirForCid(uid, cid));
      if (decoded.ok && decoded.files.length) {
        attachmentNames = decoded.files.map((file) => file.name);
      }
    } catch (error) {
      log.warn('P3394 inbound artifact save failed', {
        cid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (this.fetchObject) {
      try {
        const fetched = await objectPartsToFiles(envelope.payload.parts, attachmentDirForCid(uid, cid), (digest) => {
          return this.fetchObject!(envelope.sender.agent_id, digest);
        });
        if (fetched.ok === false) {
          log.warn('P3394 inbound object fetch failed', { cid, error: fetched.error });
        } else if (fetched.files.length) {
          attachmentNames = attachmentNames.concat(fetched.files.map((file) => file.name));
        }
      } catch (error) {
        log.warn('P3394 inbound object fetch failed', {
          cid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (attachmentNames.length) {
      artifactNote = '\n\n📎 对端发来文件：' + attachmentNames.join('、') + '（已保存到本会话附件目录）';
    }

    await this.bus.enqueue({
      uid,
      cid,
      // The peer speaks under its own agent identity — this is what makes
      // the bubble show "Hermes" instead of "user".
      fromActorId: actorId,
      ...(attachmentNames.length ? { attachments: attachmentNames } : {}),
      text: (text.slice(0, 16_000) + artifactNote),
      // Route straight to the Commander so CogSeed answers the peer.
      // Security boundary (guide §15): external messages NEVER wake a named
      // local agent directly — only the Commander can dispatch, and that
      // dispatch goes through the ordinary wake-approval gate.
      forceTo: [COMMANDER_ID],
      // External agent traffic must not be parked behind the Recall
      // projection-confirmation gate; it flows straight into the conversation.
      skipKstarRouting: true,
      // Trusted inbound: keeps the user-message abort-reset / task-run
      // lifecycle semantics while persisting the peer's own identity.
      externalInbound: true,
    });

    const p3394TaskId = envelope.task_id || `tsk-${envelope.message_id}`;
    this.taskCidMap.set(p3394TaskId, cid);
    this.armWaiter(p3394TaskId, cid);
    return { task_id: p3394TaskId };
  }

  /** Yields started, then the CogSeed reply as delta + completed. */
  async *stream(taskId: string): AsyncIterable<P3394RuntimeEvent> {
    const cid = this.taskCidMap.get(taskId);
    if (!cid) throw new Error('p3394_task_not_found');
    let sequence = 0;
    sequence += 1;
    yield { sequence, task_id: taskId, kind: 'started' };

    const waiter = this.taskWaiterMap.get(taskId);
    if (!waiter) {
      sequence += 1;
      yield { sequence, task_id: taskId, kind: 'failed', data: { error: 'p3394_task_not_found' } };
      return;
    }
    const reply = await waiter.promise;
    if (reply.ok === false) {
      sequence += 1;
      yield { sequence, task_id: taskId, kind: 'failed', data: { error: reply.error } };
      return;
    }
    sequence += 1;
    yield { sequence, task_id: taskId, kind: 'delta', data: { text: reply.text } };
    sequence += 1;
    yield { sequence, task_id: taskId, kind: 'completed' };
  }

  async resume(_sessionId: string): Promise<void> {
    // A conversation is inherently resumable by the user; nothing to do.
  }

  async cancel(taskId: string): Promise<void> {
    const waiter = this.taskWaiterMap.get(taskId);
    if (!waiter || waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    this.dropWaiter(waiter.cid, waiter);
    waiter.resolve({ ok: false, error: 'p3394_task_cancelled' });
  }

  async snapshot(sessionId: string): Promise<P3394RuntimeSnapshot> {
    const cid = this.sessionCidMap.get(sessionId);
    if (!cid) throw new Error('p3394_session_not_found');
    return { session_id: sessionId, native_session_id: cid, at: this.now(), state: { conversation: cid } };
  }

  async closeSession(sessionId: string): Promise<void> {
    const cid = this.sessionCidMap.get(sessionId);
    if (!cid) throw new Error('p3394_session_not_found');
    this.sessionCidMap.delete(sessionId);
    for (const [taskId, mapped] of [...this.taskCidMap.entries()]) {
      if (mapped === cid) this.taskCidMap.delete(taskId);
    }
    // Settle any waiters still pending on this conversation (they must not
    // hang past the session's lifetime).
    const queue = this.waitersByCid.get(cid);
    if (queue) {
      for (const waiter of [...queue]) {
        if (waiter.settled) continue;
        waiter.settled = true;
        clearTimeout(waiter.timer);
        waiter.resolve({ ok: false, error: 'p3394_session_closed' });
      }
      this.waitersByCid.delete(cid);
    }
    for (const [taskId, waiter] of [...this.taskWaiterMap.entries()]) {
      if (waiter.cid === cid) this.taskWaiterMap.delete(taskId);
    }
    const unsubscribe = this.cidSubscriptions.get(cid);
    if (unsubscribe) {
      unsubscribe();
      this.cidSubscriptions.delete(cid);
    }
  }
}

