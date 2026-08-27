// ─── Composer execution-config chip (unified execution entry) ──────────
// Injected into each composer bottom-bar, right-aligned next to the send
// button. Shows the ACTUAL execution config for the current task — the
// model and reasoning effort the next message will run with — and lets the
// user adjust them for THIS conversation only:
//
//   recipient = Commander      → global default entry + global effort pref
//   recipient = local Agent    → the agent's own defaults (agent settings),
//                                CLI agents use their runtime.model and have
//                                no effort control (the CLI decides)
//   recipient = API model pick → that exact model
//
// Any change here is a per-task override (`chat.execOverrideByCid`): it
// never rewrites the global default entry, the global thinking preference,
// or the agent's saved defaults. Global settings live in the settings page.
//
// The model and effort pickers share this one chip; target selection
// (who executes) lives in the @ recipient picker, grouped into
// 「本地 Agent」and「API 连接模型」.

const _modelChipLog = createLogger('model-chip');

let _modelChipEntries = [];      // auth.listEntries cache (rank order)
let _modelChipGlobalEffort = 'auto'; // global preference — display fallback only
let _modelChipBound = false;
// provider → { [modelId]: reasoning|undefined } — populated from
// auth.listModels responses (main now annotates each model with its
// reasoning capability). Unknown ids fall back to the name heuristic.
const _modelReasoningByProvider = new Map();

const _EFFORT_OPTIONS = ['auto', 'off', 'low', 'high'];

function _modelSupportsThinking(modelId) {
  const id = String(modelId || '').toLowerCase();
  // Models known to accept a reasoning-effort style parameter. Unknown
  // models degrade to auto/off only.
  return /deepseek|gpt-5|\bo1\b|\bo3\b|claude|thinking|reasoner|kimi|qwen|glm|minimax|seed-2|doubao/.test(id);
}

/** Reasoning capability for a provider+model pair: explicit catalog value
 *  first, name heuristic as the fallback for unannotated models. */
