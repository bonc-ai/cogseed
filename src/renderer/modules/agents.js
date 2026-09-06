const _agentsLog = createLogger('agents');
// ─── Agents (three-column: list / detail / inline edit chat) ───

function _agentsTrackClick(action, data) {
  try { if (window.Monitor) (() => {})(action, data || {}); } catch (_) {}
}

function _agentsTrackEvent(action, data) {
  void action;
  void data;
}

function _agentsTrackError(action, data) {
  void action;
  void data;
}

let _agentsCache = null;
// Startup holds a deliberately small identity cache for chat mentions and
// avatars. The Agents tab upgrades it to the complete listing on first entry.
let _agentsCacheIsSummary = false;
let _agentsLoadInFlight = null;
let _selectedAgent = null; // { id, name, source }
let _agentEditing = false;
let _agentFieldSaveTimer = null;
let _agentSkillNameRows = null;
let _agentSkillNameLoadInFlight = null;
const _COMMANDER_AGENT_ID = 'commander';
let _commanderAgentMemoryEntries = [];
let _commanderAgentAvatar = null;
let _commanderAgentProfile = null;
let _commanderAgentRuntimeStats = null;
let _commanderAgentStateInFlight = null;

function _agentUiIconHtml(name, className) {
  if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
    return window.uiIconHtml(name, className);
  }
  return '';
}

// Mirror of `agents.ts::RESERVED_AGENT_NAMES` so the renderer can fail fast
// without a round-trip. Server is still authoritative — this is just UX.
const _RESERVED_AGENT_NAMES = new Set(['指挥官', '总指挥', 'コマンダー', '司令官', 'commander', 'cogseed']);
/** Look up the localized "External · <Brand>" label for an agent runtime
 *  type. The external badge (formerly "CLI · X") is the single
 *  user-facing tag for cli-runtime agents — name surfaces consistently
 *  in cards, detail page, and edit form. */
function _cliBadgeLabel(type) {
  const key = 'agent.external_badge.' + type;
  const v = t(key);
  if (!v || v === key) {
    const externalWord = t('agent.external_word');
    const word = (externalWord && externalWord !== 'agent.external_word') ? externalWord : 'External';
    return word + ' · ' + type;
  }
  return v;
}

function _isReservedAgentName(name) {
  const key = String(name || '').replace(/\s+/g, '').toLowerCase();
  return _RESERVED_AGENT_NAMES.has(key);
}

function _agentSource(source) {
  return (typeof normalizeCatalogSource === 'function')
    ? normalizeCatalogSource(source)
    : String(source || '');
}

function _isAgentProfileMock() {
  return false;
}


// CLI custom-provider bindings are intentionally renderer-only here: the
// provider list is masked by main IPC and the selected `cp:<id>` is stored
// with the CLI runtime. Claude accepts Anthropic providers; Codex accepts
// OpenAI providers. Other CLI runtimes keep their CLI-owned configuration.
function _cliProviderProtocol(cli) {
  if (cli === 'claude') return 'anthropic';
  if (cli === 'codex') return 'openai';
  return '';
}

function filterCliProviders(cli, providers) {
  const protocol = _cliProviderProtocol(cli);
  if (!protocol || !Array.isArray(providers)) return [];
  return providers.filter((provider) => provider && provider.protocol === protocol);
}

function normalizeCliProviderSelection(cli, selectedId, providers) {
  if (!selectedId) return '';
  const match = String(selectedId).match(/^cp:(.+)$/);
  if (!match) return '';
  return filterCliProviders(cli, providers).some((provider) => String(provider.id) === match[1])
    ? selectedId
    : '';
}

function withCliProviderSelection(runtime, selectedId) {
  const next = { ...(runtime || {}) };
  delete next.cli_provider_id;
  if (selectedId) next.cli_provider_id = selectedId;
  return next;
}

let _externalCliProviders = [];
let _externalCliProviderSelect = null;

async function _loadExternalCliProviders() {
  const res = await window.cogseed.invoke('customProviders.list');
  _externalCliProviders = (res && res.ok && Array.isArray(res.providers)) ? res.providers : [];
  return _externalCliProviders;
}

function _renderExternalCliProviderSelect(cli, selectedId = '') {
  const row = document.getElementById('agent-ext-provider-row');
  const mount = document.getElementById('agent-modal-ext-provider-select');
  if (!row || !mount) return;
  const providers = filterCliProviders(cli, _externalCliProviders);
  const compatibleSelected = normalizeCliProviderSelection(cli, selectedId, _externalCliProviders);
  row.hidden = !(cli === 'claude' || cli === 'codex');
  if (row.hidden) {
    _externalCliProviderSelect?.setValue('');
    return;
  }
  const options = [
    { value: '', label: t('agent_modal.ext_provider_none') },
    ...providers.map((provider) => ({
      value: `cp:${provider.id}`,
      label: provider.name || provider.id,
      hint: provider.apiKeyMasked || provider.baseUrl || '',
    })),
  ];
  if (!_externalCliProviderSelect) {
    _externalCliProviderSelect = _aiSelectMount(mount, {
      options, value: compatibleSelected,
      placeholder: t('agent_modal.ext_provider_none'),
    });
  } else {
    _externalCliProviderSelect.setOptions(options, { value: compatibleSelected });
  }
}

function _getExternalCliProviderValue(cli) {
  const selected = _externalCliProviderSelect?.getValue() || '';
  return normalizeCliProviderSelection(cli, selected, _externalCliProviders);
}

window.filterCliProviders = filterCliProviders;
window.normalizeCliProviderSelection = normalizeCliProviderSelection;
window.withCliProviderSelection = withCliProviderSelection;

function _isAgentPlatformSource(source) {
  return (typeof isMarketplaceCatalogSource === 'function')
    ? isMarketplaceCatalogSource(source)
    : _agentSource(source) === 'marketplace';
}

function _isExternalCliAgent(agent) {
  // R1：主进程 _normalizeRuntime 把 legacy 'cli' runtime 一律读回
  // 'p3394-gateway'，渲染层读到的 kind 永不含 'cli' —— 统一判定只认
  // 'p3394-gateway'（这是全部渲染层外接判定的共享入口）。
  return !!(agent && agent.runtime && agent.runtime.kind === 'p3394-gateway');
}

function _agentCardMetaHtml(a, lang) {
  if (_isCommanderAgent(a)) {
    return '';
  }
  const parts = [];
  if (a.version) {
    const versionLabel = t('marketplace.version').replace('{version}', String(a.version));
    parts.push(`<span class="agent-card-chip is-version">${escapeHtml(versionLabel)}</span>`);
  }
  const catLabel = _resolveCategoryLabel(a.category, lang);
  if (catLabel) parts.push(`<span class="agent-card-chip">${escapeHtml(catLabel)}</span>`);
  return parts.join('');
}

function _agentPlatformStatusChipsHtml(a) {
  return '';
}

function _agentLabel(key, zh, en, ja) {
  const raw = t(key);
  if (raw && raw !== key) return raw;
  const lang = getLang();
  if (lang === 'zh') return zh;
  if (lang === 'ja') return ja || en;
  return en;
}

