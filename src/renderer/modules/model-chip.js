// ─── Composer model chip (model name + thinking effort) ───────────────
// A single Codex-style chip injected into each composer bottom-bar,
// right-aligned next to the send button. It shows the current default
// model and thinking strength together ("model · effort") and opens one
// menu to switch either. Effort options adapt to the model's reasoning
// support.

const _modelChipLog = createLogger('model-chip');

let _modelChipEntries = [];
let _modelChipEffort = 'auto'; // 'auto' | 'off' | 'low' | 'high'
let _modelChipBound = false;

const _EFFORT_OPTIONS = ['auto', 'off', 'low', 'high'];

function _modelSupportsThinking(modelId) {
  const id = String(modelId || '').toLowerCase();
  // Models known to accept a reasoning-effort style parameter. Unknown
  // models degrade to auto/off only.
  return /deepseek|gpt-5|\bo1\b|\bo3\b|claude|thinking|reasoner|kimi|qwen|glm|minimax|seed-2|doubao/.test(id);
}

async function refreshModelChipEntries() {
  try {
    const res = await window.cogseed.invoke('auth.listEntries');
    if (res && res.ok && Array.isArray(res.entries)) {
      _modelChipEntries = res.entries;
      _modelChipRenderAll();
    }
  } catch (err) {
    _modelChipLog.warn('model entries refresh failed', { error: (err && err.message) || String(err) });
  }
}

async function refreshModelChipEffort() {
  try {
    const res = await window.cogseed.invoke('prefs.getThinkingLevel');
    if (res && (res.level === 'auto' || res.level === 'off' || res.level === 'low' || res.level === 'high')) {
      _modelChipEffort = res.level;
      _modelChipRenderAll();
    }
  } catch (err) {
    _modelChipLog.warn('thinking level refresh failed', { error: (err && err.message) || String(err) });
  }
}

function _createCombinedChip(target) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'model-chip chat-model-effort-chip';
  chip.dataset.modelTarget = target;
  chip.hidden = true; // shown once entries exist
  const chevron = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('chevron-down', 'model-chip-chevron')
    : '';
  chip.innerHTML =
    '<span class="model-chip-label"></span>' +
    '<span class="chat-model-effort-sep">·</span>' +
    '<span class="effort-chip-label"></span>' +
    chevron;
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    _toggleModelMenu(chip);
  });
  return chip;
}

function _mountModelChipInBar(bar, target) {
  if (!bar) return null;
  const existing = Array.from(bar.querySelectorAll(`.chat-model-effort-chip[data-model-target="${target}"]`));
  const chip = existing[0] || _createCombinedChip(target);
  for (const duplicate of existing.slice(1)) duplicate.remove();

  // Right-aligned: combined chip → (mic) → send button. The chip owns the flex
  // auto-space (margin-left: auto); the mic and send stay flush on its right.
  const sendBtn = bar.querySelector('.chat-send-btn');
  const micBtn = bar.querySelector('.chat-stt-btn');
  const anchor = micBtn || sendBtn;
  if (anchor) {
    if (chip.parentNode !== bar || chip.nextElementSibling !== anchor) {
      bar.insertBefore(chip, anchor);
    }
  } else if (!chip.parentNode) {
    bar.appendChild(chip);
  }
  return chip;
}

function _modelChipRenderAll() {
  document.querySelectorAll('.chat-model-effort-chip[data-model-target]').forEach((chip) => _renderCombinedChip(chip));
}

function _renderCombinedChip(chip) {
  const current = _modelChipEntries[0];
  const labelEl = chip.querySelector('.model-chip-label');
  if (!current) {
    // 没有配置任何模型：不造假，显示一个空态入口，点击带用户去配置。
    chip.hidden = false;
    chip.classList.add('is-empty');
    if (labelEl) labelEl.textContent = t('model_chip.empty_label');
    chip.title = t('model_chip.empty_title');
    return;
  }
  chip.classList.remove('is-empty');
  chip.hidden = false;
  const provider = current.providerLabel || current.provider || '';
  const model = current.modelName || current.model || '';
  const effortEl = chip.querySelector('.effort-chip-label');
  // Only the model name + effort level are shown: provider names can be long
  // (custom providers are often named after their API host), which would push
  // the composer toolbar onto a second line. The full "provider · model" pair
  // stays in the hover tooltip.
  if (labelEl) labelEl.textContent = model;
  if (effortEl) effortEl.textContent = t('model_effort.' + _modelChipEffort);
  const supports = _modelSupportsThinking(model);
  const modelTitle = t('model_chip.title', { provider, model });
  chip.title = supports
    ? modelTitle + ' ' + t('model_effort.title')
    : modelTitle + ' ' + t('model_effort.unsupported_title');
  chip.classList.toggle('is-unsupported', !supports);
}

