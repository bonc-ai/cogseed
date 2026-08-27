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
  return !!(agent && agent.runtime && (agent.runtime.kind === 'cli' || agent.runtime.kind === 'p3394-gateway'));
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
    const moreBtn = (isMock || isCommander) ? '' : `<button type="button" class="agent-card-more" data-agent-more title="${moreTitle}" aria-label="${moreTitle}">⋯</button>`;
    const avatarHtml = renderAvatarHtml(a.icon, a.color, {
      size: 32,
      seed: a.agent_id,
      extraClass: 'agent-card-avatar',
      // 外接 CLI agent：头像内容换成该 agent 名称前两个字母（如 Claude → "Cl"）
      letter: _isExternalCliAgent(a) ? (a.name || '') : '',
    });
    // CLI brand chip on the bottom row, shared with the play button.
    const cliChip = (a.runtime && (a.runtime.kind === 'cli' || a.runtime.kind === 'p3394-gateway'))
      ? `<span class="agent-card-chip is-cli is-cli-${escapeHtml(a.runtime.cli)}">${escapeHtml(_cliBadgeLabel(a.runtime.cli))}</span>`
      : '';
    // Source provenance chips on the bottom row. Version/category now live
    // in the subtitle line under the card title, so marketplace only keeps
    // review status here when that UI is enabled.
    const provenanceChips = _isAgentPlatformSource(a.source) ? _agentPlatformStatusChipsHtml(a) : '';
    return `
      <div class="agent-card${enabled ? '' : ' is-disabled'}" data-id="${escapeHtml(a.agent_id)}" data-source="${escapeHtml(a.source || '')}">
        <div class="agent-card-header">
          ${avatarHtml}
          <div class="agent-card-title">
            <span class="agent-card-name">${escapeHtml(a.name || t('agents.unnamed'))}</span>
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

// Render the header meta strip for a single agent / skill detail. Custom items
// mount an editable category select beside these static chips.
function _renderSourceMetaHtml(item) {
  if (!item) return '';
  if (_isCommanderAgent(item)) return '';
  const parts = [];
  if (item.version) {
    const versionLabel = t('marketplace.version').replace('{version}', String(item.version));
    parts.push(`<span class="agents-detail-source is-version">${escapeHtml(versionLabel)}</span>`);
  }
  if (_agentSource(item.source) !== 'custom') {
    const lang = (typeof getLang === 'function') ? getLang() : 'en';
    const label = _resolveCategoryLabel(item.category, lang);
    parts.push(`<span class="agents-detail-source is-category">${escapeHtml(label)}</span>`);
  }
  return parts.join('');
}

async function _detailCategoryOptions(currentValue = '') {
  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  const canonical = (code) => {
    return typeof _mpCanonicalCategoryCode === 'function'
      ? _mpCanonicalCategoryCode(code)
      : String(code || '').trim();
  };
  const stateCats = (typeof _mpState !== 'undefined' && Array.isArray(_mpState?.categories)) ? _mpState.categories : [];
  const cacheCats = (typeof _mpCategoriesCache !== 'undefined' && Array.isArray(_mpCategoriesCache)) ? _mpCategoriesCache : [];
  let categories = stateCats.length ? stateCats : cacheCats;
  if (!categories.length && typeof window !== 'undefined' && window.cogseed?.invoke) {
    try {
      const res = await window.cogseed.invoke('marketplace.categories', { local_only: true });
      const list = Array.isArray(res?.list) ? res.list : [];
      if (list.length) {
        categories = list;
        if (typeof _mpCategoriesCache !== 'undefined') _mpCategoriesCache = list;
        if (typeof _mpState !== 'undefined' && _mpState) _mpState.categories = list;
        if (typeof _mpPersistCategoriesCache === 'function') _mpPersistCategoriesCache(list);
      }
    } catch (_) {
      // The current value / General fallback below keeps the control usable.
    }
  }

  const seen = new Set();
  const options = [];
  for (const category of categories) {
    const code = canonical(category && category.code);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    options.push({
      value: code,
      label: (typeof pickLocalizedName === 'function' ? pickLocalizedName(category, lang) : '') || code,
    });
  }

  const current = canonical(currentValue || 'general') || 'general';
  if (current && !seen.has(current)) {
    options.unshift({
      value: current,
      label: _resolveCategoryLabel(current, lang) || current,
    });
    seen.add(current);
  }
  if (!options.length) options.push({ value: 'general', label: _generalCategoryLabel(lang) });
  return options;
}

async function _mountDetailCategorySelect(host, { value = 'general', onChange, readonly = false } = {}) {
  if (!host) return null;
  const current = (typeof _mpCanonicalCategoryCode === 'function')
    ? _mpCanonicalCategoryCode(value || 'general')
    : String(value || 'general').trim();
  const mount = document.createElement('div');
  mount.className = 'ai-select detail-category-select';
  host.appendChild(mount);
  const options = await _detailCategoryOptions(current);
  let api;
  api = _aiSelectMount(mount, {
    options,
    value: current || 'general',
    onChange: async (nextValue) => {
      if (readonly) {
        api.setValue(current || 'general');
        return;
      }
      if (typeof onChange === 'function') await onChange(nextValue || 'general', api);
    },
  });
  if (readonly) {
    mount.classList.add('is-readonly');
    const trigger = mount.querySelector('.ai-select-trigger');
    if (trigger) {
      trigger.setAttribute('disabled', '');
      trigger.setAttribute('aria-disabled', 'true');
    }
  }
  return api;
}

function _renderAgentHeaderCategory(agent) {
  const sourceEl = document.getElementById('agents-detail-source');
  if (!sourceEl || _isCommanderAgent(agent) || _agentSource(agent?.source) !== 'custom') return;
  const agentId = agent?.agent_id;
  const isMock = _isAgentProfileMock(agent);
  _mountDetailCategorySelect(sourceEl, {
    value: agent?.category || 'general',
    readonly: isMock,
    onChange: async (category, api) => {
      try {
        const res = await window.cogseed.invoke('agents.update', {
          agent_id: agentId,
          updates: { category: category || 'general' },
        });
        if (!res || !res.ok) {
          api.setValue(agent?.category || 'general');
          uiAlert((res && res.error) || t('agents.update_failed'));
          return;
        }
        agent.category = res.agent?.category || category || 'general';
        await loadAgents(true);
        if (_selectedAgent?.id === agentId && !_agentEditing) await selectAgent(agentId);
      } catch (err) {
        api.setValue(agent?.category || 'general');
        uiAlert((err && err.message) || t('agents.update_failed'));
      }
    },
  }).catch((err) => _agentsLog.warn('render agent category select failed', err));
}

function _agentProfileChipHtml(text, extraClass) {
  return text ? `<span class="agents-profile-chip${extraClass ? ' ' + extraClass : ''}">${escapeHtml(text)}</span>` : '';
}

function _agentDetailListIconHtml(kind) {
  if (kind === 'memory') {
    return '<svg viewBox="0 0 24 24" fill="none"><path d="M7 4.5h10a1.5 1.5 0 0 1 1.5 1.5v14l-6.5-3.6L5.5 20V6A1.5 1.5 0 0 1 7 4.5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  }
  if (kind === 'standard') {
    return '<svg viewBox="0 0 24 24" fill="none"><path d="m5 12 4.2 4.2L19 6.8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="7.5" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
}

function _agentMemoryListItemHtml(text, editable) {
  if (!text) return '';
  const removeTitle = _agentLabel('agents.memory_remove', '删除记忆', 'Remove memory', 'メモリを削除');
  const editTitle = _agentLabel('agents.memory_edit', '修改记忆', 'Edit memory', 'メモリを編集');
  return `
    <div class="agents-detail-list-item">
      <span class="agents-detail-list-icon is-memory" aria-hidden="true">${_agentDetailListIconHtml('memory')}</span>
      ${editable
        ? `<button type="button" class="agents-detail-list-text is-action" data-agent-memory-edit="${escapeHtml(text)}" title="${escapeHtml(editTitle)}">${escapeHtml(text)}</button>`
        : `<span class="agents-detail-list-text">${escapeHtml(text)}</span>`}
      ${editable ? `<button type="button" class="agents-memory-chip-remove" data-agent-memory-remove="${escapeHtml(text)}" title="${escapeHtml(removeTitle)}" aria-label="${escapeHtml(removeTitle)}">×</button>` : ''}
    </div>
  `;
}

function _agentEditableListItemHtml(text, index, key) {
  if (!text) return '';
  const editTitle = _agentLabel('agents.tag_edit', '修改', 'Edit', '編集');
  const removeTitle = _agentLabel('agents.tag_remove', '删除', 'Remove', '削除');
  const iconKind = key === 'standards' ? 'standard' : 'ability';
  return `
    <div class="agents-detail-list-item">
      <span class="agents-detail-list-icon is-${escapeHtml(iconKind)}" aria-hidden="true">${_agentDetailListIconHtml(iconKind)}</span>
      <button type="button" class="agents-detail-list-text is-action" data-agent-list-edit="${escapeHtml(key)}" data-agent-list-index="${index}" title="${escapeHtml(editTitle)}">${escapeHtml(text)}</button>
      <button type="button" class="agents-memory-chip-remove" data-agent-list-remove="${escapeHtml(key)}" data-agent-list-index="${index}" title="${escapeHtml(removeTitle)}" aria-label="${escapeHtml(removeTitle)}">×</button>
    </div>
  `;
}

function _agentReadonlyListItemHtml(text, key) {
  if (!text) return '';
  const iconKind = key === 'standards' ? 'standard' : 'ability';
  return `
    <div class="agents-detail-list-item">
      <span class="agents-detail-list-icon is-${escapeHtml(iconKind)}" aria-hidden="true">${_agentDetailListIconHtml(iconKind)}</span>
      <span class="agents-detail-list-text">${escapeHtml(text)}</span>
    </div>
  `;
}

function _agentWorkflowMarkdown(steps) {
  if (!steps.length) return '';
  return steps.map((step, idx) => {
    const title = normalizeDisplayText(step.title || step.description);
    const desc = normalizeDisplayText(step.description);
    const tool = normalizeDisplayText(step.tool);
    const line = `${idx + 1}. ${title}${tool ? `（${tool}）` : ''}`;
    return desc && desc !== title ? `${line}\n${desc}` : line;
  }).join('\n\n');
}

function _agentProfileEntryTags(entries) {
  return entries
    .map((entry) => entry.title || entry.description)
    .map(normalizeDisplayText)
    .filter(Boolean);
}

function _agentTextList(agent, key) {
  return _agentProfileEntryTags(_agentProfileEntries(_agentProfile(agent)[key])).slice(0, 20);
}

function _canEditAgentDefinition(agent) {
  const source = _agentSource(agent && agent.source);
  return !!agent && !_isAgentProfileMock(agent)
    && source === 'custom';
}

function _canEditAgentMemory(agent) {
  const source = _agentSource(agent && agent.source);
  return !!agent
    && !_isAgentProfileMock(agent)
    && !_isExternalCliAgent(agent)
    && (_isCommanderAgent(agent) || source === 'custom' || _isAgentPlatformSource(source));
}

function _canEnterAgentEditMode(agent) {
  return _isCommanderAgent(agent) || _canEditAgentDefinition(agent) || _canEditAgentMemory(agent);
}

async function _saveAgentTextList(agent, key, values) {
  if (!agent || !_canEditAgentDefinition(agent)) return false;
  const clean = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const text = normalizeDisplayText(raw);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    clean.push(text);
    if (clean.length >= 20) break;
  }
  try {
    const res = await window.cogseed.invoke('agents.update', {
      agent_id: agent.agent_id,
      updates: { [key]: clean },
    });
    if (!res || !res.ok) {
      await uiAlert((res && res.error) || t('agents.update_failed'));
      return false;
    }
    await loadAgents(true);
    await _refreshAgentDetail(agent.agent_id);
    return true;
  } catch (err) {
    await uiAlert((err && err.message) || t('agents.update_failed'));
    return false;
  }
}

async function _refreshAgentDetail(agentId) {
  if (!agentId) return;
  if (_isCommanderAgent(agentId)) {
    await _renderCommanderAgentDetail(!!_agentEditing);
    return;
  }
  const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`);
  const data = await res.json();
  if (!data.ok || !data.agent) return;
  data.agent.source = _agentSource(data.agent.source);
  await _maybeLoadAgentSkillNames(_agentSkillIds(data.agent), data.agent.agent_id, { refresh: false });
  _selectedAgent = { id: data.agent.agent_id, name: data.agent.name, source: data.agent.source };
  _renderAgentDetail(data.agent, !!_agentEditing);
}

async function _promptAgentTextListValue(kind, current = '') {
  const label = kind === 'standards'
    ? _agentLabel(
        'agents.standard_prompt',
        '输入交付标准：明确可验收的预期结果',
        'Enter a delivery standard: an expected, verifiable result',
        '納品基準を入力：検証できる期待結果',
      )
    : _agentLabel('agents.knowhow_prompt', '输入擅长点', 'Enter know-how', '得意分野を入力');
  const value = typeof uiPrompt === 'function'
    ? await uiPrompt(label, current)
    : window.prompt(label, current);
  return normalizeDisplayText(value);
}

function _renderEditableTagList(host, agent, key, tags, editing) {
  const canEdit = !!editing && _canEditAgentDefinition(agent);
  if (!host) return;
  host.innerHTML = canEdit
    ? tags.map((tag, idx) => _agentEditableListItemHtml(tag, idx, key)).join('')
    : tags.map((tag) => _agentReadonlyListItemHtml(tag, key)).join('');
  if (!canEdit) return;
  host.querySelectorAll('[data-agent-list-edit]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const idx = Number(btn.getAttribute('data-agent-list-index'));
      if (!Number.isInteger(idx) || idx < 0 || idx >= tags.length) return;
      const next = await _promptAgentTextListValue(key, tags[idx]);
      if (!next || next === tags[idx]) return;
      const values = tags.slice();
      values[idx] = next;
      await _saveAgentTextList(agent, key, values);
    });
  });
  host.querySelectorAll('[data-agent-list-remove]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const idx = Number(btn.getAttribute('data-agent-list-index'));
      if (!Number.isInteger(idx) || idx < 0 || idx >= tags.length) return;
      const ok = typeof uiConfirm === 'function'
        ? await uiConfirm({
            message: _agentLabel('agents.tag_remove_confirm', '确认删除这一项？', 'Remove this item?', 'この項目を削除しますか？'),
            okLabel: _agentLabel('agents.memory_remove_ok', '删除', 'Delete', '削除'),
            cancelLabel: _agentLabel('common.cancel', '取消', 'Cancel', 'キャンセル'),
          })
        : false;
      if (!ok) return;
      const values = tags.filter((_, i) => i !== idx);
      await _saveAgentTextList(agent, key, values);
    });
  });
}

function _mountAgentListAddButton(section, agent, key, tags, editing) {
  const title = section?.querySelector('.agents-detail-label, .agents-detail-subtitle');
  if (!title) return;
  title.querySelector('[data-agent-list-add]')?.remove();
  if (!editing || !_canEditAgentDefinition(agent)) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'agents-memory-add';
  btn.dataset.agentListAdd = key;
  btn.textContent = _agentLabel('agents.tag_add', '添加', 'Add', '追加');
  title.appendChild(btn);
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    const next = await _promptAgentTextListValue(key, '');
    if (!next) return;
    await _saveAgentTextList(agent, key, [...tags, next]);
  });
}

function _agentInputRefs(agent) {
  const cleanInputTitle = (value) => normalizeDisplayText(value)
    .replace(/\s*[（(]\s*(可选|选填|optional)\s*[）)]\s*$/i, '')
    .replace(/\s*[（(]\s*(必填|required)\s*[）)]\s*$/i, '')
    .trim();
  return Array.isArray(agent.inputs)
    ? agent.inputs.map((input) => ({
        title: cleanInputTitle(input.label || input.id || ''),
        description: normalizeDisplayText(input.description || input.type || ''),
        required: input.required === true,
      })).filter((input) => input.title)
    : [];
}

function _agentInputChipHtml(input) {
  if (!input || !input.title) return '';
  const state = input.required
    ? _agentLabel('agents.input_required', '必填', 'Required', '必須')
    : _agentLabel('agents.input_optional', '可选', 'Optional', '任意');
  return `
    <span class="agents-profile-chip agents-input-chip" title="${escapeHtml(input.description || '')}">
      <span>${escapeHtml(input.title)}</span>
      <small>${escapeHtml(state)}</small>
    </span>
  `;
}

function _renderAgentDetailStats(agent, editing = false) {
  const section = document.getElementById('agents-detail-stats-section');
  const host = document.getElementById('agents-detail-stats');
  if (!host) return;
  const runtime = _agentRuntimeStats(agent);
  if (runtime.deliveries <= 0) {
    if (section) section.style.display = 'none';
    host.innerHTML = '';
    return;
  }
  const stats = _agentDetailStats(agent).slice(0, 4);
  if (section) section.style.display = stats.length ? '' : 'none';
  const statsHtml = stats.map((s) => `
    <div class="agents-detail-stat${s.kind === 'memory' ? ' is-memory' : ''}">
      <div class="agents-detail-stat-value">${escapeHtml(s.value)}${s.unit ? `<small>${escapeHtml(s.unit)}</small>` : ''}</div>
      <div class="agents-detail-stat-label">${escapeHtml(s.key)}</div>
    </div>
  `).join('');
  host.innerHTML = statsHtml;
}

function _renderAgentDetailMemory(agent, editing = false) {
  const section = document.getElementById('agents-detail-memory-section');
  const host = document.getElementById('agents-detail-memory');
  if (!section || !host) return;
  if (_isExternalCliAgent(agent)) {
    section.style.display = 'none';
    host.innerHTML = '';
    section.querySelector('[data-agent-memory-add]')?.remove();
    return;
  }
  const memoryTags = _agentMemoryEntries(agent)
    .map((entry) => entry.title || entry.description)
    .filter(Boolean)
    .slice(0, 20);
  const canEditMemory = !!editing && _canEditAgentMemory(agent);
  section.style.display = (memoryTags.length || canEditMemory) ? '' : 'none';
  section.querySelector('[data-agent-memory-add]')?.remove();
  const title = section.querySelector('.agents-detail-label');
  if (title && canEditMemory) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'agents-memory-add';
    btn.dataset.agentMemoryAdd = '';
    btn.textContent = _agentLabel('agents.memory_add', '添加', 'Add', '追加');
    title.appendChild(btn);
  }
  host.innerHTML = memoryTags.map((tag) => _agentMemoryListItemHtml(tag, canEditMemory)).join('');
  if (canEditMemory) _wireAgentMemoryControls(section, agent);
}

async function _agentMemoryAdd(agent, text) {
  if (_isCommanderAgent(agent)) {
    return window.cogseed.invoke('memory.add', { target: 'agent', agentId: _COMMANDER_AGENT_ID, content: text });
  }
  return window.cogseed.invoke('agents.memory.add', { agent_id: agent.agent_id, content: text });
}

async function _agentMemoryUpdate(agent, oldText, text) {
  if (_isCommanderAgent(agent)) {
    return window.cogseed.invoke('memory.replace', { target: 'agent', agentId: _COMMANDER_AGENT_ID, oldText, content: text });
  }
  return window.cogseed.invoke('agents.memory.update', { agent_id: agent.agent_id, old_text: oldText, content: text });
}

async function _agentMemoryRemove(agent, text) {
  if (_isCommanderAgent(agent)) {
    return window.cogseed.invoke('memory.remove', { target: 'agent', agentId: _COMMANDER_AGENT_ID, oldText: text });
  }
  return window.cogseed.invoke('agents.memory.remove', { agent_id: agent.agent_id, old_text: text });
}

