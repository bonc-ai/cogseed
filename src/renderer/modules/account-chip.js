// ─── 左下角融合入口（用户状态 + 设置，方案：hover 向上展开面板）─────────────
// Sidebar footer 唯一常驻入口。与 Settings › 账号 tab 共享同一套 Hub 交互后端：
//   - 只消费既有 IPC 通道（hub-account.status / start_login / logout / me），
//     不新增、不修改主进程或 Hub 服务交互；
//   - 登录完成同样靠 `hub-account:login-result` 推送（preload 的 onPushEvent
//     允许同一 channel 多个监听，与本模块并存的 hub-account.js 互不影响）；
//   - token 永不过 IPC 边界，本模块只读 renderer-safe 的 status DTO。
//
// 交互模型（与 docs/design/sidebar-user-menu-merged-prototype.html 一致）：
//   - hover 进入入口 150ms 后向上展开面板；面板与入口无缝衔接（重叠 6px），
//     指针在两者之间移动不会闪断；
//   - 离开「入口 + 面板」整体 220ms 后收起，期间回移取消；已钉住不收起；
//   - 单击入口 = 钉住 / 取消钉住（未登录时单击仍直接进入登录流程）；
//   - 键盘 focus/Enter 同样展开，Esc 关闭并取消钉住；
//   - 原独立「设置」按钮并入面板（sign-in 各态均保留），设置视图的 active
//     高亮由 boot.js 通过 window.setChipSettingsActive 同步到面板设置项；
//   - Hub status 拿不到/不可达时降级为「设置」形态，面板仅含本地功能，
//     保证设置入口永不丢失。
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
// 面板展开 / 收起的 hover 延迟（防路过误触；回移取消收起）。
const _PANEL_OPEN_MS = 150;
const _PANEL_CLOSE_MS = 220;