function _isCommanderAgent(agentOrId) {
  if (!agentOrId) return false;
  if (typeof agentOrId === 'string') return agentOrId === _COMMANDER_AGENT_ID || agentOrId === '__commander__';
  return String(agentOrId.agent_id || agentOrId.id || '') === _COMMANDER_AGENT_ID
    || _agentSource(agentOrId.source) === _COMMANDER_AGENT_ID;
}

function _commanderLocalizedText(value, fallback = '', opts = {}) {
  const clean = (text) => {
    if (opts.preserveNewlines) {
      return String(text || '')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\{2,}/g, '\\')
        .replace(/\r\n?/g, '\n')
        .trim();
    }
    return normalizeDisplayText(text);
  };
  if (typeof value === 'string') return clean(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const lang = getLang();
  const direct = clean(value[lang]);
  if (direct) return direct;
  return clean(value.zh) || clean(value.en) || clean(value.ja) || fallback;
}

function _commanderLocalizedList(value) {
  if (Array.isArray(value)) return value.map(normalizeDisplayText).filter(Boolean);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const lang = getLang();
  const direct = Array.isArray(value[lang]) ? value[lang] : null;
  const fallback = direct || (Array.isArray(value.zh) ? value.zh : null) || (Array.isArray(value.en) ? value.en : null) || (Array.isArray(value.ja) ? value.ja : []);
  return fallback.map(normalizeDisplayText).filter(Boolean);
}

function _commanderAvatarFallback() {
  const fallback = (typeof COMMANDER_DEFAULT !== 'undefined' && COMMANDER_DEFAULT)
    ? COMMANDER_DEFAULT
    : { icon: 'crown', color: 'gold' };
  return {
    icon: fallback.icon || 'crown',
    color: _commanderAgentAvatar?.color || fallback.color || 'gold',
  };
}

async function _refreshCommanderAgentState() {
  if (_commanderAgentStateInFlight) return _commanderAgentStateInFlight;
  _commanderAgentStateInFlight = (async () => {
    if (typeof window === 'undefined' || !window.cogseed?.invoke) return;
    const [memoryRes, avatarRes, profileRes, statsRes] = await Promise.allSettled([
      window.cogseed.invoke('memory.list', { target: 'agent', agentId: _COMMANDER_AGENT_ID }),
      window.cogseed.invoke('prefs.getCommanderAvatar'),
      window.cogseed.invoke('commander.getProfile'),
      window.cogseed.invoke('commander.runtimeStats.get'),
    ]);
    if (memoryRes.status === 'fulfilled') {
      _commanderAgentMemoryEntries = Array.isArray(memoryRes.value?.entries)
        ? memoryRes.value.entries.map(normalizeDisplayText).filter(Boolean)
        : [];
    }
    if (avatarRes.status === 'fulfilled' && avatarRes.value?.avatar) {
      const avatar = avatarRes.value.avatar;
      if (avatar.icon && avatar.color) _commanderAgentAvatar = { icon: avatar.icon, color: avatar.color };
    }
    if (profileRes.status === 'fulfilled' && profileRes.value?.profile) {
      _commanderAgentProfile = profileRes.value.profile;
    }
    if (statsRes.status === 'fulfilled') {
      _commanderAgentRuntimeStats = statsRes.value?.runtime_stats || null;
    }
  })().catch((err) => {
    _agentsLog.warn('load commander agent state failed', err);
  }).finally(() => {
    _commanderAgentStateInFlight = null;
  });
  return _commanderAgentStateInFlight;
}

function _buildCommanderAgent() {
  const avatar = _commanderAvatarFallback();
  const profile = _commanderAgentProfile || {};
  const name = _commanderLocalizedText(profile.name, t('chat.recipient_commander'));
  const description = _commanderLocalizedText(profile.description, '');
  const workflow = _commanderLocalizedText(profile.workflow, '', { preserveNewlines: true });
  const knowhow = _commanderLocalizedList(profile.knowhow);
  const standards = _commanderLocalizedList(profile.standards);
  return {
    agent_id: _COMMANDER_AGENT_ID,
    id: _COMMANDER_AGENT_ID,
    name,
    source: _COMMANDER_AGENT_ID,
    category: 'general',
    enabled: true,
    icon: avatar.icon,
    color: avatar.color,
    description,
    workflow,
    knowhow,
    standards,
    profile: {
      knowhow,
      standards,
      memory: _commanderAgentMemoryEntries.map((title) => ({ title })),
    },
    skill_list: [],
    runtime_stats: _commanderAgentRuntimeStats || {},
  };
}

function _withCommanderAgent(agents) {
  const list = Array.isArray(agents) ? agents : [];
  return [_buildCommanderAgent(), ...list.filter((a) => !_isCommanderAgent(a))];
}

function _agentProfile(agent) {
  const p = agent && agent.profile;
  const profile = p && typeof p === 'object' && !Array.isArray(p) ? { ...p } : {};
  if (agent && Array.isArray(agent.knowhow) && !Array.isArray(profile.knowhow)) {
    profile.knowhow = agent.knowhow;
  }
  if (agent && Array.isArray(agent.standards) && !Array.isArray(profile.standards)) {
    profile.standards = agent.standards;
  }
  return profile;
}

function _agentProfileEntries(value) {
  if (!Array.isArray(value)) return [];
  const entries = [];
  for (const item of value) {
    if (typeof item === 'string' || typeof item === 'number') {
      const title = normalizeDisplayText(item);
      if (title) entries.push({ title, description: '', tool: '', source: '', updated_at: '' });
      continue;
    }
    if (!item || typeof item !== 'object' || item.kept === false) continue;
    const entry = {
      title: normalizeDisplayText(item.title || item.name || item.t || ''),
      description: normalizeDisplayText(item.description || item.d || ''),
      tool: normalizeDisplayText(item.tool || item.skill || ''),
      source: normalizeDisplayText(item.source || item.from || ''),
      updated_at: normalizeDisplayText(item.updated_at || item.when || ''),
    };
    if (entry.title || entry.description) entries.push(entry);
  }
  return entries;
}

function _agentSummary(agent, lang) {
  if (_isCommanderAgent(agent)) return normalizeDisplayText(agent && agent.description);
  // P3394 external Agents use the product preset description as the live
  // contract. This also repairs older persisted records that were created
  // before the external preset descriptions were corrected (for example,
  // Hermes records that still say ACP despite runtime.kind=p3394-gateway).
  const runtime = agent && agent.runtime;
  if (runtime && runtime.kind === 'p3394-gateway' && runtime.cli && typeof getCliDefaults === 'function') {
    const defaults = getCliDefaults(runtime.cli);
    if (defaults) return (pickDesc(defaults, lang) || '').trim();
  }
  return (pickDesc(agent, lang) || '').trim();
}

function _agentWorkflowSteps(agent) {
  return [];
}

function _agentMemoryEntries(agent) {
  return _agentProfileEntries(_agentProfile(agent).memory);
}

function _agentKnownSkillRows() {
  const rows = [];
  if (Array.isArray(_agentSkillNameRows)) rows.push(..._agentSkillNameRows);
  if (typeof _skillsCache !== 'undefined' && Array.isArray(_skillsCache)) rows.push(..._skillsCache);
  if (typeof _openSkillsCache !== 'undefined' && Array.isArray(_openSkillsCache)) rows.push(..._openSkillsCache);
  return rows;
}