function _wireAgentMemoryControls(host, agent) {
  host.querySelectorAll('[data-agent-memory-add]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const label = _agentLabel('agents.memory_add_prompt', '请输入要添加的记忆', 'Enter memory to add', '追加するメモリを入力');
      const content = typeof uiPrompt === 'function'
        ? await uiPrompt(label, '')
        : window.prompt(label, '');
      const text = (content || '').trim();
      if (!text) return;
      try {
        const res = await _agentMemoryAdd(agent, text);
        if (!res || res.ok === false) {
          uiAlert((res && res.error) || _agentLabel('agents.memory_update_failed', '记忆更新失败', 'Memory update failed', 'メモリ更新に失敗しました'));
          return;
        }
        await loadAgents(true);
        await _refreshAgentDetail(agent.agent_id);
      } catch (err) {
        uiAlert((err && err.message) || _agentLabel('agents.memory_update_failed', '记忆更新失败', 'Memory update failed', 'メモリ更新に失敗しました'));
      }
    });
  });
  host.querySelectorAll('[data-agent-memory-edit]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const oldText = btn.getAttribute('data-agent-memory-edit') || '';
      if (!oldText) return;
      const label = _agentLabel('agents.memory_edit_prompt', '修改记忆', 'Edit memory', 'メモリを編集');
      const content = typeof uiPrompt === 'function'
        ? await uiPrompt(label, oldText)
        : window.prompt(label, oldText);
      const text = (content || '').trim();
      if (!text || text === oldText) return;
      try {
        const res = await _agentMemoryUpdate(agent, oldText, text);
        if (!res || res.ok === false) {
          uiAlert((res && res.error) || _agentLabel('agents.memory_update_failed', '记忆更新失败', 'Memory update failed', 'メモリ更新に失敗しました'));
          return;
        }
        await loadAgents(true);
        await _refreshAgentDetail(agent.agent_id);
      } catch (err) {
        uiAlert((err && err.message) || _agentLabel('agents.memory_update_failed', '记忆更新失败', 'Memory update failed', 'メモリ更新に失敗しました'));
      }
    });
  });
  host.querySelectorAll('[data-agent-memory-remove]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const text = btn.getAttribute('data-agent-memory-remove') || '';
      if (!text) return;
      const confirmText = _agentLabel('agents.memory_remove_confirm', '确认删除这条记忆？', 'Remove this memory?', 'このメモリを削除しますか？');
      const ok = typeof uiConfirm === 'function'
        ? await uiConfirm({
            message: confirmText,
            okLabel: _agentLabel('agents.memory_remove_ok', '删除', 'Delete', '削除'),
            cancelLabel: _agentLabel('common.cancel', '取消', 'Cancel', 'キャンセル'),
          })
        : false;
      if (!ok) return;
      try {
        const res = await _agentMemoryRemove(agent, text);
        if (!res || res.ok === false) {
          uiAlert((res && res.error) || _agentLabel('agents.memory_update_failed', '记忆更新失败', 'Memory update failed', 'メモリ更新に失敗しました'));
          return;
        }
        await loadAgents(true);
        await _refreshAgentDetail(agent.agent_id);
      } catch (err) {
        uiAlert((err && err.message) || _agentLabel('agents.memory_update_failed', '记忆更新失败', 'Memory update failed', 'メモリ更新に失敗しました'));
      }
    });
  });
}

function _renderAgentDetailKnowhow(agent, editing = false) {
  const section = document.getElementById('agents-detail-knowhow-section');
  const host = document.getElementById('agents-detail-knowhow');
  if (!section || !host) return;
  if (_isExternalCliAgent(agent)) {
    section.style.display = 'none';
    host.innerHTML = '';
    _mountAgentListAddButton(section, agent, 'knowhow', [], false);
    return;
  }
  const tags = _agentTextList(agent, 'knowhow');
  const canEdit = !!editing && _canEditAgentDefinition(agent);
  section.style.display = (tags.length || canEdit) ? '' : 'none';
  _mountAgentListAddButton(section, agent, 'knowhow', tags, editing);
  _renderEditableTagList(host, agent, 'knowhow', tags, editing);
}

/** 一条资产没被继承的原因，翻成用户能懂的话。
 *
 *  `user_excluded` 单独一档：那是人做的决定，其余五档是系统按资产状态判的。
 *  两者混在一起显示，用户就没法回答「是我当初勾掉的，还是它自己失效了」。 */
function _inheritanceExclusionLabel(reason) {
  switch (reason) {
    case 'user_excluded':
      return _agentLabel('agents.inheritance_excluded_user', '你在创建时勾掉了', 'You unchecked it at creation', '作成時にあなたが外しました');
    case 'paused':
      return _agentLabel('agents.inheritance_excluded_paused', '当时已暂停', 'Paused at the time', '当時は一時停止中');
    case 'archived':
      return _agentLabel('agents.inheritance_excluded_archived', '当时已归档', 'Archived at the time', '当時はアーカイブ済み');
    case 'revoked':
      return _agentLabel('agents.inheritance_excluded_revoked', '当时已撤销', 'Revoked at the time', '当時は取り消し済み');
    case 'deleted':
      return _agentLabel('agents.inheritance_excluded_deleted', '当时已删除', 'Deleted at the time', '当時は削除済み');
    case 'purged':
      return _agentLabel('agents.inheritance_excluded_purged', '当时已彻底清除', 'Purged at the time', '当時は完全消去済み');
    default:
      return reason;
  }
}

function _inheritanceItemHtml(title, meta, { excludedByUser = false } = {}) {
  return `
    <div class="agents-detail-list-item">
      <div class="agents-detail-list-main">
        <span class="agents-detail-list-text">${escapeHtml(title)}</span>
        <span class="agents-detail-list-meta${excludedByUser ? ' is-user-choice' : ''}">${escapeHtml(meta)}</span>
      </div>
    </div>
  `;
}

/**
 * 「出生时继承了什么」。
 *
 * **两种空必须分开说。** `inheritance === null` 表示这个 Agent 生成的时候还没有
 * 继承机制——它不是「没继承到东西」，是这个问题当时根本不存在。把两者都渲染成
 * 一句「没有继承任何认知」，用户会以为自己教过的东西丢了。
 */
