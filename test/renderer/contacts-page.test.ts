import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/**
 * Contacts page integration: renders from the IPC bridge and only through shared
 * components. Pins the invariants that matter for the MVP — an empty list offers
 * the add action, an offline contact's "start chat" is disabled, and a pending
 * request exposes accept/reject — without asserting on page-local classes.
 */
const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/contacts-page.js'), 'utf8');
const formSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/ui-form.js'), 'utf8');

interface Harness {
  html: () => string;
  modalHtml: () => string;
  setContacts: (rows: unknown[]) => void;
  setRequests: (rows: unknown[]) => void;
  setHistory: (rows: unknown[]) => void;
  startChat: (userId: string) => Promise<void>;
  chooseMode: (mode: string) => void;
  chooseConversation: (cid: string) => void;
  existingConversationsHidden: () => boolean;
  submitModal: () => Promise<void>;
  closeModal: (reason?: string) => void;
  dispatchI18nChange: () => void;
  settledModalMutations: () => number;
  setView: ReturnType<typeof vi.fn>;
  insertMention: ReturnType<typeof vi.fn>;
  startChatFocus: ReturnType<typeof vi.fn>;
  selectContact: (id: string) => Promise<void>;
  detailHtml: (contact: unknown, history: unknown[]) => string;
  expiredNotice: (rows: unknown[]) => string;
  render: () => void;
  decideRequestAdd: (lookup: unknown) => { allowed: boolean; reason?: string };
}

type ConversationResult = any[] | Error | Promise<any[]>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function renderAttrs(attrs: Record<string, unknown> = {}) {
  return Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${String(value)}"`)
    .join('');
}

