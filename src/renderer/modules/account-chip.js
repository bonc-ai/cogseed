// ─── 左下角共享 UserMenu（个人身份 + 设置）──────────────────────────────
// Sidebar footer 唯一常驻入口。展示结构由 ui-user-menu.js 统一生成，
// 与 Settings › 账号 tab 共享同一套 Hub 交互后端：
//   - 只消费既有 IPC 通道（hub-account.status / start_login / logout / me），
//     不新增、不修改主进程或 Hub 服务交互；
//   - 登录完成同样靠 `hub-account:login-result` 推送（preload 的 onPushEvent
//     允许同一 channel 多个监听，与本模块并存的 hub-account.js 互不影响）；
//   - token 永不过 IPC 边界，本模块只读 renderer-safe 的 status DTO。
//
// 交互模型：
//   - 单击入口 = 展开面板，再单击 = 收起；展开后保持打开，直到再点入口、
//     点击面板外或按 Esc；
//   - hover 只做入口视觉高亮，不触发任何开合——原 hover 延迟开合与「钉住」
//     概念已移除，入口不再出现 pin 图标；
//   - 三态一致：未登录 / 已登录 / Hub 不可用，入口都先表达本地个人工作空间；
//     Hub 登录是菜单动作，不再把整个左下角入口伪装成服务状态按钮；
//   - 键盘 Enter/Space 在入口上切换展开，Tab 可在面板项间移动，
//     Esc 关闭并把焦点还给入口；
//   - 原独立「设置」按钮并入面板（各态均保留），设置视图的 active 高亮由
//     boot.js 通过 window.setChipSettingsActive 同步到面板设置项；
//   - Hub status 拿不到/不可达时降级为「设置」形态，面板仅含本地功能，
//     保证设置入口永不丢失（含侧栏折叠态，见 style.css）。
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
  status: null,          // HubStatusView | null（null = 拿不到，降级形态）
  mode: 'signed-out',    // 'signed-out' | 'signing-in' | 'signed-in'
  signInStartedAt: 0,
  signInTimeout: null,
  lastFocusRefresh: 0,
  meCache: { at: 0, displayName: null },
  // ── 融合面板交互（点击开合，无 hover / 钉住状态）──
  isOpen: false,
  settingsActive: false, // 当前视图是否为 settings（boot.js 同步）
};

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

function _chipIdentity(status, mode) {
  const signedIn = mode === 'signed-in' && status && status.signed_in;
  if (mode === 'signing-in') {
    return {
      name: t('hub.chip.signing_in'),
      description: t('hub.chip.signing_in_sub'),
      avatar: { icon: 'loader', variant: 'spin' },
    };
  }
  if (signedIn) {
    const maskedId = _chipMaskId(status.account_id || '');
    const initial = String(status.account_id || '?').trim().charAt(0).toUpperCase() || '?';
    return {
      name: maskedId,
      description: t('hub.chip.personal_workspace'),
      avatar: { text: initial, variant: 'gradient', role: 'avatar' },
      nameRole: 'name',
    };
  }
  const localName = t('hub.chip.local_user');
  return {
    name: localName,
    description: t('hub.chip.personal_workspace'),
    avatar: { text: String(localName).trim().charAt(0).toUpperCase() || '?', variant: 'gradient' },
  };
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
  const identity = _chipIdentity(status, mode);

  root.innerHTML = `
    ${window.uiUserMenuTrigger({
      id: 'hub-account-chip',
      open: _chipState.isOpen,
      disabled: mode === 'signing-in',
      name: identity.name,
      description: identity.description,
      nameRole: identity.nameRole,
      avatar: identity.avatar,
      ariaLabel: t('hub.chip.user_menu_label', { name: identity.name }),
    })}
    <div class="hub-chip-menu" id="hub-account-chip-menu" role="menu"${_chipState.isOpen && _chipState.mode !== 'signing-in' ? '' : ' hidden'}></div>`;

  const chip = root.querySelector('#hub-account-chip');
  chip.addEventListener('click', () => _onChipClick(chip));
  chip.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    void _openMenu(event.key === 'ArrowUp' ? 'last' : 'first');
  });
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
        chip.setAttribute('aria-label', t('hub.chip.user_menu_label', { name: displayName }));
      }
    });
  }

  // 重建入口会清掉已展开的面板：若仍处于展开态（点击展开后保持），立即恢复。
  if (_chipState.isOpen && _chipState.mode !== 'signing-in') _openMenu();
}