function _agentSkillNameForId(skillId) {
  const id = normalizeDisplayText(skillId);
  if (!id) return '';
  const row = _agentKnownSkillRows().find((s) => {
    if (!s || typeof s !== 'object') return false;
    return String(s.id || '') === id || String(s.skill_id || '') === id;
  });
  const name = normalizeDisplayText(row && (row.name || row.display_name || row.title));
  return name || id;
}

function _agentSkillIds(agent) {
  return Array.isArray(agent && agent.skill_list)
    ? agent.skill_list.map(normalizeDisplayText).filter(Boolean)
    : [];
}

function _maybeLoadAgentSkillNames(ids, agentId, opts = {}) {
  if (!ids.length || _agentSkillNameRows) return Promise.resolve();
  if (_agentSkillNameLoadInFlight) return _agentSkillNameLoadInFlight;
  const hasUnresolved = ids.some((id) => _agentSkillNameForId(id) === id);
  if (!hasUnresolved || typeof window === 'undefined' || !window.cogseed?.invoke) return Promise.resolve();
  _agentSkillNameLoadInFlight = (async () => {
    try {
      const [trustedRes, openRes] = await Promise.allSettled([
        window.cogseed.invoke('skills.list'),
        window.cogseed.invoke('skills.listOpen'),
      ]);
      const trusted = trustedRes.status === 'fulfilled' && Array.isArray(trustedRes.value?.skills)
        ? trustedRes.value.skills
        : [];
      const open = openRes.status === 'fulfilled' && openRes.value?.ok && Array.isArray(openRes.value.skills)
        ? openRes.value.skills
        : [];
      _agentSkillNameRows = [...trusted, ...open];
    } catch (err) {
      _agentsLog.warn('load skill names for agent detail failed', err);
      _agentSkillNameRows = [];
    } finally {
      _agentSkillNameLoadInFlight = null;
    }
    const shouldRefresh = opts.refresh !== false;
    if (shouldRefresh && !_agentEditing && _selectedAgent?.id === agentId) {
      selectAgent(agentId).catch(() => { /* best-effort refresh */ });
    }
  })();
  return _agentSkillNameLoadInFlight;
}

function _agentSkillRefs(agent) {
  const ids = _agentSkillIds(agent);
  _maybeLoadAgentSkillNames(ids, agent && agent.agent_id);
  return ids
    .map((id) => ({ id, title: _agentSkillNameForId(id) }))
    .filter((skill) => skill.title);
}

function _agentRuntimeStats(agent) {
  const raw = agent && typeof agent === 'object' ? agent.runtime_stats : null;
  const attempts = Math.max(0, Number(raw && raw.attempts) || 0);
  const deliveries = Math.max(0, Number(raw && raw.deliveries) || 0);
  const successes = raw && raw.successes !== undefined
    ? Math.max(0, Number(raw.successes) || 0)
    : deliveries;
  const totalDurationMs = Math.max(0, Number(raw && raw.total_duration_ms) || 0);
  const successfulDurationMs = Math.max(0, Number(raw && raw.successful_duration_ms) || 0);
  return {
    attempts,
    successes,
    deliveries,
    failures: Math.max(0, Number(raw && raw.failures) || 0),
    errors: Math.max(0, Number(raw && raw.errors) || 0),
    totalDurationMs,
    successfulDurationMs,
    updatedAt: normalizeDisplayText(raw && raw.updated_at),
  };
}

