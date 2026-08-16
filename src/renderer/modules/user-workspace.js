// ─── 工作空间选择器（空间化重构：由「文件夹工作区」改为「空间选择」）───
// Adds a "工作空间" chip to the bottom bar of chat input toolbars
// (new-chat + conversation). Clicking opens a dropdown listing the user's
// spaces (plus a "默认工作区" entry):
//   - conversation panel: picking a space binds the current conversation to it
//     (`conversations.setSpace`); picking "默认工作区" unbinds (→ 最近任务).
//   - new-chat panel: picking a space remembers it for the NEXT new chat
//     (created with that space_id, persisted in localStorage); "默认工作区"
//     = no space (orphan → 最近任务).
// The old "folder workspace" concept is gone (replaced by spaces).

const _wsLog = (typeof createLogger === 'function')
  ? createLogger('user-workspace')
  : { info() {}, warn() {}, error() {} };

// ── State ──────────────────────────────────────────────────────────────

/** 空间列表缓存（spaces.list，含派生 meta）。 */
let _spacesCache = [];
let _spacesLoading = null;

/** new-chat 面板选中的空间 id（后续新对话创建带 space_id）；localStorage 持久化。 */
const _NEW_CHAT_SPACE_KEY = 'chat.newChatSpaceId.v1';
let _newChatSpaceId = _loadNewChatSpaceId();
function _loadNewChatSpaceId() {
  try { return localStorage.getItem(_NEW_CHAT_SPACE_KEY) || ''; } catch (_) { return ''; }
}
function _saveNewChatSpaceId() {
  try { localStorage.setItem(_NEW_CHAT_SPACE_KEY, _newChatSpaceId || ''); } catch (_) {}
}

// ── Space data helpers ─────────────────────────────────────────────────

async function _loadSpaces() {
  if (_spacesLoading) return _spacesLoading;
  _spacesLoading = (async () => {
    try {
      const res = await (window.cogseed || window.orkas).invoke('spaces.list', {});
      _spacesCache = Array.isArray(res && res.spaces) ? res.spaces : [];
      // new-chat 记忆的空间若已被删除 → 清掉（避免 chip 显示失效 sid）
      if (_newChatSpaceId && !_spacesCache.some((s) => s.space_id === _newChatSpaceId)) {
        _newChatSpaceId = '';
        _saveNewChatSpaceId();
        _updateAllChips();
      }
    } catch (err) {
      _wsLog.warn('load spaces failed', err);
      _spacesCache = [];
    } finally {
      _spacesLoading = null;
    }
  })();
  return _spacesLoading;
}

function _spaceById(sid) {
  return _spacesCache.find((s) => s && s.space_id === sid) || null;
}

/** 当前 chip 目标对应的空间 id：conversation = 当前会话 space_id；new-chat = 记忆值。 */
function _currentSpaceId(target) {
  if (target === 'new-chat') return _newChatSpaceId;
  const cid = (typeof currentCid === 'string') ? currentCid : '';
  const conv = (typeof conversations !== 'undefined' && Array.isArray(conversations))
    ? conversations.find((c) => c && c.conversation_id === cid) : null;
  return (conv && conv.space_id) || '';
}

/** chip 文案 = 当前选择的空间名，未选 = 默认工作区。 */
function _chipLabel(target) {
  const sid = _currentSpaceId(target);
  if (!sid) return t('workspace.default_space', '默认工作区');
  const sp = _spaceById(sid);
  return sp ? (sp.name || sid) : sid;
}

// ── Chip label update ──────────────────────────────────────────────────

function _updateChipForTarget(target) {
  const sel = target === 'new-chat'
    ? '#panel-new-chat .workspace-chip'
    : '#panel-conversation .workspace-chip';
  const chip = document.querySelector(sel);
  if (!chip) return;
  const label = chip.querySelector('.workspace-chip-label');
  if (label) label.textContent = _chipLabel(target);
  chip.title = t('workspace.chip_title', '点击选择工作空间');
}

function _updateAllChips() {
  _updateChipForTarget('new-chat');
  _updateChipForTarget('conversation');
}

// ── Pick space / create space ──────────────────────────────────────────

