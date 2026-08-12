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
    telegramCreatingNew: false,
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
    // 扫码绑定成功后的回调地址引导卡（一次性配置，飞书平台不允许程序化
    // 修改重定向 URL，只能引导用户在开发者后台手动完成）。
    setupGuide: null,
    setupGuideDismissed: false,
    wecom: {
      flowId: '',
      state: '',
      authUrl: '',
      popup: null,
      starting: false,
      cancelling: false,
      revision: 0,
      timer: null,
      // 连续轮询网络错误计数：超过阈值即停止轮询并报错，
      // 而不是弹窗关闭后仍无限重试（旧行为）。
      pollErrorCount: 0,
    },
    wechat: {
      flowId: '',
      state: '',
      qrSource: '',
      error: '',
      errorCode: '',
      starting: false,
      cancelling: false,
      revision: 0,
      timer: null,
      pollErrorCount: 0,
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
    { key: 'wechat', platform: 'wechat_personal', icon: 'wechat', group: 'open' },
    { key: 'qq', platform: 'qq', icon: 'qq', group: 'soon' },
    { key: 'dingtalk', platform: 'dingtalk', icon: 'dingtalk', group: 'soon' },
    { key: 'discord', platform: 'discord', icon: 'discord', group: 'soon' },
  ]);

  // 轮询连续网络错误上限：超过后停止轮询并提示，避免弹窗已关闭还无限重试。
  const MAX_POLL_ERRORS = 5;

  const QR_TERMINAL_STATES = new Set(['completed', 'cancelled', 'expired', 'denied', 'failed']);
  const WECHAT_TERMINAL_STATES = new Set(['completed', 'cancelled', 'expired', 'blocked', 'failed']);
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

  /** Plain-language hints per main-process registration error code. */
  const FEISHU_QR_ERROR_HINTS = Object.freeze({
    network_error: 'messaging.feishu_qr.error_network_error',
    network_unreachable: 'messaging.feishu_qr.error_network_unreachable',
    network_timeout: 'messaging.feishu_qr.error_network_timeout',
    network_tls: 'messaging.feishu_qr.error_network_tls',
    registration_failed: 'messaging.feishu_qr.error_registration_failed',
    invalid_response: 'messaging.feishu_qr.error_invalid_response',
    activation_failed: 'messaging.feishu_qr.error_activation_failed',
  });

  function invoke(channel, payload) {
    if (!window.cogseed || typeof window.cogseed.invoke !== 'function') {
      return Promise.reject(new Error('IPC unavailable'));
    }
    return window.cogseed.invoke(channel, payload || {});
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

  if (window.cogseed && typeof window.cogseed.onPushEvent === 'function') {
    try {
      window.cogseed.onPushEvent('messaging:send-confirm', (info) => {
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
    if (!instance) return null;
    if (instance.platform === 'wechat_personal') return 'wechat';
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
      ...(typeof value.errorCode === 'string' && value.errorCode.trim() ? { errorCode: value.errorCode.trim() } : {}),
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
    if (next.errorCode) {
      // Map the main-process error code to a plain-language hint so a network
      // hiccup is not mistaken for a product failure.
      const hintKey = FEISHU_QR_ERROR_HINTS[next.errorCode];
      state.qr.error = hintKey
        ? labelFor(hintKey, qrStateLabel('failed'))
        : next.error || '';
    } else if (next.error) {
      state.qr.error = next.error;
    }
    return next;
  }

  function qrStateLabel(statusState) {
    return labelFor(QR_STATE_KEYS[statusState] || QR_STATE_KEYS.starting, statusState || 'starting');
  }

  function wecomStatusLabel(statusState, errorCode) {
    return labelFor(`messaging.wecom_qr.status_${statusState}`, errorCode || statusState);
  }

  function wechatStatusLabel(statusState, errorCode) {
    return labelFor(`messaging.wechat_qr.status_${statusState}`, errorCode || statusState);
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

  function renderQrCode(host, url, labelPrefix) {
    const prefix = labelPrefix || 'messaging.feishu_qr';
    host.replaceChildren();
    if (!url) {
      host.appendChild(el('span', 'messaging-qr-pending', labelFor(`${prefix}.qr_pending`, '')));
      return;
    }
    if (typeof qrcode !== 'function') {
      host.appendChild(el('span', 'messaging-qr-pending', labelFor(`${prefix}.qr_unavailable`, '')));
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
        svg.setAttribute('aria-label', labelFor(`${prefix}.qr_alt`, ''));
      }
    } catch (error) {
      host.appendChild(el('span', 'messaging-qr-pending', errorMessage(error, labelFor(`${prefix}.qr_unavailable`, ''))));
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
    // 绑定成功 → 拉起回调地址引导卡（一次性）：飞书要求重定向 URL 与
    // 开发者后台精确一致，不配置则授权时必报 20029。扫码后直接引导，
    // 用户只需复制 → 打开后台 → 粘贴 → 添加 → 发布。
    const bound = instance && typeof instance.id === 'string' ? instance.id : state.selectedInstanceId;
    void loadSetupGuide(bound, instance && instance.feishuTenantBrand);
  }

  async function loadSetupGuide(instanceId, brand) {
    if (!instanceId) return;
    try {
      const result = await invoke('personal_context.setup_guide', { instanceId });
      const guide = result && result.guide;
      if (!guide || !guide.credentialReady || !guide.appId || !guide.redirectUri) return;
      state.setupGuide = {
        appId: guide.appId,
        redirectUri: guide.redirectUri,
        brand: brand === 'lark' ? 'lark' : 'feishu',
      };
      state.setupGuideDismissed = false;
      renderCurrent();
    } catch (_error) {
      // 引导卡是尽力而为：主进程不可用时不影响绑定成功状态
    }
  }

  function renderSetupGuideCard() {
    if (!state.setupGuide || state.setupGuideDismissed) return null;
    const guide = state.setupGuide;
    const consoleUrl = guide.brand === 'lark'
      ? `https://open.larksuite.com/app/${guide.appId}/safe`
      : `https://open.feishu.cn/app/${guide.appId}/safe`;
    const section = el('section', 'messaging-config-card messaging-setup-guide-card');
    const heading = el('div', 'messaging-config-card-heading');
    heading.appendChild(el('h3', '', labelFor('messaging.setup_guide.title', '')));
    heading.appendChild(el('p', '', labelFor('messaging.setup_guide.desc', '')));
    section.appendChild(heading);

    const urlRow = el('div', 'messaging-setup-guide-url');
    const url = el('code', '', guide.redirectUri);
    urlRow.appendChild(url);
    const copy = el('button', 'btn messaging-secondary-button', labelFor('messaging.setup_guide.copy', ''));
    copy.type = 'button';
    copy.appendChild(icon('copy', 'messaging-action-icon'));
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(guide.redirectUri).then(() => {
        copy.textContent = labelFor('messaging.setup_guide.copied', '');
        setTimeout(() => {
          copy.textContent = labelFor('messaging.setup_guide.copy', '');
        }, 1800);
      }).catch(() => { /* clipboard unavailable; user can select the url manually */ });
    });
    urlRow.appendChild(copy);
    section.appendChild(urlRow);

    section.appendChild(el('p', 'messaging-setup-guide-steps', labelFor('messaging.setup_guide.steps', '')));

    const actions = el('div', 'messaging-setup-guide-actions');
    const open = el('button', 'btn messaging-scan-button', labelFor('messaging.setup_guide.open_console', ''));
    open.type = 'button';
    open.appendChild(icon('external-link', 'messaging-action-icon'));
    open.addEventListener('click', () => {
      void invoke('auth.openExternal', { url: consoleUrl }).catch(() => {
        setNotice(labelFor('messaging.setup_guide.open_failed', ''), 'error');
        renderCurrent();
      });
    });
    const done = el('button', 'btn messaging-secondary-button', labelFor('messaging.setup_guide.done', ''));
    done.type = 'button';
    done.addEventListener('click', () => {
      // 用户确认已配置：记录本机标记，触点页授权时不再拦截
      void invoke('personal_context.setup_guide.confirm', {}).catch(() => { /* best effort */ });
      state.setupGuideDismissed = true;
      renderCurrent();
    });
    actions.append(open, done);
    section.appendChild(actions);
    return section;
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

  function switchActionForInstance(instance) {
    if (instance && instance.hasCredentials === true) return 'toggle';
    if (instance && instance.platform === 'feishu_lark') return 'bind';
    return 'unavailable';
  }

  function switchControl(instance) {
    const action = switchActionForInstance(instance);
    const label = el('label', 'messaging-switch');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = instance.enabled === true;
    input.disabled = state.updating || action === 'unavailable' || (action === 'bind' && qrIsPending());
    input.setAttribute('aria-label', labelFor(action === 'bind' ? 'messaging.scan' : 'messaging.enabled', ''));
    input.addEventListener('change', () => {
      if (action === 'bind') {
        // An unbound Feishu/Lark draft cannot be enabled yet. Treat the switch
        // as the missing association affordance: start QR binding and keep the
        // persisted enabled state off until activation succeeds atomically.
        input.checked = false;
        void startQr(instance);
        return;
      }
      const enabled = input.checked;
      void updateInstance({ enabled }, input);
    });
    const track = el('span', 'messaging-switch-track');
    track.setAttribute('aria-hidden', 'true');
    track.addEventListener('click', (event) => {
      if (action !== 'bind' || input.disabled) return;
      // The visual track is the actual hit target; invoke the binding flow
      // explicitly instead of relying on implicit label activation for the
      // hidden checkbox, which is not reliable in Electron accessibility/UI
      // automation and custom chrome combinations.
      event.preventDefault();
      input.checked = false;
      void startQr(instance);
    });
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
    if (instance.feishuTenantBrand === 'lark') {
      info.appendChild(el('p', 'messaging-qr-lark-hint', labelFor('messaging.feishu_qr.lark_sign_in_hint', '')));
    }
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
    copy.appendChild(el('p', '', labelFor(
      instance.hasCredentials ? 'messaging.connection_bound_sub' : 'messaging.association_sub', '',
    )));
    row.appendChild(copy);
    if (instance.hasCredentials) {
      // Already bound: scanning would try to overwrite the configured
      // credentials, which main refuses. Show the state instead.
      row.appendChild(el('span', 'messaging-association-bound', labelFor('messaging.connection_bound', '')));
      section.appendChild(row);
      renderQrPanel(instance, section);
      return section;
    }
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
        state.telegramCreatingNew = false;
        renderCurrent();
      });
      list.appendChild(row);
    }
    if (channel.group === 'open' && channel.platform !== 'wecom') {
      const add = el('button', 'btn messaging-secondary-button messaging-instance-add', labelFor('messaging.instance.add', ''));
      add.type = 'button';
      add.disabled = state.updating || qrIsPending();
      add.appendChild(icon('plus', 'messaging-action-icon'));
      add.addEventListener('click', () => {
        if (channel.platform === 'telegram') {
          state.telegramCreatingNew = true;
          state.selectedInstanceId = '';
          renderCurrent();
        } else if (channel.platform === 'wechat_personal') {
          void startWechatFlow();
        } else {
          void startQrForChannel(channel);
        }
      });
      list.appendChild(add);
    }
    section.appendChild(list);
    return section;
  }

  function renderFeishuPanel(channel) {
    const wrapper = el('div', 'messaging-panel-body');
    wrapper.appendChild(renderInstanceList(channel));
    // 扫码绑定成功后弹出的回调地址引导卡（一次性）：位于实例列表下方，
    // 绑定新的飞书机器人时自动出现，配置完成后可关闭。
    const guideCard = renderSetupGuideCard();
    if (guideCard) wrapper.appendChild(guideCard);
    const instances = instancesForChannel(channel);
    const instance = instances.find((item) => item.id === state.selectedInstanceId) || instances[0] || null;
    if (instance) {
      wrapper.appendChild(associationCard(instance));
      wrapper.appendChild(ownerIdentityCard(instance));
      const responseSelect = selectControl([
        { value: 'text', label: labelFor('messaging.response_text', '') },
        { value: 'streaming_card', label: labelFor('messaging.response_streaming_card', '') },
      ], instance.responseMode || 'text', state.updating);
      responseSelect.setAttribute('aria-label', labelFor('messaging.response_title', ''));
      responseSelect.addEventListener('change', () => {
        if (responseSelect.value !== (instance.responseMode || 'text')) {
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
      wrapper.appendChild(preferencesCard(responseSelect, workspaceSelect));
      const deletion = card('messaging.delete_title', 'messaging.delete_subtitle', 'messaging-delete-card');
      const deleteButton = el('button', 'btn btn-danger messaging-delete-button', labelFor('messaging.delete', ''));
      deleteButton.type = 'button';
      deleteButton.disabled = state.updating;
      deleteButton.appendChild(icon('trash', 'messaging-action-icon'));
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
    // QR 流程进行中（含轮询）时忽略重复触发，避免连点"连接"反复创建新实例
    if (!channel || state.openingChannel || qrIsPending()) return;
    const operation = ++state.operation;
    state.openingChannel = channel.key;
    setNotice('', '');
    renderCurrent();
    try {
      // Always mint a fresh draft: the "add binding" path must create a new
      // instance instead of re-running QR against an already-bound bot (main
      // refuses to overwrite existing credentials).
      const result = await invoke('messaging.feishu_draft.create', {
        feishuTenantBrand: channel.feishuTenantBrand,
        displayName: labelFor(`messaging.channel.${channel.key}.title`, channel.key === 'lark' ? 'Lark' : '飞书'),
      });
      const instance = result && result.instance;
      if (!instance || typeof instance.id !== 'string' || !instance.id) throw new Error(labelFor('messaging.open_failed', ''));
      if (state.operation !== operation) return;
      state.instances = state.instances.some((candidate) => candidate.id === instance.id)
        ? state.instances.map((candidate) => candidate.id === instance.id ? instance : candidate)
        : [...state.instances, instance];
      state.selectedInstanceId = instance.id;
      state.openingChannel = '';
      renderCurrent();
      // No-owner Feishu bot: QR 面板内有常驻的 owner 绑定引导区
      // （messaging-owner-guide），不再弹全屏提示窗——弹窗遮罩会拦截页面
      // 点击，打断"点按钮→扫码→完事"流程（触点页曾因此表现为"卡死"）。
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

  function validateBotToken(token) {
    return typeof token === 'string' && /^\d+:[A-Za-z0-9_-]{20,}$/.test(token.trim());
  }

  async function saveTelegramToken(instance, tokenInput, button) {
    if (button.disabled) return;
    const token = String(tokenInput.value || '').trim();
    if (!validateBotToken(token)) {
      setNotice(labelFor('messaging.telegram.token_invalid', ''), 'error');
      tokenInput.focus();
      return;
    }
    button.disabled = true;
    state.updating = true;
    setNotice('', '');
    try {
      if (!instance) {
        const created = await invoke('messaging.create', {
          platform: 'telegram',
          displayName: 'Telegram',
          secret: { botToken: token },
        });
        if (!created || !created.instance || typeof created.instance.id !== 'string') {
          throw new Error(created?.error || labelFor('messaging.update_failed', ''));
        }
        let enabled;
        try {
          enabled = await invoke('messaging.set_enabled', { instanceId: created.instance.id, enabled: true });
        } catch (error) {
          try { await invoke('messaging.delete', { instanceId: created.instance.id }); } catch (_) { /* rollback best effort */ }
          throw new Error(labelFor('messaging.telegram.enable_failed', ''));
        }
        state.instances = [...state.instances, enabled.instance || created.instance];
        state.selectedInstanceId = (enabled.instance && enabled.instance.id) || created.instance.id;
        state.telegramCreatingNew = false;
        setNotice(labelFor('messaging.link_success', ''), 'success');
      } else {
        const result = await invoke('messaging.update', {
          instanceId: instance.id,
          secret: { botToken: token },
          enabled: true,
        });
        if (!result || !result.instance || typeof result.instance.id !== 'string') {
          throw new Error(result?.error || labelFor('messaging.update_failed', ''));
        }
        state.instances = state.instances.map((candidate) => candidate.id === result.instance.id ? result.instance : candidate);
        setNotice(labelFor('messaging.updated', ''), 'success');
      }
    } catch (error) {
      setNotice(errorMessage(error, labelFor('messaging.update_failed', '')), 'error');
    } finally {
      state.updating = false;
      renderCurrent();
    }
  }

  function renderTelegramPanel(channel) {
    const wrapper = el('div', 'messaging-panel-body');
    wrapper.appendChild(renderInstanceList(channel));
    const instances = instancesForChannel(channel);
    const instance = state.telegramCreatingNew
      ? null
      : instances.find((item) => item.id === state.selectedInstanceId) || instances[0] || null;
    const config = card('messaging.telegram.token_label', '', 'messaging-telegram-card');
    const tokenInput = document.createElement('input');
    tokenInput.type = 'password';
    tokenInput.className = 'form-input';
    tokenInput.placeholder = labelFor('messaging.telegram.token_placeholder', '');
    tokenInput.autocomplete = 'off';
    tokenInput.spellcheck = false;
    tokenInput.setAttribute('aria-label', labelFor('messaging.telegram.token_label', ''));
    const save = el('button', 'btn messaging-scan-button', labelFor(
      instance ? 'messaging.telegram.reconnect' : 'messaging.telegram.connect', '',
    ));
    save.type = 'button';
    save.disabled = state.updating;
    save.appendChild(icon('send', 'messaging-action-icon'));
    save.addEventListener('click', () => void saveTelegramToken(instance, tokenInput, save));
    const rows = el('div', 'messaging-manual-fields');
    rows.append(tokenInput, save);
    config.appendChild(rows);
    wrapper.appendChild(config);
    if (instance) {
      const deletion = card('messaging.delete_title', 'messaging.delete_subtitle', 'messaging-delete-card');
      const deleteButton = el('button', 'btn btn-danger messaging-delete-button', labelFor('messaging.delete', ''));
      deleteButton.type = 'button';
      deleteButton.disabled = state.updating;
      deleteButton.appendChild(icon('trash', 'messaging-action-icon'));
      deleteButton.addEventListener('click', () => void deleteInstance(instance, deleteButton));
      deletion.appendChild(deleteButton);
      wrapper.appendChild(deletion);
    }
    return wrapper;
  }

  const WECOM_AUTH_ORIGIN = 'https://work.weixin.qq.com';

  function parseWecomAuthMessage(event, popup) {
    const data = event && typeof event.data === 'object' ? event.data : {};
    const wecomBotId = typeof data.wecomBotId === 'string' ? data.wecomBotId.trim() : '';
    const wecomBotSecret = typeof data.wecomBotSecret === 'string' ? data.wecomBotSecret.trim() : '';
    if (!event || event.origin !== WECOM_AUTH_ORIGIN) return { ok: false, reason: 'origin' };
    if (!popup || event.source !== popup) return { ok: false, reason: 'source' };
    if (data.type !== 'AUTH_SUCCESS' || !wecomBotId || !wecomBotSecret) return { ok: false, reason: 'shape' };
    return { ok: true, wecomBotId, wecomBotSecret };
  }

  function closeWecomPopup() {
    const popup = state.wecom.popup;
    if (popup && typeof popup.close === 'function') {
      try { popup.close(); } catch (_) { /* already closed */ }
    }
    state.wecom.popup = null;
  }

  async function cancelWecomFlow(options) {
    const opts = options || {};
    const flowId = state.wecom.flowId;
    if (state.wecom.timer !== null) {
      clearTimeout(state.wecom.timer);
      state.wecom.timer = null;
    }
    closeWecomPopup();
    if (typeof window.removeEventListener === 'function') {
      window.removeEventListener('message', handleWecomAuthMessage);
    }
    const revision = ++state.wecom.revision;
    state.wecom.cancelling = true;
    try {
      if (flowId && state.wecom.state !== 'completed' && state.wecom.state !== 'cancelled') {
        try { await invoke('messaging.wecom_qr.cancel', { flowId }); } catch (_) { /* best effort */ }
      }
    } finally {
      if (state.wecom.revision === revision) {
        state.wecom.flowId = '';
        state.wecom.state = '';
        state.wecom.authUrl = '';
        state.wecom.starting = false;
        state.wecom.cancelling = false;
        state.wecom.pollErrorCount = 0;
        if (opts.render !== false) renderCurrent();
      }
    }
  }

  function handleWecomAuthMessage(event) {
    if (!state.wecom.flowId) return;
    const parsed = parseWecomAuthMessage(event, state.wecom.popup);
    if (!parsed.ok) {
      if (parsed.reason === 'origin' || parsed.reason === 'source') return;
      setNotice(labelFor('messaging.wecom_qr.invalid_message', ''), 'error');
      return;
    }
    void completeWecomFlow(parsed.wecomBotId, parsed.wecomBotSecret);
  }

  function scheduleWecomPoll(flowId) {
    if (state.wecom.timer !== null) clearTimeout(state.wecom.timer);
    if (!flowId || state.wecom.flowId !== flowId || state.wecom.state === 'completed') return;
    state.wecom.timer = setTimeout(() => {
      state.wecom.timer = null;
      void pollWecomStatus(flowId);
    }, 5000);
  }

  async function pollWecomStatus(flowId) {
    if (!flowId || state.wecom.flowId !== flowId || state.wecom.cancelling) return;
    const revision = state.wecom.revision;
    try {
      const result = await invoke('messaging.wecom_qr.status', { flowId });
      if (state.wecom.revision !== revision) return;
      state.wecom.pollErrorCount = 0;
      const registration = result && result.registration ? result.registration : result;
      const nextState = typeof registration.state === 'string' ? registration.state : 'failed';
      if (nextState === 'completed' && registration.instance && registration.instance.id) {
        state.wecom.state = 'completed';
        state.instances = state.instances.some((candidate) => candidate.id === registration.instance.id)
          ? state.instances.map((candidate) => candidate.id === registration.instance.id ? registration.instance : candidate)
          : [...state.instances, registration.instance];
        state.selectedInstanceId = registration.instance.id;
        setNotice(labelFor('messaging.wecom_qr.completed', ''), 'success');
        await cancelWecomFlow({ silent: true, render: false });
        renderCurrent();
        return;
      }
      if (nextState === 'expired' || nextState === 'cancelled' || nextState === 'failed') {
        setNotice(wecomStatusLabel(nextState, registration.errorCode), 'error');
        await cancelWecomFlow({ silent: true, render: false });
        renderCurrent();
        return;
      }
      scheduleWecomPoll(flowId);
    } catch (error) {
      if (state.wecom.revision !== revision) return;
      state.wecom.pollErrorCount += 1;
      // 连续网络错误超过阈值才放弃：偶发抖动不应打断绑定流程，
      // 但弹窗已关闭/网络长期不可用时也不能无限轮询下去。
      if (state.wecom.pollErrorCount >= MAX_POLL_ERRORS) {
        setNotice(errorMessage(error, labelFor('messaging.wecom_qr.invalid_message', '')), 'error');
        await cancelWecomFlow({ silent: true, render: false });
        renderCurrent();
        return;
      }
      scheduleWecomPoll(flowId);
    }
  }

  async function completeWecomFlow(wecomBotId, wecomBotSecret) {
    if (!state.wecom.flowId || state.wecom.state === 'completed' || state.wecom.state === 'activating' || state.wecom.cancelling) return;
    const flowId = state.wecom.flowId;
    const revision = state.wecom.revision;
    state.wecom.state = 'activating';
    try {
      const result = await invoke('messaging.wecom_qr.complete', { flowId, wecomBotId, wecomBotSecret });
      if (state.wecom.revision !== revision) return;
      const registration = result && result.registration ? result.registration : result;
      if (registration.state === 'completed' && registration.instance && registration.instance.id) {
        state.instances = state.instances.some((candidate) => candidate.id === registration.instance.id)
          ? state.instances.map((candidate) => candidate.id === registration.instance.id ? registration.instance : candidate)
          : [...state.instances, registration.instance];
        state.selectedInstanceId = registration.instance.id;
        state.wecom.state = 'completed';
        setNotice(labelFor('messaging.wecom_qr.completed', ''), 'success');
        await cancelWecomFlow({ silent: true, render: false });
        renderCurrent();
        return;
      }
      if (registration.state === 'failed' || registration.state === 'expired' || registration.state === 'denied') {
        setNotice(wecomStatusLabel(registration.state, registration.errorCode), 'error');
        await cancelWecomFlow({ silent: true, render: false });
        renderCurrent();
      }
    } catch (error) {
      if (state.wecom.revision !== revision) return;
      setNotice(errorMessage(error, labelFor('messaging.wecom_qr.invalid_message', '')), 'error');
    }
  }

  async function startWecomFlow() {
    if (state.wecom.starting || state.wecom.cancelling) return;
    state.wecom.starting = true;
    setNotice('', '');
    renderCurrent();
    try {
      const result = await invoke('messaging.wecom_qr.start', {
        displayName: labelFor('messaging.channel.wecom.title', '企业微信'),
      });
      const registration = result && result.registration ? result.registration : result;
      const flowId = typeof registration.flowId === 'string' ? registration.flowId.trim() : '';
      const authUrl = typeof registration.authUrl === 'string' ? registration.authUrl.trim() : '';
      if (!flowId || !authUrl) throw new Error(registration.error || labelFor('messaging.wecom_qr.invalid_message', ''));
      state.wecom.flowId = flowId;
      state.wecom.authUrl = authUrl;
      state.wecom.state = registration.state || 'awaiting_scan';
      state.wecom.starting = false;
      const popup = window.open(authUrl, 'wecom_auth', 'width=720,height=640,popup=yes');
      if (!popup) {
        setNotice(labelFor('messaging.wecom_qr.popup_blocked', ''), 'error');
        await cancelWecomFlow({ silent: true, render: false });
        renderCurrent();
        return;
      }
      state.wecom.popup = popup;
      if (typeof window.addEventListener === 'function') {
        window.addEventListener('message', handleWecomAuthMessage);
      }
      setNotice(labelFor('messaging.wecom_qr.open_hint', ''), 'info');
      scheduleWecomPoll(flowId);
      renderCurrent();
    } catch (error) {
      state.wecom.starting = false;
      setNotice(errorMessage(error, labelFor('messaging.wecom_qr.invalid_message', '')), 'error');
      renderCurrent();
    }
  }

  function wechatFlowActive() {
    return Boolean(state.wechat.flowId && !WECHAT_TERMINAL_STATES.has(state.wechat.state));
  }

  function resetWechatFlow() {
    if (state.wechat.timer !== null) {
      clearTimeout(state.wechat.timer);
      state.wechat.timer = null;
    }
    state.wechat.revision += 1;
    state.wechat.flowId = '';
    state.wechat.state = '';
    state.wechat.qrSource = '';
    state.wechat.error = '';
    state.wechat.errorCode = '';
    state.wechat.starting = false;
    state.wechat.cancelling = false;
    state.wechat.pollErrorCount = 0;
  }

  async function cancelWechatFlow(options) {
    const opts = options || {};
    const flowId = state.wechat.flowId;
    if (state.wechat.timer !== null) {
      clearTimeout(state.wechat.timer);
      state.wechat.timer = null;
    }
    const revision = ++state.wechat.revision;
    state.wechat.cancelling = true;
    if (opts.render !== false) renderCurrent();
    try {
      if (flowId && state.wechat.state !== 'completed' && state.wechat.state !== 'cancelled') {
        try { await invoke('messaging.wechat_qr.cancel', { flowId }); } catch (_) { /* best effort */ }
      }
    } finally {
      if (state.wechat.revision === revision) {
        resetWechatFlow();
        if (opts.render !== false) renderCurrent();
      }
    }
  }

  function scheduleWechatPoll(flowId) {
    if (state.wechat.timer !== null) clearTimeout(state.wechat.timer);
    if (!flowId || state.wechat.flowId !== flowId || WECHAT_TERMINAL_STATES.has(state.wechat.state)) return;
    state.wechat.timer = setTimeout(() => {
      state.wechat.timer = null;
      void pollWechatStatus(flowId);
    }, state.wechat.state === 'starting' ? 750 : 1500);
  }

  async function completeWechatFlow(registration, flowId, revision) {
    if (state.wechat.revision !== revision || state.wechat.flowId !== flowId) return;
    try {
      await loadInstances();
    } catch (error) {
      if (state.wechat.revision !== revision) return;
      setNotice(errorMessage(error, labelFor('messaging.load_failed', '')), 'error');
      resetWechatFlow();
      renderCurrent();
      return;
    }
    if (state.wechat.revision !== revision) return;
    if (typeof registration.instanceId === 'string' && registration.instanceId) {
      state.selectedInstanceId = registration.instanceId;
    }
    setNotice(labelFor('messaging.wechat_qr.completed', ''), 'success');
    resetWechatFlow();
    renderCurrent();
  }

  async function pollWechatStatus(flowId) {
    if (!flowId || state.wechat.flowId !== flowId || state.wechat.cancelling) return;
    const revision = state.wechat.revision;
    try {
      const result = await invoke('messaging.wechat_qr.status', { flowId });
      if (state.wechat.revision !== revision) return;
      const registration = unwrapRegistrationResult(result);
      const nextState = typeof registration.state === 'string' ? registration.state : 'failed';
      if (nextState === 'completed') {
        await completeWechatFlow(registration, flowId, revision);
        return;
      }
      if (WECHAT_TERMINAL_STATES.has(nextState)) {
        setNotice(wechatStatusLabel(nextState, registration.errorCode), 'error');
        await cancelWechatFlow({ silent: true, render: false });
        renderCurrent();
        return;
      }
      state.wechat.state = nextState;
      state.wechat.errorCode = typeof registration.errorCode === 'string' ? registration.errorCode : '';
      if (typeof registration.qrUrl === 'string' && registration.qrUrl.trim()) {
        state.wechat.qrSource = registration.qrUrl.trim();
      } else if (typeof registration.qrCode === 'string' && registration.qrCode.trim()) {
        state.wechat.qrSource = registration.qrCode.trim();
      }
      renderCurrent();
      scheduleWechatPoll(flowId);
    } catch (error) {
      if (state.wechat.revision !== revision) return;
      state.wechat.pollErrorCount += 1;
      // 连续网络错误超过阈值才放弃：偶发抖动不打断绑定流程，
      // 但长期不可用时也不能无限轮询。
      if (state.wechat.pollErrorCount >= MAX_POLL_ERRORS) {
        state.wechat.error = errorMessage(error, labelFor('messaging.wechat_qr.start_failed', ''));
        setNotice(state.wechat.error, 'error');
        await cancelWechatFlow({ silent: true, render: false });
        renderCurrent();
        return;
      }
      scheduleWechatPoll(flowId);
    }
  }

  async function startWechatFlow() {
    if (state.wechat.starting || state.wechat.cancelling || wechatFlowActive()) return;
    resetWechatFlow();
    const revision = state.wechat.revision;
    state.wechat.starting = true;
    state.wechat.state = 'starting';
    setNotice('', '');
    renderCurrent();
    try {
      const result = await invoke('messaging.wechat_qr.start', {});
      const registration = unwrapRegistrationResult(result);
      const flowId = typeof registration.flowId === 'string' ? registration.flowId.trim() : '';
      if (!flowId) throw new Error(registration.error || result?.error || labelFor('messaging.wechat_qr.start_failed', ''));
      if (state.wechat.revision !== revision) {
        try { await invoke('messaging.wechat_qr.cancel', { flowId }); } catch (_) { /* stale flow */ }
        return;
      }
      state.wechat.flowId = flowId;
      state.wechat.state = typeof registration.state === 'string' ? registration.state : 'awaiting_scan';
      state.wechat.starting = false;
      state.wechat.errorCode = typeof registration.errorCode === 'string' ? registration.errorCode : '';
      if (typeof registration.qrUrl === 'string' && registration.qrUrl.trim()) {
        state.wechat.qrSource = registration.qrUrl.trim();
      } else if (typeof registration.qrCode === 'string' && registration.qrCode.trim()) {
        state.wechat.qrSource = registration.qrCode.trim();
      }
      if (!state.wechat.qrSource && !WECHAT_TERMINAL_STATES.has(state.wechat.state)) {
        // 启动成功但响应里既没有 qrUrl 也没有 qrCode（如二维码响应字段
        // 缺失或被白名单拒绝）→ 按启动失败渲染，绝不展示空二维码区域；
        // 服务端 flow 一并静默取消。
        try { await invoke('messaging.wechat_qr.cancel', { flowId }); } catch (_) { /* best effort */ }
        state.wechat.state = 'failed';
        state.wechat.error = labelFor('messaging.wechat_qr.start_failed', '');
        setNotice(state.wechat.error, 'error');
        renderCurrent();
        return;
      }
      renderCurrent();
      if (state.wechat.state === 'completed') {
        await completeWechatFlow(registration, flowId, revision);
      } else if (WECHAT_TERMINAL_STATES.has(state.wechat.state)) {
        setNotice(wechatStatusLabel(state.wechat.state, state.wechat.errorCode), 'error');
        await cancelWechatFlow({ silent: true, render: false });
        renderCurrent();
      } else {
        scheduleWechatPoll(flowId);
      }
    } catch (error) {
      if (state.wechat.revision !== revision) return;
      state.wechat.starting = false;
      state.wechat.state = 'failed';
      state.wechat.error = errorMessage(error, labelFor('messaging.wechat_qr.start_failed', ''));
      setNotice(state.wechat.error, 'error');
      renderCurrent();
    }
  }

  function renderWechatQrPanel(cardRoot) {
    if (!state.wechat.starting && !state.wechat.flowId) return;
    const panel = el('div', 'messaging-qr-panel');
    const host = el('div', 'messaging-qr-code');
    host.setAttribute('aria-live', 'polite');
    const status = state.wechat.error && WECHAT_TERMINAL_STATES.has(state.wechat.state)
      ? state.wechat.error
      : wechatStatusLabel(state.wechat.state || 'starting', state.wechat.errorCode);
    if (state.wechat.error && WECHAT_TERMINAL_STATES.has(state.wechat.state)) {
      // 终态错误（如启动后无二维码来源）：在二维码区域渲染错误文案，
      // 而不是空二维码占位
      host.appendChild(el('span', 'messaging-qr-pending', status));
    } else {
      renderQrCode(host, state.wechat.qrSource, 'messaging.wechat_qr');
    }
    const info = el('div', 'messaging-qr-info');
    const statusRow = el('div', `messaging-qr-status is-${state.wechat.state || 'starting'}`);
    statusRow.append(icon('loader', 'messaging-qr-status-icon'), el('span', '', status));
    info.appendChild(statusRow);
    panel.append(host, info);
    cardRoot.appendChild(panel);
  }

  function wechatAssociationCard() {
    const section = el('section', 'messaging-config-card messaging-association-card');
    const row = el('div', 'messaging-association-row');
    const copy = el('div', 'messaging-config-card-heading');
    copy.appendChild(el('h3', '', labelFor('messaging.wechat_qr.title', '')));
    copy.appendChild(el('p', '', labelFor('messaging.wechat_qr.subtitle', '')));
    row.appendChild(copy);
    const flowActive = wechatFlowActive();
    const scan = el('button', 'btn messaging-scan-button', labelFor(
      flowActive ? 'messaging.wechat_qr.cancel' : 'messaging.wechat_qr.start', '',
    ));
    scan.type = 'button';
    scan.disabled = state.updating || state.wechat.starting || state.wechat.cancelling;
    scan.appendChild(icon(flowActive ? 'x' : 'qr-code', 'messaging-action-icon'));
    scan.addEventListener('click', () => {
      if (flowActive) void cancelWechatFlow();
      else void startWechatFlow();
    });
    row.appendChild(scan);
    section.appendChild(row);
    renderWechatQrPanel(section);
    return section;
  }

  function renderWechatPanel(channel) {
    const wrapper = el('div', 'messaging-panel-body');
    wrapper.appendChild(renderInstanceList(channel));
    wrapper.appendChild(wechatAssociationCard());
    const instances = instancesForChannel(channel);
    if (instances.length) {
      const deletion = card('messaging.delete_title', 'messaging.delete_subtitle', 'messaging-delete-card');
      const instance = instances.find((item) => item.id === state.selectedInstanceId) || instances[0];
      const deleteButton = el('button', 'btn btn-danger messaging-delete-button', labelFor('messaging.delete', ''));
      deleteButton.type = 'button';
      deleteButton.disabled = state.updating;
      deleteButton.appendChild(icon('trash', 'messaging-action-icon'));
      deleteButton.addEventListener('click', () => void deleteInstance(instance, deleteButton));
      deletion.appendChild(deleteButton);
      wrapper.appendChild(deletion);
    }
    return wrapper;
  }

  function renderWecomPanel(channel) {
    const wrapper = el('div', 'messaging-panel-body');
    wrapper.appendChild(renderInstanceList(channel));
    const config = card('messaging.association_title', 'messaging.association_sub', 'messaging-wecom-card');
    const flowActive = Boolean(state.wecom.flowId && !['completed', 'cancelled', 'expired', 'failed'].includes(state.wecom.state));
    const scan = el('button', 'btn messaging-scan-button', labelFor(
      flowActive ? 'messaging.wecom_qr.cancel' : 'messaging.wecom_qr.start', '',
    ));
    scan.type = 'button';
    scan.disabled = state.updating || state.wecom.starting || state.wecom.cancelling;
    scan.appendChild(icon(flowActive ? 'x' : 'qr-code', 'messaging-action-icon'));
    scan.addEventListener('click', () => {
      if (flowActive) void cancelWecomFlow();
      else void startWecomFlow();
    });
    config.appendChild(scan);
    wrapper.appendChild(config);
    const instances = instancesForChannel(channel);
    if (instances.length) {
      const deletion = card('messaging.delete_title', 'messaging.delete_subtitle', 'messaging-delete-card');
      const instance = instances.find((item) => item.id === state.selectedInstanceId) || instances[0];
      const deleteButton = el('button', 'btn btn-danger messaging-delete-button', labelFor('messaging.delete', ''));
      deleteButton.type = 'button';
      deleteButton.disabled = state.updating;
      deleteButton.appendChild(icon('trash', 'messaging-action-icon'));
      deleteButton.addEventListener('click', () => void deleteInstance(instance, deleteButton));
      deletion.appendChild(deleteButton);
      wrapper.appendChild(deletion);
    }
    return wrapper;
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
      // Owner already bound: show who it is and offer clearing only. The
      // manual id entry reappears in the unbound state for rebinding.
      const row = el('div', 'messaging-owner-bound-row');
      const status = el('div', 'messaging-manual-bound');
      status.append(
        icon('check-circle', 'messaging-status-icon'),
        el('span', '', instance.ownerLabel || instance.ownerMaskedId || labelFor('messaging.owner_configured', '')),
      );
      row.appendChild(status);
      const clear = el('button', 'btn messaging-secondary-button', labelFor('messaging.owner_clear', ''));
      clear.type = 'button';
      clear.disabled = state.updating;
      clear.addEventListener('click', () => void updateInstance({ clearOwner: true }, clear));
      row.appendChild(clear);
      section.appendChild(row);
      return section;
    }

    if (instance.platform === 'feishu_lark') {
      // Auto-binding window: the user just needs to send the bot a direct
      // message — no id entry. Only shown while the window is actually open.
      const pending = el('div', 'messaging-owner-pending');
      pending.style.display = 'none';
      pending.append(icon('clock', 'messaging-status-icon'), el('span', '', ''));
      section.appendChild(pending);
      void invoke('messaging.owner_binding_status', { instanceId: instance.id }).then((res) => {
        if (res && res.binding) {
          pending.style.display = '';
          pending.querySelector('span').textContent = labelFor('messaging.owner_bind_pending', '');
        }
      }).catch(() => { /* window may have expired; leave the hint hidden */ });
    }

    // Standing guide for the unbound state: the auto-bind path is primary,
    // manual id entry is the fallback (persists even after the window closes).
    const guide = el('p', 'messaging-owner-guide', labelFor('messaging.owner_bind_guide', ''));
    section.appendChild(guide);

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

    const save = el('button', 'btn messaging-link-button', labelFor('messaging.owner_save', ''));
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
    section.appendChild(fields);
    return section;
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
    await cancelWecomFlow({ silent: true, render: false });
    await cancelWechatFlow({ silent: true, render: false });
    state.selectedChannel = key;
    state.selectedInstanceId = '';
    state.telegramCreatingNew = false;
    setNotice('', '');
    renderCurrent();
  }

  function renderPanelPage() {
    const channel = channelForKey(state.selectedChannel) || channelForKey('feishu');
    const panel = el('section', `messaging-panel is-${channel.key}`);
    panel.appendChild(renderPanelHeader(channel));
    if (channel.platform === 'feishu_lark') {
      panel.appendChild(renderFeishuPanel(channel));
    } else if (channel.platform === 'telegram') {
      panel.appendChild(renderTelegramPanel(channel));
    } else if (channel.platform === 'wecom') {
      panel.appendChild(renderWecomPanel(channel));
    } else if (channel.platform === 'wechat_personal') {
      panel.appendChild(renderWechatPanel(channel));
    }
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
        if (group === 'open' && bound) {
          const status = el('span', 'messaging-menu-item-status is-bound');
          status.appendChild(el('span', '', labelFor('messaging.status.bound', '')));
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
    // 实例状态实时推送：主进程在状态 kind 变化时广播（心跳重复 connected
    // 不推送）。收到后更新本地实例并重渲染，让"连接中→已连接"即时可见。
    window.cogseed.onPushEvent('messaging:instance-status', (payload) => {
      if (!payload || typeof payload.instanceId !== 'string' || !payload.status) return;
      const instance = state.instances.find((item) => item.id === payload.instanceId);
      if (!instance) return;
      instance.status = payload.status;
      renderCurrent();
    });
  }

  window.initMessagingSettings = async function initMessagingSettings() {
    bind();
    if (!state.initialized) {
      state.initialized = true;
    }
    await refresh();
  };

  // Public entry point for the desktop-first touchpoint flow. It creates a
  // fresh Feishu draft and starts the real QR binding flow, instead of merely
  // opening the legacy settings panel.
  window.openFeishuConnection = async function openFeishuConnection() {
    bind();
    if (!state.initialized) state.initialized = true;
    await refresh();
    state.selectedChannel = 'feishu';
    state.selectedInstanceId = '';
    await startQrForChannel(channelForKey('feishu'));
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      CHANNELS,
      normalizeFeishuQrStatus,
      channelForInstance,
      __test: {
        state,
        applyFeishuQrStatus,
        qrIsVisibleFor,
        qrPollDelay,
        resetQrState,
        instancesForChannel,
        validateBotToken,
        parseWecomAuthMessage,
        switchActionForInstance,
        wechatFlowActive,
        resetWechatFlow,
      },
    };
  }
})();