async function _renderAgentDetailInheritance(agent) {
  const section = document.getElementById('agents-detail-inheritance-section');
  const host = document.getElementById('agents-detail-inheritance');
  if (!section || !host) return;
  const agentId = String(agent?.agent_id || '');
  if (!agentId || _isCommanderAgent(agent)) {
    section.style.display = 'none';
    host.innerHTML = '';
    return;
  }

  let inheritance = null;
  let assetTitles = new Map();
  try {
    const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/inheritance`);
    const data = await res.json();
    if (!data.ok) throw new Error('inheritance unavailable');
    inheritance = data.inheritance;
    if (inheritance) {
      // 继承记录只存引用，标题要另取——取不到就退回显示 id，而不是空着。
      // recall 频道在渲染层一律直接 invoke（与 skills.js 一致），不走 apiFetch。
      const list = await window.cogseed.invoke('recall.assets.list').catch(() => null);
      assetTitles = new Map((list?.assets || []).map((a) => [a.id, a.title]));
    }
  } catch {
    section.style.display = 'none';
    host.innerHTML = '';
    return;
  }

  // 异步返回期间用户可能已经切走了，别把结果画到别人的详情页上。
  if (!_selectedAgent || _selectedAgent.id !== agentId) return;

  section.style.display = '';

  if (!inheritance) {
    host.innerHTML = `<p class="agents-detail-placeholder">${escapeHtml(_agentLabel(
      'agents.inheritance_none_recorded',
      '这个智能体创建时还没有继承机制，所以没有出生记录——不是它没继承到东西。',
      'This agent was created before inheritance was recorded, so there is no record of its creation — that is not the same as inheriting nothing.',
      'このエージェントは継承の記録が始まる前に作成されたため、作成時の記録がありません（何も継承しなかったという意味ではありません）。',
    ))}</p>`;
    return;
  }

  const inherited = Array.isArray(inheritance.inheritedAssets) ? inheritance.inheritedAssets : [];
  const excluded = Array.isArray(inheritance.excludedAssets) ? inheritance.excludedAssets : [];

  const inheritedHtml = inherited.map((ref) => _inheritanceItemHtml(
    assetTitles.get(ref.asset_id) || ref.asset_id,
    `v${ref.version}`,
  )).join('');

  const excludedHtml = excluded.map((entry) => _inheritanceItemHtml(
    assetTitles.get(entry.assetId) || entry.assetId,
    _inheritanceExclusionLabel(entry.reason),
    { excludedByUser: entry.reason === 'user_excluded' },
  )).join('');

  const emptyHtml = inherited.length ? '' : `<p class="agents-detail-placeholder">${escapeHtml(_agentLabel(
    'agents.inheritance_empty',
    '创建时没有可继承的认知资产。',
    'There was no cognition available to inherit when this agent was created.',
    '作成時に継承できる認知資産がありませんでした。',
  ))}</p>`;

  const excludedTitle = excluded.length ? `<div class="agents-detail-label is-sub">${escapeHtml(_agentLabel(
    'agents.inheritance_excluded_label',
    '没有带走的',
    'Not carried over',
    '引き継がなかったもの',
  ))}</div>` : '';

  host.innerHTML = `${emptyHtml}${inheritedHtml}${excludedTitle}${excludedHtml}`;
}

function _renderAgentDetail(agent, editing) {
  agent = { ...agent, source: _agentSource(agent.source) };
  const isCommander = _isCommanderAgent(agent);
  document.getElementById('agents-detail-content').style.display = '';

  const nameEl = document.getElementById('agents-detail-name');
  const nameInput = document.getElementById('agents-detail-name-input');
  const sourceEl = document.getElementById('agents-detail-source');
  const descEl = document.getElementById('agents-detail-desc');
  const workflowEl = document.getElementById('agents-detail-workflow');
  const editBtn = document.getElementById('agent-edit-btn');

  const lang = getLang();
  nameEl.textContent = agent.name || '';
  if (nameInput) nameInput.value = agent.name || '';
  // Header chips: custom items mount an editable category dropdown;
  // marketplace-installed items show version + category as static chips.
  sourceEl.className = 'agents-detail-source-row';
  sourceEl.innerHTML = _renderSourceMetaHtml(agent);
  _renderAgentHeaderCategory(agent);
  // Runtime slot lives at the top of the body now (not the header):
  // an always-editable dropdown so the user can flip CogSeed ↔ local CLI
  // without entering edit mode. The header chip was removed because
  // it duplicated information the dropdown already exposes.
  _renderAgentDetailRuntime(agent);
  _renderAgentDetailProjectDir(agent);
  void _renderAgentDetailGateway(agent);
  const localizedDesc = _agentSummary(agent, lang);
  descEl.textContent = localizedDesc;
  descEl.classList.toggle('is-empty', !localizedDesc);

  _renderAgentDetailAvatar(agent);
  _renderAgentDetailStats(agent, editing);
  _renderAgentDetailMemory(agent, editing);
  _renderAgentDetailKnowhow(agent, editing);
  // 异步：要读出生快照与资产标题。失败就把整段藏起来，不占位。
  void _renderAgentDetailInheritance(agent);

  // CLI-backed agents have no authored workflow / skill_list — the
  // external CLI brings its own behavior. Hide the entire workflow
  // section so the detail page doesn't show an empty editor block.
  const workflowSection = document.querySelector('.agents-detail-section-workflow');
  const isCliRuntime = !!(agent.runtime && (agent.runtime.kind === 'cli' || agent.runtime.kind === 'p3394-gateway'));
  const structuredWorkflow = _agentWorkflowSteps(agent);
  const hasWorkflowToShow = structuredWorkflow.length || !!String(agent.workflow || '').trim();
  if (workflowSection) workflowSection.style.display = (isCliRuntime && !hasWorkflowToShow) ? 'none' : '';

  const unsetHtml = `<span class="agents-detail-placeholder">${escapeHtml(t('agents.placeholder_unset'))}</span>`;
  // Workflow renders markdown in readonly mode; raw text in edit mode so user
  // can edit source directly.
  if (editing && !isCommander) {
    workflowEl.textContent = agent.workflow || '';
  } else {
    const workflowMarkdown = structuredWorkflow.length
      ? _agentWorkflowMarkdown(structuredWorkflow)
      : String(agent.workflow || '').trim();
    workflowEl.innerHTML = workflowMarkdown ? renderMarkdownFull(workflowMarkdown) : unsetHtml;
  }
  if (!editing && !localizedDesc) descEl.innerHTML = unsetHtml;

  // Detail header actions, fixed order:
  //   use (icon) / edit / enable-disable / delete
  // Edit mode hides everything except the "done" button (the relabeled
  // "edit" button).
  const useBtn = document.getElementById('agent-use-btn');
  const manageBtn = document.getElementById('agent-manage-btn');
  const enableBtn = document.getElementById('agent-enabled-btn');
  const uploadBtn = document.getElementById('agent-upload-marketplace-btn');
  const delBtn = document.getElementById('agent-delete-btn');
  const isMock = _isAgentProfileMock(agent);
  const isCustom = agent.source === 'custom' && !isMock;
  const canEditDefinition = !isMock && isCustom;
  const canEdit = isCommander || canEditDefinition || _canEditAgentMemory(agent);
  if (useBtn) {
    useBtn.style.display = editing ? 'none' : '';
    useBtn.disabled = isMock || agent.enabled === false;
    useBtn.setAttribute('aria-disabled', (isMock || agent.enabled === false) ? 'true' : 'false');
  }
  if (manageBtn) {
    const canManage = agent.management_surface === 'expense_workbench'
      && agent.reimbursement_entry_role === 'canonical';
    manageBtn.hidden = editing || !canManage;
    manageBtn.disabled = editing || !canManage || agent.enabled === false;
    manageBtn.setAttribute('aria-hidden', (!canManage || editing) ? 'true' : 'false');
    if (canManage && agent.agent_id) manageBtn.setAttribute('data-expense-agent-id', agent.agent_id);
    else manageBtn.removeAttribute('data-expense-agent-id');
  }
  if (enableBtn && isCommander) {
    enableBtn.style.display = 'none';
    enableBtn.disabled = true;
  } else if (enableBtn && isMock) {
    enableBtn.style.display = editing ? 'none' : '';
    enableBtn.disabled = true;
    enableBtn.textContent = t('component.disable');
  } else if (enableBtn) {
    enableBtn.style.display = editing ? 'none' : '';
    enableBtn.disabled = false;
  }
  // Upload button visibility: gated by marketplace_dev.js's presence (the open-source build lacks it).
  if (uploadBtn) {
    uploadBtn.style.display = isCommander
      ? 'none'
      : (isMock ? (editing ? 'none' : '') : ((typeof openMarketplaceUpload === 'function' && !editing) ? '' : 'none'));
    uploadBtn.disabled = isCommander || isMock;
  }
  if (delBtn) {
    delBtn.style.display = (!isCommander && (canEditDefinition || isMock) && !editing) ? '' : 'none';
    delBtn.disabled = isCommander || isMock;
  }
  if (editBtn) {
    editBtn.style.display = (canEdit || isMock) ? '' : 'none';
    editBtn.disabled = isMock && !isCommander;
    editBtn.textContent = editing ? t('agents.edit_btn_done') : t('agents.edit_btn_edit');
  }
  if (!isMock && !isCommander) _renderAgentEnabledButton({ id: agent.agent_id, enabled: agent.enabled !== false });

  _renderAgentOutputFormatSection(agent, editing);

  _toggleAgentFieldEditable(editing && !isCommander);
}

/** Render the output-format preference dropdown (auto / text /
 *  dashboard / artifact). Always editable (no edit-mode gating — same convention as the
 *  runtime selector); persists via `agents.update({ output_format })`. Hidden
 *  for CLI agents — those run an external coding CLI and ignore the in-process
 *  system-prompt hint entirely.
 *
 *  Legacy on-disk values map for display: `'markdown_only'` → `'text'`,
 *  `'allow_artifacts'` → `'artifact'`; `'auto'` / missing → `'auto'`
 *  (the default). */
function _renderAgentOutputFormatSection(agent, editing = false) {
  const section = document.getElementById('agents-detail-input-output-section');
  const slot = document.getElementById('agents-detail-output-format');
  const standardsSection = document.getElementById('agents-detail-output-standards-section');
  const standardsHost = document.getElementById('agents-detail-output-standards');
  const formatSection = document.getElementById('agents-detail-output-format-control');
  const inputRow = document.getElementById('agents-detail-inputs-row');
  const inputHost = document.getElementById('agents-detail-inputs');
  if (!section || !slot) return;
  const isCommander = _isCommanderAgent(agent);
  const isExternalCli = _isExternalCliAgent(agent);
  const standardTags = (isExternalCli) ? [] : _agentTextList(agent, 'standards');
  const isMock = _isAgentProfileMock(agent);
  const canShowFormatControl = !isExternalCli && !isCommander;
  const canEditStandards = !isExternalCli && !isCommander && !!editing && _canEditAgentDefinition(agent);
  const inputRefs = (isExternalCli || isCommander) ? [] : _agentInputRefs(agent);

  if (standardsSection && standardsHost) {
    standardsSection.style.display = (standardTags.length || canEditStandards) ? '' : 'none';
    _mountAgentListAddButton(standardsSection, agent, 'standards', standardTags, editing);
    _renderEditableTagList(standardsHost, agent, 'standards', standardTags, editing);
  }
  if (inputRow && inputHost) {
    inputRow.style.display = inputRefs.length ? '' : 'none';
    inputHost.innerHTML = inputRefs.map(_agentInputChipHtml).join('');
  }
  if (formatSection) formatSection.style.display = canShowFormatControl ? '' : 'none';
  if (!inputRefs.length && !canShowFormatControl) {
    section.style.display = 'none';
    slot.innerHTML = '';
    return;
  }
  section.style.display = '';
  if (!canShowFormatControl) {
    slot.innerHTML = '';
    return;
  }

  const canEdit = !isMock && agent.source === 'custom';

  slot.innerHTML = '';
  const mount = document.createElement('div');
  mount.className = 'ai-select';
  slot.appendChild(mount);

  const options = [
    { value: 'auto',           label: t('agents.output_format_auto'),          hint: t('agents.output_format_auto_hint') },
    { value: 'text',           label: t('agents.output_format_text'),          hint: t('agents.output_format_text_hint') },
    { value: 'dashboard',      label: t('agents.output_format_dashboard'),     hint: t('agents.output_format_dashboard_hint') },
    { value: 'artifact',       label: t('agents.output_format_artifact'),      hint: t('agents.output_format_artifact_hint') },
  ];
  // Map legacy on-disk values to the current 4-option display.
  let current;
  switch (agent.output_format) {
    case 'auto':                                current = 'auto';          break;
    case 'text':
    case 'markdown_only':                       current = 'text';          break;
    case 'dashboard':                           current = 'dashboard';     break;
    case 'artifact':
    case 'allow_artifacts':                     current = 'artifact';      break;
    default:                                    current = 'auto';          break;
  }

  const api = _aiSelectMount(mount, {
    options,
    value: current,
    onChange: async (val) => {
      try {
        const res = await window.cogseed.invoke('agents.update', {
          agent_id: agent.agent_id,
          updates: { output_format: val },
        });
        if (!res || !res.ok) {
          api.setValue(current);
          uiAlert((res && res.error) || t('agents.update_failed'));
        } else if (res.agent) {
          agent.output_format = res.agent.output_format;
          current = val;
        }
      } catch (err) {
        api.setValue(current);
        uiAlert((err && err.message) || t('agents.update_failed'));
      }
    },
  });
  if (!canEdit) {
    // Disable the trigger — read-only display for builtin agents in
    // non-dev mode (mirrors the runtime row pattern).
    const trigger = mount.querySelector('.ai-select-trigger');
    if (trigger) { trigger.setAttribute('disabled', ''); trigger.style.pointerEvents = 'none'; trigger.style.opacity = '0.6'; }
  }
}


/** Render the runtime control in the detail body.
 *
 *  The runtime "kind" is locked at create time:
 *  - `in_process` (CogSeed) agents → never show the selector here. The
 *    runtime row stays hidden; user has no need to see it.
 *  - `cli` agents → show a selector with **CLI options only** (no
 *    CogSeed / in_process option). User can swap which CLI backs the
 *    agent at any time, but can't revert to CogSeed — that would
 *    invalidate the description and inputs which were authored
 *    specifically for a CLI runtime.
 *
 *  Reuses `_aiSelectMount` (see CLAUDE.md "Reuse UI components") and
 *  persists each change via `agents.update({ runtime })`. */
async function _renderAgentDetailRuntime(agent) {
  const section = document.getElementById('agents-detail-runtime-section');
  const slot = document.getElementById('agents-detail-runtime');
  if (!slot || !section) return;
  slot.innerHTML = '';

  // In-process agents: section stays hidden. No selector, no
  // information to surface.
  if (agent.runtime?.kind !== 'cli') {
    section.style.display = 'none';
    return;
  }

  // Re-probe when the detail selector is rendered. A CLI can be installed
  // while CogSeed is already open, and the renderer cache otherwise keeps the
  // old missing result indefinitely.
  const entries = (typeof loadLocalCliEntries === 'function')
    ? await loadLocalCliEntries({ force: true })
    : [];
  const available = entries.filter(e => e.available);
  const seen = new Set(available.map(e => e.type));
  const currentType = agent.runtime.cli;
  const currentEntry = entries.find(e => e.type === currentType);

  // Build CLI-only options: every detected CLI + the bound one if it's
  // missing (with a warning suffix so the user can flip away in one
  // click). CogSeed / in_process is intentionally absent — see fn doc.
  const options = [];
  for (const e of available) {
    options.push({
      value: `cli:${e.type}`,
      label: `${t('agent_modal.runtime_cli_' + e.type)}${e.version ? ` (${e.version})` : ''}`,
    });
  }
  if (!seen.has(currentType)) {
    const baseLabel = t('agent_modal.runtime_cli_' + currentType);
    const labelText = (baseLabel && baseLabel !== 'agent_modal.runtime_cli_' + currentType)
      ? baseLabel : currentType;
    options.push({
      value: `cli:${currentType}`,
      label: labelText,
      hint: (typeof window.getLocalCliUnavailableHint === 'function')
        ? window.getLocalCliUnavailableHint(currentEntry)
        : t('agent.cli_not_found'),
      iconName: 'warning',
    });
  }
  if (options.length === 0) {
    // Defensive — shouldn't happen since we always add the bound CLI
    // above. Hide the row instead of rendering an empty dropdown.
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  const mount = document.createElement('div');
  mount.className = 'ai-select agents-detail-runtime-select';
  slot.appendChild(mount);
  _aiSelectMount(mount, {
    options, value: `cli:${currentType}`,
    onChange: async (next) => {
      const m = /^cli:(.+)$/.exec(next);
      if (!m) return;
      const newCli = m[1];
      // Mirror the create-modal behaviour: if the user's current name /
      // description are still the defaults of the previous CLI (or empty),
      // follow the new CLI's defaults. Otherwise, leave their edits alone.
      const updates = { runtime: { kind: 'p3394-gateway', cli: newCli } };
      const lang = (typeof getLang === 'function') ? getLang() : 'en';
      const prev = (typeof getCliDefaults === 'function') ? getCliDefaults(currentType) : null;
      const next2 = (typeof getCliDefaults === 'function') ? getCliDefaults(newCli) : null;
      const prevDescLocal = prev ? pickDesc(prev, lang) : '';
      const curName = (agent.name || '').trim();
      const curDescLocal = pickDesc(agent, lang).trim();
      // Same default-like detection as the create modal: bare default OR
      // dedup-style "<default> 2" / "(2)" suffixes count as untouched.
      const nameUntouched = _isDefaultlikeName(curName, prev?.name);
      const descUntouched = !curDescLocal || (prev && curDescLocal === prevDescLocal);
      if (next2 && nameUntouched) updates.name = next2.name;
      if (next2) {
        if (descUntouched) {
          updates.description_zh = next2.description_zh;
          updates.description_en = next2.description_en;
        }
      }
      try {
        const res = await window.cogseed.invoke('agents.update', {
          agent_id: agent.agent_id, updates,
        });
        if (res?.ok && res.agent) {
          _agentsCache = null;
          const fetched = await apiFetch(`/api/agents/${encodeURIComponent(agent.agent_id)}`);
          const data = await fetched.json();
          if (data.ok && data.agent) _renderAgentDetail(data.agent, _agentEditing);
        } else if (res?.code === 'E_AGENT_NAME_TAKEN') {
          // Name we tried to auto-apply already belongs to another
          // agent. Re-issue the update without the name override so
          // the runtime swap still goes through.
          const safeUpdates = { ...updates };
          delete safeUpdates.name;
          await window.cogseed.invoke('agents.update', {
            agent_id: agent.agent_id, updates: safeUpdates,
          });
          _agentsCache = null;
          const fetched = await apiFetch(`/api/agents/${encodeURIComponent(agent.agent_id)}`);
          const data = await fetched.json();
          if (data.ok && data.agent) _renderAgentDetail(data.agent, _agentEditing);
        }
      } catch (err) {
        _agentsLog.warn('agents.update runtime failed', err);
      }
    },
  });
}

/** P3394 外接智能体详情：托管网关运行状态 + 停止/启动按钮。
 *  复用现成 IPC p3394.external.list（返回 running/pid/port）与
 *  p3394.external.start/stop；仅对 runtime.kind==='p3394-gateway' 显示。 */
async function _renderAgentDetailGateway(agent) {
  const section = document.getElementById('agents-detail-gateway-section');
  const slot = document.getElementById('agents-detail-gateway');
  if (!section || !slot) return;
  const cli = (agent.runtime?.kind === 'p3394-gateway' && agent.runtime.cli) ? agent.runtime.cli : '';
  if (!cli) {
    section.style.display = 'none';
    slot.innerHTML = '';
    return;
  }
  section.style.display = '';
  const gateways = (typeof loadExternalGateways === 'function')
    ? await loadExternalGateways({ force: true })
    : [];
  const gw = gateways.find((g) => g && g.cli === cli);
  const running = !!(gw && gw.running);
  const statusText = running
    ? t('agents.gateway_running')
      + (gw.pid ? ` · pid ${gw.pid}` : '')
      + (gw.port ? ` · :${gw.port}` : '')
    : t('agents.gateway_offline');
  const action = running ? 'stop' : 'start';
  const btnLabel = running ? t('agents.gateway_stop') : t('agents.gateway_start');
  slot.innerHTML = `
    <div class="agents-detail-gateway-status">
      <span class="agents-detail-gateway-dot ${running ? 'is-on' : 'is-off'}"></span>
      <span class="agents-detail-gateway-text">${escapeHtml(statusText)}</span>
      <button type="button" class="btn btn-sm" data-gateway-action="${action}" data-gateway-cli="${escapeHtml(cli)}">${escapeHtml(btnLabel)}</button>
    </div>`;
  const btn = slot.querySelector('[data-gateway-action]');
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      if (action === 'stop') {
        await window.cogseed.invoke('p3394.external.stop', { cli });
      } else {
        const entries = (typeof loadLocalCliEntries === 'function')
          ? await loadLocalCliEntries({ force: true })
          : [];
        const detected = entries.find((entry) => entry && entry.type === cli);
        await window.cogseed.invoke('p3394.external.start', {
          cli,
          alias: agent.name || cli,
          ...(detected && detected.path ? { binPath: detected.path } : {}),
        });
      }
    } catch (err) {
      _agentsLog.warn('p3394 gateway toggle failed', { cli, action, error: err && (err.message || err) });
    }
    btn.disabled = false;
    void _renderAgentDetailGateway(agent);
  });
}

/** Project directory setting for external coding agents (claude / codex).
 *  Stored in a local-only main-process config; each conversation copies
 *  the effective value on its first coding-agent dispatch. */
async function _renderAgentDetailProjectDir(agent) {  const section = document.getElementById('agents-detail-project-dir-section');
  const slot = document.getElementById('agents-detail-project-dir');
  if (!section || !slot) return;
  const cli = (agent.runtime?.kind === 'cli' || agent.runtime?.kind === 'p3394-gateway') ? agent.runtime.cli : '';
  const supportsProjectDir = typeof cliIsCodingAgent === 'function' && cliIsCodingAgent(cli);
  if (!supportsProjectDir) {
    section.style.display = 'none';
    slot.innerHTML = '';
    return;
  }
  section.style.display = '';
  slot.dataset.agentId = agent.agent_id;

  const canEdit = agent.source === 'custom';

  const renderInfo = (info) => {
    if (_selectedAgent?.id !== agent.agent_id || slot.dataset.agentId !== agent.agent_id) return;
    const mode = info?.mode === 'custom' ? 'custom' : 'workspace';
    const missing = mode === 'custom' && info.exists === false;
    const pathText = String(info?.path || info?.workspace_path || '');
    const badge = mode === 'custom'
      ? t('agents.project_dir_custom')
      : t('agents.project_dir_workspace');
    const status = missing ? t('agents.project_dir_missing') : badge;
    const cardClass = [
      'agent-project-dir-card',
      mode === 'workspace' ? 'is-workspace' : 'is-custom',
      missing ? 'is-missing' : '',
      canEdit ? '' : 'is-disabled',
    ].filter(Boolean).join(' ');
    slot.innerHTML = `
      <div class="${cardClass}">
        ${_agentUiIconHtml(missing ? 'warning' : 'folder-open', 'agent-project-dir-icon')}
        <div class="agent-project-dir-main">
          <div class="agent-project-dir-path" title="${escapeHtml(pathText)}">${escapeHtml(pathText)}</div>
          <div class="agent-project-dir-mode">${escapeHtml(status)}</div>
        </div>
        <div class="agent-project-dir-actions">
          <button type="button" class="btn btn-sm" data-act="pick" ${canEdit ? '' : 'disabled'}>${escapeHtml(t('input.dir.change'))}</button>
          ${mode === 'custom' ? `<button type="button" class="btn btn-sm" data-act="reset" ${canEdit ? '' : 'disabled'}>${escapeHtml(t('agents.project_dir_use_workspace'))}</button>` : ''}
        </div>
      </div>`;
    const pickBtn = slot.querySelector('[data-act="pick"]');
    const resetBtn = slot.querySelector('[data-act="reset"]');
    const pick = async () => {
      if (!canEdit) return;
      try {
        const picked = await window.cogseed.invoke('common.pickDirectory', {
          title: t('agents.label_project_dir'),
        });
        if (!picked || picked.cancelled || !picked.path) return;
        const saved = await window.cogseed.invoke('agents.cliProjectDir.set', {
          agent_id: agent.agent_id,
          path: picked.path,
        });
        if (!saved || !saved.ok) {
          await uiAlert((saved && saved.error) || t('agents.project_dir_save_failed'));
          return;
        }
        renderInfo(saved.info);
      } catch (err) {
        await uiAlert((err && err.message) || t('agents.project_dir_save_failed'));
      }
    };
    pickBtn?.addEventListener('click', (e) => { e.stopPropagation(); pick(); });
    resetBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!canEdit) return;
      try {
        const saved = await window.cogseed.invoke('agents.cliProjectDir.set', {
          agent_id: agent.agent_id,
          path: '',
        });
        if (!saved || !saved.ok) {
          await uiAlert((saved && saved.error) || t('agents.project_dir_save_failed'));
          return;
        }
        renderInfo(saved.info);
      } catch (err) {
        await uiAlert((err && err.message) || t('agents.project_dir_save_failed'));
      }
    });
  };

  slot.innerHTML = `<div class="agent-project-dir-card is-loading">${_agentUiIconHtml('folder-open', 'agent-project-dir-icon')}<div class="agent-project-dir-main"><div class="agent-project-dir-path">${escapeHtml(t('common.loading'))}</div></div></div>`;
  try {
    const res = await window.cogseed.invoke('agents.cliProjectDir.get', { agent_id: agent.agent_id });
    if (!res || !res.ok || !res.info) throw new Error(res?.error || 'failed');
    renderInfo(res.info);
  } catch (err) {
    _agentsLog.warn('load agent project dir failed', err);
    slot.innerHTML = `<div class="agents-detail-placeholder">${escapeHtml(t('agents.project_dir_load_failed'))}</div>`;
  }
}

/** Render the detail-page avatar slot. Custom agents get a clickable avatar
 *  that opens the picker; builtin agents just show theirs read-only. Each
 *  picker change is sent as an `agents.update` IPC and the local cache is
 *  refreshed so the card grid reflects the new combo on next render. */
function _renderAgentDetailAvatar(agent) {
  const slot = document.getElementById('agents-detail-avatar');
  if (!slot) return;
  const isCommander = _isCommanderAgent(agent);
  const isCustom = agent.source === 'custom' && !_isAgentProfileMock(agent);
  const clickable = isCustom || isCommander;
  const avatarHtml = renderAvatarHtml(agent.icon, agent.color, {
    size: 32,
    seed: agent.agent_id,
    clickable,
    extraClass: 'agents-detail-avatar',
  });
  slot.innerHTML = clickable
    ? `<span class="agents-detail-avatar-edit-wrap">${avatarHtml}<span class="agents-detail-avatar-edit-badge" aria-hidden="true">${_agentUiIconHtml('edit-pencil', 'agents-detail-avatar-edit-icon')}</span></span>`
    : avatarHtml;
  if (!clickable) return;
  const trigger = slot.querySelector('.avatar-circle');
  if (!trigger) return;
  trigger.title = t('avatar.change');
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isAvatarPickerOpenFor(trigger)) { closeAvatarPicker(); return; }
    const commanderIcon = (typeof COMMANDER_DEFAULT !== 'undefined' && COMMANDER_DEFAULT?.icon) || 'crown';
    const cur = isCommander
      ? { icon: commanderIcon, color: agent.color }
      : { icon: agent.icon, color: agent.color };
    const pickerOpts = isCommander
      ? { allowCommanderCombo: true, hideIcons: true, colorLabelKey: 'avatar.background_label' }
      : {};
    openAvatarPicker(trigger, cur, pickerOpts, async (next) => {
      // Optimistic in-place update — keeps the trigger element (and its
      // click handler) intact so the picker stays interactive.
      const nextIcon = isCommander ? commanderIcon : next.icon;
      agent.icon = nextIcon;
      agent.color = next.color;
      applyAvatarToElement(trigger, nextIcon, next.color, agent.agent_id);
      try {
        if (isCommander) {
          const res = await window.cogseed.invoke('prefs.setCommanderAvatar', { icon: nextIcon, color: next.color });
          if (res?.ok && res.avatar) {
            _commanderAgentAvatar = { icon: nextIcon, color: res.avatar.color };
            if (typeof setCommanderAvatarCache === 'function') setCommanderAvatarCache({ icon: nextIcon, color: res.avatar.color });
            if (_agentsCache) renderAgentsList(_agentsCache);
            if (typeof renderConversationList === 'function') renderConversationList();
            if (typeof renderProjectsSection === 'function') renderProjectsSection();
          }
        } else {
          const res = await window.cogseed.invoke('agents.update', {
            agent_id: agent.agent_id,
            updates: { icon: next.icon, color: next.color },
          });
          if (res?.ok && res.agent) {
            const cached = _agentsCache?.find((a) => a.agent_id === agent.agent_id);
            if (cached) { cached.icon = next.icon; cached.color = next.color; }
            if (_agentsCache) renderAgentsList(_agentsCache);
          }
        }
      } catch (err) {
        _agentsLog.warn(isCommander ? 'prefs.setCommanderAvatar failed' : 'agents.update avatar failed', err);
      }
    });
  });
}

/** Per-agent enable / disable button in the detail header.
 *  Clone-replace to drop any prior click handler bound to a stale
 *  agent id. The button label flips between "enable" and "disable"
 *  (whichever the click would do). */
function _renderAgentEnabledButton(agent) {
  const oldBtn = document.getElementById('agent-enabled-btn');
  if (!oldBtn) return;
  const enabled = agent.enabled !== false;
  const btn = oldBtn.cloneNode(true);
  oldBtn.parentNode.replaceChild(btn, oldBtn);
  btn.disabled = false;
  btn.textContent = enabled ? t('component.disable') : t('component.enable');
  btn.title = enabled ? t('component.toggle_disable_hint') : t('component.toggle_enable_hint');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await _flipAgentEnabled(agent.id, !enabled); }
    finally { btn.disabled = false; }
  });
}


function _toggleAgentFieldEditable(on) {
  const nameEl = document.getElementById('agents-detail-name');
  const nameInput = document.getElementById('agents-detail-name-input');
  const descEl = document.getElementById('agents-detail-desc');
  const workflowEl = document.getElementById('agents-detail-workflow');
  if (nameEl) {
    nameEl.setAttribute('contenteditable', 'false');
    nameEl.classList.remove('is-editing');
    nameEl.hidden = !!on;
  }
  if (nameInput) {
    nameInput.hidden = !on;
    nameInput.classList.toggle('is-editing', on);
    nameInput.readOnly = !on;
    nameInput.setAttribute('aria-label', t('agent_modal.name'));
  }
  for (const el of [descEl, workflowEl]) {
    if (!el) continue;
    el.setAttribute('contenteditable', on ? 'plaintext-only' : 'false');
    el.classList.toggle('is-editing', on);
  }
}

async function toggleAgentEditMode() {
  if (!_selectedAgent) return;
  if (_isAgentProfileMock(_selectedAgent.id)) return;
  if (_agentEditing) {
    await _exitAgentEditMode();
  } else {
    await _enterAgentEditMode();
  }
}

async function _enterAgentEditMode() {
  _agentEditing = true;
  if (_isCommanderAgent(_selectedAgent?.id)) {
    await _renderCommanderAgentDetail(true);
    const chatCol = document.getElementById('agents-chat-col');
    if (chatCol) chatCol.style.display = 'none';
    return;
  }
  // Re-fetch to show raw workflow (not rendered markdown) for editing.
  const res = await apiFetch(`/api/agents/${encodeURIComponent(_selectedAgent.id)}`);
  const data = await res.json();
  const agent = data.ok && data.agent ? { ...data.agent, source: _agentSource(data.agent.source) } : null;
  if (!agent) {
    _agentEditing = false;
    return;
  }
  if (!_canEnterAgentEditMode(agent)) {
    _agentEditing = false;
    return;
  }
  _renderAgentDetail(agent, true);
  // External agents have no LLM-driven authoring. Marketplace installs in
  // the open-source build are memory-only edits. Both hide the edit chat.
  const isExternal = !!(agent.runtime?.kind === 'cli' || agent.runtime?.kind === 'p3394-gateway');
  const isMemoryOnly = !_canEditAgentDefinition(agent) && _canEditAgentMemory(agent);
  const chatCol = document.getElementById('agents-chat-col');
  if (chatCol) chatCol.style.display = (isExternal || isMemoryOnly) ? 'none' : '';
  if (!isExternal && !isMemoryOnly) {
    await _loadAgentChatHistory(_selectedAgent.id);
    setTimeout(() => document.getElementById('agents-chat-input')?.focus(), 50);
  } else if (isExternal) {
    setTimeout(() => document.getElementById('agents-detail-name-input')?.focus(), 50);
  }
  // Wire field blur-save (one-time attach)
  _bindAgentFieldSave();
}

async function _exitAgentEditMode() {
  _agentEditing = false;
  // Abort any in-flight reply so the "done" button stops the stream immediately. The
  // agent chat controller is a singleton; leaving it pending also leaks the
  // streaming-button state into the next agent's edit panel.
  try { _agentChatCtrl?.abort(); } catch (_) { /* ignore */ }
  if (_isCommanderAgent(_selectedAgent?.id)) {
    clearTimeout(_agentFieldSaveTimer);
    _agentFieldSaveTimer = null;
    _pendingAgentField = null;
    document.getElementById('agents-chat-col').style.display = 'none';
    await _renderCommanderAgentDetail(false);
    await loadAgents(true);
    return;
  }
  // Flush any pending save and then re-render in readonly mode.
  // The Done button is the explicit commit point — validate name here so
  // a bad value alerts + reverts rather than silently lingering.
  await _flushAgentFieldSave({ validate: true });
  document.getElementById('agents-chat-col').style.display = 'none';
  const aid = _selectedAgent?.id;
  if (aid) {
    const res = await apiFetch(`/api/agents/${encodeURIComponent(aid)}`);
    const data = await res.json();
    if (data.ok && data.agent) _renderAgentDetail(data.agent, false);
  }
  await loadAgents(true);
}

function _bindAgentFieldSave() {
  const fields = [
    ['agents-detail-name-input', 'name', (el) => el.value],
    ['agents-detail-desc', 'description', (el) => el.innerText],
    ['agents-detail-workflow', 'workflow', (el) => el.innerText],
  ];
  for (const [id, field, readValue] of fields) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.dataset.bound === '1') continue;
    el.dataset.bound = '1';
    if (field === 'name' && typeof window.bindNameLimitControl === 'function') window.bindNameLimitControl(el);
    el.addEventListener('input', () => _scheduleAgentFieldSave(field, readValue(el)));
    el.addEventListener('blur', () => _flushAgentFieldSave());
  }
}

function _restoreAgentNameField() {
  const next = _selectedAgent?.name || '';
  const nameEl = document.getElementById('agents-detail-name');
  const nameInput = document.getElementById('agents-detail-name-input');
  if (nameEl) nameEl.textContent = next;
  if (nameInput) nameInput.value = next;
}

function _scheduleAgentFieldSave(field, value) {
  if (!_selectedAgent) return;
  if (_isAgentPlatformSource(_selectedAgent.source)) return;
  _pendingAgentField = { field, value };
  clearTimeout(_agentFieldSaveTimer);
  _agentFieldSaveTimer = setTimeout(_flushAgentFieldSave, 800);
}

let _pendingAgentField = null;
// `validate` is only true when the user explicitly commits (clicks "done" →
// `_exitAgentEditMode`). Typing-debounced and blur-triggered flushes pass
// false: a bad name silently skips the save (the DOM keeps the user's
// in-progress text) instead of popping a uiAlert mid-keystroke.
async function _flushAgentFieldSave({ validate = false } = {}) {
  clearTimeout(_agentFieldSaveTimer);
  _agentFieldSaveTimer = null;
  if (!_pendingAgentField || !_selectedAgent) return;
  const { field, value } = _pendingAgentField;
  if (field === 'name') {
    const blank = !String(value || '').trim();
    const hasWhitespace = /\s/.test(String(value || ''));
    const reserved = !hasWhitespace && _isReservedAgentName(value);
    const invalid = hasWhitespace || (!reserved && !_isValidAgentNameCharset(value));
    if (blank || reserved || invalid) {
      if (!validate) return;
      _pendingAgentField = null;
      await uiAlert(t(reserved ? 'agents.name_reserved' : 'agents.name_invalid'));
      _restoreAgentNameField();
      return;
    }
  }
  _pendingAgentField = null;
  try {
    const body = { [field]: value };
    const res = await apiFetch(`/api/agents/${encodeURIComponent(_selectedAgent.id)}/update`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      // Surface duplicate-name / reserved-name with their localised messages
      // instead of the raw English server text.
      const localised = _agentCreateErrorMessage(data);
      throw new Error(localised || data.error || 'save failed');
    }
    if (field === 'name') {
      const nextName = data.agent?.name || String(value || '').trim();
      _selectedAgent = { ..._selectedAgent, name: nextName };
      const nameEl = document.getElementById('agents-detail-name');
      const nameInput = document.getElementById('agents-detail-name-input');
      if (nameEl) nameEl.textContent = nextName;
      if (nameInput) nameInput.value = nextName;
    }
    // Eagerly refresh — name changes feed the chat-bubble @-mention regex
    // (`_buildMentionRe` reads `_agentsCache`); leaving the cache null until
    // the next picker open means freshly-typed `@<multi-word-name>` only
    // gets the fallback char class, which stops at the first whitespace.
    await loadAgents(true);
    // Repaint the input-box recipient chip if it's bound to this agent —
    // its `name` field is a localStorage snapshot taken at picker time, so
    // without an explicit re-render the chip keeps showing the old name
    // until the next view switch.
    if (field === 'name' && typeof _renderRecipientChip === 'function') {
      try { _renderRecipientChip(); } catch (_) { /* non-fatal */ }
    }
  } catch (e) {
    _agentsLog.warn('save agent field failed', e);
    if (field === 'name') {
      await uiAlert(e.message || t('agents.create_failed'));
      _restoreAgentNameField();
    }
  }
}

// ─── Create agent (modal-first, two tabs: Create / External) ───
//
// "Create" (default tab) — manual authoring of an in-process agent.
// The LLM-driven edit chat opens immediately on save so the workflow
// can be refined.
//
// "External" — bind a local CLI as the runtime. The CLI selector sits
// at the top (default "not selected"); selecting a CLI auto-fills
// name + description from
// CLI_DEFAULTS. The user can override either; subsequent CLI swaps
// only re-fill fields that still match the previous CLI's defaults
// (so a user-edited value is never clobbered).
//
// Track the last-applied CLI defaults so that "switch CLI → fields
// follow" can detect "did the user touch this field?". `null` =
// nothing applied yet (untouched-default state, or the "create" tab).

function _switchAgentTab(tab) {
  const tabs = document.querySelectorAll('#agent-modal-tabs [data-agent-tab]');
  tabs.forEach((el) => el.classList.toggle('is-active', el.dataset.agentTab === tab));
  const panels = document.querySelectorAll('#agent-modal [data-agent-panel]');
  panels.forEach((el) => el.classList.toggle('is-active', el.dataset.agentPanel === tab));
  const msgEl = document.getElementById('agent-form-msg');
  if (msgEl) { msgEl.textContent = ''; msgEl.className = 'form-msg'; }
  // 每次切到「外接」tab 都重新扫描并展示「正在扫描本机 CLI…」。之前
  // 扫描只发生在打开弹窗时一次，用户切换 tab 看到的总是早已就绪的
  // 结果 → 感知上像「没有扫描」。移到这里后，进入外接面板必然先短暂
  // 显示扫描态，再呈现真实探测结果。
  if (tab === 'external') {
    _refreshExternalCliSelector();
  }
  setTimeout(() => {
    const focusId = tab === 'external' ? 'agent-modal-ext-cli-select' : 'agent-name-input';
    const el = document.getElementById(focusId);
    // ai-select wrapper isn't focusable directly; just leave it alone.
    if (el && typeof el.focus === 'function' && el.tagName !== 'DIV') el.focus();
  }, 30);
}
window._switchAgentTab = _switchAgentTab;

/** 挂载 / 刷新「外接」tab 的 CLI 选择器：先清空 provider 选择，再以
 *  force 重扫（mountExternalCliSelect 内部会短暂显示「正在扫描本机
 *  CLI…」再替换为最终列表）。每次进入外接面板都会执行，让用户能亲
 *  眼看到本机探测正在发生，而不是直接拿到上次的缓存结果。 */
function _refreshExternalCliSelector() {
  _externalCliProviderSelect?.setValue('');
  const providerLoad = _loadExternalCliProviders().catch(() => []);
  if (typeof mountExternalCliSelect === 'function') {
    mountExternalCliSelect((cli) => {
      _applyExternalCliDefaults(cli);
      providerLoad.then(() => _renderExternalCliProviderSelect(cli, _getExternalCliProviderValue(cli)));
    }).catch(() => {});
  }
  if (typeof _renderExternalPanelPeers === 'function') {
    void _renderExternalPanelPeers();
  }
}

/** 「外接」tab 的「已接入节点」管理区：展示统一注册表快照（全部已注册
 *  P3394 节点，含自研网关/远端 peer），提供 移除（revoke：清注册表+投影
 *  +停托管网关）与 停用/启用（disable/enable）。数据来自与 CLI 选择器
 *  同一次 p3394.external.list 往返的 peers 快照（不额外拉 IPC）。 */
async function _renderExternalPanelPeers() {
  const slot = document.getElementById('agent-ext-peers');
  if (!slot) return;
  let peers = [];
  try {
    // 共享本次 tab 进入时的探测结果（_refreshExternalCliSelector 已用
    // force 重扫过一次，且 loadExternalPanelData 内部有 in-flight 去重），
    // 这里不再单独 force——否则每次点击节点操作后的整表单重渲染都会
    // 再跑一遍完整 detectAll。节点增删后缓存已被 revoke/toggle 置空，
    // 下一次渲染自然重探。
    const data = (typeof loadExternalPanelData === 'function')
      ? await loadExternalPanelData()
      : null;
    peers = Array.isArray(data && data.peers) ? data.peers : [];
  } catch (err) {
    _agentsLog.warn('p3394 peers load failed', err);
  }
  // 本机 CogSeed 自身不当作"已接入节点"展示。
  const visible = peers.filter((p) => p && p.agent_id && p.agent_id !== 'cogseed');
  const msgEl = document.getElementById('agent-form-msg');
  if (!visible.length) {
    slot.innerHTML = `<div class="agents-ext-peers-empty">${escapeHtml(t('agents.peers.none'))}</div>`;
    return;
  }
  const kindLabel = t('agents.peers.kind');
  const capLabel = t('agents.peers.capabilities');
  slot.innerHTML = visible.map((peer) => {
    const agentId = peer.agent_id;
    const name = peer.display_name || agentId;
    const online = !!peer.online;
    const disabled = !!peer.disabled;
    const stateText = disabled
      ? t('agents.peers.state_disabled')
      : (online ? t('agents.peers.state_online') : t('agents.peers.state_offline'));
    const kind = peer.node_kind ? escapeHtml(String(peer.node_kind)) : 'agent';
    const capCount = Array.isArray(peer.capabilities) ? peer.capabilities.length : 0;
    const loc = peer.locality ? escapeHtml(String(peer.locality)) : '';
    const metaPieces = [];
    if (loc) metaPieces.push(loc);
    if (capCount > 0) metaPieces.push(`${capCount} ${escapeHtml(capLabel)}`);
    const meta = metaPieces.length ? `<span class="agents-ext-peers-meta">${metaPieces.join(' · ')}</span>` : '';
    const toggleLabel = disabled
      ? t('agents.peers.action_enable')
      : t('agents.peers.action_disable');
    return `
      <div class="agents-ext-peer-row ${disabled ? 'is-disabled' : ''}">
        <span class="agents-detail-gateway-dot ${disabled || !online ? 'is-off' : 'is-on'}"></span>
        <span class="agents-ext-peer-name" title="${escapeHtml(String(agentId))}">${escapeHtml(name)}</span>
        <span class="agents-ext-peer-state">${escapeHtml(stateText)}</span>
        <span class="agents-ext-peer-kind" title="${escapeHtml(kindLabel)}">${kind}</span>
        ${meta}
        <span class="agents-ext-peer-actions">
          <button type="button" class="btn btn-sm" data-peer-act="toggle" data-peer-id="${escapeHtml(String(agentId))}" data-peer-disabled="${disabled ? '1' : '0'}">${escapeHtml(toggleLabel)}</button>
          <button type="button" class="btn btn-sm is-danger" data-peer-act="revoke" data-peer-id="${escapeHtml(String(agentId))}">${escapeHtml(t('agents.peers.action_remove'))}</button>
        </span>
      </div>`;
  }).join('');

  slot.querySelectorAll('[data-peer-act]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const agentId = btn.dataset.peerId;
      const act = btn.dataset.peerAct;
      if (!agentId) return;
      btn.disabled = true;
      const setMsg = (text, isSuccess) => {
        if (!msgEl) return;
        msgEl.textContent = text;
        msgEl.className = isSuccess ? 'form-msg ok' : 'form-msg err';
      };
      try {
        if (act === 'revoke') {
          const ok = typeof uiConfirm === 'function'
            ? await uiConfirm(t('agents.peers.remove_confirm', { name: agentId }))
            : true;
          if (!ok) { btn.disabled = false; return; }
          const res = (typeof revokeP3394Peer === 'function') ? await revokeP3394Peer(agentId) : null;
          if (res && res.ok) setMsg(t('agents.peers.removed', { name: agentId }), true);
          else setMsg((res && res.error) || t('agents.peers.action_failed'), false);
        } else {
          const nextDisabled = btn.dataset.peerDisabled === '1' ? false : true;
          const res = (typeof toggleP3394Peer === 'function') ? await toggleP3394Peer(agentId, nextDisabled) : null;
          if (res && res.ok) setMsg(t('agents.peers.toggled', { name: agentId }), true);
          else setMsg((res && res.error) || t('agents.peers.action_failed'), false);
        }
      } catch (err) {
        _agentsLog.warn('p3394 peer action failed', { agentId, act, error: err && (err.message || err) });
        setMsg((err && err.message) || t('agents.peers.action_failed'), false);
      }
      btn.disabled = false;
      void _renderExternalPanelPeers();
    });
  });
}

// Track which CLI defaults are currently reflected in the External-tab
// inputs. When a user types over a default, the field key drops out of
// this set so subsequent CLI swaps don't overwrite the typed value.
let _extActiveCli = null;
let _extDefaultFieldsAtMount = { name: false, desc: false };

/** Decide whether a current `name` value still counts as "the default
 *  for `defaultName`" — meaning a CLI swap should overwrite it. We
 *  recognise the bare default plus the dedup-style suffixes a user
 *  is likely to add when fighting the name-taken error: "ClaudeCode",
 *  "ClaudeCode2", "ClaudeCode-2", "ClaudeCode(2)", etc. Anything
 *  with non-digit text after the default ("ClaudeCodePro") counts as
 *  user-edited and is kept. */
function _isDefaultlikeName(value, defaultName) {
  if (!value) return true;
  if (!defaultName) return false;
  if (value === defaultName) return true;
  const escaped = defaultName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + escaped + '\\s*(?:[-_]\\s*)?(?:\\(\\s*\\d+\\s*\\)|\\d+)$');
  return re.test(value);
}

function _applyExternalCliDefaults(cliType, { force = false } = {}) {
  const defaults = (typeof getCliDefaults === 'function') ? getCliDefaults(cliType) : null;
  const nameEl = document.getElementById('agent-ext-name-input');
  const descEl = document.getElementById('agent-ext-desc-input');
  if (!nameEl || !descEl) return;

  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  const localizedDesc = defaults ? pickDesc(defaults, lang) : '';
  const targetName = defaults ? defaults.name : '';
  const targetDesc = localizedDesc;

  // Decide per field whether to overwrite. The two checks are independent —
  // a user who edits the name but leaves the description alone keeps their
  // name and gets a refreshed description. "Default-like name" also covers
  // dedup suffixes like "ClaudeCode2" (added to dodge name-taken errors).
  const prev = (typeof getCliDefaults === 'function') ? getCliDefaults(_extActiveCli) : null;
  const prevDescLocalized = prev ? pickDesc(prev, lang) : '';

  const nameUntouched = force || _isDefaultlikeName(nameEl.value, prev?.name);
  const descUntouched = force
    || descEl.value === ''
    || (prev && descEl.value === prevDescLocalized);

  if (cliType === null) {
    // Reverted to "not selected" — only clear fields that still hold
    // the previous CLI's defaults. Keep user-typed text.
    if (nameUntouched) nameEl.value = '';
    if (descUntouched) descEl.value = '';
  } else {
    if (nameUntouched) nameEl.value = targetName;
    if (descUntouched) descEl.value = targetDesc;
  }
  _extActiveCli = cliType;
}

function openAgentModal(options = {}) {
  const requestedTab = typeof options === 'string' ? options : options?.initialTab;
  const initialTab = requestedTab === 'external' ? 'external' : 'create';
  const modal = document.getElementById('agent-modal');
  const msgEl = document.getElementById('agent-form-msg');
  msgEl.textContent = '';
  msgEl.className = 'form-msg';

  // Reset both panels' inputs.
  const nameInput = document.getElementById('agent-name-input');
  const descInput = document.getElementById('agent-desc-input');
  const extName = document.getElementById('agent-ext-name-input');
  const extDesc = document.getElementById('agent-ext-desc-input');
  if (nameInput) nameInput.value = '';
  if (descInput) descInput.value = '';
  if (extName) extName.value = '';
  if (extDesc) extDesc.value = '';
  _extActiveCli = null;
  _extDefaultFieldsAtMount = { name: true, desc: true };
  if (typeof window.bindNameLimitControl === 'function') {
    window.bindNameLimitControl(nameInput);
    window.bindNameLimitControl(extName);
  }

  // Wire tabs (idempotent).
  const tabBar = document.getElementById('agent-modal-tabs');
  if (tabBar && !tabBar.dataset.wired) {
    tabBar.querySelectorAll('[data-agent-tab]').forEach((btn) => {
      btn.addEventListener('click', () => _switchAgentTab(btn.dataset.agentTab));
    });
    tabBar.dataset.wired = '1';
  }
  _switchAgentTab(initialTab);

  modal.classList.add('open');
  const focusId = initialTab === 'external' ? 'agent-ext-name-input' : 'agent-name-input';
  setTimeout(() => document.getElementById(focusId)?.focus(), 50);
}
window.openAgentModal = openAgentModal;

function closeAgentModal() {
  document.getElementById('agent-modal').classList.remove('open');
}
window.closeAgentModal = closeAgentModal;

async function saveAgentModal() {
  const msgEl = document.getElementById('agent-form-msg');
  const activeTab = document.querySelector('#agent-modal-tabs .is-active')?.dataset.agentTab || 'create';
  if (activeTab === 'external') return _saveExternalAgent({ msgEl });
  return _saveCreateAgent({ msgEl });
}
window.saveAgentModal = saveAgentModal;

async function _saveCreateAgent({ msgEl }) {
  const rawName = document.getElementById('agent-name-input').value;
  const name = rawName.trim();
  const description = document.getElementById('agent-desc-input').value.trim();

  if (!name) {
    msgEl.textContent = t('agents.input_name_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-name-input').focus();
    return;
  }
  const hasWhitespace = /\s/.test(rawName);
  const reserved = !hasWhitespace && _isReservedAgentName(name);
  if (hasWhitespace || (!reserved && !_isValidAgentNameCharset(rawName))) {
    msgEl.textContent = t('agents.name_invalid');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-name-input').focus();
    return;
  }
  if (reserved) {
    msgEl.textContent = t('agents.name_reserved');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-name-input').focus();
    return;
  }
  if (!description) {
    msgEl.textContent = t('agents.input_desc_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-desc-input').focus();
    return;
  }

  const outputFormat = 'auto';

  const startedAt = performance.now();
  if (window.Monitor) (() => {})('agent_create_submit', { agent_type: 'default', output_format: outputFormat });
  try {
    // Leave the icon unset so the immediately-started agent authoring model
    // can choose semantically from the controlled catalog. The renderer's
    // legacy seed fallback covers the brief pre-authoring state.
    const body = { name, description, category: 'general' };
    const res = await apiFetch('/api/agents/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok || !data.agent) {
      msgEl.textContent = _agentCreateErrorMessage(data) || t('agents.create_failed');
      msgEl.className = 'form-msg err';
      if (window.Monitor) {
        (() => {})('agent_create_result', {
          result: 'failure',
          agent_type: 'default',
          output_format: outputFormat,
          duration_ms: Math.round(performance.now() - startedAt),
          error_code: data.code || '',
        });
        (() => {})('agent_create', {
          agent_type: 'default',
          output_format: outputFormat,
          error_type: 'api',
          error_code: data.code || '',
          error_message: data.error || 'unknown',
        });
      }
      return;
    }
    if (window.Monitor) (() => {})('agent_create_result', {
      result: 'success',
      agent_id: data.agent.agent_id,
      agent_type: 'default',
      output_format: outputFormat,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    closeAgentModal();
    setView('agents');
    await loadAgents(true);
    await _showAgentsDetailView(data.agent.agent_id);
    await _enterAgentEditMode();
    const seed = t('agents.seed_workflow_model', { name, description });
    await _autoSendAgentChat(t('agents.seed_workflow'), { model_text: seed });
  } catch (e) {
    msgEl.textContent = t('agents.network_error', { reason: e.message || e });
    msgEl.className = 'form-msg err';
    if (window.Monitor) {
      (() => {})('agent_create_result', {
        result: 'failure',
        agent_type: 'default',
        output_format: outputFormat,
        duration_ms: Math.round(performance.now() - startedAt),
      });
      (() => {})('agent_create', {
        agent_type: 'default',
        output_format: outputFormat,
        error_type: 'network',
        error_message: e.message || String(e),
      });
    }
  }
}

async function _saveExternalAgent({ msgEl }) {
  const cli = (typeof getExternalCliValue === 'function') ? getExternalCliValue() : null;
  const rawName = document.getElementById('agent-ext-name-input').value;
  const name = rawName.trim();
  const desc = document.getElementById('agent-ext-desc-input').value.trim();

  if (!cli) {
    msgEl.textContent = t('agents.ext_cli_needed');
    msgEl.className = 'form-msg err';
    return;
  }
  if (!name) {
    msgEl.textContent = t('agents.input_name_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-ext-name-input').focus();
    return;
  }
  const hasWhitespace = /\s/.test(rawName);
  const reserved = !hasWhitespace && _isReservedAgentName(name);
  if (hasWhitespace || (!reserved && !_isValidAgentNameCharset(rawName))) {
    msgEl.textContent = t('agents.name_invalid');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-ext-name-input').focus();
    return;
  }
  if (reserved) {
    msgEl.textContent = t('agents.name_reserved');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-ext-name-input').focus();
    return;
  }
  if (!desc) {
    msgEl.textContent = t('agents.input_desc_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-ext-desc-input').focus();
    return;
  }

  const startedAt = performance.now();
  if (window.Monitor) (() => {})('agent_create_submit', { agent_type: 'p3394', cli });
  // P3394 方式外接：先创建智能体记录，再拉起该 CLI 的受管 P3394 网关。
  // 顺序不能反：先起网关会立即收到 hello → 自动投影用默认名抢先创建，
  // 用户命名的同名智能体反而被 "已占用" 拒绝（时序竞态，曾产生双卡）。
  // 先建记录后，投影的 existing_agent 分支会复用本记录，不再重复创建。
  try {
    const entries = await window.loadLocalCliEntries({ force: true });
    const detected = entries.find((e) => e && e.type === cli);
    const body = {
      name,
      description: desc,
      // P3394 外接智能体：每一轮对话都通过桥与受管网关节点协作。
      icon: 'code', color: 'sage',
      runtime: { kind: 'p3394-gateway', cli },
      category: 'general',
    };
    const res = await apiFetch('/api/agents/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok || !data.agent) {
      msgEl.textContent = _agentCreateErrorMessage(data) || t('agents.create_failed');
      msgEl.className = 'form-msg err';
      if (window.Monitor) {
        (() => {})('agent_create_result', {
          result: 'failure',
          agent_type: 'cli',
          cli,
          duration_ms: Math.round(performance.now() - startedAt),
          error_code: data.code || '',
        });
        (() => {})('agent_create', {
          agent_type: 'cli',
          cli,
          error_type: 'api',
          error_code: data.code || '',
          error_message: data.error || 'unknown',
        });
      }
      return;
    }
    const agentId = data.agent.agent_id;
    // 记录已创建，再启动网关。网关 hello 触发自动投影时会复用上面的
    // 记录（team-projection 的 existing_agent 分支），不会重复创建默认名。
    let started;
    try {
      started = await window.cogseed.invoke('p3394.external.start', {
        cli,
        alias: name,
        ...(detected && detected.path ? { binPath: detected.path } : {}),
      });
    } catch (startErr) {
      // 网关启动调用本身抛异常：回滚刚创建的记录，避免留下半成品。
      try { await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' }); } catch { /* best effort */ }
      msgEl.textContent = t('agents.network_error', { reason: startErr.message || startErr });
      msgEl.className = 'form-msg err';
      if (window.Monitor) {
        (() => {})('agent_create_result', {
          result: 'failure',
          agent_type: 'p3394',
          cli,
          duration_ms: Math.round(performance.now() - startedAt),
        });
      }
      return;
    }
    if (!started || !started.ok) {
      // 网关启动失败（脚本缺失 / 注册超时等）：回滚刚创建的记录。投影
      // 映射可能残留指向已删除记录（已有投射记录时节点 hello 不再重建
      // 卡片），属低频边界，后续可清理投影文件恢复。
      try { await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' }); } catch { /* best effort */ }
      msgEl.textContent = t('agents.p3394_gateway_start_failed', {
        reason: (started && started.error) || 'unknown',
      });
      msgEl.className = 'form-msg err';
      if (window.Monitor) {
        (() => {})('agent_create_result', {
          result: 'failure',
          agent_type: 'p3394',
          cli,
          duration_ms: Math.round(performance.now() - startedAt),
          error_code: (started && started.error) || '',
        });
      }
      return;
    }
    if (window.Monitor) (() => {})('agent_create_result', {
      result: 'success',
      agent_id: agentId,
      agent_type: 'p3394',
      cli,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    closeAgentModal();
    setView('agents');
    await loadAgents(true);
    // External agents go straight to the detail view but skip the LLM
    // edit-chat — there's nothing to author. The user can still rename
    // or reword the description through the inline name/desc editors.
    await _showAgentsDetailView(agentId);
  } catch (e) {
    msgEl.textContent = t('agents.network_error', { reason: e.message || e });
    msgEl.className = 'form-msg err';
    if (window.Monitor) {
      (() => {})('agent_create_result', {
        result: 'failure',
        agent_type: 'p3394',
        cli,
        duration_ms: Math.round(performance.now() - startedAt),
      });
      (() => {})('agent_create', {
        agent_type: 'p3394',
        cli,
        error_type: 'network',
        error_message: e.message || String(e),
      });
    }
  }
}

/** Normalise IPC-shim error replies into a user-facing message. The
 *  backend tags duplicate-name / reserved-name failures with a `code`
 *  so we surface the localised string instead of the raw "agent name
 *  ... is already in use" English text. */
function _agentCreateErrorMessage(data) {
  if (!data) return '';
  const code = data.code;
  if (code === 'E_AGENT_NAME_TAKEN') return t('agents.name_taken');
  if (code === 'E_AGENT_NAME_RESERVED') return t('agents.name_reserved');
  if (code === 'E_AGENT_NAME_INVALID') return t('agents.name_invalid');
  if (code === 'E_AGENT_NAME_TOO_LONG') return t('agents.name_too_long');
  return data.error || '';
}

async function _autoSendAgentChat(content, extraBody) {
  if (!_selectedAgent) return;
  const container = document.getElementById('agents-chat-messages');
  if (!container) return;
  // Only auto-seed when the chat is empty (fresh agent).
  const existing = container.querySelectorAll('.chat-message');
  if (existing.length > 0) return;
  _ensureAgentChatController();
  await _agentChatCtrl.send(content, extraBody);
}

async function deleteSelectedAgent() {
  if (!_selectedAgent) return;
  if (_isCommanderAgent(_selectedAgent.id)) return;
  if (_isAgentProfileMock(_selectedAgent.id)) return;
  const isMarketplace = _isAgentPlatformSource(_selectedAgent.source);
  if (isMarketplace && !false) return;
  const agentId = _selectedAgent.id;
  if (!(await uiConfirm(t('agents.delete_confirm', { name: _selectedAgent.name || agentId })))) return;
  if (window.Monitor) (() => {})('agent_delete', { agent_id: agentId });
  try {
    const data = isMarketplace
      ? await window.cogseed.invoke('agents.builtin.delete', { agent_id: agentId })
      : await (await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' })).json();
    if (!data.ok) throw new Error(data.error || t('agents.delete_failed'));
    _selectedAgent = null; _agentEditing = false;
    document.getElementById('agents-chat-col').style.display = 'none';
    document.getElementById('agents-detail-content').style.display = 'none';
    _showAgentsGridView();
    await loadAgents(true);
    await loadConversations();
  } catch (e) {
    await uiAlert(t('agents.delete_failed_with', { reason: e.message || e }));
  }
}

// ─── Agent inline edit chat ───

let _agentChatCtrl = null;
let _agentEditAttachmentsBound = false;

function _agentEditAttachmentCid(agentId) {
  return agentId ? `agent-edit-${agentId}` : '';
}

function _bindAgentEditAttachments() {
  if (_agentEditAttachmentsBound) return;
  _agentEditAttachmentsBound = true;
  const btn = document.getElementById('agents-chat-attach-btn');
  const area = document.querySelector('.agents-chat-input-area');
  const input = document.getElementById('agents-chat-input');
  const currentCid = () => _agentEditAttachmentCid(_selectedAgent?.id || '');
  if (btn) {
    btn.addEventListener('click', async () => {
      const cid = currentCid();
      if (cid) await _chatAttachPickAndUpload(cid, 'picker');
    });
  }
  if (area) {
    area.addEventListener('dragover', (e) => {
      const hasFiles = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length;
      const hasInternal = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(COGSEED_FILE_DRAG_MIME);
      if (!hasFiles && !hasInternal) return;
      e.preventDefault();
      area.classList.add('drag-over');
    });
    area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
    area.addEventListener('drop', async (e) => {
      const cid = currentCid();
      if (!cid) return;
      const internal = _chatAttachInternalDragItems(e.dataTransfer);
      if (internal.length) {
        e.preventDefault();
        area.classList.remove('drag-over');
        await _chatAttachImportPaths(cid, internal, 'internal_drop');
        return;
      }
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault();
        area.classList.remove('drag-over');
        await _chatAttachUpload(cid, e.dataTransfer.files, 'drop');
      }
    });
  }
  if (input) {
    input.addEventListener('paste', async (e) => {
      if (!e.clipboardData || !e.clipboardData.files || !e.clipboardData.files.length) return;
      const cid = currentCid();
      if (!cid) return;
      e.preventDefault();
      await _chatAttachUpload(cid, e.clipboardData.files, 'paste');
    });
  }
}

async function _buildAgentEditChatExtraBody(_content, agentId, state) {
  const cid = _agentEditAttachmentCid(agentId);
  const items = _chatAttachList(cid);
  if (!items.length) return undefined;
  if (items.some((a) => a.status === 'uploading')) {
    await uiAlert(t('chat.attach_still_uploading'));
    return null;
  }
  const attachments = items.filter((a) => a.status !== 'error').map((a) => a.name);
  if (!attachments.length) return undefined;
  if (state && (state.pending || state.hasQueue)) {
    await uiAlert(t('chat.attach_queue_blocked'));
    return null;
  }
  _chatAttachClear(cid);
  return { attachments, attachment_cid: cid };
}

function _ensureAgentChatController() {
  if (_agentChatCtrl) return _agentChatCtrl;
  _bindAgentEditAttachments();
  _agentChatCtrl = createChatController({
    historyEl: 'agents-chat-messages',
    inputEl: 'agents-chat-input',
    sendBtnEl: 'agents-chat-send-btn',
    getCurrentId: () => _selectedAgent?.id || null,
    historyEndpoint: (id) => `/api/agents/${encodeURIComponent(id)}/chat`,
    streamEndpoint: (id) => `/api/agents/${encodeURIComponent(id)}/chat/send/stream`,
    clearEndpoint: (id) => `/api/agents/${encodeURIComponent(id)}/chat`,
    features: { archive: false, scrollPin: true, queue: true },
    queue: {
      keyPrefix: 'agent',
      panelId: 'agents-chat-queue',
      listId: 'agents-chat-queue-list',
      countId: 'agents-chat-queue-count',
    },
    hooks: {
      buildExtraBody: _buildAgentEditChatExtraBody,
      async onFinal(ev, msgEl, id) {
        // Agent edit chat may have rewritten name / description / workflow;
        // the `updated` object on the final event carries the diff.
        if (ev.updated && Object.keys(ev.updated).length) {
          try {
            const freshRes = await apiFetch(`/api/agents/${encodeURIComponent(id)}`);
            const freshData = await freshRes.json();
            if (freshData.ok && freshData.agent && _selectedAgent?.id === id) {
              _selectedAgent.name = freshData.agent.name;
              _renderAgentDetail(freshData.agent, true);
              _agentsCache = null;
              await loadAgents(true);
              // Repaint the chat input recipient chip in case its bound
              // agent was the one just renamed by the edit chat.
              if (typeof _renderRecipientChip === 'function') {
                try { _renderRecipientChip(); } catch (_) { /* non-fatal */ }
              }
            }
          } catch (e) {
            _agentsLog.warn('refresh after updated fields failed', e);
          }
        }
      },
    },
  });
  return _agentChatCtrl;
}

async function _loadAgentChatHistory(agentId) {
  _ensureAgentChatController();
  await _agentChatCtrl.loadHistory();
  await _chatAttachRefreshFromServer(_agentEditAttachmentCid(agentId));
  // Custom empty-state message for fresh agents — controller's default is
  // "no messages..."; replace it with an agent-specific prompt when empty.
  const container = document.getElementById('agents-chat-messages');
  const empty = container?.querySelector('.empty');
  const defaultEmptyText = t('chat.empty');
  if (empty && (empty.textContent === defaultEmptyText || empty.textContent.includes('无对话记录') || empty.textContent.includes('No messages'))) {
    empty.textContent = t('agents.edit_chat_empty');
  }
}

async function clearAgentChat() {
  if (!_selectedAgent) return;
  if (!(await uiConfirm(t('agents.clear_confirm')))) return;
  _ensureAgentChatController();
  await _agentChatCtrl.clear();
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

// ─── Agent picker (one-shot, works on both new-chat and conversation) ───
// Selecting an agent immediately fires a send with the agent's workflow
// auto-injected on the backend. The selection does NOT persist — the user
// picks an agent each time they need one.

// Place popover above the **input area** (not just the anchor button) so
// it never covers the textarea — the toolbar buttons sit at the bottom of
// the input area, and computing "above" from the button alone meant the
// popover's bottom edge landed on top of the textarea above. We look for
// any chat-input wrapper / area ancestor (main conv, new-chat, skill-edit,
// agent-edit) and use its top as the "above" reference, falling back to
// the anchor's own rect for unrelated anchors.
const _INPUT_AREA_CLASS_RE = /(?:^|\s)(?:chat|new-chat|skills-chat|agents-chat)-input-(?:wrapper|area)(?:\s|$)/;
function _findInputAreaTop(anchorEl) {
  let cur = anchorEl;
  while (cur && cur !== document.body) {
    const cls = cur.className;
    if (typeof cls === 'string' && _INPUT_AREA_CLASS_RE.test(cls)) {
      return cur.getBoundingClientRect().top;
    }
    cur = cur.parentElement;
  }
  return null;
}

function _positionPopoverAboveOrBelow(popover, anchorEl) {
  // Make invisible but laid out so we can measure it before positioning.
  popover.style.display = 'flex';
  popover.style.left = '-9999px';
  popover.style.top = '-9999px';
  popover.style.maxHeight = '';
  const rect = anchorEl.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const margin = 12;
  const gap = 8;
  // Reference top for "above" computation: top of the whole input area
  // when the anchor lives in the chat composer; otherwise the anchor's
  // own top. This keeps the popover from overlapping the textarea on
  // chat panels while still working for any other future anchor.
  const aboveRef = _findInputAreaTop(anchorEl);
  const refTop = aboveRef !== null ? aboveRef : rect.top;
  const availAbove = refTop - margin - gap;
  const availBelow = window.innerHeight - rect.bottom - margin - gap;
  const preferAbove = popRect.height <= availAbove || availAbove >= availBelow;

  let left = rect.left;
  if (left + popRect.width > window.innerWidth - margin) {
    left = window.innerWidth - popRect.width - margin;
  }
  if (left < margin) left = margin;

  let top;
  if (preferAbove) {
    const maxH = Math.max(0, availAbove);
    if (popRect.height > maxH) popover.style.maxHeight = maxH + 'px';
    top = Math.max(margin, refTop - Math.min(popRect.height, maxH) - gap);
  } else {
    const maxH = Math.max(0, availBelow);
    if (popRect.height > maxH) popover.style.maxHeight = maxH + 'px';
    top = rect.bottom + gap;
  }
  popover.style.left = left + 'px';
  popover.style.top = top + 'px';
}

// Expose so skills.js can reuse the same positioning math (DRY across the
// two pickers; behaviour must stay identical so users get consistent UX).
if (typeof window !== 'undefined') {
  window.positionPickerPopover = _positionPopoverAboveOrBelow;
}

// Project scope state for the active picker session: when the anchor's
// active context (commander tab / current conv) belongs to a project, the
// picker collapses to that project's bound agents. `null` = no project
// scope active (orphan conv / no project picked) → unrestricted listing.
// Set on every `_openAgentPicker`; consumed by `_renderAgentPickerList` and
// the search-input change handler so live filtering stays scoped.
let _pickerBoundAgentIds = null;
let _pickerBoundSkillIds = null; // 情境空间一期：同 scope.resolve 的 skills 作用域
let _pickerProjectId = '';
let _pickerScopeSpace = null; // 情境空间一期：当前项目绑定空间摘要
let _pickerLibraryRows = null;
let _pickerLibraryLoading = null;
let _pickerLibraryRenderSeq = 0;
// "本体" tab cache — same lazy-load-once-per-picker-session pattern as
// _pickerLibraryRows above, but scoped to personalOntology.groups.list (no
// project-scoped variant, per §3.7's "only the hidden groups sub-dir" bound).
let _pickerOntologyEntries = null;
let _pickerOntologyLoading = null;
// 本体 tab：被用户收起的分组（parentId 集合）—— 分组标题行可折叠子条目。
// parentId 是 PO contract 给的展示用标识（模板 = templateId），不是 PO 内部 group_id。
let _pickerOntologyCollapsed = new Set();
let _pickerOntologyRenderSeq = 0;
let _agentPickerTab = 'agents';
let _agentPickerOpenSeq = 0;
let _agentPickerLoadedTabs = new Set();
const _agentPickerTabLoads = new Map();
let _pickerProjectContextLoading = false;
let _pickerProjectContextSeq = 0;
// 产物/资产 tab（空间会话 @ 引用）：懒加载缓存（每 picker 会话重置一次）
let _pickerArtifactRows = null;        // 空间产物（spaces.artifacts.list）
let _pickerArtifactTitles = new Map(); // cid → 会话标题（引用 source_title）
let _pickerArtifactLoading = null;
let _pickerArtifactRenderSeq = 0;
let _pickerAssetRows = null;           // 全局沉淀资产（recall.assets.list）
let _pickerAssetLoading = null;
let _pickerAssetRenderSeq = 0;
// 任务引用 chips（composer 引用条）：conversation = 已持久化 task_references；
// new-chat = 待提交 pending（会话创建后写入 task_references）
let _pendingNewChatRefs = [];          // TaskReference[]
const _AGENT_PICKER_TAB_ORDER = ['agents', 'skills', 'artifacts', 'assets'];
const _AGENT_PICKER_TABS = new Set(_AGENT_PICKER_TAB_ORDER);

function _normalizeAgentPickerTab(tab) {
  return _AGENT_PICKER_TABS.has(tab) ? tab : 'agents';
}

/**
 * @ 选择器作用域：锚点所在会话是否绑空间。
 *   - chat-recipient-chip：当前会话（currentCid → conversations 缓存）space_id；
 *   - new-chat-recipient-chip：工作空间 chip 选中的空间（getNewChatSpaceId）；
 *   - auto-recipient-chip / 其余：无空间。
 */
function _agentPickerSpaceId(anchorId) {
  if (anchorId === 'chat-recipient-chip') {
    const cid = (typeof currentCid === 'string') ? currentCid : '';
    if (cid && typeof conversations !== 'undefined' && Array.isArray(conversations)) {
      const conv = conversations.find((c) => c && c.conversation_id === cid);
      return (conv && conv.space_id) || '';
    }
    return '';
  }
  if (anchorId === 'new-chat-recipient-chip' && typeof window.getNewChatSpaceId === 'function') {
    return window.getNewChatSpaceId() || '';
  }
  return '';
}

function _agentPickerVisibleTabs(anchorId) {
  // 空间会话（聊天绑空间 / new-chat 选中空间）→ 智能体/技能/产物/资产；
  // 无空间（主对话默认工作区 / Auto）→ 仅智能体/技能。
  // 连接器/资料库/本体 tab 已删（两处都不再出现）。
  const spaceId = _agentPickerSpaceId(anchorId);
  return spaceId ? _AGENT_PICKER_TAB_ORDER : ['agents', 'skills'];
}

function _agentPickerSearchPlaceholder() {
  if (_agentPickerTab === 'skills') return t('agent_picker.search_skills_placeholder');
  if (_agentPickerTab === 'artifacts') return t('agent_picker.search_artifacts_placeholder');
  if (_agentPickerTab === 'assets') return t('agent_picker.search_assets_placeholder');
  return t('agent_picker.search_placeholder');
}

/** composer 占位符随会话空间状态更新：空间会话提示「产物/资产」可选，非空间只说智能体/技能。
 *  同时同步富文本编辑器（contenteditable 镜像 data-placeholder，见 _initMentionMirror）与
 *  attribute（i18n 重应用/镜像 sync 读的是 getAttribute）。 */
function updateAgentPickerPlaceholders() {
  const spacePh = t('agent_picker.input_placeholder_space', '输入 @ 选择智能体、技能、产物、资产');
  const plainPh = t('chat.input_placeholder', '输入 @ 选择智能体、技能');
  const apply = (input, ph) => {
    if (!input) return;
    input.placeholder = ph;
    input.setAttribute('placeholder', ph);
    try {
      if (typeof getChatRichComposerEditor === 'function') {
        const ed = getChatRichComposerEditor(input.id);
        if (ed) ed.dataset.placeholder = ph;
      }
    } catch (_) {}
  };
  apply(document.getElementById('chat-input'), _agentPickerSpaceId('chat-recipient-chip') ? spacePh : plainPh);
  apply(document.getElementById('new-chat-input'), _agentPickerSpaceId('new-chat-recipient-chip') ? spacePh : plainPh);
}

function _updateAgentPickerChrome() {
  const picker = document.getElementById('agent-picker');
  if (!picker) return;
  const visibleTabs = new Set(_agentPickerVisibleTabs(picker.dataset.anchorId || ''));
  picker.querySelectorAll('[data-agent-picker-tab]').forEach((btn) => {
    const tab = btn.dataset.agentPickerTab || 'agents';
    const visible = visibleTabs.has(tab);
    btn.style.display = visible ? '' : 'none';
    const active = visible && tab === _agentPickerTab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const tabsEl = picker.querySelector('.skill-picker-tabs');
  if (tabsEl) tabsEl.style.gridTemplateColumns = `repeat(${Math.max(1, visibleTabs.size)}, minmax(0, 1fr))`;
  const search = document.getElementById('agent-picker-search');
  if (search) search.placeholder = _agentPickerSearchPlaceholder();
}

function _setAgentPickerTab(tab, opts = {}) {
  const picker = document.getElementById('agent-picker');
  const visibleTabs = _agentPickerVisibleTabs(picker?.dataset.anchorId || '');
  const normalized = _normalizeAgentPickerTab(tab);
  _agentPickerTab = visibleTabs.includes(normalized) ? normalized : 'agents';
  const search = document.getElementById('agent-picker-search');
  if (search && !opts.keepSearch) search.value = '';
  _updateAgentPickerChrome();
  _renderAgentPickerList(search ? search.value : '');
  _ensureAgentPickerTabData(_agentPickerTab, _agentPickerOpenSeq);
  if (opts.focusSearch !== false) setTimeout(() => search?.focus(), 0);
}

function _ensureAgentPickerTabData(tab, openSeq) {
  const normalized = _normalizeAgentPickerTab(tab);
  // artifacts/assets own their own lazy-load + cache inside their render
  // functions (_renderArtifactsPickerList / _renderAssetsPickerList) — same
  // pattern as the removed library/ontology tabs, skip generic bookkeeping.
  if (normalized === 'artifacts' || normalized === 'assets' || _agentPickerLoadedTabs.has(normalized)) {
    return Promise.resolve();
  }
  const existing = _agentPickerTabLoads.get(normalized);
  if (existing) {
    const joined = existing.then(() => {
      if (openSeq !== _agentPickerOpenSeq) return;
      _agentPickerLoadedTabs.add(normalized);
      const picker = document.getElementById('agent-picker');
      if (!picker || picker.style.display === 'none' || _agentPickerTab !== normalized) return;
      const search = document.getElementById('agent-picker-search');
      _renderAgentPickerList(search ? search.value : '');
    });
    joined.catch(() => {});
    return joined;
  }
  const run = (async () => {
    if (normalized === 'skills') {
      const loader = typeof loadRendererFeature === 'function'
        ? loadRendererFeature
        : window.loadRendererFeature;
      if (typeof loadSkills !== 'function' && typeof loader === 'function') {
        await loader('skills');
      }
      if (typeof loadSkills === 'function') await loadSkills(false);
    } else {
      // A summary catalog is enough for the first frame. `loadAgents(false)`
      // upgrades it once and then reuses the validated full cache.
      await loadAgents(false);
    }
    if (openSeq === _agentPickerOpenSeq) _agentPickerLoadedTabs.add(normalized);
  })().catch((err) => {
    _agentsLog.warn('picker tab load failed', {
      tab: normalized,
      error: err?.message || String(err),
    });
    throw err;
  }).finally(() => {
    if (_agentPickerTabLoads.get(normalized) === run) _agentPickerTabLoads.delete(normalized);
    const picker = document.getElementById('agent-picker');
    if (openSeq !== _agentPickerOpenSeq || !picker || picker.style.display === 'none') return;
    if (_agentPickerTab !== normalized) return;
    const search = document.getElementById('agent-picker-search');
    _renderAgentPickerList(search ? search.value : '');
  });
  _agentPickerTabLoads.set(normalized, run);
  // Tab clicks are UI events; contain failures here so they never create an
  // unhandled rejection. Re-selecting the tab retries because the map clears.
  run.catch(() => {});
  return run;
}

function _moveAgentPickerTab(delta) {
  const picker = document.getElementById('agent-picker');
  const tabs = _agentPickerVisibleTabs(picker?.dataset.anchorId || '');
  const cur = tabs.indexOf(_agentPickerTab);
  const idx = cur >= 0 ? cur : 0;
  const next = (idx + delta + tabs.length) % tabs.length;
  _setAgentPickerTab(tabs[next]);
}

async function _refreshAgentPickerProjectContext(anchorId) {
  // 空间化重构：picker 作用域 = 当前会话所属空间的「能力配置」。
  //   - 会话绑空间（conv.space_id 非空）→ 折叠到该空间 agents ∪ skills
  //     （模板 bundle ∪ extra，与 runner 执行作用域同源 spaces.scope.resolve）；
  //   - 未绑空间 / 空间空配置（S1：resolve 返回 null）→ 全局不过滤。
  // 旧项目作用域已删（不再按 project 过滤）。
  // 主对话：当前会话 → 空间；新聊天：chip 选中的空间（创建后对话归该空间，@ 同步过滤）
  // （同步判定，无空间直接走全局路径，不闪 loading）
  const spaceId = _agentPickerSpaceId(anchorId);
  if (!spaceId) {
    _pickerBoundAgentIds = null;
    _pickerBoundSkillIds = null;
    _pickerScopeSpace = null;
    _pickerProjectId = '';
    _pickerProjectContextLoading = false;
    _pickerLibraryRows = null;
    _pickerLibraryLoading = null;
    _pickerLibraryRenderSeq += 1;
    _pickerOntologyEntries = null;
    _pickerOntologyLoading = null;
    _pickerOntologyRenderSeq += 1;
    _pickerArtifactRows = null;
    _pickerArtifactTitles = new Map();
    _pickerArtifactLoading = null;
    _pickerAssetRows = null;
    _pickerAssetLoading = null;
    return;
  }
  // 有空间 → 异步解析作用域（loading 壳防旧列表可点）
  _pickerProjectContextLoading = true;
  let boundAgentIds = null;
  let boundSkillIds = null;
  let scopeSpace = null;
  try {
    const res = await window.cogseed.invoke('spaces.scope.resolve', { spaceId });
    const scope = res && res.scope;
    if (scope && Array.isArray(scope.agents) && Array.isArray(scope.skills)) {
      boundAgentIds = new Set(scope.agents);
      boundSkillIds = new Set(scope.skills);
      scopeSpace = { space_id: spaceId };
    }
    // scope === null（空间缺失/空配置/全失效）→ 保持 null = 全局可见
  } catch (err) {
    _agentsLog.warn('resolve space scope for picker failed', err);
  } finally {
    _pickerProjectContextLoading = false;
  }
  _pickerBoundAgentIds = boundAgentIds;
  _pickerBoundSkillIds = boundSkillIds;
  _pickerScopeSpace = scopeSpace;
  _pickerProjectId = '';
  _pickerLibraryRows = null;
  _pickerLibraryLoading = null;
  _pickerLibraryRenderSeq += 1;
  _pickerOntologyEntries = null;
  _pickerOntologyLoading = null;
  _pickerOntologyRenderSeq += 1;
  _pickerArtifactRows = null;
  _pickerArtifactTitles = new Map();
  _pickerArtifactLoading = null;
  _pickerAssetRows = null;
  _pickerAssetLoading = null;
}

async function refreshAgentPickerContext(anchorId) {
  const picker = document.getElementById('agent-picker');
  if (!picker || picker.style.display === 'none') return;
  if (anchorId && picker.dataset.anchorId !== anchorId) return;
  const activeAnchorId = picker.dataset.anchorId || anchorId || '';
  await _refreshAgentPickerProjectContext(activeAnchorId);
  const search = document.getElementById('agent-picker-search');
  _renderAgentPickerList(search ? search.value : '');
}

async function _openAgentPicker(anchorBtn) {
  const picker = document.getElementById('agent-picker');
  if (!anchorBtn || !picker) return;
  picker.dataset.anchorId = anchorBtn.id;
  const openSeq = ++_agentPickerOpenSeq;
  _agentPickerLoadedTabs = new Set();
  // 产物/资产目录按 picker 会话重置（防上次会话残留旧空间行可点）
  _pickerArtifactRows = null;
  _pickerArtifactTitles = new Map();
  _pickerArtifactLoading = null;
  _pickerAssetRows = null;
  _pickerAssetLoading = null;
  // Reset project scope synchronously before painting. For project-bound
  // composers this flips the list to a loading shell immediately, so stale
  // unrestricted rows from the previous picker session are never clickable
  // while the fresh binding request is in flight.
  const projectContextPromise = _refreshAgentPickerProjectContext(anchorBtn.id);
  // Paint the cached Agent shell in the same interaction frame. Other tabs
  // own their script/data loads and cannot delay this first frame.
  _setAgentPickerTab('agents', { focusSearch: false });
  _positionPopoverAboveOrBelow(picker, anchorBtn);
  setTimeout(() => document.getElementById('agent-picker-search')?.focus(), 30);
  // Project bindings affect Agent visibility, so refresh them independently
  // and repaint only if this picker session is still current.
  projectContextPromise.then(() => {
    if (openSeq !== _agentPickerOpenSeq || picker.style.display === 'none') return;
    if (_agentPickerTab !== 'agents') return;
    const search = document.getElementById('agent-picker-search');
    _renderAgentPickerList(search ? search.value : '');
  }).catch(() => {});
}

function _closeAgentPicker() {
  const picker = document.getElementById('agent-picker');
  if (picker) picker.style.display = 'none';
  // NOTE: callers that close-without-selection (Esc / click-outside) must
  // also clear `_atKeyMark` — otherwise the next picker open would consume
  // a stale `@`. Selection callers leave the mark so _triggerPickerItem can
  // use it before clearing.
}

function _renderAgentPickerList(filterText) {
  const listEl = document.getElementById('agent-picker-list');
  const picker = document.getElementById('agent-picker');
  if (!listEl) return;
  const anchorId = picker?.dataset.anchorId || '';
  if (!_agentPickerVisibleTabs(anchorId).includes(_agentPickerTab)) {
    _agentPickerTab = 'agents';
  }
  _updateAgentPickerChrome();
  if (_agentPickerTab === 'skills') {
    if (typeof loadSkills !== 'function') {
      listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('common.loading'))}</div>`;
      return;
    }
    _renderSkillPickerList(listEl, filterText, anchorId);
    return;
  }
  if (_agentPickerTab === 'artifacts') {
    _renderArtifactsPickerList(listEl, filterText, anchorId);
    return;
  }
  if (_agentPickerTab === 'assets') {
    _renderAssetsPickerList(listEl, filterText, anchorId);
    return;
  }
  // Disabled agents are filtered out — picker is a "what can I dispatch right
  // now" UI, and re-enabling lives in the management page (Agents view + ⋯ menu).
  if (_pickerProjectContextLoading) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('common.loading'))}</div>`;
    return;
  }
  let agents = (_agentsCache || []).filter((a) => a.enabled !== false);
  // Project scope: only show agents bound to the active context's project.
  // Applied AFTER the enabled filter (per CLAUDE.md §6 outer-intersection
  // rule). `null` = no project scope, full listing.
  if (_pickerBoundAgentIds) {
    agents = agents.filter((a) => _pickerBoundAgentIds.has(a.agent_id));
  }
  const q = (filterText || '').toLowerCase();
  // Search matches across the active locale description; cross-language
  // fallback via pickDesc lets users find a single-locale agent regardless
  // of which side they typed in.
  // Match-quality ranking: name-exact (0) < name-prefix (1) < name-substring (2)
  // < description-only (3). Stable sort within ties preserves the source-group
  // order computed below. Without this, an agent whose description happens to
  // mention the query (e.g. "Agent Skill 搜集" mentioning "Claude Code subagents"
  // in passing) outranks the actual `Claude Code` agent because the original
  // list is sorted by hex agent_id, not by relevance.
  const lang = getLang();
  const matchScore = (a) => {
    const name = (a.name || '').toLowerCase();
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.includes(q)) return 2;
    return 3;
  };
  const filtered = q
    ? agents
        .filter(a => (a.name || '').toLowerCase().includes(q) || pickDesc(a, lang).toLowerCase().includes(q))
        .sort((a, b) => matchScore(a) - matchScore(b))
    : agents;
  // Recipient chip exposes "commander" as a virtual top entry so the user can
  // switch back without an empty-state. Other anchors keep agent-only listing.
  const isRecipientPicker = anchorId === 'chat-recipient-chip'
    || anchorId === 'new-chat-recipient-chip'
    || anchorId === 'auto-recipient-chip';
  const commanderName = t('chat.recipient_commander');
  const commanderMatchesFilter = !q || commanderName.toLowerCase().includes(q);
  if (!filtered.length && !(isRecipientPicker && commanderMatchesFilter)) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('agents.no_match'))}</div>`;
    return;
  }
  const groups = { custom: [], marketplace: [] };
  for (const a of filtered) (groups[_agentSource(a.source)] || groups.custom).push(a);
  const groupHtml = (label, list) => {
    if (!list.length) return '';
    return `<div class="skill-picker-group-label">${escapeHtml(label)}</div>` +
      list.map(a => {
        const aDesc = pickDesc(a, lang).trim();
        return `
        <div class="skill-picker-item" data-kind="agent" data-id="${escapeHtml(a.agent_id)}" data-name="${escapeHtml(a.name || a.agent_id)}">
          <div class="skill-picker-item-name">${escapeHtml(a.name || t('agents.unnamed'))}</div>
          ${aDesc ? `<div class="skill-picker-item-desc">${escapeHtml(aDesc)}</div>` : ''}
        </div>`;
      }).join('');
  };
  const commanderHtml = (isRecipientPicker && commanderMatchesFilter)
    ? `<div class="skill-picker-item" data-kind="agent" data-id="__commander__" data-name="${escapeHtml(commanderName)}">
         <div class="skill-picker-item-name">${escapeHtml(commanderName)}</div>
         <div class="skill-picker-item-desc">${escapeHtml(t('chat.recipient_commander_hint'))}</div>
       </div>`
    : '';
  // When the active context is a project AND the project has zero agents
  // bound, surface a hint above the commander entry so the user knows
  // "this isn't broken — go bind an agent first". Suppressed on user search
  // (they're explicitly typing) so the search "no match" message owns the
  // empty rendering.
  const projectEmptyHint = (!q && _pickerBoundAgentIds && _pickerBoundAgentIds.size === 0)
    ? `<div class="skill-picker-empty-hint">${escapeHtml(t('agents.no_project_agents'))}</div>`
    : '';
  listEl.innerHTML = projectEmptyHint + commanderHtml
    + groupHtml(t('agents.source_custom'), groups.custom)
    + groupHtml(t('agents.source_marketplace'), groups.marketplace);
  _bindAgentPickerListItems(listEl, anchorId);
}

