// ─── 左下角 Hub 账号常驻入口（方案 A）──────────────────────────────────────
// Sidebar footer 的账号区。与 Settings › 账号 tab 共享同一套 Hub 交互后端：
//   - 只消费既有 IPC 通道（hub-account.status / start_login / logout / me），
//     不新增、不修改主进程或 Hub 服务交互；
//   - 登录完成同样靠 `hub-account:login-result` 推送（preload 的 onPushEvent
//     允许同一 channel 多个监听，与本模块并存的 hub-account.js 互不影响）；
//   - token 永不过 IPC 边界，本模块只读 renderer-safe 的 status DTO。
//
// 本模块常驻加载（不随 settings lazy feature）；hub-account.js 是 settings
// feature 的一部分，两者不互相依赖，仅共享 IPC 通道与推送事件。

const _chipLog = createLogger('hub-account:chip');

// 登录中的最长等待：超过后回退到未登录态（登录结果推送迟到/丢失时兜底）。
const _SIGN_IN_TIMEOUT_MS = 3 * 60 * 1000;
// focus 触发刷新的最小间隔：status 会打一次 Hub healthz，避免窗口反复
// 聚焦时高频请求后端。
const _FOCUS_REFRESH_MIN_MS = 15 * 1000;
// display_name 缓存时长（hub-account.me 是额外网络请求，仅菜单打开时用）。
const _ME_CACHE_MS = 60 * 1000;

const _chipState = {
  status: null,          // HubStatusView | null（null = 拿不到，隐藏入口）
  mode: 'signed-out',    // 'signed-out' | 'signing-in' | 'signed-in'
  signInStartedAt: 0,
  signInTimeout: null,
  lastFocusRefresh: 0,
  meCache: { at: 0, displayName: null },
};

/** Render a UI icon by name (single source: modules/icons.js — no emoji). */
function _chipIcon(name, className) {
  const html = window.uiIconHtml ? window.uiIconHtml(name, className) : '';
  return html || `<span class="${className || 'ui-icon'}"></span>`;
}