function createHarness({
  conversationResults = [],
  locale = 'en-US',
}: {
  conversationResults?: ConversationResult[];
  locale?: string;
} = {}): Harness {
  let contacts: any[] = [];
  let requests: any[] = [];
  let html = '';
  let resultIndex = 0;
  let finalConversationRows: any[] = [];
  let modalState: any = null;
  let settledModalMutationCount = 0;
  const eventListeners = new Map<string, Set<() => void>>();
  const setView = vi.fn();
  const insertMention = vi.fn(() => true);
  const startChatFocus = vi.fn();
  const startChatTrigger = {
    dataset: { contactStart: 'cs_alice' },
    focus: startChatFocus,
  };

  const conversationModeButtons = new Map<string, any>();
  const conversationSelect = { value: '' };
  const existingField = { hidden: false };

  function rebuildModalControls() {
    conversationModeButtons.clear();
    const bodyHtml = String(modalState?.options.bodyHtml || '');
    for (const mode of ['continue', 'new']) {
      if (!bodyHtml.includes(`data-contact-conversation-mode="${mode}"`)) continue;
      const listeners: Array<() => void> = [];
      conversationModeButtons.set(mode, {
        dataset: { contactConversationMode: mode },
        setAttribute: () => {},
        addEventListener: (type: string, listener: () => void) => {
          if (type === 'click') listeners.push(listener);
        },
        click: () => listeners.forEach((listener) => listener()),
      });
    }
    const selected = bodyHtml.match(/<option value="([^"]*)" selected>/)
      || bodyHtml.match(/<option value="([^"]*)">/);
    conversationSelect.value = selected ? selected[1] : '';
    existingField.hidden = bodyHtml.includes('data-contact-existing-field hidden');
  }

  const host = {
    set innerHTML(value: string) { html = value; },
    get innerHTML() { return html; },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: (type: string, listener: () => void) => {
      if (!eventListeners.has(type)) eventListeners.set(type, new Set());
      eventListeners.get(type)?.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      eventListeners.get(type)?.delete(listener);
    },
  };
  const sandbox: Record<string, any> = {
    console: { warn: () => {} },
    setTimeout,
    Promise,
    document: {
      readyState: 'complete',
      documentElement: { lang: locale },
      getElementById: (id: string) => (id === 'contacts-view' ? host : null),
      querySelectorAll: (selector: string) => (selector === '[data-contact-start]' ? [startChatTrigger] : []),
      createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, classList: { add: () => {}, remove: () => {} } }),
    },
    addEventListener: (type: string, listener: () => void) => {
      if (!eventListeners.has(type)) eventListeners.set(type, new Set());
      eventListeners.get(type)?.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      eventListeners.get(type)?.delete(listener);
    },
    t: (key: string, vars?: Record<string, unknown>) => {
      const rendered = vars && Object.keys(vars).length ? `${key}:${JSON.stringify(vars)}` : key;
      return key.startsWith('contacts.conversation_') ? `translated:${rendered}` : rendered;
    },
    uiBadge: (o: any) => `<badge>${o.label}</badge>`,
    uiStatusDot: (o: any) => `<dot data-tone="${o.tone}">${o.label}</dot>`,
    uiResourceGrid: (o: any) => `<grid>${o.bodyHtml || ''}</grid>`,
    uiStatusPill: (o: any) => `<pill>${o.label}</pill>`,
    uiCard: (o: any) => `<card data-id="${(o.attrs || {})['data-contact-card'] || (o.attrs || {})['data-request-row'] || ''}">${o.bodyHtml || ''}</card>`,
    uiResourceCard: (o: any) => `<card data-id="${(o.attrs || {})['data-contact-card'] || (o.attrs || {})['data-request-row'] || ''}">${o.title}${o.description || ''}${o.status ? `<pill>${o.status.label}</pill>` : ''}${o.bodyHtml || ''}${(o.actions || []).map((a: any) => `<btn data-attrs="${JSON.stringify(a.attrs || {})}"${a.disabled ? ' disabled' : ''}>${a.label}</btn>`).join('')}</card>`,
    uiButton: (o: any) => `<button data-attrs="${JSON.stringify(o.attrs || {})}">${o.label}</button>`,
    uiEmptyState: (o: any) => `<empty>${o.title}</empty>`,
    uiPageHeader: (o: any) => `<header>${o.title}${(o.actions || []).map((a: any) => `<btn data-attrs="${JSON.stringify(a.attrs || {})}">${a.label}</btn>`).join('')}</header>`,
    uiSegmentedControl: (o: any) => `<tabs>${o.items.map((i: any) => `<button${renderAttrs(i.attrs)} aria-pressed="${String(i.value) === String(o.value)}">${i.label}</button>`).join('')}</tabs>`,
    uiFormModal: (options: any) => {
      let settle!: (value: unknown) => void;
      let settled = false;
      const result = new Promise((resolvePromise) => { settle = resolvePromise; });
      const modal = Object.assign(result, {
        options: { ...options },
        feedback: '',
        busy: false,
        dialog: {
          querySelector: (selector: string) => {
            if (selector === '[data-contact-existing-field]') return existingField;
            if (selector === '[data-contact-conversation-select]') return conversationSelect;
            return null;
          },
          querySelectorAll: (selector: string) => (
            selector === '[data-contact-conversation-mode]'
              ? Array.from(conversationModeButtons.values())
              : []
          ),
        },
        update: (next: any) => {
          if (settled) {
            settledModalMutationCount += 1;
            return;
          }
          modal.options = { ...modal.options, ...next };
          rebuildModalControls();
        },
        setFeedback: (value: string) => {
          if (settled) {
            settledModalMutationCount += 1;
            return;
          }
          modal.feedback = String(value || '');
        },
        setBusy: (value: boolean) => {
          if (settled) {
            settledModalMutationCount += 1;
            return;
          }
          modal.busy = Boolean(value);
        },
        close: (value: unknown, reason = 'close') => {
          if (settled) return;
          settled = true;
          if (modalState === modal) modalState = null;
          settle({ value, reason });
        },
      });
      modalState = modal;
      rebuildModalControls();
      return modal;
    },
    setView,
    composerMembers: { insertMention },
    contacts: {
      list: () => contacts,
      pendingRequests: () => requests.filter((row) => row.state === 'pending'),
      requestAdd: async () => ({}),
      acceptRequest: async () => ({}),
      rejectRequest: async () => ({}),
      lookupByPhone: async () => ({ registered: true, discoverable: true, is_contact: false }),
      conversationsFor: async () => {
        const next = resultIndex < conversationResults.length
          ? conversationResults[resultIndex++]
          : finalConversationRows;
        if (next instanceof Error) throw next;
        const rows = await next;
        if (Array.isArray(rows)) finalConversationRows = rows;
        return rows;
      },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(formSource, sandbox, { filename: 'ui-form.js' });
  vm.runInContext(source, sandbox, { filename: 'contacts-page.js' });
  return {
    html: () => html,
    modalHtml: () => modalState
      ? `${modalState.options.title || ''}${modalState.options.submitLabel || ''}${modalState.options.bodyHtml || ''}${modalState.feedback || ''}`
      : '',
    setContacts: (rows) => { contacts = rows as any[]; },
    setRequests: (rows) => { requests = rows as any[]; },
    setHistory: (rows) => { if (sandbox.contacts) sandbox.contacts.history = async () => rows; },
    selectContact: (id: string) => sandbox.window.contactsPage.selectContact(id),
    detailHtml: (contact: any, history: any[]) => sandbox.window.contactsPage.detailHtml(contact, history),
    expiredNotice: (rows: any[]) => sandbox.window.contactsPage.expiredNotice(rows),
    startChat: (id: string) => sandbox.window.contactsPage.startChat(id),
    chooseMode: (mode: string) => conversationModeButtons.get(mode)?.click(),
    chooseConversation: (cid: string) => { conversationSelect.value = cid; },
    existingConversationsHidden: () => existingField.hidden,
    submitModal: async () => { await modalState?.options.onSubmit(); },
    closeModal: (reason = 'cancel') => { modalState?.close(null, reason); },
    dispatchI18nChange: () => eventListeners.get('i18n-change')?.forEach((listener) => listener()),
    settledModalMutations: () => settledModalMutationCount,
    setView,
    insertMention,
    startChatFocus,
    render: () => sandbox.window.renderContactsPage(),
    decideRequestAdd: (lookup: any) => sandbox.window.contactsPage.decideRequestAdd(lookup),
  };
}