async function _renderMenu() {
  const root = _chipRoot();
  const menu = root && root.querySelector('#hub-account-chip-menu');
  if (!menu) return;
  const status = _chipState.status;
  const degraded = _chipDegraded();

  const identity = _chipIdentity(status, _chipState.mode);
  const items = [{
    action: 'settings',
    label: t('hub.chip.menu.settings'),
    icon: 'settings',
    active: _chipState.settingsActive,
  }];

  if (degraded) {
    menu.innerHTML = window.uiUserMenuPanel({
      ...identity,
      note: { icon: 'warning', label: t('hub.chip.menu.hub_unavailable') },
      items,
    });
    _bindMenuActions(menu);
    return;
  }

  if (_chipState.mode === 'signed-out') {
    items.push({
      action: 'sign-in',
      label: t('hub.chip.sign_in'),
      icon: 'user',
      separatorBefore: true,
    });
    menu.innerHTML = window.uiUserMenuPanel({ ...identity, items });
    _bindMenuActions(menu);
    return;
  }

  // 已登录：账号头部 + 设置 + 退出 + 收起。
  // P3394 ACCOUNT-01/03：菜单只保留当前账号状态、设置、退出登录；
  // 不再提供「账号概览」「登录设备」入口，也不展示 LocalIdentity 绑定状态。
  const displayName = await _chipDisplayName();
  if (displayName) {
    identity.name = displayName;
    identity.avatar = { text: String(displayName).trim().charAt(0).toUpperCase() || '?', variant: 'gradient' };
  }
  items.push({
    action: 'sign-out',
    label: t('hub.account.sign_out'),
    icon: 'log-out',
    danger: true,
    separatorBefore: true,
  });
  menu.innerHTML = window.uiUserMenuPanel({ ...identity, items });
  _bindMenuActions(menu);
}

function _bindMenuActions(menu) {
  menu.querySelectorAll('[data-chip-action]').forEach((item) => {
    item.addEventListener('click', () => void _onMenuAction(item.dataset.chipAction));
  });
}

// ── 展开 / 收起（点击切换，无 hover / 延迟 / 钉住逻辑）──────────────────

function _closeMenu() {
  _chipState.isOpen = false;
  const root = _chipRoot();
  if (root) root.classList.remove('is-open');
  const menu = root && root.querySelector('#hub-account-chip-menu');
  const chip = root && root.querySelector('#hub-account-chip');
  if (menu) menu.hidden = true;
  if (chip) chip.setAttribute('aria-expanded', 'false');
}

async function _openMenu(focusTarget = '') {
  const root = _chipRoot();
  const menu = root && root.querySelector('#hub-account-chip-menu');
  const chip = root && root.querySelector('#hub-account-chip');
  if (!menu || !chip) return;
  if (_chipState.mode === 'signing-in') return;
  _chipState.isOpen = true;
  if (root) root.classList.add('is-open');
  menu.hidden = false;
  chip.setAttribute('aria-expanded', 'true');
  await _renderMenu();
  if (focusTarget) {
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    const target = focusTarget === 'last' ? items[items.length - 1] : items[0];
    if (target && typeof target.focus === 'function') target.focus();
  }
}

// ── 交互 ─────────────────────────────────────────────────────────────────

/** 单击入口：展开 / 收起切换（三态统一；signing-in 期间忽略）。 */
function _onChipClick(_chip) {
  if (_chipState.mode === 'signing-in') return;
  if (_chipState.isOpen) _closeMenu();
  else _openMenu();
}

async function _startLogin() {
  if (_chipState.mode === 'signing-in') return;
  _closeMenu();
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
  // 展开中的面板不因刷新关闭：_renderChip 会按 isOpen 恢复并重渲染内容。
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
  if (action === 'sign-in') {
    void _startLogin();
    return;
  }
  if (action === 'settings') {
    // 与面板设置项同路径：只切视图，不指定 tab（默认 tab）。
    if (typeof window.setView === 'function') window.setView('settings');
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

  // 语言切换后重渲染（文案与设置页同步更新；面板展开中也会重建并恢复）。
  window.addEventListener('i18n-change', () => _renderChip());

  // 点击入口外区域或 Esc 关闭面板。
  document.addEventListener('click', (e) => {
    if (!root || root.contains(e.target)) return;
    _closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape' && _chipState.isOpen) {
      _closeMenu();
      const chip = root && root.querySelector('#hub-account-chip');
      if (chip) chip.focus();
      return;
    }
    if (!_chipState.isOpen || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const menu = root && root.querySelector('#hub-account-chip-menu');
    if (!menu || !menu.contains(e.target)) return;
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    if (!items.length) return;
    const current = items.indexOf(e.target);
    let next = current;
    if (e.key === 'ArrowDown') next = (current + 1 + items.length) % items.length;
    else if (e.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    e.preventDefault();
    items[next].focus();
  });
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
