// ─── Composer execution-config chip (unified execution entry) ──────────
// Injected into each composer bottom-bar, right-aligned next to the send
// button. Shows the ACTUAL execution config for the current task — the
// model and reasoning effort the next message will run with — and lets the
// user adjust them for THIS conversation only:
//
//   recipient = Commander      → global default entry + global effort pref
//   recipient = local Agent    → the agent's own defaults (agent settings).
//                                CLI-backed agents (方案 B): the model is the
//                                CLI's own decision (the gateway envelope has
//                                no model slot) — no model picker, only the
//                                reasoning-effort pills for CLIs with a real
//                                switch (claude)
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

// provider → models[]（auth.listModels 原样结果）：一级菜单悬停 provider 时
// 立刻弹二级模型清单用它，与能力表来自同一次请求（同一数据源，不重复拉）。
const _modelListByProvider = new Map();

// provider → { [modelId]: string[] }：模型在「模型配置 → 高级配置 → 推理等级」
// 里声明的思考强度档位（自定义 provider 的 reasoningLevels）。三级飞出层用它
// 标注「该模型已配置哪些档位」；内置 provider 无此数据（走能力表）。
const _modelLevelsByProvider = new Map();
let _modelChipLevelsLoaded = false;

// auth.listEntries 不带 reasoning 标注，能力表过去只在下钻二级列表时填充
// ——顶层菜单冷开会对自定义 provider 误显示「该模型不支持」。启动加载
// 条目时按 provider 预取标注，与下钻共用同一张表（同一数据源）。
async function _prefetchReasoningForEntries(force = false) {
  const providers = new Set(_modelChipEntries.map((e) => e && e.provider).filter(Boolean));
  let changed = await _prefetchConfiguredReasoningLevels(force);
  for (const provider of providers) {
    // 已有表（含标注为空的空表）不再重复拉；IPC 失败不入表，下次打开重试。
    if (!force && _modelReasoningByProvider.has(provider)) continue;
    try {
      const res = await window.cogseed.invoke('auth.listModels', { provider });
      if (!(res && res.ok && Array.isArray(res.models))) continue;
      const table = {};
      for (const m of res.models) {
        if (m && typeof m === 'object' && typeof m.reasoning === 'boolean') table[String(m.id)] = m.reasoning;
      }
      _modelReasoningByProvider.set(String(provider), table);
      _modelListByProvider.set(String(provider), res.models);
      changed = true;
    } catch { /* 下次打开菜单重试 */ }
  }
  return changed;
}

/** 模型配置里声明的思考强度档位（自定义 provider）：三级飞出层的档位标注。
 *  数据来自 customProviders.list（与设置页同一来源），按 cp:<id> 建表；失败
 *  静默——档位标注是增强信息，缺了不影响选择。成功一次即不再重复拉，配置
 *  变更（cogseed:model-entries-changed）时 force 重拉。 */
async function _prefetchConfiguredReasoningLevels(force = false) {
  if (_modelChipLevelsLoaded && !force) return false;
  try {
    const res = await window.cogseed.invoke('customProviders.list');
    if (!(res && Array.isArray(res.providers))) return false;
    for (const provider of res.providers) {
      const levels = {};
      for (const model of Array.isArray(provider.models) ? provider.models : []) {
        const id = String((model && model.id) || '').trim();
        if (!id) continue;
        const declared = Array.isArray(model.reasoningLevels)
          ? model.reasoningLevels.map((level) => String(level || '').trim()).filter(Boolean)
          : [];
        if (declared.length) levels[id] = declared;
      }
      _modelLevelsByProvider.set(`cp:${provider.id}`, levels);
    }
    _modelChipLevelsLoaded = true;
    return true;
  } catch {
    return false;
  }
}

/** 该模型声明的思考强度档位（没有则空数组）。 */
function _configuredLevelsFor(provider, model) {
  const table = _modelLevelsByProvider.get(String(provider || ''));
  const levels = table ? table[String(model || '')] : null;
  return Array.isArray(levels) ? levels : [];
}

/** 某个 provider 的模型清单：命中缓存直接返回，否则拉一次并入表（能力表
 *  同步填充——二级/三级与顶层菜单共用同一份标注）。 */
async function _loadProviderModels(provider) {
  const key = String(provider || '');
  const cached = _modelListByProvider.get(key);
  if (Array.isArray(cached)) return cached;
  try {
    const res = await window.cogseed.invoke('auth.listModels', { provider: key });
    if (!(res && res.ok && Array.isArray(res.models))) return [];
    const table = {};
    for (const m of res.models) {
      if (m && typeof m === 'object' && typeof m.reasoning === 'boolean') table[String(m.id)] = m.reasoning;
    }
    _modelReasoningByProvider.set(key, table);
    _modelListByProvider.set(key, res.models);
    return res.models;
  } catch (err) {
    _modelChipLog.warn('list models failed', { error: (err && err.message) || String(err) });
    return [];
  }
}

const _EFFORT_OPTIONS = ['auto', 'off', 'low', 'high'];

function _modelSupportsThinking(modelId) {
  const id = String(modelId || '').toLowerCase();
  // Models known to accept a reasoning-effort style parameter. Unknown
  // models degrade to auto/off only.
  return /deepseek|gpt-5|\bo1\b|\bo3\b|claude|thinking|reasoner|kimi|qwen|glm|minimax|seed-2|doubao/.test(id);
}

/** Reasoning capability for a provider+model pair: explicit value from the
 *  list-models annotation first (custom providers now carry the recognition
 *  result). Custom-provider models with NO annotation stay disabled — the
 *  runtime does not forward reasoning for unrecognized ids either, and a
 *  name-regex unlock here would be a dead control. Built-in providers keep
 *  the heuristic fallback for cold catalog entries. */
function _modelReasoningCapability(provider, model) {
  const table = _modelReasoningByProvider.get(String(provider || ''));
  if (table && Object.prototype.hasOwnProperty.call(table, String(model || ''))) {
    return table[String(model || '')] === true;
  }
  if (String(provider || '').startsWith('cp:')) return false;
  return _modelSupportsThinking(model);
}