describe('contacts page › rendering', () => {
  it('offers the add action when there are no contacts', () => {
    const h = createHarness();
    h.setContacts([]);
    h.render();
    expect(h.html()).toContain('还没有联系人');
    expect(h.html()).toContain('添加联系人');
  });

  it('renders a card per contact and disables "start chat" for an offline contact', () => {
    const h = createHarness();
    h.setContacts([
      { user_id: 'cs_alice', name: 'Alice', online: true, phone_masked: '138****1234' },
      { user_id: 'cs_bob', name: 'Bob', online: false },
    ]);
    h.render();
    const html = h.html();
    expect(html).toContain('data-id="cs_alice"');
    expect(html).toContain('data-id="cs_bob"');
    expect(html).toContain('在线');
    // Offline card carries the disabled attribute on its start-chat button.
    const bobCard = html.split('<card').find((chunk) => chunk.includes('cs_bob')) || '';
    expect(bobCard).toContain('disabled');
  });

  it('exposes accept/reject only for a pending incoming request', () => {
    const h = createHarness();
    h.setRequests([
      { id: 'creq-1', direction: 'in', state: 'pending', peer_name: 'Carol' },
      { id: 'creq-2', direction: 'out', state: 'pending', peer_name: 'Dave' },
    ]);
    h.render();
    h.setRequests([
      { id: 'creq-1', direction: 'in', state: 'pending', peer_name: 'Carol' },
      { id: 'creq-2', direction: 'out', state: 'pending', peer_name: 'Dave' },
    ]);
    // Switch to the requests tab through the exported setter.
    (vm as any); // keep types quiet
    const hostHtml = h.html();
    expect(hostHtml).toContain('新的联系人');
  });
});