function _modelReasoningCapability(provider, model) {
  const table = _modelReasoningByProvider.get(String(provider || ''));
  if (table && Object.prototype.hasOwnProperty.call(table, String(model || ''))) {
    return table[String(model || '')] === true;
  }
  return _modelSupportsThinking(model);
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

function getModelChipEntries() { return _modelChipEntries.slice(); }

async function refreshModelChipEffort() {
  try {
    const res = await window.cogseed.invoke('prefs.getThinkingLevel');
    if (res && (res.level === 'auto' || res.level === 'off' || res.level === 'low' || res.level === 'high')) {
      _modelChipGlobalEffort = res.level;
      _modelChipRenderAll();
    }
  } catch (err) {
    _modelChipLog.warn('thinking level refresh failed', { error: (err && err.message) || String(err) });
  }
}

// ─── Effective-config resolution ─────────────────────────────────────────

function _chipTargetForElement(chip) {
  return (chip && chip.dataset && chip.dataset.modelTarget) || 'conversation';
}

/** The agent spec behind the current recipient, when the recipient is an
 *  agent (works for CLI and in-process agents). */
function _recipientAgent(target) {
  try {
    const r = (typeof getChatRecipient === 'function') ? getChatRecipient(target) : null;
    if (!r || r.kind !== 'agent' || !r.id) return null;
    const list = (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) ? _agentsCache : [];
    return list.find((a) => a && a.agent_id === r.id) || null;
  } catch (_) { return null; }
}

function _isCliAgent(agent) {
  return !!(agent && agent.runtime && (agent.runtime.kind === 'cli' || agent.runtime.kind === 'p3394-gateway'));
}

/** Resolve what the NEXT message in this target will actually run with.
 *  Mirrors the main-process priority: task override > agent default >
 *  global default. Returns:
 *  { mode:'cli'|'api', model, modelLabel, provider, providerLabel,
 *    effort, effortOverridden, modelOverridden, reasoning } */
function _effectiveExecConfig(target) {
  const recipient = (typeof getChatRecipient === 'function') ? getChatRecipient(target) : { kind: 'commander' };
  const override = (typeof getExecOverride === 'function') ? (getExecOverride(target) || {}) : {};
  const defaultEntry = _modelChipEntries[0] || null;

  // CLI-backed local agent: model comes from the agent's runtime (task
  // override may swap it); effort is owned by the external CLI.
  const agent = _recipientAgent(target);
  if (recipient.kind === 'agent' && _isCliAgent(agent)) {
    const model = override.model || agent.runtime.model || '';
    return {
      mode: 'cli',
      model,
      modelLabel: override.modelLabel || model || '',
      provider: '',
      providerLabel: (agent.runtime && agent.runtime.cli) || '',
      effort: null,           // CLI decides its own reasoning config
      effortOverridden: false,
      modelOverridden: !!override.model,
      reasoning: false,
      agent,
    };
  }

  // API-connection model recipient: the pick IS the execution target; only
  // effort can be overridden on top.
  if (recipient.kind === 'model' && recipient.provider && recipient.model) {
    return {
      mode: 'api',
      model: recipient.model,
      modelLabel: recipient.name || recipient.model,
      provider: recipient.provider,
      providerLabel: recipient.providerLabel || recipient.provider,
      effort: override.effort || _modelChipGlobalEffort,
      effortOverridden: !!override.effort,
      modelOverridden: false,
      reasoning: _modelReasoningCapability(recipient.provider, recipient.model),
      agent: null,
    };
  }

  // Commander / in-process agent: task override > agent default > global.
  const agentDefaultModel = (agent && agent.default_model) ? agent.default_model : null;
  const modelChoice = (override.provider && override.model)
    ? { provider: override.provider, model: override.model, label: override.modelLabel || override.model }
    : agentDefaultModel
      ? { provider: agentDefaultModel.provider, model: agentDefaultModel.model, label: agentDefaultModel.model }
      : defaultEntry
        ? { provider: defaultEntry.provider, model: defaultEntry.model, label: defaultEntry.modelName || defaultEntry.model }
        : null;
  const agentDefaultEffort = (agent && agent.default_thinking) ? agent.default_thinking : null;
  const effort = override.effort || agentDefaultEffort || _modelChipGlobalEffort;
  return {
    mode: 'api',
    model: modelChoice ? modelChoice.model : '',
    modelLabel: modelChoice ? modelChoice.label : '',
    provider: modelChoice ? modelChoice.provider : '',
    providerLabel: modelChoice
      ? ((_modelChipEntries.find((e) => e && e.provider === modelChoice.provider) || {}).providerLabel || modelChoice.provider)
      : '',
    effort,
    effortOverridden: !!override.effort,
    modelOverridden: !!(override.provider && override.model),
    reasoning: modelChoice ? _modelReasoningCapability(modelChoice.provider, modelChoice.model) : true,
    agent,
  };
}

// ─── Chip DOM ─────────────────────────────────────────────────────────────

function _createModelChip(target) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'model-chip exec-config-chip';
  chip.dataset.modelTarget = target;
  chip.hidden = true; // shown once entries exist or a recipient is picked
  const chevron = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('chevron-down', 'model-chip-chevron')
    : '';
  chip.innerHTML =
    '<span class="model-chip-label"></span>' +
    '<span class="exec-config-effort"></span>' +
    chevron;
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    _toggleExecConfigMenu(chip);
  });
  return chip;
}