function _matchPickerItem(q, name, desc, extra = '') {
  if (!q) return true;
  return String(name || '').toLowerCase().includes(q)
    || String(desc || '').toLowerCase().includes(q)
    || String(extra || '').toLowerCase().includes(q);
}

function _pickerMatchScore(q, name) {
  const n = String(name || '').toLowerCase();
  if (!q) return 0;
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(q)) return 2;
  return 3;
}

function _renderSkillPickerList(listEl, filterText, anchorId) {
  const lang = getLang();
  const q = (filterText || '').toLowerCase();
  const trustedDesc = (s) => pickDesc(s, lang);
  const openDesc = (s) => s.description || '';
  const applyFilter = (list, descOf) => q
    ? list
        .filter((s) => _matchPickerItem(q, s.name || s.id, descOf(s), s.id))
        .sort((a, b) => _pickerMatchScore(q, a.name || a.id) - _pickerMatchScore(q, b.name || b.id))
    : list;

  const trusted = applyFilter((_skillsCache || [])
    .filter((s) => s.enabled !== false)
    // 情境空间一期：项目/空间作用域下只显示作用域内技能（null = 全局不过滤）
    .filter((s) => !_pickerBoundSkillIds || _pickerBoundSkillIds.has(s.id)), trustedDesc);
  // Global open-tier skills share the same picker surface as trusted skills.
  // External package internals stay package-scoped in user UI; the agent layer
  // can still see package-provided SKILL.md files when composing a task.
  // 情境空间一期：global 技能同样受作用域过滤（否则空间外技能漏网显示）。
  const openRows = (typeof _openSkillsCache !== 'undefined' && Array.isArray(_openSkillsCache))
    ? applyFilter(_openSkillsCache.filter((s) => s.source === 'global' && s.enabled !== false
      && (!_pickerBoundSkillIds || _pickerBoundSkillIds.has(s.id))), openDesc)
    : [];

  if (!trusted.length && !openRows.length) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('skills.no_match'))}</div>`;
    return;
  }

  const groups = { custom: [], marketplace: [] };
  for (const s of trusted) {
    const source = (typeof normalizeCatalogSource === 'function') ? normalizeCatalogSource(s.source) : s.source;
    (groups[source] || groups.custom).push(s);
  }
  const globalRows = openRows.filter((s) => s.source === 'global');

  const groupHtml = (label, list, descOf) => {
    if (!list.length) return '';
    return `<div class="skill-picker-group-label">${escapeHtml(label)}</div>` +
      list.map((s) => {
        const desc = (descOf(s) || '').trim();
        const name = s.name || s.id;
        return `
        <div class="skill-picker-item" data-kind="skill" data-id="${escapeHtml(s.id)}" data-name="${escapeHtml(name)}">
          <div class="skill-picker-item-name">${escapeHtml(name)}</div>
          ${desc ? `<div class="skill-picker-item-desc">${escapeHtml(desc)}</div>` : ''}
        </div>`;
      }).join('');
  };
  listEl.innerHTML = groupHtml(t('skills.source_custom'), groups.custom, trustedDesc)
    + groupHtml(t('skills.source_marketplace'), groups.marketplace, trustedDesc)
    + groupHtml(t('skills.global_group'), globalRows, openDesc);
  _bindAgentPickerListItems(listEl, anchorId);
}

function _renderConnectorPickerList(listEl, filterText, anchorId) {
  const q = (filterText || '').toLowerCase();
  const items = (typeof listUsableConnectorsForPicker === 'function')
    ? listUsableConnectorsForPicker()
    : [];
  const filtered = q
    ? items
        .filter((c) => _matchPickerItem(q, c.name || c.id, c.description, `${c.id} ${c.account || ''}`))
        .sort((a, b) => _pickerMatchScore(q, a.name || a.id) - _pickerMatchScore(q, b.name || b.id))
    : items;
  if (!filtered.length) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(q ? t('connectors.no_match') : t('connectors.no_connected'))}</div>`;
    return;
  }
  listEl.innerHTML = `<div class="skill-picker-group-label">${escapeHtml(t('connectors.group.connected'))}</div>` +
    filtered.map((c) => {
      const descParts = [];
      if (c.description) descParts.push(c.description);
      if (c.account) descParts.push(t('connectors.account_label', { account: c.account }));
      return `
      <div class="skill-picker-item" data-kind="connector" data-id="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name || c.id)}">
        <div class="skill-picker-item-name">${escapeHtml(c.name || c.id)}</div>
        ${descParts.length ? `<div class="skill-picker-item-desc">${escapeHtml(descParts.join(' · '))}</div>` : ''}
      </div>`;
    }).join('');
  _bindAgentPickerListItems(listEl, anchorId);
}

