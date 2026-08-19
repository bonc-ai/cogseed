/**
 * P3394 bridge session manager — canonical session lifecycle (SDK design §7.1).
 *
 * State machine:
 *   [*] -> negotiating -> active <-> waiting <-> active
 *              | rejected        | suspended <-> active (recover)
 *           active/suspended/waiting -> closing -> closed
 *
 * A session is longer-lived than one task: it carries participants, tasks,
 * an ownership/recovery epoch, and an optimistic version for shared-metadata
 * conflict detection (§7.2). Task state lives in task-manager.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type P3394BridgeSessionState =
  | 'negotiating'
  | 'active'
  | 'waiting'
  | 'suspended'
  | 'closing'
  | 'closed'
  | 'rejected';

export interface P3394BridgeSession {
  session_id: string;
  goal: string;
  /** Local agent owning the session (the recipient running the work). */
  agent_id: string;
  /** Authenticated participants (agent ids), including the owner. */
  participants: string[];
  task_ids: string[];
  state: P3394BridgeSessionState;
  /** Ownership/recovery epoch: bumped whenever ownership or recovery state
   *  changes (§7.2). */
  epoch: number;
  /** Optimistic version counter: every mutation bumps it so concurrent
   *  updates to shared session metadata can be detected (§7.2). */
  version: number;
  created_at: string;
  activated_at?: string;
  closed_at?: string;
}

const SESSION_TRANSITIONS: Record<P3394BridgeSessionState, P3394BridgeSessionState[]> = {
  negotiating: ['active', 'rejected'],
  active: ['waiting', 'suspended', 'closing'],
  waiting: ['active', 'closing'],
  suspended: ['active', 'closing'],
  closing: ['closed'],
  closed: [],
  rejected: [],
};

export interface P3394SessionManagerOptions {
  /** Session state file per session id (Agent Home sessions/<id>/session.json
   *  style). When provided, every state mutation persists atomically and
   *  open() restores the durable state — the six-state machine survives
   *  bridge/app restarts (SDK design §6/§7: sessions are durable). */
  filePathFor?: (sessionId: string) => string | null;
}

const SESSION_FILE_SCHEMA_VERSION = 1;

export class P3394BridgeSessionManager {
  private sessions = new Map<string, P3394BridgeSession>();
  private readonly filePathFor: (sessionId: string) => string | null;

  constructor(private now = () => new Date().toISOString(), options: P3394SessionManagerOptions = {}) {
    this.filePathFor = options.filePathFor ?? (() => null);
  }

  /** Opens or restores a session. New sessions start in 'negotiating'; the
   *  executor moves them to 'active' once identity/capability checks pass. */
  open(input: { session_id: string; goal: string; agent_id: string }): P3394BridgeSession {
    const existing = this.sessions.get(input.session_id);
    if (existing) return existing;
    // Durable restore: the session file is the authoritative copy across
    // restarts (state machine, participants, tasks, epoch/version).
    const restored = this.loadSession(input.session_id);
    if (restored) {
      this.sessions.set(input.session_id, restored);
      return restored;
    }
    const session: P3394BridgeSession = {
      ...input,
      participants: [input.agent_id],
      task_ids: [],
      state: 'negotiating',
      epoch: 1,
      version: 1,
      created_at: this.now(),
    };
    this.sessions.set(input.session_id, session);
    this.persistSession(session);
    return session;
  }

  /** Reads the durable session record (tolerant of absence/corruption). */
  private loadSession(sessionId: string): P3394BridgeSession | null {
    const file = this.filePathFor(sessionId);
    if (!file) return null;
    try {
      if (!fs.existsSync(file)) return null;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { schema_version?: number; session?: Partial<P3394BridgeSession> };
      if (parsed.schema_version !== SESSION_FILE_SCHEMA_VERSION || !parsed.session) return null;
      const raw = parsed.session;
      if (raw.session_id !== sessionId || typeof raw.agent_id !== 'string') return null;
      const session: P3394BridgeSession = {
        session_id: String(raw.session_id),
        goal: typeof raw.goal === 'string' ? raw.goal : '',
        agent_id: raw.agent_id,
        participants: Array.isArray(raw.participants) ? raw.participants.filter((v): v is string => typeof v === 'string') : [],
        task_ids: Array.isArray(raw.task_ids) ? raw.task_ids.filter((v): v is string => typeof v === 'string') : [],
        state: this.validState(raw.state) ? raw.state : 'negotiating',
        epoch: Number.isSafeInteger(raw.epoch) && (raw.epoch as number) > 0 ? raw.epoch as number : 1,
        version: Number.isSafeInteger(raw.version) && (raw.version as number) > 0 ? raw.version as number : 1,
        created_at: typeof raw.created_at === 'string' ? raw.created_at : this.now(),
        ...(typeof raw.activated_at === 'string' ? { activated_at: raw.activated_at } : {}),
        ...(typeof raw.closed_at === 'string' ? { closed_at: raw.closed_at } : {}),
      };
      return session;
    } catch {
      return null;
    }
  }

