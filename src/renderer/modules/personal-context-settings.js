// 个人上下文连接器设置（设置 → 消息平台 → 个人上下文连接器）。
// 经典脚本 IIFE：渲染飞书连接状态（未连接/授权中/已连接/异常），
// 提供连接/取消/撤销/健康检查动作；已连接时展示发现到的可接入资源
// （日历/文件夹/文档等，只读元数据）并支持勾选保存接入范围。
// 通过 window.orkas.invoke 走 personal_context.* IPC 通道。
(function () {
  'use strict';

  const PROVIDER_ID = 'feishu';
  const POLL_MS = 2000;
  const AUTHORIZING_KINDS = new Set(['connecting']);

  const RESOURCE_TYPE_KEYS = {
    calendar: 'personal_context.resources.type.calendar',
    calendar_event: 'personal_context.resources.type.calendar_event',
    document: 'personal_context.resources.type.document',
    file: 'personal_context.resources.type.file',
    folder: 'personal_context.resources.type.folder',
    chat: 'personal_context.resources.type.chat',
    contact: 'personal_context.resources.type.contact',
  };

  const state = {
    initialized: false,
    status: null,
    authorizing: false,
    busy: false,
    pollTimer: null,
    // 首次使用配置向导：折叠式，平时只显示一行开关
    setupOpen: false,
    setupStep: 0,
    guide: null,
    // 资源选择区状态（仅 connected 时有效）
    resources: [],
    scopeIds: new Set(),
    resourcesLoaded: false,
    loadingResources: false,
    savingScope: false,
    resourceError: '',
  };

  function page() {
    return document.getElementById('personal-context-page');
  }

  function invoke(channel, payload) {
    if (!window.orkas || typeof window.orkas.invoke !== 'function') {
      return Promise.reject(new Error('IPC unavailable'));
    }
    return window.orkas.invoke(channel, payload || {});
  }

  function labelFor(key, fallback) {
    try {
      if (typeof t === 'function') return t(key);
    } catch (_) {
      // A locale failure should not prevent the settings tab from opening.
    }
    return fallback || key;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name, className) {
    const node = el('span', className || 'messaging-icon');
    node.dataset.uiIcon = name;
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  function errorMessage(error) {
    if (error && typeof error === 'object' && 'message' in error) return error.message;
    return String(error || '');
  }

  function kind() {
    return state.status ? state.status.kind : 'disconnected';
  }

  async function refreshStatus() {
    const result = await invoke('personal_context.get_status', { providerId: PROVIDER_ID });
    state.status = result && result.status ? result.status : null;
    state.authorizing = Boolean(result && result.status && result.status.authorizing);
    return state.status;
  }

  async function refresh() {
    try {
      await Promise.all([refreshStatus(), refreshGuide()]);
      // 非已连接状态：清除资源选择区缓存，下次连接时重新发现
      if (kind() !== 'connected') {
        state.resources = [];
        state.scopeIds = new Set();
        state.resourcesLoaded = false;
        state.resourceError = '';
      }
      renderCurrent();
      if (kind() === 'connected' && !state.resourcesLoaded && !state.loadingResources) {
        void loadResources();
      }
    } catch (error) {
      state.status = { kind: 'error', checkedAt: new Date().toISOString(), error: errorMessage(error) };
      renderCurrent();
    }
  }

  async function refreshGuide() {
    try {
      const result = await invoke('personal_context.get_setup_guide', {});
      state.guide = result && result.guide ? result.guide : null;
    } catch (_) {
      state.guide = null; // 向导数据缺失不阻塞状态展示
    }
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  }

  /** 授权窗口期间轮询：authorizing 结束（connected/error/disconnected）即停。 */
  function pollWhileAuthorizing() {
    stopPolling();
    const tick = async () => {
      if (!state.authorizing && !AUTHORIZING_KINDS.has(kind())) return;
      await refresh().catch(() => undefined);
      if (state.authorizing || AUTHORIZING_KINDS.has(kind())) {
        state.pollTimer = setTimeout(tick, POLL_MS);
      }
    };
    state.pollTimer = setTimeout(tick, POLL_MS);
  }

  function statusLine() {
    const row = el('div', 'messaging-owner-bound-row');
    const status = el('div', 'messaging-manual-bound');
    const k = kind();
    if (k === 'connected') {
      status.append(icon('check-circle', 'messaging-status-icon'), el('span', '', labelFor('personal_context.status.connected', '')));
    } else if (k === 'connecting' || state.authorizing) {
      status.append(icon('clock', 'messaging-status-icon'), el('span', '', labelFor('personal_context.status.connecting', '')));
    } else if (k === 'error') {
      status.append(
        icon('alert', 'messaging-status-icon'),
        el('span', '', state.status.needsReauth
          ? labelFor('personal_context.status.needs_reauth', '')
          : labelFor('personal_context.status.error', '').replace('{error}', state.status.error || '')),
      );
    } else {
      status.append(icon('circle', 'messaging-status-icon'), el('span', '', labelFor('personal_context.status.disconnected', '')));
    }
    row.appendChild(status);
    return row;
  }

  function actions() {
    const row = el('div', 'messaging-manual-fields');
    const k = kind();
    if (k === 'connected') {
      const revoke = el('button', 'btn btn-danger messaging-delete-button', labelFor('personal_context.revoke', ''));
      revoke.type = 'button';
      revoke.disabled = state.busy;
      revoke.addEventListener('click', () => void revokeConnection(revoke));
      row.appendChild(revoke);
    } else if (k === 'connecting' || state.authorizing) {
      const cancel = el('button', 'btn messaging-secondary-button', labelFor('personal_context.cancel', ''));
      cancel.type = 'button';
      cancel.disabled = state.busy;
      cancel.addEventListener('click', () => void cancelAuthorize(cancel));
      row.appendChild(cancel);
    } else {
      const connect = el('button', 'btn btn-primary', labelFor('personal_context.connect', ''));
      connect.type = 'button';
      connect.disabled = state.busy;
      connect.addEventListener('click', () => void connectFeishu(connect));
      row.appendChild(connect);
      if (k === 'error') {
        const revoke = el('button', 'btn messaging-secondary-button', labelFor('personal_context.revoke', ''));
        revoke.type = 'button';
        revoke.disabled = state.busy;
        revoke.addEventListener('click', () => void revokeConnection(revoke));
        row.appendChild(revoke);
      }
    }
    return row;
  }

  // ---- 首次使用配置向导（折叠式步骤引导）----

  function setupButton(labelKey, onClick) {
    const btn = el('button', 'btn', labelFor(labelKey, ''));
    btn.type = 'button';
    btn.addEventListener('click', () => onClick(btn));
    return btn;
  }

  function openConsole(btn) {
    const appId = state.guide && state.guide.appId;
    const url = 'https://open.feishu.cn/app' + (appId ? '/' + encodeURIComponent(appId) : '');
    void invoke('auth.openExternal', { url }).catch(() => undefined);
  }

  function copyRedirect(btn) {
    const url = state.guide && state.guide.redirectUri;
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => {
      if (btn) btn.textContent = labelFor('personal_context.setup.copied', '');
    }).catch(() => undefined);
  }

  function advanceSetup() {
    const steps = setupGuideSteps();
    if (state.setupStep < steps.length - 1) {
      state.setupStep += 1;
    } else {
      state.setupOpen = false; // 最后一步「完成」收起向导
    }
    renderCurrent();
  }

  function toggleSetup() {
    state.setupOpen = !state.setupOpen;
    if (state.setupOpen && !state.guide) void refreshGuide().then(() => renderCurrent());
    renderCurrent();
  }

  function setupGuideSteps() {
    const guide = state.guide || {};
    return [
      {
        titleKey: 'personal_context.setup.step0_title',
        body() {
          if (guide.credentialReady) {
            return el('p', '', labelFor('personal_context.setup.step0_ready', ''));
          }
          return el('p', '', labelFor('personal_context.setup.step0_missing', ''));
        },
        canNext: () => Boolean(guide.credentialReady),
      },
      {
        titleKey: 'personal_context.setup.step1_title',
        body() {
          const wrap = el('div', '');
          wrap.appendChild(el('p', '', labelFor('personal_context.setup.step1_desc', '')));
          wrap.appendChild(el('code', 'personal-context-redirect', guide.redirectUri || ''));
          const row = el('div', 'personal-context-guide-actions');
          row.appendChild(setupButton('personal_context.setup.copy', copyRedirect));
          row.appendChild(setupButton('personal_context.setup.open_console', openConsole));
          wrap.appendChild(row);
          return wrap;
        },
        canNext: () => true,
      },
      {
        titleKey: 'personal_context.setup.step2_title',
        body() {
          const wrap = el('div', '');
          wrap.appendChild(el('p', '', labelFor('personal_context.setup.step2_desc', '')));
          wrap.appendChild(el('p', '', labelFor('personal_context.setup.permissions', '')));
          const row = el('div', 'personal-context-guide-actions');
          row.appendChild(setupButton('personal_context.setup.open_console', openConsole));
          wrap.appendChild(row);
          return wrap;
        },
        canNext: () => true,
      },
      {
        titleKey: 'personal_context.setup.step3_title',
        body() {
          return el('p', '', labelFor('personal_context.setup.step3_desc', ''));
        },
        canNext: () => true,
      },
      {
        titleKey: 'personal_context.setup.step4_title',
        body() {
          return el('p', '', labelFor('personal_context.setup.step4_desc', ''));
        },
        canNext: () => true,
      },
    ];
  }

  function renderSetupGuide() {
    const steps = setupGuideSteps();
    const index = Math.min(state.setupStep, steps.length - 1);
    const step = steps[index];
    const box = el('div', 'messaging-config-card personal-context-guide-box');
    box.appendChild(el('h4', '', labelFor(step.titleKey, '')));
    box.appendChild(step.body());
    if (step.canNext()) {
      const finish = index >= steps.length - 1;
      const btn = el('button', 'btn btn-primary', labelFor(finish ? 'personal_context.setup.finish' : 'personal_context.setup.done', ''));
      btn.type = 'button';
      btn.addEventListener('click', () => advanceSetup());
      box.appendChild(btn);
    }
    return box;
  }

  function renderCurrent() {
    const target = page();
    if (!target) return;
    target.replaceChildren();
    const section = el('section', 'messaging-config-card messaging-owner-card');
    section.appendChild(el('h3', '', labelFor('personal_context.title', '')));
    section.appendChild(el('p', '', labelFor('personal_context.subtitle', '')));
    section.appendChild(statusLine());
    const toggle = el('button', 'personal-context-guide-toggle', labelFor('personal_context.setup_toggle', ''));
    toggle.type = 'button';
    toggle.addEventListener('click', () => toggleSetup());
    section.appendChild(toggle);
    if (state.setupOpen) section.appendChild(renderSetupGuide());
    section.appendChild(actions());
    if (kind() === 'connected') {
      section.appendChild(resourcesCard());
    }
    target.appendChild(section);
  }

  // ── 资源选择区（仅已连接）───────────────────────────────────────────────

  function resourceTypeLabel(type) {
    const key = RESOURCE_TYPE_KEYS[type];
    return key ? labelFor(key, type) : type;
  }

  function resourcesCard() {
    const card = el('section', 'messaging-config-card');
    const head = el('div', 'messaging-config-card-heading');
    head.appendChild(el('h3', '', labelFor('personal_context.resources.title', '')));
    head.appendChild(el('p', '', labelFor('personal_context.resources.subtitle', '')));
    card.appendChild(head);

    const list = el('div', '');
    list.id = 'pc-resource-list';
    card.appendChild(list);

    const buttons = el('div', 'messaging-manual-fields');
    const refresh = el('button', 'btn messaging-secondary-button', labelFor('personal_context.resources.refresh', ''));
    refresh.type = 'button';
    refresh.addEventListener('click', () => void refreshResources(refresh));
    const save = el('button', 'btn btn-primary', labelFor('personal_context.resources.save', ''));
    save.type = 'button';
    save.addEventListener('click', () => void saveScope(save));
    buttons.append(refresh, save);
    card.appendChild(buttons);
    return card;
  }

  /** 拉取发现资源 + 当前接入范围，合并勾选状态 */
  async function loadResources() {
    if (state.loadingResources) return;
    state.loadingResources = true;
    renderResourceList();
    try {
      const [discovered, scope] = await Promise.all([
        invoke('personal_context.discover_resources', { providerId: PROVIDER_ID }),
        invoke('personal_context.get_scope', { providerId: PROVIDER_ID }),
      ]);
      state.resources = (discovered && discovered.resources) || [];
      state.scopeIds = new Set(((scope && scope.scope && scope.scope.entries) || []).map((entry) => entry.resourceId));
      state.resourcesLoaded = true;
      state.resourceError = '';
    } catch (error) {
      state.resourceError = errorMessage(error);
    } finally {
      state.loadingResources = false;
      renderResourceList();
    }
  }

  function renderResourceList() {
    const list = document.getElementById('pc-resource-list');
    if (!list) return;
    list.replaceChildren();
    if (state.loadingResources && state.resources.length === 0) {
      list.appendChild(el('p', 'messaging-owner-guide', labelFor('personal_context.resources.loading', '')));
      return;
    }
    if (state.resourceError) {
      list.appendChild(el('p', 'messaging-owner-guide', labelFor('personal_context.resources.load_failed', '').replace('{error}', state.resourceError)));
      return;
    }
    if (state.resources.length === 0) {
      list.appendChild(el('p', 'messaging-owner-guide', labelFor('personal_context.resources.empty', '')));
      return;
    }
    for (const resource of state.resources) {
      const row = el('label', 'messaging-owner-bound-row');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state.scopeIds.has(resource.resourceId);
      box.addEventListener('change', (event) => {
        const checked = Boolean(event.target && event.target.checked);
        if (checked) state.scopeIds.add(resource.resourceId);
        else state.scopeIds.delete(resource.resourceId);
      });
      const title = el('span', '', resource.title || resource.resourceId);
      const typeLabel = el('span', '', resourceTypeLabel(resource.resourceType));
      typeLabel.style.color = 'var(--muted)';
      typeLabel.style.fontSize = '12px';
      row.append(box, title, typeLabel);
      list.appendChild(row);
    }
  }

  function refreshResources(button) {
    if (state.loadingResources) return;
    button.disabled = true;
    state.resourcesLoaded = false;
    state.resources = [];
    loadResources().finally(() => {
      button.disabled = false;
    });
  }

  /** 保存勾选的接入范围（整体替换） */
  async function saveScope(button) {
    if (state.savingScope) return;
    state.savingScope = true;
    button.disabled = true;
    try {
      const resources = state.resources.filter((resource) => state.scopeIds.has(resource.resourceId));
      const result = await invoke('personal_context.set_scope', { providerId: PROVIDER_ID, resources });
      setNotice(labelFor(
        result && result.changed ? 'personal_context.resources.saved' : 'personal_context.resources.saved_unchanged',
        '',
      ), 'info');
    } catch (error) {
      setNotice(labelFor('personal_context.resources.save_failed', '').replace('{error}', errorMessage(error)), 'error');
    } finally {
      state.savingScope = false;
      button.disabled = false;
    }
  }

  async function connectFeishu(button) {
    if (state.busy) return;
    state.busy = true;
    button.disabled = true;
    try {
      await invoke('personal_context.begin_authorize', { providerId: PROVIDER_ID });
      await refreshStatus();
      renderCurrent();
      pollWhileAuthorizing();
    } catch (error) {
      setNotice(labelFor('personal_context.connect_failed', '').replace('{error}', errorMessage(error)), 'error');
      await refresh();
    } finally {
      state.busy = false;
    }
  }

  async function cancelAuthorize(button) {
    if (state.busy) return;
    state.busy = true;
    button.disabled = true;
    stopPolling();
    try {
      await invoke('personal_context.cancel_authorize', { providerId: PROVIDER_ID });
    } catch (_) {
      /* status refresh below reconciles */
    } finally {
      state.busy = false;
      await refresh();
    }
  }

  async function revokeConnection(button) {
    if (state.busy) return;
    if (typeof window.confirm === 'function' && !window.confirm(labelFor('personal_context.revoke_confirm', ''))) return;
    state.busy = true;
    button.disabled = true;
    stopPolling();
    try {
      await invoke('personal_context.revoke', { providerId: PROVIDER_ID });
    } catch (error) {
      setNotice(labelFor('personal_context.revoke_failed', '').replace('{error}', errorMessage(error)), 'error');
    } finally {
      state.busy = false;
      await refresh();
    }
  }

  function setNotice(text, kindName) {
    const target = page();
    if (!target) return;
    let notice = target.querySelector('.messaging-notice');
    if (!notice) {
      notice = el('div', 'messaging-notice');
      target.appendChild(notice);
    }
    notice.className = `messaging-notice is-${kindName || 'info'}`;
    notice.setAttribute('role', kindName === 'error' ? 'alert' : 'status');
    notice.textContent = text;
  }

  window.initPersonalContextSettings = async function initPersonalContextSettings() {
    if (!state.initialized) {
      state.initialized = true;
    }
    await refresh();
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      PROVIDER_ID,
      __test: {
        state,
        labelFor,
        statusLine,
        actions,
        renderCurrent,
        refreshStatus,
        stopPolling,
        refreshGuide,
        toggleSetup,
        advanceSetup,
        renderSetupGuide,
        setupGuideSteps,
        resourceTypeLabel,
        renderResourceList,
      },
    };
  }
})();
