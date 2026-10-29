import { describe, expect, it, vi } from 'vitest';
import {
  copyForContactRequest,
  startContactNotifications,
  type ContactNotificationRuntime,
} from '../../../../src/main/features/contacts/notifications';
import type { ContactRequestRecord } from '../../../../src/main/features/contacts/store';

/**
 * A contact notification is only useful when the user cannot see the app (FR-21),
 * so the cases pin the two silent paths — focused window and disabled preference —
 * as hard as the delivered one.
 */
function runtime(overrides: Partial<ContactNotificationRuntime> = {}) {
  const shown: Array<{ title: string; body: string }> = [];
  const clicks: Array<() => void> = [];
  const base: ContactNotificationRuntime = {
    getActiveUserId: () => 'user-1',
    isEnabled: () => true,
    hasFocusedWindow: () => false,
    isSupported: () => true,
    createNotification: (options) => {
      shown.push(options);
      return {
        onClick: (listener) => { clicks.push(listener); },
        show: () => {},
      };
    },
    openContacts: () => { clicks.push(() => {}); },
    ...overrides,
  };
  return { base, shown, clicks };
}

const incoming: ContactRequestRecord = {
  id: 'creq-1',
  direction: 'in',
  peerName: 'Alice',
  phoneMasked: '138****1234',
  note: '一起做 A2A',
  state: 'pending',
  createdAt: '2026-10-21T10:00:00Z',
};

describe('contact notifications › copy', () => {
  it('names the requester and carries the note', () => {
    expect(copyForContactRequest(incoming)).toEqual({
      title: 'Alice 想加你为联系人',
      body: '一起做 A2A',
    });
  });

  it('falls back to the masked phone or a generic title', () => {
    const { peerName: _drop, ...rest } = incoming;
    expect(copyForContactRequest(rest as ContactRequestRecord).title).toBe('138****1234 想加你为联系人');
    const noPhone = { ...incoming, peerName: undefined, phoneMasked: undefined, note: undefined };
    expect(copyForContactRequest(noPhone as ContactRequestRecord)).toEqual({
      title: '新的联系人申请',
      body: '打开通讯录查看并处理',
    });
  });
});

describe('contact notifications › delivery rules', () => {
  function emit(listener: any, record: any = incoming, userId = 'user-1') {
    listener(userId, record);
  }

  it('shows a notification for an incoming request while unfocused', () => {
    const { base, shown } = runtime();
    const subscribe = vi.fn((listener: any) => { emit(listener); return () => {}; });
    startContactNotifications({ runtime: base, subscribe });
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toContain('Alice');
  });

  it('stays quiet while the window is focused', () => {
    const { base, shown } = runtime({ hasFocusedWindow: () => true });
    startContactNotifications({ runtime: base, subscribe: (listener) => { emit(listener); return () => {}; } });
    expect(shown).toHaveLength(0);
  });

  it('stays quiet when notifications are disabled, unsupported, or another account', () => {
    const disabled = runtime({ isEnabled: () => false });
    startContactNotifications({ runtime: disabled.base, subscribe: (l) => { emit(l); return () => {}; } });
    expect(disabled.shown).toHaveLength(0);

    const unsupported = runtime({ isSupported: () => false });
    startContactNotifications({ runtime: unsupported.base, subscribe: (l) => { emit(l); return () => {}; } });
    expect(unsupported.shown).toHaveLength(0);

    const otherUser = runtime();
    startContactNotifications({ runtime: otherUser.base, subscribe: (l) => { emit(l, incoming, 'user-2'); return () => {}; } });
    expect(otherUser.shown).toHaveLength(0);
  });

  it('ignores an outgoing request and opens the contacts page on click', () => {
    const { base, shown, clicks } = runtime();
    startContactNotifications({ runtime: base, subscribe: (l) => { emit(l, { ...incoming, direction: 'out' }); return () => {}; } });
    expect(shown).toHaveLength(0);

    const second = runtime();
    startContactNotifications({ runtime: second.base, subscribe: (l) => { emit(l); return () => {}; } });
    expect(second.clicks.length).toBeGreaterThan(0);
  });
});