async function _refreshAgentRuntimeStatsAfterRun(agentId) {
  const id = String(agentId || '');
  if (!id || _isCommanderAgent(id) || _isAgentProfileMock(id) || !window.cogseed?.invoke) return;
  try {
    await loadAgents(true);
    if (_selectedAgent?.id === id && !_agentEditing) await selectAgent(id);
  } catch (err) {
    _agentsLog.warn('refresh agent runtime stats failed', err);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('cogseed-agent-run-finished', (event) => {
    const detail = event && event.detail ? event.detail : {};
    _refreshAgentRuntimeStatsAfterRun(detail.agent_id).catch(() => {});
  });
}

function _agentDeliveryCount(agent) {
  return _agentRuntimeStats(agent).deliveries;
}

function _agentDeliveryChip(count) {
  const n = Math.max(0, Number(count) || 0);
  if (n <= 0) return '';
  const label = _agentLabel('agents.card_delivery_count', '{n} 交付', '{n} delivered', '{n} 納品');
  return `<span class="agent-card-chip">${escapeHtml(label.replace('{n}', String(n)))}</span>`;
}

function _agentRoundedSeconds(ms, count) {
  const avg = count > 0 ? Math.round(ms / count / 1000) : 0;
  return ms > 0 && avg === 0 ? 1 : avg;
}

function _agentDetailStats(agent) {
  const runtime = _agentRuntimeStats(agent);
  const assessed = runtime.successes + runtime.failures;
  const successRate = assessed > 0 ? Math.round((runtime.successes / assessed) * 100) : 0;
  const avgSource = runtime.deliveries > 0 ? runtime.successfulDurationMs : runtime.totalDurationMs;
  const avgCount = runtime.deliveries > 0 ? runtime.deliveries : runtime.attempts;
  const stats = [
    {
      key: _agentLabel('agents.stat_delivery_label', '交付', 'Delivered', '納品'),
      value: String(runtime.deliveries),
      unit: _agentLabel('agents.stat_delivery_unit', '次', 'times', '回'),
      kind: 'delivery',
    },
    {
      key: _agentLabel('agents.stat_success_label', '成功率', 'Success rate', '成功率'),
      value: String(successRate),
      unit: '%',
      kind: 'success',
    },
    {
      key: _agentLabel('agents.stat_avg_time_label', '耗时', 'Time', '時間'),
      value: String(_agentRoundedSeconds(avgSource, avgCount)),
      unit: _agentLabel('agents.stat_avg_time_unit', '秒', 's', '秒'),
      kind: 'duration',
    },
  ];
  if (!_isExternalCliAgent(agent)) {
    const memory = _agentMemoryEntries(agent);
    stats.push({
      key: _agentLabel('agents.stat_memory_label', '记忆', 'Memory', '記憶'),
      value: String(memory.length),
      unit: _agentLabel('agents.stat_memory_unit', '项', 'items', '件'),
      kind: 'memory',
    });
  }
  return stats;
}

function _agentExplicitCountChip(label, count) {
  return count > 0
    ? `<span class="agent-card-chip">${escapeHtml(label.replace('{n}', String(count)))}</span>`
    : '';
}

function _generalCategoryLabel(lang) {
  const code = 'general';
  const list = (typeof _mpCategoriesCache !== 'undefined' && _mpCategoriesCache) || [];
  const c = list.find((x) => {
    const xCode = typeof _mpCanonicalCategoryCode === 'function' ? _mpCanonicalCategoryCode(x && x.code) : String(x && x.code || '').trim();
    return xCode === code;
  });
  const label = c ? pickLocalizedName(c, lang) : '';
  if (label) return label;
  if (lang === 'zh') return '通用';
  if (lang === 'ja') return '汎用';
  return 'General';
}

function _knownCategoryCodes(cats) {
  const canonicalCategoryCode = (code) => {
    return typeof _mpCanonicalCategoryCode === 'function'
      ? _mpCanonicalCategoryCode(code)
      : String(code || '').trim();
  };
  return new Set(
    (cats || []).map((c) => canonicalCategoryCode(c && c.code)).filter(Boolean),
  );
}

function _effectiveCategoryCode(code, knownCodes) {
  const canonical = typeof _mpCanonicalCategoryCode === 'function'
    ? _mpCanonicalCategoryCode(code)
    : String(code || '').trim();
  return canonical && knownCodes.has(canonical) ? canonical : 'general';
}

/** Shared category-code → localized label. Missing or non-registry codes display as General
 *  while marketplace.js schedules a throttled registry refresh for possible server drift. */
function _resolveCategoryLabel(code, lang) {
  if (!code) return _generalCategoryLabel(lang);
  if (typeof _mpMaybeRefreshCategoriesForCodes === 'function') {
    _mpMaybeRefreshCategoriesForCodes([code]);
  }
  const canonical = typeof _mpCanonicalCategoryCode === 'function' ? _mpCanonicalCategoryCode(code) : String(code || '').trim();
  const list = (typeof _mpCategoriesCache !== 'undefined' && _mpCategoriesCache) || [];
  const c = list.find((x) => {
    const xCode = typeof _mpCanonicalCategoryCode === 'function' ? _mpCanonicalCategoryCode(x && x.code) : String(x && x.code || '').trim();
    return xCode === canonical;
  });
  if (!c) return _generalCategoryLabel(lang);
  return pickLocalizedName(c, lang) || code;
}

// Mirror of `agents.ts::NAME_TOKEN_RE` so the form rejects junk before
// the round-trip. Charset must round-trip through the bus's @-mention
// regex; see backend for the full reasoning. UIs may still surface
// server errors (E_AGENT_NAME_INVALID / E_AGENT_NAME_TOO_LONG) when
// the LLM-driven path produces a bad name.
const _NAME_TOKEN_RE = /^[A-Za-z0-9_一-鿿-]+$/;
function _isValidAgentNameCharset(name) {
  const v = String(name || '');
  const trimmed = v.trim();
  if (!trimmed) return true;
  if (v !== trimmed) return false;
  if (typeof window.nameDisplayWidth === 'function' && window.nameDisplayWidth(trimmed) > window.NAME_DISPLAY_MAX_UNITS) return false;
  return _NAME_TOKEN_RE.test(trimmed);
}

async function loadAgents(forceRefresh, opts = {}) {
  const summary = opts.summary === true;
  if (_agentsLoadInFlight) {
    await _agentsLoadInFlight.catch(() => {});
  }
  if (_agentsCache && !forceRefresh && (summary || !_agentsCacheIsSummary)) {
    if (!summary) {
      await _refreshCommanderAgentState();
      renderAgentsList(_agentsCache);
    }
    return;
  }
  _agentsLoadInFlight = (async () => {
    try {
      const query = new URLSearchParams();
      if (forceRefresh) query.set('force', '1');
      if (summary) query.set('summary', '1');
      const res = await apiFetch(`/api/agents/list${query.size ? `?${query}` : ''}`);
      const data = await res.json();
      if (data.ok) {
        // Sort once on cache fill so picker + grid share the order. Electron
        // provides Chinese pinyin collation through its built-in ICU runtime;
        // this avoids bundling a third-party transliteration table.
        const sortedAgents = (data.agents || []).map((a) => ({
          ...a,
          source: _agentSource(a.source),
        })).sort((a, b) => {
          if (a.source !== b.source) return a.source === 'custom' ? -1 : 1;
          const byName = compareDisplayNames(a.name || a.agent_id || '', b.name || b.agent_id || '');
          if (byName) return byName;
          return String(a.agent_id || '').localeCompare(String(b.agent_id || ''), undefined, { numeric: true, sensitivity: 'base' });
        });
        _agentsCache = sortedAgents;
        _agentsCacheIsSummary = summary;
        // Unified execution entry: agent defaults (default_model /
        // default_thinking) feed the composer's exec-config chip — notify
        // it whenever the cache is refreshed (includes agent-edit writes).
        try { window.dispatchEvent(new CustomEvent('cogseed:agents-cache-refreshed')); } catch (_) {}
        // Sidebar conv-row badges read agent icon+color from `_agentsCache`
        // (via `_renderConvAgentStackHtml`). Boot order is loadConversations
        // → loadAgents, so the first sidebar render lands before the cache
        // is populated and the badges fall back to seed-derived avatars —
        // re-render once the cache exists so they pick up the authored
        // icon. Conversation list subscribes to the same render call.
        if (typeof renderConversationList === 'function') renderConversationList();
        if (summary) return;
        await _refreshCommanderAgentState();
        renderAgentsList(_agentsCache);
        // Backfill avatars to disk when older specs lack them — derive
        // from the seed for cross-device consistency (the same agent_id
        // produces the same icon/color combination on every machine, so
        // cloud sync won't see two ends writing different values and
        // colliding). Entries that already have icon + color are
        // skipped, so repeated loadAgents calls don't re-write.
        // Asynchronous so it doesn't block rendering — the render layer
        // also seeds an avatar fallback whose value matches what we
        // backfill, so the user sees no visual change.
        _backfillMissingAvatars(_agentsCache).catch((e) => {
          _agentsLog.warn('avatar backfill failed', e);
        });
      }
    } catch (e) {
      _agentsLog.error('load agents failed', e);
    } finally {
      _agentsLoadInFlight = null;
    }
  })();
  return _agentsLoadInFlight;
}

async function _backfillMissingAvatars(agents) {
  const missing = (agents || []).filter(
    (a) => a.source === 'custom' && (!a.icon || !a.color),
  );
  if (!missing.length) return;
  for (const a of missing) {
    const seedAvatar = avatarFromSeed(a.agent_id);
    const updates = {};
    if (!a.icon) updates.icon = seedAvatar.icon;
    if (!a.color) updates.color = seedAvatar.color;
    try {
      const res = await window.cogseed.invoke('agents.update', {
        agent_id: a.agent_id, updates,
      });
      if (res?.ok && res.agent) {
        a.icon = res.agent.icon;
        a.color = res.agent.color;
      }
    } catch (e) {
      // Failure here doesn't matter — the render layer's seed-based
      // fallback still produces the same combination, and the next
      // loadAgents call will retry.
      _agentsLog.warn(`backfill ${a.agent_id} failed`, e);
    }
  }
  _agentsLog.info(`avatar backfill: ${missing.length} agent(s)`);
}

function renderAgentsList(agents) { renderAgentsGrid(_withCommanderAgent(agents)); }

// Active category-chip selection for the Agents page. Empty string = "All";
// matches `_mpState.category` semantics in marketplace.js. Persists across
// re-renders within a session; defaults to All on each load.
let _agentsActiveCategory = '';

function renderAgentsGrid(agents) {
  const emptyEl = document.getElementById('agents-empty');
  const chipsHost = document.getElementById('agents-categories');
  const gridEl = document.getElementById('agents-grid');
  if (!gridEl) return;

  if (!agents.length) {
    if (chipsHost) chipsHost.innerHTML = '';
    gridEl.classList.remove('is-sectioned');
    gridEl.innerHTML = '';
    if (emptyEl) {
      if (typeof _mpUpdateInstallingEmptyStates === 'function') _mpUpdateInstallingEmptyStates();
      else emptyEl.textContent = t('agents.empty');
      emptyEl.style.display = '';
    }
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  const useTitle = escapeHtml(t('agents.use_tooltip'));
  const useLabel = escapeHtml(t('agents.use'));
  const moreTitle = escapeHtml(t('agents.more_actions'));
  const lang = getLang();
  const customChipLabel = t('agents.custom_group');
  const baseGroupLabel = (() => {
    const raw = t('agents.base_group');
    return (raw && raw !== 'agents.base_group') ? raw : t('agents.external_group');
  })();
  const marketplaceGroupLabel = (() => {
    const raw = t('agents.builtin_group');
    return (raw && raw !== 'agents.builtin_group') ? raw : t('agents.source_marketplace');
  })();
  const allLabel = (() => {
    const raw = t('marketplace.all');
    return (raw && raw !== 'marketplace.all') ? raw : 'All';
  })();

  // Build the chip strip from the marketplace category cache. Missing categories
  // and non-registry category codes are treated as General.
  // If the active selection no longer matches any agent (rare — agent moved
  // between categories mid-session), fall back to All so the body isn't empty.
  const canonicalCategoryCode = (code) => {
    return typeof _mpCanonicalCategoryCode === 'function'
      ? _mpCanonicalCategoryCode(code)
      : String(code || '').trim();
  };
  const cats = (typeof _mpCategoriesCache !== 'undefined' && _mpCategoriesCache) || [];
  const knownCodes = _knownCategoryCodes(cats);
  const rawCodesPresent = new Set(agents.map((a) => canonicalCategoryCode(a && a.category)));
  const unknownCodes = [...rawCodesPresent].filter((c) => c && !knownCodes.has(c)).sort();
  if (unknownCodes.length && typeof _mpMaybeRefreshCategoriesForCodes === 'function') {
    _mpMaybeRefreshCategoriesForCodes(unknownCodes);
  }
  const codesPresent = new Set([...rawCodesPresent].map((c) => _effectiveCategoryCode(c, knownCodes)));
  const chipCodes = [];
  const chipCodeSeen = new Set();
  for (const c of cats) {
    const code = canonicalCategoryCode(c && c.code);
    if (!code || !codesPresent.has(code) || chipCodeSeen.has(code)) continue;
    chipCodes.push({ code, label: pickLocalizedName(c, lang) || code });
    chipCodeSeen.add(code);
  }
  if (codesPresent.has('general') && !chipCodeSeen.has('general')) {
    chipCodes.push({ code: 'general', label: _generalCategoryLabel(lang) });
    chipCodeSeen.add('general');
  }
  if (_agentsActiveCategory === '__uncategorized__' || _agentsActiveCategory === '__unknown__') {
    _agentsActiveCategory = codesPresent.has('general') ? 'general' : '';
  }
  if (_agentsActiveCategory && !chipCodes.some((c) => c.code === _agentsActiveCategory)) {
    _agentsActiveCategory = '';
  }

  if (chipsHost) {
    const allActive = _agentsActiveCategory === '' ? ' is-active' : '';
    const chipsHtml = [
      `<button type="button" class="marketplace-chip${allActive}" data-agents-cat="">${escapeHtml(allLabel)}</button>`,
      ...chipCodes.map((c) => {
        const active = _agentsActiveCategory === c.code ? ' is-active' : '';
        return `<button type="button" class="marketplace-chip${active}" data-agents-cat="${escapeHtml(c.code)}">${escapeHtml(c.label)}</button>`;
      }),
    ].join('');
    chipsHost.innerHTML = chipsHtml;
    chipsHost.querySelectorAll('[data-agents-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        _agentsActiveCategory = btn.dataset.agentsCat || '';
        // Only the user re-renders here — backend cache (`_agentsCache`) is
        // unchanged, so we pass it back through the same code path.
        if (_agentsCache) renderAgentsList(_agentsCache);
      });
    });
  }

  const filtered = agents.filter((a) => {
    if (_agentsActiveCategory === '') return true;
    return _effectiveCategoryCode(a && a.category, knownCodes) === _agentsActiveCategory;
  });

  const cardHtml = (a) => {
    const enabled = a.enabled !== false;
    const isMock = _isAgentProfileMock(a);
    const isCommander = _isCommanderAgent(a);
    const desc = _agentSummary(a, lang);
    const metaHtml = _agentCardMetaHtml(a, lang);
    const memoryEntries = _isExternalCliAgent(a) ? [] : _agentMemoryEntries(a);
    const memoryCount = memoryEntries.length;
    const skillCount = Array.isArray(a.skill_list) ? a.skill_list.length : 0;
    const deliveryCount = _agentDeliveryCount(a);
    const descClass = desc ? 'agent-card-desc' : 'agent-card-desc is-empty';
    const descText = desc || t('agents.placeholder_unset');
    const agentName = a.name || t('agents.unnamed');
    const openLabel = `${t('agents.manage_tooltip')}: ${agentName}`;
    const moreBtn = (isMock || isCommander) ? '' : `<button type="button" class="agent-card-more" data-agent-more title="${moreTitle}" aria-label="${moreTitle}">⋯</button>`;
    const avatarHtml = renderAvatarHtml(a.icon, a.color, {
      size: 32,
      seed: a.agent_id,
      extraClass: 'agent-card-avatar',
      // 外接 CLI agent：头像内容换成该 agent 名称前两个字母（如 Claude → "Cl"）
      letter: _isExternalCliAgent(a) ? (a.name || '') : '',
    });
    // CLI brand chip on the bottom row, shared with the play button.
    const cliChip = _isExternalCliAgent(a)
      ? `<span class="agent-card-chip is-cli is-cli-${escapeHtml(a.runtime.cli)}">${escapeHtml(_cliBadgeLabel(a.runtime.cli))}</span>`
      : '';
    // Source provenance chips on the bottom row. Version/category now live
    // in the subtitle line under the card title, so marketplace only keeps
    // review status here when that UI is enabled.
    const provenanceChips = _isAgentPlatformSource(a.source) ? _agentPlatformStatusChipsHtml(a) : '';
    return `
      <div class="agent-card${enabled ? '' : ' is-disabled'}" data-id="${escapeHtml(a.agent_id)}" data-source="${escapeHtml(a.source || '')}">
        <button type="button" class="agent-card-open" data-agent-open aria-label="${escapeHtml(openLabel)}"></button>
        <div class="agent-card-header">
          ${avatarHtml}
          <div class="agent-card-title">
            <span class="agent-card-name">${escapeHtml(agentName)}</span>
            ${metaHtml ? `<span class="agent-card-meta">${metaHtml}</span>` : ''}
          </div>
          ${moreBtn}
        </div>
        <div class="${descClass}">${escapeHtml(descText)}</div>
        <div class="agent-card-actions">
          ${cliChip}${provenanceChips}
          ${_agentDeliveryChip(deliveryCount)}
          ${_agentExplicitCountChip(_agentLabel('agents.card_memory_count', '{n} 记忆', '{n} memory', '{n} 記憶'), memoryCount)}
          ${_agentExplicitCountChip(_agentLabel('agents.card_skill_count', '{n} 技能', '{n} skills', '{n} スキル'), skillCount)}
          <button type="button" class="agent-card-use" data-agent-use title="${useTitle}" aria-label="${useTitle}" ${enabled && !isMock ? '' : 'disabled aria-disabled="true" tabindex="-1"'}>
            ${useLabel}
          </button>
        </div>
      </div>
    `;
  };

  const groups = { commander: [], base: [], custom: [], marketplace: [] };
  for (const a of filtered) {
    const source = _agentSource(a?.source);
    if (_isCommanderAgent(a)) groups.commander.push(a);
    else if (source === 'marketplace') groups.marketplace.push(a);
    // 外接 CLI agent（ClaudeCode / Codex / WorkBuddy…）是「基础 Agent」：
    // 与指挥官同层（谁来承接空间任务），与自定义团队成员分开。
    else if (_isExternalCliAgent(a)) groups.base.push(a);
    else groups.custom.push(a);
  }
  const sectionHtml = (label, list, opts = {}) => {
    if (!list.length) return '';
    const headHtml = opts.hideHead ? '' : `
        <div class="agents-source-section-head">
          <span>${escapeHtml(label)}</span>
          <span class="agents-source-section-count">${list.length}</span>
        </div>`;
    return `
      <section class="agents-source-section">
        ${headHtml}
        <div class="agents-source-section-grid">
          ${list.map(cardHtml).join('')}
        </div>
      </section>
    `;
  };
  gridEl.classList.add('is-sectioned');
  gridEl.innerHTML = sectionHtml('', groups.commander, { hideHead: true })
    + sectionHtml(baseGroupLabel, groups.base)
    + sectionHtml(customChipLabel, groups.custom)
    + sectionHtml(marketplaceGroupLabel, groups.marketplace);

  for (const card of gridEl.querySelectorAll('.agent-card')) {
    const id = card.dataset.id;
    const source = card.dataset.source;
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-agent-use]')) {
        e.stopPropagation();
        if (!card.classList.contains('is-disabled')) useAgent(id, 'agent_card');
        return;
      }
      if (e.target.closest('[data-agent-more]')) {
        e.stopPropagation();
        _toggleAgentRowMenu(e.target.closest('[data-agent-more]'), id, source);
        return;
      }
      _showAgentsDetailView(id);
    });
  }
}