async function refreshModelChipEntries() {
  try {
    const res = await window.cogseed.invoke('auth.listEntries');
    if (res && res.ok && Array.isArray(res.entries)) {
      _modelChipEntries = res.entries;
      _modelChipRenderAll();
      void _prefetchReasoningForEntries();
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
    const hit = list.find((a) => a && a.agent_id === r.id) || null;
    if (!hit && typeof loadAgents === 'function' && !Array.isArray(_agentsCache)) {
      // 缓存为 null（agent 编辑等流程会先置空再回填，回填失败则一直空）：
      // 接收者明明是 agent 却解析不出 spec，chip/菜单会静默滑到指挥官的
      // API 语义。后台补拉一次，拉回后 agents-cache-refreshed 事件会触发
      // chip 重渲染自愈；本次渲染先按现状走。
      try { void loadAgents(true); } catch (_) { /* already running */ }
    }
    return hit;
  } catch (_) { return null; }
}

function _isCliAgent(agent) {
  return !!(agent && agent.runtime && (agent.runtime.kind === 'cli' || agent.runtime.kind === 'p3394-gateway'));
}

/** Resolve what the NEXT message in this target will actually run with.
 *  Mirrors the main-process priority: task override > agent default >
 *  global default. Returns:
 *  { mode:'cli'|'api', model, modelLabel, provider, providerLabel,
 *    effort, effortOverridden, effortSupported, modelOverridden } */
// 外接智能体执行控制：模型/强度的可改性由能力表决定
// （window.cliExecControl.execControlFor，与主进程 bus 同源）——claude/codex
// 有真实下发链路（信封 execution_prefs → --model / thread config），其余
// CLI 不放假开关。
function _effectiveExecConfig(target) {
  const recipient = (typeof getChatRecipient === 'function') ? getChatRecipient(target) : { kind: 'commander' };
  const override = (typeof getExecOverride === 'function') ? (getExecOverride(target) || {}) : {};
  const defaultEntry = _modelChipEntries[0] || null;

  // CLI-backed local agent（CodexHost 显示规则照抄）：chip 永远显示具体模型名，
  // 不显示「默认」占位——优先级：任务级覆盖 > agent 默认 runtime.model > 扫描
  // current（CLI 自报当前）> 清单 default 条目（claude 'default'/workbuddy
  // 'auto'）> 清单第一项；扫描在途显示「正在加载」；仅完全无数据才占位。
  // 模型可控性由网关运行时协商（modelControllable）。effort 按兜底能力表。
  const agent = _recipientAgent(target);
  if (recipient.kind === 'agent' && _isCliAgent(agent)) {
    const cliType = (agent.runtime && agent.runtime.cli) || '';
    const ctl = (typeof window !== 'undefined' && window.cliExecControl)
      ? window.cliExecControl
      : null;
    const modelSupported = ctl ? ctl.modelControllableFor(cliType) : true;
    // 强度可控性同模型：网关协商（effort_controllable，自建智能体经
    // P3394_AGENT_EFFORT_ARGS 声明也协商为 true）优先，未协商走兜底表。
    const effortSupported = ctl ? ctl.effortControllableFor(cliType) : false;
    const runtimeModel = (agent.runtime && agent.runtime.model) || '';
    const scanEntry = ctl ? ctl.cachedCliModels(cliType) : null;
    const effective = ctl ? ctl.effectiveModelLabel(cliType, scanEntry) : null;
    const modelChoice = (modelSupported && override.model) ? String(override.model)
      : (modelSupported && runtimeModel) ? String(runtimeModel)
      : '';
    const scanning = ctl && ctl.scanInFlight(cliType) && !scanEntry;
    const modelLabel = modelChoice
      || (scanEntry && scanEntry.current)
      || (effective ? effective.label : '')
      || (scanning ? t('exec_config.cli_models_loading') : t('exec_config.cli_default_model'));
    return {
      mode: 'cli',
      cliType,
      modelSupported,
      model: modelChoice,
      modelLabel,
      modelIsCliCurrent: !modelChoice && !!(scanEntry && scanEntry.current),
      provider: '',
      providerLabel: cliType,
      effort: (override.effort === 'off' || override.effort === 'low' || override.effort === 'high') ? override.effort : null,
      effortOverridden: override.effort === 'off' || override.effort === 'low' || override.effort === 'high',
      effortSupported,
      modelOverridden: !!(modelSupported && override.model),
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
  const settingsIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('settings', 'model-chip-icon')
    : '';
  const chevron = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('chevron-down', 'model-chip-chevron')
    : '';
  chip.innerHTML =
    settingsIcon + '<span class="model-chip-label"></span>' +
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
  _modelChipRenderChipsOnly();
  _refreshOpenMemberMenu();
}

function _modelChipRenderChipsOnly() {
  document.querySelectorAll('.model-chip[data-model-target]').forEach((chip) => _modelChipRenderChip(chip));
}

/** 成员/来源变化时让已展开的多来源菜单与真实状态保持一致：来源消失（取消成员）
 *  关闭其第二层、只剩一套时恢复直达、来源行摘要跟着更新（FR-014）。菜单处于旧
 *  单接收者视图时不介入——那条路径由它自己的事件驱动。 */
function _refreshOpenMemberMenu() {
  const menu = document.getElementById('model-chip-menu');
  if (!menu) return;
  if (String(menu.dataset.view || '').indexOf('member') !== 0) return;
  const target = menu.dataset.modelTarget || '';
  const anchor = document.querySelector(`.model-chip[data-model-target="${target}"]`);
  const groups = anchor ? _memberSourceGroups(target) : null;
  if (!anchor || !groups || !groups.length) {
    _closeMenuWithFlyouts();
    return;
  }
  _closeFlyouts();
  _renderExecConfigMenu(menu, anchor);
  _positionModelMenu(menu, anchor);
}

/** 切到外接智能体时后台拉一次模型扫描（有缓存直接命中）——chip 的
 *  「CLI 当前模型」标签来自扫描结果的 current 字段，异步回来重渲染。 */
async function _scanCliCurrentForChips() {
  const ctl = (typeof window !== 'undefined' && window.cliExecControl) ? window.cliExecControl : null;
  if (!ctl) return;
  const seen = new Set();
  for (const target of ['conversation', 'new-chat', 'project']) {
    try {
      const agent = _recipientAgent(target);
      if (!_isCliAgent(agent) || !agent.runtime || !agent.runtime.cli) continue;
      const cli = agent.runtime.cli;
      if (seen.has(cli)) continue;
      seen.add(cli);
      await ctl.loadCliModels(agent.agent_id, cli);
    } catch { /* 扫描失败保持现状（占位标签）*/ }
  }
  _modelChipRenderAll();
}

function _modelChipRenderChip(chip) {
  const target = _chipTargetForElement(chip);
  const groups = _memberSourceGroups(target);
  const cfg = _effectiveExecConfig(target);
  const hasRecipient = (typeof getChatRecipient === 'function')
    && getChatRecipient(target).kind !== 'commander';
  // 有会话成员时入口始终可见：外接实例的模型配置即使在没有 API 模型时也要能调。
  if (!(groups && groups.length) && !cfg.model && !hasRecipient && !_modelChipEntries.length) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;

  const labelEl = chip.querySelector('.model-chip-label');
  const effortEl = chip.querySelector('.exec-config-effort');
  const cliMode = cfg.mode === 'cli';

  // 多 Agent：入口按会话成员的配置套数变化（FR-008）。单套显示具体模型并直达
  // 其选项；多套显示「模型配置」并先列来源，强度徽标只在单套显示。
  if (groups && groups.length) {
    const multi = groups.length > 1;
    const only = groups[0];
    if (labelEl) {
      labelEl.textContent = multi ? t('composer.model.title') : _memberSourceModelLabel(target, only);
    }
    if (effortEl) {
      const effort = multi ? '' : ((_memberSourceConfig(target, only.id) || {}).effort || '');
      effortEl.hidden = multi;
      effortEl.textContent = multi ? '' : _execEffortLabel(effort || 'auto');
      effortEl.classList.remove('is-cli');
      effortEl.classList.toggle('is-override', !multi && !!effort);
    }
    const overridden = groups.some((group) => {
      const conf = _memberSourceConfig(target, group.id);
      return !!(conf && (conf.model || conf.effort));
    });
    chip.classList.toggle('is-override', overridden);
    chip.title = multi
      ? t('composer.model.multi_title')
      : t('exec_config.title');
    return;
  }

  if (labelEl) {
    labelEl.textContent = cfg.modelLabel
      || (cliMode ? t('exec_config.cli_default_model') : t('exec_config.no_model'));
  }
  if (effortEl) {
    effortEl.hidden = false;
    if (cliMode) {
      // claude：选了档位就显示档位（本次任务徽标态）；否则显示 CLI 徽标。
      if (cfg.effort) {
        effortEl.textContent = _execEffortLabel(cfg.effort);
        effortEl.classList.add('is-override');
        effortEl.classList.remove('is-cli');
      } else {
        effortEl.textContent = t('exec_config.cli_badge');
        effortEl.classList.add('is-cli');
        effortEl.classList.remove('is-override');
      }
    } else {
      const displayEffort = cfg.effort || 'auto';
      effortEl.textContent = _execEffortLabel(displayEffort);
      effortEl.classList.remove('is-cli');
      effortEl.classList.toggle('is-override', cfg.effortOverridden);
    }
  }
  const overrideMarker = cfg.modelOverridden || cfg.effortOverridden;
  chip.classList.toggle('is-override', !!overrideMarker);
  chip.title = cliMode
    ? (cfg.modelIsCliCurrent
      ? t('exec_config.cli_current_model_title', { model: cfg.modelLabel })
      : t('exec_config.effort_cli_note'))
    : t('exec_config.title');
}

// ─── Menu ─────────────────────────────────────────────────────────────────

// ── 多 Agent：按来源的模型配置（PRD FR-007～014） ─────────────────────────
// 套数只随会话成员变化：CogSeed 与全部 Task Agent 共用一套 API 配置，每个外接
// Agent 实例各自一套。单套 → 入口直达模型 + 竖排思考强度；多套 → 入口显示
// 「模型配置」，第一层列来源，悬浮/点击/键盘展开第二层。

function _memberSourceGroups(target) {
  const cm = (typeof window !== 'undefined') ? window.composerMembers : null;
  if (!cm || typeof cm.getMembers !== 'function' || typeof cm.configGroups !== 'function') return null;
  if (!cm.getMembers(target).length) return null;
  return cm.configGroups(target);
}

function _memberSourceConfig(target, sourceId) {
  const cm = window.composerMembers;
  if (!cm || typeof cm.getSourceConfig !== 'function') return null;
  return cm.getSourceConfig(target, sourceId) || {};
}

function _memberSourceWrite(target, sourceId, patch) {
  const cm = window.composerMembers;
  if (!cm || typeof cm.setSourceConfig !== 'function') return;
  cm.setSourceConfig(target, sourceId, patch);
  // 只重画入口：菜单/第二层的层内状态由调用方维护（选完模型要回第一层，
  // 点强度要保持当前层），整菜单重画会把用户正在看的层拆掉。
  _modelChipRenderChipsOnly();
}

function _memberAgentRecord(agentId) {
  const list = (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) ? _agentsCache : [];
  return list.find((a) => a && a.agent_id === agentId) || null;
}

/** 来源当前生效的模型标签：显式配置 > 外接跟随其自身 > 内部默认条目。 */
function _memberSourceModelLabel(target, group) {
  const conf = _memberSourceConfig(target, group.id);
  if (conf.model) return conf.modelLabel || conf.model;
  if (group.external) {
    const agent = _memberAgentRecord(group.id);
    const cli = (agent && agent.runtime && agent.runtime.cli) || '';
    const ctl = window.cliExecControl;
    const scan = ctl ? ctl.cachedCliModels(cli) : null;
    if (scan && scan.current) return scan.current;
    const eff = ctl ? ctl.effectiveModelLabel(cli, scan) : null;
    if (eff && eff.label) return eff.label;
    return t('exec_config.cli_default_model');
  }
  const entry = _modelChipEntries[0];
  return (entry && (entry.modelName || entry.model)) || t('exec_config.no_model');
}

function _memberSourceEffortLabel(target, group) {
  return _execEffortLabel(_memberSourceConfig(target, group.id).effort || 'auto');
}

/** 第二层：某来源的模型清单 + 竖排思考强度（悬浮切换来源时整层重画）。 */
function _openMemberSourceFlyout(target, group, rowEl, pin) {
  if (pin) { _cancelFlyoutTimers(); _flyoutPinned = true; }
  const flyout = _ensureFlyout('models');
  _closeFlyout('levels');
  _flyoutProviderKey = `member:${group.id}`;
  flyout.innerHTML = '';
  // 第二层保留来源名称标题（FR-009）。
  _flyoutHeader(flyout, group.name, _memberSourceModelLabel(target, group));
  _renderMemberSourceBody(flyout, target, group, { flyout: true });
  _positionFlyout(flyout, rowEl);
}

function _renderMemberConfigMenu(menu, anchor, target, groups) {
  const multi = groups.length > 1;
  menu.dataset.view = multi ? 'member-sources' : 'member-source-single';
  if (multi) {
    const header = document.createElement('div');
    header.className = 'model-chip-menu-header';
    header.textContent = t('composer.model.title');
    header.title = t('composer.model.multi_title');
    menu.appendChild(header);
  } else {
    // 单套：直达该来源的选项，不显示来源标题（FR-011）。
    _renderMemberSourceBody(menu, target, groups[0], {});
    return;
  }
  groups.forEach((group) => {
    const item = document.createElement('div');
    item.className = 'model-chip-menu-item model-chip-menu-item--provider';
    item.tabIndex = 0;
    item.dataset.configSource = group.id;
    item.setAttribute('aria-expanded', 'false');
    // FR-011：来源行不显示 `>`／`›` 箭头（原型同样没有），靠悬浮/点击展开。
    item.innerHTML = '<span class="model-chip-menu-main">'
      + `<span class="model-chip-menu-name">${escapeHtml(group.name)}</span></span>`
      + `<span class="model-chip-menu-sub">${escapeHtml(`${_memberSourceModelLabel(target, group)} · ${_memberSourceEffortLabel(target, group)}`)}</span>`;

    const open = (pin) => _openMemberSourceFlyout(target, group, item, pin);
    item.addEventListener('mouseenter', () => _scheduleFlyoutOpen(() => open(false), _MEMBER_FLYOUT_DELAY));
    item.addEventListener('mouseleave', _scheduleFlyoutClose);
    item.addEventListener('focus', () => open(true));
    item.addEventListener('click', (e) => { e.stopPropagation(); open(true); });
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
        e.preventDefault();
        open(true);
      }
    });
    item.addEventListener('blur', () => {
      setTimeout(() => {
        const active = document.activeElement;
        if (active && (_inFlyout(active) || menu.contains(active))) return;
        _closeFlyouts();
      }, 0);
    });
    menu.appendChild(item);
  });
}

