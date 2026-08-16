/**
 * P3394 Bridge → CogSeed Backend runtime adapter (Phase 2).
 *
 * Wires the contract-first P3394RuntimeAdapter into the real CogSeed
 * backend execution path:
 *
 *   openSession  → getOrCreateMateSession (real session-store record)
 *   deliver      → mateRuntimeController.startMateTask (task admission)
 *   stream       → readMateTaskEvents + readMateTask (event/status polling)
 *   resume       → mateRuntimeController.resumeMateTask (recoverable tasks)
 *   cancel       → mateRuntimeController.cancelMateTask
 *   snapshot     → listMateTasks over the session
 *   closeSession → recordMateTaskRunForRecall for terminal tasks
 *
 * The adapter keeps explicit P3394 session/task id ↔ CogSeed id mappings so
 * P3394 session/task semantics stay the canonical external identity while
 * CogSeed ids (`mate-session-*`, `mate-task-*`) remain the storage truth.
 * Mappings are in-memory for this phase; persistence lands with the Phase 1
 * registry/journal hardening.
 *
 * Failure discipline: a failed external request must never mutate the active
 * recipient/orchestration ledger beyond its own task records — all calls go
 * through the existing backend stores, and Recall recording at close is
 * best-effort.
 */

import * as fs from 'node:fs';
import { getActiveUserId } from '../users';
import { genId12, writeJsonSync } from '../../storage';
import { createLogger } from '../../logger';
import { getOrCreateMateSession, readMateSession } from '../cogseed_backend/session-store';
import {
  mateRuntimeController,
  type MateRuntimeController,
} from '../cogseed_backend/runtime-controller';
import { listMateTasks, readMateTask } from '../cogseed_backend/task-store';
import { readMateTaskEvents } from '../cogseed_backend/event-store';
import { recordMateTaskRunForRecall } from '../cogseed_backend/recall-bridge';
import type { MateTaskEvent } from '../cogseed_backend/types';
import type { P3394Envelope } from './envelope';
import type {
  P3394RuntimeAdapter,
  P3394RuntimeEvent,
  P3394RuntimeSessionBinding,
  P3394RuntimeSnapshot,
} from './runtime-adapter';

const log = createLogger('p3394-bridge:cogseed-runtime-adapter');

export interface P3394CogseedRuntimeAdapterDeps {
  /** Resolves the owning user; defaults to the active app user. */
  userId?: () => string;
  /** CogSeed runtime controller; defaults to the app-wide singleton. */
  controller?: MateRuntimeController;
  /** Clock for snapshot/audit timestamps. */
  now?: () => string;
  /** Event polling interval for stream(). */
  pollIntervalMs?: number;
  /** Upper bound for stream() polling before failing. */
  streamTimeoutMs?: number;
  /** Optional persistence file for the session/task id mappings (Agent Home). */
  stateFile?: string;
}

export interface P3394CogseedAdapterState {
  schemaVersion: 1;
  sessions: Array<{ p3394_session_id: string; mate_session_id: string; agent_id?: string }>;
  tasks: Array<{ p3394_task_id: string; mate_task_id: string; p3394_session_id: string }>;
}

export const P3394_COGSEED_ADAPTER_DEFAULTS = {
  pollIntervalMs: 120,
  streamTimeoutMs: 15 * 60 * 1000,
} as const;

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Joins text payload parts into one task instruction. */
export function p3394EnvelopeTextTask(envelope: P3394Envelope): string {
  const texts: string[] = [];
  for (const part of envelope.payload.parts) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      texts.push(part.text);
    }
  }
  return texts.join('\n').trim();
}

export class P3394CogseedRuntimeAdapter implements P3394RuntimeAdapter {
  private readonly userId: () => string;
  private readonly controller: MateRuntimeController;
  private readonly now: () => string;
  private readonly pollIntervalMs: number;
  private readonly streamTimeoutMs: number;
  private readonly stateFile: string | null;

  /** p3394 session_id → CogSeed mate-session-* id. */
  private readonly sessionMap = new Map<string, string>();
  /** p3394 session_id → CogSeed agent id used for its tasks. */
  private readonly sessionAgentMap = new Map<string, string>();
  /** CogSeed session ids confirmed to still exist in the backend this boot. */
  private readonly verifiedSessions = new Set<string>();
  /** p3394 task_id → CogSeed mate-task-* id. */
  private readonly taskMap = new Map<string, string>();
  /** p3394 task_id → p3394 session_id. */
  private readonly taskSessionMap = new Map<string, string>();

