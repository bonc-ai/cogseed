// ─── Composer model chip + thinking-effort chip ───────────────────────
// Injected into each composer bottom-bar, right-aligned next to the send
// button. The model chip shows the current default model (first priority
// entry) and opens a menu to promote any configured model. The effort
// chip next to it picks the thinking strength (reasoning effort) for chat
// calls; its options adapt to the current model's reasoning support.

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

function _createModelChip(target) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'model-chip';
  chip.dataset.modelTarget = target;
  chip.hidden = true; // shown once entries exist
  const chevron = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('chevron-down', 'model-chip-chevron')
    : '';
  chip.innerHTML =
    '<span class="model-chip-label"></span>' +
    chevron;
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    _toggleModelMenu(chip);
  });
  return chip;
}

function _createEffortChip(target) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'model-chip effort-chip';
  chip.dataset.effortTarget = target;
  chip.hidden = true; // shown once entries exist
  const chevron = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('chevron-down', 'model-chip-chevron')
    : '';
  chip.innerHTML =
    '<span class="model-chip-label effort-chip-label"></span>' +
    chevron;
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    _toggleEffortMenu(chip);
  });
  return chip;
}

function _mountModelChipInBar(bar, target) {
  if (!bar) return null;
  const existing = Array.from(bar.querySelectorAll(`.model-chip[data-model-target="${target}"]`));
  const chip = existing[0] || _createModelChip(target);
  for (const duplicate of existing.slice(1)) duplicate.remove();

  const effortExisting = Array.from(bar.querySelectorAll(`.effort-chip[data-effort-target="${target}"]`));
  const effortChip = effortExisting[0] || _createEffortChip(target);
  for (const duplicate of effortExisting.slice(1)) duplicate.remove();

  // Right-aligned: model chip → effort chip → send button. The model chip
  // owns the flex auto-space; both chips sit flush next to the send button.
  const sendBtn = bar.querySelector('.chat-send-btn');
  if (sendBtn) {
    if (effortChip.parentNode !== bar) bar.insertBefore(effortChip, sendBtn);
    if (chip.parentNode !== bar || chip.nextElementSibling !== effortChip) {
      bar.insertBefore(chip, effortChip);
    }
  } else if (!chip.parentNode) {
    bar.appendChild(chip);
    bar.appendChild(effortChip);
  }
  return chip;
}

function _modelChipRenderAll() {
  document.querySelectorAll('.model-chip[data-model-target]').forEach((chip) => _modelChipRenderChip(chip));
  document.querySelectorAll('.effort-chip[data-effort-target]').forEach((chip) => _modelChipRenderEffortChip(chip));
}

function _modelChipRenderChip(chip) {
  const current = _modelChipEntries[0];
  if (!current) { chip.hidden = true; return; }
  chip.hidden = false;
  const provider = current.providerLabel || current.provider || '';
  const model = current.modelName || current.model || '';
  const labelEl = chip.querySelector('.model-chip-label');
  // Single line, same height as the recipient/workspace chips. Only the
  // model name is shown: provider names can be long (custom providers are
  // often named after their API host), which would push the composer
  // toolbar onto a second line. The full "provider · model" pair stays in
  // the hover tooltip below.
  if (labelEl) labelEl.textContent = model;
  chip.title = t('model_chip.title', { provider, model });
}

function _modelChipRenderEffortChip(chip) {
  const current = _modelChipEntries[0];
  if (!current) { chip.hidden = true; return; }
  chip.hidden = false;
  const labelEl = chip.querySelector('.effort-chip-label');
  const model = current.modelName || current.model || '';
  if (labelEl) labelEl.textContent = t('model_effort.label', { level: t('model_effort.' + _modelChipEffort) });
  const supports = _modelSupportsThinking(model);
  chip.title = supports
    ? t('model_effort.title')
    : t('model_effort.unsupported_title');
  chip.classList.toggle('is-unsupported', !supports);
}

function _toggleEffortMenu(anchor) {
  const old = document.getElementById('model-effort-menu');
  if (old) { _closeModelMenu(); return; }
  const current = _modelChipEntries[0];
  if (!current) return;
  const supports = _modelSupportsThinking(current.modelName || current.model || '');

  const menu = document.createElement('div');
  menu.id = 'model-effort-menu';
  menu.className = 'model-chip-menu';
  anchor.classList.add('model-chip--open');

  const header = document.createElement('div');
  header.className = 'model-chip-menu-header';
  header.textContent = t('model_effort.menu_title');
  menu.appendChild(header);

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
    menu.appendChild(item);
  });

  _positionModelMenu(menu, anchor);
  _bindModelMenuDismiss(menu, anchor);
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

function _positionModelMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = rect.left + 'px';
  menu.style.zIndex = '12000';
  document.body.appendChild(menu);
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
    if (!menu.contains(e.target) && !anchor.contains(e.target)) _closeModelMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { _closeModelMenu(); e.preventDefault(); }
  };
  menu._onDocDown = onDocDown;
  menu._onKey = onKey;
  setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
  document.addEventListener('keydown', onKey, true);
}

