import type { P3394Envelope } from './envelope';

export interface P3394RuntimeSessionBinding { session_id: string; native_session_id: string; agent_id: string }
export interface P3394RuntimeSnapshot { session_id: string; native_session_id: string; at: string; state?: Record<string, unknown> }
export interface P3394RuntimeEvent { sequence: number; task_id: string; kind: 'started' | 'delta' | 'input_required' | 'artifact' | 'completed' | 'failed' | 'cancelled'; data?: Record<string, unknown> }

export interface P3394RuntimeAdapter {
  openSession(input: { session_id: string; agent_id: string }): Promise<P3394RuntimeSessionBinding>;
  deliver(envelope: P3394Envelope): Promise<{ task_id: string }>;
  stream(taskId: string): AsyncIterable<P3394RuntimeEvent>;
  resume(sessionId: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
  snapshot(sessionId: string): Promise<P3394RuntimeSnapshot>;
  closeSession(sessionId: string): Promise<void>;
}

export interface P3394InMemoryRuntimeAdapterDeps {
  now?: () => string;
}

export class P3394InMemoryRuntimeAdapter implements P3394RuntimeAdapter {
  private sessions = new Map<string, P3394RuntimeSessionBinding>();
  private events = new Map<string, P3394RuntimeEvent[]>();
  private seq = 0;
  private now: () => string;

  constructor(deps: P3394InMemoryRuntimeAdapterDeps = {}) { this.now = deps.now ?? (() => new Date().toISOString()); }

  async openSession(input: { session_id: string; agent_id: string }): Promise<P3394RuntimeSessionBinding> {
    const existing = this.sessions.get(input.session_id);
    if (existing) return existing;
    const binding = { session_id: input.session_id, native_session_id: `native-${input.session_id}`, agent_id: input.agent_id };
    this.sessions.set(input.session_id, binding);
    return binding;
  }

  async deliver(envelope: P3394Envelope): Promise<{ task_id: string }> {
    const task_id = envelope.task_id || `task-${envelope.message_id}`;
    this.events.set(task_id, [
      { sequence: ++this.seq, task_id, kind: 'started', data: { message_id: envelope.message_id } },
      { sequence: ++this.seq, task_id, kind: 'completed', data: { session_id: envelope.session_id } },
    ]);
    return { task_id };
  }

  async *stream(taskId: string): AsyncIterable<P3394RuntimeEvent> {
    for (const event of this.events.get(taskId) ?? []) yield event;
  }

  async resume(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) throw new Error('p3394_runtime_session_not_found');
  }

  async cancel(taskId: string): Promise<void> {
    const events = this.events.get(taskId) ?? [];
    events.push({ sequence: ++this.seq, task_id: taskId, kind: 'cancelled' });
    this.events.set(taskId, events);
  }

  async snapshot(sessionId: string): Promise<P3394RuntimeSnapshot> {
    const binding = this.sessions.get(sessionId);
    if (!binding) throw new Error('p3394_runtime_session_not_found');
    return { session_id: sessionId, native_session_id: binding.native_session_id, at: this.now() };
  }

  async closeSession(sessionId: string): Promise<void> { this.sessions.delete(sessionId); }
}