function _chipEscapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Mask long ids for display (e.g. cogseed_acc_abc123 → cogseed_acc_***123). */
function _chipMaskId(id) {
  if (!id) return '';
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}***${id.slice(-4)}`;
}

async function _chipInvoke(channel, payload) {
  const res = await window.cogseed.invoke(channel, payload || {});
  if (!res || !res.ok) {
    throw new Error((res && (res.error || res.code)) || `${channel} failed`);
  }
  return res;
}

async function _chipStatus() {
  const res = await _chipInvoke('hub-account.status');
  return res.status;
}

/** 打开菜单时异步补 display_name（hub-account.me，60s 缓存，失败静默）。 */
async function _chipDisplayName() {
  const cache = _chipState.meCache;
  if (cache.displayName && Date.now() - cache.at < _ME_CACHE_MS) return cache.displayName;
  try {
    const res = await _chipInvoke('hub-account.me');
    const name = res.me && res.me.account && res.me.account.community_profile
      ? (res.me.account.community_profile.display_name || null)
      : null;
    cache.at = Date.now();
    cache.displayName = name;
    return name;
  } catch (err) {
    _chipLog.warn('hub me fetch failed (display name unavailable)', { error: (err && err.message) || String(err) });
    return null;
  }
}

// ── 渲染 ─────────────────────────────────────────────────────────────────

function _chipRoot() {
  return document.getElementById('hub-account-chip-root');
}

function _chipStatusDotClass() {
  const s = _chipState.status;
  if (!s) return 'off';
  if (_chipState.mode === 'signing-in') return 'warn';
  if (s.hub_reachable === false) return 'warn';
  return 'on';
}

function _renderChip() {
  const root = _chipRoot();
  if (!root) return;

  const status = _chipState.status;
  // 拿不到 status：保持隐藏（与设置页 unavailable 空态对应的最保守行为），
  // 绝不影响侧边栏其余布局。
  if (!status) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  root.hidden = false;

  const mode = _chipState.mode;
  const signedIn = mode === 'signed-in' && status.signed_in;

  let inner = '';
  if (mode === 'signing-in') {
    inner = `
      <span class="hub-chip-avatar is-spin">${_chipIcon('loader', 'hub-chip-avatar-icon')}</span>
      <span class="hub-chip-meta">
        <span class="hub-chip-name">${_chipEscapeHtml(t('hub.chip.signing_in'))}</span>
        <span class="hub-chip-sub">${_chipEscapeHtml(t('hub.chip.signing_in_sub'))}</span>
      </span>
      <span class="hub-chip-dot warn" aria-hidden="true"></span>`;
  } else if (signedIn) {
    const maskedId = _chipMaskId(status.account_id || '');
    const initial = String(status.account_id || '?').trim().charAt(0).toUpperCase() || '?';
    inner = `
      <span class="hub-chip-avatar is-gradient" aria-hidden="true">${_chipEscapeHtml(initial)}</span>
      <span class="hub-chip-meta">
        <span class="hub-chip-name" data-chip-role="name">${maskedId}</span>
        <span class="hub-chip-sub">${maskedId}</span>
      </span>
      <span class="hub-chip-dot ${_chipStatusDotClass()}" aria-hidden="true"></span>
      <span class="hub-chip-chev">${_chipIcon('chevron-down')}</span>`;
  } else {
    inner = `
      <span class="hub-chip-avatar">${_chipIcon('user', 'hub-chip-avatar-icon')}</span>
      <span class="hub-chip-meta">
        <span class="hub-chip-name">${_chipEscapeHtml(t('hub.chip.sign_in'))}</span>
        <span class="hub-chip-sub is-accent">${_chipEscapeHtml(t('hub.chip.signed_out_sub'))}</span>
      </span>
      <span class="hub-chip-dot ${_chipStatusDotClass()}" aria-hidden="true"></span>`;
  }

  root.innerHTML = `
    <button type="button" class="hub-chip${signedIn ? ' is-signed-row' : ''}" id="hub-account-chip"
            aria-haspopup="menu" aria-expanded="false"${mode === 'signing-in' ? ' disabled' : ''}>${inner}</button>
    <div class="hub-chip-menu" id="hub-account-chip-menu" hidden></div>`;

  const chip = root.querySelector('#hub-account-chip');
  chip.addEventListener('click', () => _onChipClick(chip));
  // 服务不可达时给整条入口一个解释性 tooltip。
  if (status.hub_reachable === false && !signedIn && mode !== 'signing-in') {
    chip.setAttribute('title', t('hub.account.hub_unreachable'));
  }

  // 已登录：异步补 display_name（复用 60s 缓存的 hub-account.me 通道，
  // 失败静默保持脱敏 ID；渲染可能已切换状态，先回读再写）。
  if (signedIn) {
    void _chipDisplayName().then((displayName) => {
      const rootNow = _chipRoot();
      const nameEl = rootNow && rootNow.querySelector('[data-chip-role="name"]');
      const avatarEl = rootNow && rootNow.querySelector('.hub-chip-avatar.is-gradient');
      if (!nameEl || !avatarEl) return; // 状态已变化，放弃更新
      if (displayName) {
        nameEl.textContent = displayName;
        avatarEl.textContent = String(displayName).trim().charAt(0).toUpperCase() || avatarEl.textContent;
      }
    });
  }
}

async function _renderMenu() {
  const root = _chipRoot();
  const menu = root && root.querySelector('#hub-account-chip-menu');
  if (!menu) return;
  const status = _chipState.status;

  const maskedId = _chipMaskId((status && status.account_id) || '');
  const displayName = await _chipDisplayName();
  const name = displayName || maskedId;
  const bound = status && status.bound
    ? _chipEscapeHtml(t('hub.account.bound_local'))
    : _chipEscapeHtml(t('hub.account.not_bound'));

  menu.innerHTML = `
    <div class="hub-chip-menu-head">
      <span class="hub-chip-avatar is-signed">${_chipIcon('user', 'hub-chip-avatar-icon')}</span>
      <div class="hub-chip-menu-id">
        <span class="hub-chip-menu-name">${_chipEscapeHtml(name)}</span>
        <span class="hub-chip-menu-sub">${_chipEscapeHtml(maskedId)} · ${bound}</span>
      </div>
    </div>
    <button type="button" class="hub-chip-menu-item" data-chip-action="open-settings">
      ${_chipIcon('settings', 'hub-chip-menu-item-icon')}${_chipEscapeHtml(t('hub.chip.menu.open_settings'))}
    </button>
    <button type="button" class="hub-chip-menu-item" data-chip-action="open-templates">
      ${_chipIcon('layout', 'hub-chip-menu-item-icon')}${_chipEscapeHtml(t('hub.chip.menu.templates', '模板'))}
    </button>
    <button type="button" class="hub-chip-menu-item" data-chip-action="open-usage">
      ${_chipIcon('credit-card', 'hub-chip-menu-item-icon')}${_chipEscapeHtml(t('hub.chip.menu.usage', '额度'))}
    </button>`;

  menu.querySelectorAll('[data-chip-action]').forEach((item) => {
    item.addEventListener('click', () => void _onMenuAction(item.dataset.chipAction));
  });
  menu.hidden = false;
}

function _closeMenu() {
  const root = _chipRoot();
  const menu = root && root.querySelector('#hub-account-chip-menu');
  const chip = root && root.querySelector('#hub-account-chip');
  if (menu && !menu.hidden) menu.hidden = true;
  if (chip) chip.setAttribute('aria-expanded', 'false');
}

function _openMenu() {
  const chip = _chipRoot() && _chipRoot().querySelector('#hub-account-chip');
  if (chip) chip.setAttribute('aria-expanded', 'true');
  void _renderMenu();
}

// ── 交互 ─────────────────────────────────────────────────────────────────

function _onChipClick(chip) {
  const status = _chipState.status;
  if (!status) return;
  if (_chipState.mode === 'signing-in') return;

  if (_chipState.mode === 'signed-in' && status.signed_in) {
    const menu = _chipRoot() && _chipRoot().querySelector('#hub-account-chip-menu');
    if (menu && !menu.hidden) _closeMenu();
    else _openMenu();
    return;
  }
  void _startLogin(chip);
}

async function _startLogin(chip) {
  if (_chipState.mode === 'signing-in') return;
  _setSigningIn();
  try {
    // 与设置页完全相同的调用：打开浏览器授权页即返回，真正完成靠
    // hub-account:login-result 推送。
    await _chipInvoke('hub-account.start_login');
  } catch (err) {
    _chipLog.warn('hub sign-in start failed', { error: (err && err.message) || String(err) });
    _setSignedOut();
    window.alert((err && err.message) || t('hub.account.error_start'));
  }
}

function _setSigningIn() {
  _chipState.mode = 'signing-in';
  _chipState.signInStartedAt = Date.now();
  if (_chipState.signInTimeout) clearTimeout(_chipState.signInTimeout);
  _chipState.signInTimeout = setTimeout(() => {
    if (_chipState.mode === 'signing-in') {
      _chipLog.warn('hub sign-in timed out (no login-result push)', {});
      _setSignedOut();
    }
  }, _SIGN_IN_TIMEOUT_MS);
  _renderChip();
}

function _setSignedOut() {
  _chipState.mode = 'signed-out';
  _chipState.signInStartedAt = 0;
  if (_chipState.signInTimeout) { clearTimeout(_chipState.signInTimeout); _chipState.signInTimeout = null; }
  _renderChip();
}

function _setSignedIn() {
  _chipState.mode = 'signed-in';
  if (_chipState.signInTimeout) { clearTimeout(_chipState.signInTimeout); _chipState.signInTimeout = null; }
}

async function _refresh() {
  let status = null;
  try {
    status = await _chipStatus();
  } catch (err) {
    _chipLog.warn('hub chip status refresh failed', { error: (err && err.message) || String(err) });
  }
  _chipState.status = status;
  if (status && status.signed_in) {
    _setSignedIn();
  } else {
    // 刷新到的状态不是"已登录"（登出/注销/会话失效）：统一回到未登录态，
    // 同时清掉可能残留的登录中兜底计时器。
    _setSignedOut();
  }
  _closeMenu();
  _renderChip();
}

async function _onMenuAction(action) {
  _closeMenu();
  if (action === 'sign-out') {
    if (!window.confirm(t('hub.account.sign_out_confirm'))) return;
    try {
      await _chipInvoke('hub-account.logout');
      _chipState.meCache = { at: 0, displayName: null };
      await _refresh();
    } catch (err) {
      _chipLog.warn('hub sign-out failed', { error: (err && err.message) || String(err) });
      window.alert((err && err.message) || t('hub.account.error_sign_out'));
    }
    return;
  }
  // 本地菜单：设置 / 模板 / 额度。
  const goSettings = (tab) => {
    if (typeof window.setView === 'function') window.setView('settings');
    else document.getElementById('settings-btn')?.click();
    if (typeof window.activateSettingsTab === 'function') {
      window.activateSettingsTab(tab || 'general');
    }
  };
  if (action === 'open-templates') {
    // 模板：进入「认知资产」页（角色模板 / 个人本体区）。
    if (typeof window.setView === 'function') window.setView('recall');
    return;
  }
  if (action === 'open-usage') {
    // 额度：设置 › 账号与用量。
    goSettings('usage');
    return;
  }
  // open-settings（默认）：设置页。
  goSettings('general');
}

// ── 生命周期 ─────────────────────────────────────────────────────────────

function _initChip() {
  if (!_chipRoot()) return;

  // 启动即刷新一次（status 通道不带 token，主进程侧做 healthz）。
  void _refresh();

  // 登录完成/失败推送 —— 与 hub-account.js 订阅同一 channel；preload 的
  // onPushEvent 每调用一次都注册独立 listener，两者互不干扰。
  if (window.cogseed && typeof window.cogseed.onPushEvent === 'function') {
    try {
      window.cogseed.onPushEvent('hub-account:login-result', (outcome) => {
        _chipLog.info('hub chip login result received', {
          result: (outcome && outcome.result) || 'unknown',
          code: (outcome && outcome.code) || undefined,
        });
        if (outcome && outcome.result === 'success') _setSignedIn();
        else _setSignedOut();
        void _refresh();
      });
    } catch (err) {
      _chipLog.warn('hub chip login result subscription failed', { error: (err && err.message) || String(err) });
    }

    // 状态变更广播：登出/注销可能发生在设置-账号页等其它表面，
    // 这里收到后立即刷新，保持左下角与设置页状态一致。
    try {
      window.cogseed.onPushEvent('hub-account:state-changed', (change) => {
        _chipLog.info('hub chip state change received', { reason: (change && change.reason) || 'unknown' });
        void _refresh();
      });
    } catch (err) {
      _chipLog.warn('hub chip state change subscription failed', { error: (err && err.message) || String(err) });
    }
  }

  // 深链回调会把窗口带回前台：补一次刷新（节流，避免 healthz 高频）。
  window.addEventListener('focus', () => {
    const now = Date.now();
    if (now - _chipState.lastFocusRefresh < _FOCUS_REFRESH_MIN_MS) return;
    _chipState.lastFocusRefresh = now;
    void _refresh();
  });

  // 语言切换后重渲染（文案与设置页同步更新）。
  window.addEventListener('i18n-change', () => _renderChip());

  // 点击入口外区域或 Esc 关闭菜单。
  document.addEventListener('click', (e) => {
    const root = _chipRoot();
    if (!root || root.contains(e.target)) return;
    _closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') _closeMenu();
  });
}

_initChip();
