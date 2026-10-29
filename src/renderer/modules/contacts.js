/**
 * A2A contacts — renderer bridge.
 *
 * Two jobs, both deliberately small:
 *
 * 1. Publish the contact list to the composer's `@` picker through the seam the
 *    picker already reads (`window.getComposerContactCandidates`), so a contact
 *    appears as a picker row exactly like an agent does.
 * 2. Be the single place the contacts page reads from, so the page stays a view
 *    over IPC rather than a second copy of the data.
 *
 * The relationship authority is the Hub (decision D-1); the MVP talks to the local
 * store through the same `contacts.*` channels the Hub client will implement, so
 * nothing here changes when the backend does.
 */
(function () {
  'use strict';

  const log = (typeof console !== 'undefined' && console) || { warn() {} };

  /** Contacts as last loaded from the main process. */
  let contacts = [];
  /** Pending requests (incoming), for the "新的联系人" badge. */
  let requests = [];
  let loadingPromise = null;
  /** 上一次看到的待处理数量：变大时才提示（AC-01）。 */
  let lastPendingCount = 0;

  function contactsNavLabel() {
    const key = 'sidebar.contacts';
    const translated = typeof window.t === 'function' ? window.t(key) : key;
    return translated && translated !== key ? String(translated) : '通讯录';
  }

  function renderContactsNavButton() {
    if (typeof document === 'undefined' || typeof window.uiButton !== 'function') return null;
    const host = document.getElementById('contacts-nav-host');
    if (!host) return null;
    if (!document.getElementById('contacts-btn')) {
      host.innerHTML = window.uiButton({
        label: contactsNavLabel(),
        icon: 'users',
        role: 'ghost',
        className: 'sidebar-btn',
        attrs: { id: 'contacts-btn' },
      });
    }
    const button = document.getElementById('contacts-btn');
    const label = button && button.querySelector('.ui-button__label');
    if (label) label.setAttribute('data-i18n', 'sidebar.contacts');
    return button;
  }

  function refreshContactsNavLabel() {
    const button = renderContactsNavButton();
    const label = button && button.querySelector('.ui-button__label');
    if (label) label.textContent = contactsNavLabel();
  }

  function invoke(channel, payload) {
    const bridge = typeof window !== 'undefined' ? window.cogseed : null;
    if (!bridge || typeof bridge.invoke !== 'function') return Promise.reject(new Error('no ipc bridge'));
    return bridge.invoke(channel, payload || {});
  }

  function normalizeContact(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const userId = String(raw.userId || '').trim();
    if (!userId) return null;
    return {
      user_id: userId,
      name: String(raw.name || userId),
      online: raw.online !== false,
      assistant_name: raw.assistantName ? String(raw.assistantName) : '',
      phone_masked: raw.phoneMasked ? String(raw.phoneMasked) : '',
      default_agent_id: raw.defaultAgentId ? String(raw.defaultAgentId) : '',
      default_workspace: raw.defaultWorkspace ? String(raw.defaultWorkspace) : '',
    };
  }

  /**
   * The composer seam. Returns [] until the first load lands — an empty list means
   * the picker shows no「联系人」group at all, which is the pre-A2A behaviour.
   */
  function getComposerContactCandidates() {
    return contacts
      .filter((row) => row && row.user_id)
      .map((row) => ({
        user_id: row.user_id,
        name: row.name,
        online: row.online !== false,
        assistant_name: row.assistant_name,
      }));
  }

  /** IPC 结果按 preload 约定是 `{ ok, ...fields }`，数组都放在字段里。 */
  function field(result, name) {
    if (!result || typeof result !== 'object') return null;
    const value = result[name];
    return value === undefined ? null : value;
  }

  async function load() {
    const [listResult, requestsResult] = await Promise.all([
      invoke('contacts.list'),
      invoke('contacts.requests').catch(() => null),
    ]);
    const list = field(listResult, 'contacts');
    const previousNames = new Map(contacts.map(row => [row.user_id, row.name]));
    contacts = (Array.isArray(list) ? list : []).map(normalizeContact).filter(Boolean);
    const pending = field(requestsResult, 'requests');
    requests = Array.isArray(pending) ? pending : [];
    updateNavBadge(pendingRequests().length);
    const namesChanged = contacts.some(row => previousNames.has(row.user_id)
      && previousNames.get(row.user_id) !== row.name);
    notifyChanged(namesChanged);
    return contacts;
  }

  /** Coalesce concurrent refreshes onto one IPC round trip. */
  function refresh() {
    if (!loadingPromise) {
      loadingPromise = load().finally(() => { loadingPromise = null; });
    }
    return loadingPromise;
  }

  /** 侧栏「通讯录」角标：有未处理申请时显示数量（AC-01 / FR-01）。 */
  function updateNavBadge(count) {
    const badgeHost = typeof document !== 'undefined' ? document.getElementById('contacts-btn') : null;
    if (badgeHost) {
      const existing = badgeHost.querySelector('[data-contacts-badge]');
      if (!count) {
        if (existing) existing.remove();
      } else {
        const html = typeof window.uiBadge === 'function'
          ? window.uiBadge({ label: String(count), tone: 'info' })
          : `<span>${count}</span>`;
        if (existing) existing.innerHTML = html;
        else {
          const holder = document.createElement('span');
          holder.className = 'sidebar-btn-badge';
          holder.setAttribute('data-contacts-badge', '1');
          holder.innerHTML = html;
          badgeHost.appendChild(holder);
        }
      }
    }
    if (count > lastPendingCount) {
      try {
        if (typeof window.uiToast === 'function') {
          window.uiToast(
            (typeof window.t === 'function' && window.t('contacts.new_request')) || '收到新的联系人申请',
            { variant: 'info' },
          );
        }
      } catch (_) { /* 提示失败不影响数据 */ }
    }
    lastPendingCount = count;
  }

  function notifyChanged(namesChanged = false) {
    try {
      window.dispatchEvent(new CustomEvent('contacts-changed', {
        detail: { contacts: contacts.length, pending: pendingRequests().length, namesChanged },
      }));
    } catch (_) { /* 无 DOM 环境（单测）忽略 */ }
  }

  function list() {
    return contacts.slice();
  }

  /** 全部已加载的申请（含已过期/已拒绝），页面据此给出过期提示。 */
  function allRequests() {
    return requests.slice();
  }

  function pendingRequests() {
    return requests.filter((row) => row && row.state === 'pending');
  }

  async function lookupByPhone(phone) {
    const response = await invoke('contacts.lookupByPhone', { phone: String(phone || '') });
    // Hub 的业务拒绝（配额/版本闸门）必须向上抛，不能伪装成“未注册”。
    if (!response || response.ok === false) {
      const error = new Error((response && response.error) || 'lookup failed');
      error.code = response && response.code;
      throw error;
    }
    const result = field(response, 'lookup');
    return result && typeof result === 'object'
      ? {
        registered: !!result.registered,
        discoverable: !!result.discoverable,
        is_contact: !!result.is_contact,
      }
      : { registered: false, discoverable: false, is_contact: false };
  }

  async function requestAdd(phone, note) {
    const created = field(await invoke('contacts.requestAdd', {
      phone: String(phone || ''),
      ...(note ? { note: String(note) } : {}),
    }), 'request');
    await refresh();
    return created;
  }

  async function acceptRequest(id) {
    const result = field(await invoke('contacts.acceptRequest', { id: String(id || '') }), 'request');
    await refresh();
    return result;
  }

  async function rejectRequest(id) {
    const result = field(await invoke('contacts.rejectRequest', { id: String(id || '') }), 'request');
    await refresh();
    return result;
  }

  async function remove(userId) {
    const removed = field(await invoke('contacts.remove', { userId: String(userId || '') }), 'removed');
    await refresh();
    return removed;
  }

  async function setDefaultScope(userId, scope) {
    const updated = field(await invoke('contacts.setDefaultScope', {
      userId: String(userId || ''),
      // 空串是把默认值清回「按接待时选择」的有效输入，不能过滤掉。
      ...(scope && scope.agentId !== undefined ? { agentId: String(scope.agentId) } : {}),
      ...(scope && scope.workspace !== undefined ? { workspace: String(scope.workspace) } : {}),
    }), 'contact');
    await refresh();
    return updated;
  }

  async function history(userId) {
    const rows = field(await invoke('contacts.history', userId ? { userId: String(userId) } : {}), 'history');
    return Array.isArray(rows) ? rows : [];
  }

  async function conversationsFor(userId) {
    const result = await invoke('a2a.conversations.listForContact', { contactUserId: String(userId || '') });
    if (result && typeof result === 'object' && result.ok === false) {
      throw new Error(String(result.error || 'conversation directory unavailable'));
    }
    const rows = field(result, 'conversations');
    return (Array.isArray(rows) ? rows : []).filter((row) => (
      row && typeof row === 'object' && !Array.isArray(row)
    )).map((row) => ({
      conversation_id: String(row.conversationId || ''),
      title: String(row.title || ''),
      updated_at: String(row.updatedAt || ''),
      state: String(row.state || ''),
      preview: String(row.preview || ''),
    })).filter((row) => row.conversation_id);
  }

  const api = {
    refresh,
    list,
    pendingRequests,
    requests: allRequests,
    lookupByPhone,
    requestAdd,
    acceptRequest,
    rejectRequest,
    remove,
    setDefaultScope,
    history,
    conversationsFor,
    updateNavBadge,
  };

  /** 每隔一分钟重读一次联系人（在线状态会自然变化）。 */
  const AUTO_REFRESH_MS = 60_000;
  let autoRefreshTimer = null;
  function startAutoRefresh() {
    if (autoRefreshTimer) return;
    if (typeof window.setInterval !== 'function') return;
    autoRefreshTimer = window.setInterval(() => {
      refresh().catch(() => { /* 后台刷新失败保留旧数据 */ });
    }, AUTO_REFRESH_MS);
  }

  window.contacts = api;
  window.getComposerContactCandidates = getComposerContactCandidates;
  renderContactsNavButton();

  // 系统通知点击后跳转通讯录（FR-21）：主进程推送 —> 切视图。
  try {
    if (window.cogseed && typeof window.cogseed.onPushEvent === 'function') {
      window.cogseed.onPushEvent('contacts:open', () => {
        try {
          if (typeof window.setView === 'function') window.setView('contacts');
        } catch (_) { /* 视图切换失败不影响数据 */ }
      });
    }
  } catch (_) { /* 预加载未提供推送能力时忽略 */ }

  // 首次进页面时预热一次；失败不阻断（例如无 IPC 的静态预览）。
  refresh().catch((error) => log.warn('contacts preload failed', error));

  // 在线状态由服务端按心跳窗口判定，会自己变；缓存必须定期刷新，否则 @ 面板里的
  // 「离线」会一直停在启动那一刻——而离线联系人在 PRD 里不可选，等于发不出去。
  startAutoRefresh();

  // 进入通讯录时补一次刷新：60s 轮询之外，切视图（包括重复点「通讯录」）也应该
  // 立刻看到对方刚通过的好友申请——否则页面停在旧状态，用户以为没通过。
  try {
    window.addEventListener('cogseed:view-changed', (event) => {
      const detail = (event && event.detail) || {};
      if (detail.view !== 'contacts') return;
      refresh().catch(() => { /* 失败保留旧数据 */ });
    });
    window.addEventListener('i18n-change', refreshContactsNavLabel);
  } catch (_) { /* 无 DOM 环境忽略 */ }
})();
