/**
 * P3394 bridge task manager — task lifecycle (SDK design §7.1).
 *
 * A task is one unit of work inside a session:
 *   submitted -> working -> input-required -> working -> completed | failed | cancelled
 *
 * Several tasks may run concurrently or sequentially inside one session;
 * the session tracks task ids, this manager tracks per-task state.
 */

export type P3394BridgeTaskState = 'submitted' | 'working' | 'input-required' | 'recoverable' | 'completed' | 'failed' | 'cancelled';

export interface P3394BridgeTask {
  task_id: string;
  session_id: string;
  message_id: string;
  state: P3394BridgeTaskState;
  created_at: string;
  /** ISO timestamp of the last state change. */
  updated_at: string;
}

const TASK_TRANSITIONS: Record<P3394BridgeTaskState, P3394BridgeTaskState[]> = {
  submitted: ['working', 'recoverable', 'completed', 'failed', 'cancelled'],
  working: ['input-required', 'recoverable', 'completed', 'failed', 'cancelled'],
  'input-required': ['working', 'recoverable', 'completed', 'failed', 'cancelled'],
  recoverable: ['working', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export class P3394BridgeTaskManager {
  private tasks = new Map<string, P3394BridgeTask>();

  constructor(private now = () => new Date().toISOString()) {}

  submit(input: Omit<P3394BridgeTask, 'state' | 'created_at' | 'updated_at'>): P3394BridgeTask {
    const existing = this.tasks.get(input.task_id);
    if (existing) return existing;
    const now = this.now();
    const t: P3394BridgeTask = { ...input, state: 'submitted', created_at: now, updated_at: now };
    this.tasks.set(t.task_id, t);
    return t;
  }

  /** Marks the task as running (first started event). */
  start(taskId: string): P3394BridgeTask {
    return this.settle(taskId, 'working');
  }

  /** Requests external input; a later working/completed event re-enters
   *  the active path. */
  awaitInput(taskId: string): P3394BridgeTask {
    return this.settle(taskId, 'input-required');
  }

  /** Marks transport loss as recoverable without declaring Runtime failure. */
  markRecoverable(taskId: string): P3394BridgeTask {
    return this.settle(taskId, 'recoverable');
  }

  /** Advances the task with transition validation; terminal re-settlement
   *  with the SAME terminal state is idempotent. */
  settle(taskId: string, state: P3394BridgeTaskState): P3394BridgeTask {
    const t = this.require(taskId);
    if (t.state === state) return t;
    if (!TASK_TRANSITIONS[t.state].includes(state)) {
      throw new Error('p3394_task_transition_' + t.state + '_to_' + state);
    }
    t.state = state;
    t.updated_at = this.now();
    return t;
  }

  get(taskId: string): P3394BridgeTask | null {
    const t = this.tasks.get(taskId);
    return t ? { ...t } : null;
  }

  /** Snapshot of all tasks (recovery controller / doctor consumption). */
  list(): P3394BridgeTask[] {
    return [...this.tasks.values()].map((t) => ({ ...t }));
  }

  /** Tasks waiting for transport recovery (state === 'recoverable'). */
  listRecoverable(): P3394BridgeTask[] {
    return this.list().filter((t) => t.state === 'recoverable');
  }

  require(taskId: string): P3394BridgeTask {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error('p3394_task_not_found');
    return t;
  }
}