async function _pickSpace(target, sid) {
  if (target === 'new-chat') {
    _newChatSpaceId = sid;
    _saveNewChatSpaceId();
    _updateAllChips();
    _refreshComposerPlaceholder();
    return;
  }
  // conversation：绑定/解绑当前会话（空 sid = 默认工作区 = 解绑）
  const cid = (typeof currentCid === 'string') ? currentCid : '';
  if (!cid) return;
  try {
    const res = await (window.cogseed || window.orkas).invoke('conversations.setSpace', { cid, spaceId: sid });
    if (!res || res.error || !res.conversation) {
      _showSpaceSetFailure((res && res.error) || t('workspace.set_failed', '无法切换工作空间。'));
      return;
    }
    const idx = (typeof conversations !== 'undefined' && Array.isArray(conversations))
      ? conversations.findIndex((c) => c && c.conversation_id === cid) : -1;
    if (idx >= 0) {
      // 解绑时后端返回的会话无 space_id 键，需显式删除本地残留值
      const updated = { ...conversations[idx], ...res.conversation };
      if (sid) updated.space_id = sid;
      else delete updated.space_id;
      conversations[idx] = updated;
    }
    if (typeof renderConversationList === 'function') renderConversationList();
    _updateAllChips();
    _refreshComposerPlaceholder();
  } catch (err) {
    _wsLog.warn('pick space failed', err);
    _showSpaceSetFailure(err);
  }
}

/** 空间归属变化后刷新 @ 占位符提示（空间会话提示产物/资产可选）。 */
function _refreshComposerPlaceholder() {
  try {
    if (typeof window !== 'undefined' && typeof window.updateAgentPickerPlaceholders === 'function') {
      window.updateAgentPickerPlaceholders();
    }
  } catch (_) {}
}

function _openSpaceCreate() {
  if (typeof setView === 'function') setView('workspace'); // 触发 workspace.js 懒加载
  const tryOpen = () => {
    if (typeof window.openWorkspaceCreate === 'function') {
      window.openWorkspaceCreate();
      return true;
    }
    return false;
  };
  if (tryOpen()) return;
  const deadline = Date.now() + 5000;
  const timer = setInterval(() => {
    if (tryOpen() || Date.now() > deadline) clearInterval(timer);
  }, 200);
}

function _showSpaceSetFailure(errOrMessage) {
  const raw = typeof errOrMessage === 'string'
    ? errOrMessage
    : ((errOrMessage && errOrMessage.message) || String(errOrMessage || ''));
  const message = raw && raw !== '[object Object]' ? raw : t('workspace.set_failed', '无法切换工作空间。');
  if (typeof uiToast === 'function') uiToast(message, { variant: 'warning', timeoutMs: 5000 });
}

// ── Chip creation ───────────────────────────────────────────────────

function _createWorkspaceChip(target) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'workspace-chip';
  chip.dataset.wsTarget = target;
  chip.title = t('workspace.chip_title', '点击选择工作空间');
  const prefix = t('workspace.chip_label', '工作空间：');
  const chevronIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('chevron-down', 'workspace-chip-chevron')
    : '';
  chip.innerHTML =
    `<span class="workspace-chip-prefix">${escapeHtml(prefix)}</span>` +
    '<span class="workspace-chip-label"></span>' +
    chevronIcon;
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    _showWorkspaceDropdown(chip, target);
  });
  return chip;
}

// ── Dropdown menu（搜索 + 默认工作区 + 空间列表 + 新建工作空间）────────

function _spaceMenuItemHtml(name, sid, currentSid) {
  const active = sid === currentSid;
  const check = active
    ? `<span class="workspace-menu-check">${(typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
        ? window.uiIconHtml('check', 'ui-icon workspace-check-icon') : ''}</span>`
    : '';
  return `<button type="button" class="workspace-menu-item${active ? ' workspace-menu-item--active' : ''}"
      data-space-pick="${escapeHtml(sid)}">
      <span>${escapeHtml(name)}</span>${check}
    </button>`;
}

function _showWorkspaceDropdown(anchor, target) {
  const old = document.getElementById('workspace-menu');
  if (old) { old.remove(); return; } // 已有菜单 → 关闭（toggle）
  void _loadSpaces().then(() => {
    // 渲染前清掉任何残留菜单（防快速双击重复挂载）
    const existing = document.getElementById('workspace-menu');
    if (existing) existing.remove();
    _renderSpaceMenu(anchor, target);
  });
}

