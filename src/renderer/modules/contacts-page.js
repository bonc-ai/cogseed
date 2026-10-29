/**
 * A2A contacts page.
 *
 * A view over `window.contacts` (the IPC bridge) built only from shared
 * components: `uiPageHeader`, `uiSegmentedControl`, `uiCard`, `uiEmptyState`,
 * `uiButton`, `uiBadge`, `uiStatusDot`, `uiForm`, `uiSelect`, `uiFormModal`.
 * No page-local modal or raw control — the add-contact flow reuses `uiPrompt`,
 * and destructive removal reuses `uiConfirmDanger`, per the renderer policy.
 *
 * The page owns no data: it renders what the bridge last loaded and re-renders on
 * `contacts-changed`, so the `@` picker and this page can never disagree.
 */
(function () {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;

  function tr(key, fallback, vars) {
    try {
      if (typeof root.t === 'function') {
        const value = root.t(key, vars);
        if (value && value !== key) return String(value);
      }
    } catch (_) { /* i18n 未加载 */ }
    return String(fallback).replace(/\{(\w+)\}/g, (_, name) => (vars && vars[name] != null ? String(vars[name]) : `{${name}}`));
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let activeTab = 'contacts';
  /** 详情是独立一页（原型 viewDetail + 返回），不是并排面板。 */
  let detailOpen = false;
  let selectedUserId = '';
  let selectedHistory = [];
  /** 搜索与在线筛选（原型 toolbar：search + 全部/在线 带数量）。 */
  let keyword = '';
  let onlineOnly = false;

  /** 默认接待范围的可选项：Agent 与工作空间（异步加载，缓存一次）。 */
  const scopeOptions = { agents: [], spaces: [], loaded: false, loading: null };

  async function loadScopeOptions() {
    if (scopeOptions.loaded) return scopeOptions;
    if (scopeOptions.loading) return scopeOptions.loading;
    const bridge = root.cogseed;
    if (!bridge || typeof bridge.invoke !== 'function') return scopeOptions;
    scopeOptions.loading = (async () => {
      try {
        const [agentsRes, spacesRes] = await Promise.all([
          bridge.invoke('agents.list', { summary: true }).catch(() => null),
          bridge.invoke('spaces.list', {}).catch(() => null),
        ]);
        const agents = (agentsRes && agentsRes.agents) || [];
        const spaces = (spacesRes && spacesRes.spaces) || [];
        scopeOptions.agents = agents
          .map((row) => ({ value: String(row.agent_id || ''), label: String(row.name || row.agent_id || '') }))
          .filter((row) => row.value);
        scopeOptions.spaces = spaces
          .map((row) => ({ value: String(row.space_id || row.id || ''), label: String(row.name || row.space_id || '') }))
          .filter((row) => row.value);
        scopeOptions.loaded = true;
      } catch (_) {
        scopeOptions.loaded = true;
      }
      return scopeOptions;
    })();
    return scopeOptions.loading;
  }

  function contactsApi() {
    return root.contacts && typeof root.contacts.list === 'function' ? root.contacts : null;
  }

  function visibleContacts(list) {
    const q = String(keyword || '').trim().toLowerCase();
    return (Array.isArray(list) ? list : [])
      .filter((row) => (onlineOnly ? row.online !== false : true))
      .filter((row) => (!q ? true : `${row.name || ''} ${row.phone_masked || ''}`.toLowerCase().includes(q)));
  }

  /** 联系人卡（原型 viewContacts：uiResourceCard + icon + status + 发起对话）。 */
  function contactCard(contact) {
    const online = contact.online !== false;
    if (typeof root.uiResourceCard !== 'function') {
      return `<div data-contact-card="${esc(contact.user_id)}">${esc(contact.name || contact.user_id)}</div>`;
    }
    return root.uiResourceCard({
      title: String(contact.name || contact.user_id),
      icon: 'user',
      status: online ? { label: tr('contacts.online', '在线'), tone: 'success' } : { label: tr('contacts.offline', '离线'), tone: 'neutral' },
      actions: [{
        label: tr('contacts.start_chat', '发起对话'),
        role: 'primary',
        icon: 'at-sign',
        disabled: !online,
        attrs: { 'data-contact-start': contact.user_id },
      }],
      attrs: { 'data-contact-card': contact.user_id },
    });
  }

  /** 往来记录表（原型：uiDataTable，列＝时间/方向/内容）。 */
  function historyTable(history) {
    const rows = (Array.isArray(history) ? history : []).map((row) => ({
      time: String(row.at || '').slice(0, 16).replace('T', ' '),
      direction: row.direction === 'out' ? tr('contacts.history_out', '发起') : tr('contacts.history_in', '来访'),
      summary: String(row.summary || ''),
    }));
    if (!rows.length) {
      return typeof root.uiEmptyState === 'function'
        ? root.uiEmptyState({ title: tr('contacts.history_empty', '还没有往来记录') })
        : '';
    }
    if (typeof root.uiDataTable === 'function') {
      return root.uiDataTable({
        label: tr('contacts.history', '往来记录'),
        columns: [
          { key: 'time', label: tr('contacts.history_time', '时间') },
          { key: 'direction', label: tr('contacts.history_direction', '方向') },
          { key: 'summary', label: tr('contacts.history_content', '内容') },
        ],
        rows,
      });
    }
    return `<ul class="contacts-history">${rows.map((row) => `<li>${esc(row.time)} · ${esc(row.direction)} · ${esc(row.summary)}</li>`).join('')}</ul>`;
  }

  /** 详情内容（纯函数，测试入口）：手机号 + 往来记录表。 */
  function detailHtml(contact, history) {
    const meta = [
      contact && contact.phone_masked ? String(contact.phone_masked) : '',
      contact && contact.online === false ? tr('contacts.offline', '离线') : tr('contacts.online', '在线'),
    ].filter(Boolean).join(' · ');
    return `<div class="contacts-detail">
        <p class="contacts-detail-meta">${esc(meta)}</p>
        ${historyTable(history)}
      </div>`;
  }

  /** 过期提示文案（AC-17）：只算「我发出的」过期请求。 */
  function expiredNotice(rows) {
    const expired = (Array.isArray(rows) ? rows : [])
      .filter((row) => row && row.state === 'expired' && row.direction === 'out');
    if (!expired.length) return '';
    return tr('contacts.expired_notice', '有 {count} 条请求对方未响应，可以重新发起', { count: expired.length });
  }

  /** 过期文案按方向区分（AC-17）。 */
  function requestStateText(request) {
    if (request.state === 'expired') {
      return request.direction === 'out'
        ? tr('contacts.state.expired_out', '对方未响应')
        : tr('contacts.state.expired_in', '请求已过期');
    }
    return tr(`contacts.state.${request.state}`, request.state);
  }

  function section(title, bodyHtml) {
    return `<section class="ui-settings-section"><div class="ui-settings-section__header"><h3 class="ui-settings-section__title">${esc(title)}</h3></div><div class="ui-settings-section__body">${bodyHtml}</div></section>`;
  }

  function emptyState(titleKey, fallback) {
    if (typeof root.uiEmptyState !== 'function') return `<div class="contacts-empty">${esc(tr(titleKey, fallback))}</div>`;
    return root.uiEmptyState({ title: tr(titleKey, fallback) });
  }

  function grid(cards) {
    if (typeof root.uiResourceGrid === 'function') return root.uiResourceGrid({ bodyHtml: cards });
    return `<div class="contacts-grid">${cards}</div>`;
  }

  /** 联系人 tab（原型 viewContacts）。 */
  function renderContactsTab(api) {
    const all = api ? api.list() : [];
    const list = visibleContacts(all);
    const onlineCount = all.filter((row) => row.online !== false).length;
    const seg = typeof root.uiSegmentedControl === 'function'
      ? root.uiSegmentedControl({
        ariaLabel: tr('contacts.filter', '筛选联系人'),
        value: onlineOnly ? 'online' : 'all',
        items: [
          { value: 'all', label: tr('contacts.filter_all', '全部'), count: all.length, attrs: { 'data-value': 'all' } },
          { value: 'online', label: tr('contacts.filter_online', '在线'), count: onlineCount, attrs: { 'data-value': 'online' } },
        ],
      })
      : '';
    const search = typeof root.uiInput === 'function'
      ? root.uiInput({
        id: 'contact-search',
        type: 'search',
        value: keyword,
        placeholder: tr('contacts.search_placeholder', '搜索联系人'),
        attrs: { 'data-contacts-search': '1' },
      })
      : '';
    const cards = list.map(contactCard).join('');
    const searching = String(keyword || '').trim().length > 0;
    const body = cards
      ? grid(cards)
      : (searching
        ? emptyState('contacts.no_match', '没有匹配的联系人')
        : emptyState(
          all.length ? 'contacts.empty_online' : 'contacts.empty',
          all.length ? '没有在线的联系人' : '还没有联系人。添加同事的手机号后，就可以在任务里 @ 对方。',
        ));
    return `<div class="contacts-toolbar">${search}${seg}</div><div class="contacts-list-body">${body}</div>`;
  }

  /** 新的联系人 tab（原型 viewRequests：收到的申请 / 我发出的申请）。 */
  function renderRequestsTab(api) {
    const rows = api && typeof api.requests === 'function' ? api.requests() : [];
    const incoming = rows.filter((row) => row.direction === 'in' && row.state === 'pending');
    const outgoing = rows.filter((row) => row.direction === 'out');
    const incomingCards = incoming.map((request) => {
      if (typeof root.uiResourceCard !== 'function') return '';
      return root.uiResourceCard({
        title: String(request.peerName || request.peer_name || request.phone_masked || tr('contacts.unknown_peer', '未知联系人')),
        description: request.note ? String(request.note) : '',
        icon: 'user',
        bodyHtml: `<div class="contact-meta"><span class="mono">${esc(request.phone_masked || '')}</span><span>${esc(String(request.createdAt || '').slice(0, 16).replace('T', ' '))}</span></div>`,
        actions: [
          { label: tr('contacts.reject', '拒绝'), role: 'secondary', attrs: { 'data-request-reject': request.id } },
          { label: tr('contacts.accept', '通过'), role: 'primary', attrs: { 'data-request-accept': request.id } },
        ],
        attrs: { 'data-request-row': request.id },
      });
    }).join('');
    const outgoingCards = outgoing.map((request) => {
      if (typeof root.uiResourceCard !== 'function') return '';
      const state = requestStateText(request);
      const tone = request.state === 'pending' ? 'attention' : (request.state === 'accepted' ? 'success' : 'neutral');
      return root.uiResourceCard({
        title: String(request.peerName || request.peer_name || request.phone_masked || tr('contacts.unknown_peer', '未知联系人')),
        icon: 'user',
        status: { label: state, tone },
        attrs: { 'data-request-row': request.id },
      });
    }).join('');
    return [
      `<p class="section-title">${esc(tr('contacts.received_requests', '收到的申请'))}</p>`,
      incomingCards ? grid(incomingCards) : emptyState('contacts.requests_empty', '没有待处理的申请'),
      outgoingCards ? `<p class="section-title">${esc(tr('contacts.sent_requests', '我发出的申请'))}</p>${grid(outgoingCards)}` : '',
    ].join('');
  }

  /** 详情页（原型 viewDetail）：返回 + 默认接待范围 + 往来记录 + 删除。 */
  function detailPageHtml(contact) {
    const online = contact.online !== false;
    const header = typeof root.uiPageHeader === 'function'
      ? root.uiPageHeader({
        title: String(contact.name || contact.user_id),
        actions: [{ label: tr('contacts.back', '返回'), icon: 'chevron-left', attrs: { 'data-contacts-back': '1' } }],
      })
      : `<h1 class="contacts-title">${esc(contact.name || contact.user_id)}</h1>`;
    const dot = typeof root.uiStatusDot === 'function'
      ? root.uiStatusDot({ label: online ? tr('contacts.online', '在线') : tr('contacts.offline', '离线'), tone: online ? 'success' : 'idle' })
      : '';
    const startBtn = typeof root.uiButton === 'function'
      ? root.uiButton({
        label: tr('contacts.start_chat', '发起对话'),
        role: 'primary',
        icon: 'at-sign',
        disabled: !online,
        attrs: { 'data-contact-start': contact.user_id },
      })
      : '';
    const agentSelect = typeof root.uiSelect === 'function'
      ? root.uiSelect({
        id: 'contact-default-agent',
        native: true,
        ariaLabel: tr('contacts.default_agent', 'Agent'),
        value: contact.default_agent_id || '',
        options: [
          { value: '', label: tr('contacts.default_agent_auto', '按接待时选择') },
          ...scopeOptions.agents,
        ],
        attrs: { 'data-contact-default-agent': contact.user_id },
      })
      : '';
    const wsSelect = typeof root.uiSelect === 'function'
      ? root.uiSelect({
        id: 'contact-default-workspace',
        native: true,
        ariaLabel: tr('contacts.default_workspace', '工作区'),
        value: contact.default_workspace || '',
        options: [
          { value: '', label: tr('contacts.default_workspace_auto', '按接待时选择') },
          ...scopeOptions.spaces,
        ],
        attrs: { 'data-contact-default-workspace': contact.user_id },
      })
      : '';
    const deleteBtn = typeof root.uiButton === 'function'
      ? root.uiButton({ label: tr('contacts.delete', '删除联系人'), role: 'danger', attrs: { 'data-contact-delete': contact.user_id } })
      : '';
    const head = `<div class="contacts-detail-head">
        ${dot}
        ${contact.phone_masked ? `<span class="contacts-detail-phone mono">${esc(contact.phone_masked)}</span>` : ''}
        <span class="contacts-detail-spacer"></span>
        ${startBtn}
      </div>`;
    const defaultScope = section(
      tr('contacts.default_scope', '对方发来请求时默认使用'),
      `<dl class="contacts-kv"><dt>${esc(tr('contacts.default_agent', 'Agent'))}</dt><dd>${agentSelect}</dd><dt>${esc(tr('contacts.default_workspace', '工作区'))}</dt><dd>${wsSelect}</dd></dl>`,
    );
    const history = section(tr('contacts.history', '往来记录'), historyTable(selectedHistory));
    const danger = section('', `<div class="contacts-danger-row"><span class="contacts-danger-hint">${esc(tr('contacts.delete_hint', '删除后双方都不能再向对方发起对话。'))}</span>${deleteBtn}</div>`);
    return `<div class="contacts-page contacts-detail-page">${header}<div class="contacts-detail-body">${head}${defaultScope}${history}${danger}</div></div>`;
  }

  function render() {
    const host = typeof document !== 'undefined' ? document.getElementById('contacts-view') : null;
    if (!host) return;
    const api = contactsApi();
    const allRequests = api && typeof api.requests === 'function' ? api.requests() : [];
    const pendingCount = allRequests.filter((row) => row.state === 'pending').length;
    const contact = api ? api.list().find((row) => row.user_id === selectedUserId) : null;

    if (detailOpen && contact) {
      host.innerHTML = detailPageHtml(contact);
      bind(host);
      return;
    }
    if (detailOpen && !contact) detailOpen = false;

    const notice = expiredNotice(allRequests);
    const header = typeof root.uiPageHeader === 'function'
      ? root.uiPageHeader({
        title: tr('contacts.title', '通讯录'),
        actions: [{ label: tr('contacts.add', '添加联系人'), icon: 'plus', attrs: { 'data-contacts-add': '1' } }],
      })
      : `<h1 class="contacts-title">${esc(tr('contacts.title', '通讯录'))}</h1>`;
    const tabs = typeof root.uiSegmentedControl === 'function'
      ? root.uiSegmentedControl({
        ariaLabel: tr('contacts.title', '通讯录'),
        role: 'tablist',
        value: activeTab,
        items: [
          { value: 'contacts', label: tr('contacts.tab.contacts', '联系人'), count: api ? api.list().length : 0, attrs: { 'data-value': 'contacts' } },
          { value: 'requests', label: tr('contacts.tab.requests', '新的联系人'), count: pendingCount, attrs: { 'data-value': 'requests' } },
        ],
      })
      : '';
    const noticeHtml = notice ? `<div class="contacts-expired-notice" role="status">${esc(notice)}</div>` : '';
    const body = activeTab === 'contacts' ? renderContactsTab(api) : renderRequestsTab(api);
    host.innerHTML = `<div class="contacts-page">${header}${noticeHtml}${tabs}${body}</div>`;
    bind(host);
  }

  function bind(host) {
    host.querySelectorAll('.ui-segmented-control button[data-value]').forEach((node) => {
      node.addEventListener('click', (event) => {
        const value = node.getAttribute('data-value');
        if (!value) return;
        if (value === 'all' || value === 'online') {
          event.preventDefault();
          onlineOnly = value === 'online';
          render();
          return;
        }
        if (value === activeTab) return;
        event.preventDefault();
        activeTab = value;
        render();
      });
    });
    const search = host.querySelector('[data-contacts-search]');
    if (search) {
      search.value = keyword;
      search.addEventListener('input', () => {
        keyword = String(search.value || '');
        const listPane = host.querySelector('.contacts-list-body');
        const api = contactsApi();
        if (listPane && api) {
          listPane.innerHTML = renderContactsTab(api);
          bind(host.querySelector('.contacts-list-body') || host);
        }
      });
    }
    host.querySelectorAll('[data-contacts-add]').forEach((node) => {
      node.addEventListener('click', () => { void addContact(); });
    });
    host.querySelectorAll('[data-contacts-back]').forEach((node) => {
      node.addEventListener('click', (event) => {
        event.preventDefault();
        detailOpen = false;
        render();
      });
    });
    host.querySelectorAll('[data-request-accept]').forEach((node) => {
      node.addEventListener('click', () => { void accept(node.dataset.requestAccept); });
    });
    host.querySelectorAll('[data-request-reject]').forEach((node) => {
      node.addEventListener('click', () => { void reject(node.dataset.requestReject); });
    });
    host.querySelectorAll('[data-contact-delete]').forEach((node) => {
      node.addEventListener('click', (event) => {
        event.preventDefault();
        void deleteContact(node.dataset.contactDelete);
      });
    });
    host.querySelectorAll('[data-contact-card]').forEach((node) => {
      node.addEventListener('click', (event) => {
        if (event.target && event.target.closest && event.target.closest('button, a')) return;
        void selectContact(node.dataset.contactCard);
      });
    });
    const agentSel = host.querySelector('[data-contact-default-agent]');
    if (agentSel) {
      agentSel.addEventListener('change', () => {
        void saveScope(agentSel.getAttribute('data-contact-default-agent'), { agentId: agentSel.value });
      });
    }
    const wsSel = host.querySelector('[data-contact-default-workspace]');
    if (wsSel) {
      wsSel.addEventListener('change', () => {
        void saveScope(wsSel.getAttribute('data-contact-default-workspace'), { workspace: wsSel.value });
      });
    }
    host.querySelectorAll('[data-contact-start]').forEach((node) => {
      node.addEventListener('click', (event) => {
        event.preventDefault();
        void startChat(node.dataset.contactStart);
      });
    });
  }

  async function selectContact(userId) {
    if (!userId) return;
    selectedUserId = String(userId);
    selectedHistory = [];
    detailOpen = true;
    render();
    void loadScopeOptions().then(() => { if (detailOpen && selectedUserId === String(userId)) render(); }).catch(() => {});
    const api = contactsApi();
    if (api && typeof api.history === 'function') {
      try {
        const rows = await api.history(selectedUserId);
        selectedHistory = Array.isArray(rows) ? rows : [];
      } catch (_) { selectedHistory = []; }
    }
    if (selectedUserId) render();
  }

  /**
   * 查号结果 → 能不能发申请（AC-02/06 的界面侧判断）。
   *
   * 三布尔已经回答了「有没有这个人 / 是不是已经认识 / 让不让搜」，界面不该再发一次
   * 服务器一定会拒的申请——拒绝原因必须当场说清楚。
   */
  function decideRequestAdd(lookup) {
    if (!lookup || lookup.registered !== true) return { allowed: false, reason: 'not_registered' };
    if (lookup.is_contact === true) return { allowed: false, reason: 'already_contact' };
    if (lookup.discoverable === false) return { allowed: false, reason: 'not_discoverable' };
    return { allowed: true };
  }

  const REQUEST_ADD_MESSAGES = {
    not_registered: ['contacts.not_registered', '该手机号还没有注册 CogSeed。'],
    already_contact: ['contacts.already_contact', '你们已经是联系人了。'],
    not_discoverable: ['contacts.not_discoverable', '对方不接受新的联系人申请。'],
  };

  async function addContact() {
    const api = contactsApi();
    if (!api || typeof api.requestAdd !== 'function') return;
    if (typeof root.uiPrompt !== 'function') return;
    const phone = await root.uiPrompt(tr('contacts.add_prompt', '输入对方手机号'), '');
    if (!phone) return;
    let lookup = null;
    try {
      lookup = typeof api.lookupByPhone === 'function' ? await api.lookupByPhone(phone) : null;
    } catch (err) {
      const code = err && err.code;
      const message = code === 'LOOKUP_QUOTA_EXCEEDED'
        ? tr('contacts.lookup_quota_exceeded', '今日查找次数已用完，请明天再试。')
        : tr('contacts.lookup_failed', '查找失败，请稍后重试。');
      if (typeof root.uiAlert === 'function') root.uiAlert(message);
      return;
    }
    const decision = decideRequestAdd(lookup);
    if (!decision.allowed) {
      const entry = REQUEST_ADD_MESSAGES[decision.reason];
      if (entry && typeof root.uiAlert === 'function') root.uiAlert(tr(entry[0], entry[1]));
      return;
    }
    try {
      await api.requestAdd(phone, '');
    } catch (err) {
      // 服务端明确拒绝（开关关闭等）时把原因说出来，而不是静默失败。
      const reason = (err && err.message) || tr('contacts.request_failed', '发起申请失败，请稍后重试。');
      if (typeof root.uiAlert === 'function') root.uiAlert(reason);
    }
  }

  async function accept(id) {
    const api = contactsApi();
    if (!api || typeof api.acceptRequest !== 'function' || !id) return;
    await api.acceptRequest(id);
  }

  async function reject(id) {
    const api = contactsApi();
    if (!api || typeof api.rejectRequest !== 'function' || !id) return;
    await api.rejectRequest(id);
  }

  async function deleteContact(userId) {
    const api = contactsApi();
    if (!api || typeof api.remove !== 'function' || !userId) return;
    const confirmed = typeof root.uiConfirmDanger === 'function'
      ? await root.uiConfirmDanger({
        title: tr('contacts.delete_title', '删除联系人'),
        message: tr('contacts.delete_message', '删除后双方都不能再向对方发起；本机往来记录会保留。'),
        confirmLabel: tr('contacts.delete', '删除联系人'),
      })
      : true;
    if (!confirmed) return;
    await api.remove(userId);
    if (selectedUserId === userId) {
      selectedUserId = '';
      selectedHistory = [];
      detailOpen = false;
    }
    render();
  }

  /** 保存默认接待范围（FR-06）：只写本机缓存，Hub 就绪后再同步服务端。 */
  async function saveScope(userId, scope) {
    const api = contactsApi();
    if (!api || typeof api.setDefaultScope !== 'function' || !userId) return;
    try {
      await api.setDefaultScope(userId, scope);
    } catch (_) { /* 失败保留旧值，下次进入详情重新读取 */ }
    if (detailOpen && selectedUserId === String(userId)) render();
  }

  /** 打开新任务，并把联系人作为点名写进草稿（FR-17）。 */
  function openNewContactDraft(contact) {
    const id = String(contact.user_id || '');
    try {
      if (typeof root.setView === 'function') root.setView('new-chat');
    } catch (_) { /* 视图切换失败不阻断 */ }
    const cm = root.composerMembers;
    if (!cm || typeof cm.insertMention !== 'function') return;
    const name = String(contact.name || id);
    // 视图切换后输入框才挂载：轮询到插入成功为止（最多约 1.2s）。
    // 之前只等一帧，冷启动时输入框还没挂载，令牌插不进去，用户手打的 @名字
    // 又不会被当成联系人，消息就发给了本机助理。
    let tries = 0;
    const insert = () => {
      tries += 1;
      let inserted = false;
      try {
        inserted = cm.insertMention('new-chat', { kind: 'contact', user_id: id, name }) === true;
      } catch (_) { /* 插入失败继续重试 */ }
      if (!inserted && tries < 20) root.setTimeout(insert, 60);
    };
    root.setTimeout(insert, 60);
  }

  function formatConversationTime(value) {
    const date = new Date(String(value || ''));
    if (!Number.isFinite(date.getTime())) return '';
    try {
      const locale = root.document && root.document.documentElement
        ? root.document.documentElement.lang || undefined
        : undefined;
      return new Intl.DateTimeFormat(locale, {
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(date);
    } catch (_) {
      return String(value || '').slice(0, 16).replace('T', ' ');
    }
  }

  function conversationChoiceFormHtml(rows, mode) {
    const options = rows.map((row) => ({
      value: row.conversation_id,
      label: [row.title || tr('contacts.conversation_untitled', '未命名会话'), String(row.preview || '').slice(0, 80), formatConversationTime(row.updated_at)]
        .filter(Boolean).join(' · '),
    }));
    const modeControl = root.uiSegmentedControl({
      ariaLabel: tr('contacts.conversation_choice_mode', '选择方式'),
      role: 'group',
      value: mode,
      items: [
        { value: 'continue', label: tr('contacts.conversation_continue', '继续已有会话'), attrs: { 'data-contact-conversation-mode': 'continue' } },
        { value: 'new', label: tr('contacts.conversation_new', '创建新会话'), attrs: { 'data-contact-conversation-mode': 'new' } },
      ],
    });
    const select = root.uiSelect({
      id: 'contact-conversation-select',
      native: true,
      className: 'form-input',
      ariaLabel: tr('contacts.conversation_existing', '已有会话'),
      value: options[0] ? options[0].value : '',
      options,
      attrs: { 'data-contact-conversation-select': '1' },
    });
    const existing = rows.length
      ? select
      : root.uiEmptyState({ title: tr('contacts.conversation_empty', '还没有可继续的会话') });
    return root.uiForm({
      ariaLabel: tr('contacts.conversation_choice_title', '发起对话'),
      fields: [
        { html: modeControl },
        { html: `<div data-contact-existing-field${mode === 'continue' ? '' : ' hidden'}>${existing}</div>` },
      ],
    });
  }

  function conversationStatusFormHtml(key, fallback) {
    return root.uiForm({
      ariaLabel: tr('contacts.conversation_choice_title', '发起对话'),
      fields: [{ html: `<p role="status">${esc(tr(key, fallback))}</p>` }],
    });
  }

  function restoreStartChatFocus(userId) {
    const doc = root.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') return;
    const trigger = Array.from(doc.querySelectorAll('[data-contact-start]'))
      .find((node) => node && node.dataset && node.dataset.contactStart === userId);
    if (trigger && typeof trigger.focus === 'function') trigger.focus({ preventScroll: true });
  }

  async function startChat(userId) {
    const id = String(userId || '');
    const api = contactsApi();
    const contact = api && api.list().find((row) => row.user_id === id);
    if (!id || !contact || typeof api.conversationsFor !== 'function') return;
    if (typeof root.uiFormModal !== 'function') return;
    let rows = [];
    let mode = 'new';
    let status = 'loading';
    let alive = true;
    const modal = root.uiFormModal({
      title: tr('contacts.conversation_choice_title', '发起对话'),
      closeLabel: tr('common.cancel', '取消'),
      cancelLabel: tr('common.cancel', '取消'),
      submitLabel: tr('contacts.conversation_confirm', '确认'),
      busyLabel: tr('contacts.conversation_loading', '正在读取会话…'),
      bodyHtml: conversationStatusFormHtml('contacts.conversation_loading', '正在读取会话…'),
      onSubmit: async () => {
        if (status === 'error') {
          await loadRows();
          return;
        }
        if (status !== 'ready') return;
        if (mode === 'new') {
          alive = false;
          modal.close('new');
          openNewContactDraft(contact);
          return;
        }
        const select = modal.dialog.querySelector('[data-contact-conversation-select]');
        const cid = select ? String(select.value || '') : '';
        if (!cid) {
          modal.setFeedback(tr('contacts.conversation_empty', '还没有可继续的会话'));
          return;
        }
        modal.setBusy(true);
        try {
          const latestRows = await api.conversationsFor(id);
          if (!alive) return;
          const available = latestRows.some((row) => row.conversation_id === cid);
          if (!available) {
            rows = latestRows;
            mode = rows.length ? 'continue' : 'new';
            renderReady();
            modal.setFeedback(tr('contacts.conversation_unavailable', '这条会话已不可用，请重新选择。'));
            return;
          }
          alive = false;
          modal.close(cid);
          if (typeof root.setView === 'function') root.setView('conversation', cid);
        } catch (_) {
          if (!alive) return;
          modal.setFeedback(tr('contacts.conversation_load_failed', '读取已有会话失败，请重试。'));
        } finally {
          if (alive) modal.setBusy(false);
        }
      },
    });

    function bindChoiceControls() {
      const existingField = modal.dialog.querySelector('[data-contact-existing-field]');
      const modeButtons = modal.dialog.querySelectorAll('[data-contact-conversation-mode]');
      const applyMode = (nextMode) => {
        mode = nextMode === 'continue' ? 'continue' : 'new';
        modeButtons.forEach((button) => {
          button.setAttribute('aria-pressed', String(button.dataset.contactConversationMode === mode));
        });
        if (existingField) existingField.hidden = mode !== 'continue';
        modal.setFeedback('');
      };
      modeButtons.forEach((button) => {
        button.addEventListener('click', () => applyMode(button.dataset.contactConversationMode));
      });
      applyMode(mode);
    }

    function renderReady() {
      if (!alive) return;
      status = 'ready';
      modal.update({
        submitLabel: tr('contacts.conversation_confirm', '确认'),
        bodyHtml: conversationChoiceFormHtml(rows, mode),
      });
      bindChoiceControls();
    }

    async function loadRows() {
      status = 'loading';
      modal.update({
        submitLabel: tr('contacts.conversation_confirm', '确认'),
        bodyHtml: conversationStatusFormHtml('contacts.conversation_loading', '正在读取会话…'),
      });
      modal.setFeedback('');
      modal.setBusy(true);
      try {
        const loadedRows = await api.conversationsFor(id);
        if (!alive) return;
        rows = loadedRows;
        mode = rows.length ? 'continue' : 'new';
        renderReady();
      } catch (_) {
        if (!alive) return;
        status = 'error';
        modal.update({
          submitLabel: tr('contacts.conversation_retry', '重试'),
          bodyHtml: conversationStatusFormHtml('contacts.conversation_load_failed', '读取已有会话失败，请重试。'),
        });
      } finally {
        if (alive) modal.setBusy(false);
      }
    }

    const onI18nChange = () => {
      alive = false;
      modal.close('rerender', 'i18n-change');
    };
    if (typeof root.addEventListener === 'function') root.addEventListener('i18n-change', onI18nChange);
    modal.then((result) => {
      alive = false;
      if (typeof root.removeEventListener === 'function') root.removeEventListener('i18n-change', onI18nChange);
      if (result && result.reason === 'i18n-change') void startChat(id);
      else if (result && ['escape', 'close', 'cancel', 'backdrop'].includes(result.reason)) restoreStartChatFocus(id);
    });
    await loadRows();
  }

  root.renderContactsPage = render;
  root.contactsPage = {
    render,
    showList: () => { detailOpen = false; render(); },
    setTab: (tab) => { activeTab = tab; render(); },
    selectContact,
    deleteContact,
    startChat,
    detailHtml,
    expiredNotice,
    // 纯判断：谁能发申请、被拒的原因是什么（界面与测试共用同一处口径）。
    decideRequestAdd,
  };

  if (typeof root.addEventListener === 'function') {
    root.addEventListener('contacts-changed', () => { render(); });
  }

  if (typeof document !== 'undefined' && document.readyState !== 'loading') render();
  else if (typeof root.addEventListener === 'function') root.addEventListener('DOMContentLoaded', render);
})();