/** Flip an agent's enabled override (used by both the ⋯ menu's toggle item
 *  and the detail-page enable/disable button). On failure, alerts; on
 *  success, refreshes the grid + detail page. */
async function _flipAgentEnabled(agentId, nextEnabled) {
  if (_isCommanderAgent(agentId)) return false;
  try {
    const res = await window.cogseed.invoke('agents.setEnabled', { agent_id: agentId, enabled: nextEnabled });
    if (!res || !res.ok) {
      await uiAlert(t('component.toggle_failed'));
      return false;
    }
    const cached = _agentsCache?.find((a) => a.agent_id === agentId);
    if (cached) cached.enabled = nextEnabled;
    await loadAgents(true);
    if (_selectedAgent?.id === agentId) {
      _renderAgentEnabledButton({ id: agentId, enabled: nextEnabled });
    }
    return true;
  } catch (err) {
    await uiAlert(t('component.toggle_failed'));
    return false;
  }
}

// ─── View switching: grid ↔ detail ─────────────────────────────────────

function _showAgentsGridView() {
  if (typeof closeExpenseWorkbench === 'function') closeExpenseWorkbench();
  const grid = document.getElementById('agents-grid-view');
  const detail = document.getElementById('agents-detail-view');
  if (_agentEditing) {
    // Defer to async cleanup so any pending field save flushes.
    _exitAgentEditMode().catch(() => {});
  }
  if (grid) grid.style.display = 'flex';
  if (detail) detail.style.display = 'none';
  _selectedAgent = null;
  _closeAgentRowMenu();
  const detailContent = document.getElementById('agents-detail-content');
  if (detailContent) detailContent.style.display = 'none';
}

