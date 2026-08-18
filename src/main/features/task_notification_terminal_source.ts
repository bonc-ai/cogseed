import { createLogger } from '../logger';
import {
  subscribeTaskTerminals,
  type TaskTerminalEvent,
  type TaskTerminalListener,
  type TaskTerminalStatus,
} from './group_chat/bus';

export type { TaskTerminalEvent, TaskTerminalListener, TaskTerminalStatus };

const log = createLogger('task-notification-terminal-source');
const LISTENERS_KEY = Symbol.for('cogseed.task_notification_terminal_source.listeners');
const listeners: Set<TaskTerminalListener> = ((globalThis as any)[LISTENERS_KEY] ??= new Set<TaskTerminalListener>());

export function subscribeTaskNotificationTerminals(listener: TaskTerminalListener): () => void {
  listeners.add(listener);
  const unsubscribeLegacy = subscribeTaskTerminals(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(listener);
    unsubscribeLegacy();
  };
}

export function publishTaskNotificationTerminal(event: TaskTerminalEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      log.warn('task terminal listener threw', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
