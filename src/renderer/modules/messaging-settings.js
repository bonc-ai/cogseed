// Settings surface for local two-way messaging bots. The main process owns
// credential validation and adapter lifecycle; this module owns presentation,
// selection state, and explicit IPC actions.
(function () {
  const state = {
    catalog: [],
    instances: [],
    selectedId: '',
    draftPlatform: '',
    adding: false,
    bound: false,
    loading: false,
    feishuQr: {
      flowId: '',
      state: '',
      starting: false,
      cancelling: false,
      revision: 0,
      qrUrl: '',
      expiresAt: null,
      pollIntervalSeconds: 0,
      error: '',
      timer: null,
      polling: false,
      draft: null,
    },
    wecomQr: {
      flowId: '',
      state: '',
      starting: false,
      completing: false,
      cancelling: false,
      revision: 0,
      popup: null,
      messageListenerBound: false,
      popupWatchTimer: null,
      timeoutTimer: null,
      statusTimer: null,
      expiresAt: null,
      error: '',
      polling: false,
      draft: null,
    },
  };

  const PLATFORM_META = {
    telegram: { labelKey: 'messaging.platform.telegram', fallback: 'Telegram', icon: 'send' },
    feishu_lark: { labelKey: 'messaging.platform.feishu', fallback: '飞书 / Lark', icon: 'message-square' },
    wechat_personal: { labelKey: 'messaging.platform.wechat', fallback: '个人微信', icon: 'message-square' },
    wecom: { labelKey: 'messaging.platform.wecom', fallback: '企业微信', icon: 'users' },
  };

  const FALLBACK_CATALOG = [
    { platform: 'telegram', available: true, twoWay: true },
    { platform: 'feishu_lark', available: true, twoWay: true },
    { platform: 'wechat_personal', available: false, twoWay: false },
    { platform: 'wecom', available: true, twoWay: true },
  ];

  const STATUS_KEYS = {
    disabled: 'messaging.status.disabled',
    disconnected: 'messaging.status.disconnected',
    connecting: 'messaging.status.connecting',
    connected: 'messaging.status.connected',
    error: 'messaging.status.error',
  };

  const FEISHU_QR_TERMINAL_STATES = new Set([
    'completed',
    'cancelled',
    'expired',
    'denied',
    'failed',
  ]);

  const FEISHU_QR_STATE_KEYS = {
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
  };

  const WECOM_QR_TERMINAL_STATES = new Set([
    'completed',
    'cancelled',
    'expired',
    'failed',
  ]);

  const WECOM_QR_STATE_KEYS = {
    awaiting_scan: 'messaging.wecom_qr.status_awaiting_scan',
    activating: 'messaging.wecom_qr.status_activating',
    completed: 'messaging.wecom_qr.status_completed',
    cancelled: 'messaging.wecom_qr.status_cancelled',
    expired: 'messaging.wecom_qr.status_expired',
    failed: 'messaging.wecom_qr.status_failed',
  };

  const WECOM_QR_AUTH_PATH = '/ai/qc/gen';
  const WECOM_QR_FLOW_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
  const WECOM_BOT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
  const WECOM_BOT_SECRET_PATTERN = /^[^\u0000-\u0020\u007f]{8,512}$/;

  function invoke(channel, payload) {
    if (!window.orkas || typeof window.orkas.invoke !== 'function') {
      return Promise.reject(new Error('IPC unavailable'));
    }
    return window.orkas.invoke(channel, payload || {});
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function labelFor(key, fallback) {
    try { return typeof t === 'function' ? t(key) : fallback; } catch (_) { return fallback; }
  }

  function errorMessage(error, fallback) {
    if (error && typeof error.message === 'string' && error.message.trim()) return error.message.trim();
    return fallback;
  }

  function hydrateMessagingIcons() {
    const shell = document.getElementById('messaging-settings-shell');
    if (shell && typeof hydrateUiIcons === 'function') hydrateUiIcons(shell);
  }

  function platformMeta(platform) {
    return PLATFORM_META[platform] || { labelKey: '', fallback: platform || 'Unknown', icon: 'message-square' };
  }

  function platformLabel(platform) {
    const meta = platformMeta(platform);
    return meta.labelKey ? labelFor(meta.labelKey, meta.fallback) : meta.fallback;
  }

  function platformIcon(platform, className) {
    const meta = platformMeta(platform);
    const icon = el('span', `messaging-platform-icon ${className || ''}`.trim());
    icon.dataset.uiIcon = meta.icon;
    icon.setAttribute('aria-hidden', 'true');
    return icon;
  }

  function genericIcon(name, className) {
    const icon = el('span', className || 'messaging-action-icon');
    icon.dataset.uiIcon = name;
    icon.setAttribute('aria-hidden', 'true');
    return icon;
  }

  function statusLabel(kind) {
    return labelFor(STATUS_KEYS[kind] || STATUS_KEYS.disconnected, kind || 'disconnected');
  }

  function statusKind(instance) {
    const kind = instance && instance.status && instance.status.kind;
    return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(STATUS_KEYS, kind) ? kind : 'disconnected';
  }

  function setStatus(message, isError) {
    const node = document.getElementById('messaging-detail-status');
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('is-error', !!isError);
    node.classList.toggle('is-success', !isError && !!message);
  }

  function currentInstance() {
    return state.instances.find((item) => item.id === state.selectedId) || null;
  }

  function isFeishuQrTerminal() {
    return FEISHU_QR_TERMINAL_STATES.has(state.feishuQr.state);
  }

  function isFeishuQrLocked() {
    return state.feishuQr.starting || state.feishuQr.cancelling
      || (Boolean(state.feishuQr.flowId) && !isFeishuQrTerminal());
  }

  function isWecomQrTerminal() {
    return WECOM_QR_TERMINAL_STATES.has(state.wecomQr.state);
  }

  function isWecomQrLocked() {
    return state.wecomQr.starting || state.wecomQr.completing || state.wecomQr.cancelling
      || (Boolean(state.wecomQr.flowId) && !isWecomQrTerminal());
  }

  function clearFeishuQrTimer() {
    if (state.feishuQr.timer !== null) {
      clearTimeout(state.feishuQr.timer);
      state.feishuQr.timer = null;
    }
  }

  function resetFeishuQrState() {
    clearFeishuQrTimer();
    state.feishuQr.revision += 1;
    state.feishuQr.flowId = '';
    state.feishuQr.state = '';
    state.feishuQr.starting = false;
    state.feishuQr.cancelling = false;
    state.feishuQr.qrUrl = '';
    state.feishuQr.expiresAt = null;
    state.feishuQr.pollIntervalSeconds = 0;
    state.feishuQr.error = '';
    state.feishuQr.polling = false;
    state.feishuQr.draft = null;
  }

  function feishuQrStateLabel(statusState) {
    const key = FEISHU_QR_STATE_KEYS[statusState];
    return key ? labelFor(key, statusState) : labelFor('messaging.feishu_qr.status_starting', '正在准备扫码…');
  }

  function normalizeFeishuQrStatus(status) {
    const value = status && typeof status === 'object' ? status : {};
    const nextState = typeof value.state === 'string' && FEISHU_QR_STATE_KEYS[value.state]
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
      ...(typeof value.message === 'string' && value.message.trim() ? { message: value.message.trim() } : {}),
      ...(value.instance && typeof value.instance === 'object' ? { instance: value.instance } : {}),
    };
  }

  function unwrapRegistrationResult(result) {
    if (result && typeof result.registration === 'object' && result.registration !== null) return result.registration;
    return result && typeof result === 'object' ? result : {};
  }

  function applyFeishuQrStatus(status) {
    const next = normalizeFeishuQrStatus(status);
    state.feishuQr.state = next.state;
    if (FEISHU_QR_TERMINAL_STATES.has(next.state)) {
      state.feishuQr.qrUrl = '';
      state.feishuQr.expiresAt = null;
      state.feishuQr.pollIntervalSeconds = 0;
    } else {
      if (next.qrUrl) state.feishuQr.qrUrl = next.qrUrl;
      if (next.expiresAt !== undefined) state.feishuQr.expiresAt = next.expiresAt;
      if (next.intervalSeconds !== undefined) state.feishuQr.pollIntervalSeconds = next.intervalSeconds;
    }
    if (next.error || next.message) state.feishuQr.error = next.error || next.message;
    return next;
  }

  function formatFeishuQrExpiry(value) {
    if (!value) return '';
    const timestamp = typeof value === 'number' ? value : Date.parse(String(value));
    if (!Number.isFinite(timestamp)) return '';
    const date = new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp);
    if (Number.isNaN(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
    } catch (_) {
      return date.toLocaleTimeString();
    }
  }

  function renderFeishuQrCode(host, url) {
    host.replaceChildren();
    if (!url) {
      host.appendChild(el('span', 'messaging-feishu-qr-unavailable', labelFor('messaging.feishu_qr.qr_pending', '开始后将在这里显示二维码')));
      return;
    }
    if (typeof qrcode !== 'function') {
      host.appendChild(el('span', 'messaging-feishu-qr-unavailable', labelFor('messaging.feishu_qr.qr_unavailable', '二维码组件尚未加载')));
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
        svg.setAttribute('aria-label', labelFor('messaging.feishu_qr.qr_alt', '飞书扫码授权二维码'));
      }
    } catch (error) {
      host.appendChild(el('span', 'messaging-feishu-qr-unavailable', errorMessage(error, labelFor('messaging.feishu_qr.qr_unavailable', '二维码生成失败'))));
    }
  }

  function renderFeishuQrStatus(statusNode) {
    const flowState = state.feishuQr.state || (state.feishuQr.starting ? 'starting' : '');
    statusNode.replaceChildren();
    if (!flowState) return;
    statusNode.className = `messaging-feishu-qr-status is-${flowState}`;
    statusNode.appendChild(el('span', 'messaging-status-dot'));
    const text = state.feishuQr.error && (flowState === 'failed' || flowState === 'denied')
      ? state.feishuQr.error
      : feishuQrStateLabel(flowState);
    statusNode.appendChild(el('span', '', text));
    const expiry = formatFeishuQrExpiry(state.feishuQr.expiresAt);
    if (expiry && !FEISHU_QR_TERMINAL_STATES.has(flowState)) {
      statusNode.appendChild(el('span', 'messaging-feishu-qr-expiry', labelFor('messaging.feishu_qr.expires_at', '有效期至 {time}').replace('{time}', expiry)));
    }
  }

  function feishuQrPollDelay(statusState) {
    if (statusState === 'slow_down') return 5000;
    if (Number.isFinite(state.feishuQr.pollIntervalSeconds) && state.feishuQr.pollIntervalSeconds > 0) {
      return Math.max(750, Math.min(10_000, Math.floor(state.feishuQr.pollIntervalSeconds * 1000)));
    }
    if (statusState === 'starting' || statusState === 'domain_switched') return 750;
    return 1500;
  }

  function scheduleFeishuQrPoll(flowId, statusState) {
    clearFeishuQrTimer();
    if (!flowId || state.feishuQr.flowId !== flowId || FEISHU_QR_TERMINAL_STATES.has(statusState)) return;
    state.feishuQr.timer = setTimeout(() => {
      state.feishuQr.timer = null;
      void pollFeishuQr(flowId);
    }, feishuQrPollDelay(statusState));
  }

  async function cancelFeishuQrFlow(options) {
    const flowId = state.feishuQr.flowId;
    const shouldRender = !options || options.render !== false;
    clearFeishuQrTimer();
    if (!flowId || isFeishuQrTerminal()) {
      resetFeishuQrState();
      if (shouldRender) renderDetail(state.adding ? null : currentInstance());
      return;
    }
    state.feishuQr.revision += 1;
    const cancelRevision = state.feishuQr.revision;
    state.feishuQr.cancelling = true;
    state.feishuQr.polling = false;
    let cancelError = '';
    try {
      await invoke('messaging.feishu_qr.cancel', { flowId });
    } catch (error) {
      if (!(options && options.silent) && state.feishuQr.flowId === flowId && state.feishuQr.revision === cancelRevision) {
        cancelError = errorMessage(error, labelFor('messaging.feishu_qr.cancel_failed', '取消扫码失败'));
      }
    } finally {
      if (state.feishuQr.flowId === flowId && state.feishuQr.revision === cancelRevision) {
        resetFeishuQrState();
        if (shouldRender) renderDetail(state.adding ? null : currentInstance());
        if (cancelError) setStatus(cancelError, true);
      }
    }
  }

  async function pollFeishuQr(flowId) {
    if (!flowId || state.feishuQr.flowId !== flowId || state.feishuQr.polling) return;
    const revision = state.feishuQr.revision;
    state.feishuQr.polling = true;
    try {
      const result = await invoke('messaging.feishu_qr.status', { flowId });
      if (state.feishuQr.flowId !== flowId || state.feishuQr.revision !== revision || state.feishuQr.cancelling) return;
      const registration = unwrapRegistrationResult(result);
      const next = applyFeishuQrStatus(registration.status || registration);
      if (next.state === 'completed') {
        const instance = next.instance;
        resetFeishuQrState();
        if (instance && typeof instance.id === 'string' && instance.id) state.selectedId = instance.id;
        state.adding = false;
        state.draftPlatform = '';
        await refresh();
        setStatus(labelFor('messaging.feishu_qr.completed', '飞书机器人已创建'), false);
        return;
      }
      renderDetail(state.adding ? null : currentInstance());
      if (FEISHU_QR_TERMINAL_STATES.has(next.state)) {
        clearFeishuQrTimer();
        if (next.instance && typeof next.instance.id === 'string' && next.instance.id) {
          state.selectedId = next.instance.id;
          state.adding = false;
          state.draftPlatform = '';
          resetFeishuQrState();
          await refresh();
          setStatus(feishuQrStateLabel(next.state), true);
        }
      } else {
        scheduleFeishuQrPoll(flowId, next.state);
      }
    } catch (error) {
      if (state.feishuQr.flowId !== flowId || state.feishuQr.revision !== revision || state.feishuQr.cancelling) return;
      state.feishuQr.state = 'failed';
      state.feishuQr.error = errorMessage(error, labelFor('messaging.feishu_qr.poll_failed', '扫码状态获取失败'));
      clearFeishuQrTimer();
      renderDetail(state.adding ? null : currentInstance());
    } finally {
      if (state.feishuQr.flowId === flowId && state.feishuQr.revision === revision) state.feishuQr.polling = false;
    }
  }

  function listValue(value) {
    return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  }

  function makeMessagingDraft(platform, nameInput, workspaceType, projectInput, replyMode, mentionToggle, allowUsers, allowGroups) {
    const displayName = String(nameInput?.value || '').trim();
    if (!displayName) throw new Error(labelFor('messaging.name_required', '请输入机器人名称'));
    const workspace = workspaceType?.value === 'project'
      ? { type: 'project', projectId: String(projectInput?.value || '').trim() }
      : { type: 'default' };
    if (workspace.type === 'project' && !workspace.projectId) {
      throw new Error(labelFor('messaging.project_required', '请输入项目 ID'));
    }
    return {
      platform,
      displayName,
      workspace,
      policy: {
        replyMode: String(replyMode?.value || 'every_message'),
        allowUserIds: listValue(allowUsers?.value),
        allowGroupIds: listValue(allowGroups?.value),
        requireMentionInGroups: mentionToggle?.checked !== false,
      },
    };
  }

  async function startFeishuQrFlow(payload) {
    if (isFeishuQrLocked()) return;
    if (state.feishuQr.flowId) resetFeishuQrState();
    const revision = state.feishuQr.revision + 1;
    state.feishuQr.revision = revision;
    state.feishuQr.starting = true;
    state.feishuQr.cancelling = false;
    state.feishuQr.state = 'starting';
    state.feishuQr.qrUrl = '';
    state.feishuQr.expiresAt = null;
    state.feishuQr.pollIntervalSeconds = 0;
    state.feishuQr.error = '';
    state.feishuQr.draft = payload;
    renderDetail(null);
    try {
      const result = await invoke('messaging.feishu_qr.start', payload);
      const registration = unwrapRegistrationResult(result);
      const flowId = typeof registration.flowId === 'string' ? registration.flowId.trim() : '';
      if (!flowId) throw new Error(registration.error || result?.error || labelFor('messaging.feishu_qr.start_failed', '无法启动飞书扫码创建'));
      if (state.feishuQr.revision !== revision || !state.feishuQr.starting) {
        try {
          await invoke('messaging.feishu_qr.cancel', { flowId });
        } catch (error) {
          if (state.feishuQr.revision === revision) {
            state.feishuQr.error = errorMessage(error, labelFor('messaging.feishu_qr.cancel_failed', '取消扫码失败'));
          }
        }
        return;
      }
      state.feishuQr.flowId = flowId;
      state.feishuQr.starting = false;
      const next = applyFeishuQrStatus(registration.status || (registration.state ? registration : { state: 'awaiting_scan' }));
      renderDetail(null);
      if (next.state === 'completed') {
        await pollFeishuQr(flowId);
      } else if (FEISHU_QR_TERMINAL_STATES.has(next.state)) {
        clearFeishuQrTimer();
      } else {
        scheduleFeishuQrPoll(flowId, next.state);
      }
    } catch (error) {
      if (state.feishuQr.revision !== revision) return;
      state.feishuQr.starting = false;
      state.feishuQr.state = 'failed';
      state.feishuQr.error = errorMessage(error, labelFor('messaging.feishu_qr.start_failed', '无法启动飞书扫码创建'));
      renderDetail(null);
    }
  }

  function isPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    try {
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    } catch (_) {
      return false;
    }
  }

  function wecomQrStateLabel(statusState) {
    const key = WECOM_QR_STATE_KEYS[statusState];
    return key ? labelFor(key, statusState) : labelFor('messaging.wecom_qr.status_failed', '企业微信授权失败');
  }

  function normalizeWecomQrStatus(status) {
    const value = isPlainRecord(status) ? status : {};
    const statusState = typeof value.state === 'string' && WECOM_QR_STATE_KEYS[value.state]
      ? value.state
      : 'failed';
    return {
      flowId: typeof value.flowId === 'string' ? value.flowId.trim() : '',
      state: statusState,
      ...(typeof value.authUrl === 'string' && value.authUrl.trim() ? { authUrl: value.authUrl.trim() } : {}),
      ...(typeof value.expiresAt === 'string' || typeof value.expiresAt === 'number'
        ? { expiresAt: value.expiresAt }
        : {}),
      ...(value.instance && typeof value.instance === 'object' ? { instance: value.instance } : {}),
    };
  }

  function applyWecomQrStatus(status) {
    const next = normalizeWecomQrStatus(status);
    if (!WECOM_QR_FLOW_ID_PATTERN.test(next.flowId)
      || (state.wecomQr.flowId && next.flowId !== state.wecomQr.flowId)) {
      throw new Error('invalid WeCom registration status');
    }
    state.wecomQr.state = next.state;
    if (WECOM_QR_TERMINAL_STATES.has(next.state)) {
      state.wecomQr.expiresAt = null;
      state.wecomQr.error = next.state === 'failed' ? wecomQrStateLabel('failed') : '';
    } else {
      state.wecomQr.expiresAt = next.expiresAt === undefined ? state.wecomQr.expiresAt : next.expiresAt;
      state.wecomQr.error = '';
    }
    return next;
  }

  function isValidWecomAuthorizationUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:'
        && url.hostname === 'work.weixin.qq.com'
        && url.port === ''
        && url.pathname === WECOM_QR_AUTH_PATH
        && !url.username
        && !url.password
        && !url.search
        && !url.hash;
    } catch (_) {
      return false;
    }
  }

  function validateWecomAuthPayload(data) {
    try {
      if (!isPlainRecord(data) || data.type !== 'AUTH_SUCCESS' || !isPlainRecord(data.payload)) return null;
      const botId = typeof data.payload.botid === 'string' ? data.payload.botid.trim() : '';
      const botSecret = typeof data.payload.secret === 'string' ? data.payload.secret.trim() : '';
      if (!WECOM_BOT_ID_PATTERN.test(botId) || !WECOM_BOT_SECRET_PATTERN.test(botSecret)) return null;
      return { botId, botSecret };
    } catch (_) {
      return null;
    }
  }

  function clearWecomQrTimers() {
    if (state.wecomQr.popupWatchTimer !== null) {
      clearInterval(state.wecomQr.popupWatchTimer);
      state.wecomQr.popupWatchTimer = null;
    }
    if (state.wecomQr.timeoutTimer !== null) {
      clearTimeout(state.wecomQr.timeoutTimer);
      state.wecomQr.timeoutTimer = null;
    }
    if (state.wecomQr.statusTimer !== null) {
      clearTimeout(state.wecomQr.statusTimer);
      state.wecomQr.statusTimer = null;
    }
  }

  function bindWecomQrMessageListener() {
    if (state.wecomQr.messageListenerBound) return;
    window.addEventListener('message', handleWecomQrMessage);
    state.wecomQr.messageListenerBound = true;
  }

  function clearWecomQrMessageListener() {
    if (!state.wecomQr.messageListenerBound) return;
    window.removeEventListener('message', handleWecomQrMessage);
    state.wecomQr.messageListenerBound = false;
  }

  function closeWecomQrPopup(popup) {
    try {
      if (popup && popup.closed !== true && typeof popup.close === 'function') popup.close();
    } catch (_) {
      // The browser can revoke a cross-window reference while closing it.
    }
  }

  function isWecomQrPopupClosed(popup) {
    try {
      return !popup || popup.closed === true;
    } catch (_) {
      return true;
    }
  }

  function invalidateWecomQrAttempt() {
    const snapshot = {
      flowId: state.wecomQr.flowId,
      draft: state.wecomQr.draft,
      popup: state.wecomQr.popup,
    };
    clearWecomQrTimers();
    clearWecomQrMessageListener();
    closeWecomQrPopup(snapshot.popup);
    state.wecomQr.revision += 1;
    state.wecomQr.flowId = '';
    state.wecomQr.starting = false;
    state.wecomQr.completing = false;
    state.wecomQr.cancelling = false;
    state.wecomQr.popup = null;
    state.wecomQr.expiresAt = null;
    state.wecomQr.polling = false;
    return snapshot;
  }

  function resetWecomQrState() {
    invalidateWecomQrAttempt();
    state.wecomQr.state = '';
    state.wecomQr.error = '';
    state.wecomQr.draft = null;
  }

  function settleWecomQrAttempt(statusState, error, retainDraft) {
    const snapshot = invalidateWecomQrAttempt();
    state.wecomQr.state = statusState;
    state.wecomQr.error = error || '';
    state.wecomQr.draft = retainDraft ? snapshot.draft : null;
    return snapshot;
  }

  // Authorization completion and popup closure can happen in either order.
  // Tear down the popup resources as one state transition before crossing the
  // IPC boundary, so the close watcher cannot compensate a valid completion.
  function beginWecomQrActivation(flowId, revision) {
    if (state.wecomQr.flowId !== flowId || state.wecomQr.revision !== revision
      || state.wecomQr.completing || state.wecomQr.cancelling || state.wecomQr.state !== 'awaiting_scan') {
      return false;
    }
    state.wecomQr.completing = true;
    clearWecomQrTimers();
    clearWecomQrMessageListener();
    const popup = state.wecomQr.popup;
    state.wecomQr.popup = null;
    closeWecomQrPopup(popup);
    state.wecomQr.state = 'activating';
    return true;
  }

  function formatWecomQrExpiry(value) {
    return formatFeishuQrExpiry(value);
  }

  function renderWecomQrStatus(statusNode) {
    const flowState = state.wecomQr.state || (state.wecomQr.starting ? 'awaiting_scan' : '');
    statusNode.replaceChildren();
    if (!flowState) return;
    statusNode.className = `messaging-wecom-qr-status is-${flowState}`;
    statusNode.appendChild(el('span', 'messaging-status-dot'));
    const text = state.wecomQr.error && WECOM_QR_TERMINAL_STATES.has(flowState)
      ? state.wecomQr.error
      : wecomQrStateLabel(flowState);
    statusNode.appendChild(el('span', '', text));
    const expiry = formatWecomQrExpiry(state.wecomQr.expiresAt);
    if (expiry && !WECOM_QR_TERMINAL_STATES.has(flowState)) {
      statusNode.appendChild(el('span', 'messaging-wecom-qr-expiry', labelFor('messaging.wecom_qr.expires_at', '有效期至 {time}').replace('{time}', expiry)));
    }
  }

  function scheduleWecomQrStatusPoll(flowId, revision) {
    if (!flowId || state.wecomQr.flowId !== flowId || state.wecomQr.revision !== revision || isWecomQrTerminal()) return;
    if (state.wecomQr.statusTimer !== null) clearTimeout(state.wecomQr.statusTimer);
    state.wecomQr.statusTimer = setTimeout(() => {
      state.wecomQr.statusTimer = null;
      void pollWecomQr(flowId, revision);
    }, 1500);
  }

  function scheduleWecomQrTimeout(flowId, revision) {
    if (state.wecomQr.timeoutTimer !== null) clearTimeout(state.wecomQr.timeoutTimer);
    const expiresAt = Date.parse(String(state.wecomQr.expiresAt || ''));
    if (!Number.isFinite(expiresAt)) return;
    const schedule = () => {
      if (state.wecomQr.flowId !== flowId || state.wecomQr.revision !== revision || isWecomQrTerminal()) return;
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        void cancelWecomQrFlow({
          silent: true,
          retainTerminal: true,
          terminalState: 'expired',
          error: labelFor('messaging.wecom_qr.timeout', '企业微信授权已过期，请重新开始。'),
        });
        return;
      }
      state.wecomQr.timeoutTimer = setTimeout(schedule, Math.min(remaining, 60_000));
    };
    schedule();
  }

  function startWecomQrWatchers(flowId, revision) {
    const popup = state.wecomQr.popup;
    if (!popup) return;
    if (state.wecomQr.popupWatchTimer !== null) clearInterval(state.wecomQr.popupWatchTimer);
    state.wecomQr.popupWatchTimer = setInterval(() => {
      if (state.wecomQr.flowId !== flowId || state.wecomQr.revision !== revision || isWecomQrTerminal()) {
        if (state.wecomQr.popupWatchTimer !== null) {
          clearInterval(state.wecomQr.popupWatchTimer);
          state.wecomQr.popupWatchTimer = null;
        }
        return;
      }
      if (isWecomQrPopupClosed(popup)) {
        void cancelWecomQrFlow({
          silent: true,
          retainTerminal: true,
          terminalState: 'cancelled',
          error: labelFor('messaging.wecom_qr.popup_closed', '企业微信授权窗口已关闭。'),
        });
      }
    }, 500);
    scheduleWecomQrTimeout(flowId, revision);
    scheduleWecomQrStatusPoll(flowId, revision);
  }

  async function finishWecomQrRegistration(instance) {
    const instanceId = instance && typeof instance.id === 'string' ? instance.id : '';
    if (!instanceId) {
      settleWecomQrAttempt('failed', labelFor('messaging.wecom_qr.complete_failed', '企业微信机器人创建失败。'), true);
      renderDetail(null);
      return;
    }
    resetWecomQrState();
    state.selectedId = instanceId;
    state.adding = false;
    state.draftPlatform = '';
    await refresh();
    setStatus(labelFor('messaging.wecom_qr.completed', '企业微信机器人已创建'), false);
  }

  async function cancelWecomQrFlow(options) {
    const config = options || {};
    const shouldRender = config.render !== false;
    const retainTerminal = config.retainTerminal === true;
    const terminalState = WECOM_QR_TERMINAL_STATES.has(config.terminalState)
      ? config.terminalState
      : 'cancelled';
    const hasAttempt = Boolean(state.wecomQr.flowId || state.wecomQr.starting || state.wecomQr.completing
      || state.wecomQr.cancelling || state.wecomQr.popup || state.wecomQr.state || state.wecomQr.draft);
    if (!hasAttempt) return;
    const snapshot = invalidateWecomQrAttempt();
    const revision = state.wecomQr.revision;
    if (retainTerminal) {
      state.wecomQr.state = terminalState;
      state.wecomQr.error = config.error || '';
      state.wecomQr.draft = snapshot.draft;
    } else {
      state.wecomQr.state = '';
      state.wecomQr.error = '';
      state.wecomQr.draft = null;
    }
    if (shouldRender) renderDetail(state.adding ? null : currentInstance());
    if (!snapshot.flowId) return;
    try {
      await invoke('messaging.wecom_qr.cancel', { flowId: snapshot.flowId });
    } catch (_) {
      if (!config.silent && state.wecomQr.revision === revision) {
        state.wecomQr.state = 'failed';
        state.wecomQr.error = labelFor('messaging.wecom_qr.cancel_failed', '无法取消企业微信授权。');
        if (shouldRender) renderDetail(state.adding ? null : currentInstance());
      }
    }
  }

  async function pollWecomQr(flowId, revision) {
    if (!flowId || state.wecomQr.flowId !== flowId || state.wecomQr.revision !== revision
      || state.wecomQr.polling || state.wecomQr.completing) return;
    state.wecomQr.polling = true;
    try {
      const result = await invoke('messaging.wecom_qr.status', { flowId });
      if (state.wecomQr.flowId !== flowId || state.wecomQr.revision !== revision
        || state.wecomQr.cancelling || state.wecomQr.completing) return;
      const next = applyWecomQrStatus(unwrapRegistrationResult(result));
      if (next.state === 'completed') {
        await finishWecomQrRegistration(next.instance);
        return;
      }
      if (WECOM_QR_TERMINAL_STATES.has(next.state)) {
        settleWecomQrAttempt(next.state, next.state === 'failed' ? state.wecomQr.error : '', true);
        renderDetail(null);
        return;
      }
      renderDetail(null);
      scheduleWecomQrTimeout(flowId, revision);
      scheduleWecomQrStatusPoll(flowId, revision);
    } catch (_) {
      if (state.wecomQr.flowId !== flowId || state.wecomQr.revision !== revision) return;
      await cancelWecomQrFlow({
        silent: true,
        retainTerminal: true,
        terminalState: 'failed',
        error: labelFor('messaging.wecom_qr.poll_failed', '企业微信授权状态获取失败。'),
      });
    } finally {
      if (state.wecomQr.flowId === flowId && state.wecomQr.revision === revision) state.wecomQr.polling = false;
    }
  }

  async function completeWecomQrFlow(flowId, revision, wecomBotId, wecomBotSecret) {
    if (!beginWecomQrActivation(flowId, revision)) return;
    renderDetail(null);
    let secret = wecomBotSecret;
    wecomBotSecret = '';
    try {
      const result = await invoke('messaging.wecom_qr.complete', {
        flowId,
        wecomBotId,
        wecomBotSecret: secret,
      });
      secret = '';
      if (state.wecomQr.flowId !== flowId || state.wecomQr.revision !== revision) return;
      state.wecomQr.completing = false;
      const next = applyWecomQrStatus(unwrapRegistrationResult(result));
      if (next.state === 'completed') {
        await finishWecomQrRegistration(next.instance);
        return;
      }
      if (WECOM_QR_TERMINAL_STATES.has(next.state)) {
        settleWecomQrAttempt(next.state, next.state === 'failed' ? state.wecomQr.error : '', true);
        renderDetail(null);
        return;
      }
      renderDetail(null);
      scheduleWecomQrTimeout(flowId, revision);
      scheduleWecomQrStatusPoll(flowId, revision);
    } catch (_) {
      if (state.wecomQr.flowId !== flowId || state.wecomQr.revision !== revision) return;
      await cancelWecomQrFlow({
        silent: true,
        retainTerminal: true,
        terminalState: 'failed',
        error: labelFor('messaging.wecom_qr.complete_failed', '企业微信机器人创建失败。'),
      });
    } finally {
      secret = '';
      wecomBotSecret = '';
      if (state.wecomQr.flowId === flowId && state.wecomQr.revision === revision) state.wecomQr.completing = false;
    }
  }

  function handleWecomQrMessage(event) {
    if (!state.wecomQr.flowId || state.wecomQr.starting || state.wecomQr.completing
      || state.wecomQr.cancelling || state.wecomQr.state !== 'awaiting_scan') return;
    const isOfficialOrigin = event.origin === 'https://work.weixin.qq.com';
    const isCurrentPopup = event.source === state.wecomQr.popup;
    if (!isOfficialOrigin || !isCurrentPopup) return;
    const credentials = validateWecomAuthPayload(event.data);
    if (!credentials) return;
    const flowId = state.wecomQr.flowId;
    const revision = state.wecomQr.revision;
    const wecomBotId = credentials.botId;
    let wecomBotSecret = credentials.botSecret;
    credentials.botSecret = '';
    void completeWecomQrFlow(flowId, revision, wecomBotId, wecomBotSecret);
    wecomBotSecret = '';
  }

  async function startWecomQrFlow(payload) {
    if (isWecomQrLocked()) return;
    if (state.wecomQr.flowId || state.wecomQr.state || state.wecomQr.draft) resetWecomQrState();
    const revision = state.wecomQr.revision + 1;
    state.wecomQr.revision = revision;
    state.wecomQr.starting = true;
    state.wecomQr.state = 'awaiting_scan';
    state.wecomQr.error = '';
    state.wecomQr.draft = payload;
    renderDetail(null);
    let startedFlowId = '';
    try {
      const result = await invoke('messaging.wecom_qr.start', {
        displayName: payload.displayName,
        workspace: payload.workspace,
        policy: payload.policy,
      });
      const registration = normalizeWecomQrStatus(unwrapRegistrationResult(result));
      startedFlowId = registration.flowId;
      const registrationExpiry = Date.parse(String(registration.expiresAt || ''));
      if (!WECOM_QR_FLOW_ID_PATTERN.test(registration.flowId)
        || !isValidWecomAuthorizationUrl(registration.authUrl)
        || registration.state !== 'awaiting_scan'
        || !Number.isFinite(registrationExpiry)
        || registrationExpiry <= Date.now()) {
        throw new Error('invalid WeCom authorization response');
      }
      if (state.wecomQr.revision !== revision || !state.wecomQr.starting) {
        try {
          await invoke('messaging.wecom_qr.cancel', { flowId: registration.flowId });
        } catch (_) {
          // A superseded flow is already locally invalidated and cannot update this UI.
        }
        return;
      }
      state.wecomQr.flowId = registration.flowId;
      state.wecomQr.starting = false;
      state.wecomQr.state = registration.state;
      state.wecomQr.expiresAt = registration.expiresAt || null;
      const popup = window.open(
        registration.authUrl,
        'mate-agent-wecom-authorization',
        'popup=yes,width=520,height=720,resizable=yes,scrollbars=yes',
      );
      if (isWecomQrPopupClosed(popup)) {
        await cancelWecomQrFlow({
          silent: true,
          retainTerminal: true,
          terminalState: 'failed',
          error: labelFor('messaging.wecom_qr.popup_blocked', '无法打开企业微信授权窗口。'),
        });
        return;
      }
      if (state.wecomQr.flowId !== registration.flowId || state.wecomQr.revision !== revision) {
        closeWecomQrPopup(popup);
        try {
          await invoke('messaging.wecom_qr.cancel', { flowId: registration.flowId });
        } catch (_) {
          // The invalidated flow cannot regain ownership of the active UI.
        }
        return;
      }
      state.wecomQr.popup = popup;
      bindWecomQrMessageListener();
      renderDetail(null);
      startWecomQrWatchers(registration.flowId, revision);
    } catch (_) {
      if (state.wecomQr.revision !== revision) return;
      const snapshot = settleWecomQrAttempt(
        'failed',
        labelFor('messaging.wecom_qr.start_failed', '无法启动企业微信授权。'),
        true,
      );
      renderDetail(null);
      const flowId = snapshot.flowId || startedFlowId;
      if (WECOM_QR_FLOW_ID_PATTERN.test(flowId)) {
        try {
          await invoke('messaging.wecom_qr.cancel', { flowId });
        } catch (_) {
          // The failed start is already terminal locally; cancellation is best effort.
        }
      }
    }
  }

  function discardActiveQrFlows() {
    if (state.feishuQr.flowId || state.feishuQr.starting) void cancelFeishuQrFlow({ silent: true, render: false });
    if (state.wecomQr.flowId || state.wecomQr.starting || state.wecomQr.completing
      || state.wecomQr.cancelling || state.wecomQr.popup || state.wecomQr.state || state.wecomQr.draft) {
      void cancelWecomQrFlow({ silent: true, render: false });
    }
  }

  function catalogEntries() {
    const source = state.catalog.length ? state.catalog : FALLBACK_CATALOG;
    const known = new Set();
    return source.filter((entry) => {
      const platform = entry && typeof entry.platform === 'string' ? entry.platform : '';
      if (!platform || known.has(platform)) return false;
      known.add(platform);
      return true;
    });
  }

  function selectDraftPlatform(platform) {
    const entry = catalogEntries().find((item) => item.platform === platform);
    if (!entry || entry.available === false || entry.twoWay === false) return;
    discardActiveQrFlows();
    state.selectedId = '';
    state.adding = true;
    state.draftPlatform = platform;
    renderList();
    renderCatalog();
    renderDetail(null);
  }

  function renderCatalog() {
    const root = document.getElementById('messaging-catalog');
    if (!root) return;
    root.classList.toggle('is-only-section', state.instances.length === 0);
    root.replaceChildren();
    root.appendChild(el('div', 'messaging-catalog-heading', labelFor('messaging.catalog_title', '可用平台')));
    root.appendChild(el('div', 'messaging-catalog-sub', labelFor('messaging.catalog_subtitle', '选择平台开始配置')));
    for (const entry of catalogEntries()) {
      const platform = entry.platform;
      const available = entry.available !== false && entry.twoWay !== false;
      const row = el('button', `messaging-catalog-row${available ? '' : ' is-disabled'}${state.draftPlatform === platform ? ' is-selected' : ''}`);
      row.type = 'button';
      row.dataset.platform = platform;
      row.disabled = !available;
      row.appendChild(platformIcon(platform, 'messaging-catalog-icon'));
      const body = el('span', 'messaging-catalog-body');
      body.appendChild(el('strong', '', platformLabel(platform)));
      const description = available
        ? labelFor('messaging.catalog_two_way', '双向对话')
        : labelFor('messaging.catalog_unavailable', '暂不可用');
      body.appendChild(el('span', '', description));
      row.appendChild(body);
      if (available) row.addEventListener('click', () => selectDraftPlatform(platform));
      root.appendChild(row);
    }
    hydrateMessagingIcons();
  }

  function renderList() {
    const root = document.getElementById('messaging-instance-list');
    if (!root) return;
    const label = document.getElementById('messaging-configured-title');
    root.replaceChildren();
    if (!state.instances.length) {
      root.hidden = true;
      if (label) label.hidden = true;
      hydrateMessagingIcons();
      return;
    }
    root.hidden = false;
    if (label) label.hidden = false;
    for (const instance of state.instances) {
      const selected = !state.adding && instance.id === state.selectedId;
      const row = el('button', `messaging-instance-row${selected ? ' is-selected' : ''}`);
      row.type = 'button';
      row.dataset.instanceId = instance.id;
      row.appendChild(platformIcon(instance.platform, 'messaging-instance-icon'));
      const body = el('span', 'messaging-instance-row-body');
      body.appendChild(el('strong', 'messaging-instance-name', instance.displayName || platformLabel(instance.platform)));
      body.appendChild(el('span', 'messaging-instance-platform', platformLabel(instance.platform)));
      row.appendChild(body);
      const kind = statusKind(instance);
      const status = el('span', `messaging-status-dot is-${kind}`);
      status.title = statusLabel(kind);
      status.setAttribute('aria-label', statusLabel(kind));
      row.appendChild(status);
      row.addEventListener('click', () => {
        discardActiveQrFlows();
        state.selectedId = instance.id;
        state.adding = false;
        state.draftPlatform = '';
        renderList();
        renderCatalog();
        renderDetail(instance);
      });
      root.appendChild(row);
    }
    hydrateMessagingIcons();
  }

  function input(type, value, placeholder) {
    const node = document.createElement('input');
    node.type = type;
    node.className = 'form-input';
    node.value = typeof value === 'string' ? value : '';
    if (placeholder) node.placeholder = placeholder;
    node.autocomplete = 'off';
    node.spellcheck = false;
    return node;
  }

  function select(options, value) {
    const node = document.createElement('select');
    node.className = 'form-input messaging-select';
    for (const option of options) {
      const item = document.createElement('option');
      item.value = option.value;
      item.textContent = option.label;
      item.selected = option.value === value;
      node.appendChild(item);
    }
    return node;
  }

  function fieldRow(labelText, control, helpText) {
    const row = el('label', 'messaging-field');
    row.appendChild(el('span', 'messaging-field-label', labelText));
    const content = el('span', 'messaging-field-control');
    content.appendChild(control);
    if (helpText) content.appendChild(el('span', 'messaging-field-help', helpText));
    row.appendChild(content);
    return row;
  }

  function manualSecretForPlatform(platform, credentials, isNew) {
    if (platform === 'telegram') {
      return isNew || credentials.telegramToken.value ? { botToken: credentials.telegramToken.value } : null;
    }
    if (platform === 'feishu_lark') {
      const hasValue = credentials.feishuAppId.value || credentials.feishuAppSecret.value || credentials.feishuTenantToken.value;
      return isNew || hasValue
        ? {
          appId: credentials.feishuAppId.value,
          appSecret: credentials.feishuAppSecret.value,
          tenantAccessToken: credentials.feishuTenantToken.value,
        }
        : null;
    }
    if (platform === 'wecom') {
      const wecomBotId = credentials.wecomBotId.value.trim();
      const wecomBotSecret = credentials.wecomBotSecret.value.trim();
      if (!isNew && !wecomBotId && !wecomBotSecret) return null;
      if (!wecomBotId || !wecomBotSecret) {
        throw new Error(labelFor('messaging.wecom_credentials_pair_required', '请同时填写企业微信 Bot ID 和 Secret。'));
      }
      return { wecomBotId, wecomBotSecret };
    }
    throw new Error(labelFor('messaging.save_failed', '保存失败'));
  }

  function card(title, description, className) {
    const root = el('section', `messaging-config-card ${className || ''}`.trim());
    const head = el('div', 'messaging-config-card-head');
    const titleWrap = el('div', 'messaging-config-card-title-wrap');
    titleWrap.appendChild(el('h4', '', title));
    if (description) titleWrap.appendChild(el('p', '', description));
    head.appendChild(titleWrap);
    root.appendChild(head);
    return root;
  }

  function toggleControl(instance, onChange) {
    const label = el('label', 'messaging-switch');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = instance.enabled === true;
    checkbox.setAttribute('aria-label', labelFor('messaging.enabled', '启用接收'));
    checkbox.addEventListener('change', onChange);
    const track = el('span', 'messaging-switch-track');
    track.setAttribute('aria-hidden', 'true');
    label.append(checkbox, track);
    return { label, checkbox };
  }

  function unbindButton(instance) {
    const button = el('button', 'btn messaging-unbind-button', labelFor('messaging.unbind', '解绑'));
    button.type = 'button';
    button.appendChild(genericIcon('link', 'messaging-action-icon'));
    button.addEventListener('click', async () => {
      if (!window.confirm(labelFor('messaging.unbind_confirm', '解绑后需要重新输入凭据才能接收消息，确定继续吗？'))) return;
      button.disabled = true;
      try {
        const result = await invoke('messaging.unbind', { instanceId: instance.id });
        if (!result || !result.instance) throw new Error(result?.error || labelFor('messaging.unbind_failed', '解绑失败'));
        await refresh();
        setStatus(labelFor('messaging.unbound', '已解绑'), false);
      } catch (error) {
        setStatus(errorMessage(error, labelFor('messaging.unbind_failed', '解绑失败')), true);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  function deleteButton(instance) {
    const button = el('button', 'btn btn-danger messaging-delete-button', labelFor('messaging.delete', '删除机器人'));
    button.type = 'button';
    button.appendChild(genericIcon('trash', 'messaging-action-icon'));
    button.addEventListener('click', async () => {
      if (!window.confirm(labelFor('messaging.delete_confirm', '确定删除这个机器人实例吗？'))) return;
      button.disabled = true;
      try {
        const result = await invoke('messaging.delete', { instanceId: instance.id });
        if (result && result.deleted === false) throw new Error(labelFor('messaging.delete_failed', '删除失败'));
        state.selectedId = '';
        state.adding = false;
        state.draftPlatform = '';
        await refresh();
      } catch (error) {
        setStatus(errorMessage(error, labelFor('messaging.delete_failed', '删除失败')), true);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  function renderDetail(instance) {
    const root = document.getElementById('messaging-detail');
    if (!root) return;
    root.replaceChildren();
    if (!instance && !state.draftPlatform) {
      const empty = el('div', 'messaging-detail-empty');
      empty.appendChild(platformIcon('message-square', 'messaging-empty-mark'));
      empty.appendChild(el('strong', '', labelFor('messaging.empty_title', '选择一个机器人或平台')));
      empty.appendChild(el('span', '', labelFor('messaging.empty_sub', '从左侧选择已配置机器人，或选择平台开始新建')));
      root.appendChild(empty);
      hydrateMessagingIcons();
      return;
    }

    const isNew = !instance;
    const platform = instance?.platform || state.draftPlatform;
    const canConfigureCredentials = isNew || instance.hasCredentials !== true || platform === 'wecom';
    const qrDraft = isNew && platform === 'feishu_lark'
      ? state.feishuQr.draft
      : isNew && platform === 'wecom'
        ? state.wecomQr.draft
        : null;
    const qrFlowLocked = isNew && (
      (platform === 'feishu_lark' && isFeishuQrLocked())
      || (platform === 'wecom' && isWecomQrLocked())
    );
    const form = el('form', 'messaging-detail-form');
    form.noValidate = true;

    const header = el('header', 'messaging-detail-header');
    const heading = el('div', 'messaging-detail-heading');
    const titleRow = el('div', 'messaging-detail-title-row');
    titleRow.appendChild(platformIcon(platform, 'messaging-detail-icon'));
    const titleWrap = el('div', 'messaging-detail-title-wrap');
    titleWrap.appendChild(el('h3', '', isNew ? labelFor('messaging.new_title', '新建机器人') : instance.displayName));
    titleWrap.appendChild(el('span', 'messaging-detail-platform', platformLabel(platform)));
    titleRow.appendChild(titleWrap);
    heading.appendChild(titleRow);
    const headerStatusKind = isNew ? 'disconnected' : statusKind(instance);
    const statusRow = el('div', `messaging-detail-state is-${headerStatusKind}`);
    statusRow.appendChild(el('span', `messaging-status-dot is-${headerStatusKind}`));
    statusRow.appendChild(el('span', '', isNew ? labelFor('messaging.status.unbound', '未关联') : statusLabel(statusKind(instance))));
    heading.appendChild(statusRow);
    header.appendChild(heading);

    if (!isNew) {
      const toggle = toggleControl(instance, async (event) => {
        const checkbox = event.currentTarget;
        checkbox.disabled = true;
        try {
          const result = await invoke('messaging.set_enabled', { instanceId: instance.id, enabled: checkbox.checked });
          if (!result || !result.instance) throw new Error(result?.error || labelFor('messaging.save_failed', '保存失败'));
          await refresh();
          setStatus(labelFor('messaging.saved', '已保存'), false);
        } catch (error) {
          checkbox.checked = !checkbox.checked;
          setStatus(errorMessage(error, labelFor('messaging.save_failed', '保存失败')), true);
        } finally {
          checkbox.disabled = false;
        }
      });
      header.appendChild(toggle.label);
    }
    form.appendChild(header);

    const connection = card(
      labelFor('messaging.connection_title', '关联机器人'),
      labelFor(isNew
        ? 'messaging.connection_new_sub'
        : canConfigureCredentials
          ? 'messaging.connection_new_sub'
          : 'messaging.connection_bound_sub', '输入应用凭据后检查连接。'),
      'messaging-connection-card',
    );
    const connectionToolbar = el('div', 'messaging-connection-toolbar');
    const connectionState = el('div', 'messaging-connection-state');
    const stateKind = isNew ? 'disconnected' : statusKind(instance);
    connectionState.appendChild(el('span', `messaging-status-dot is-${stateKind}`));
    connectionState.appendChild(el('span', '', isNew
      ? labelFor('messaging.status.unbound', '未关联')
      : instance.hasCredentials
        ? labelFor('messaging.connection_bound', '已关联')
        : labelFor('messaging.status.unbound', '未关联')));
    connectionToolbar.appendChild(connectionState);
    if (!isNew && instance.hasCredentials) connectionToolbar.appendChild(unbindButton(instance));
    connection.appendChild(connectionToolbar);

    const details = el('div', 'messaging-connection-details');
    const nameInput = input('text', instance?.displayName || qrDraft?.displayName || '', labelFor('messaging.name_placeholder', '例如：团队助理'));
    details.appendChild(fieldRow(labelFor('messaging.name', '机器人名称'), nameInput));
    const telegramToken = input('password', '', isNew
      ? labelFor('messaging.telegram_token_placeholder', '粘贴 BotFather 生成的 token')
      : labelFor('messaging.secret_keep_placeholder', '留空以保留现有凭证'));
    const feishuAppId = input('text', '', isNew ? 'cli_xxx' : labelFor('messaging.secret_keep_placeholder', '留空以保留现有凭证'));
    const feishuAppSecret = input('password', '', isNew
      ? labelFor('messaging.feishu_secret_placeholder', '飞书应用 App Secret')
      : labelFor('messaging.secret_keep_placeholder', '留空以保留现有凭证'));
    const feishuTenantToken = input('password', '', labelFor('messaging.feishu_token_optional', '可选：已有 tenant_access_token'));
    const wecomBotId = input('text', '', isNew
      ? labelFor('messaging.wecom_bot_id_placeholder', '企业微信机器人 Bot ID')
      : labelFor('messaging.secret_keep_placeholder', '留空以保留现有凭证'));
    const wecomBotSecret = input('password', '', isNew
      ? labelFor('messaging.wecom_bot_secret_placeholder', '企业微信机器人 Secret')
      : labelFor('messaging.secret_keep_placeholder', '留空以保留现有凭证'));
    const telegramRow = fieldRow(labelFor('messaging.telegram_token', 'Bot Token'), telegramToken);
    const feishuAppIdRow = fieldRow(labelFor('messaging.feishu_app_id', 'App ID'), feishuAppId);
    const feishuSecretRow = fieldRow(labelFor('messaging.feishu_app_secret', 'App Secret'), feishuAppSecret);
    const feishuTenantRow = fieldRow(labelFor('messaging.feishu_tenant_token', 'Tenant Token'), feishuTenantToken);
    const wecomBotIdRow = fieldRow(labelFor('messaging.wecom_bot_id', 'Bot ID'), wecomBotId);
    const wecomBotSecretRow = fieldRow(labelFor('messaging.wecom_bot_secret', 'Bot Secret'), wecomBotSecret);
    if (canConfigureCredentials) {
      details.append(telegramRow, feishuAppIdRow, feishuSecretRow, feishuTenantRow, wecomBotIdRow, wecomBotSecretRow);
    }
    connection.appendChild(details);
    form.appendChild(connection);

    let feishuQrStartButton = null;
    let feishuQrCancelButton = null;
    if (isNew && platform === 'feishu_lark') {
      const qrCard = card(
        labelFor('messaging.feishu_qr.title', '扫码创建飞书机器人'),
        labelFor('messaging.feishu_qr.subtitle', '使用飞书官方授权流程扫码，应用凭据会安全保存在本机。'),
        'messaging-feishu-qr-card',
      );
      const qrLayout = el('div', 'messaging-feishu-qr-layout');
      const qrHost = el('div', 'messaging-feishu-qr-code');
      qrHost.setAttribute('aria-live', 'polite');
      renderFeishuQrCode(qrHost, state.feishuQr.qrUrl);
      const qrInfo = el('div', 'messaging-feishu-qr-info');
      const qrStatus = el('div', 'messaging-feishu-qr-status');
      renderFeishuQrStatus(qrStatus);
      qrInfo.appendChild(qrStatus);
      const qrHint = el('p', 'messaging-feishu-qr-hint', labelFor('messaging.feishu_qr.hint', '点击开始后，用飞书扫描二维码并完成授权。'));
      qrInfo.appendChild(qrHint);
      const qrActions = el('div', 'messaging-feishu-qr-actions');
      const hasFlow = Boolean(state.feishuQr.flowId);
      if (!hasFlow || isFeishuQrTerminal()) {
        feishuQrStartButton = el('button', 'btn btn-primary', labelFor(
          state.feishuQr.state && state.feishuQr.state !== 'completed'
            ? 'messaging.feishu_qr.retry'
            : 'messaging.feishu_qr.start',
          state.feishuQr.state && state.feishuQr.state !== 'completed' ? '重新扫码创建' : '开始扫码创建',
        ));
        feishuQrStartButton.type = 'button';
        feishuQrStartButton.appendChild(genericIcon('refresh', 'messaging-action-icon'));
        feishuQrStartButton.disabled = state.feishuQr.starting;
        feishuQrStartButton.addEventListener('click', () => {
          try {
            const payload = makeMessagingDraft('feishu_lark', nameInput, workspaceType, projectInput, replyMode, mentionToggle, allowUsers, allowGroups);
            void startFeishuQrFlow(payload);
          } catch (error) {
            setStatus(errorMessage(error, labelFor('messaging.save_failed', '保存失败')), true);
          }
        });
        qrActions.appendChild(feishuQrStartButton);
      }
      if (hasFlow && !isFeishuQrTerminal()) {
        feishuQrCancelButton = el('button', 'btn', labelFor('messaging.feishu_qr.cancel', '取消扫码'));
        feishuQrCancelButton.type = 'button';
        feishuQrCancelButton.appendChild(genericIcon('x', 'messaging-action-icon'));
        feishuQrCancelButton.addEventListener('click', () => {
          feishuQrCancelButton.disabled = true;
          void cancelFeishuQrFlow().finally(() => {
            if (feishuQrCancelButton) feishuQrCancelButton.disabled = false;
          });
        });
        qrActions.appendChild(feishuQrCancelButton);
      }
      qrInfo.appendChild(qrActions);
      qrLayout.append(qrHost, qrInfo);
      qrCard.appendChild(qrLayout);
      form.appendChild(qrCard);
    }

    if (isNew && platform === 'wecom') {
      const qrCard = card(
        labelFor('messaging.wecom_qr.title', '授权创建企业微信机器人'),
        labelFor('messaging.wecom_qr.subtitle', '通过企业微信官方授权页创建机器人，授权会在单独窗口中完成。'),
        'messaging-wecom-qr-card',
      );
      const qrLayout = el('div', 'messaging-wecom-qr-layout');
      const qrInfo = el('div', 'messaging-wecom-qr-info');
      const qrStatus = el('div', 'messaging-wecom-qr-status');
      qrStatus.setAttribute('aria-live', 'polite');
      renderWecomQrStatus(qrStatus);
      qrInfo.appendChild(qrStatus);
      qrInfo.appendChild(el('p', 'messaging-wecom-qr-hint', labelFor(
        'messaging.wecom_qr.hint',
        '开始后将打开企业微信官方授权页，请在该窗口中完成扫码和授权。',
      )));
      const qrActions = el('div', 'messaging-wecom-qr-actions');
      const hasFlow = Boolean(state.wecomQr.flowId || state.wecomQr.starting || state.wecomQr.completing);
      if (!hasFlow || isWecomQrTerminal()) {
        const startButton = el('button', 'btn btn-primary', labelFor(
          state.wecomQr.state && state.wecomQr.state !== 'completed'
            ? 'messaging.wecom_qr.retry'
            : 'messaging.wecom_qr.start',
          state.wecomQr.state && state.wecomQr.state !== 'completed' ? '重新授权创建' : '开始官方授权',
        ));
        startButton.type = 'button';
        startButton.appendChild(genericIcon('external-link', 'messaging-action-icon'));
        startButton.disabled = state.wecomQr.starting || state.wecomQr.completing;
        startButton.addEventListener('click', () => {
          try {
            const payload = makeMessagingDraft('wecom', nameInput, workspaceType, projectInput, replyMode, mentionToggle, allowUsers, allowGroups);
            void startWecomQrFlow(payload);
          } catch (error) {
            setStatus(errorMessage(error, labelFor('messaging.save_failed', '保存失败')), true);
          }
        });
        qrActions.appendChild(startButton);
      }
      if (hasFlow && !isWecomQrTerminal()) {
        const cancelButton = el('button', 'btn', labelFor('messaging.wecom_qr.cancel', '取消授权'));
        cancelButton.type = 'button';
        cancelButton.appendChild(genericIcon('x', 'messaging-action-icon'));
        cancelButton.addEventListener('click', () => {
          cancelButton.disabled = true;
          void cancelWecomQrFlow({ retainTerminal: true }).finally(() => {
            cancelButton.disabled = false;
          });
        });
        qrActions.appendChild(cancelButton);
      }
      qrInfo.appendChild(qrActions);
      qrLayout.appendChild(qrInfo);
      qrCard.appendChild(qrLayout);
      form.appendChild(qrCard);
    }

    const reply = card(
      labelFor('messaging.reply_title', '机器人回复规则'),
      labelFor('messaging.reply_sub', '控制机器人接收哪些消息，群聊可以要求先 @机器人。'),
      'messaging-reply-card',
    );
    const replyMode = select([
      { value: 'every_message', label: labelFor('messaging.reply_every', '每条消息') },
      { value: 'mentions_only', label: labelFor('messaging.reply_mentions', '仅被提及时') },
      { value: 'commands_only', label: labelFor('messaging.reply_commands', '仅命令消息') },
    ], instance?.policy?.replyMode || qrDraft?.policy?.replyMode || 'every_message');
    reply.appendChild(fieldRow(labelFor('messaging.reply_mode', '回复粒度'), replyMode));
    const mentionLabel = el('label', 'messaging-checkbox');
    const mentionToggle = document.createElement('input');
    mentionToggle.type = 'checkbox';
    mentionToggle.checked = instance?.policy?.requireMentionInGroups !== undefined
      ? instance.policy.requireMentionInGroups !== false
      : qrDraft?.policy?.requireMentionInGroups !== false;
    mentionLabel.append(mentionToggle, el('span', '', labelFor('messaging.require_mention', '群聊需要 @机器人')));
    reply.appendChild(mentionLabel);
    form.appendChild(reply);

    const workspace = card(
      labelFor('messaging.workspace_title', '工作区访问范围'),
      labelFor('messaging.workspace_sub', '这个机器人可以使用已配置的工作区。'),
      'messaging-workspace-card',
    );
    const workspaceType = select([
      { value: 'default', label: labelFor('messaging.workspace_default', '默认工作区') },
      { value: 'project', label: labelFor('messaging.workspace_project', '指定项目') },
    ], instance?.workspace?.type || qrDraft?.workspace?.type || 'default');
    const projectInput = input('text', instance?.workspace?.projectId || qrDraft?.workspace?.projectId || '', labelFor('messaging.project_placeholder', '项目页中的项目 ID'));
    const projectRow = fieldRow(labelFor('messaging.project_id', '项目 ID'), projectInput);
    workspace.appendChild(fieldRow(labelFor('messaging.workspace', '工作区'), workspaceType));
    workspace.appendChild(projectRow);

    const access = el('div', 'messaging-access-grid');
    const allowUsers = input('text', (instance?.policy?.allowUserIds || qrDraft?.policy?.allowUserIds || []).join(', '), labelFor('messaging.allow_users_placeholder', '留空允许所有用户；多个 ID 用逗号分隔'));
    const allowGroups = input('text', (instance?.policy?.allowGroupIds || qrDraft?.policy?.allowGroupIds || []).join(', '), labelFor('messaging.allow_groups_placeholder', '留空允许所有群组；多个 ID 用逗号分隔'));
    access.appendChild(fieldRow(labelFor('messaging.allow_users', '用户白名单'), allowUsers));
    access.appendChild(fieldRow(labelFor('messaging.allow_groups', '群组白名单'), allowGroups));
    workspace.appendChild(access);
    form.appendChild(workspace);

    const actions = el('div', 'messaging-detail-actions');
    const saveButton = el('button', 'btn btn-primary', labelFor('messaging.save', '保存配置'));
    saveButton.type = 'submit';
    saveButton.disabled = qrFlowLocked;
    actions.appendChild(saveButton);
    let formCancelButton = null;
    if (!isNew) {
      const healthButton = el('button', 'btn', labelFor('messaging.health_check', '检查连接'));
      healthButton.type = 'button';
      healthButton.addEventListener('click', async () => {
        healthButton.disabled = true;
        setStatus(labelFor('messaging.health_checking', '正在检查…'), false);
        try {
          const result = await invoke('messaging.health', { instanceId: instance.id });
          const nextStatus = result && result.status;
          const message = nextStatus ? statusLabel(nextStatus.kind) : labelFor('messaging.health_failed', '连接检查失败');
          const isError = nextStatus?.kind === 'error';
          await refresh();
          setStatus(message, isError);
        } catch (error) {
          setStatus(errorMessage(error, labelFor('messaging.health_failed', '连接检查失败')), true);
        } finally {
          healthButton.disabled = false;
        }
      });
      actions.appendChild(healthButton);

    } else {
      formCancelButton = el('button', 'btn', labelFor('common.cancel', '取消'));
      formCancelButton.type = 'button';
      formCancelButton.disabled = qrFlowLocked;
      formCancelButton.addEventListener('click', async () => {
        const cancellations = [];
        if (state.feishuQr.flowId || state.feishuQr.starting) {
          cancellations.push(cancelFeishuQrFlow({ silent: true, render: false }));
        }
        if (state.wecomQr.flowId || state.wecomQr.starting || state.wecomQr.completing
          || state.wecomQr.cancelling || state.wecomQr.popup || state.wecomQr.state || state.wecomQr.draft) {
          cancellations.push(cancelWecomQrFlow({ silent: true, render: false }));
        }
        if (cancellations.length) await Promise.all(cancellations);
        state.adding = false;
        state.draftPlatform = '';
        renderCatalog();
        renderDetail(null);
      });
      actions.appendChild(formCancelButton);
    }
    form.appendChild(actions);

    if (!isNew) {
      const deletion = card(
        labelFor('messaging.delete_title', '删除机器人'),
        labelFor('messaging.delete_sub', '移除这个机器人。'),
        'messaging-delete-card',
      );
      deletion.appendChild(deleteButton(instance));
      form.appendChild(deletion);
    }

    const statusNode = el('div', 'messaging-detail-status', '');
    statusNode.id = 'messaging-detail-status';
    form.appendChild(statusNode);
    root.appendChild(form);
    hydrateMessagingIcons();

    if (qrFlowLocked) {
      [nameInput, telegramToken, feishuAppId, feishuAppSecret, feishuTenantToken,
        wecomBotId, wecomBotSecret, replyMode, mentionToggle, workspaceType, projectInput, allowUsers, allowGroups]
        .forEach((control) => { control.disabled = true; });
      if (formCancelButton) formCancelButton.disabled = true;
    }

    const syncRows = () => {
      telegramRow.hidden = platform !== 'telegram';
      feishuAppIdRow.hidden = platform !== 'feishu_lark';
      feishuSecretRow.hidden = platform !== 'feishu_lark';
      feishuTenantRow.hidden = platform !== 'feishu_lark';
      wecomBotIdRow.hidden = platform !== 'wecom';
      wecomBotSecretRow.hidden = platform !== 'wecom';
      projectRow.hidden = workspaceType.value !== 'project';
    };
    workspaceType.addEventListener('change', syncRows);
    syncRows();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      saveButton.disabled = true;
      setStatus(labelFor('messaging.saving', '正在保存…'), false);
      try {
        const users = allowUsers.value.split(',').map((value) => value.trim()).filter(Boolean);
        const groups = allowGroups.value.split(',').map((value) => value.trim()).filter(Boolean);
        const payload = {
          displayName: nameInput.value,
          workspace: workspaceType.value === 'project'
            ? { type: 'project', projectId: projectInput.value }
            : { type: 'default' },
          policy: {
            replyMode: replyMode.value,
            allowUserIds: users,
            allowGroupIds: groups,
            requireMentionInGroups: mentionToggle.checked,
          },
        };
        let result;
        if (isNew) {
          const secret = manualSecretForPlatform(platform, {
            telegramToken,
            feishuAppId,
            feishuAppSecret,
            feishuTenantToken,
            wecomBotId,
            wecomBotSecret,
          }, true);
          result = await invoke('messaging.create', { platform, ...payload, secret });
        } else {
          const secret = manualSecretForPlatform(platform, {
            telegramToken,
            feishuAppId,
            feishuAppSecret,
            feishuTenantToken,
            wecomBotId,
            wecomBotSecret,
          }, false);
          result = await invoke('messaging.update', { instanceId: instance.id, ...payload, ...(secret ? { secret } : {}) });
        }
        if (!result || !result.instance || typeof result.instance.id !== 'string') {
          throw new Error(labelFor('messaging.save_failed', '保存失败'));
        }
        state.selectedId = result.instance.id;
        state.adding = false;
        state.draftPlatform = '';
        await refresh();
        setStatus(labelFor('messaging.saved', '已保存'), false);
      } catch (error) {
        setStatus(errorMessage(error, labelFor('messaging.save_failed', '保存失败')), true);
      } finally {
        saveButton.disabled = isNew && (
          (platform === 'feishu_lark' && isFeishuQrLocked())
          || (platform === 'wecom' && isWecomQrLocked())
        );
      }
    });
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    try {
      const [catalogResult, listResult] = await Promise.all([
        invoke('messaging.catalog'),
        invoke('messaging.list'),
      ]);
      state.catalog = Array.isArray(catalogResult?.catalog) ? catalogResult.catalog : [];
      state.instances = Array.isArray(listResult?.instances) ? listResult.instances : [];
      if (!state.instances.some((item) => item.id === state.selectedId)) state.selectedId = '';
      renderList();
      renderCatalog();
      renderDetail(state.adding ? null : currentInstance());
      const shell = document.getElementById('messaging-settings-shell');
      if (typeof applyDomI18n === 'function') applyDomI18n(shell || document);
      if (typeof hydrateUiIcons === 'function') hydrateUiIcons(shell || document);
    } catch (error) {
      const list = document.getElementById('messaging-instance-list');
      const label = document.getElementById('messaging-configured-title');
      if (list) {
        list.hidden = false;
        list.replaceChildren(el('div', 'settings-empty is-error', errorMessage(error, labelFor('messaging.load_failed', '消息平台配置加载失败'))));
      }
      if (label) label.hidden = false;
    } finally {
      state.loading = false;
    }
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    document.getElementById('messaging-add-btn')?.addEventListener('click', () => {
      discardActiveQrFlows();
      state.selectedId = '';
      state.adding = true;
      state.draftPlatform = '';
      renderList();
      renderCatalog();
      renderDetail(null);
    });
    window.addEventListener('i18n-change', () => {
      if (document.getElementById('panel-settings')?.classList.contains('is-active')) {
        renderList();
        renderCatalog();
        renderDetail(state.adding ? null : currentInstance());
      }
    });
  }

  window.initMessagingSettings = async function initMessagingSettings() {
    bind();
    await refresh();
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      isValidWecomAuthorizationUrl,
      manualSecretForPlatform,
      validateWecomAuthPayload,
      __test: {
        beginWecomQrActivation,
        handleWecomQrMessage,
        state,
      },
    };
  }
})();