function _agentPickerBasename(rel) {
  const s = String(rel || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function _agentPickerFormatMtime(mtime) {
  const n = Number(mtime);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = n > 100000000000 ? n : n * 1000;
  try {
    const locale = (typeof getLocaleMeta === 'function' && typeof getLang === 'function')
      ? getLocaleMeta(getLang()).intlLocale
      : undefined;
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch (_) {
    return new Date(ms).toLocaleString();
  }
}

function _flattenLibraryPickerTree(nodes, scope, projectId) {
  const rows = [];
  const walk = (items) => {
    for (const node of items || []) {
      if (!node) continue;
      if (node.type === 'dir') {
        walk(node.children || []);
        continue;
      }
      if (node.type !== 'file') continue;
      const rel = String(node.relPath || node.path || node.name || '');
      if (!rel) continue;
      const name = node.name || _agentPickerBasename(rel);
      rows.push({
        scope,
        projectId: projectId || '',
        rel,
        name,
        group: scope === 'project' ? 'project' : 'global',
        kind: node.kind || '',
        bytes: Number(node.bytes || 0),
        mtime: node.mtime,
      });
    }
  };
  walk(nodes || []);
  return rows;
}

async function _loadLibraryPickerRows() {
  // 空间化后仅全局上下文库（contexts）可选；项目文件树已删。
  const globalPromise = apiFetch('/api/contexts/tree')
    .then((res) => res.json())
    .catch((err) => {
      _agentsLog.warn('global library picker load failed', err);
      return null;
    });
  const globalData = await globalPromise;
  const rows = [];
  if (globalData && globalData.ok !== false) {
    rows.push(..._flattenLibraryPickerTree(globalData.tree || [], 'global', ''));
  }
  return rows;
}

function _libraryPickerRowHtml(row) {
  const rel = row.rel || row.name || '';
  const label = row.name || _agentPickerBasename(rel);
  const time = _agentPickerFormatMtime(row.mtime);
  const desc = rel && rel !== label ? rel : '';
  const id = `${row.scope}:${row.projectId || ''}:${rel}`;
  return `
    <div class="skill-picker-item" data-kind="library" data-id="${escapeHtml(id)}"
         data-name="${escapeHtml(label)}" data-library-scope="${escapeHtml(row.scope)}"
         data-library-rel="${escapeHtml(rel)}" data-project-id="${escapeHtml(row.projectId || '')}">
      <div class="skill-picker-item-meta">
        <div class="skill-picker-item-name">${escapeHtml(label)}</div>
        ${time ? `<span class="skill-picker-item-time">${escapeHtml(time)}</span>` : ''}
      </div>
      ${desc ? `<div class="skill-picker-item-desc">${escapeHtml(desc)}</div>` : ''}
    </div>`;
}

function _renderLibraryPickerList(listEl, filterText, anchorId) {
  const q = (filterText || '').toLowerCase();
  const renderSeq = ++_pickerLibraryRenderSeq;
  if (!_pickerLibraryRows) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('common.loading'))}</div>`;
    if (!_pickerLibraryLoading) {
      _pickerLibraryLoading = _loadLibraryPickerRows()
        .then((rows) => {
          _pickerLibraryRows = rows || [];
          _pickerLibraryLoading = null;
        })
        .catch((err) => {
          _agentsLog.warn('library picker load failed', err);
          _pickerLibraryRows = [];
          _pickerLibraryLoading = null;
        });
    }
    _pickerLibraryLoading.then(() => {
      if (renderSeq !== _pickerLibraryRenderSeq) return;
      const picker = document.getElementById('agent-picker');
      if (!picker || picker.style.display === 'none' || _agentPickerTab !== 'library') return;
      const search = document.getElementById('agent-picker-search');
      _renderLibraryPickerList(listEl, search ? search.value : filterText, anchorId);
    });
    return;
  }

  const allRows = _pickerLibraryRows || [];
  const filtered = q
    ? allRows
        .filter((row) => _matchPickerItem(q, row.name, row.rel, row.kind))
        .sort((a, b) => _pickerMatchScore(q, a.name || a.rel) - _pickerMatchScore(q, b.name || b.rel))
    : allRows;

  if (!filtered.length) {
    const key = allRows.length ? 'agent_picker.library_no_match' : 'agent_picker.library_empty';
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t(key))}</div>`;
    return;
  }

  const projectRows = filtered.filter((row) => row.scope === 'project');
  const globalRows = filtered.filter((row) => row.scope === 'global');
  const groupHtml = (label, rows) => {
    if (!rows.length) return '';
    return `<div class="skill-picker-group-label">${escapeHtml(label)}</div>` + rows.map(_libraryPickerRowHtml).join('');
  };
  listEl.innerHTML = groupHtml(t('agent_picker.library_group_project'), projectRows)
    + groupHtml(t('agent_picker.library_group_global'), globalRows);
  _bindAgentPickerListItems(listEl, anchorId);
}