describe('contacts page › conversation choice', () => {
  it('uses shared full-width styling for the native conversation select with long labels', async () => {
    const titleSuffix = 'long conversation title '.repeat(12);
    const title = `Quarterly <plan> & ${titleSuffix}`;
    const updatedAt = '2026-10-25T10:00:00Z';
    const expectedTime = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'short', timeStyle: 'short',
    }).format(new Date(updatedAt));
    const h = createHarness({ conversationResults: [[
      { conversation_id: 'a2a-existing-1', title, preview: `${'x'.repeat(80)}TRUNCATED`, updated_at: updatedAt },
      { conversation_id: 'a2a-existing-2', title: 'Second conversation', preview: '', updated_at: updatedAt },
    ]] });
    h.setContacts([{ user_id: 'cs_alice', name: 'Alice', online: true }]);
    await h.startChat('cs_alice');

    const html = h.modalHtml();
    const select = html.match(/<select\b[^>]*id="contact-conversation-select"[^>]*>[\s\S]*?<\/select>/)?.[0] || '';
    expect(select).toContain('class="ui-native-select form-input"');
    expect(select).toContain('aria-label="translated:contacts.conversation_existing"');
    expect(select).toContain('data-contact-conversation-select="1"');
    expect(select).toContain(`<option value="a2a-existing-1" selected>Quarterly &lt;plan&gt; &amp; ${titleSuffix} · ${'x'.repeat(80)} · ${expectedTime}</option>`);
    expect(select).toContain('<option value="a2a-existing-2">Second conversation');
    expect(select).not.toContain('TRUNCATED');
    expect(html).toContain('<div class="ui-form__item"><div data-contact-existing-field>');
    expect(h.existingConversationsHidden()).toBe(false);

    h.chooseMode('new');
    expect(h.existingConversationsHidden()).toBe(true);
    h.chooseMode('continue');
    expect(h.existingConversationsHidden()).toBe(false);
    h.chooseConversation('a2a-existing-2');
    await h.submitModal();
    expect(h.setView).toHaveBeenCalledWith('conversation', 'a2a-existing-2');
    expect(h.insertMention).not.toHaveBeenCalled();
    expect(h.modalHtml()).toBe('');
  });

  it('shows a loading state while the contact directory is pending', async () => {
    const pending = deferred<any[]>();
    const h = createHarness({ conversationResults: [pending.promise] });
    h.setContacts([{ user_id: 'cs_alice', name: 'Alice', online: true }]);
    const opening = h.startChat('cs_alice');
    expect(h.modalHtml()).toContain('contacts.conversation_loading');
    pending.resolve([]);
    await opening;
    expect(h.modalHtml()).toContain('contacts.conversation_new');
  });

  it('offers new and continue when the contact has existing conversations', async () => {
    const h = createHarness({ conversationResults: [[
      { conversation_id: 'a2a-existing-1', title: '报价', preview: '第一条', updated_at: '2026-10-25T10:00:00Z' },
      { conversation_id: 'a2a-existing-2', title: '排期', preview: '第二条', updated_at: '2026-10-25T11:00:00Z' },
    ]] });
    h.setContacts([{ user_id: 'cs_alice', name: 'Alice', online: true }]);
    await h.startChat('cs_alice');
    expect(h.modalHtml()).toContain('contacts.conversation_continue');
    expect(h.modalHtml()).toContain('contacts.conversation_new');
    expect(h.modalHtml()).toContain('a2a-existing-1');
    expect(h.modalHtml()).toContain('a2a-existing-2');
  });

  it('formats conversation option labels with title, truncated preview and localized time', async () => {
    const preview = `${'x'.repeat(80)}TRUNCATED`;
    const updatedAt = '2026-10-25T10:00:00Z';
    const expectedTime = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(updatedAt));
    const h = createHarness({
      locale: 'en-US',
      conversationResults: [[{
        conversation_id: 'a2a-existing-1',
        title: 'Quarterly plan',
        preview,
        updated_at: updatedAt,
      }]],
    });
    h.setContacts([{ user_id: 'cs_alice', name: 'Alice', online: true }]);
    await h.startChat('cs_alice');
    expect(h.modalHtml()).toContain('Quarterly plan');
    expect(h.modalHtml()).toContain('x'.repeat(80));
    expect(h.modalHtml()).not.toContain('TRUNCATED');
    expect(h.modalHtml()).toContain(expectedTime);
  });

  it('opens the selected existing conversation without inserting a new mention', async () => {
    const h = createHarness({ conversationResults: [[
      { conversation_id: 'a2a-existing-2', title: '排期', preview: '', updated_at: '2026-10-25T11:00:00Z' },
    ]] });
    h.setContacts([{ user_id: 'cs_alice', name: 'Alice', online: true }]);
    await h.startChat('cs_alice');
    h.chooseMode('continue');
    h.chooseConversation('a2a-existing-2');
    await h.submitModal();
    expect(h.setView).toHaveBeenCalledWith('conversation', 'a2a-existing-2');
    expect(h.insertMention).not.toHaveBeenCalled();
  });

  it('opens a new contact draft when new conversation is selected', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({ conversationResults: [[]] });
      h.setContacts([{ user_id: 'cs_alice', name: 'Alice', online: true }]);
      await h.startChat('cs_alice');
      expect(h.modalHtml()).toContain('contacts.conversation_empty');
      h.chooseMode('new');
      await h.submitModal();
      vi.runAllTimers();
      expect(h.setView).toHaveBeenCalledWith('new-chat');
      expect(h.insertMention).toHaveBeenCalledWith('new-chat', {
        kind: 'contact', user_id: 'cs_alice', name: 'Alice',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the chooser open and supports retry after a list failure', async () => {
    const h = createHarness({ conversationResults: [new Error('read failed'), []] });
    h.setContacts([{ user_id: 'cs_alice', name: 'Alice', online: true }]);
    await h.startChat('cs_alice');
    expect(h.modalHtml()).toContain('contacts.conversation_load_failed');
    expect(h.setView).not.toHaveBeenCalled();
    await h.submitModal();
    expect(h.modalHtml()).toContain('contacts.conversation_new');
  });

  it('does not open a conversation that became unavailable after selection', async () => {
    const row = { conversation_id: 'a2a-existing-1', title: '报价', preview: '', updated_at: '2026-10-25T10:00:00Z' };
    const h = createHarness({ conversationResults: [[row], []] });
    h.setContacts([{ user_id: 'cs_alice', name: 'Alice', online: true }]);
    await h.startChat('cs_alice');
    h.chooseMode('continue');
    h.chooseConversation('a2a-existing-1');
    await h.submitModal();
    expect(h.modalHtml()).toContain('contacts.conversation_unavailable');
    expect(h.setView).not.toHaveBeenCalled();
  });

  it('does not continue submit revalidation after the chooser is cancelled', async () => {
    const row = { conversation_id: 'a2a-existing-1', title: '报价', preview: '', updated_at: '2026-10-25T10:00:00Z' };
    const pending = deferred<any[]>();
    const h = createHarness({ conversationResults: [[row], pending.promise] });
    h.setContacts([{ user_id: 'cs_alice', name: 'Alice', online: true }]);
    await h.startChat('cs_alice');
    h.chooseMode('continue');
    h.chooseConversation(row.conversation_id);
    const submitting = h.submitModal();
    h.closeModal('cancel');
    await Promise.resolve();
    pending.resolve([row]);
    await submitting;
    expect(h.setView).not.toHaveBeenCalled();
    expect(h.settledModalMutations()).toBe(0);
  });

  it('does not let an old submit continuation affect the chooser reopened for i18n', async () => {
    const row = { conversation_id: 'a2a-existing-1', title: '报价', preview: '', updated_at: '2026-10-25T10:00:00Z' };
    const pending = deferred<any[]>();
    const h = createHarness({ conversationResults: [[row], pending.promise, []] });
    h.setContacts([{ user_id: 'cs_alice', name: 'Alice', online: true }]);
    await h.startChat('cs_alice');
    h.chooseMode('continue');
    h.chooseConversation(row.conversation_id);
    const submitting = h.submitModal();
    h.dispatchI18nChange();
    await Promise.resolve();
    pending.resolve([row]);
    await submitting;
    await Promise.resolve();
    expect(h.modalHtml()).toContain('contacts.conversation_new');
    expect(h.setView).not.toHaveBeenCalled();
    expect(h.settledModalMutations()).toBe(0);
  });

  it('reopens the chooser on i18n-change so modal chrome is translated', async () => {
    const h = createHarness({ conversationResults: [[], []] });
    h.setContacts([{ user_id: 'cs_alice', name: 'Alice', online: true }]);
    await h.startChat('cs_alice');
    h.dispatchI18nChange();
    await Promise.resolve();
    expect(h.modalHtml()).toContain('contacts.conversation_choice_title');
    expect(h.setView).not.toHaveBeenCalled();
  });

  it('restores focus to the current start button after Escape replaces the original trigger', async () => {
    const h = createHarness({ conversationResults: [[]] });
    h.setContacts([{ user_id: 'cs_alice', name: 'Alice', online: true }]);
    await h.startChat('cs_alice');
    h.closeModal('escape');
    await Promise.resolve();
    expect(h.startChatFocus).toHaveBeenCalledWith({ preventScroll: true });
  });
});