async function _showAgentsDetailView(agentId) {
  const grid = document.getElementById('agents-grid-view');
  const detail = document.getElementById('agents-detail-view');
  if (grid) grid.style.display = 'none';
  if (detail) detail.style.display = 'flex';
  // Detail has a target-scoped API below. Do not refresh/enrich the complete
  // Agent catalog merely to open one agent.json.
  await selectAgent(agentId);
}

async function refreshSelectedAgentDetail() {
  if (_agentEditing || !_selectedAgent?.id) return;
  const detail = document.getElementById('agents-detail-view');
  if (!detail || detail.style.display === 'none') return;
  await selectAgent(_selectedAgent.id);
}

// ─── Per-row "⋯" menu (edit / delete) ─────────────────────────────────────

function _positionRowMenu(menuEl, anchorEl) {
  menuEl.style.display = 'block';
  menuEl.style.left = '-9999px';
  menuEl.style.top = '-9999px';
  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menuEl.getBoundingClientRect();
  const margin = 8;
  const gap = 4;
  // Right-align to the anchor by default; clamp to viewport.
  let left = rect.right - menuRect.width;
  if (left < margin) left = margin;
  if (left + menuRect.width > window.innerWidth - margin) {
    left = window.innerWidth - menuRect.width - margin;
  }
  // Below if there's room, otherwise above.
  const below = rect.bottom + gap + menuRect.height <= window.innerHeight - margin;
  const top = below ? rect.bottom + gap : Math.max(margin, rect.top - menuRect.height - gap);
  menuEl.style.left = left + 'px';
  menuEl.style.top = top + 'px';
}

function _closeAgentRowMenu() {
  const menu = document.getElementById('agent-row-menu');
  if (menu) {
    menu.style.display = 'none';
    delete menu.dataset.agentId;
    delete menu.dataset.anchorTs;
  }
  // Drop the "keep ⋯ visible" sticky class from whichever row had the open menu.
  for (const el of document.querySelectorAll('.agent-item.is-menu-open')) {
    el.classList.remove('is-menu-open');
  }
}

function _toggleAgentRowMenu(anchorBtn, agentId, source = '') {
  if (_isCommanderAgent(agentId)) return;
  const menu = document.getElementById('agent-row-menu');
  if (!menu) return;
  // Toggle off if already open for this same anchor.
  if (menu.style.display !== 'none' && menu.dataset.agentId === agentId) {
    _closeAgentRowMenu();
    return;
  }
  // Reset any prior sticky row before marking the new one.
  for (const el of document.querySelectorAll('.agent-card.is-menu-open')) {
    el.classList.remove('is-menu-open');
  }
  anchorBtn.closest('.agent-card')?.classList.add('is-menu-open');
  menu.dataset.agentId = agentId;
  menu.dataset.agentSource = source || '';
  // Re-render menu items per-open: builtin gets only enable/disable, custom
  // gets edit / delete / enable-disable. Per-row state (enabled?) drives the
  // toggle item label. Done as innerHTML rebuild because there are only
  // ~3 items max and binding cost is negligible.
  _renderAgentRowMenuItems(menu, agentId, source);
  _positionRowMenu(menu, anchorBtn);
  if (!menu.dataset.bound) {
    menu.dataset.bound = '1';
    document.addEventListener('click', (e) => {
      if (menu.style.display === 'none') return;
      if (menu.contains(e.target)) return;
      if (e.target.closest('.agent-card-more')) return;
      _closeAgentRowMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menu.style.display !== 'none') _closeAgentRowMenu();
    });
    window.addEventListener('scroll', _closeAgentRowMenu, true);
    window.addEventListener('resize', _closeAgentRowMenu);
    window.addEventListener('i18n-change', _closeAgentRowMenu);
  }
}

