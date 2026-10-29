/**
 * Native notification for an arriving contact request (FR-11/FR-21).
 *
 * Mirrors the task-notification shape on purpose: a request that arrives while the
 * window is not focused is the only case a native notification helps, and a request
 * that arrives while the user is looking at the app would be noise on top of the
 * in-app badge (AC-01).
 */

import { onContactRequestArrived, type ContactRequestRecord } from './store';

export interface ContactNotificationRuntime {
  getActiveUserId(): string;
  isEnabled(): boolean;
  hasFocusedWindow(): boolean;
  isSupported(): boolean;
  createNotification(options: { title: string; body: string }): { onClick(listener: () => void): void; show(): void };
  /** Bring the contacts page forward. */
  openContacts(): void;
}

export type ContactNotificationCopy = { title: string; body: string };

/** Copy for one request; the peer's name wins over the masked phone when present. */
export function copyForContactRequest(request: ContactRequestRecord): ContactNotificationCopy {
  const who = String(request.peerName || request.phoneMasked || '').trim();
  const title = who ? `${who} 想加你为联系人` : '新的联系人申请';
  const body = request.note ? String(request.note).slice(0, 120) : '打开通讯录查看并处理';
  return { title, body };
}

export interface StartContactNotificationsOptions {
  runtime: ContactNotificationRuntime;
  /** Defaults to the store's arrival event; injectable for tests. */
  subscribe?: (listener: (userId: string, request: ContactRequestRecord) => void) => () => void;
}

export function startContactNotifications(options: StartContactNotificationsOptions): () => void {
  const { runtime } = options;
  const subscribe = options.subscribe || onContactRequestArrived;

  return subscribe((userId, request) => {
    try {
      if (!request || request.direction !== 'in') return;
      if (runtime.getActiveUserId() !== userId) return;
      if (!runtime.isEnabled()) return;
      // 窗口在前台：应用内已有角标，系统通知只会打扰。
      if (runtime.hasFocusedWindow()) return;
      if (!runtime.isSupported()) return;

      const notification = runtime.createNotification(copyForContactRequest(request));
      notification.onClick(() => {
        try {
          runtime.openContacts();
        } catch { /* 跳转失败不影响通知本身 */ }
      });
      notification.show();
    } catch { /* 通知是附加注意力层，失败不得影响请求入库 */ }
  });
}