  constructor(deps: P3394CogseedRuntimeAdapterDeps = {}) {
    this.userId = deps.userId ?? getActiveUserId;
    this.controller = deps.controller ?? mateRuntimeController;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.pollIntervalMs = deps.pollIntervalMs ?? P3394_COGSEED_ADAPTER_DEFAULTS.pollIntervalMs;
    this.streamTimeoutMs = deps.streamTimeoutMs ?? P3394_COGSEED_ADAPTER_DEFAULTS.streamTimeoutMs;
    this.stateFile = deps.stateFile ?? null;
    if (this.stateFile) this.loadStateSync();
  }

  /** Restores session/task mappings after a restart (tolerant of absence). */
  private loadStateSync(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile!, 'utf8')) as P3394CogseedAdapterState;
      if (parsed.schemaVersion !== 1) return;
      for (const item of parsed.sessions) {
        this.sessionMap.set(item.p3394_session_id, item.mate_session_id);
        if (item.agent_id) this.sessionAgentMap.set(item.p3394_session_id, item.agent_id);
      }
      for (const item of parsed.tasks) {
        this.taskMap.set(item.p3394_task_id, item.mate_task_id);
        this.taskSessionMap.set(item.p3394_task_id, item.p3394_session_id);
      }
    } catch {
      // Missing or malformed state file: start with an empty mapping.
    }
  }

  /** Atomically persists the mapping state (best-effort). */
  private persistState(): void {
    if (!this.stateFile) return;
    try {
      const state: P3394CogseedAdapterState = {
        schemaVersion: 1,
        sessions: [...this.sessionMap.entries()].map(([p3394_session_id, mate_session_id]) => ({
          p3394_session_id,
          mate_session_id,
          ...(this.sessionAgentMap.get(p3394_session_id) ? { agent_id: this.sessionAgentMap.get(p3394_session_id) } : {}),
        })),
        tasks: [...this.taskMap.entries()].map(([p3394_task_id, mate_task_id]) => ({
          p3394_task_id,
          mate_task_id,
          p3394_session_id: this.taskSessionMap.get(p3394_task_id) ?? '',
        })),
      };
      writeJsonSync(this.stateFile, state);
    } catch (error) {
      log.warn('P3394 adapter state persistence failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Resolves the CogSeed session backing a P3394 session, creating it on first contact. */
  private async mateSessionFor(sessionId: string, agentId?: string): Promise<string> {
    const existing = this.sessionMap.get(sessionId);
    if (existing) {
      // A mapping restored from the state file may point at a session the
      // backend no longer has (e.g. the variant data root was reset). Verify
      // lazily on first use instead of failing the delivery.
      if (!this.verifiedSessions.has(existing)) {
        const record = await readMateSession(this.userId(), existing).catch(() => null);
        if (!record) {
          log.warn('P3394 adapter restored mate session missing; recreating', {
            p3394_session_id: sessionId,
            mate_session_id: existing,
          });
          this.sessionMap.delete(sessionId);
          this.sessionAgentMap.delete(sessionId);
          this.persistState();
        } else {
          this.verifiedSessions.add(existing);
        }
      }
      const recreated = this.sessionMap.get(sessionId);
      if (recreated) {
        if (agentId) this.sessionAgentMap.set(sessionId, agentId);
        return recreated;
      }
    }
    const record = await getOrCreateMateSession(this.userId());
    this.sessionMap.set(sessionId, record.sessionId);
    this.verifiedSessions.add(record.sessionId);
    if (agentId) this.sessionAgentMap.set(sessionId, agentId);
    this.persistState();
    return record.sessionId;
  }

  async openSession(input: { session_id: string; agent_id: string }): Promise<P3394RuntimeSessionBinding> {
    const mateSessionId = await this.mateSessionFor(input.session_id, input.agent_id);
    return { session_id: input.session_id, native_session_id: mateSessionId, agent_id: input.agent_id };
  }

  async deliver(envelope: P3394Envelope): Promise<{ task_id: string }> {
    const userId = this.userId();
    const text = p3394EnvelopeTextTask(envelope);
    if (!text) throw new Error('p3394_message_has_no_text_part');

    const recipientAgentId = envelope.recipients[0]?.agent_id;
    const mateSessionId = await this.mateSessionFor(envelope.session_id, recipientAgentId);
    const agentId = this.sessionAgentMap.get(envelope.session_id);

    const task = await this.controller.startMateTask(userId, {
      requestId: `req-${genId12()}`,
      task: text.slice(0, 64_000),
      sessionId: mateSessionId,
      ...(agentId ? { agentId } : {}),
    });

    const p3394TaskId = envelope.task_id || `tsk-${envelope.message_id}`;
    this.taskMap.set(p3394TaskId, task.taskId);
    this.taskSessionMap.set(p3394TaskId, envelope.session_id);
    this.persistState();
    return { task_id: p3394TaskId };
  }

  async *stream(taskId: string): AsyncIterable<P3394RuntimeEvent> {
    const mateTaskId = this.taskMap.get(taskId);
    if (!mateTaskId) throw new Error('p3394_task_not_found');
    const userId = this.userId();
    const sessionId = this.taskSessionMap.get(taskId);
    let lastSequence = 0;
    let sequence = 0;
    const deadline = Date.now() + this.streamTimeoutMs;

    for (;;) {
      const events = await readMateTaskEvents(userId, mateTaskId, lastSequence, 200);
      for (const event of events) {
        lastSequence = event.sequence;
        const mapped = mapMateTaskEvent(event);
        if (mapped) {
          sequence += 1;
          yield { ...mapped, sequence, task_id: taskId };
        }
      }
      const task = await readMateTask(userId, mateTaskId);
      if (task) {
        if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
          sequence += 1;
          yield { sequence, task_id: taskId, kind: task.status, data: { session_id: sessionId } };
          return;
        }
        // `recoverable` is not terminal: a later resume keeps this stream alive.
      }
      if (Date.now() > deadline) throw new Error('p3394_runtime_stream_timeout');
      await sleep(this.pollIntervalMs);
    }
  }

  async resume(sessionId: string): Promise<void> {
    const userId = this.userId();
    const mateSessionId = this.sessionMap.get(sessionId);
    if (!mateSessionId) throw new Error('p3394_session_not_found');
    const recoverable = (await listMateTasks(userId))
      .filter((task) => task.sessionId === mateSessionId && task.status === 'recoverable');
    if (recoverable.length === 0) throw new Error('p3394_no_recoverable_task');
    const target = recoverable[0];
    await this.controller.resumeMateTask(userId, target.taskId, {
      requestId: `req-${genId12()}`,
      continuation: target.task.slice(0, 64_000),
    });
  }

  async cancel(taskId: string): Promise<void> {
    const mateTaskId = this.taskMap.get(taskId);
    if (!mateTaskId) throw new Error('p3394_task_not_found');
    await this.controller.cancelMateTask(this.userId(), mateTaskId);
  }

  async snapshot(sessionId: string): Promise<P3394RuntimeSnapshot> {
    const userId = this.userId();
    const mateSessionId = this.sessionMap.get(sessionId);
    if (!mateSessionId) throw new Error('p3394_session_not_found');
    const tasks = (await listMateTasks(userId))
      .filter((task) => task.sessionId === mateSessionId)
      .map((task) => ({ task_id: task.taskId, status: task.status }));
    return {
      session_id: sessionId,
      native_session_id: mateSessionId,
      at: this.now(),
      state: { tasks },
    };
  }

  async closeSession(sessionId: string): Promise<void> {
    const userId = this.userId();
    const mateSessionId = this.sessionMap.get(sessionId);
    if (!mateSessionId) throw new Error('p3394_session_not_found');
    const terminalTasks = (await listMateTasks(userId))
      .filter((task) => task.sessionId === mateSessionId && TERMINAL_TASK_STATUSES.has(task.status));
    for (const task of terminalTasks) {
      try {
        await recordMateTaskRunForRecall(userId, task.taskId);
      } catch (error) {
        log.warn('P3394 close: Recall recording skipped', {
          sessionId,
          taskId: task.taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.sessionMap.delete(sessionId);
    this.sessionAgentMap.delete(sessionId);
    for (const [taskId, mapped] of [...this.taskMap.entries()]) {
      if (this.taskSessionMap.get(taskId) === sessionId) {
        this.taskMap.delete(taskId);
        this.taskSessionMap.delete(taskId);
        void mapped;
      }
    }
    this.persistState();
  }
}

function mapMateTaskEvent(event: MateTaskEvent): Omit<P3394RuntimeEvent, 'sequence' | 'task_id'> | null {
  switch (event.type) {
    case 'task.started':
      return { kind: 'started' };
    case 'model.delta':
      return { kind: 'delta', data: { text: typeof event.payload.text === 'string' ? event.payload.text : '' } };
    case 'tool.started':
      return { kind: 'delta', data: { tool: 'started', name: typeof event.payload.name === 'string' ? event.payload.name : undefined } };
    case 'tool.finished':
      return { kind: 'delta', data: { tool: 'finished', name: typeof event.payload.name === 'string' ? event.payload.name : undefined } };
    default:
      return null;
  }
}