const _chipState = {
  status: null,          // HubStatusView | null（null = 拿不到，降级形态）
  mode: 'signed-out',    // 'signed-out' | 'signing-in' | 'signed-in'
  signInStartedAt: 0,
  signInTimeout: null,
  lastFocusRefresh: 0,
  meCache: { at: 0, displayName: null },
  // ── 融合面板交互 ──
  isOpen: false,
  isPinned: false,
  isHovering: false,
  isFocusing: false,
  openTimer: null,
  closeTimer: null,
  settingsActive: false, // 当前视图是否为 settings（boot.js 同步）
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

/** 降级形态：status 拿不到，或服务不可达且未登录（账号功能不可用）。 */
function _chipDegraded() {
  const s = _chipState.status;
  if (!s) return true;
  if (s.hub_reachable === false && _chipState.mode !== 'signed-in') return true;
  return false;
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
  if (!s) return 'warn';
  if (_chipState.mode === 'signing-in') return 'warn';
  if (s.hub_reachable === false) return 'warn';
  return 'on';
}

function _renderChip() {
  const root = _chipRoot();
  if (!root) return;

  // 融合入口任何状态都常驻（status 拿不到时降级为「设置」形态），
  // 绝不影响侧边栏其余布局。
  root.hidden = false;

  const status = _chipState.status;
  const mode = _chipState.mode;
  const signedIn = mode === 'signed-in' && status && status.signed_in;
  const degraded = _chipDegraded();
  const pinIcon = _chipState.isPinned
    ? `<span class="hub-chip-pin" data-chip-role="pin">${_chipIcon('pin')}</span>`
    : '';

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
      ${pinIcon}
      <span class="hub-chip-chev">${_chipIcon('chevron-down')}</span>`;
  } else if (degraded) {
    inner = `
      <span class="hub-chip-avatar is-signed">${_chipIcon('settings', 'hub-chip-avatar-icon')}</span>
      <span class="hub-chip-meta">
        <span class="hub-chip-name">${_chipEscapeHtml(t('hub.chip.degraded_name'))}</span>
        <span class="hub-chip-sub">${_chipEscapeHtml(t('hub.chip.degraded_sub'))}</span>
      </span>
      <span class="hub-chip-dot warn" aria-hidden="true"></span>
      ${pinIcon}
      <span class="hub-chip-chev">${_chipIcon('chevron-down')}</span>`;
  } else {
    inner = `
      <span class="hub-chip-avatar">${_chipIcon('user', 'hub-chip-avatar-icon')}</span>
      <span class="hub-chip-meta">
        <span class="hub-chip-name">${_chipEscapeHtml(t('hub.chip.sign_in'))}</span>
        <span class="hub-chip-sub is-accent">${_chipEscapeHtml(t('hub.chip.signed_out_sub'))}</span>
      </span>
      <span class="hub-chip-dot ${_chipStatusDotClass()}" aria-hidden="true"></span>
      <span class="hub-chip-chev">${_chipIcon('chevron-down')}</span>`;
  }

  root.innerHTML = `
    <button type="button" class="hub-chip${signedIn ? ' is-signed-row' : ''}" id="hub-account-chip"
            aria-haspopup="menu" aria-expanded="false"${mode === 'signing-in' ? ' disabled' : ''}>${inner}</button>
    <div class="hub-chip-menu" id="hub-account-chip-menu" role="menu" hidden></div>`;

  const chip = root.querySelector('#hub-account-chip');
  chip.addEventListener('click', () => _onChipClick(chip));
  // 服务不可达时给整条入口一个解释性 tooltip。
  if (status && status.hub_reachable === false && !signedIn && mode !== 'signing-in') {
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

  // 重建入口会清掉已展开的面板：若仍应展开（钉住/悬停/焦点），立即恢复。
  if (_shouldPanelBeOpen()) _openMenu();
}

async function _renderMenu() {
  const root = _chipRoot();
  const menu = root && root.querySelector('#hub-account-chip-menu');
  if (!menu) return;
  const status = _chipState.status;
  const degraded = _chipDegraded();

  const settingsItem = `
    <button type="button" class="hub-chip-menu-item${_chipState.settingsActive ? ' is-active' : ''}" data-chip-action="settings" role="menuitem">
      ${_chipIcon('settings', 'hub-chip-menu-item-icon')}${_chipEscapeHtml(t('hub.chip.menu.settings'))}
    </button>`;

  if (degraded) {
    menu.innerHTML = `
      <div class="hub-chip-menu-note">
        ${_chipIcon('warning', 'hub-chip-menu-note-icon')}${_chipEscapeHtml(t('hub.chip.menu.hub_unavailable'))}
      </div>
      ${settingsItem}`;
    _bindMenuActions(menu);
    return;
  }

  if (_chipState.mode === 'signed-out') {
    menu.innerHTML = `
      <div class="hub-chip-menu-head">
        <span class="hub-chip-avatar is-signed">${_chipIcon('user', 'hub-chip-avatar-icon')}</span>
        <div class="hub-chip-menu-id">
          <span class="hub-chip-menu-name">${_chipEscapeHtml(t('hub.chip.sign_in'))}</span>
          <span class="hub-chip-menu-sub">${_chipEscapeHtml(t('hub.chip.menu.sign_in_sub'))}</span>
        </div>
      </div>
      <button type="button" class="hub-chip-menu-item" data-chip-action="sign-in" role="menuitem">
        ${_chipIcon('external', 'hub-chip-menu-item-icon')}${_chipEscapeHtml(t('hub.account.sign_in'))}
      </button>
      ${settingsItem}`;
    _bindMenuActions(menu);
    return;
  }

  // 已登录：账号头部 + 设置 + 账号管理 + 退出。
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
    ${settingsItem}
    <button type="button" class="hub-chip-menu-item" data-chip-action="overview" role="menuitem">
      ${_chipIcon('info', 'hub-chip-menu-item-icon')}${_chipEscapeHtml(t('hub.chip.menu.overview'))}
    </button>
    <button type="button" class="hub-chip-menu-item" data-chip-action="devices" role="menuitem">
      ${_chipIcon('monitor', 'hub-chip-menu-item-icon')}${_chipEscapeHtml(t('hub.chip.menu.devices'))}
    </button>
    <div class="hub-chip-menu-sep" role="separator"></div>
    <button type="button" class="hub-chip-menu-item is-danger" data-chip-action="sign-out" role="menuitem">
      ${_chipIcon('log-out', 'hub-chip-menu-item-icon')}${_chipEscapeHtml(t('hub.account.sign_out'))}
    </button>`;
  _bindMenuActions(menu);
}

function _bindMenuActions(menu) {
  menu.querySelectorAll('[data-chip-action]').forEach((item) => {
    item.addEventListener('click', () => void _onMenuAction(item.dataset.chipAction));
  });
}

// ── 展开 / 收起调度（hover 延迟 + 无缝衔接 + 钉住）──────────────────────

function _shouldPanelBeOpen() {
  if (_chipState.mode === 'signing-in') return false;
  return _chipState.isHovering || _chipState.isFocusing || _chipState.isPinned;
}

function _scheduleOpen() {
  if (_chipState.closeTimer) { clearTimeout(_chipState.closeTimer); _chipState.closeTimer = null; }
  if (_chipState.isOpen || _chipState.openTimer) return;
  _chipState.openTimer = setTimeout(() => {
    _chipState.openTimer = null;
    _openMenu();
  }, _PANEL_OPEN_MS);
}

function _scheduleClose() {
  if (_chipState.openTimer) { clearTimeout(_chipState.openTimer); _chipState.openTimer = null; }
  if (!_chipState.isOpen || _chipState.closeTimer) return;
  _chipState.closeTimer = setTimeout(() => {
    _chipState.closeTimer = null;
    _closeMenu();
  }, _PANEL_CLOSE_MS);
}

/** 依据 hover / focus / 钉住任一成立来开合面板。 */
function _recompute() {
  if (_shouldPanelBeOpen()) _scheduleOpen();
  else _scheduleClose();
}

function _closeMenu() {
  if (_chipState.openTimer) { clearTimeout(_chipState.openTimer); _chipState.openTimer = null; }
  if (_chipState.closeTimer) { clearTimeout(_chipState.closeTimer); _chipState.closeTimer = null; }
  _chipState.isOpen = false;
  const root = _chipRoot();
  const menu = root && root.querySelector('#hub-account-chip-menu');
  const chip = root && root.querySelector('#hub-account-chip');
  if (menu) menu.hidden = true;
  if (chip) chip.setAttribute('aria-expanded', 'false');
}

/** 立即收起面板；alsoUnpin 时同时取消钉住（Esc / 点击外部 / 面板项动作）。 */
function _closePanel(alsoUnpin) {
  if (alsoUnpin && _chipState.isPinned) {
    _chipState.isPinned = false;
    const root = _chipRoot();
    if (root) root.classList.remove('is-pinned');
    const pinEl = root && root.querySelector('[data-chip-role="pin"]');
    if (pinEl) pinEl.remove();
  }
  _closeMenu();
}

function _openMenu() {
  const root = _chipRoot();
  const menu = root && root.querySelector('#hub-account-chip-menu');
  const chip = root && root.querySelector('#hub-account-chip');
  if (!menu || !chip) return;
  if (_chipState.mode === 'signing-in') return;
  _chipState.isOpen = true;
  menu.hidden = false;
  chip.setAttribute('aria-expanded', 'true');
  void _renderMenu();
}

// ── 交互 ─────────────────────────────────────────────────────────────────

function _onChipClick(chip) {
  const status = _chipState.status;
  if (_chipState.mode === 'signing-in') return;

  if (_chipState.mode === 'signed-in' && status && status.signed_in) {
    _togglePin();
    return;
  }
  if (_chipDegraded()) {
    // 降级形态：单击 = 钉住/取消钉住（面板只有本地功能）。
    _togglePin();
    return;
  }
  void _startLogin(chip);
}

function _togglePin() {
  _chipState.isPinned = !_chipState.isPinned;
  const root = _chipRoot();
  if (root) root.classList.toggle('is-pinned', _chipState.isPinned);
  // 重建入口以更新钉住图标（_renderChip 末尾会按需恢复面板）。
  _renderChip();
  _recompute();
}

async function _startLogin(chip) {
  if (_chipState.mode === 'signing-in') return;
  _closePanel(true);
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
  _closePanel(true);
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
  if (action === 'sign-in') {
    const chip = _chipRoot() && _chipRoot().querySelector('#hub-account-chip');
    void _startLogin(chip);
    return;
  }
  if (action === 'settings') {
    // 与原独立设置按钮同路径：只切视图，不指定 tab（默认 tab）。
    if (typeof window.setView === 'function') window.setView('settings');
    return;
  }
  // overview / devices：落到 设置 › 账号 tab（完整管理面），
  // 与 settings_tabs.js 的 activateSettingsTab 组合使用。
  if (typeof window.setView === 'function') window.setView('settings');
  if (typeof window.activateSettingsTab === 'function') {
    window.activateSettingsTab('account');
  }
}

// ── 生命周期 ─────────────────────────────────────────────────────────────

function _initChip() {
  const root = _chipRoot();
  if (!root) return;

  // 初始 settings 高亮：读当前视图 DOM（boot.js 后续每次切视图都会同步）。
  _chipState.settingsActive =
    !!document.getElementById('panel-settings')?.classList.contains('active');

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

  // 语言切换后重渲染（文案与设置页同步更新；面板展开中也会重建）。
  window.addEventListener('i18n-change', () => _renderChip());

  // ── 面板开合：hover 热区 = 整个入口容器（入口 + 面板无缝衔接）──
  root.addEventListener('mouseenter', () => { _chipState.isHovering = true; _recompute(); });
  root.addEventListener('mouseleave', () => { _chipState.isHovering = false; _recompute(); });
  root.addEventListener('focusin', () => { _chipState.isFocusing = true; _recompute(); });
  root.addEventListener('focusout', (e) => {
    if (!root.contains(e.relatedTarget)) { _chipState.isFocusing = false; _recompute(); }
  });

  // 点击入口外区域或 Esc 关闭面板并取消钉住。
  document.addEventListener('click', (e) => {
    if (!root || root.contains(e.target)) return;
    _closePanel(true);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (_chipState.isOpen || _chipState.isPinned)) {
      _closePanel(true);
      const chip = root && root.querySelector('#hub-account-chip');
      if (chip) chip.focus();
    }
  });

  // 会话列表滚动时收起未钉住的面板，避免面板悬在内容上方遮挡。
  const convList = document.getElementById('conversation-list');
  if (convList) {
    convList.addEventListener('scroll', () => {
      if (_chipState.isOpen && !_chipState.isPinned) _closePanel(false);
    });
  }
}

// boot.js 在视图切换时同步 settings 高亮到面板设置项（DOM 级更新，不重建面板）。
window.setChipSettingsActive = function (active) {
  _chipState.settingsActive = !!active;
  const root = _chipRoot();
  const menu = root && root.querySelector('#hub-account-chip-menu');
  const item = menu && menu.querySelector('[data-chip-action="settings"]');
  if (item) item.classList.toggle('is-active', !!active);
};

_initChip();