  private validState(value: unknown): value is P3394BridgeSessionState {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SESSION_TRANSITIONS, value);
  }

  /** Atomic tmp+rename write of the session record (best-effort). */
  private persistSession(session: P3394BridgeSession): void {
    const file = this.filePathFor(session.session_id);
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ schema_version: SESSION_FILE_SCHEMA_VERSION, session, saved_at: this.now() }, null, 2));
      fs.renameSync(tmp, file);
    } catch {
      // Durability is best-effort; in-memory state stays authoritative in
      // this process.
    }
  }

  /** negotiating -> active (identity and capabilities accepted). Idempotent
   *  on an already-active session. */
  accept(sessionId: string): P3394BridgeSession {
    const s = this.require(sessionId);
    if (s.state === 'active') return s;
    this.transition(s, 'active');
    s.activated_at = this.now();
    this.persistSession(s);
    return s;
  }

  /** negotiating -> rejected (policy or profile failure). */
  reject(sessionId: string): P3394BridgeSession {
    const s = this.require(sessionId);
    this.transition(s, 'rejected');
    return s;
  }

  /** active -> waiting (input or external event required). */
  toWaiting(sessionId: string): P3394BridgeSession {
    const s = this.require(sessionId);
    if (s.state === 'waiting') return s;
    this.transition(s, 'waiting');
    return s;
  }

  /** waiting/suspended -> active (message, resume, or recovery arrived). */
  activate(sessionId: string): P3394BridgeSession {
    const s = this.require(sessionId);
    if (s.state === 'active') return s;
    if (s.state === 'closed' || s.state === 'rejected') {
      throw new Error('p3394_session_terminal');
    }
    this.transition(s, 'active');
    return s;
  }

  /** active -> suspended (local agent unavailable). */
  suspend(sessionId: string): P3394BridgeSession {
    const s = this.require(sessionId);
    this.transition(s, 'suspended');
    return s;
  }

  /** -> closing. The final close() commits to 'closed' (journal committed). */
  beginClose(sessionId: string): P3394BridgeSession {
    const s = this.require(sessionId);
    if (s.state === 'closing' || s.state === 'closed') return s;
    this.transition(s, 'closing');
    return s;
  }

  /** closing -> closed (idempotent). Non-negotiated sessions cannot be
   *  committed: callers must accept or reject first. */
  close(sessionId: string): P3394BridgeSession {
    const s = this.require(sessionId);
    if (s.state === 'closed') return s;
    if (s.state !== 'closing') {
      if (s.state === 'negotiating') {
        throw new Error('p3394_session_not_negotiated');
      }
      this.transition(s, 'closing');
    }
    this.transition(s, 'closed');
    s.closed_at = this.now();
    this.persistSession(s);
    return s;
  }

  /** Registers an authenticated participant (idempotent). */
  addParticipant(sessionId: string, agentId: string): P3394BridgeSession {
    const s = this.require(sessionId);
    if (!s.participants.includes(agentId)) {
      s.participants.push(agentId);
      this.bump(s);
    }
    return s;
  }

  /** Ownership/recovery epoch bump (§7.2: epochs change when ownership or
   *  recovery state changes). */
  bumpEpoch(sessionId: string): P3394BridgeSession {
    const s = this.require(sessionId);
    s.epoch += 1;
    this.bump(s);
    return s;
  }

  attachTask(sessionId: string, taskId: string): void {
    const s = this.require(sessionId);
    if (!s.task_ids.includes(taskId)) {
      s.task_ids.push(taskId);
      this.bump(s);
    }
  }

  list(): P3394BridgeSession[] {
    return [...this.sessions.values()].map((s) => ({ ...s, participants: [...s.participants], task_ids: [...s.task_ids] }));
  }

  require(sessionId: string): P3394BridgeSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('p3394_session_not_found');
    return s;
  }

  private transition(s: P3394BridgeSession, next: P3394BridgeSessionState): void {
    if (!SESSION_TRANSITIONS[s.state].includes(next)) {
      throw new Error('p3394_session_transition_' + s.state + '_to_' + next);
    }
    s.state = next;
    this.bump(s);
  }

  private bump(s: P3394BridgeSession): void {
    s.version += 1;
    this.persistSession(s);
  }
}