async function _loadOntologyPickerEntries() {
  try {
    const res = await window.cogseed.invoke('personalOntology.entries.list', {});
    return (res && res.ok !== false && Array.isArray(res.entries)) ? res.entries : [];
  } catch (err) {
    _agentsLog.warn('ontology entry picker load failed', err);
    return [];
  }
}

function _ontologyPickerRowHtml(entry, checked) {
  return `
    <div class="skill-picker-item is-checkable${checked ? ' is-checked' : ''}${entry.parentId ? ' is-template-child' : ''}" data-kind="ontology_group"
         data-id="${escapeHtml(entry.ref)}" data-name="${escapeHtml(entry.label || '')}">
      <span class="skill-picker-item-checkbox" aria-hidden="true"></span>
      <div class="skill-picker-item-meta">
        <div class="skill-picker-item-name">${escapeHtml(entry.label || '')}</div>
      </div>
    </div>`;
}

// 本体 tab 层级渲染：无 parentId 的条目平铺；有 parentId 的收纳在分组标题行
// （可折叠）下。data-id 一律是 PO contract 给的 opaque ref —— 渲染层不解析、
// 不拼接，chat-use 原样透传，发送时主进程按 ref 读回内容。
// 标题行不带 data-id —— 不参与键盘导航（_setAgentPickerActive 只遍历 [data-id]）
// 也不参与点击选中（_bindAgentPickerListItems 只绑 [data-id]），多选逻辑零改动。
function _ontologyPickerSectionsHtml(entries, selectedIds) {
  const rows = [];
  const grouped = new Map(); // parentId → { label, items[] }
  for (const e of entries) {
    if (!e || !e.ref) continue;
    if (!e.parentId) {
      rows.push(_ontologyPickerRowHtml(e, selectedIds.has(e.ref)));
      continue;
    }
    let bucket = grouped.get(e.parentId);
    if (!bucket) {
      bucket = { label: e.parentLabel || e.parentId, items: [] };
      grouped.set(e.parentId, bucket);
    }
    bucket.items.push(e);
  }
  for (const [parentId, bucket] of grouped) {
    const collapsed = _pickerOntologyCollapsed.has(parentId);
    rows.push(`<button type="button" class="skill-picker-template-header" data-ontology-template-toggle="${escapeHtml(parentId)}">
      <span class="skill-picker-template-caret">${collapsed ? '▶' : '▼'}</span>${escapeHtml(bucket.label)}</button>`);
    if (!collapsed) {
      rows.push(`<div class="skill-picker-template-groups">${
        bucket.items.map((e) => _ontologyPickerRowHtml(e, selectedIds.has(e.ref))).join('')
      }</div>`);
    }
  }
  return rows.join('');
}

