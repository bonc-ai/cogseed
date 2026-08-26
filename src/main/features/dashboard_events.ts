/**
 * Dashboard event fan-out (智能体总览 2.0).
 *
 * Bridges group-chat bus signals to renderer push channels via
 * `broadcastToRenderer`. Two channels, each with a deliberate minimal
 * surface — the per-conversation UI keeps its own `subscribe(uid, cid)`
 * stream; these channels only feed the cross-conversation overview:
 *
 *   dashboard:activity  task-level terminals (start/end/failure/waiting) —
 *                      low-volume, privacy-safe by construction
 *                      (TaskTerminalEvent is already the privacy-safe cut).
 *   dashboard:collab    message-level increments for the relay graph
 *                      (who → whom, dispatch marker, turn id, 80-char head).
 *
 *   dashboard:alert     reserved for health alerts (T9); nothing emits yet.
 *
 * The broadcast helper is required lazily to avoid an ipc→features import
 * cycle — same pattern as hub_account/account-events.ts.
 */

import {
  subscribeAllGroups,
  subscribeTaskTerminals,
  type GroupEvent,
  type TaskTerminalEvent,
} from './group_chat/bus';

const ipc = require('../ipc') as {
  broadcastToRenderer?: (channel: string, payload: unknown) => void;
};

function broadcast(channel: string, payload: unknown): void {
  try {
    ipc.broadcastToRenderer?.(channel, payload);
  } catch {
    // Push fan-out must never break the bus that feeds it.
  }
}

export interface DashboardCollabEvent {
  kind: 'message';
  cid: string;
  from: string;
  to: string[];
  turnId?: string;
  dispatch: boolean;
  ts: string;
  messageId: string;
  textHead: string;
}

export function dashboardCollabFromGroupEvent(ev: GroupEvent): DashboardCollabEvent | null {
  if (ev.type !== 'message') return null;
  const msg = ev.msg;
  return {
    kind: 'message',
    cid: ev.cid,
    from: msg.from,
    to: Array.isArray(msg.to) ? msg.to : [],
    ...(msg.turn_id ? { turnId: msg.turn_id } : {}),
    dispatch: msg.dispatch === true,
    ts: msg.ts,
    messageId: msg.id,
    textHead: String(msg.text || '').slice(0, 80),
  };
}

/** Wake Gate（计划门）事件 → activity 频道：让主页/协作/红点知道
 * 「有会话在等你确认」。批准/拒绝仍在会话内的确认卡片上做。 */
export function dashboardActivityFromGroupEvent(ev: GroupEvent): { kind: 'wake_request'; cid: string; agentId: string; status: string } | null {
  if (ev.type !== 'wake_request') return null;
  return {
    kind: 'wake_request',
    cid: ev.cid,
    agentId: ev.request?.agent_id || '',
    status: ev.request?.status || 'pending',
  };
}

export function dashboardActivityFromTaskTerminal(event: TaskTerminalEvent) {
  return { kind: 'task_terminal' as const, ...event };
}

let _wired = false;

export function initDashboardEvents(): void {
  if (_wired) return;
  _wired = true;
  subscribeAllGroups((ev) => {
    const collab = dashboardCollabFromGroupEvent(ev);
    if (collab) broadcast('dashboard:collab', collab);
    const wake = dashboardActivityFromGroupEvent(ev);
    if (wake) broadcast('dashboard:activity', wake);
  });
  subscribeTaskTerminals((event) => {
    broadcast('dashboard:activity', dashboardActivityFromTaskTerminal(event));
  });
}