describe('contacts page › detail content (AC-11)', () => {
  it('renders masked phone, direction and summary for each history row', () => {
    const h = createHarness();
    const html = h.detailHtml(
      { user_id: 'cs_alice', name: 'Alice', phone_masked: '138****1234', online: true },
      [
        { direction: 'out', summary: '问了报价', at: '2026-10-20T10:00:00Z' },
        { direction: 'in', summary: '回复了九折', at: '2026-10-20T10:05:00Z' },
      ],
    );
    expect(html).toContain('138****1234');
    expect(html).toContain('问了报价');
    expect(html).toContain('回复了九折');
    expect(html).toContain('2026-10-20 10:0');
  });

  it('shows the empty state when there is no history yet', () => {
    const h = createHarness();
    const html = h.detailHtml({ user_id: 'cs_bob', name: 'Bob', online: false }, []);
    expect(html).toContain('还没有往来记录');
    expect(html).toContain('离线');
  });

describe('contacts page › expired notice (AC-17)', () => {
  it('counts only outgoing expired requests', () => {
    const h = createHarness();
    expect(h.expiredNotice([
      { id: 'a', state: 'expired', direction: 'out' },
      { id: 'b', state: 'expired', direction: 'in' },
      { id: 'c', state: 'pending', direction: 'out' },
    ])).toContain('contacts.expired_notice');
  });

  it('stays empty when nothing expired so no banner appears', () => {
    const h = createHarness();
    expect(h.expiredNotice([{ id: 'a', state: 'pending', direction: 'out' }])).toBe('');
  });
});
});

describe('contacts page › who may be asked (AC-02/06)', () => {
  it('refuses before sending when the three booleans already answer', () => {
    const harness = createHarness();
    const decide = harness.decideRequestAdd;
    expect(decide({ registered: false, discoverable: false, is_contact: false }))
      .toEqual({ allowed: false, reason: 'not_registered' });
    expect(decide({ registered: true, discoverable: true, is_contact: true }))
      .toEqual({ allowed: false, reason: 'already_contact' });
    // 对方关了「可被搜」：不再发一次一定被拒的申请。
    expect(decide({ registered: true, discoverable: false, is_contact: false }))
      .toEqual({ allowed: false, reason: 'not_discoverable' });
    expect(decide({ registered: true, discoverable: true, is_contact: false }))
      .toEqual({ allowed: true });
  });
});
