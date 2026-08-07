// Zcode-style two-step settings surface for the local Feishu/Lark gateway.
// Credentials stay in main; this module only sends metadata and renders state.
(function () {
  'use strict';

  const state = {
    view: 'panel',
    instances: [],
    selectedChannel: 'feishu',
    selectedInstanceId: '',
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
    wecom: {
      flowId: '',
      state: '',
      authUrl: '',
      popup: null,
      starting: false,
      cancelling: false,
      error: '',
      timer: null,
    },
  };

  // The messaging channel catalog is product content: `open` channels get a
  // live configuration panel, `soon` channels render disabled so the roadmap
  // stays visible without a false affordance.
  const CHANNELS = Object.freeze([
    { key: 'feishu', platform: 'feishu_lark', feishuTenantBrand: 'feishu', icon: 'feishu', group: 'open' },
    { key: 'lark', platform: 'feishu_lark', feishuTenantBrand: 'lark', icon: 'lark', group: 'open' },
    { key: 'wecom', platform: 'wecom', icon: 'wecom', group: 'open' },
    { key: 'telegram', platform: 'telegram', icon: 'telegram', group: 'open' },
    { key: 'wechat', platform: 'wechat_personal', icon: 'wechat', group: 'soon' },
    { key: 'qq', platform: 'qq', icon: 'qq', group: 'soon' },
    { key: 'dingtalk', platform: 'dingtalk', icon: 'dingtalk', group: 'soon' },
    { key: 'discord', platform: 'discord', icon: 'discord', group: 'soon' },
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
    if (!instance) return null;
    if (instance.platform === 'wecom' || instance.platform === 'telegram') return instance.platform;
    if (instance.platform === 'feishu_lark') return instance.feishuTenantBrand === 'lark' ? 'lark' : 'feishu';
    return null;
  }

  function currentInstance() {
    return state.instances.find((instance) => instance.id === state.selectedInstanceId) || null;
  }

  function instancesForChannel(channel) {
    if (!channel) return [];
    return state.instances
      .filter((instance) => channelForInstance(instance) === channel.key)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
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
      state.selectedInstanceId = instance.id;
    } else {
      await loadInstances();
    }
    resetQrState();
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
    return section;
  }

  function renderInstanceList(channel) {
    const section = el('section', 'messaging-config-card messaging-instance-card');
    const heading = el('div', 'messaging-config-card-heading');
    heading.appendChild(el('h3', '', labelFor('messaging.instance.title', '')));
    section.appendChild(heading);
    const instances = instancesForChannel(channel);
    if (!instances.length) {
      section.appendChild(el('p', 'messaging-instance-empty', labelFor('messaging.instance.empty', '')));
      return section;
    }
    const list = el('div', 'messaging-instance-list');
    for (const instance of instances) {
      const row = el('div', `messaging-instance-row is-${statusForInstance(instance)}`);
      const active = state.selectedInstanceId === instance.id;
      if (active) row.classList.add('is-selected');
      const copy = el('div', 'messaging-instance-copy');
      copy.appendChild(el('strong', '', instance.displayName || instance.id));
      copy.appendChild(el('span', 'messaging-instance-state', statusLabel(statusForInstance(instance))));
      row.appendChild(copy);
      row.appendChild(switchControl(instance));
      const unbind = el('button', 'btn messaging-secondary-button', labelFor('messaging.unbind', ''));
      unbind.type = 'button';
      unbind.disabled = state.updating;
      unbind.addEventListener('click', () => void unbindInstance(instance, unbind));
      row.appendChild(unbind);
      row.addEventListener('click', () => {
        state.selectedInstanceId = instance.id;
        renderCurrent();
      });
      list.appendChild(row);
    }
    section.appendChild(list);
    return section;
  }

  function renderFeishuPanel(channel) {
    const wrapper = el('div', 'messaging-panel-body');
    wrapper.appendChild(renderInstanceList(channel));
    const instances = instancesForChannel(channel);
    const instance = instances.find((item) => item.id === state.selectedInstanceId) || instances[0] || null;
    if (instance) {
      wrapper.appendChild(associationCard(instance));
      const responseSelect = selectControl([
        { value: 'text', label: labelFor('messaging.response_text', '') },
        { value: 'streaming_card', label: labelFor('messaging.response_streaming_card', '') },
      ], instance.responseMode || 'text', state.updating);
      responseSelect.addEventListener('change', () => {
        if (responseSelect.value !== (instance.responseMode || 'text')) {
          void updateInstance({ responseMode: responseSelect.value }, responseSelect);
        }
      });
      const workspaceSelect = selectControl([
        { value: 'all', label: labelFor('messaging.workspace_all', '') },
      ], 'all', state.updating);
      workspaceSelect.addEventListener('change', () => {
        void updateInstance({ workspace: { type: 'all' } }, workspaceSelect);
      });
      wrapper.appendChild(preferencesCard(responseSelect, workspaceSelect));
      const deletion = card('messaging.delete_title', 'messaging.delete_subtitle', 'messaging-delete-card');
      const deleteButton = el('button', 'btn btn-danger messaging-delete-button', labelFor('messaging.delete', ''));
      deleteButton.type = 'button';
      deleteButton.disabled = state.updating;
      deleteButton.addEventListener('click', () => void deleteInstance(instance, deleteButton));
      deletion.appendChild(deleteButton);
      wrapper.appendChild(deletion);
    } else {
      const empty = el('div', 'messaging-config-card messaging-empty-card');
      const scan = el('button', 'btn messaging-scan-button', labelFor('messaging.scan', ''));
      scan.type = 'button';
      scan.appendChild(icon('qr-code', 'messaging-action-icon'));
      scan.addEventListener('click', () => void startQrForChannel(channel));
      empty.appendChild(scan);
      wrapper.appendChild(empty);
      renderQrPanelForChannel(wrapper, channel);
    }
    return wrapper;
  }

  function renderQrPanelForChannel(cardRoot, channel) {
    const instance = instancesForChannel(channel)
      .find((candidate) => candidate.id === state.qr.instanceId) || null;
    if (!instance) return;
    renderQrPanel(instance, cardRoot);
  }

  async function startQrForChannel(channel) {
    if (!channel || state.openingChannel) return;
    const operation = ++state.operation;
    state.openingChannel = channel.key;
    setNotice('', '');
    renderCurrent();
    try {
      let instance = instancesForChannel(channel)[0] || null;
      if (!instance) {
        const result = await invoke('messaging.feishu_draft.create', {
          feishuTenantBrand: channel.feishuTenantBrand,
          displayName: labelFor(`messaging.channel.${channel.key}.title`, channel.key === 'lark' ? 'Lark' : '飞书'),
        });
        instance = result && result.instance;
      }
      if (!instance || typeof instance.id !== 'string' || !instance.id) throw new Error(labelFor('messaging.open_failed', ''));
      if (state.operation !== operation) return;
      state.instances = state.instances.some((candidate) => candidate.id === instance.id)
        ? state.instances.map((candidate) => candidate.id === instance.id ? instance : candidate)
        : [...state.instances, instance];
      state.selectedInstanceId = instance.id;
      state.openingChannel = '';
      renderCurrent();
      await startQr(instance);
    } catch (error) {
      if (state.operation !== operation) return;
      state.openingChannel = '';
      setNotice(errorMessage(error, labelFor('messaging.open_failed', '')), 'error');
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
    } catch (error) {
      if (control && previousValue !== undefined) control.value = previousValue;
      setNotice(errorMessage(error, labelFor('messaging.update_failed', '')), 'error');
    } finally {
      state.updating = false;
      renderCurrent();
    }
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
      state.selectedInstanceId = '';
      setNotice('', '');
    } catch (error) {
      setNotice(errorMessage(error, labelFor('messaging.delete_failed', '')), 'error');
    } finally {
      state.updating = false;
      renderCurrent();
    }
  }

  async function selectChannel(key) {
    const channel = channelForKey(key);
    if (!channel || channel.group !== 'open' || state.selectedChannel === key) return;
    cancelQr({ silent: true, render: false });
    // Task 8 追加: await cancelWecomFlow({ silent: true, render: false });
    state.selectedChannel = key;
    state.selectedInstanceId = '';
    setNotice('', '');
    renderCurrent();
  }

  function renderPanelPage() {
    const channel = channelForKey(state.selectedChannel) || channelForKey('feishu');
    const panel = el('section', `messaging-panel is-${channel.key}`);
    panel.appendChild(renderPanelHeader(channel));
    if (channel.platform === 'feishu_lark') {
      panel.appendChild(renderFeishuPanel(channel));
    }
    // Task 7 追加: else if (channel.platform === 'telegram') panel.appendChild(renderTelegramPanel(channel));
    // Task 8 追加: else if (channel.platform === 'wecom') panel.appendChild(renderWecomPanel(channel));
    appendNotice(panel);
    return panel;
  }

  function renderPanelHeader(channel) {
    const header = el('header', 'messaging-detail-header');
    const brand = el('div', `messaging-brand-icon is-${channel.key}`);
    brand.appendChild(icon(channel.icon, 'messaging-brand-glyph'));
    const titleWrap = el('div', 'messaging-detail-title-wrap');
    const titleRow = el('div', 'messaging-detail-title-row');
    titleRow.appendChild(el('h2', '', labelFor(`messaging.channel.${channel.key}.title`, channel.key)));
    if (channel.feishuTenantBrand) {
      titleRow.appendChild(el('span', 'messaging-channel-badge', labelFor(`messaging.channel.${channel.key}.badge`, '')));
    }
    titleWrap.appendChild(titleRow);
    const instances = instancesForChannel(channel);
    const instance = instances.find((item) => item.id === state.selectedInstanceId) || instances[0] || null;
    const status = instance ? statusForInstance(instance) : 'unbound';
    const stateRow = el('div', `messaging-detail-state is-${status}`);
    stateRow.append(icon(status === 'connected' ? 'check-circle' : 'clock', 'messaging-status-icon'));
    stateRow.appendChild(el('span', '', statusLabel(status)));
    titleWrap.appendChild(stateRow);
    header.append(brand, titleWrap, instance ? switchControl(instance) : el('span', 'messaging-detail-switch-placeholder', ''));
    return header;
  }

  async function loadInstances() {
    const result = await invoke('messaging.list');
    if (!result || !Array.isArray(result.instances)) throw new Error(result?.error || labelFor('messaging.load_failed', ''));
    state.instances = result.instances.filter((instance) => instance && typeof instance.id === 'string');
    if (state.selectedInstanceId && !state.instances.some((instance) => instance.id === state.selectedInstanceId)) {
      state.selectedInstanceId = '';
    }
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    try {
      await loadInstances();
      if (state.selectedInstanceId && !state.instances.some((instance) => instance.id === state.selectedInstanceId)) {
        state.selectedInstanceId = '';
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

  function renderLayoutPage() {
    const layout = el('div', 'messaging-layout');
    layout.append(renderMenuPage(), renderPanelPage());
    return layout;
  }

  function renderMenuPage() {
    const aside = el('aside', 'messaging-menu');
    aside.appendChild(el('h1', 'messaging-menu-title', labelFor('messaging.catalog.page_title', '')));
    for (const group of ['open', 'soon']) {
      const section = el('div', `messaging-menu-group is-${group}`);
      section.appendChild(el('div', 'messaging-menu-group-label', labelFor(
        group === 'open' ? 'messaging.group.open' : 'messaging.group.soon', '',
      )));
      for (const channel of CHANNELS.filter((item) => item.group === group)) {
        const active = state.selectedChannel === channel.key;
        const bound = instancesForChannel(channel).length > 0;
        const row = el('button', `messaging-menu-item is-${channel.key}${active ? ' is-active' : ''}${group === 'soon' ? ' is-disabled' : ''}`);
        row.type = 'button';
        row.disabled = group === 'soon';
        row.dataset.channel = channel.key;
        row.setAttribute('aria-disabled', String(group === 'soon'));
        const visual = el('span', 'messaging-menu-item-icon');
        visual.appendChild(icon(channel.icon, 'messaging-menu-item-glyph'));
        row.appendChild(visual);
        row.appendChild(el('span', 'messaging-menu-item-name', labelFor(`messaging.channel.${channel.key}.title`, channel.key)));
        if (group === 'open') {
          const status = el('span', `messaging-menu-item-status is-${bound ? 'bound' : 'empty'}`);
          status.appendChild(el('span', '', labelFor(
            bound ? 'messaging.status.bound' : 'messaging.status.unbound', '',
          )));
          row.appendChild(status);
        }
        if (group === 'open' && !row.disabled) row.addEventListener('click', () => selectChannel(channel.key));
        section.appendChild(row);
      }
      aside.appendChild(section);
    }
    return aside;
  }

  function renderCurrent() {
    const root = rootNode();
    if (!root) return;
    root.replaceChildren();
    root.appendChild(renderLayoutPage());
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
    }
    await refresh();
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      CHANNELS,
      normalizeFeishuQrStatus,
      channelForInstance,
      __test: { state, applyFeishuQrStatus, qrIsVisibleFor, qrPollDelay, resetQrState, instancesForChannel },
    };
  }
})();