function _bindAgentPickerTemplateToggles(listEl) {
  for (const btn of listEl.querySelectorAll('[data-ontology-template-toggle]')) {
    btn.addEventListener('click', () => {
      const pid = btn.dataset.ontologyTemplateToggle;
      if (!pid) return;
      if (_pickerOntologyCollapsed.has(pid)) _pickerOntologyCollapsed.delete(pid);
      else _pickerOntologyCollapsed.add(pid);
      const picker = document.getElementById('agent-picker');
      const search = document.getElementById('agent-picker-search');
      _renderOntologyPickerList(listEl, search ? search.value : '', picker ? picker.dataset.anchorId || '' : '');
    });
  }
}

function _renderOntologyPickerList(listEl, filterText, anchorId) {
  const q = (filterText || '').toLowerCase();
  const renderSeq = ++_pickerOntologyRenderSeq;
  if (!_pickerOntologyEntries) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('common.loading'))}</div>`;
    if (!_pickerOntologyLoading) {
      _pickerOntologyLoading = _loadOntologyPickerEntries()
        .then((entries) => {
          _pickerOntologyEntries = entries || [];
          _pickerOntologyLoading = null;
        })
        .catch(() => {
          _pickerOntologyEntries = [];
          _pickerOntologyLoading = null;
        });
    }
    _pickerOntologyLoading.then(() => {
      if (renderSeq !== _pickerOntologyRenderSeq) return;
      const picker = document.getElementById('agent-picker');
      if (!picker || picker.style.display === 'none' || _agentPickerTab !== 'ontology') return;
      const search = document.getElementById('agent-picker-search');
      _renderOntologyPickerList(listEl, search ? search.value : filterText, anchorId);
    });
    return;
  }

  const allEntries = _pickerOntologyEntries || [];
  // 搜索匹配条目标签或分组标签：分组名命中时保留该分组全部条目（与收归前
  // 「模板名命中保留该模板全部预置组」的行为一致），单一过滤路径。
  const filtered = q
    ? (() => {
        const hitParents = new Set(
          allEntries.filter((e) => e.parentLabel && _matchPickerItem(q, e.parentLabel, '', ''))
            .map((e) => e.parentId),
        );
        return allEntries
          .filter((e) => _matchPickerItem(q, e.label, '', '') || (e.parentId && hitParents.has(e.parentId)))
          .sort((a, b) => _pickerMatchScore(q, a.label) - _pickerMatchScore(q, b.label));
      })()
    : allEntries;

  if (!filtered.length) {
    const key = allEntries.length ? 'agent_picker.ontology_no_match' : 'agent_picker.ontology_empty';
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t(key))}</div>`;
    return;
  }

  const target = _targetFromPickerAnchor(anchorId);
  const selectedIds = new Set(
    (typeof getChatUseOntologyGroups === 'function' ? getChatUseOntologyGroups(target) : [])
      .map((sel) => sel.id),
  );
  listEl.innerHTML = _ontologyPickerSectionsHtml(filtered, selectedIds);
  _bindAgentPickerTemplateToggles(listEl);
  _bindAgentPickerListItems(listEl, anchorId);
}

function _bindAgentPickerListItems(listEl, anchorId) {
  for (const el of listEl.querySelectorAll('[data-id]')) {
    el.addEventListener('click', async () => {
      // "本体" rows are checkboxes, not click-to-trigger-and-close — this is
      // the one behavioral difference from the other four tabs (§3.7). Toggle
      // the checked state and keep the picker open so the user can multi-select.
      if (el.dataset.kind === 'ontology_group') {
        await _triggerPickerItem('ontology_group', el.dataset.id, el.dataset.name, anchorId, el.dataset);
        return;
      }
      _closeAgentPicker();
      await _triggerPickerItem(el.dataset.kind || 'agent', el.dataset.id, el.dataset.name, anchorId, el.dataset);
    });
    el.addEventListener('mouseenter', () => {
      const all = listEl.querySelectorAll('.skill-picker-item[data-id]');
      const idx = Array.prototype.indexOf.call(all, el);
      if (idx >= 0) _setAgentPickerActive(idx);
    });
  }
  _setAgentPickerActive(0);
}

// ── Agent picker keyboard navigation ─────────────────────────────────────

function _setAgentPickerActive(idx) {
  const listEl = document.getElementById('agent-picker-list');
  if (!listEl) return;
  const items = listEl.querySelectorAll('.skill-picker-item[data-id]');
  if (!items.length) return;
  const clamped = Math.max(0, Math.min(items.length - 1, idx));
  items.forEach((el, i) => el.classList.toggle('active', i === clamped));
  items[clamped].scrollIntoView({ block: 'nearest' });
}

function _moveAgentPickerActive(delta) {
  const listEl = document.getElementById('agent-picker-list');
  if (!listEl) return;
  const items = listEl.querySelectorAll('.skill-picker-item[data-id]');
  if (!items.length) return;
  let cur = -1;
  items.forEach((el, i) => { if (el.classList.contains('active')) cur = i; });
  const next = cur < 0 ? 0 : (cur + delta + items.length) % items.length;
  _setAgentPickerActive(next);
}

function _targetFromPickerAnchor(anchorId) {
  if (anchorId === 'new-chat-recipient-chip') return 'new-chat';
  if (anchorId === 'auto-recipient-chip') return 'auto';
  return 'conversation';
}

// ── 产物 / 资产 tab（空间会话 @ 引用：复用任务引用 task_references）─────────────

function _sameTaskRefKey(r) {
  return r && r.kind === 'asset'
    ? `asset:${r.asset_id || ''}`
    : `artifact:${r.source_cid || ''}:${r.file_name || ''}`;
}

async function _loadArtifactPickerRows(spaceId) {
  const [artRes, convRes] = await Promise.all([
    window.cogseed.invoke('spaces.artifacts.list', { spaceId }).catch(() => ({})),
    window.cogseed.invoke('spaces.conversations.list', { spaceId }).catch(() => ({})),
  ]);
  const titles = new Map();
  for (const c of (convRes && convRes.conversations) || []) {
    if (c && c.conversation_id) titles.set(c.conversation_id, c.title || '');
  }
  _pickerArtifactTitles = titles;
  return Array.isArray(artRes && artRes.artifacts) ? artRes.artifacts : [];
}

async function _loadAssetPickerRows(spaceId) {
  // @ 资产 = 本空间沉淀资产（recall.assets.listForSpace，与空间资产 tab 同源；
  // 不再用全局 recall.assets.list——用户明确要求空间资产）。
  if (!spaceId) return [];
  try {
    const res = await window.cogseed.invoke('recall.assets.listForSpace', { spaceId });
    return Array.isArray(res && res.assets)
      ? res.assets.map((a) => ({ asset_id: a.id, title: a.title, asset_type: a.type }))
      : [];
  } catch (err) {
    _agentsLog.warn('asset picker load failed', err);
    return [];
  }
}

function _renderArtifactsPickerList(listEl, filterText, anchorId) {
  const q = (filterText || '').toLowerCase();
  const renderSeq = ++_pickerArtifactRenderSeq;
  const spaceId = _agentPickerSpaceId(anchorId);
  if (!spaceId) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('agent_picker.artifacts_empty'))}</div>`;
    return;
  }
  if (!_pickerArtifactRows) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('common.loading'))}</div>`;
    const openSeq = _agentPickerOpenSeq;
    if (!_pickerArtifactLoading) {
      _pickerArtifactLoading = _loadArtifactPickerRows(spaceId)
        .then((rows) => {
          // 会话守卫：picker 已关闭/重开则丢弃过期结果
          if (openSeq !== _agentPickerOpenSeq) return;
          _pickerArtifactRows = rows || [];
          _pickerArtifactLoading = null;
        })
        .catch((err) => {
          if (openSeq !== _agentPickerOpenSeq) return;
          _agentsLog.warn('artifact picker load failed', err);
          _pickerArtifactRows = [];
          _pickerArtifactLoading = null;
        });
    }
    _pickerArtifactLoading.then(() => {
      if (openSeq !== _agentPickerOpenSeq) return;
      if (renderSeq !== _pickerArtifactRenderSeq) return;
      const picker = document.getElementById('agent-picker');
      if (!picker || picker.style.display === 'none' || _agentPickerTab !== 'artifacts') return;
      const search = document.getElementById('agent-picker-search');
      _renderArtifactsPickerList(listEl, search ? search.value : filterText, anchorId);
    });
    return;
  }
  const rows = _pickerArtifactRows || [];
  const filtered = q ? rows.filter((a) => _matchPickerItem(q, a.name, a.sourceSessionId || '', a.ext || '')) : rows;
  if (!filtered.length) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(q ? t('agent_picker.artifacts_no_match') : t('agent_picker.artifacts_empty'))}</div>`;
    return;
  }
  listEl.innerHTML = `<div class="skill-picker-group-label">${escapeHtml(t('agent_picker.artifacts_group'))}</div>` +
    filtered.map((a) => {
      const sub = `${a.type === 'artifact' ? escapeHtml(t('agent_picker.artifact_confirmed')) : escapeHtml(t('agent_picker.artifact_attachment'))}${a.ext ? ` · ${escapeHtml(a.ext)}` : ''}`;
      return `
      <div class="skill-picker-item" data-kind="artifact"
           data-id="${escapeHtml(a.name)}" data-name="${escapeHtml(a.name)}"
           data-source-cid="${escapeHtml(a.sourceSessionId || '')}"
           data-source-title="${escapeHtml(_pickerArtifactTitles.get(a.sourceSessionId) || '')}"
           data-file-name="${escapeHtml(a.name)}">
        <div class="skill-picker-item-name">${escapeHtml(a.name)}</div>
        <div class="skill-picker-item-desc">${sub}</div>
      </div>`;
    }).join('');
  _bindAgentPickerListItems(listEl, anchorId);
}

function _renderAssetsPickerList(listEl, filterText, anchorId) {
  const q = (filterText || '').toLowerCase();
  const renderSeq = ++_pickerAssetRenderSeq;
  const spaceId = _agentPickerSpaceId(anchorId);
  if (!spaceId) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('agent_picker.assets_empty'))}</div>`;
    return;
  }
  if (!_pickerAssetRows) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('common.loading'))}</div>`;
    const openSeq = _agentPickerOpenSeq;
    if (!_pickerAssetLoading) {
      _pickerAssetLoading = _loadAssetPickerRows(spaceId)
        .then((rows) => {
          // 会话守卫：picker 已关闭/重开则丢弃过期结果
          if (openSeq !== _agentPickerOpenSeq) return;
          _pickerAssetRows = rows || [];
          _pickerAssetLoading = null;
        })
        .catch(() => {
          if (openSeq !== _agentPickerOpenSeq) return;
          _pickerAssetRows = [];
          _pickerAssetLoading = null;
        });
    }
    _pickerAssetLoading.then(() => {
      if (openSeq !== _agentPickerOpenSeq) return;
      if (renderSeq !== _pickerAssetRenderSeq) return;
      const picker = document.getElementById('agent-picker');
      if (!picker || picker.style.display === 'none' || _agentPickerTab !== 'assets') return;
      const search = document.getElementById('agent-picker-search');
      _renderAssetsPickerList(listEl, search ? search.value : filterText, anchorId);
    });
    return;
  }
  const rows = _pickerAssetRows || [];
  const filtered = q ? rows.filter((a) => _matchPickerItem(q, a.title || '', a.asset_id || '', a.asset_type || '')) : rows;
  if (!filtered.length) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(q ? t('agent_picker.assets_no_match') : t('agent_picker.assets_empty'))}</div>`;
    return;
  }
  listEl.innerHTML = `<div class="skill-picker-group-label">${escapeHtml(t('agent_picker.assets_group'))}</div>` +
    filtered.map((a) => {
      const typeLabel = a.asset_type ? ` · ${escapeHtml(a.asset_type)}` : '';
      return `
      <div class="skill-picker-item" data-kind="asset"
           data-id="${escapeHtml(a.asset_id)}" data-name="${escapeHtml(a.title || a.asset_id)}"
           data-asset-id="${escapeHtml(a.asset_id)}" data-asset-type="${escapeHtml(a.asset_type || '')}">
        <div class="skill-picker-item-name">${escapeHtml(a.title || a.asset_id)}</div>
        <div class="skill-picker-item-desc">${escapeHtml(t('agent_picker.asset_type'))}${typeLabel}</div>
      </div>`;
    }).join('');
  _bindAgentPickerListItems(listEl, anchorId);
}

