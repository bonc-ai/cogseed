import { t } from '../i18n';
import { createLogger } from '../logger';
import {
  subscribeTaskTerminals,
  type TaskTerminalEvent,
  type TaskTerminalListener,
  type TaskTerminalStatus,
} from './group_chat/bus';

const log = createLogger('task-notifications');

export interface TaskNotificationHandle {
  onClick(listener: () => void): void;
  show(): void;
}

export interface TaskNotificationRuntime {
  getActiveUserId(): string;
  isEnabled(): boolean;
  hasFocusedWindow(): boolean;
  isSupported(): boolean;
  setBadgeCount(count: number): void;
  onDidFocus(listener: () => void): () => void;
  createNotification(options: { title: string; body: string }): TaskNotificationHandle;
  openConversation(conversationId: string, status: TaskTerminalStatus): void;
}

type TaskTerminalSubscribe = (listener: TaskTerminalListener) => () => void;

/** 「到点未执行」的通知文案：说明缺的是哪一项、去处理什么（FR-051）。
 *  只由 main 调用，渲染层不参与，避免和任务行上的提示重复实现。 */
export function skipNotificationCopy(input: { title?: string; count?: number }): { title: string; body: string } {
  return {
    title: t('notification.auto_skip.title'),
    body: t('notification.auto_skip.body', {
      title: input.title || '',
      count: String(Math.max(0, Math.trunc(input.count || 0))),
    }),
  };
}

function copyFor(status: Exclude<TaskTerminalStatus, 'cancelled'>): { title: string; body: string } {
  return {
    title: t(`notification.task.${status}.title`),
    body: t(`notification.task.${status}.body`),
  };
}

/**
 * Bridge privacy-safe bus terminal events to the operating system. The caller
 * owns all Electron dependencies so this feature stays independently testable.
 */
export interface SkipNotificationOptions {
  /** 定时任务到点未执行的事件源（`auto_tasks.subscribeFires`）；不传就不发这类通知。 */
  subscribeFires?: (listener: (event: {
    type: string; task_id?: string; title?: string; items?: unknown[];
  }) => void) => () => void;
}

export function startTaskNotifications(
  runtime: TaskNotificationRuntime,
  subscribe: TaskTerminalSubscribe = subscribeTaskTerminals,
  opts: SkipNotificationOptions = {},
): () => void {
  let unreadCount = 0;

  const updateBadge = (nextCount: number): void => {
    unreadCount = Math.max(0, Math.trunc(nextCount));
    try {
      runtime.setBadgeCount(unreadCount);
    } catch (err) {
      // The badge is an additional best-effort attention layer. A platform
      // integration failure must not suppress the native notification.
      log.warn('task notification badge update failed', { error: (err as Error)?.message || String(err) });
    }
  };
  const clearUnread = (): void => {
    if (unreadCount > 0) updateBadge(0);
  };

  // Clear any stale OS-owned badge left behind by an unclean prior exit.
  updateBadge(0);
  const stopFocusListener = runtime.onDidFocus(clearUnread);
  // 「到点未执行」：与群聊终态通知共用同一套开关、聚焦判断和系统通知通道。
  const unsubscribeSkips = opts.subscribeFires ? opts.subscribeFires((event) => {
    try {
      if (event.type !== 'fire_skipped') return;
      if (!runtime.isEnabled()) return;
      if (runtime.hasFocusedWindow() || !runtime.isSupported()) return;
      const copy = skipNotificationCopy({
        title: event.title,
        count: Array.isArray(event.items) ? event.items.length : 0,
      });
      const notification = runtime.createNotification(copy);
      notification.onClick(() => { /* 没有会话可打开：点开只是收起系统通知 */ });
      notification.show();
    } catch (err) {
      log.warn('skip notification failed', { error: (err as Error)?.message || String(err) });
    }
  }) : () => {};

  const unsubscribe = subscribe((event: TaskTerminalEvent) => {
    try {
      if (event.status === 'cancelled') return;
      if (runtime.getActiveUserId() !== event.user_id) return;
      if (!runtime.isEnabled()) return;
      if (runtime.hasFocusedWindow() || !runtime.isSupported()) return;

      updateBadge(unreadCount + 1);
      const notification = runtime.createNotification(copyFor(event.status));
      notification.onClick(() => {
        try {
          // A stale notification must never navigate into another account's
          // local conversation namespace after an account switch.
          if (runtime.getActiveUserId() !== event.user_id) return;
          clearUnread();
          runtime.openConversation(event.conversation_id, event.status);
        } catch (err) {
          log.warn('task notification click failed', { error: (err as Error)?.message || String(err) });
        }
      });
      notification.show();
    } catch (err) {
      // Notifications are a best-effort attention layer. They must never
      // affect persistence, task completion, or the worker scheduler.
      log.warn('native task notification failed', { error: (err as Error)?.message || String(err) });
    }
  });

  return () => {
    unsubscribe();
    unsubscribeSkips();
    stopFocusListener();
    clearUnread();
  };
}