function _mountModelChipInBar(bar, target) {
  if (!bar) return null;
  const existing = Array.from(bar.querySelectorAll(`.model-chip[data-model-target="${target}"]`));
  const chip = existing[0] || _createModelChip(target);
  for (const duplicate of existing.slice(1)) duplicate.remove();
  // Legacy effort chip (pre-unified-entry) — remove if it somehow reappears.
  for (const legacy of Array.from(bar.querySelectorAll('.effort-chip'))) legacy.remove();

  // Right-aligned: chip → (mic) → send button. The chip owns the flex
  // auto-space; the mic (added by the STT feature) and send stay flush on
  // its right, so anchor on the mic when present.
  const micBtn = bar.querySelector('.chat-stt-btn');
  const sendBtn = bar.querySelector('.chat-send-btn');
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

function _execEffortLabel(effort) {
  return t('model_effort.' + (effort || 'auto'));
}

function _modelChipRenderAll() {
  document.querySelectorAll('.model-chip[data-model-target]').forEach((chip) => _modelChipRenderChip(chip));
}

function _modelChipRenderChip(chip) {
  const target = _chipTargetForElement(chip);
  const cfg = _effectiveExecConfig(target);
  const hasRecipient = (typeof getChatRecipient === 'function')
    && getChatRecipient(target).kind !== 'commander';
  if (!cfg.model && !hasRecipient && !_modelChipEntries.length) { chip.hidden = true; return; }
  chip.hidden = false;

  const labelEl = chip.querySelector('.model-chip-label');
  const effortEl = chip.querySelector('.exec-config-effort');
  const cliMode = cfg.mode === 'cli';

  if (labelEl) {
    labelEl.textContent = cfg.modelLabel
      || (cliMode ? t('exec_config.cli_default_model') : t('exec_config.no_model'));
  }
  if (effortEl) {
    if (cliMode) {
      // CLI agent: effort is owned by the external CLI — show the badge as
      // the reason instead of a changeable value.
      effortEl.textContent = t('exec_config.cli_badge');
      effortEl.classList.add('is-cli');
    } else {
      const displayEffort = cfg.effort || 'auto';
      effortEl.textContent = _execEffortLabel(displayEffort);
      effortEl.classList.remove('is-cli');
      effortEl.classList.toggle('is-override', cfg.effortOverridden);
    }
  }
  const overrideMarker = cfg.modelOverridden || cfg.effortOverridden;
  chip.classList.toggle('is-override', !!overrideMarker);
  chip.title = t('exec_config.title');
}

// ─── Menu ─────────────────────────────────────────────────────────────────

function _positionModelMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = rect.left + 'px';
  menu.style.zIndex = '12000';
  document.body.appendChild(menu);
  // Flip above the anchor when there isn't enough room below; clamp to
  // the viewport either way.
  const menuHeight = menu.offsetHeight || 320;
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

function _closeModelMenu() {
  const menu = document.getElementById('model-chip-menu');
  if (!menu) return;
  document.removeEventListener('mousedown', menu._onDocDown, true);
  document.removeEventListener('keydown', menu._onKey, true);
  menu.remove();
  document.querySelectorAll('.model-chip--open').forEach((el) => el.classList.remove('model-chip--open'));
}

/** One menu, two sections: model (with provider drill-down) + effort. */
function _toggleExecConfigMenu(anchor) {
  const old = document.getElementById('model-chip-menu');
  if (old) { _closeModelMenu(); return; }

  const menu = document.createElement('div');
  menu.id = 'model-chip-menu';
  menu.className = 'model-chip-menu model-chip-menu--exec';
  anchor.classList.add('model-chip--open');
  _renderExecConfigMenu(menu, anchor);
  _positionModelMenu(menu, anchor);
  _bindModelMenuDismiss(menu, anchor);
}

function _menuSectionLabel(menu, key, extra = '') {
  const el = document.createElement('div');
  el.className = 'model-chip-menu-section';
  el.innerHTML = `${escapeHtml(t(key))}${extra ? ` <span class="model-chip-menu-section-extra">${escapeHtml(extra)}</span>` : ''}`;
  menu.appendChild(el);
  return el;
}

function _renderExecConfigMenu(menu, anchor) {
  const target = _chipTargetForElement(anchor);
  const cfg = _effectiveExecConfig(target);
  menu.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'model-chip-menu-header';
  header.textContent = t('exec_config.menu_title');
  menu.appendChild(header);

  const sub = document.createElement('div');
  sub.className = 'model-chip-menu-subheader';
  sub.textContent = cfg.mode === 'cli'
    ? t('exec_config.subheader_cli', { name: (cfg.agent && cfg.agent.name) || '' })
    : t('exec_config.subheader_task');
  menu.appendChild(sub);

  // ── Model section ──
  _menuSectionLabel(menu, 'exec_config.section_model');

  // Summary row only when it adds information the provider list can't show:
  // a task override (badge + reset affordance) or a CLI runtime. Otherwise
  // the provider rows below already mark the active pick as「当前」and a
  // duplicate line would read as two different entries.
  if (cfg.mode === 'cli' || cfg.modelOverridden) {
    const currentModelEl = document.createElement('div');
    currentModelEl.className = 'model-chip-menu-item' + (cfg.modelOverridden ? ' is-override' : '');
    currentModelEl.innerHTML =
      '<span class="model-chip-menu-main">' +
      `<span class="model-chip-menu-name">${escapeHtml(cfg.modelLabel || t('exec_config.no_model'))}</span>` +
      (cfg.modelOverridden ? `<span class="model-chip-menu-default">${escapeHtml(t('exec_config.task_override_badge'))}</span>` : '') +
      '</span>' +
      `<span class="model-chip-menu-sub">${escapeHtml(cfg.providerLabel || (cfg.mode === 'cli' ? t('exec_config.cli_runtime', { cli: cfg.providerLabel }) : ''))}</span>`;
    menu.appendChild(currentModelEl);
  }

  if (cfg.mode === 'cli') {
    // CLI agent: model options come from the CLI's own model table
    // (same list the agent settings page uses).
    _renderCliModelOptions(menu, anchor, cfg);
  } else if (cfg.model || _modelChipEntries.length) {
    // Reset-to-default row (only meaningful when a task override exists).
    if (cfg.modelOverridden) {
      const reset = document.createElement('div');
      reset.className = 'model-chip-menu-item model-chip-menu-item--action';
      reset.innerHTML = `<span class="model-chip-menu-main"><span class="model-chip-menu-name">${escapeHtml(t('exec_config.reset_model'))}</span></span>`;
      reset.addEventListener('click', () => {
        _clearModelOverride(target);
        _closeModelMenu();
      });
      menu.appendChild(reset);
    }
    _renderApiProviderRows(menu, anchor, target, cfg);
  }

  // ── Effort section ──
  _menuSectionLabel(menu, 'exec_config.section_effort');

  if (cfg.mode === 'cli') {
    const note = document.createElement('div');
    note.className = 'model-chip-menu-note';
    note.textContent = t('exec_config.effort_cli_note');
    menu.appendChild(note);
  } else {
    const supports = cfg.model ? cfg.reasoning : false;
    if (cfg.model && !supports) {
      const note = document.createElement('div');
      note.className = 'model-chip-menu-note';
      note.textContent = t('model_effort.unsupported_hint');
      menu.appendChild(note);
    }
    const activeEffort = cfg.effort || 'auto';
    _EFFORT_OPTIONS.forEach((level) => {
      const isActive = activeEffort === level;
      const unavailable = (level === 'low' || level === 'high') && !supports;
      const item = document.createElement('div');
      item.className = 'model-chip-menu-item'
        + (isActive ? ' is-default' : '')
        + (unavailable ? ' is-disabled' : '');
      if (unavailable) item.title = t('model_effort.unsupported_title');
      item.innerHTML =
        '<span class="model-chip-menu-main">' +
        `<span class="model-chip-menu-name">${escapeHtml(t('model_effort.' + level))}</span>` +
        (isActive
          ? `<span class="model-chip-menu-default">${escapeHtml(cfg.effortOverridden ? t('exec_config.task_override_badge') : t('exec_config.current_badge'))}</span>`
          : '') +
        '</span>' +
        (unavailable ? `<span class="model-chip-menu-sub">${escapeHtml(t('model_effort.unsupported_hint'))}</span>` : '');
      if (!unavailable) {
        item.addEventListener('click', () => {
          _setTaskEffort(target, level);
          _closeModelMenu();
        });
      }
      menu.appendChild(item);
    });
  }
}

// ── Model option rows ────────────────────────────────────────────────────

function _clearModelOverride(target) {
  try {
    const ov = (typeof getExecOverride === 'function') ? (getExecOverride(target) || {}) : {};
    const { effort, ...rest } = ov; // keep effort, drop the model pair
    if (typeof setExecOverride === 'function') {
      setExecOverride(target, effort ? { effort } : null);
    }
    _modelChipRenderAll();
  } catch (err) {
    _modelChipLog.warn('clear model override failed', { error: (err && err.message) || String(err) });
  }
}

function _setTaskEffort(target, level) {
  try {
    if (typeof setExecOverride !== 'function') return;
    if (level === 'auto') {
      // Drop only the effort part of the override; keep a model pair if set.
      const ov = getExecOverride(target) || {};
      const { effort, ...rest } = ov;
      setExecOverride(target, Object.keys(rest).length ? rest : null);
    } else {
      const ov = getExecOverride(target) || {};
      setExecOverride(target, { ...ov, effort: level });
    }
    _modelChipRenderAll();
  } catch (err) {
    _modelChipLog.warn('set task effort failed', { error: (err && err.message) || String(err) });
  }
}

/** API models: one row per configured provider (its current priority
 *  entry); the chevron drills into the provider's full model list. Picking
 *  writes a task override — or, when the recipient IS an API model pick,
 *  swaps the recipient itself (the pick is the target, not a layer on it). */
function _renderApiProviderRows(menu, anchor, target, cfg) {
  const chevronIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('chevron-right', 'model-chip-menu-arrow-icon')
    : '›';

  _modelChipEntries.forEach((entry) => {
    if (!entry || !entry.provider || !entry.model) return;
    const isCurrent = cfg.provider === entry.provider && cfg.model === entry.model;
    const item = document.createElement('div');
    item.className = 'model-chip-menu-item' + (isCurrent ? ' is-default' : '');
    const provider = entry.providerLabel || entry.provider || '';
    const model = entry.modelName || entry.model || '';
    item.innerHTML =
      '<span class="model-chip-menu-main">' +
      `<span class="model-chip-menu-name">${escapeHtml(model)}</span>` +
      (isCurrent ? `<span class="model-chip-menu-default">${escapeHtml(t('exec_config.current_badge'))}</span>` : '') +
      '</span>' +
      `<span class="model-chip-menu-sub">${escapeHtml(provider)}</span>`;
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'model-chip-menu-arrow';
    expand.innerHTML = chevronIcon;
    expand.title = t('model_chip.expand_title');
    expand.addEventListener('click', (e) => {
      e.stopPropagation();
      _openProviderModels(menu, anchor, target, entry, cfg);
    });
    item.appendChild(expand);
    item.addEventListener('click', () => {
      _applyModelPick(target, cfg, entry.provider, entry.model, model, entry.providerLabel);
      _closeModelMenu();
    });
    menu.appendChild(item);
  });
}

/** Apply a model pick: recipient-swap for model recipients (the pick is the
 *  execution target), task override everywhere else. */
function _applyModelPick(target, cfg, provider, model, modelLabel, providerLabel) {
  try {
    const recipient = (typeof getChatRecipient === 'function') ? getChatRecipient(target) : null;
    if (recipient && recipient.kind === 'model') {
      if (typeof setChatRecipient === 'function') {
        setChatRecipient(target, {
          kind: 'model', provider, model,
          name: modelLabel || model,
          providerLabel: providerLabel || provider,
        });
      }
    } else if (typeof setExecOverride === 'function') {
      const ov = getExecOverride(target) || {};
      setExecOverride(target, {
        ...ov,
        provider, model,
        modelLabel: modelLabel || model,
      });
    }
    _modelChipRenderAll();
  } catch (err) {
    _modelChipLog.warn('apply model pick failed', { error: (err && err.message) || String(err) });
  }
}

/** Second level: every model of one provider (annotated with reasoning
 *  capability, cached for the effort gating). */
async function _openProviderModels(menu, anchor, target, entry, cfg) {
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
    _renderExecConfigMenu(menu, anchor);
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
    if (res && res.ok && Array.isArray(res.models)) models = res.models;
  } catch (err) {
    _modelChipLog.warn('list models failed', { error: (err && err.message) || String(err) });
  }
  // Remember the reasoning capability for effort gating on this provider.
  if (models.length) {
    const table = {};
    for (const m of models) {
      if (m && typeof m === 'object' && typeof m.reasoning === 'boolean') table[String(m.id)] = m.reasoning;
    }
    _modelReasoningByProvider.set(String(entry.provider), table);
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

  models.forEach((m) => {
    const id = String(m && typeof m === 'object' ? (m.id || m.name || '') : m || '');
    if (!id) return;
    const label = String((m && m.name) || id);
    const isCurrent = cfg.provider === entry.provider && cfg.model === id;
    const item = document.createElement('div');
    item.className = 'model-chip-menu-item' + (isCurrent ? ' is-default' : '');
    item.innerHTML =
      '<span class="model-chip-menu-main">' +
      `<span class="model-chip-menu-name">${escapeHtml(label)}</span>` +
      (isCurrent ? `<span class="model-chip-menu-default">${escapeHtml(t('exec_config.current_badge'))}</span>` : '') +
      '</span>' +
      (m && typeof m === 'object' && m.reasoning === false
        ? `<span class="model-chip-menu-sub">${escapeHtml(t('exec_config.no_reasoning_note'))}</span>`
        : '');
    item.addEventListener('click', () => {
      _applyModelPick(target, cfg, entry.provider, id, label, entry.providerLabel);
      _closeModelMenu();
    });
    menu.appendChild(item);
  });
  _positionModelMenu(menu, anchor);
}

/** CLI agent model options: static model table per CLI type (same source
 *  as the agent settings page); the agent's saved runtime.model stays the
 *  default, a pick here is a task override. */
function _renderCliModelOptions(menu, anchor, cfg) {
  const agent = cfg.agent;
  const cliType = (agent && agent.runtime && agent.runtime.cli) || '';
  const container = document.createElement('div');
  container.className = 'model-chip-menu-loading';
  container.textContent = t('common.loading');
  menu.appendChild(container);

  window.cogseed.invoke('localAgents.listModels', { type: cliType }).then((res) => {
    if (!menu.isConnected) return;
    container.remove();
    const models = (res && Array.isArray(res.models)) ? res.models : [];
    if (!models.length) {
      const note = document.createElement('div');
      note.className = 'model-chip-menu-note';
      note.textContent = t('exec_config.cli_no_models');
      menu.appendChild(note);
      return;
    }
    if (cfg.modelOverridden) {
      const reset = document.createElement('div');
      reset.className = 'model-chip-menu-item model-chip-menu-item--action';
      reset.innerHTML = `<span class="model-chip-menu-main"><span class="model-chip-menu-name">${escapeHtml(t('exec_config.reset_model'))}</span></span>`;
      reset.addEventListener('click', () => {
        _clearModelOverride(_chipTargetForElement(anchor));
        _closeModelMenu();
      });
      menu.appendChild(reset);
    }
    models.forEach((m) => {
      const id = String(m && typeof m === 'object' ? (m.id || '') : String(m || ''));
      if (!id) return;
      const label = String((m && m.label) || id);
      const isCurrent = cfg.model === id;
      const item = document.createElement('div');
      item.className = 'model-chip-menu-item' + (isCurrent ? ' is-default' : '');
      item.innerHTML =
        '<span class="model-chip-menu-main">' +
        `<span class="model-chip-menu-name">${escapeHtml(label)}</span>` +
        (isCurrent ? `<span class="model-chip-menu-default">${escapeHtml(t('exec_config.current_badge'))}</span>` : '') +
        '</span>';
      item.addEventListener('click', () => {
        try {
          if (typeof setExecOverride === 'function') {
            const ov = getExecOverride(_chipTargetForElement(anchor)) || {};
            setExecOverride(_chipTargetForElement(anchor), { ...ov, model: id, modelLabel: label });
          }
          _modelChipRenderAll();
        } catch (err) {
          _modelChipLog.warn('cli model pick failed', { error: (err && err.message) || String(err) });
        }
        _closeModelMenu();
      });
      menu.appendChild(item);
    });
    _positionModelMenu(menu, anchor);
  }).catch(() => {
    if (!menu.isConnected) return;
    container.remove();
    const note = document.createElement('div');
    note.className = 'model-chip-menu-note';
    note.textContent = t('exec_config.cli_no_models');
    menu.appendChild(note);
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────

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
    // Recipient changes re-resolve the effective config (agent defaults /
    // API model pick) — the chip must follow the target.
    window.addEventListener('cogseed:recipient-changed', () => _modelChipRenderAll());
    // Agent defaults (default_model / default_thinking) can change from the
    // agent settings page while a chat is open.
    window.addEventListener('cogseed:agents-cache-refreshed', () => _modelChipRenderAll());
  }
  refreshModelChipEntries();
  refreshModelChipEffort();
}

window.initModelChip = initModelChip;
window.refreshExecConfigChip = _modelChipRenderAll;
window.getModelChipEntries = getModelChipEntries;