// ── 任务引用 chips（composer 引用条）───────────────────────────────────────

function _renderTaskRefChips(el, refs, cid) {
  if (!el) return;
  if (!refs || !refs.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  el.innerHTML = refs.map((r, i) => `
    <span class="chat-taskref-chip ${r.kind === 'asset' ? 'is-asset' : 'is-artifact'}">
      <em>${r.kind === 'asset' ? escapeHtml(t('agent_picker.ref_asset')) : escapeHtml(t('agent_picker.ref_artifact'))}</em>
      <span title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
      <button type="button" class="chat-taskref-remove" data-cid="${escapeHtml(cid || '')}" data-index="${i}"
        data-kind="${escapeHtml(r.kind || '')}" data-key="${escapeHtml(_sameTaskRefKey(r))}" aria-label="${escapeHtml(t('agent_picker.ref_remove'))}">×</button>
    </span>`).join('');
  el.querySelectorAll('.chat-taskref-remove').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const c = btn.dataset.cid;
      const idx = Number(btn.dataset.index);
      try {
        if (c) {
          await window.cogseed.invoke('conversations.taskRefs.remove', { cid: c, index: idx });
        } else {
          _pendingNewChatRefs = (_pendingNewChatRefs || []).filter((_, i) => i !== idx);
        }
      } catch (err) {
        _agentsLog.warn('task ref remove failed', err);
      }
      renderChatTaskRefChips();
    });
  });
}

/** 渲染两个 composer 的引用条：conversation = 当前会话 task_references；new-chat = pending。 */
function renderChatTaskRefChips() {
  const cid = (typeof currentCid === 'string') ? currentCid : '';
  const convEl = document.getElementById('chat-taskrefs');
  if (convEl) {
    if (!cid) { convEl.style.display = 'none'; convEl.innerHTML = ''; }
    else {
      (async () => {
        try {
          const res = await window.cogseed.invoke('conversations.taskRefs.list', { cid });
          const refs = Array.isArray(res && res.references) ? res.references : [];
          _renderTaskRefChips(convEl, refs, cid);
        } catch (_) { convEl.style.display = 'none'; }
      })();
    }
  }
  const ncEl = document.getElementById('new-chat-taskrefs');
  if (ncEl) _renderTaskRefChips(ncEl, _pendingNewChatRefs || [], '');
}

/** 发送后清空 composer 引用条（视觉反馈：引用已随消息发出；服务端 task_references 保留）。 */
function clearChatTaskRefChips() {
  const convEl = document.getElementById('chat-taskrefs');
  if (convEl) { convEl.style.display = 'none'; convEl.innerHTML = ''; }
  const ncEl = document.getElementById('new-chat-taskrefs');
  if (ncEl) { ncEl.style.display = 'none'; ncEl.innerHTML = ''; }
}

/** new-chat 提交：把 @ 选的 pending 引用写入新建会话的 task_references（发送前调用）。 */
async function commitNewChatTaskRefs(convId) {
  const refs = _pendingNewChatRefs || [];
  _pendingNewChatRefs = [];
  renderChatTaskRefChips();
  if (!convId || !refs.length) return;
  for (const r of refs.slice(0, 20)) {
    try {
      await window.cogseed.invoke('conversations.taskRefs.add', { cid: convId, reference: r });
    } catch (err) {
      _agentsLog.warn('taskRefs.add for new chat failed', err);
    }
  }
}

async function _commitTaskRef(reference, anchorId) {
  const target = _targetFromPickerAnchor(anchorId);
  if (target === 'conversation') {
    const cid = (typeof currentCid === 'string') ? currentCid : '';
    if (!cid) return false;
    try {
      const res = await window.cogseed.invoke('conversations.taskRefs.add', { cid, reference });
      if (res && res.error) throw new Error(res.error);
    } catch (err) {
      _agentsLog.warn('taskRefs.add failed', err);
      if (typeof uiToast === 'function') uiToast(t('agent_picker.ref_add_failed', '添加引用失败'), { variant: 'warning' });
      return false;
    }
    renderChatTaskRefChips();
    return true;
  }
  if (target === 'new-chat') {
    const pending = _pendingNewChatRefs || [];
    const dup = pending.some((r) => _sameTaskRefKey(r) === _sameTaskRefKey(reference));
    if (!dup) {
      if (pending.length >= 20) {
        if (typeof uiToast === 'function') uiToast(t('agent_picker.ref_too_many', '引用数量已达上限'), { variant: 'warning' });
        return false;
      }
      pending.push(reference);
      _pendingNewChatRefs = pending;
    }
    renderChatTaskRefChips();
    return true;
  }
  return false;
}

async function _triggerArtifactRef(itemName, dataset, anchorId) {
  const target = _targetFromPickerAnchor(anchorId);
  const name = dataset.fileName || dataset.name || itemName || '';
  if (!name) return;
  _agentsTrackClick(target === 'auto' ? 'auto_artifact_select' : 'chat_artifact_select', { target, name });
  _consumeAtKeyChar();
  const reference = {
    kind: 'artifact',
    name,
    ...(dataset.sourceCid ? { source_cid: dataset.sourceCid } : {}),
    ...(dataset.sourceTitle ? { source_title: dataset.sourceTitle } : {}),
    file_name: dataset.fileName || name,
  };
  const ok = await _commitTaskRef(reference, anchorId);
  const inputId = target === 'new-chat' ? 'new-chat-input' : 'chat-input';
  _focusInput(document.getElementById(inputId));
  if (ok && typeof uiToast === 'function') {
    uiToast(t('agent_picker.ref_added', '已添加引用'), { variant: 'success', timeoutMs: 1500 });
  }
}

async function _triggerAssetRef(itemName, dataset, anchorId) {
  const target = _targetFromPickerAnchor(anchorId);
  const name = dataset.name || itemName || '';
  if (!name) return;
  _consumeAtKeyChar();
  const reference = {
    kind: 'asset',
    name,
    ...(dataset.assetId ? { asset_id: dataset.assetId } : {}),
    ...(dataset.assetType ? { asset_type: dataset.assetType } : {}),
  };
  const ok = await _commitTaskRef(reference, anchorId);
  const inputId = target === 'new-chat' ? 'new-chat-input' : 'chat-input';
  _focusInput(document.getElementById(inputId));
  if (ok && typeof uiToast === 'function') {
    uiToast(t('agent_picker.ref_added', '已添加引用'), { variant: 'success', timeoutMs: 1500 });
  }
}

async function _triggerPickerItem(kind, itemId, itemName, anchorId, dataset) {
  const target = _targetFromPickerAnchor(anchorId);
  if (kind === 'skill') {
    const skillId = String(itemId || itemName || '');
    _agentsTrackClick(target === 'auto' ? 'auto_skill_select' : 'chat_skill_select', {
      target,
      skill_id: skillId,
    });
    _consumeAtKeyChar();
    setChatSkill(target, itemId, itemName || itemId);
    const inputId = target === 'new-chat'
      ? 'new-chat-input'
      : (target === 'auto' ? 'auto-task-input' : 'chat-input');
    _focusInput(document.getElementById(inputId));
    return;
  }
  if (kind === 'connector') {
    _consumeAtKeyChar();
    setChatConnector(target, itemId, itemName || itemId);
    const inputId = target === 'new-chat'
      ? 'new-chat-input'
      : (target === 'auto' ? 'auto-task-input' : 'chat-input');
    _focusInput(document.getElementById(inputId));
    return;
  }
  if (kind === 'library') {
    await _triggerLibraryFile(dataset || {}, anchorId);
    return;
  }
  if (kind === 'ontology_group') {
    _triggerOntologyGroup(itemId, itemName, anchorId);
    return;
  }
  if (kind === 'artifact') {
    await _triggerArtifactRef(itemName, dataset || {}, anchorId);
    return;
  }
  if (kind === 'asset') {
    await _triggerAssetRef(itemName, dataset || {}, anchorId);
    return;
  }
  await _triggerAgent(itemId, itemName, anchorId);
}

/**
 * 本体分组行的点击处理：不走 _triggerAgent/_triggerLibraryFile 那种"触发即关闭
 * picker"的分支，而是切换该分组的勾选状态（类似多选下拉）。第一次选中会顺带
 * 消费掉输入框里那个 `@` 字符（跟其余 tab 一致）；之后的多选不会再有 `@` 可消费
 * （_consumeAtKeyChar 在标记已清空时是安全的空操作）。选中/取消不关闭 picker，
 * 也不 focus 回输入框——用户还在挑选，focus 跳走会打断多选操作。
 */
function _triggerOntologyGroup(groupId, groupTitle, anchorId) {
  const target = _targetFromPickerAnchor(anchorId);
  const alreadySelected = (typeof getChatUseOntologyGroups === 'function')
    ? getChatUseOntologyGroups(target).some((sel) => sel.id === groupId)
    : false;
  _consumeAtKeyChar();
  if (alreadySelected) {
    if (typeof removeChatUseOntologyGroup === 'function') removeChatUseOntologyGroup(target, groupId);
  } else {
    if (typeof addChatUseOntologyGroup === 'function') addChatUseOntologyGroup(target, groupId, groupTitle);
  }
  // Re-render just the list so the checkbox reflects the new state; the
  // search input keeps focus and the picker stays open for further picks.
  const listEl = document.getElementById('agent-picker-list');
  const search = document.getElementById('agent-picker-search');
  if (listEl) _renderOntologyPickerList(listEl, search ? search.value : '', anchorId);
}

function _libraryPickerInputIdForTarget(target) {
  if (target === 'new-chat') return 'new-chat-input';
  if (target === 'auto') return 'auto-task-input';
  return 'chat-input';
}

function _libraryPickerDraftCidFor(anchorId, target) {
  if (target === 'new-chat') return window.COMMANDER_DRAFT_CID;
  if (target === 'conversation') {
    return (typeof currentCid !== 'undefined') ? (currentCid || '') : '';
  }
  return '';
}

async function _triggerLibraryFile(dataset, anchorId) {
  const target = _targetFromPickerAnchor(anchorId);
  // 空间化后仅全局上下文库（contexts）可挂草稿；project scope 已删。
  const scope = 'global';
  const rel = dataset.libraryRel || '';
  if (!rel) return;
  if (target === 'auto') {
    try {
      if (typeof window._autoAttachLibraryFile !== 'function') throw new Error('auto_attach_unavailable');
      await window._autoAttachLibraryFile({ scope, rel });
      _consumeAtKeyChar();
      _focusInput(document.getElementById('auto-task-input'));
    } catch (err) {
      const reason = String((err && err.message) || err || 'failed');
      if (typeof uiAlert === 'function') await uiAlert(t('agent_picker.library_attach_failed', { reason }));
    }
    return;
  }
  const cid = _libraryPickerDraftCidFor(anchorId, target);
  if (!cid) return;

  const channel = 'contexts.attachToDraft';
  const payload = { relPath: rel };
  const inputId = _libraryPickerInputIdForTarget(target);
  const telemetry = {
    target,
    scope,
    has_project: false,
  };
  try {
    await window.attachKbFileToDraft(
      channel,
      payload,
      cid,
      () => {
        if (target === 'new-chat' && typeof setView === 'function') setView('new-chat');
      },
    );
    _agentsTrackEvent('chat_library_attach_result', { ...telemetry, result: 'success' });
    _consumeAtKeyChar();
    _focusInput(document.getElementById(inputId));
  } catch (err) {
    const reason = String((err && err.message) || err || 'failed');
    _agentsTrackEvent('chat_library_attach_result', { ...telemetry, result: 'failure' });
    _agentsTrackError('chat_library_attach', {
      ...telemetry,
      error_type: 'operation',
      error_message: 'library_attach_failed',
    });
    if (typeof uiAlert === 'function') await uiAlert(t('agent_picker.library_attach_failed', { reason }));
  }
}

// Route an agent selection to the right behaviour based on which button
// triggered the picker:
//   - recipient chip / @ picker → update the persistent recipient chip.
//   - other anchors → spin up a fresh conversation for that agent.
async function _triggerAgent(agentId, agentName, anchorId) {
  if (anchorId === 'auto-recipient-chip') {
    // Auto modal owns its own recipient state; route the picked agent
    // (or commander) to its registered handler instead of touching any
    // conversation-scoped chat state.
    const rec = (agentId === '__commander__')
      ? { kind: 'commander' }
      : { kind: 'agent', id: agentId, name: agentName || agentId };
    const resourceAgentId = rec.kind === 'commander' ? _COMMANDER_AGENT_ID : String(agentId || '');
    _agentsTrackClick('auto_agent_select', {
      target: 'auto',
      recipient_type: rec.kind,
      agent_id: rec.kind === 'agent' ? String(agentId || '') : '',
    });
    if (typeof window !== 'undefined' && typeof window._autoOnRecipientPicked === 'function') {
      window._autoOnRecipientPicked(rec);
    }
    _consumeAtKeyChar();
    _focusInput(document.getElementById('auto-task-input'));
    return;
  }
  const isRecipientAnchor = anchorId === 'chat-recipient-chip'
    || anchorId === 'new-chat-recipient-chip';
  if (isRecipientAnchor) {
    const target = _targetFromPickerAnchor(anchorId);
    const resourceAgentId = agentId === '__commander__' ? _COMMANDER_AGENT_ID : String(agentId || '');
    _agentsTrackClick('chat_agent_select', {
      target,
      recipient_type: agentId === '__commander__' ? 'commander' : 'agent',
      agent_id: agentId === '__commander__' ? '' : String(agentId || ''),
    });
    if (agentId === '__commander__') {
      setChatRecipient(target, { kind: 'commander' });
    } else {
      setChatRecipient(target, { kind: 'agent', id: agentId, name: agentName || agentId });
    }
    // If the picker was opened by the user typing `@` in the textarea, that
    // `@` is now redundant (the chip carries the recipient) and would also
    // leak into the sent text — strip it.
    _consumeAtKeyChar();
    const inputId = target === 'new-chat' ? 'new-chat-input' : 'chat-input';
    _focusInput(document.getElementById(inputId));
    return;
  }
  // Sidebar / agent-detail "use" button → spin up a fresh conversation
  await useAgent(agentId);
}

// `@`-keystroke bookkeeping so a successful picker selection can remove the
// `@` the user just typed. Cleared on every open; consumed on selection.
let _atKeyMark = null; // { inputId, posAfter } | null

function _consumeAtKeyChar() {
  const m = _atKeyMark;
  _atKeyMark = null;
  if (!m) return null;
  const ta = document.getElementById(m.inputId);
  if (!ta) return null;
  const atIdx = m.posAfter - 1;
  if (atIdx < 0 || ta.value.charAt(atIdx) !== '@') return null;
  ta.value = ta.value.slice(0, atIdx) + ta.value.slice(atIdx + 1);
  try { ta.setSelectionRange(atIdx, atIdx); } catch (_) {}
  if (typeof autoGrow === 'function') autoGrow(ta, 200);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return ta;
}

function _focusInput(input) {
  // Defer to the next tick so the picker's outside-click handler can finish
  // closing first; otherwise focus jumps back to the picker on some browsers.
  setTimeout(() => {
    try {
      if (typeof focusChatRichComposer === 'function' && focusChatRichComposer(input)) return;
      input.focus();
    } catch (_) {}
  }, 0);
}

// Recipient chip + composer textarea anchor pairs. Three sticky composers
// (commander conversation, new-chat landing, project detail) get bound at
// boot from this table; the auto modal calls `bindRecipientAnchor`
// directly when it mounts so its DOM ID joins the wiring on the fly.
const _RECIPIENT_ANCHOR_PAIRS = [
  { chip: 'chat-recipient-chip',         input: 'chat-input' },
  { chip: 'new-chat-recipient-chip',     input: 'new-chat-input' },
];

// Backspace right after a `@<name>` token (with or without the trailing
// space the picker inserts) removes the whole mention as one unit —
// character-by-character deletion of `@<CJK-name> ` is annoying when the
// user picked the wrong agent. Matches the bus mention regex's charset so
// CJK names work.
const _MENTION_DELETE_RE = /@[A-Za-z0-9_一-鿿-]+ ?$/u;

function _recipientTextareaFromEventTarget(target) {
  if (!target) return null;
  const inputId = target.dataset?.richInputId || target.id || '';
  if (inputId) {
    const input = document.getElementById(inputId);
    if (input) return input;
  }
  return target;
}

function _onMentionBackspace(e) {
  if (e.key !== 'Backspace') return;
  if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
  const ta = _recipientTextareaFromEventTarget(e.currentTarget);
  if (!ta || typeof ta.selectionStart !== 'number') return;
  if (ta.selectionStart !== ta.selectionEnd) return; // user has a selection — let default handle
  const caret = ta.selectionStart;
  if (caret === 0) return;
  const left = ta.value.slice(0, caret);
  const m = _MENTION_DELETE_RE.exec(left);
  if (!m) return;
  const start = caret - m[0].length;
  e.preventDefault();
  ta.value = ta.value.slice(0, start) + ta.value.slice(caret);
  try { ta.setSelectionRange(start, start); } catch (_) {}
  if (typeof autoGrow === 'function') autoGrow(ta, 200);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function _atKeyOpener(chipId) {
  return (e) => {
    if (e.key !== '@') return;
    const btn = document.getElementById(chipId);
    if (!btn) return;
    const ta = _recipientTextareaFromEventTarget(e.currentTarget);
    if (!ta) return;
    setTimeout(() => {
      try {
        if (typeof getChatRichComposerSelection === 'function') getChatRichComposerSelection(ta);
      } catch (_) {}
      _atKeyMark = {
        inputId: ta.id || '',
        posAfter: typeof ta.selectionStart === 'number' ? ta.selectionStart : 0,
      };
      _openAgentPicker(btn);
    }, 0);
  };
}

// Wire (chip → click opens picker) + (textarea → `@` opens picker,
// Backspace deletes whole mention). Guarded with dataset flags so calling
// this twice for the same anchor is a no-op. Called at boot for the three
// sticky composers AND on demand by `modules/auto.js` when its modal
// mounts (registers the 4th `'auto-recipient-chip'` anchor).
function bindRecipientAnchor(chipId, inputId) {
  const btn = document.getElementById(chipId);
  if (btn && btn.dataset.bound !== '1') {
    btn.dataset.bound = '1';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      _atKeyMark = null; // chip click is not a `@`-keystroke trigger
      const picker = document.getElementById('agent-picker');
      if (picker && picker.style.display !== 'none' && picker.dataset.anchorId === chipId) {
        _closeAgentPicker();
      } else {
        _openAgentPicker(btn);
      }
    });
  }
  const ta = document.getElementById(inputId);
  const bindInput = (el) => {
    if (!el || el.dataset.atBound === '1') return;
    el.dataset.atBound = '1';
    el.addEventListener('keydown', _atKeyOpener(chipId));
    el.addEventListener('keydown', _onMentionBackspace);
  };
  bindInput(ta);
  if (typeof getChatRichComposerEditor === 'function') {
    try {
      bindInput(getChatRichComposerEditor(inputId));
    } catch (_) {}
  }
}

if (typeof window !== 'undefined') {
  window.bindRecipientAnchor = bindRecipientAnchor;
  window.refreshAgentPickerContext = refreshAgentPickerContext;
  window.renderChatTaskRefChips = renderChatTaskRefChips;
  window.commitNewChatTaskRefs = commitNewChatTaskRefs;
  window.clearChatTaskRefChips = clearChatTaskRefChips;
  window.updateAgentPickerPlaceholders = updateAgentPickerPlaceholders;
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