function _renderModelMenuRoot(menu, anchor) {
  menu.innerHTML = '';
  const entries = _modelChipEntries;

  const header = document.createElement('div');
  header.className = 'model-chip-menu-header';
  header.textContent = t('model_chip.menu_title');
  menu.appendChild(header);

  const chevronIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('chevron-right', 'model-chip-menu-arrow-icon')
    : '›';

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
    // Expand button: shows every model this provider has configured, so the
    // user can switch directly without leaving the menu.
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'model-chip-menu-arrow';
    expand.innerHTML = chevronIcon;
    expand.title = t('model_chip.expand_title');
    expand.addEventListener('click', (e) => {
      e.stopPropagation();
      _openProviderModels(menu, anchor, entry, idx);
    });
    item.appendChild(expand);

    item.addEventListener('click', () => {
      _closeModelMenu();
      if (!isDefault) _promoteModelEntry(entry);
    });
    menu.appendChild(item);
  });
}

// Second level: all models of one provider. Picking one switches the
// default entry to that model (and promotes the provider to rank 1).
async function _openProviderModels(menu, anchor, entry, idx) {
  menu.innerHTML = '';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'model-chip-menu-back';
  const backIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('chevron-left', 'model-chip-menu-back-icon')
    : '‹ ';
  back.innerHTML = backIcon + `<span>${escapeHtml(t('model_chip.back'))}</span>`;
  back.addEventListener('click', (e) => {
    e.stopPropagation();
    _renderModelMenuRoot(menu, anchor);
    _positionModelMenu(menu, anchor);
  });
  menu.appendChild(back);

  const header = document.createElement('div');
  header.className = 'model-chip-menu-header';
  header.textContent = entry.providerLabel || entry.provider || '';
  menu.appendChild(header);

  const loading = document.createElement('div');
  loading.className = 'model-chip-menu-loading';
  loading.textContent = t('model_chip.loading_models');
  menu.appendChild(loading);
  _positionModelMenu(menu, anchor);

  let models = [];
  try {
    const res = await window.cogseed.invoke('auth.listModels', { provider: entry.provider });
    models = (res && res.ok && Array.isArray(res.models)) ? res.models : [];
  } catch (err) {
    _modelChipLog.warn('list models failed', { error: (err && err.message) || String(err) });
  }
  // Menu may have been closed while loading.
  if (!menu.isConnected) return;
  loading.remove();

  if (!models.length) {
    const empty = document.createElement('div');
    empty.className = 'model-chip-menu-loading';
    empty.textContent = t('model_chip.no_models');
    menu.appendChild(empty);
    _positionModelMenu(menu, anchor);
    return;
  }

  const currentModel = entry.modelName || entry.model || '';
  models.forEach((m) => {
    const id = String(m && typeof m === 'object' ? (m.id || m.name || '') : m || '');
    if (!id) return;
    const isCurrent = id === entry.model || id === currentModel;
    const item = document.createElement('div');
    item.className = 'model-chip-menu-item' + (isCurrent ? ' is-default' : '');
    item.innerHTML =
      '<span class="model-chip-menu-main">' +
      `<span class="model-chip-menu-name">${escapeHtml(m.name || m.id || id)}</span>` +
      (isCurrent ? `<span class="model-chip-menu-default">${escapeHtml(t('model_chip.default_badge'))}</span>` : '') +
      '</span>';
    item.addEventListener('click', () => {
      _closeModelMenu();
      if (!isCurrent) _switchEntryModel(entry, idx, id);
      else if (idx !== 0) _promoteModelEntry(entry);
    });
    menu.appendChild(item);
  });
  _positionModelMenu(menu, anchor);
}

// Switch the default model: update this entry's model, then promote the
// entry to rank 1 so the change takes effect immediately.
async function _switchEntryModel(entry, idx, modelId) {
  try {
    const up = await window.cogseed.invoke('auth.updateEntryModel', {
      entryId: entry.entryId,
      model: modelId,
    });
    if (!up || !up.ok) {
      _modelChipLog.warn('switch model failed', { error: up && up.error });
      return;
    }
    if (idx !== 0) {
      const orderedIds = [
        entry.entryId,
        ..._modelChipEntries.filter((e) => e.entryId !== entry.entryId).map((e) => e.entryId),
      ];
      await window.cogseed.invoke('auth.reorderEntries', { orderedIds });
    }
  } catch (err) {
    _modelChipLog.warn('switch model failed', { error: (err && err.message) || String(err) });
  }
  await refreshModelChipEntries();
}

function _toggleModelMenu(anchor) {
  const old = document.getElementById('model-chip-menu');
  if (old) { _closeModelMenu(); return; }
  const entries = _modelChipEntries;
  if (!entries.length) return;

  const menu = document.createElement('div');
  menu.id = 'model-chip-menu';
  menu.className = 'model-chip-menu';
  anchor.classList.add('model-chip--open');

  _renderModelMenuRoot(menu, anchor);
  _positionModelMenu(menu, anchor);
  _bindModelMenuDismiss(menu, anchor);
}

function _closeModelMenu() {
  const menu = document.getElementById('model-chip-menu') || document.getElementById('model-effort-menu');
  if (!menu) return;
  document.removeEventListener('mousedown', menu._onDocDown, true);
  document.removeEventListener('keydown', menu._onKey, true);
  menu.remove();
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