function _renderEffortOptions(container) {
  const current = _modelChipEntries[0];
  if (!current) return;
  const supports = _modelSupportsThinking(current.modelName || current.model || '');

  const header = document.createElement('div');
  header.className = 'model-chip-menu-header';
  header.textContent = t('model_effort.menu_title');
  container.appendChild(header);

  _EFFORT_OPTIONS.forEach((level) => {
    const isActive = _modelChipEffort === level;
    const unavailable = (level === 'low' || level === 'high') && !supports;
    const item = document.createElement('div');
    item.className = 'model-chip-menu-item' + (isActive ? ' is-default' : '') + (unavailable ? ' is-disabled' : '');
    if (unavailable) item.title = t('model_effort.unsupported_title');
    item.innerHTML =
      '<span class="model-chip-menu-main">' +
      `<span class="model-chip-menu-name">${escapeHtml(t('model_effort.' + level))}</span>` +
      (isActive ? `<span class="model-chip-menu-default">${escapeHtml(t('model_chip.default_badge'))}</span>` : '') +
      '</span>' +
      (unavailable ? `<span class="model-chip-menu-sub">${escapeHtml(t('model_effort.unsupported_hint'))}</span>` : '');
    if (!unavailable) {
      item.addEventListener('click', () => {
        _closeModelMenu();
        if (level !== _modelChipEffort) _setModelChipEffort(level);
      });
    }
    container.appendChild(item);
  });
}

async function _setModelChipEffort(level) {
  _modelChipEffort = level;
  _modelChipRenderAll();
  try {
    await window.cogseed.invoke('prefs.setThinkingLevel', { level });
  } catch (err) {
    _modelChipLog.warn('thinking level save failed', { error: (err && err.message) || String(err) });
  }
}

function _clampMenuLeft(preferredLeft, menuWidth) {
  const edge = 8;
  const maxLeft = Math.max(edge, window.innerWidth - menuWidth - edge);
  return Math.min(Math.max(edge, preferredLeft), maxLeft);
}

function _positionModelMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  document.body.appendChild(menu);
  const menuWidth = menu.offsetWidth || 150;
  menu.style.left = _clampMenuLeft(rect.left, menuWidth) + 'px';
  // Flip above the anchor when there isn't enough room below; clamp to
  // the viewport either way.
  const menuHeight = menu.offsetHeight || 280;
  const spaceBelow = window.innerHeight - (rect.bottom + 6);
  const spaceAbove = rect.top - 6;
  const topBelow = Math.min(rect.bottom + 6, window.innerHeight - menuHeight - 8);
  if (spaceBelow < menuHeight && spaceAbove > menuHeight) {
    menu.style.top = Math.max(8, rect.top - 6 - menuHeight) + 'px';
  } else {
    menu.style.top = Math.max(8, topBelow) + 'px';
  }
}

function _bindModelMenuDismiss(menu, anchor) {
  const onDocDown = (e) => {
    const sub = document.getElementById('model-chip-submenu');
    if (!menu.contains(e.target) && !(sub && sub.contains(e.target)) && !anchor.contains(e.target)) _closeModelMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { _closeModelMenu(); e.preventDefault(); }
  };
  const onViewportChange = () => _closeModelMenu();
  menu._onDocDown = onDocDown;
  menu._onKey = onKey;
  menu._onViewportChange = onViewportChange;
  setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onViewportChange);
  document.addEventListener('scroll', onViewportChange, true);
}

function _makeMenuTrigger(label, chevronIcon, onClick) {
  const item = document.createElement('div');
  item.className = 'model-chip-menu-item model-chip-menu-trigger';
  item.innerHTML =
    '<span class="model-chip-menu-main">' +
    `<span class="model-chip-menu-name">${escapeHtml(label)}</span>` +
    '</span>' +
    `<span class="model-chip-menu-trigger-chevron">${chevronIcon}</span>`;
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return item;
}

function _renderModelMenuRoot(menu, anchor) {
  menu.innerHTML = '';
  const chevronIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('chevron-right', 'model-chip-menu-trigger-chevron-icon')
    : '›';

  // 主菜单只放两个入口：模型 / 思考强度。点哪个，才在右侧弹出对应的子菜单
  // （用户只有明确点某一个时才展开，不默认平铺）。
  menu.appendChild(_makeMenuTrigger(t('model_chip.menu_title'), chevronIcon, () => _openSubmenu(menu, 'model')));
  menu.appendChild(_makeMenuTrigger(t('model_effort.menu_title'), chevronIcon, () => _openSubmenu(menu, 'effort')));
}

