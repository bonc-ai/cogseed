// Zcode-style two-step settings surface for the local Feishu/Lark gateway.
// Credentials stay in main; this module only sends metadata and renders state.
(function () {
  'use strict';

  const state = {
    view: 'catalog',
    instances: [],
    selectedId: '',
    openingChannel: '',
    notice: '',
    noticeKind: '',
    loading: false,
    updating: false,
    bound: false,
    initialized: false,
    operation: 0,
    qr: {
      instanceId: '',
      flowId: '',
      state: '',
      starting: false,
      cancelling: false,
      polling: false,
      revision: 0,
      qrUrl: '',
      expiresAt: null,
      intervalSeconds: 0,
      error: '',
      timer: null,
    },
  };

  // The disabled WeChat entry is deliberately visible so the unsupported
  // channel does not become a false affordance or disappear from the catalog.
  const CHANNELS = Object.freeze([
    { key: 'wechat', platform: 'wechat_personal', icon: 'message-square', available: false },
    { key: 'feishu', platform: 'feishu_lark', feishuTenantBrand: 'feishu', icon: 'message-square', available: true },
    { key: 'lark', platform: 'feishu_lark', feishuTenantBrand: 'lark', icon: 'message-square', available: true },
  ]);

  const QR_TERMINAL_STATES = new Set(['completed', 'cancelled', 'expired', 'denied', 'failed']);
  const QR_STATE_KEYS = Object.freeze({
    starting: 'messaging.feishu_qr.status_starting',
    awaiting_scan: 'messaging.feishu_qr.status_awaiting_scan',
    polling: 'messaging.feishu_qr.status_polling',
    slow_down: 'messaging.feishu_qr.status_slow_down',
    domain_switched: 'messaging.feishu_qr.status_domain_switched',
    activating: 'messaging.feishu_qr.status_activating',
    completed: 'messaging.feishu_qr.status_completed',
    cancelled: 'messaging.feishu_qr.status_cancelled',
    expired: 'messaging.feishu_qr.status_expired',
    denied: 'messaging.feishu_qr.status_denied',
    failed: 'messaging.feishu_qr.status_failed',
  });

  function invoke(channel, payload) {
    if (!window.orkas || typeof window.orkas.invoke !== 'function') {
      return Promise.reject(new Error('IPC unavailable'));
    }
    return window.orkas.invoke(channel, payload || {});
  }

  // Commander-driven proactive send: main pushes a `messaging:send-confirm`
  // request, the user must approve here before any Feishu message is sent.
  // FIFO so concurrent sends don't stack dialogs (mirrors connectors.js).
  const _sendConfirmQueue = [];
  let _sendConfirmDialogOpen = false;

  function _drainSendConfirmQueue() {
    if (_sendConfirmDialogOpen) return;
    _sendConfirmDialogOpen = true;
    (async () => {
      try {
        while (_sendConfirmQueue.length) {
          const info = _sendConfirmQueue.shift();
          const message = labelFor('messaging.send_confirm.message', '')
            .replace('{instance}', info.instance_name || '')
            .replace('{owner}', info.owner_label || '本人')
            .replace('{text}', info.text || '');
          const ok = await uiConfirm({
            message,
            okLabel: labelFor('messaging.send_confirm.approve', 'Send'),
            cancelLabel: labelFor('messaging.send_confirm.decline', 'Cancel'),
          });
          try {
            await invoke('messaging.send_confirm_response', {
              request_id: info.request_id,
              approved: !!ok,
            });
          } catch (_err) {
            /* stale dialog after timeout; harmless */
          }
        }
      } finally {
        _sendConfirmDialogOpen = false;
      }
    })();
  }

  if (window.orkas && typeof window.orkas.onPushEvent === 'function') {
    try {
      window.orkas.onPushEvent('messaging:send-confirm', (info) => {
        if (!info || typeof info.request_id !== 'string') return;
        _sendConfirmQueue.push(info);
        _drainSendConfirmQueue();
      });
    } catch (_err) { /* event not supported; harmless */ }
  }

  function labelFor(key, fallback) {
    try {
      if (typeof t === 'function') return t(key);
    } catch (_) {
      // A locale failure should not prevent the settings tab from opening.
    }
    return fallback || key;
  }

  function errorMessage(error, fallback) {
    if (error && typeof error.message === 'string' && error.message.trim()) return error.message.trim();
    return fallback || labelFor('messaging.load_failed', 'Messaging settings failed to load');
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

  function hydrate(root) {
    if (typeof hydrateUiIcons === 'function') hydrateUiIcons(root || document);
  }

  function rootNode() {
    return document.getElementById('messaging-page');
  }

  function channelForKey(key) {
    return CHANNELS.find((channel) => channel.key === key) || null;
  }

  function channelForInstance(instance) {
    if (!instance || instance.platform !== 'feishu_lark') return null;
    return instance.feishuTenantBrand === 'lark' ? 'lark' : 'feishu';
  }

  function currentInstance() {
    return state.instances.find((instance) => instance.id === state.selectedId) || null;
  }

  function instanceForChannel(channel) {
    if (!channel) return null;
    return state.instances
      .filter((instance) => channelForInstance(instance) === channel.key)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0] || null;
  }

  function setNotice(message, kind) {
    state.notice = message || '';
    state.noticeKind = kind || '';
  }

  function clearQrTimer() {
    if (state.qr.timer !== null) {
      clearTimeout(state.qr.timer);
      state.qr.timer = null;
    }
  }

  function resetQrState() {
    clearQrTimer();
    state.qr.revision += 1;
    state.qr.instanceId = '';
    state.qr.flowId = '';
    state.qr.state = '';
    state.qr.starting = false;
    state.qr.cancelling = false;
    state.qr.polling = false;
    state.qr.qrUrl = '';
    state.qr.expiresAt = null;
    state.qr.intervalSeconds = 0;
    state.qr.error = '';
  }

  function unwrapRegistrationResult(result) {
    if (result && result.registration && typeof result.registration === 'object') return result.registration;
    return result && typeof result === 'object' ? result : {};
  }

  function normalizeFeishuQrStatus(status) {
    const value = status && typeof status === 'object' ? status : {};
    const nextState = typeof value.state === 'string' && QR_STATE_KEYS[value.state]
      ? value.state
      : 'failed';
    return {
      state: nextState,
      ...(typeof value.qrUrl === 'string' && value.qrUrl.trim() ? { qrUrl: value.qrUrl.trim() } : {}),
      ...(typeof value.expiresAt === 'string' || typeof value.expiresAt === 'number'
        ? { expiresAt: value.expiresAt }
        : {}),
      ...(typeof value.intervalSeconds === 'number' && Number.isFinite(value.intervalSeconds)
        ? { intervalSeconds: value.intervalSeconds }
        : {}),
      ...(typeof value.error === 'string' && value.error.trim() ? { error: value.error.trim() } : {}),
      ...(value.instance && typeof value.instance === 'object' ? { instance: value.instance } : {}),
    };
  }

  function applyFeishuQrStatus(status) {
    const next = normalizeFeishuQrStatus(status);
    state.qr.state = next.state;
    if (QR_TERMINAL_STATES.has(next.state)) {
      state.qr.qrUrl = '';
      state.qr.expiresAt = null;
      state.qr.intervalSeconds = 0;
    } else {
      if (next.qrUrl) state.qr.qrUrl = next.qrUrl;
      if (next.expiresAt !== undefined) state.qr.expiresAt = next.expiresAt;
      if (next.intervalSeconds !== undefined) state.qr.intervalSeconds = next.intervalSeconds;
    }
    if (next.error) state.qr.error = next.error;
    return next;
  }

  function qrStateLabel(statusState) {
    return labelFor(QR_STATE_KEYS[statusState] || QR_STATE_KEYS.starting, statusState || 'starting');
  }

  function formatExpiry(value) {
    if (!value) return '';
    const numeric = typeof value === 'number' ? value : Date.parse(String(value));
    if (!Number.isFinite(numeric)) return '';
    const date = new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
    if (Number.isNaN(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
    } catch (_) {
      return date.toLocaleTimeString();
    }
  }

  function renderQrCode(host, url) {
    host.replaceChildren();
    if (!url) {
      host.appendChild(el('span', 'messaging-qr-pending', labelFor('messaging.feishu_qr.qr_pending', '')));
      return;
    }
    if (typeof qrcode !== 'function') {
      host.appendChild(el('span', 'messaging-qr-pending', labelFor('messaging.feishu_qr.qr_unavailable', '')));
      return;
    }
    try {
      const code = qrcode(0, 'M');
      code.addData(url, 'Byte');
      code.make();
      host.innerHTML = code.createSvgTag(4, 4);
      const svg = host.querySelector('svg');
      if (svg) {
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', labelFor('messaging.feishu_qr.qr_alt', ''));
      }
    } catch (error) {
      host.appendChild(el('span', 'messaging-qr-pending', errorMessage(error, labelFor('messaging.feishu_qr.qr_unavailable', ''))));
    }
  }

  function qrIsVisibleFor(instance) {
    return Boolean(instance && state.qr.instanceId === instance.id
      && (state.qr.starting || state.qr.flowId || state.qr.state));
  }

  function qrIsPending() {
    return Boolean(state.qr.starting || state.qr.cancelling
      || (state.qr.flowId && !QR_TERMINAL_STATES.has(state.qr.state)));
  }

  function qrPollDelay() {
    if (state.qr.state === 'slow_down') return 5000;
    if (Number.isFinite(state.qr.intervalSeconds) && state.qr.intervalSeconds > 0) {
      return Math.max(750, Math.min(10_000, Math.floor(state.qr.intervalSeconds * 1000)));
    }
    return state.qr.state === 'starting' ? 750 : 1500;
  }

  function scheduleQrPoll(flowId, revision) {
    clearQrTimer();
    if (!flowId || state.qr.flowId !== flowId || state.qr.revision !== revision || QR_TERMINAL_STATES.has(state.qr.state)) return;
    state.qr.timer = setTimeout(() => {
      state.qr.timer = null;
      void pollQr(flowId, revision);
    }, qrPollDelay());
  }

  async function completeQrRegistration(registration, flowId, revision) {
    if (state.qr.revision !== revision || state.qr.flowId !== flowId) return;
    const instance = registration && registration.instance;
    if (instance && typeof instance.id === 'string' && instance.id) {
      state.instances = state.instances.map((candidate) => candidate.id === instance.id ? instance : candidate);
      state.selectedId = instance.id;
    } else {
      await loadInstances();
    }
    resetQrState();
    state.view = 'detail';
    setNotice(labelFor('messaging.feishu_qr.completed', ''), 'success');
    renderCurrent();
  }

  async function pollQr(flowId, revision) {
    if (!flowId || state.qr.flowId !== flowId || state.qr.revision !== revision || state.qr.polling) return;
    state.qr.polling = true;
    try {
      const result = await invoke('messaging.feishu_qr.status', { flowId });
      if (state.qr.flowId !== flowId || state.qr.revision !== revision || state.qr.cancelling) return;
      const registration = unwrapRegistrationResult(result);
      const next = applyFeishuQrStatus(registration.status || registration);
      if (next.state === 'completed') {
        await completeQrRegistration(next, flowId, revision);
        return;
      }
      if (next.state === 'failed' || next.state === 'denied') {
        setNotice(state.qr.error || qrStateLabel(next.state), 'error');
      }
      renderCurrent();
      if (!QR_TERMINAL_STATES.has(next.state)) scheduleQrPoll(flowId, revision);
    } catch (error) {
      if (state.qr.flowId !== flowId || state.qr.revision !== revision || state.qr.cancelling) return;
      state.qr.state = 'failed';
      state.qr.error = errorMessage(error, labelFor('messaging.feishu_qr.poll_failed', ''));
      setNotice(state.qr.error, 'error');
      clearQrTimer();
      renderCurrent();
    } finally {
      if (state.qr.flowId === flowId && state.qr.revision === revision) state.qr.polling = false;
    }
  }

  async function startQr(instance) {
    if (!instance || !instance.id || qrIsPending()) return;
    resetQrState();
    const revision = state.qr.revision;
    state.qr.instanceId = instance.id;
    state.qr.starting = true;
    state.qr.state = 'starting';
    setNotice('', '');
    renderCurrent();
    try {
      const result = await invoke('messaging.feishu_qr.start', { instanceId: instance.id });
      const registration = unwrapRegistrationResult(result);
      const flowId = typeof registration.flowId === 'string' ? registration.flowId.trim() : '';
      if (!flowId) throw new Error(registration.error || result?.error || labelFor('messaging.feishu_qr.start_failed', ''));
      if (state.qr.revision !== revision || state.qr.instanceId !== instance.id) {
        try { await invoke('messaging.feishu_qr.cancel', { flowId }); } catch (_) { /* stale flow */ }
        return;
      }
      state.qr.flowId = flowId;
      state.qr.starting = false;
      const next = applyFeishuQrStatus(registration.status || registration);
      renderCurrent();
      if (next.state === 'completed') await completeQrRegistration(next, flowId, revision);
      else if (!QR_TERMINAL_STATES.has(next.state)) scheduleQrPoll(flowId, revision);
    } catch (error) {
      if (state.qr.revision !== revision) return;
      state.qr.starting = false;
      state.qr.state = 'failed';
      state.qr.error = errorMessage(error, labelFor('messaging.feishu_qr.start_failed', ''));
      setNotice(state.qr.error, 'error');
      renderCurrent();
    }
  }

  async function cancelQr(options) {
    const opts = options || {};
    const flowId = state.qr.flowId;
    const shouldRender = opts.render !== false;
    clearQrTimer();
    if (!flowId || QR_TERMINAL_STATES.has(state.qr.state)) {
      resetQrState();
      if (shouldRender) renderCurrent();
      return;
    }
    const revision = ++state.qr.revision;
    state.qr.cancelling = true;
    if (shouldRender) renderCurrent();
    try {
      await invoke('messaging.feishu_qr.cancel', { flowId });
    } catch (error) {
      if (!opts.silent) setNotice(errorMessage(error, labelFor('messaging.feishu_qr.cancel_failed', '')), 'error');
    } finally {
      if (state.qr.revision === revision) {
        resetQrState();
        if (shouldRender) renderCurrent();
      }
    }
  }

  function card(titleKey, subtitleKey, className) {
    const section = el('section', `messaging-config-card ${className || ''}`.trim());
    const heading = el('div', 'messaging-config-card-heading');
    heading.appendChild(el('h3', '', labelFor(titleKey, '')));
    if (subtitleKey) heading.appendChild(el('p', '', labelFor(subtitleKey, '')));
    section.appendChild(heading);
    return section;
  }

  function selectControl(options, value, disabled) {
    const select = document.createElement('select');
    select.className = 'messaging-detail-select';
    select.disabled = Boolean(disabled);
    for (const option of options) {
      const item = document.createElement('option');
      item.value = option.value;
      item.textContent = option.label;
      item.selected = option.value === value;
      select.appendChild(item);
    }
    return select;
  }

  function statusForInstance(instance) {
    if (!instance || instance.hasCredentials !== true) return 'unbound';
    if (instance.enabled !== true) return 'disabled';
    const kind = instance.status && instance.status.kind;
    return kind === 'error' ? 'error' : kind === 'connecting' ? 'connecting' : kind === 'connected' ? 'connected' : 'disconnected';
  }

  function statusLabel(status) {
    const keys = {
      unbound: 'messaging.status.unbound',
      disabled: 'messaging.status.disabled',
      connecting: 'messaging.status.connecting',
      connected: 'messaging.status.connected',
      disconnected: 'messaging.status.disconnected',
      error: 'messaging.status.error',
    };
    return labelFor(keys[status] || keys.disconnected, status);
  }

  function switchControl(instance) {
    const label = el('label', 'messaging-switch');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = instance.enabled === true;
    input.disabled = state.updating || instance.hasCredentials !== true;
    input.setAttribute('aria-label', labelFor('messaging.enabled', ''));
    input.addEventListener('change', () => {
      const enabled = input.checked;
      void updateInstance({ enabled }, input);
    });
    const track = el('span', 'messaging-switch-track');
    track.setAttribute('aria-hidden', 'true');
    label.append(input, track);
    return label;
  }

  function renderQrPanel(instance, cardRoot) {
    if (!qrIsVisibleFor(instance)) return;
    const panel = el('div', 'messaging-qr-panel');
    const host = el('div', 'messaging-qr-code');
    host.setAttribute('aria-live', 'polite');
    renderQrCode(host, state.qr.qrUrl);
    const info = el('div', 'messaging-qr-info');
    const status = state.qr.error && (state.qr.state === 'failed' || state.qr.state === 'denied')
      ? state.qr.error
      : qrStateLabel(state.qr.state || 'starting');
    const statusRow = el('div', `messaging-qr-status is-${state.qr.state || 'starting'}`);
    statusRow.append(icon('loader', 'messaging-qr-status-icon'), el('span', '', status));
    const expiry = formatExpiry(state.qr.expiresAt);
    if (expiry && !QR_TERMINAL_STATES.has(state.qr.state)) {
      statusRow.appendChild(el('span', 'messaging-qr-expiry', labelFor('messaging.feishu_qr.expires_at', '').replace('{time}', expiry)));
    }
    info.appendChild(statusRow);
    const actions = el('div', 'messaging-qr-actions');
    if (state.qr.flowId && !QR_TERMINAL_STATES.has(state.qr.state)) {
      const cancel = el('button', 'btn messaging-secondary-button', labelFor('messaging.feishu_qr.cancel', ''));
      cancel.type = 'button';
      cancel.disabled = state.qr.cancelling;
      cancel.appendChild(icon('x', 'messaging-action-icon'));
      cancel.addEventListener('click', () => void cancelQr());
      actions.appendChild(cancel);
    }
    info.appendChild(actions);
    panel.append(host, info);
    cardRoot.appendChild(panel);
  }

  function associationCard(instance) {
    const section = el('section', 'messaging-config-card messaging-association-card');
    const row = el('div', 'messaging-association-row');
    const copy = el('div', 'messaging-config-card-heading');
    copy.appendChild(el('h3', '', labelFor('messaging.association_title', '')));
    copy.appendChild(el('p', '', labelFor('messaging.association_sub', '')));
    row.appendChild(copy);
    const scanning = qrIsVisibleFor(instance);
    const scan = el('button', 'btn messaging-scan-button', labelFor(
      scanning ? 'messaging.feishu_qr.retry' : 'messaging.scan', '',
    ));
    scan.type = 'button';
    scan.disabled = state.updating || state.qr.starting || state.qr.cancelling || qrIsPending();
    scan.appendChild(icon(scanning ? 'refresh' : 'qr-code', 'messaging-action-icon'));
    scan.addEventListener('click', () => {
      if (scanning && state.qr.state && QR_TERMINAL_STATES.has(state.qr.state)) resetQrState();
      void startQr(instance);
    });
    row.appendChild(scan);
    section.appendChild(row);
    renderQrPanel(instance, section);
    const manual = manualLinkSection(instance);
    if (manual) section.appendChild(manual);
    return section;
  }

  function manualLinkSection(instance) {
    const qrActive = qrIsVisibleFor(instance) || qrIsPending();
    if (instance.hasCredentials === true) {
      const bound = el('div', 'messaging-manual-link');
      const boundRow = el('div', 'messaging-manual-bound');
      boundRow.append(icon('check-circle', 'messaging-status-icon'), el('span', '', labelFor('messaging.connection_bound', '')));
      const unbind = el('button', 'btn messaging-secondary-button', labelFor('messaging.unbind', ''));
      unbind.type = 'button';
      unbind.disabled = state.updating || qrActive;
      unbind.addEventListener('click', () => void unbindInstance(instance, unbind));
      boundRow.appendChild(unbind);
      bound.appendChild(boundRow);
      return bound;
    }
    if (qrActive) return null;
    const section = el('div', 'messaging-manual-link');
    const heading = el('div', 'messaging-config-card-heading');
    heading.appendChild(el('h4', '', labelFor('messaging.use_existing', '')));
    heading.appendChild(el('p', '', labelFor('messaging.use_existing_sub', '')));
    const appIdInput = document.createElement('input');
    appIdInput.type = 'text';
    appIdInput.className = 'form-input';
    appIdInput.placeholder = 'cli_xxxxxxxxxxxxxxxx';
    appIdInput.autocomplete = 'off';
    appIdInput.spellcheck = false;
    appIdInput.setAttribute('aria-label', labelFor('messaging.app_id', ''));
    const appSecretInput = document.createElement('input');
    appSecretInput.type = 'password';
    appSecretInput.className = 'form-input';
    appSecretInput.placeholder = '••••••••••••••••';
    appSecretInput.autocomplete = 'off';
    appSecretInput.spellcheck = false;
    appSecretInput.setAttribute('aria-label', labelFor('messaging.app_secret', ''));
    const link = el('button', 'btn messaging-link-button', labelFor('messaging.link', ''));
    link.type = 'button';
    link.disabled = state.updating;
    link.addEventListener('click', () => void linkWithCredentials(instance, appIdInput, appSecretInput, link));
    const rows = el('div', 'messaging-manual-fields');
    rows.append(appIdInput, appSecretInput, link);
    section.append(heading, rows);
    return section;
  }

  async function linkWithCredentials(instance, appIdInput, appSecretInput, button) {
    if (!instance || !instance.id || button.disabled) return;
    const appId = String(appIdInput.value || '').trim();
    const appSecret = String(appSecretInput.value || '').trim();
    if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
      setNotice(labelFor('messaging.app_id_invalid', ''), 'error');
      appIdInput.focus();
      return;
    }
    if (!appSecret) {
      setNotice(labelFor('messaging.app_secret_required', ''), 'error');
      appSecretInput.focus();
      return;
    }
    button.disabled = true;
    state.updating = true;
    setNotice('', '');
    renderCurrent();
    try {
      const result = await invoke('messaging.update', { instanceId: instance.id, secret: { appId, appSecret } });
      if (!result || !result.instance || typeof result.instance.id !== 'string') {
        throw new Error(result?.error || labelFor('messaging.link_failed', ''));
      }
      state.instances = state.instances.map((candidate) => candidate.id === result.instance.id ? result.instance : candidate);
      setNotice(labelFor('messaging.link_success', ''), 'success');
      // No-owner Feishu bot: guide the user to claim it by sending the first
      // direct message — no manual open id needed (main opens a binding window).
      if (result.instance.ownerConfigured === false && typeof uiAlert === 'function') {
        uiAlert(labelFor('messaging.owner_bind_hint', ''));
      }
    } catch (error) {
      setNotice(errorMessage(error, labelFor('messaging.link_failed', '')), 'error');
    } finally {
      state.updating = false;
      renderCurrent();
    }
  }

  async function unbindInstance(instance, button) {
    if (!instance || !instance.id || button.disabled) return;
    if (typeof window.confirm === 'function'
      && !window.confirm(labelFor('messaging.unbind_confirm', ''))) return;
    button.disabled = true;
    state.updating = true;
    setNotice('', '');
    try {
      if (state.qr.instanceId === instance.id) await cancelQr({ silent: true, render: false });
      const result = await invoke('messaging.unbind', { instanceId: instance.id });
      if (!result || !result.instance || typeof result.instance.id !== 'string') {
        throw new Error(result?.error || labelFor('messaging.unbind_failed', ''));
      }
      state.instances = state.instances.map((candidate) => candidate.id === result.instance.id ? result.instance : candidate);
      setNotice(labelFor('messaging.unbind_success', ''), 'success');
    } catch (error) {
      setNotice(errorMessage(error, labelFor('messaging.unbind_failed', '')), 'error');
    } finally {
      state.updating = false;
      renderCurrent();
    }
  }

  async function updateInstance(patch, control) {
    const instance = currentInstance();
    if (!instance || state.updating) return;
    const previousValue = control && 'value' in control ? control.value : undefined;
    state.updating = true;
    setNotice('', '');
    renderCurrent();
    try {
      const result = await invoke('messaging.update', { instanceId: instance.id, ...patch });
      if (!result || !result.instance || typeof result.instance.id !== 'string') {
        throw new Error(result?.error || labelFor('messaging.update_failed', ''));
      }
      state.instances = state.instances.map((candidate) => candidate.id === result.instance.id ? result.instance : candidate);
      setNotice(labelFor('messaging.updated', ''), 'success');
      // Enabling or linking a Feishu bot without an owner opens the auto-binding
      // window in main; tell the user how to claim it without typing an id.
      if ((patch.enabled === true || patch.secret !== undefined)
        && result.instance.ownerConfigured === false && typeof uiAlert === 'function') {
        uiAlert(labelFor('messaging.owner_bind_hint', ''));
      }
    } catch (error) {
      if (control && previousValue !== undefined) control.value = previousValue;
      setNotice(errorMessage(error, labelFor('messaging.update_failed', '')), 'error');
    } finally {
      state.updating = false;
      renderCurrent();
    }
  }

  function ownerIdentityCard(instance) {
    const section = card('messaging.owner_title', 'messaging.owner_subtitle', 'messaging-owner-card');
    if (instance.ownerConfigured === true) {
      const status = el('div', 'messaging-manual-bound');
      status.append(
        icon('check-circle', 'messaging-status-icon'),
        el('span', '', instance.ownerLabel || labelFor('messaging.owner_configured', '')),
      );
      section.appendChild(status);
    }

    const ownerIdInput = document.createElement('input');
    ownerIdInput.type = 'text';
    ownerIdInput.className = 'form-input';
    ownerIdInput.placeholder = 'ou_xxxxxxxxxxxxxxxx';
    ownerIdInput.autocomplete = 'off';
    ownerIdInput.spellcheck = false;
    ownerIdInput.setAttribute('aria-label', labelFor('messaging.owner_open_id', ''));

    const ownerNameInput = document.createElement('input');
    ownerNameInput.type = 'text';
    ownerNameInput.className = 'form-input';
    ownerNameInput.placeholder = labelFor('messaging.owner_name_placeholder', '');
    ownerNameInput.autocomplete = 'off';
    ownerNameInput.setAttribute('aria-label', labelFor('messaging.owner_name', ''));

    const save = el('button', 'btn messaging-link-button', labelFor(
      instance.ownerConfigured ? 'messaging.owner_update' : 'messaging.owner_save', '',
    ));
    save.type = 'button';
    save.disabled = state.updating;
    save.addEventListener('click', () => {
      const ownerExternalUserId = String(ownerIdInput.value || '').trim();
      const ownerExternalUserName = String(ownerNameInput.value || '').trim();
      if (!/^ou_[A-Za-z0-9_-]{1,157}$/.test(ownerExternalUserId)) {
        setNotice(labelFor('messaging.owner_open_id_invalid', ''), 'error');
        ownerIdInput.focus();
        renderCurrent();
        return;
      }
      void updateInstance({ ownerExternalUserId, ownerExternalUserName }, save);
    });

    const fields = el('div', 'messaging-manual-fields');
    fields.append(ownerIdInput, ownerNameInput, save);
    if (instance.ownerConfigured === true) {
      const clear = el('button', 'btn messaging-secondary-button', labelFor('messaging.owner_clear', ''));
      clear.type = 'button';
      clear.disabled = state.updating;
      clear.addEventListener('click', () => void updateInstance({ clearOwner: true }, clear));
      fields.appendChild(clear);
    }
    section.appendChild(fields);
    return section;
  }

  function detailPage(instance) {
    const channel = channelForKey(channelForInstance(instance)) || channelForKey('feishu');
    const page = el('section', 'messaging-detail-page');
    const nav = el('div', 'messaging-detail-nav');
    const back = el('button', 'messaging-back-button');
    back.type = 'button';
    back.title = labelFor('messaging.catalog.back', '');
    back.setAttribute('aria-label', labelFor('messaging.catalog.back', ''));
    back.appendChild(icon('chevron-left', 'messaging-nav-icon'));
    back.addEventListener('click', () => {
      void cancelQr({ silent: true, render: false });
      state.view = 'catalog';
      state.selectedId = '';
      setNotice('', '');
      renderCurrent();
    });
    nav.appendChild(back);
    page.appendChild(nav);

    const header = el('header', 'messaging-detail-header');
    const brand = el('div', `messaging-brand-icon is-${channel.key}`);
    brand.appendChild(icon(channel.icon, 'messaging-brand-glyph'));
    const titleWrap = el('div', 'messaging-detail-title-wrap');
    titleWrap.appendChild(el('h2', '', instance.displayName || labelFor('messaging.new_title', '')));
    const stateRow = el('div', `messaging-detail-state is-${statusForInstance(instance)}`);
    stateRow.append(icon(statusForInstance(instance) === 'connected' ? 'check-circle' : 'clock', 'messaging-status-icon'));
    stateRow.appendChild(el('span', '', statusLabel(statusForInstance(instance))));
    titleWrap.appendChild(stateRow);
    header.append(brand, titleWrap, switchControl(instance));
    page.appendChild(header);

    page.appendChild(associationCard(instance));
    page.appendChild(ownerIdentityCard(instance));

    const responseMode = instance.responseMode || 'text';
    const responseSelect = selectControl([
      { value: 'text', label: labelFor('messaging.response_text', '') },
      { value: 'streaming_card', label: labelFor('messaging.response_streaming_card', '') },
    ], responseMode, state.updating);
    responseSelect.setAttribute('aria-label', labelFor('messaging.response_title', ''));
    responseSelect.addEventListener('change', () => {
      if (responseSelect.value !== responseMode) {
        void updateInstance({ responseMode: responseSelect.value }, responseSelect);
      }
    });

    const workspaceSelect = selectControl([
      { value: 'all', label: labelFor('messaging.workspace_all', '') },
    ], 'all', state.updating);
    workspaceSelect.setAttribute('aria-label', labelFor('messaging.workspace_title', ''));
    workspaceSelect.addEventListener('change', () => {
      void updateInstance({ workspace: { type: 'all' } }, workspaceSelect);
    });
    page.appendChild(preferencesCard(responseSelect, workspaceSelect));

    const deletion = card('messaging.delete_title', 'messaging.delete_subtitle', 'messaging-delete-card');
    const deleteButton = el('button', 'btn btn-danger messaging-delete-button', labelFor('messaging.delete', ''));
    deleteButton.type = 'button';
    deleteButton.disabled = state.updating;
    deleteButton.appendChild(icon('trash', 'messaging-action-icon'));
    deleteButton.addEventListener('click', () => void deleteInstance(instance, deleteButton));
    deletion.appendChild(deleteButton);
    page.appendChild(deletion);

    appendNotice(page);
    return page;
  }

  function preferencesCard(responseControl, workspaceControl) {
    const section = el('section', 'messaging-config-card messaging-preferences-card');
    section.append(
      preferenceRow('messaging.response_title', 'messaging.response_subtitle', responseControl),
      preferenceRow('messaging.workspace_title', 'messaging.workspace_subtitle', workspaceControl),
    );
    return section;
  }

  function preferenceRow(titleKey, subtitleKey, control) {
    const row = el('div', 'messaging-preference-row');
    const copy = el('div', 'messaging-config-card-heading');
    copy.appendChild(el('h3', '', labelFor(titleKey, '')));
    copy.appendChild(el('p', '', labelFor(subtitleKey, '')));
    row.append(copy, control);
    return row;
  }

  function appendNotice(page) {
    if (!state.notice) return;
    const notice = el('div', `messaging-notice is-${state.noticeKind || 'info'}`, state.notice);
    notice.setAttribute('role', state.noticeKind === 'error' ? 'alert' : 'status');
    page.appendChild(notice);
  }

  async function deleteInstance(instance, button) {
    if (!instance || !instance.id || button.disabled) return;
    if (typeof window.confirm === 'function'
      && !window.confirm(labelFor('messaging.delete_confirm', ''))) return;
    button.disabled = true;
    state.updating = true;
    try {
      if (state.qr.instanceId === instance.id) await cancelQr({ silent: true, render: false });
      const result = await invoke('messaging.delete', { instanceId: instance.id });
      if (result && result.deleted === false) throw new Error(result.error || labelFor('messaging.delete_failed', ''));
      state.instances = state.instances.filter((candidate) => candidate.id !== instance.id);
      state.selectedId = '';
      state.view = 'catalog';
      setNotice('', '');
    } catch (error) {
      setNotice(errorMessage(error, labelFor('messaging.delete_failed', '')), 'error');
    } finally {
      state.updating = false;
      renderCurrent();
    }
  }

  function renderCatalogPage() {
    const page = el('section', 'messaging-catalog-page');
    page.appendChild(el('h1', '', labelFor('messaging.catalog.page_title', '')));
    page.appendChild(el('p', 'messaging-catalog-lead', labelFor('messaging.catalog.page_subtitle', '')));
    appendNotice(page);
    const grid = el('div', 'messaging-channel-grid');
    for (const channel of CHANNELS) {
      const existing = instanceForChannel(channel);
      const active = channel.available && (channel.platform === 'feishu_lark');
      const opening = state.openingChannel === channel.key;
      const row = el('button', `messaging-channel-card is-${channel.key}${active ? '' : ' is-disabled'}${opening ? ' is-loading' : ''}`);
      row.type = 'button';
      row.disabled = !active || Boolean(state.openingChannel);
      row.dataset.channel = channel.key;
      row.setAttribute('aria-disabled', String(!active));
      row.setAttribute('aria-busy', String(opening));
      const visual = el('span', 'messaging-channel-visual');
      visual.appendChild(icon(opening ? 'loader' : channel.icon, `messaging-channel-icon${opening ? ' is-spinning' : ''}`));
      row.appendChild(visual);
      const copy = el('span', 'messaging-channel-copy');
      const title = el('span', 'messaging-channel-title');
      title.appendChild(el('strong', '', labelFor(`messaging.channel.${channel.key}.title`, '')));
      if (channel.feishuTenantBrand) {
        title.appendChild(el('span', 'messaging-channel-badge', labelFor(`messaging.channel.${channel.key}.badge`, '')));
      }
      copy.appendChild(title);
      copy.appendChild(el('span', 'messaging-channel-description', labelFor(
        active ? `messaging.channel.${channel.key}.description` : 'messaging.channel.coming_soon', '',
      )));
      row.appendChild(copy);
      if (existing) row.classList.add('has-instance');
      if (active) row.addEventListener('click', () => void openChannel(channel));
      grid.appendChild(row);
    }
    page.appendChild(grid);
    return page;
  }

  async function openChannel(channel) {
    if (!channel || !channel.available || channel.platform !== 'feishu_lark' || state.openingChannel) return;
    const operation = ++state.operation;
    state.openingChannel = channel.key;
    setNotice('', '');
    renderCurrent();
    try {
      // Keep the loading frame visible even when an existing draft is reused.
      await Promise.resolve();
      let instance = instanceForChannel(channel);
      if (!instance) {
        const result = await invoke('messaging.feishu_draft.create', {
          feishuTenantBrand: channel.feishuTenantBrand,
          displayName: labelFor(`messaging.channel.${channel.key}.title`, channel.key === 'lark' ? 'Lark' : '飞书'),
        });
        instance = result && result.instance;
      }
      if (!instance || typeof instance.id !== 'string' || !instance.id) {
        throw new Error(labelFor('messaging.open_failed', ''));
      }
      if (state.operation !== operation) return;
      state.instances = state.instances.some((candidate) => candidate.id === instance.id)
        ? state.instances.map((candidate) => candidate.id === instance.id ? instance : candidate)
        : [...state.instances, instance];
      state.selectedId = instance.id;
      state.openingChannel = '';
      state.view = 'detail';
      renderCurrent();
    } catch (error) {
      if (state.operation !== operation) return;
      state.openingChannel = '';
      setNotice(errorMessage(error, labelFor('messaging.open_failed', '')), 'error');
      state.view = 'catalog';
      renderCurrent();
    }
  }

  async function loadInstances() {
    const result = await invoke('messaging.list');
    if (!result || !Array.isArray(result.instances)) throw new Error(result?.error || labelFor('messaging.load_failed', ''));
    state.instances = result.instances.filter((instance) => instance && typeof instance.id === 'string');
    if (state.selectedId && !state.instances.some((instance) => instance.id === state.selectedId)) {
      state.selectedId = '';
      state.view = 'catalog';
    }
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    try {
      await loadInstances();
      if (state.selectedId && !state.instances.some((instance) => instance.id === state.selectedId)) {
        state.selectedId = '';
        state.view = 'catalog';
      }
      state.notice = '';
      state.noticeKind = '';
    } catch (error) {
      setNotice(errorMessage(error, labelFor('messaging.load_failed', '')), 'error');
    } finally {
      state.loading = false;
      renderCurrent();
    }
  }

  function renderCurrent() {
    const root = rootNode();
    if (!root) return;
    root.replaceChildren();
    const instance = currentInstance();
    if (state.view === 'detail' && instance) root.appendChild(detailPage(instance));
    else {
      state.view = 'catalog';
      root.appendChild(renderCatalogPage());
    }
    hydrate(root);
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    window.addEventListener('i18n-change', () => {
      if (document.getElementById('panel-settings')?.classList.contains('is-active')) renderCurrent();
    });
  }

  window.initMessagingSettings = async function initMessagingSettings() {
    bind();
    if (!state.initialized) {
      state.initialized = true;
      state.view = 'catalog';
    }
    await refresh();
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      CHANNELS,
      normalizeFeishuQrStatus,
      channelForInstance,
      __test: { state, applyFeishuQrStatus, qrIsVisibleFor, qrPollDelay, resetQrState },
    };
  }
})();