// Re-render the agent grid + currently selected detail page when the UI
// language changes — descriptions are bilingual now, and `pickDesc`
// returns a different string after the locale flip. Detail re-render goes
// through `selectAgent` so it re-fetches the full agent (the cached
// `_selectedAgent` only holds id/name/source).
window.addEventListener('i18n-change', () => {
  if (_agentsCache && !_agentsCacheIsSummary) renderAgentsList(_agentsCache);
  if (_selectedAgent?.id) {
    selectAgent(_selectedAgent.id).catch(() => { /* ignore */ });
  }
});

function _resetAgentDetailScroll() {
  const detailContent = document.getElementById('agents-detail-content');
  if (detailContent) detailContent.scrollTop = 0;
  for (const sel of ['.agents-detail-body', '#agents-detail-desc', '#agents-detail-workflow']) {
    const el = document.querySelector(sel);
    if (el) el.scrollTop = 0;
  }
}

async function _renderCommanderAgentDetail(editing = false) {
  await _refreshCommanderAgentState();
  const agent = _buildCommanderAgent();
  _selectedAgent = { id: agent.agent_id, name: agent.name, source: agent.source };
  _renderAgentDetail(agent, editing);
}

async function refreshAgentsAfterMarketplaceReconcile() {
  await loadAgents(true);
  if (_agentEditing) return;
  if (_selectedAgent?.id && _isAgentPlatformSource(_selectedAgent.source)) {
    await selectAgent(_selectedAgent.id);
  }
}

/** Render the per-row "⋯" menu items based on the target agent's source +
 *  enabled state. Called fresh on each open so the toggle label is right
 *  and builtin agents see only the enable/disable item. */
function _renderAgentRowMenuItems(menu, agentId, source = '') {
  if (_isCommanderAgent(agentId)) {
    menu.innerHTML = '';
    return;
  }
  const normalizedSource = _agentSource(source);
  const a = _agentsCache?.find((x) => x.agent_id === agentId && (!normalizedSource || _agentSource(x.source) === normalizedSource))
    || _agentsCache?.find((x) => x.agent_id === agentId);
  const enabled = a ? a.enabled !== false : true;
  const isMock = _isAgentProfileMock(a || agentId);
  const isCustom = a?.source === 'custom' && !isMock;
  const canEditDefinition = !isMock && isCustom;
  const canEdit = canEditDefinition || _canEditAgentMemory(a);
  const toggleLabel = enabled ? t('component.disable') : t('component.enable');
  const items = [];
  if (canEdit) {
    items.push(`<div class="agent-row-menu-item" data-action="edit">${escapeHtml(t('agents.edit'))}</div>`);
  }
  // Upload-to-marketplace is owned by marketplace_dev.js (renderer-side dev module). the open-source build
  // doesn't ship that file, so `typeof openMarketplaceUpload === 'function'` is false there
  // and the menu item simply doesn't appear — no isDevMode check needed (and would be banned
  // by the open-source build's strip-rules anyway).
  if (typeof openMarketplaceUpload === 'function') {
    items.push(`<div class="agent-row-menu-item" data-action="upload-marketplace">${escapeHtml(t('marketplace.upload'))}</div>`);
  }
  if (!isMock) items.push(`<div class="agent-row-menu-item" data-action="toggle-enabled">${escapeHtml(toggleLabel)}</div>`);
  if (canEditDefinition) {
    items.push(`<div class="agent-row-menu-item is-danger" data-action="delete">${escapeHtml(t('agents.delete'))}</div>`);
  }
  menu.innerHTML = items.join('');
  for (const item of menu.querySelectorAll('.agent-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      const aid = menu.dataset.agentId;
      const source = menu.dataset.agentSource || a?.source || '';
      _closeAgentRowMenu();
      if (!aid) return;
      if (action === 'edit') {
        await _showAgentsDetailView(aid);
        if (!_agentEditing) await toggleAgentEditMode();
      } else if (action === 'delete') {
        if (_selectedAgent?.id !== aid) await selectAgent(aid);
        await deleteSelectedAgent();
      } else if (action === 'upload-marketplace') {
        if (typeof openMarketplaceUpload === 'function') await openMarketplaceUpload('agent', aid, source);
      } else if (action === 'toggle-enabled') {
        await _flipAgentEnabledFromMenu(aid);
      }
    });
  }
}

async function _flipAgentEnabledFromMenu(agentId) {
  if (_isCommanderAgent(agentId)) return;
  if (_isAgentProfileMock(agentId)) return;
  const cached = _agentsCache?.find((x) => x.agent_id === agentId);
  const next = !(cached?.enabled !== false);
  await _flipAgentEnabled(agentId, next);
}