function _renderModelOptions(container) {
  const entries = _modelChipEntries;
  const header = document.createElement('div');
  header.className = 'model-chip-menu-header';
  header.textContent = t('model_chip.menu_title');
  container.appendChild(header);

  entries.forEach((entry, idx) => {
    const isDefault = idx === 0;
    const item = document.createElement('div');
    item.className = 'model-chip-menu-item' + (isDefault ? ' is-default' : '');
    const provider = entry.providerLabel || entry.provider || '';
    const model = entry.modelName || entry.model || '';
    item.innerHTML =
      '<span class="model-chip-menu-main">' +
      `<span class="model-chip-menu-rank">${idx + 1}</span>` +
      `<span class="model-chip-menu-name">${escapeHtml(model)}</span>` +
      (isDefault ? `<span class="model-chip-menu-default">${escapeHtml(t('model_chip.default_badge'))}</span>` : '') +
      '</span>' +
      `<span class="model-chip-menu-sub">${escapeHtml(provider)}</span>`;
    item.addEventListener('click', () => {
      _closeModelMenu();
      if (!isDefault) _promoteModelEntry(entry);
    });
    container.appendChild(item);
  });
}

function _closeSubmenu() {
  const sub = document.getElementById('model-chip-submenu');
  if (sub) sub.remove();
}

function _positionSubmenu(sub, menu) {
  const rect = menu.getBoundingClientRect();
  sub.style.position = 'fixed';
  const subWidth = sub.offsetWidth || 240;
  const spaceRight = window.innerWidth - rect.right - 6;
  let preferredLeft;
  if (spaceRight >= subWidth) {
    preferredLeft = rect.right + 6;
  } else {
    preferredLeft = rect.left - subWidth - 6;
  }
  sub.style.left = _clampMenuLeft(preferredLeft, subWidth) + 'px';
  const subHeight = sub.offsetHeight || 200;
  sub.style.top = Math.max(8, Math.min(rect.top, window.innerHeight - subHeight - 8)) + 'px';
}

function _openSubmenu(menu, kind) {
  _closeSubmenu();
  const sub = document.createElement('div');
  sub.id = 'model-chip-submenu';
  sub.className = 'model-chip-menu model-chip-submenu';
  if (kind === 'model') _renderModelOptions(sub);
  else _renderEffortOptions(sub);
  document.body.appendChild(sub);
  _positionSubmenu(sub, menu);
}

function _toggleModelMenu(anchor) {
  const entries = _modelChipEntries;
  if (!entries.length) {
    // 空态：没有模型可切换，直接带用户去「设置 → 凭据」配置模型。
    if (typeof setView === 'function') setView('settings');
    if (typeof window.activateSettingsTab === 'function') window.activateSettingsTab('credentials');
    return;
  }
  const old = document.getElementById('model-chip-menu');
  if (old) { _closeModelMenu(); return; }

  const menu = document.createElement('div');
  menu.id = 'model-chip-menu';
  menu.className = 'model-chip-menu';
  anchor.classList.add('model-chip--open');

  _renderModelMenuRoot(menu, anchor);
  _positionModelMenu(menu, anchor);
  _bindModelMenuDismiss(menu, anchor);
}

function _closeModelMenu() {
  _closeSubmenu();
  const menu = document.getElementById('model-chip-menu');
  if (menu) {
    document.removeEventListener('mousedown', menu._onDocDown, true);
    document.removeEventListener('keydown', menu._onKey, true);
    window.removeEventListener('resize', menu._onViewportChange);
    document.removeEventListener('scroll', menu._onViewportChange, true);
    menu.remove();
  }
  document.querySelectorAll('.model-chip--open').forEach((el) => el.classList.remove('model-chip--open'));
}

async function _promoteModelEntry(entry) {
  const orderedIds = [
    entry.entryId,
    ..._modelChipEntries.filter((e) => e.entryId !== entry.entryId).map((e) => e.entryId),
  ];
  try {
    const res = await window.cogseed.invoke('auth.reorderEntries', { orderedIds });
    if (res && res.ok && Array.isArray(res.entries)) {
      _modelChipEntries = res.entries;
      _modelChipRenderAll();
    }
  } catch (err) {
    _modelChipLog.warn('promote model entry failed', { error: (err && err.message) || String(err) });
  }
}

function initModelChip() {
  _mountModelChipInBar(document.querySelector('#panel-new-chat .chat-bottom-bar'), 'new-chat');
  _mountModelChipInBar(document.querySelector('#panel-conversation .chat-bottom-bar'), 'conversation');
  _mountModelChipInBar(document.querySelector('#panel-project .chat-bottom-bar'), 'project');
  if (!_modelChipBound) {
    _modelChipBound = true;
    // model-guard broadcasts the fresh entries in the event detail; without
    // consuming them the chip would keep re-rendering the stale boot-time
    // list, so a model configured in settings never shows up until restart.
    window.addEventListener('cogseed:model-entries-changed', (e) => {
      if (e && e.detail && Array.isArray(e.detail.entries)) {
        _modelChipEntries = e.detail.entries;
        _modelChipRenderAll();
      } else {
        refreshModelChipEntries();
      }
    });
    window.addEventListener('i18n-change', () => _modelChipRenderAll());
  }
  refreshModelChipEntries();
  refreshModelChipEffort();
}

window.initModelChip = initModelChip;
window.closeModelChipMenu = _closeModelMenu;