/** 来源内容的宿主：标题/头部留在层里，重画只换宿主内容。
 *  （不这么做，任何一次重画都会往同一层里再叠一份 —— 重复堆叠的根因。） */
function _memberSourceBodyHost(container) {
  for (const child of Array.from(container.children || [])) {
    if (child.classList && child.classList.contains('model-chip-menu-body')) return child;
  }
  const host = document.createElement('div');
  host.className = 'model-chip-menu-body';
  container.appendChild(host);
  return host;
}

/** 一个来源的模型行 + 竖排思考强度；「跟随默认」行清空该来源的显式配置。 */
function _renderMemberSourceBody(container, target, group, opts) {
  const host = _memberSourceBodyHost(container);
  host.replaceChildren();
  const conf = _memberSourceConfig(target, group.id);
  const finish = () => {
    if (opts.flyout) {
      // 多套：选完模型回到来源层并更新摘要（FR-010）。
      _closeFlyouts();
      const menu = document.getElementById('model-chip-menu');
      const anchor = menu
        ? document.querySelector(`.model-chip[data-model-target="${menu.dataset.modelTarget || ''}"]`)
        : null;
      if (menu && anchor) {
        _renderExecConfigMenu(menu, anchor);
        _positionModelMenu(menu, anchor);
      }
      return;
    }
    _closeModelMenu();
  };
  const pickModel = (patch) => {
    // 换模型后原强度不受支持 → 恢复该来源的默认强度并提示（FR-013）。
    const next = { ...(patch || {}) };
    const supported = (next.provider && next.model)
      ? _modelReasoningCapability(next.provider, next.model)
      : null;
    const currentEffort = conf.effort;
    if (supported === false && (currentEffort === 'low' || currentEffort === 'high')) {
      next.effort = '';
      if (typeof uiToast === 'function') {
        uiToast(t('composer.model.effort_reset_notice', { level: t(`model_effort.${currentEffort}`) }), {
          variant: 'warning',
        });
      }
    }
    _memberSourceWrite(target, group.id, next);
    finish();
  };
  const row = (label, sub, active, onPick) => {
    const item = document.createElement('div');
    item.className = 'model-chip-menu-item' + (active ? ' is-default' : '');
    item.tabIndex = 0;
    item.setAttribute('aria-pressed', active ? 'true' : 'false');
    item.innerHTML = '<span class="model-chip-menu-main">'
      + `<span class="model-chip-menu-name">${escapeHtml(label)}</span>`
      + (active ? `<span class="model-chip-menu-default">${escapeHtml(t('exec_config.current_badge'))}</span>` : '')
      + '</span>'
      + (sub ? `<span class="model-chip-menu-sub">${escapeHtml(sub)}</span>` : '');
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      onPick();
    });
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); }
    });
    host.appendChild(item);
    return item;
  };

  row(t('composer.model.follow_default'), '', !conf.model && !conf.effort, () => pickModel(null));

  if (group.external) {
    const agent = _memberAgentRecord(group.id);
    const cli = (agent && agent.runtime && agent.runtime.cli) || '';
    const ctl = window.cliExecControl;
    const scan = ctl ? ctl.cachedCliModels(cli) : null;
    // 只看扫描结果会让"读不到清单"变成"完全不可配置"：合并静态目录与手输记忆后，
    // 即使扫描失败也仍有可选模型（与既有 CLI 模型菜单同一份清单）。
    const models = (ctl && typeof ctl.mergedCliModels === 'function')
      ? ctl.mergedCliModels(cli, scan)
      : ((scan && Array.isArray(scan.models)) ? scan.models : []);
    const modelSupported = ctl ? ctl.modelControllableFor(cli) : false;
    const rerender = () => _renderMemberSourceBody(container, target, group, opts);
    if (modelSupported && typeof _renderCliModelList === 'function') {
      // 与既有 CLI 模型菜单同一份清单与同一套入口（搜索 / 手输模型 / 当前标记）：
      // 只按来源把"写回"换成该来源自己的配置。清单读取失败时它自己带重试与说明，
      // 不再出现"读不到就等于没法配"的死局面。
      void _renderCliModelList(
        host,
        container,
        {
          mode: 'cli',
          agent: agent || undefined,
          cliType: cli,
          providerLabel: cli,
          model: conf.model || '',
          modelLabel: conf.modelLabel || '',
          modelSupported: true,
        },
        target,
        cli,
        {
          // 宿主在层内，不需要（也不能）按 fixed 菜单重新定位。
          skipPositioning: true,
          onRescan: rerender,
          applyPick: (modelId, isCustom) => {
            const patch = modelId
              ? { model: String(modelId), modelLabel: String(modelId) }
              : null;
            // 手输模型要记住，下次直接可选（与既有菜单一致）。
            if (modelId && isCustom && ctl && typeof ctl.rememberCustomModel === 'function') {
              try { ctl.rememberCustomModel(cli, String(modelId)); } catch { /* best-effort */ }
            }
            _memberSourceWrite(target, group.id, patch);
            finish();
          },
        },
      );
      return;
    }
    if (!modelSupported) {
      // 该来源没有模型下发通道：不放假开关，明示「由该 Agent 管理」（FR-013）。
      const note = document.createElement('div');
      note.className = 'model-chip-menu-note';
      note.textContent = t('composer.model.managed_by_agent');
      host.appendChild(note);
    } else {
      models.forEach((model) => {
        const id = String((model && typeof model === 'object') ? (model.id || model.label || '') : model || '');
        if (!id) return;
        const label = String((model && (model.label || model.id)) || id);
        const sub = id === (scan && scan.current)
          ? t('composer.model.cli_current')
          : String((model && model.description) || '');
        row(label, sub, conf.model === id, () => pickModel({ model: id, modelLabel: label }));
      });
      if (!models.length) {
        const loading = ctl && ctl.scanInFlight(cli);
        const note = document.createElement('div');
        note.className = 'model-chip-menu-note';
        note.textContent = loading
          ? t('exec_config.cli_models_loading')
          : t('composer.model.cli_models_unavailable');
        host.appendChild(note);
        // 读取失败可重试（FR-013）：重新扫描该 CLI 的模型清单后原位重画。
        if (!loading && ctl && typeof ctl.loadCliModels === 'function') {
          row(t('composer.model.cli_models_retry'), '', false, () => {
            void ctl.loadCliModels(group.id, cli, { refresh: true }).then(() => {
              if (host.isConnected) rerender();
            }).catch(() => {});
          });
        }
      }
    }
    _renderMemberEffortRows(host, target, group, conf, {
      supported: modelSupported && (ctl ? ctl.effortControllableFor(cli) : false),
      rerender,
    });
    return;
  }

  // 内部共享来源：先画当前生效条目，provider 目录异步到达后原位重画。
  const seen = new Set();
  const entries = [];
  if (conf.provider && conf.model) entries.push({ provider: conf.provider, model: conf.model, modelName: conf.modelLabel });
  _modelChipEntries.forEach((entry) => {
    if (!entry || !entry.provider) return;
    const key = `${entry.provider}/${entry.model || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  });
  let pending = false;
  entries.forEach((entry) => {
    const provider = String(entry.provider || '');
    const cached = _modelListByProvider.get(provider);
    const models = (Array.isArray(cached) && cached.length)
      ? cached.map((m) => ((m && typeof m === 'object')
        ? { id: String(m.id || m.name || ''), name: String(m.name || m.id || '') }
        : { id: String(m), name: String(m) }))
      : [{ id: String(entry.model || ''), name: String(entry.modelName || entry.model || '') }];
    models.filter((m) => m.id).forEach((model) => {
      row(
        model.name || model.id,
        entry.providerLabel || provider,
        conf.provider === provider && conf.model === model.id,
        () => pickModel({ provider, model: model.id, modelLabel: model.name || model.id }),
      );
    });
    if (!Array.isArray(cached)) {
      pending = true;
      void _loadProviderModels(provider).then((list) => {
        if (!host.isConnected || !Array.isArray(list) || !list.length) return;
        _renderMemberSourceBody(container, target, group, opts);
      });
    }
  });
  if (pending) {
    const note = document.createElement('div');
    note.className = 'model-chip-menu-note';
    note.textContent = t('model_chip.loading_models');
    host.appendChild(note);
  }
  _renderMemberEffortRows(host, target, group, conf, {
    supported: (conf.provider && conf.model)
      ? _modelReasoningCapability(conf.provider, conf.model)
      : true,
    rerender: () => _renderMemberSourceBody(container, target, group, opts),
  });
}

/** 竖排思考强度：每项一行，点选保持当前层打开（FR-010）。 */
function _renderMemberEffortRows(container, target, group, conf, opts) {
  const section = document.createElement('div');
  section.className = 'model-chip-menu-section';
  section.textContent = t('model_effort.menu_title');
  container.appendChild(section);
  _EFFORT_OPTIONS.forEach((level) => {
    const unavailable = (level === 'low' || level === 'high') && opts.supported === false;
    const active = (conf.effort || 'auto') === level;
    const item = document.createElement('div');
    item.className = 'model-chip-menu-item'
      + (active ? ' is-default' : '')
      + (unavailable ? ' is-disabled' : '');
    item.tabIndex = unavailable ? -1 : 0;
    item.setAttribute('aria-pressed', active ? 'true' : 'false');
    item.dataset.memberEffort = level;
    item.innerHTML = '<span class="model-chip-menu-main">'
      + `<span class="model-chip-menu-name">${escapeHtml(t('model_effort.' + level))}</span></span>`
      + (active ? `<span class="model-chip-menu-default">${escapeHtml(t('exec_config.current_badge'))}</span>` : '');
    if (unavailable) {
      item.title = t('model_effort.unsupported_title');
      container.appendChild(item);
      return;
    }
    const apply = () => {
      _memberSourceWrite(target, group.id, { effort: level === 'auto' ? '' : level });
      // 强度点选保持当前层打开并显示选中态（FR-010）。
      if (typeof opts.rerender === 'function') opts.rerender();
    };
    item.addEventListener('click', (e) => { e.stopPropagation(); apply(); });
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); }
    });
    container.appendChild(item);
  });
}

function _clampMenuLeft(preferredLeft, menuWidth) {
  const edge = 8;
  const maxLeft = Math.max(edge, window.innerWidth - menuWidth - edge);
  return Math.min(Math.max(edge, preferredLeft), maxLeft);
}

function _positionModelMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.zIndex = '12000';
  document.body.appendChild(menu);
  const menuWidth = menu.offsetWidth || 320;
  menu.style.left = _clampMenuLeft(rect.left, menuWidth) + 'px';
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
    // 飞出层同样属于这个菜单：点三级档位不能被当成"外部点击"先把菜单关了。
    if (menu.contains(e.target) || anchor.contains(e.target) || _inFlyout(e.target)) return;
    _closeMenuWithFlyouts();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    // 级联是两层：Escape 先收飞出层，再按一次收菜单（一次全关会让人找不回上一级）。
    if (document.querySelector('.model-chip-flyout')) {
      _closeFlyouts();
      e.preventDefault();
      return;
    }
    _closeMenuWithFlyouts();
    e.preventDefault();
  };
  menu._onDocDown = onDocDown;
  menu._onKey = onKey;
  // 页面滚动/窗口变化会让 fixed 定位的菜单脱离锚点，照旧收起；但菜单
  // 自己的滚动（模型列表翻页、搜索框横滚——capture 监听对不冒泡的
  // scroll 事件同样可见）必须忽略，否则用户一滚菜单就秒关，长清单
  // 根本翻不动。
  const onViewportChange = (e) => {
    const t = e && e.target;
    if (t && t.nodeType && (t === menu || menu.contains(t) || _inFlyout(t))) return;
    _closeMenuWithFlyouts();
  };
  menu._onViewportChange = onViewportChange;
  menu._onDocDownTimer = setTimeout(() => {
    menu._onDocDownTimer = null;
    if (document.getElementById('model-chip-menu') !== menu) return;
    document.addEventListener('mousedown', onDocDown, true);
  }, 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onViewportChange);
  document.addEventListener('scroll', onViewportChange, true);
}

/** 菜单 + 两级飞出层一起收：飞出的子菜单不属于 menu 子树，漏关会留下
 *  悬浮孤儿层（且它的滚动/点击不再被菜单的关闭逻辑覆盖）。 */
function _closeMenuWithFlyouts() {
  _closeFlyouts();
  _closeModelMenu();
}

function _closeModelMenu() {
  _closeFlyouts();
  const menu = document.getElementById('model-chip-menu');
  if (!menu) return;
  if (menu._onDocDownTimer != null) {
    clearTimeout(menu._onDocDownTimer);
    menu._onDocDownTimer = null;
  }
  document.removeEventListener('mousedown', menu._onDocDown, true);
  document.removeEventListener('keydown', menu._onKey, true);
  window.removeEventListener('resize', menu._onViewportChange);
  document.removeEventListener('scroll', menu._onViewportChange, true);
  menu.remove();
  document.querySelectorAll('.model-chip--open').forEach((el) => el.classList.remove('model-chip--open'));
}

// Kept as a small public bridge for boot/navigation teardown callers.
window.closeModelChipMenu = _closeModelMenu;
if (typeof window.registerComposerPopover === 'function') {
  window.registerComposerPopover('model', _closeModelMenu);
}

/** One menu, two sections: model (with provider drill-down) + effort. */
function _toggleExecConfigMenu(anchor) {
  if (typeof window.closeComposerPopovers === 'function') window.closeComposerPopovers('model');
  const old = document.getElementById('model-chip-menu');
  if (old) { _closeModelMenu(); return; }

  // 开菜单瞬间用当前状态同步重画锚点 chip：chip 平时靠事件重渲染
  // （recipient/agents-cache 变化），任何一次事件丢失或时序错位都会让它
  // 停在旧态——用户会看到 chip 写着 A、菜单列着 B。菜单与 chip 读同一个
  // _effectiveExecConfig，这里同步重画后两者必然一致。
  _modelChipRenderChip(anchor);
  const menu = document.createElement('div');
  menu.id = 'model-chip-menu';
  menu.className = 'model-chip-menu model-chip-menu--exec composer-popover';
  menu.dataset.modelTarget = _chipTargetForElement(anchor);
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

  // 多 Agent：有显式会话成员时按来源分层；无成员时沿用原单接收者菜单，
  // 既有交互不受影响。
  const memberGroups = _memberSourceGroups(target);
  if (memberGroups && memberGroups.length) {
    _renderMemberConfigMenu(menu, anchor, target, memberGroups);
    return;
  }

  // Compact single-line header: title carries the scope note (task-only)
  // so no subheader row is needed.
  const header = document.createElement('div');
  header.className = 'model-chip-menu-header';
  header.textContent = cfg.mode === 'cli'
    ? t('exec_config.subheader_cli', { name: (cfg.agent && cfg.agent.name) || '' })
    : t('exec_config.menu_title');
  header.title = t('exec_config.title');
  menu.appendChild(header);

  // CLI 场景（外接智能体执行控制）——能力表内的 CLI（claude/codex）模型与
  // 强度真实可控：模型列表来自运行时扫描（问 CLI 本身，IPC
  // p3394.external.listModels）∪ 静态目录 ∪ 手输记忆；表外 CLI 只保留说明
  // （不放假开关）。扫描失败 → 回落静态+手输，UI 说明原因。
  if (cfg.mode === 'cli') {
    const cliType = cfg.providerLabel || '';
    if (cfg.modelSupported) {
      _menuSectionLabel(menu, 'exec_config.section_model', cfg.cliType || cliType);
      void _renderCliModelList(menu, anchor, cfg, target, cliType);
    }
    _menuSectionLabel(menu, 'exec_config.section_effort');
    if (cfg.effortSupported) {
      _renderCliEffortSegmented(menu, anchor, cfg, cliType);
    } else {
      const note = document.createElement('div');
      note.className = 'model-chip-menu-note';
      note.textContent = t('exec_config.effort_cli_note');
      menu.appendChild(note);
    }
    return;
  }

  // ── Provider section（一级：provider 名称）──
  // 级联：悬停 provider → 二级模型清单 → 悬停模型 → 三级思考强度。一级不再
  // 平铺模型行（模型放到二级），当前生效的 provider 带「当前/本次任务」徽标；
  // 思考强度也从一级移到三级——它本来就是"某个模型"的属性，挂在模型下面口径
  // 才对得上（模型配置页的推理等级同源）。
  _menuSectionLabel(menu, 'exec_config.section_provider');

  if (_modelChipEntries.length || cfg.model) {
    _renderProviderRows(menu, anchor, target, cfg);
  }
  // 「管理模型」兜底入口（产品交互图）：列表下方一行，跳「设置 → 配置」。
  // 菜单管的是"本次任务用哪个"，配置页管的是"有哪些可用"——没有这行时
  // 用户只能自己找设置入口。
  _renderManageModelsRow(menu);

  // 推理能力标注/模型清单/声明档位补拉（冷开兜底）：预取通常在条目加载时已
  // 完成，这里只处理「菜单先开、数据后到」的窗口——取回新数据且菜单仍留在
  // 顶层时原位重画。changed 才重画（否则「重画→再预取→再重画」死循环）。
  menu.dataset.view = 'exec';
  void _prefetchReasoningForEntries().then((changed) => {
    if (!changed || !menu.isConnected || menu.dataset.view !== 'exec') return;
    const repaint = () => {
      if (!menu.isConnected || menu.dataset.view !== 'exec') return;
      _renderExecConfigMenu(menu, anchor);
      _positionModelMenu(menu, anchor);
    };
    // 飞出层正被使用（悬停级联中）时推迟到关闭后再重画：重画会重建行，
    // 旧行上打开的飞出层既收不到 mouseleave（悬空）、也会把用户正看的
    // 级联拆掉。推迟使重画永不发生在飞出层打开期间——悬空成因被消除。
    if (_flyoutProviderKey) {
      _pendingExecRepaint = repaint;
      return;
    }
    repaint();
  });
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

/** 「管理模型」行：与列表项同款行样式 + 上方分隔线，点击跳设置配置页。 */
function _renderManageModelsRow(menu) {
  const divider = document.createElement('div');
  divider.className = 'model-chip-menu-divider';
  divider.setAttribute('role', 'separator');
  menu.appendChild(divider);

  const row = document.createElement('div');
  row.className = 'model-chip-menu-item model-chip-menu-item--action';
  row.tabIndex = 0;
  row.dataset.action = 'manage-models';
  row.title = t('exec_config.manage_models_hint');
  row.innerHTML = '<span class="model-chip-menu-main">'
    + `<span class="model-chip-menu-name">${escapeHtml(t('exec_config.manage_models'))}</span>`
    + '</span>';
  const open = (e) => {
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    _openModelManagement();
  };
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      _openModelManagement();
    }
  });
  menu.appendChild(row);
}

/** 跳到「设置 → 配置」：与 Run Center 的锚点跳转同一条缝——
 *  setView 负责切视图并懒加载设置特性（boot.js 用 opts.settingsTab/anchor 调
 *  loadSettings），activateSettingsTab 负责立刻切 tab 与锚点（设置特性已在内存
 *  时的路径）。两处都传 anchor='models'：配置页的 focusAnchor 表里
 *  models → #settings-model-authorizations（模型供应商/模型配置那一组），
 *  落地就停在模型区而不是配置页顶部。 */
function _openModelManagement() {
  _closeMenuWithFlyouts();
  try {
    const rootWindow = (typeof window !== 'undefined') ? window : null;
    const viewFn = (typeof setView === 'function') ? setView : (rootWindow ? rootWindow.setView : null);
    if (typeof viewFn === 'function') {
      viewFn('settings', undefined, { settingsTab: 'configuration', settingsAnchor: 'models' });
    }
    if (rootWindow && typeof rootWindow.activateSettingsTab === 'function') {
      rootWindow.activateSettingsTab('configuration', { anchor: 'models' });
    }
  } catch (err) {
    _modelChipLog.warn('open model management failed', { error: (err && err.message) || String(err) });
  }
}

/** 一级菜单：每个已配置 provider 一行（当前生效的带徽标）。悬停即弹该
 *  provider 的模型清单（二级飞出层）；点击/键盘同样打开（触屏与键盘路径），
 *  与悬停共用同一个飞出层。provider 行不再直接选模型——选模型在二级。 */
function _renderProviderRows(menu, anchor, target, cfg) {
  const chevronIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('chevron-right', 'model-chip-menu-arrow-icon')
    : '›';

  // 条目按 provider 去重：同一 provider 可能有多条优先级条目（主/备），
  // 一级只列一次；当前生效的 provider 永远在列（接收者是清单外的模型时
  // 补一条合成行，否则它的思考强度没有入口）。
  const rows = [];
  const seen = new Set();
  _modelChipEntries.forEach((entry) => {
    if (!entry || !entry.provider) return;
    if (seen.has(entry.provider)) return;
    seen.add(entry.provider);
    rows.push(entry);
  });
  if (cfg.provider && !seen.has(cfg.provider)) {
    rows.unshift({ provider: cfg.provider, providerLabel: cfg.providerLabel, model: cfg.model, modelName: cfg.modelLabel });
  }

  rows.forEach((entry) => {
    const isCurrent = cfg.provider === entry.provider;
    const item = document.createElement('div');
    item.className = 'model-chip-menu-item model-chip-menu-item--provider' + (isCurrent ? ' is-default' : '');
    item.tabIndex = 0;
    item.dataset.provider = entry.provider;
    item.title = t('model_chip.expand_title');
    const provider = entry.providerLabel || entry.provider || '';
    const entryModel = entry.modelName || entry.model || '';
    // 主行 = provider 名称（展开后看的是"用哪家"），副行保留该 provider 当前
    // 生效的模型名——原先一行一个模型的信息不丢。
    item.innerHTML =
      '<span class="model-chip-menu-main">' +
      `<span class="model-chip-menu-name">${escapeHtml(provider)}</span>` +
      (isCurrent
        ? `<span class="model-chip-menu-default">${escapeHtml(cfg.modelOverridden ? t('exec_config.task_override_badge') : t('exec_config.current_badge'))}</span>`
        : '') +
      '</span>' +
      (entryModel ? `<span class="model-chip-menu-sub">${escapeHtml(entryModel)}</span>` : '');
    const expand = document.createElement('span');
    expand.className = 'model-chip-menu-arrow';
    expand.innerHTML = chevronIcon;
    item.appendChild(expand);

    const open = () => _openProviderFlyout(target, cfg, entry, item, { pin: false });
    const openPinned = () => _openProviderFlyout(target, cfg, entry, item, { pin: true });
    item.addEventListener('mouseenter', () => _scheduleFlyoutOpen(open));
    item.addEventListener('mouseleave', _scheduleFlyoutClose);
    item.addEventListener('focus', openPinned);
    // 键盘路径的关闭：悬停有 mouseleave，focus 打开的 pinned 飞出层此前
    // 没有 blur 对应——Tab 离开后飞出层钉住残留。焦点转入自家飞出层
    // （沿级联下钻）不关；转到别处则解除 pin 并收起。
    item.addEventListener('blur', () => {
      setTimeout(() => {
        const active = document.activeElement;
        if (active && _inFlyout(active)) return;
        if (active && menu.contains(active) && active !== item) return;
        _closeFlyouts();
      }, 0);
    });
    item.addEventListener('click', (e) => { e.stopPropagation(); openPinned(); });
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
        e.preventDefault();
        openPinned();
      }
    });
    menu.appendChild(item);
  });
}

// ── Right-side hover flyouts (provider → models → thinking strength) ──────
//
// 悬停级联：一级 provider 行 → 二级模型清单 → 三级思考强度。飞出层挂在
// body 上（与主菜单同样的 fixed 定位），指针进入飞出层取消关闭计时，离开
// 后才收起；点击/键盘打开则钉住，直到外部点击或 Escape——触屏没有 hover。

const _FLYOUT_OPEN_DELAY = 90;
const _FLYOUT_CLOSE_DELAY = 220;
// 多 Agent 按来源分层：离开「入口 + 两层弹层」整体区域约 140ms 后收起（FR-012），
// 跨层间隙重入即取消。既有 provider 级联沿用上面的原时长，互不影响。
const _MEMBER_FLYOUT_DELAY = 140;
let _flyoutOpenTimer = null;
let _flyoutCloseTimer = null;
let _flyoutPinned = false;
let _pendingExecRepaint = null;
let _flyoutProviderKey = '';

function _cancelFlyoutTimers() {
  if (_flyoutOpenTimer) { clearTimeout(_flyoutOpenTimer); _flyoutOpenTimer = null; }
  if (_flyoutCloseTimer) { clearTimeout(_flyoutCloseTimer); _flyoutCloseTimer = null; }
}

function _scheduleFlyoutOpen(open, delay) {
  _cancelFlyoutTimers();
  _flyoutPinned = false;
  _flyoutOpenTimer = setTimeout(() => {
    _flyoutOpenTimer = null;
    open();
  }, Number.isFinite(delay) ? delay : _FLYOUT_OPEN_DELAY);
}

function _scheduleFlyoutClose(delay) {
  if (_flyoutPinned) return;
  _cancelFlyoutTimers();
  // 多来源层已展开时按 FR-012 的 140ms 收起（含移出到菜单外的情况）。
  const wait = Number.isFinite(delay)
    ? delay
    : (_flyoutProviderKey.indexOf('member:') === 0 ? _MEMBER_FLYOUT_DELAY : _FLYOUT_CLOSE_DELAY);
  _flyoutCloseTimer = setTimeout(() => {
    _flyoutCloseTimer = null;
    _closeFlyouts();
  }, wait);
}

function _closeFlyout(kind) {
  const el = document.getElementById(`model-chip-flyout-${kind}`);
  if (el) el.remove();
  if (kind === 'models') _flyoutProviderKey = '';
}

function _closeFlyouts() {
  _cancelFlyoutTimers();
  _closeFlyout('levels');
  _closeFlyout('models');
  _flyoutPinned = false;
  // 推迟的 exec 重画（飞出层使用中到达的 prefetch 数据）：关闭时机到了再画。
  if (_pendingExecRepaint) {
    const repaint = _pendingExecRepaint;
    _pendingExecRepaint = null;
    setTimeout(repaint, 0);
  }
}

function _inFlyout(node) {
  return !!(node && node.closest && node.closest('.model-chip-flyout'));
}

function _ensureFlyout(kind) {
  let el = document.getElementById(`model-chip-flyout-${kind}`);
  if (el) return el;
  el = document.createElement('div');
  el.id = `model-chip-flyout-${kind}`;
  // model-chip-submenu 是既有的右侧子菜单样式钩子（比主菜单宽、层级更高）。
  el.className = `model-chip-flyout model-chip-menu model-chip-submenu model-chip-flyout--${kind}`;
  el.dataset.flyout = kind;
  el.addEventListener('mouseenter', _cancelFlyoutTimers);
  el.addEventListener('mouseleave', _scheduleFlyoutClose);
  document.body.appendChild(el);
  return el;
}

/** 贴着触发行的右侧展开；右边放不下就翻到左侧，纵向夹在视口内。 */
function _positionFlyout(flyout, rowEl) {
  if (!flyout || !rowEl) return;
  flyout.style.position = 'fixed';
  const rect = rowEl.getBoundingClientRect();
  const gap = 6;
  const edge = 8;
  const width = flyout.offsetWidth || 240;
  const height = flyout.offsetHeight || 200;
  let left = rect.right + gap;
  if (left + width > window.innerWidth - edge) {
    const flipped = rect.left - gap - width;
    left = flipped >= edge ? flipped : Math.max(edge, window.innerWidth - width - edge);
  }
  const top = Math.min(Math.max(edge, rect.top - 6), Math.max(edge, window.innerHeight - height - edge));
  flyout.style.left = `${Math.round(left)}px`;
  flyout.style.top = `${Math.round(top)}px`;
}

function _flyoutHeader(flyout, title, sub = '') {
  const header = document.createElement('div');
  header.className = 'model-chip-menu-header';
  header.textContent = title;
  if (sub) {
    const subEl = document.createElement('div');
    subEl.className = 'model-chip-flyout-sub';
    subEl.textContent = sub;
    header.appendChild(subEl);
  }
  flyout.appendChild(header);
}

/** 二级：该 provider 配置的模型清单（悬停 provider 行弹出）。每个模型行
 *  悬停再弹三级思考强度；点击模型 = 选择该模型（与旧的一级行点击同语义）。 */
async function _openProviderFlyout(target, cfg, entry, rowEl, options = {}) {
  if (!entry || !entry.provider) return;
  if (options.pin) { _cancelFlyoutTimers(); _flyoutPinned = true; }
  const flyout = _ensureFlyout('models');
  _closeFlyout('levels');
  _flyoutProviderKey = String(entry.provider);
  flyout.innerHTML = '';
  _flyoutHeader(flyout, entry.providerLabel || entry.provider || '', '');
  const cached = _modelListByProvider.get(String(entry.provider));
  if (!Array.isArray(cached)) {
    const loading = document.createElement('div');
    loading.className = 'model-chip-menu-loading';
    loading.textContent = t('model_chip.loading_models');
    flyout.appendChild(loading);
  }
  _positionFlyout(flyout, rowEl);

  const models = Array.isArray(cached) ? cached : await _loadProviderModels(entry.provider);
  // 异步回来时飞出层可能已经换人/被收起，丢弃过期结果。
  if (!flyout.isConnected || _flyoutProviderKey !== String(entry.provider)) return;
  flyout.innerHTML = '';
  _flyoutHeader(flyout, entry.providerLabel || entry.provider || '', '');

  if (!models.length) {
    const empty = document.createElement('div');
    empty.className = 'model-chip-menu-loading';
    empty.textContent = t('exec_config.provider_no_models');
    flyout.appendChild(empty);
    _positionFlyout(flyout, rowEl);
    return;
  }

  const chevronIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('chevron-right', 'model-chip-menu-arrow-icon')
    : '›';
  models.forEach((m) => {
    const id = String(m && typeof m === 'object' ? (m.id || m.name || '') : m || '');
    if (!id) return;
    const label = String((m && m.name) || id);
    const isCurrent = cfg.provider === entry.provider && cfg.model === id;
    const item = document.createElement('div');
    item.className = 'model-chip-menu-item model-chip-menu-item--provider' + (isCurrent ? ' is-default' : '');
    item.tabIndex = 0;
    item.dataset.model = id;
    item.title = t('model_chip.expand_title');
    const levels = _configuredLevelsFor(entry.provider, id);
    item.innerHTML =
      '<span class="model-chip-menu-main">' +
      `<span class="model-chip-menu-name">${escapeHtml(label)}</span>` +
      (isCurrent
        ? `<span class="model-chip-menu-default">${escapeHtml(cfg.modelOverridden ? t('exec_config.task_override_badge') : t('exec_config.current_badge'))}</span>`
        : '') +
      '</span>' +
      (levels.length
        ? `<span class="model-chip-menu-sub">${escapeHtml(t('exec_config.model_levels_configured', { levels: levels.join(' · ') }))}</span>`
        : '');
    const arrow = document.createElement('span');
    arrow.className = 'model-chip-menu-arrow';
    arrow.innerHTML = chevronIcon;
    item.appendChild(arrow);

    const openLevels = (pin) => _openLevelsFlyout(target, cfg, entry, id, label, item, pin);
    const pick = () => {
      // 与旧一级行同语义：点当前模型 = 取消任务级覆盖、回到跟随默认；
      // 有任务级覆盖时该行带「本次任务」徽标，再点一次即撤销。
      if (isCurrent) {
        if (cfg.modelOverridden) _clearModelOverride(target);
        _closeModelMenu();
        return;
      }
      _applyModelPick(target, cfg, entry.provider, id, label, entry.providerLabel);
      _closeModelMenu();
    };
    item.addEventListener('mouseenter', () => _scheduleFlyoutOpen(() => openLevels(false)));
    item.addEventListener('mouseleave', _scheduleFlyoutClose);
    item.addEventListener('focus', () => openLevels(true));
    item.addEventListener('click', pick);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        openLevels(true);
      }
    });
    flyout.appendChild(item);
  });
  _positionFlyout(flyout, rowEl);
}

/** 三级：该模型可配置的思考强度清单。档位遵循运行时的实际取值域
 *  （自动 / 关闭 / 低 / 高）——模型声明了推理能力才开放低/高，否则置灰并
 *  给出原因，不放假开关。同时标注「模型配置」里声明的档位，让两级口径对得上。 */
function _openLevelsFlyout(target, cfg, entry, modelId, modelLabel, rowEl, pin) {
  if (pin) { _cancelFlyoutTimers(); _flyoutPinned = true; }
  const flyout = _ensureFlyout('levels');
  flyout.innerHTML = '';
  _flyoutHeader(flyout, t('model_effort.menu_title'), modelLabel || modelId);
  const supported = _modelReasoningCapability(entry.provider, modelId);
  const isCurrentModel = cfg.provider === entry.provider && cfg.model === modelId;
  const activeEffort = isCurrentModel ? (cfg.effort || 'auto') : '';
  _EFFORT_OPTIONS.forEach((level) => {
    const unavailable = (level === 'low' || level === 'high') && !supported;
    const item = document.createElement('div');
    item.className = 'model-chip-menu-item'
      + (activeEffort === level ? ' is-default' : '')
      + (unavailable ? ' is-disabled' : '');
    item.tabIndex = unavailable ? -1 : 0;
    item.innerHTML = `<span class="model-chip-menu-main"><span class="model-chip-menu-name">${escapeHtml(t('model_effort.' + level))}</span></span>`
      + (activeEffort === level
        ? `<span class="model-chip-menu-default">${escapeHtml(t('exec_config.current_badge'))}</span>`
        : '');
    if (unavailable) {
      item.title = t('model_effort.unsupported_title');
      return flyout.appendChild(item);
    }
    const pick = () => {
      // 对非当前模型选档位 = 「用这个模型跑这个强度」：先落模型，再落强度。
      if (!isCurrentModel) _applyModelPick(target, cfg, entry.provider, modelId, modelLabel, entry.providerLabel);
      _setTaskEffort(target, level);
      _closeModelMenu();
    };
    item.addEventListener('click', pick);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
    flyout.appendChild(item);
  });
  const levels = _configuredLevelsFor(entry.provider, modelId);
  if (levels.length) {
    const note = document.createElement('div');
    note.className = 'model-chip-menu-note';
    note.textContent = t('exec_config.model_levels_configured', { levels: levels.join(' · ') });
    flyout.appendChild(note);
  }
  if (!supported) {
    const note = document.createElement('div');
    note.className = 'model-chip-menu-note';
    note.textContent = t('model_effort.unsupported_hint');
    flyout.appendChild(note);
  }
  _positionFlyout(flyout, rowEl);
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


/** CLI 模型列表（扫描式）：打开即触发扫描（有缓存用缓存），列表 =
 *  扫描 ∪ 静态目录 ∪ 手输记忆；选择写任务级 model 覆盖（bare id），再点
 *  当前行取消覆盖。底部输入框接受任意模型 id（claude 接受别名与完整 id，
 *  "or a full model ID"），记入 localStorage 供下次直接选。 */
async function _renderCliModelList(menu, anchor, cfg, target, cliType, hooks = {}) {
  const ctl = (typeof window !== 'undefined' && window.cliExecControl) ? window.cliExecControl : null;
  if (!ctl) return;
  const agentId = (cfg.agent && cfg.agent.agent_id) || '';

  const loading = document.createElement('div');
  loading.className = 'model-chip-menu-loading';
  loading.textContent = t('exec_config.cli_models_scanning');
  menu.appendChild(loading);
  if (!hooks.skipPositioning) _positionModelMenu(menu, anchor);

  const scan = await ctl.loadCliModels(agentId, cliType);
  // 菜单可能在扫描期间被关闭（或重开为别的菜单）。
  if (!menu.isConnected) return;
  loading.remove();

  const merged = ctl.mergedCliModels(cliType, scan);

  // 搜索框（CodexHost 对标：长清单客户端过滤；输入事件 stopPropagation
  // 防冒泡到宿主键盘处理，搜索框永不 disabled——禁用聚焦元素会丢焦点）。
  let visibleMerged = merged;
  const needsSearch = merged.length > 8;
  if (needsSearch) {
    const searchWrap = document.createElement('div');
    searchWrap.className = 'model-chip-menu-search';
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'model-chip-menu-input';
    search.placeholder = t('exec_config.cli_models_search_ph');
    search.maxLength = 100;
    search.addEventListener('input', (e) => {
      e.stopPropagation();
      const q = String(search.value || '').trim().toLowerCase();
      visibleMerged = !q
        ? merged
        : merged.filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
      renderModelRows();
    });
    for (const type of ['keydown', 'keyup', 'keypress']) {
      search.addEventListener(type, (e) => e.stopPropagation());
    }
    searchWrap.appendChild(search);
    menu.appendChild(searchWrap);
    setTimeout(() => { try { search.focus(); } catch (_) { /* menu closed */ } }, 0);
  }

  const applyPick = (modelId, isCustom) => {
    // 多 Agent 按来源配置：写回该来源自己的配置，而不是任务级单人覆盖
    // （否则成员之间会互相串用同一个模型）。
    if (typeof hooks.applyPick === 'function') {
      hooks.applyPick(modelId, isCustom);
      return;
    }
    try {
      if (typeof setExecOverride !== 'function') return;
      const ov = getExecOverride(target) || {};
      const { effort, ...rest } = ov;
      if (!modelId) {
        // 「跟随 CLI」= 清除 model 覆盖，保留 effort。
        setExecOverride(target, effort ? { effort } : null);
      } else {
        if (isCustom && ctl) ctl.rememberCustomModel(cliType, modelId);
        setExecOverride(target, { effort, model: modelId, ...(ov.modelLabel && ov.model === modelId ? { modelLabel: ov.modelLabel } : {}) });
      }
      _modelChipRenderAll();
    } catch (err) {
      _modelChipLog.warn('cli model pick failed', { error: (err && err.message) || String(err) });
    }
    _closeModelMenu();
  };

  // 扫描状态说明：失败时一行短注（静态/手输仍可用），不阻塞选择。ready 时
  // 显示 CLI 自报的当前模型（含思考强度副信息，CodexHost resolvedModelLabel
  // 式的"CLI 现在真实状态"展示）。
  if (scan.state !== 'ready') {
    const note = document.createElement('div');
    note.className = 'model-chip-menu-note';
    note.textContent = t('exec_config.cli_models_scan_fallback', { cli: cliType });
    menu.appendChild(note);
  } else if (scan.current) {
    const cur = document.createElement('div');
    cur.className = 'model-chip-menu-note';
    cur.textContent = scan.currentEffort
      ? t('exec_config.cli_models_current_with_effort', { model: scan.current, effort: scan.currentEffort })
      : t('exec_config.cli_models_current', { model: scan.current });
    menu.appendChild(cur);
  }

  // 「跟随 CLI」行：清除任务级模型覆盖，回到 CLI 自身默认——副标签亮出
  // 该默认具体是什么（扫描披露的当前模型）。
  const followRow = document.createElement('div');
  followRow.className = 'model-chip-menu-item' + (!cfg.model ? ' is-default' : '');
  followRow.innerHTML =
    '<span class="model-chip-menu-main">' +
    `<span class="model-chip-menu-name">${escapeHtml(t('exec_config.cli_follow_default'))}</span>` +
    (!cfg.model ? `<span class="model-chip-menu-default">${escapeHtml(t('exec_config.current_badge'))}</span>` : '') +
    '</span>' +
    `<span class="model-chip-menu-sub">${escapeHtml(scan.current || cliType)}</span>`;
  followRow.addEventListener('click', () => applyPick(''));
  menu.appendChild(followRow);

  // 模型行渲染（搜索过滤后增量重画；无匹配显示提示行）。
  const rowsHost = document.createElement('div');
  menu.appendChild(rowsHost);
  const renderModelRows = () => {
    rowsHost.textContent = '';
    if (!visibleMerged.length) {
      const none = document.createElement('div');
      none.className = 'model-chip-menu-loading';
      none.textContent = t('exec_config.cli_models_no_match');
      rowsHost.appendChild(none);
      return;
    }
    visibleMerged.forEach((m) => {
    const isCurrent = cfg.model === m.id;
    const item = document.createElement('div');
    item.className = 'model-chip-menu-item' + (isCurrent ? ' is-default' : '');
    item.innerHTML =
      '<span class="model-chip-menu-main">' +
      `<span class="model-chip-menu-name">${escapeHtml(m.label)}</span>` +
      (isCurrent
        ? `<span class="model-chip-menu-default">${escapeHtml(cfg.modelOverridden ? t('exec_config.task_override_badge') : t('exec_config.current_badge'))}</span>`
        : '') +
      '</span>' +
      // 副标题优先显示客户端同款描述文案（静态目录条目），无描述回落 id。
      `<span class="model-chip-menu-sub">${escapeHtml(m.description || m.id)}</span>`;
    item.addEventListener('click', () => applyPick(m.id, m.source === 'custom'));
    rowsHost.appendChild(item);
    });
  };
  renderModelRows();

  // 手输行：任意模型 id（claude 明确接受 "a full model ID"；codex 同理）。
  const customRow = document.createElement('div');
  customRow.className = 'model-chip-menu-custom';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'model-chip-menu-input';
  input.placeholder = t('exec_config.cli_model_custom_ph');
  input.maxLength = 200;
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'model-chip-menu-custom-btn';
  submit.textContent = t('exec_config.cli_model_custom_add');
  const submitCustom = () => {
    const id = String(input.value || '').trim();
    if (!id) return;
    applyPick(id, true);
  };
  submit.addEventListener('click', (e) => { e.stopPropagation(); submitCustom(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); submitCustom(); }
  });
  customRow.appendChild(input);
  customRow.appendChild(submit);
  menu.appendChild(customRow);

  // 重扫：强制 refresh（网关缓存 + 渲染层缓存都穿透）。
  const rescan = document.createElement('button');
  rescan.type = 'button';
  rescan.className = 'model-chip-menu-rescan';
  rescan.textContent = t('exec_config.cli_models_rescan');
  rescan.addEventListener('click', (e) => {
    e.stopPropagation();
    void ctl.loadCliModels(agentId, cliType, { refresh: true }).then(() => {
      // 换来源（成员模式）时由钩子决定怎么重画——这里直接重画整菜单会把
      // 来源内容宿主当成菜单锚点，画错层。
      if (typeof hooks.onRescan === 'function') { hooks.onRescan(); return; }
      _renderExecConfigMenu(menu, anchor);
      if (!hooks.skipPositioning) _positionModelMenu(menu, anchor);
    });
  });
  menu.appendChild(rescan);
  if (!hooks.skipPositioning) _positionModelMenu(menu, anchor);
}

/** CLI 的推理档位分段（「自动」= 不干预、跟随 CLI 自身默认）。CogSeed
 *  把档位写进信封 execution_prefs：claude 走 MAX_THINKING_TOKENS 环境变
 *  量；hermes/openclaw 等有单次强度参数的走参数模板（网关 effortArgs）。
 *  「关闭」档仅对能表达禁用的 CLI 开放（hermes --reasoning none /
 *  openclaw --thinking off）；claude 无禁用入口、codex 的 minimal 对应
 *  "极简"而非关闭——置灰防语义欺骗。 */
function _renderCliEffortSegmented(menu, anchor, cfg, cliType) {
  const target = _chipTargetForElement(anchor);
  const ctl = (typeof window !== 'undefined' && window.cliExecControl) ? window.cliExecControl : null;
  const offSupported = ctl ? ctl.execControlFor(cliType).effortOff : false;
  const seg = document.createElement('div');
  seg.className = 'model-chip-menu-segmented';
  _EFFORT_OPTIONS.forEach((level) => {
    const isActive = (cfg.effort || 'auto') === level;
    const unavailable = level === 'off' && !offSupported;
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'model-chip-seg-btn'
      + (isActive ? ' is-active' : '')
      + (unavailable ? ' is-disabled' : '');
    pill.textContent = t('model_effort.' + level);
    if (unavailable) {
      pill.disabled = true;
      pill.title = t('exec_config.effort_cli_off_unavailable', { cli: cliType });
    } else {
      pill.addEventListener('click', () => {
        try {
          const ov = getExecOverride(target) || {};
          if (level === 'auto') {
            const { effort, ...rest } = ov;
            setExecOverride(target, Object.keys(rest).length ? rest : null);
          } else {
            setExecOverride(target, { ...ov, effort: level });
          }
          _modelChipRenderAll();
        } catch (err) {
          _modelChipLog.warn('cli effort pick failed', { error: (err && err.message) || String(err) });
        }
        _closeModelMenu();
      });
    }
    seg.appendChild(pill);
  });
  menu.appendChild(seg);
  const note = document.createElement('div');
  note.className = 'model-chip-menu-note';
  note.textContent = t('exec_config.effort_cli_forward_note', { cli: cliType });
  menu.appendChild(note);
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
      // 模型配置（含推理等级/输入类型）在设置页改完会广播新条目：三级飞出层
      // 的档位标注来自同一份配置，必须一起换新，否则层级里还是旧档位。
      if (e && e.detail && Array.isArray(e.detail.entries)) {
        _modelChipEntries = e.detail.entries;
        _modelChipRenderAll();
        void _prefetchReasoningForEntries(true);
      } else {
        refreshModelChipEntries();
      }
    });
    window.addEventListener('i18n-change', () => _modelChipRenderAll());
    // Recipient changes re-resolve the effective config (agent defaults /
    // API model pick) — the chip must follow the target. CLI agents also
    // kick a background model scan so the chip can surface the CLI's REAL
    // current model (e.g. "Sonnet 5") instead of a generic placeholder.
    window.addEventListener('cogseed:recipient-changed', () => {
      _modelChipRenderAll();
      void _scanCliCurrentForChips();
    });
    // Agent defaults (default_model / default_thinking) can change from the
    // agent settings page while a chat is open.
    window.addEventListener('cogseed:agents-cache-refreshed', () => _modelChipRenderAll());
  }
  refreshModelChipEntries();
  refreshModelChipEffort();
  // 恢复会话场景：打开应用就可能停在外接智能体的会话里——预扫一次让
  // chip 直接显示 CLI 当前模型（有缓存时无感命中）。
  void _scanCliCurrentForChips();
}

window.initModelChip = initModelChip;
window.refreshExecConfigChip = _modelChipRenderAll;
window.getModelChipEntries = getModelChipEntries;
// 顶层拖拽区等外部表面需要在视口/视图变化时收起悬浮菜单（boot.js 防御性
// 调用；top-drag-regions 契约测试钉住此导出）。
window.closeModelChipMenu = _closeModelMenu;