function _renderSpaceMenu(anchor, target) {
  const currentSid = _currentSpaceId(target);
  const menu = document.createElement('div');
  menu.id = 'workspace-menu';
  menu.className = 'workspace-menu space-menu';
  anchor.classList.add('workspace-chip--open');

  // 搜索框
  const search = document.createElement('input');
  search.className = 'workspace-menu-search';
  search.placeholder = t('workspace.search_ph', '搜索工作空间…');
  menu.appendChild(search);

  // 列表
  const listEl = document.createElement('div');
  listEl.className = 'workspace-menu-list';
  menu.appendChild(listEl);

  const renderList = (q) => {
    const query = String(q || '').toLowerCase();
    const rows = [
      _spaceMenuItemHtml(t('workspace.default_space', '默认工作区'), '', currentSid),
    ];
    const spaces = _spacesCache
      .filter((s) => !query || (s.name || '').toLowerCase().includes(query))
      .sort((a, b) => String(b.last_conversation_at || b.updated_at || '')
        .localeCompare(String(a.last_conversation_at || a.updated_at || ''))
        || String(a.name || '').localeCompare(String(b.name || ''), 'zh'));
    for (const s of spaces) rows.push(_spaceMenuItemHtml(s.name || s.space_id, s.space_id, currentSid));
    listEl.innerHTML = rows.join('');
    listEl.querySelectorAll('[data-space-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        _closeMenu(anchor);
        _pickSpace(target, btn.dataset.spacePick || '');
      });
    });
  };
  renderList('');
  search.addEventListener('input', () => renderList(search.value));

  // 分隔线 + 新建工作空间
  const sep = document.createElement('div');
  sep.className = 'workspace-menu-sep';
  menu.appendChild(sep);
  const newItem = document.createElement('button');
  newItem.type = 'button';
  newItem.className = 'workspace-menu-item workspace-menu-new-space';
  newItem.innerHTML = `<span>${escapeHtml(t('workspace.new_space', '新建工作空间'))}</span>`;
  newItem.addEventListener('click', () => {
    _closeMenu(anchor);
    _openSpaceCreate();
  });
  menu.appendChild(newItem);

  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = rect.left + 'px';
  menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
  document.body.appendChild(menu);

  setTimeout(() => search.focus(), 0);

  function _closeMenu() {
    menu.remove();
    anchor.classList.remove('workspace-chip--open');
    document.removeEventListener('mousedown', _onOutside);
  }
  function _onOutside(e) {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) _closeMenu();
  }
  setTimeout(() => document.addEventListener('mousedown', _onOutside), 0);
}

// ── Init ────────────────────────────────────────────────────────────

async function initUserWorkspace() {
  _mountWorkspaceChipInBar(document.querySelector('#panel-new-chat .chat-bottom-bar'), 'new-chat');
  _mountWorkspaceChipInBar(document.querySelector('#panel-conversation .chat-bottom-bar'), 'conversation');
  await _loadSpaces();
  _updateAllChips();
  _refreshComposerPlaceholder();
}

function _mountWorkspaceChipInBar(bar, target) {
  if (!bar) return null;

  const existing = Array.from(bar.querySelectorAll(`.workspace-chip[data-ws-target="${target}"]`));
  const chip = existing[0] || _createWorkspaceChip(target);
  for (const duplicate of existing.slice(1)) duplicate.remove();

  const anchor = bar.querySelector('.chat-recipient-chip');
  if (anchor) {
    const ref = anchor.nextSibling;
    if (ref !== chip) bar.insertBefore(chip, ref);
    return chip;
  }

  const sendBtn = bar.querySelector('.chat-send-btn');
  if (sendBtn && sendBtn !== chip) bar.insertBefore(chip, sendBtn);
  else if (!chip.parentNode) bar.appendChild(chip);
  return chip;
}

/** Public: called by conversation.js when the active cid changes. */
async function refreshWorkspaceChip() {
  await _loadSpaces();
  _updateAllChips();
}

/** Public: new-chat 创建对话时读取选中的空间 id（无则空 = 默认工作区）。 */
function getNewChatSpaceId() {
  return _newChatSpaceId;
}

if (typeof window !== 'undefined') {
  window.getNewChatSpaceId = getNewChatSpaceId;
  window.refreshWorkspaceChip = refreshWorkspaceChip;
  window.initUserWorkspace = initUserWorkspace;
}

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = { _mountWorkspaceChipInBar };
}