async function selectAgent(agentId) {
  // Discard any uncommitted edit state when switching agents.
  if (_agentEditing && _selectedAgent && _selectedAgent.id !== agentId) {
    await _exitAgentEditMode();
  }
  if (_isCommanderAgent(agentId)) {
    await _renderCommanderAgentDetail(false);
    _resetAgentDetailScroll();
    return;
  }
  try {
    if (typeof closeExpenseWorkbench === 'function') closeExpenseWorkbench();
    const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`);
    const data = await res.json();
    if (!data.ok || !data.agent) return;
    data.agent.source = _agentSource(data.agent.source);
    await _maybeLoadAgentSkillNames(_agentSkillIds(data.agent), data.agent.agent_id, { refresh: false });
    _selectedAgent = { id: data.agent.agent_id, name: data.agent.name, source: data.agent.source };
    _renderAgentDetail(data.agent, false);
    // Reset every nested scroll container — `.agents-detail-content` and
    // `.agents-detail-body` are the outer two, and `.agents-detail-desc` /
    // `.agents-detail-workflow` each have `overflow-y: auto` of their own
    // (style.css:4190). Without resetting the inner two the previous
    // agent's mid-scroll position bleeds into the next agent's view.
    _resetAgentDetailScroll();
  } catch (e) {
    _agentsLog.error('load agent failed', e);
  }
}



// ─── "Use" flow: preselect in the Commander composer ───

/**
 * Select an agent in the Commander tab and wait for the user's next message.
 */
async function useAgent(agentId, managementOpenGesture) {
  if (_isAgentProfileMock(agentId)) return;
  if (_isCommanderAgent(agentId)) {
    _agentsLog.info('use commander');
    _agentsTrackClick('agent_use', {
      agent_id: _COMMANDER_AGENT_ID,
    });
    setView('new-chat');
    if (typeof setChatRecipient === 'function') setChatRecipient('new-chat', { kind: 'commander' });
    if (typeof setChatUseSelection === 'function') setChatUseSelection('new-chat', null, { focus: false });
    setTimeout(() => {
      document.getElementById('new-chat-input')?.focus();
    }, 50);
    return;
  }
  const cachedAgent = _agentsCache?.find((a) => a.agent_id === agentId);
  if (cachedAgent?.enabled === false) return;
  const cachedCanonicalExpenseAgent = cachedAgent
    && cachedAgent.interaction_mode === 'management_only'
    && cachedAgent.management_surface === 'expense_workbench'
    && cachedAgent.reimbursement_entry_role === 'canonical';
  const preparedManagementOpen = cachedCanonicalExpenseAgent
    && managementOpenGesture === 'agent_card'
    && window.cogseed?.expenseWorkbench?.prepareOpen
    ? window.cogseed.expenseWorkbench.prepareOpen(agentId, managementOpenGesture).then(
      () => ({ ok: true }),
      (error) => ({
        ok: false,
        error: error instanceof Error ? error : new Error(String(error || t('agents.expense_open_authorization_failed'))),
      }),
    )
    : null;
  let preparedManagementOpenConsumed = false;
  try {
    const aRes = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`);
    const aData = await aRes.json();
    if (!aData.ok || !aData.agent) throw new Error(aData.error || t('agents.agent_not_found'));
    const agent = aData.agent;
    if (agent.enabled === false) return;
    if (agent.interaction_mode === 'management_only') {
      if (agent.management_surface === 'expense_workbench'
          && agent.reimbursement_entry_role === 'canonical'
          && typeof openExpenseWorkbench === 'function') {
        const prepared = preparedManagementOpen ? await preparedManagementOpen : null;
        if (prepared && !prepared.ok) throw prepared.error;
        if (managementOpenGesture === 'agent_card') {
          if (!prepared) throw new Error(t('agents.management_agent_changed'));
          const grid = document.getElementById('agents-grid-view');
          const detail = document.getElementById('agents-detail-view');
          if (grid) grid.style.display = 'none';
          if (detail) detail.style.display = 'flex';
          agent.source = _agentSource(agent.source);
          _selectedAgent = { id: agent.agent_id, name: agent.name, source: agent.source };
          _renderAgentDetail(agent, false);
          _resetAgentDetailScroll();
        }
        preparedManagementOpenConsumed = !!prepared;
        await openExpenseWorkbench(agent.agent_id, managementOpenGesture, !!prepared);
      }
      return;
    }

    _agentsLog.info('use agent', { agent_id: agentId });
    _agentsTrackClick('agent_use', {
      agent_id: agentId,
    });

    setView('new-chat');
    setChatRecipient('new-chat', {
      kind: 'agent',
      id: agentId,
      name: agent.name || agent.agent_id,
    });
    if (typeof setChatUseSelection === 'function') setChatUseSelection('new-chat', null, { focus: false });
    setTimeout(() => {
      document.getElementById('new-chat-input')?.focus();
    }, 50);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e || t('common.unknown_error'));
    await uiAlert(t('agents.launch_failed', { reason }));
  } finally {
    if (preparedManagementOpen && !preparedManagementOpenConsumed) {
      await preparedManagementOpen;
      await window.cogseed.expenseWorkbench.close().catch(() => {});
    }
  }
}

async function useSkill(skillId, skillName) {
  if (typeof _skillsCache !== 'undefined'
      && _skillsCache?.some((s) => s.id === skillId && s.enabled === false)) return;
  // Open-tier skills (external packages / global folders) live in their own
  // cache; a disabled one must not run from its card's play button either.
  if (typeof _openSkillsCache !== 'undefined' && Array.isArray(_openSkillsCache)
      && _openSkillsCache.some((s) => s.id === skillId && s.enabled === false)) return;
  // Skill "use" flow: navigate to the new-chat page with the skill
  // pre-selected and wait for user input.
  _agentsLog.info('use skill', { skill_id: skillId, skill_name: skillName || skillId });
  _agentsTrackClick('skill_use', {
    skill_id: skillId,
  });
  setView('new-chat');
  if (typeof setChatRecipient === 'function') {
    setChatRecipient('new-chat', { kind: 'commander' });
  }
  setChatUseSelection('new-chat', { kind: 'skill', id: skillId, name: skillName || skillId });
  setTimeout(() => document.getElementById('new-chat-input')?.focus(), 50);
}


function bindAgentPickers() {
  // Re-bindable helper: wire the recipient chips on both chat panels +
  // under anchorIds. Guarded with dataset.bound so a second call is a no-op.
  document.querySelectorAll('[data-agent-picker-tab]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _setAgentPickerTab(btn.dataset.agentPickerTab || 'agents');
    });
  });
  const searchInput = document.getElementById('agent-picker-search');
  searchInput?.addEventListener('input', () => {
    _renderAgentPickerList(searchInput.value);
  });
  searchInput?.addEventListener('keydown', (e) => {
    // IME composition guard (CLAUDE.md §8): Enter / Arrow keys belong to
    // the IME while a Chinese / Japanese / Korean candidate is being
    // composed; without this early-return, pressing Enter to commit an
    // English candidate would also fire our select-active-item handler.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { _atKeyMark = null; _closeAgentPicker(); e.preventDefault(); return; }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !searchInput.value && _atKeyMark) {
      const input = _consumeAtKeyChar();
      _closeAgentPicker();
      if (input) _focusInput(input);
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowRight') { _moveAgentPickerTab(1); e.preventDefault(); return; }
    if (e.key === 'ArrowLeft')  { _moveAgentPickerTab(-1); e.preventDefault(); return; }
    if (e.key === 'ArrowDown') { _moveAgentPickerActive(1); e.preventDefault(); return; }
    if (e.key === 'ArrowUp')   { _moveAgentPickerActive(-1); e.preventDefault(); return; }
    if (e.key === 'Enter') {
      const listEl = document.getElementById('agent-picker-list');
      const active = listEl?.querySelector('.skill-picker-item.active[data-id]')
        || listEl?.querySelector('.skill-picker-item[data-id]');
      if (active) { active.click(); e.preventDefault(); }
    }
  });
  for (const { chip, input } of _RECIPIENT_ANCHOR_PAIRS) {
    bindRecipientAnchor(chip, input);
  }
  // One global click handler is enough — guard with a flag on the picker.
  const picker = document.getElementById('agent-picker');
  if (picker && !picker.dataset.outsideBound) {
    picker.dataset.outsideBound = '1';
    document.addEventListener('click', (e) => {
      if (!picker || picker.style.display === 'none') return;
      if (picker.contains(e.target)) return;
      const anchorId = picker.dataset.anchorId;
      const anchorEl = anchorId ? document.getElementById(anchorId) : null;
      if (anchorEl && anchorEl.contains(e.target)) return;
      _atKeyMark = null;
      _closeAgentPicker();
    });
    window.addEventListener('i18n-change', () => {
      _updateAgentPickerChrome();
      if (picker.style.display !== 'none') {
        const search = document.getElementById('agent-picker-search');
        _renderAgentPickerList(search ? search.value : '');
      }
    });
  }

}
