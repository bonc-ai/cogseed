// Connectors panel — curated OAuth-only catalog of MCP-based integrations.
//
// Layout: a single scrollable grid view with two stacked sections — connected on top,
// available below. No tab switching; same shape as the Skills panel's
// Custom / Built-in split. Both groups hide themselves when empty.
//
// Cards with a registered popup use a native title button stretched across the card.
// It opens usage guidance; authorization still requires the explicit Connect action. Other card
// buttons sit above the stretched target and retain their independent actions.
//
// OAuth flow UX: clicking Connect asks main to open the system browser, then the IPC returns
// immediately. The custom-scheme callback finishes exchange + provisioning independently and
// pushes `connectors:oauth-result` back here. **The card itself does NOT stay busy while the user
// is in the browser** — no authorizing badge, no disabled button. Closing/ignoring the browser is
// abandonment, not a connector failure; a second click simply supersedes the earlier flow.

const _connectorsLog = createLogger('connectors');
const _CONNECTORS_RENDER_CACHE_VERSION = 3;
const _CONNECTORS_RENDER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let _connectorsLegacyCachePurged = false;
let _connectorsSearchQuery = '';

function _connectorAttrsHtml(attrs) {
  return Object.entries(attrs || {})
    .filter(([, value]) => value != null && value !== false)
    .map(([key, value]) => ` ${escapeHtml(key)}="${escapeHtml(value === true ? '' : value)}"`)
    .join('');
}

function _connectorUiButton(options) {
  if (typeof uiButton === 'function') return uiButton(options);
  const role = options.role || 'secondary';
  const size = options.size || 'md';
  const classes = `btn ui-button ui-button--${role} ui-button--${size}${options.loading ? ' is-loading' : ''} ${options.className || ''}`;
  const icon = options.icon && typeof uiIconHtml === 'function' ? uiIconHtml(options.icon, 'ui-button__icon') : '';
  return `<button type="button" class="${escapeHtml(classes)}"${options.disabled || options.loading ? ' disabled' : ''}${_connectorAttrsHtml(options.attrs)}>${icon}<span class="ui-button__label">${escapeHtml(options.label)}</span></button>`;
}

function _connectorUiIconButton(options) {
  if (typeof uiIconButton === 'function') return uiIconButton(options);
  const icon = typeof uiIconHtml === 'function' ? uiIconHtml(options.icon, 'ui-icon') : '';
  return `<button type="button" class="ui-icon-button ${escapeHtml(options.className || '')}" aria-label="${escapeHtml(options.label)}" title="${escapeHtml(options.title || options.label)}"${_connectorAttrsHtml(options.attrs)}>${icon}</button>`;
}

function _connectorUiInput(options) {
  if (typeof uiInput !== 'function') throw new Error('connectors require uiInput');
  return uiInput(options);
}

function _connectorUiEmptyState(options) {
  if (typeof uiEmptyState !== 'function') throw new Error('connectors require uiEmptyState');
  return uiEmptyState(options);
}

function _setConnectorButtonPresentation(button, label) {
  if (!button) return;
  const labelEl = button.querySelector('.ui-button__label');
  if (labelEl) labelEl.textContent = label;
  else button.textContent = label;
}

function _connectorsTrackClick(action, data) {
}

function _connectorsTrackEvent(action, data) {
}

function _connectorsTrackError(action, data) {
}

function _connectorTrackPayload(entry, instance) {
  const e = entry || {};
  const inst = instance || {};
  return {
    connector_id: String(e.id || inst.id || ''),
    origin: inst.origin === 'custom' || e._custom ? 'custom' : 'catalog',
    is_bundle: !!(Array.isArray(e.bundle_member_ids) && e.bundle_member_ids.length),
  };
}

function _connectorTrackErrorType(err) {
  const msg = String((err && (err.message || err.error)) || err || '').toLowerCase();
  if (/timeout|timed out/.test(msg)) return 'timeout';
  if (/network|fetch failed|econnreset|econnrefused|eai_again|enotfound/.test(msg)) return 'network';
  if (/cancelled|canceled|superseded/.test(msg)) return 'cancelled';
  if (/auth|grant|scope|oauth/.test(msg)) return 'auth';
  return 'exception';
}

const CONNECT_CANCEL_CODES = new Set(['user_cancelled', 'superseded']);

function _isConnectCancel(errLike) {
  const code = errLike && typeof errLike.code === 'string' ? errLike.code : '';
  if (code && CONNECT_CANCEL_CODES.has(code)) return true;
  const msg = String((errLike && (errLike.error || errLike.message)) || '').toLowerCase();
  return msg.includes('superseded') || msg.includes('cancelled') || msg.includes('canceled');
}

// The commercial build records the terminal outcome at this boundary. The
// open build keeps only the behavior needed to distinguish an intentional
// cancellation from a failure that should be surfaced to the user.
function _reportConnectOutcome(_payload, _startedAt, errLike, _durationMs) {
  return _isConnectCancel(errLike);
}

function _handleConnectFailure(payload, startedAt, errLike) {
  if (_reportConnectOutcome(payload, startedAt, errLike)) return;
  uiAlert(_formatConnectError(errLike));
}

let _connectorsState = {
  catalog: [],
  instances: [],
  loading: false,
  /** Per-card launch flag. It lasts only until main accepts the OAuth request; browser consent,
   *  callback exchange, and MCP startup continue asynchronously. */
  connecting: new Set(),
};
// Correlates the accepted start with a later push so the terminal metric retains click metadata
// and wall duration. Entries intentionally remain when no callback arrives: that is an abandoned
// browser flow, so there is no fabricated terminal result to report.
const _pendingConnectAttempts = new Map();
// Keyed by account as an install may finish after the user switches accounts.
const _connectorRuntimePreparing = new Map();
const _connectorRuntimeErrors = new Map();
function _connectorRuntimeKey(id) { return _connectorsRenderCacheKey() + ':' + id; }
function _connectorRuntimeProgress(entry) { return _connectorRuntimePreparing.get(_connectorRuntimeKey(entry.id)) || entry.runtime_progress; }
function _connectorManagedRuntime(entry) { return ['feishu', 'dingtalk', 'wecom'].includes(entry.id); }
function _connectorRuntimeLabel(progress) {
  const label = t('connectors.runtime.' + progress.phase);
  return progress.phase === 'downloading' && Number.isFinite(progress.percent) ? label + ' ' + progress.percent + '%' : label;
}
let _connectorsLoadSeq = 0;

function _connectorsRenderCacheKey() {
  const uid = (typeof currentUserId === 'string' && currentUserId)
    ? currentUserId
    : ((typeof globalThis.currentUserId === 'string' && globalThis.currentUserId) ? globalThis.currentUserId : 'local');
  return `cogseed.connectors.renderCache.v${_CONNECTORS_RENDER_CACHE_VERSION}.${uid}`;
}

function _purgeLegacyConnectorsRenderCaches() {
  if (_connectorsLegacyCachePurged) return;
  _connectorsLegacyCachePurged = true;
  try {
    const prefix = 'cogseed.connectors.renderCache.v';
    const currentPrefix = `cogseed.connectors.renderCache.v${_CONNECTORS_RENDER_CACHE_VERSION}.`;
    const doomed = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix) && !key.startsWith(currentPrefix)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch (_) { /* localStorage unavailable / quota — skip */ }
}

function _sanitizeConnectorArray(value, options = {}) {
  const arr = Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
  if (!options.dropErrored) return arr;
  return arr.filter((item) => !(item.status && item.status.kind === 'error'));
}

function _hydrateConnectorsRenderCache() {
  if (_connectorsState.catalog.length || _connectorsState.instances.length) return false;
  try {
    const raw = localStorage.getItem(_connectorsRenderCacheKey());
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== _CONNECTORS_RENDER_CACHE_VERSION) return false;
    if (Date.now() - Number(parsed.updated_at || 0) > _CONNECTORS_RENDER_CACHE_TTL_MS) return false;
    const catalog = _sanitizeConnectorArray(parsed.catalog);
    const instances = _sanitizeConnectorArray(parsed.instances, { dropErrored: true });
    if (!catalog.length && !instances.length) return false;
    _connectorsState.catalog = catalog;
    _connectorsState.instances = instances;
    return true;
  } catch (_) {
    return false;
  }
}

function _persistConnectorsRenderCache() {
  if (!_connectorsState.catalog.length && !_connectorsState.instances.length) return;
  try {
    localStorage.setItem(_connectorsRenderCacheKey(), JSON.stringify({
      version: _CONNECTORS_RENDER_CACHE_VERSION,
      updated_at: Date.now(),
      catalog: _connectorsState.catalog.map(({ runtime_progress, ...entry }) => entry),
      instances: _sanitizeConnectorArray(_connectorsState.instances, { dropErrored: true }),
    }));
  } catch (_) { /* localStorage unavailable / quota — skip */ }
}

async function loadConnectors() {
  const seq = ++_connectorsLoadSeq;
  _purgeLegacyConnectorsRenderCaches();
  _hydrateConnectorsRenderCache();
  _connectorsState.loading = true;
  _renderConnectorsGrid();
  try {
    const [catRes, listRes] = await Promise.all([
      window.cogseed.invoke('connectors.catalog', {}).catch((err) => ({ ok: false, error: err })),
      window.cogseed.invoke('connectors.list', {}).catch((err) => ({ ok: false, error: err })),
    ]);
    if (seq !== _connectorsLoadSeq) return;
    if (catRes && catRes.ok && Array.isArray(catRes.catalog)) {
      _connectorsState.catalog = catRes.catalog;
    } else {
      _connectorsLog.warn('catalog failed', { error: catRes && (catRes.error && catRes.error.message || catRes.error) });
    }
    if (listRes && listRes.ok && Array.isArray(listRes.instances)) {
      _connectorsState.instances = listRes.instances;
    } else {
      _connectorsLog.warn('list failed', { error: listRes && (listRes.error && listRes.error.message || listRes.error) });
    }
    _persistConnectorsRenderCache();
  } catch (err) {
    _connectorsLog.warn('list failed', { error: err && err.message });
  } finally {
    if (seq === _connectorsLoadSeq) {
      _connectorsState.loading = false;
      _renderConnectorsGrid();
    }
  }
}

/** Re-verify installed connectors on panel entry, then re-render with the real outcome.
 *
 *  Deliberately NOT awaited by `loadConnectors`: verification opens real connections and can take
 *  seconds, and the panel must paint immediately from persisted state. Cards start on their last
 *  known status and settle onto the verified one — a dead connector flips to the amber
 *  "未验证 · <reason>" card instead of sitting there green forever.
 *
 *  Cost is bounded in the manager (`verifyUsableConnectors`), not here: rows with a live connection
 *  or a recent successful connect are skipped, and concurrent runs coalesce. Fire-and-forget is
 *  safe — a failure just leaves the persisted status on screen. */
async function verifyConnectors() {
  const seq = _connectorsLoadSeq;
  try {
    const res = await window.cogseed.invoke('connectors.verify', {});
    // A newer load superseded us — its own verify pass owns the screen now.
    if (seq !== _connectorsLoadSeq) return;
    if (res && res.ok && Array.isArray(res.instances)) {
      _connectorsState.instances = res.instances;
      _persistConnectorsRenderCache();
      _renderConnectorsGrid();
    }
  } catch (err) {
    _connectorsLog.warn('connector verification failed', { error: (err && err.message) || String(err) });
  }
}

function _instanceById(id) {
  return _connectorsState.instances.find((i) => i.id === id) || null;
}

// Build a synthetic ConnectorInstance for a bundle entry. Bundle entries have no real instance
// (manager.connectViaOAuth provisions the N members instead) — but the renderer treats the
// bundle as a single card, so we derive an instance-shaped object: status=connected iff all
// members connected; account_label / enabled taken from the first member that has them.
function _deriveBundleInstance(entry) {
  const members = (entry.bundle_member_ids || []).map((id) => _instanceById(id)).filter(Boolean);
  if (!members.length) return null;  // no member installed yet → bundle shows as "available"
  const allConnected = members.length === entry.bundle_member_ids.length
    && members.every((m) => m.status && m.status.kind === 'connected');
  const anyErrored = members.find((m) => m.status && m.status.kind === 'error');
  // One unverified member makes the whole bundle unverified — a bundle card that claims "已连接"
  // while one of its five members can't reach its backend is the same lie at bundle scope.
  const anyDegraded = members.find((m) => m.status && m.status.kind === 'degraded');
  const accountLabel = members.map((m) => m.oauth_grant && m.oauth_grant.account_label).find(Boolean) || '';
  // For enabled: bundle is "enabled" iff every member is enabled (any disabled → show Enable).
  const allEnabled = members.every((m) => m.enabled !== false);
  return {
    id: entry.id,
    display_name: entry.display_name,
    status: allConnected
      ? { kind: 'connected', since: 0 }
      : (anyErrored
        ? { kind: 'error', message: anyErrored.status.message, at: 0 }
        : (anyDegraded
          ? {
            kind: 'degraded',
            message: anyDegraded.status.message,
            at: 0,
            last_verified_at: anyDegraded.status.last_verified_at,
          }
          : { kind: 'connecting' })),
    oauth_grant: accountLabel ? { account_label: accountLabel } : undefined,
    enabled: allEnabled,
    // Bundle marker so the click handlers fan out to all members.
    _bundle_member_ids: entry.bundle_member_ids,
  };
}

// True iff this connector id is verified live (last attempt succeeded + not user-disabled).
// Mirrors the main-side `resolveVisibleConnectors` filter so a queue-draft drained after the
// user disconnects / disables the connector can detect the dangling reference and degrade the
// message to plain text instead of injecting a `use <connector>` prefix the bus can't honor.
//
// `degraded` is deliberately NOT live here even though the main side still routes it: the LLM may
// retry a degraded connector (that is what heals it), but we must not advertise one to the *user*
// as ready, nor pin a composer draft to it.
function isConnectorLive(id) {
  const inst = _instanceById(id);
  return !!(inst && inst.status && inst.status.kind === 'connected' && inst.enabled !== false);
}

function _isReconnectableError(entry, instance) {
  return !!(
    entry
    && entry.transport_template
    && instance
    && instance.status
    && instance.status.kind === 'error'
  );
}

function _isConnectorVisibleDisabled(entry) {
  return !!(entry && entry.availability === 'visible_disabled');
}

/** Machine-dependent unavailability: the provider's own local CLI is not installed on this
 *  machine. Deliberately distinct from the remote-config `unsupported` case — that one means the
 *  provider will never work here, while this one is fixable by the user, so it must not be
 *  reported with the generic 暂不支持 copy. */
function _isConnectorCliMissing(entry) {
  return _isConnectorVisibleDisabled(entry) && entry.disabled_reason === 'cli_missing';
}

function _showConnectorUnsupportedToast() {
  const message = t('connectors.toast.unsupported');
  if (typeof uiToast === 'function') uiToast(message, { variant: 'warning' });
  else uiAlert(message);
}

function _showConnectorCliMissingToast(entry) {
  const message = t(entry && _connectorManagedRuntime(entry) ? 'connectors.runtime.platform_unavailable' : 'connectors.toast.cli_missing');
  if (typeof uiToast === 'function') uiToast(message, { variant: 'warning' });
  else uiAlert(message);
}

/** Single entry point for a card / detail action that cannot run because the provider is
 *  unavailable — keeps the CLI-missing branch ahead of the generic unsupported path. */
function _showConnectorUnavailableToast(entry) {
  if (_isConnectorCliMissing(entry)) _showConnectorCliMissingToast(entry);
  else _showConnectorUnsupportedToast();
}

function _connectorErrorFallback(kind) {
  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  const zh = String(lang).startsWith('zh');
  const ja = String(lang).startsWith('ja');
  if (kind === 'network') {
    if (zh) return '暂时无法连接，请稍后重试';
    if (ja) return '一時的に接続できません。しばらくしてから再試行してください';
    return 'Temporarily unable to connect. Please try again later.';
  }
  if (kind === 'reconnect') {
    if (zh) return '授权已失效，请重新连接';
    if (ja) return '認証の有効期限が切れました。再接続してください';
    return 'Authorization expired. Please reconnect.';
  }
  return '';
}

function _formatConnectorStatusError(message) {
  if (/^survey_[a-z_]+$/.test(String(message || ''))) return t('connectors.survey.' + message);
  const emailCode = String(message || '').match(/\bemail_[a-z_]+\b/);
  if (emailCode) {
    const key = 'connectors.email.' + emailCode[0];
    const value = t(key);
    return value !== key ? value : t('connectors.email.email_connection_failed');
  }
  const msg = String(message || '');
  if (/fetch failed|network|timeout|timed out|econnreset|econnrefused|eai_again|enotfound|socket|connection (closed|reset|dropped)|terminated|\brefresh_failed\b|刷新授权失败|failed to refresh authorization|認証の更新に失敗|Falha ao atualizar a autorização/i.test(msg)) {
    return _connectorErrorFallback('network');
  }
  if (/invalid_grant|connector_reconnect_required|reconnect required|grant not found|授权已失效|Authorization expired|認証の有効期限|A autorização expirou/i.test(msg)) {
    return _connectorErrorFallback('reconnect');
  }
  // The provider answered, and its answer was "this credential is no good". Mapped to an
  // instruction instead of the raw JSON the MCP client relays.
  if (_isCredentialRejection(msg)) return t('connectors.errors.credential_rejected');
  return msg;
}

/** "上次验证 5 天前" for a degraded card. Returns '' when we never recorded a successful connect
 *  (nothing truthful to say) so the caller falls back to the reason alone. */
function _formatLastVerified(ts) {
  const at = Number(ts) || 0;
  if (!at) return '';
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return t('connectors.status.verified_just_now');
  if (mins < 60) return t('connectors.status.verified_minutes_ago', { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('connectors.status.verified_hours_ago', { n: hours });
  return t('connectors.status.verified_days_ago', { n: Math.floor(hours / 24) });
}

function listUsableConnectorsForPicker() {
  const catalogById = new Map((_connectorsState.catalog || []).map((entry) => [entry.id, entry]));
  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  return (_connectorsState.instances || [])
    .filter((inst) => inst && inst.status && inst.status.kind === 'connected' && inst.enabled !== false)
    .map((inst) => {
      const entry = catalogById.get(inst.id) || _entryFromInstance(inst);
      const account = inst.oauth_grant && inst.oauth_grant.account_label ? inst.oauth_grant.account_label : '';
      return {
        id: inst.id,
        name: inst.display_name || entry.display_name || inst.id,
        description: pickDesc(entry, lang),
        account,
      };
    })
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base', numeric: true }));
}

// Brand color hex per PC/docs/design/README §Surface E. Used as background
// for the 32×32 letter square in `_renderCatalogCard` when no `icon_svg` is
// shipped. Lookup is by `entry.id` (catalog id, stable across releases) with
// a graphite fallback for unknown ids.
const _CONNECTOR_BRAND_TINT = {
  github: '#16181d',
  notion: '#000000',
  gmail: '#ea4335',
  linear: '#5e6ad2',
  slack: '#4a154b',
  gcal: '#4285f4',
  'google-calendar': '#4285f4',
  jira: '#0052cc',
  figma: '#0acf83',
  drive: '#4285f4',
  'google-drive': '#4285f4',
  'google-workspace': '#4285f4',
};

function _ensureConnectorsToolbar() {
  const searchHost = document.getElementById('connectors-search-field');
  if (searchHost) {
    let input = searchHost.querySelector('#connectors-search-input');
    if (!input) {
      searchHost.innerHTML = `${uiIconHtml('search', 'connectors-search-icon')}${_connectorUiInput({
        id: 'connectors-search-input',
        type: 'search',
        value: _connectorsSearchQuery,
        placeholder: t('connectors.search_placeholder'),
        attrs: { autocomplete: 'off', spellcheck: 'false' },
      })}`;
      if (typeof hydrateUiIcons === 'function') hydrateUiIcons(searchHost);
      input = searchHost.querySelector('#connectors-search-input');
    }
    if (input) {
      input.placeholder = t('connectors.search_placeholder');
      if (input.dataset.connectorsSearchBound !== 'true') {
        input.dataset.connectorsSearchBound = 'true';
        input.addEventListener('input', () => {
          _connectorsSearchQuery = input.value || '';
          _renderConnectorsGrid();
        });
      }
    }
  }

  const actionsHost = document.getElementById('connectors-page-header-actions');
  if (actionsHost && !actionsHost.querySelector('#connectors-add-custom-btn')) {
    actionsHost.innerHTML = _connectorUiButton({
      label: t('connectors.action.add_custom'),
      role: 'secondary',
      size: 'sm',
      attrs: { id: 'connectors-add-custom-btn' },
    });
  }
  const addBtn = document.getElementById('connectors-add-custom-btn');
  _setConnectorButtonPresentation(addBtn, t('connectors.action.add_custom'));
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', () => {
      _connectorsTrackClick('connector_custom_open', {});
      _openAddCustomDialog();
    });
  }
}

function _connectorMatchesSearch(item, query, lang) {
  if (!query) return true;
  const entry = item && item.entry ? item.entry : {};
  const instance = item && item.instance ? item.instance : {};
  const haystack = [
    entry.display_name,
    entry.id,
    pickDesc(entry, lang),
    instance.account_label,
    instance.display_name,
  ].filter(Boolean).join(' ').toLocaleLowerCase();
  return haystack.includes(query);
}

function _renderConnectorsEmptyState(empty, kind) {
  if (!empty) return;
  const noMatch = kind === 'no-match';
  empty.innerHTML = _connectorUiEmptyState(noMatch ? {
    kind: 'actionable',
    icon: 'search',
    title: t('connectors.no_match'),
    hint: t('connectors.no_match_hint'),
    action: { label: t('common.clear'), role: 'secondary', attrs: { 'data-connectors-clear-search': true } },
  } : {
    kind: 'quiet',
    title: kind === 'loading' ? t('common.loading') : t('connectors.empty'),
  });
  empty.style.display = '';
  empty.querySelector('[data-connectors-clear-search]')?.addEventListener('click', () => {
    _connectorsSearchQuery = '';
    const input = document.getElementById('connectors-search-input');
    if (input) input.value = '';
    _renderConnectorsGrid();
  });
}

// Enterprise integrations and Tencent Meeting lead the available
// inventory. Keep the policy on stable catalog ids so localization cannot change membership.
const _CONNECTOR_AVAILABLE_FEATURED_IDS = new Set([
  'email-163', 'email-qq', 'email-enterprise', 'tencent-survey', 'tencent-meeting',
  'tencent-docs', 'feishu', 'dingtalk', 'wecom', 'wps',
]);

function _renderConnectorsGrid() {
  const gridView = document.getElementById('connectors-grid-view');
  if (!gridView) return;
  // Keep the grid and any open usage popup consistent when a connection or recovery settles.
  gridView.style.display = '';
  _ensureConnectorsToolbar();

  const groupConn = document.getElementById('connectors-group-connected');
  const groupAvail = document.getElementById('connectors-group-available');
  const gridConn = document.getElementById('connectors-grid-connected');
  const gridAvail = document.getElementById('connectors-grid-available');
  const empty = document.getElementById('connectors-empty');

  // Bundle handling — entries with `bundle_member_ids` are UI groupings. Members are hidden
  // (they don't show as separate cards) so the user sees one card per logical product.
  const bundleMemberIds = new Set();
  for (const entry of _connectorsState.catalog) {
    if (Array.isArray(entry.bundle_member_ids)) {
      for (const m of entry.bundle_member_ids) bundleMemberIds.add(m);
    }
  }

  // Partition catalog rows by whether there's a corresponding installed instance.
  //
  // `degraded` rows group here alongside `connected` ones: they are installed and authorized, and
  // a momentary backend 5xx must not yank every card down into "可用" and back. They are *not*
  // presented as connected — `_renderCatalogCard` gives them the unverified treatment (reason +
  // staleness + 重试). Grouping answers "is it installed"; the card answers "does it work".
  const connectedItems = [];
  const availableItems = [];
  for (const entry of _connectorsState.catalog) {
    if (bundleMemberIds.has(entry.id)) continue;  // hide bundle members
    let inst = _instanceById(entry.id);
    // For bundle entries: derive a synthetic "connected" instance when ALL members are
    // connected. The synthetic instance shape mirrors a real one so `_renderCatalogCard`
    // doesn't care it's a bundle.
    if (Array.isArray(entry.bundle_member_ids)) {
      inst = _deriveBundleInstance(entry);
    }
    if (inst && inst.status && (inst.status.kind === 'connected' || inst.status.kind === 'degraded')) {
      connectedItems.push({ entry, instance: inst });
    } else {
      availableItems.push({ entry, instance: inst });
    }
  }
  // Custom MCP instances have no catalog entry — render them from the
  // instance itself (derived entry carries the `_custom` marker so the card
  // renderer swaps OAuth actions for remove-only handling).
  for (const inst of _connectorsState.instances) {
    if (!inst || inst.origin !== 'custom') continue;
    const item = { entry: _entryFromInstance(inst), instance: inst };
    if (inst.status && (inst.status.kind === 'connected' || inst.status.kind === 'degraded')) connectedItems.push(item);
    else availableItems.push(item);
  }
  // Connected inventory remains A→Z; available inventory leads with enterprise integrations,
  // then uses the same name ordering within each tier.
  const cmp = (a, b) => (a.entry.display_name || '').localeCompare(b.entry.display_name || '', undefined, { sensitivity: 'base', numeric: true });
  connectedItems.sort(cmp);
  availableItems.sort((a, b) => Number(_CONNECTOR_AVAILABLE_FEATURED_IDS.has(b.entry.id))
    - Number(_CONNECTOR_AVAILABLE_FEATURED_IDS.has(a.entry.id)) || cmp(a, b));
  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  const query = _connectorsSearchQuery.trim().toLocaleLowerCase();
  const visibleConnectedItems = connectedItems.filter((item) => _connectorMatchesSearch(item, query, lang));
  const visibleAvailableItems = availableItems.filter((item) => _connectorMatchesSearch(item, query, lang));

  // Render each group.
  gridConn.innerHTML = '';
  for (const it of visibleConnectedItems) gridConn.appendChild(_renderCatalogCard(it.entry, it.instance));
  groupConn.style.display = visibleConnectedItems.length ? '' : 'none';

  gridAvail.innerHTML = '';
  for (const it of visibleAvailableItems) gridAvail.appendChild(_renderCatalogCard(it.entry, it.instance));
  groupAvail.style.display = visibleAvailableItems.length ? '' : 'none';

  if (_connectorsState.loading && !_connectorsState.catalog.length) {
    _renderConnectorsEmptyState(empty, 'loading');
  } else if (!connectedItems.length && !availableItems.length) {
    _renderConnectorsEmptyState(empty, 'empty');
  } else if (!visibleConnectedItems.length && !visibleAvailableItems.length) {
    _renderConnectorsEmptyState(empty, 'no-match');
  } else {
    empty.style.display = 'none';
  }

  // Visible counts follow the active search, matching the cards currently shown.
  const connCountEl = document.getElementById('connectors-group-connected-count');
  if (connCountEl) connCountEl.textContent = visibleConnectedItems.length > 0 ? String(visibleConnectedItems.length) : '';
  const availCountEl = document.getElementById('connectors-group-available-count');
  if (availCountEl) availCountEl.textContent = visibleAvailableItems.length > 0 ? String(visibleAvailableItems.length) : '';

  if (_connectorPopupState) _renderConnectorPopup();
}

function _renderCatalogCard(entry, instance) {
  const e = entry || _entryFromInstance(instance);
  const isOAuthPending = !!(e && e.unavailable_reason === 'oauth_pending');
  const isVisibleDisabled = _isConnectorVisibleDisabled(e);
  const connected = !!(instance && instance.status && instance.status.kind === 'connected');
  const errored = !!(instance && instance.status && instance.status.kind === 'error');
  // Authorized + cached, but the last connect/refresh failed. Stays in this group (a 30s backend
  // blip must not reshuffle every card out of the list) but must never render as connected: the
  // card states the reason and how stale it is, and offers 重试 instead of 使用.
  const degraded = !!(instance && instance.status && instance.status.kind === 'degraded');
  // `enabled` is per-user soft state attached by `connectors.list` IPC. Only meaningful for
  // connected cards (un-connected ones have nothing to disable). Default true when missing.
  const enabledFlag = instance && Object.prototype.hasOwnProperty.call(instance, 'enabled')
    ? !!instance.enabled
    : true;

  const card = document.createElement('div');
  card.className = `connector-card ui-resource-card${connected && !enabledFlag ? ' is-disabled' : ''}${degraded ? ' is-unverified' : ''}`;
  card.dataset.id = e.id;
  const hasDetail = !!_connectorHasPopup(e.id);
  if (hasDetail) card.classList.add('has-detail');
  const cardName = e.auth_mode === 'credentials' ? t('connectors.email.' + e.id) : e.display_name;
  const nameHtml = hasDetail ? _connectorUiButton({
    label: cardName,
    role: 'ghost',
    className: 'connector-card-popup-entry',
    attrs: { 'data-act': 'open-popup', 'aria-label': `${cardName} · ${t('connectors.action.details')}`, 'aria-haspopup': 'dialog', 'aria-controls': 'connector-use-popup' },
  }) : escapeHtml(cardName);

  // Brand-color square per design (Surface E) — applied ONLY to the
  // fallback letter glyph (no icon_svg shipped). When a real icon_svg is
  // present, the SVG carries its own brand colors and a dark tint behind
  // it can swallow monochrome marks (GitHub `fill:#181717` on `#16181d`,
  // Notion `fill:#000` on `#000`, etc.) — the SVG sits on the card's own
  // surface instead.
  const brandTint = _CONNECTOR_BRAND_TINT[e.id] || '#16181d';
  const safeIconSvg = typeof sanitizeSvgIconHtml === 'function' ? sanitizeSvgIconHtml(e.icon_svg) : '';
  const iconHtml = e.icon_name ? `<div class="connector-card-icon is-svg">${uiIconHtml(e.icon_name)}</div>` : safeIconSvg
    ? `<div class="connector-card-icon is-svg">${safeIconSvg}</div>`
    : `<div class="connector-card-icon is-fallback" style="background:${brandTint}">${escapeHtml((e.display_name || '?').slice(0, 1).toUpperCase())}</div>`;
  // Custom cards have no authored description — show the server summary
  // (url / command) so the user can tell their entries apart.
  const desc = e._custom
    ? _customTransportSummary(instance)
    : pickDesc(e, (typeof getLang === 'function') ? getLang() : 'en');

  // Every live card starts with the same status; only actual account metadata follows it.
  const accountLabel = String((instance && instance.email_settings && instance.email_settings.address)
    || (instance && instance.oauth_grant && instance.oauth_grant.account_label) || '').trim();
  const connectedLabel = t('connectors.group.connected');
  const connectedText = accountLabel ? `${connectedLabel} · ${accountLabel}` : connectedLabel;
  // Routed through the formatter: the raw vendor string ("Streamable HTTP error: Error POSTing to
  // endpoint: {"error":"invalid_token",…}") names no cause and no next step.
  const errorMsg = errored && instance && instance.status
    ? _formatConnectorStatusError(instance.status.message)
    : '';
  const degradedMsg = degraded && instance && instance.status && instance.status.message;
  const degradedSince = degraded && instance && instance.status
    ? instance.status.last_verified_at
    : 0;

  // The ⋯ menu lives on installed cards — it hosts the destructive disconnect action so it stays
  // one click away from accidental triggers. Un-connected / errored cards still surface the
  // disconnect action as a bottom-row button (they need it visible to recover; the disable toggle
  // doesn't apply when there's nothing to disable). Degraded cards keep the menu because their
  // bottom-row action is retry, while disconnect still needs to remain reachable.
  const menuHtml = (connected || degraded)
    ? _connectorUiIconButton({
        label: t('common.more'),
        icon: 'more-horizontal',
        className: 'connector-card-menu-btn',
        attrs: { 'data-act': 'menu', 'aria-expanded': 'false' },
      })
    : '';

  // Bottom-row action:
  //   - connecting (this card is in `_connectorsState.connecting`): show spinner — overrides
  //     every other state. Without this, a bundle finishes its 5-member install in ~0.7s
  //     of stdio MCP handshakes; the card flips from "available" to "connected" section
  //     before `_runConnect`'s `finally` clears the connecting flag, and the user sees
  //     the spinner vanish "the moment they return from the browser" even though the
  //     IPC chain (loadConnectors + grid re-render) is still finishing.
  //   - connected: use in the Commander composer; enable / disable lives in the ⋯ menu
  //   - errored:   disconnect (recover from a stuck error state)
  //   - oauth_pending: disabled unavailable button
  //   - default (uninstalled): connect (start OAuth)
  let action = '';
  const isSurveyAuthorizing = e.id === 'tencent-survey' && _surveyAuthorizing;
  const isConnecting = isSurveyAuthorizing || (_connectorsState.connecting && _connectorsState.connecting.has(e.id));
  const runtimeProgress = _connectorRuntimeProgress(e);
  if (runtimeProgress) {
    action = _connectorUiButton({ label: _connectorRuntimeLabel(runtimeProgress), role: 'primary', size: 'sm', icon: 'download', loading: true, attrs: { 'data-act': 'runtime-progress' } })
      + _connectorUiButton({ label: t('common.cancel'), role: 'secondary', size: 'sm', attrs: { 'data-act': 'cancel-runtime' } });
  } else if (isConnecting) {
    action = _connectorUiButton({ label: t('connectors.action.connecting'), role: 'primary', size: 'sm', loading: true, attrs: { 'data-act': 'connect' } });
  } else if (isOAuthPending) {
    action = _connectorUiButton({ label: t('connectors.action.unavailable'), role: 'secondary', size: 'sm', disabled: true });
  } else if (_isConnectorCliMissing(e) && e.runtime_installable) {
    action = _connectorUiButton({ label: t(_connectorRuntimeErrors.has(_connectorRuntimeKey(e.id)) ? 'connectors.runtime.retry' : 'connectors.runtime.install_connect'), role: 'primary', size: 'sm', icon: 'download', attrs: { 'data-act': 'connect' } });
  } else if (isVisibleDisabled) {
    action = _connectorUiButton({ label: t('connectors.action.connect'), role: 'primary', size: 'sm', icon: 'plug', attrs: { 'data-act': 'unsupported-connect' } });
  } else if (connected) {
    const useTitle = formatChatUseLabel({ kind: 'connector', id: e.id, name: e.display_name || e.id });
    action = _connectorUiButton({ label: t('common.use'), role: 'primary', size: 'sm', className: 'connector-card-use', disabled: !enabledFlag, attrs: { 'data-act': 'use-connector', title: useTitle } });
    if (e.auth_mode === 'credentials') action += _connectorUiButton({ label: t('connectors.email.edit'), role: 'secondary', size: 'sm', attrs: { 'data-act': 'connect' } });
  } else if (degraded) {
    // Retry re-runs connect + token refresh (`connectors.refresh`) — NOT OAuth. The grant is fine;
    // what failed was reaching the backend. Offering "连接" here would send the user through a
    // pointless re-authorization for what is usually a server-side outage.
    action = _connectorUiButton({ label: t('connectors.action.retry'), role: 'primary', size: 'sm', icon: 'refresh', attrs: { 'data-act': 'retry-degraded' } });
  } else if (e._custom) {
    // Custom server, not connected: retry probes the stored transport
    // (`connectors.refresh`), never OAuth. Disconnect stays available so a
    // dead entry can be removed.
    action = `
      ${_connectorUiButton({ label: t('connectors.action.retry'), role: 'secondary', size: 'sm', icon: 'refresh', attrs: { 'data-act': 'retry-custom' } })}
      ${_connectorUiButton({ label: t('connectors.action.disconnect'), role: 'danger', size: 'sm', attrs: { 'data-act': 'disconnect' } })}`;
  } else if (e.auth_mode === 'credentials' && instance) {
    action = _connectorUiButton({ label: t('connectors.action.retry'), role: 'secondary', size: 'sm', icon: 'refresh', attrs: { 'data-act': 'retry-custom' } })
      + _connectorUiButton({ label: t('connectors.email.edit'), role: 'primary', size: 'sm', attrs: { 'data-act': 'connect' } })
      + _connectorUiButton({ label: t('connectors.action.disconnect'), role: 'danger', size: 'sm', attrs: { 'data-act': 'disconnect' } });
  } else if (_isReconnectableError(e, instance)) {
    action = _connectorUiButton({ label: t('connectors.action.connect'), role: 'primary', size: 'sm', icon: 'plug', attrs: { 'data-act': 'connect' } });
  } else if (errored) {
    action = _connectorUiButton({ label: t('connectors.action.disconnect'), role: 'danger', size: 'sm', attrs: { 'data-act': 'disconnect' } });
  } else {
    action = _connectorUiButton({ label: t('connectors.action.connect'), role: 'primary', size: 'sm', icon: 'plug', attrs: { 'data-act': 'connect' } });
  }

  if (isSurveyAuthorizing) {
    action += _connectorUiButton({ label: t('common.cancel'), role: 'secondary', size: 'sm', attrs: { 'data-act': 'cancel-survey-auth' } });
    if (_connectorAuthorizationUrl && _connectorAuthorizationUrl.catalog_id === e.id) action += _connectorUiButton({ label: t('connectors.survey.copy_link'), role: 'ghost', size: 'sm', attrs: { 'data-act': 'copy-auth-url' } });
  }

  let secondaryHtml = '';
  if (errorMsg) {
    secondaryHtml = '<div class="connector-card-error"></div>';
  } else if (degradedMsg) {
    secondaryHtml = '<div class="connector-card-unverified"></div>';
  } else if (_isConnectorCliMissing(e)) {
    // The reason is machine-dependent and actionable, so it replaces the account line rather
    // than hiding behind the generic "unsupported" toast.
    const runtimeText = runtimeProgress ? _connectorRuntimeLabel(runtimeProgress) : _connectorRuntimeErrors.get(_connectorRuntimeKey(e.id)) || t(e.runtime_installable ? 'connectors.runtime.required' : 'connectors.runtime.platform_unavailable');
    secondaryHtml = _connectorManagedRuntime(e)
      ? uiStatusDot({ label: runtimeText, tone: _connectorRuntimeErrors.has(_connectorRuntimeKey(e.id)) ? 'attention' : 'idle', className: 'connector-card-runtime connector-card-account', attrs: { title: runtimeText, 'aria-live': 'polite' } })
      : '<div class="connector-card-cli-missing muted"></div>';
  } else if (connected) {
    secondaryHtml = uiStatusDot({ label: connectedText, tone: 'success', className: 'connector-card-account', attrs: { title: connectedText } });
  }

  card.innerHTML = `
    <div class="connector-card-top">
      ${iconHtml}
      <div class="connector-card-headline">
        <div class="connector-card-name">${nameHtml}</div>
        ${secondaryHtml}
      </div>
      ${menuHtml}
    </div>
    <div class="connector-card-desc muted"></div>
    <div class="connector-card-foot">${action}</div>
  `;
  card.querySelector('.connector-card-desc').textContent = desc;
  if (errorMsg) {
    const el = card.querySelector('.connector-card-error');
    const text = `${t('connectors.status.error')}: ${_formatConnectorStatusError(errorMsg)}`;
    el.textContent = text;
    el.title = text;
  } else if (degradedMsg) {
    const el = card.querySelector('.connector-card-unverified');
    const stale = _formatLastVerified(degradedSince);
    const text = stale
      ? `${t('connectors.status.unverified')} · ${stale}: ${_formatConnectorStatusError(degradedMsg)}`
      : `${t('connectors.status.unverified')}: ${_formatConnectorStatusError(degradedMsg)}`;
    el.textContent = text;
    el.title = text;
  } else if (_isConnectorCliMissing(e) && !_connectorManagedRuntime(e)) {
    const el = card.querySelector('.connector-card-cli-missing');
    const text = t('connectors.tencent.runtime_unavailable');
    el.textContent = text;
    el.title = text;
  }

  card.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'open-popup') _openConnectorPopup(e, instance);
      else if (act === 'cancel-runtime') window.cogseed.invoke('connectors.cancel_runtime', { catalog_id: e.id }).catch(() => uiAlert(t('connectors.runtime.failed')));
      else if (act === 'cancel-survey-auth') window.cogseed.invoke('connectors.cancel_oauth', { catalog_id: e.id }).catch(err => uiAlert(_formatConnectError(err)));
      else if (act === 'copy-auth-url') _copyConnectorAuthorizationUrl(e);
      else if (act === 'connect') _runConnect(e);
      else if (act === 'unsupported-connect') _showConnectorUnavailableToast(e);
      else if (act === 'disconnect') _quickDisconnect(e, instance);
      else if (act === 'menu') _openCardMenu(btn, e, instance);
      else if (act === 'use-connector' && enabledFlag) _useConnector(e, instance);
      else if (act === 'retry-custom') _retryConnect(e, 'connector_custom_retry');
      else if (act === 'retry-degraded') _retryConnect(e, 'connector_degraded_retry');
    });
  });
  return card;
}

// Tiny absolute-positioned popover anchored under the ⋯ button — one disconnect item for now.
// Closes on outside click / Esc / window scroll. Keeping it inline so we don't pull in a generic
// menu primitive for one use site; if a second connector-card menu item ever lands, refactor.
function _clearConnectorCardMenuState() {
  document.querySelectorAll('.connector-card.is-menu-open').forEach((card) => card.classList.remove('is-menu-open'));
  document.querySelectorAll('.connector-card-menu-btn[aria-expanded="true"]').forEach((btn) => {
    btn.setAttribute('aria-expanded', 'false');
  });
}

function _openCardMenu(anchorBtn, entry, instance) {
  const card = anchorBtn.closest('.connector-card');
  const openCard = document.querySelector('.connector-card.is-menu-open');
  const existing = document.querySelector('.connector-card-menu-popover');
  if (existing) {
    existing.remove();
    _clearConnectorCardMenuState();
    if (openCard === card) return;
  }
  if (card) card.classList.add('is-menu-open');
  anchorBtn.setAttribute('aria-expanded', 'true');
  const rect = anchorBtn.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'connector-card-menu-popover';
  pop.style.top = '-9999px';
  pop.style.left = '-9999px';
  const enabledFlag = instance && Object.prototype.hasOwnProperty.call(instance, 'enabled')
    ? !!instance.enabled
    : true;
  const toggleLabel = enabledFlag ? t('component.disable') : t('component.enable');
  pop.innerHTML = `
    ${_connectorUiButton({ label: toggleLabel, role: 'ghost', size: 'sm', className: 'connector-card-menu-item', attrs: { 'data-act': 'toggle-enabled' } })}
    ${_connectorUiButton({ label: t('connectors.action.disconnect'), role: 'danger', size: 'sm', className: 'connector-card-menu-item', attrs: { 'data-act': 'disconnect' } })}
  `;
  document.body.appendChild(pop);
  const popRect = pop.getBoundingClientRect();
  const margin = 8;
  let left = rect.right - popRect.width;
  let top = rect.bottom + 6;
  if (left < margin) left = margin;
  if (left + popRect.width > window.innerWidth - margin) left = window.innerWidth - popRect.width - margin;
  if (top + popRect.height > window.innerHeight - margin) top = rect.top - popRect.height - 6;
  if (top < margin) top = margin;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;

  const close = () => {
    pop.remove();
    _clearConnectorCardMenuState();
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', close, true);
  };
  const onOutside = (ev) => { if (!pop.contains(ev.target) && ev.target !== anchorBtn) close(); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', close, true);

  pop.querySelectorAll('[data-act]').forEach((item) => {
    item.addEventListener('click', () => {
      close();
      const act = item.dataset.act;
      if (act === 'disconnect') _quickDisconnect(entry, instance);
      else if (act === 'toggle-enabled') _toggleConnectorEnabled(entry, instance, !enabledFlag);
    });
  });
}

function _useConnector(entry, instance, prefill) {
  if (!instance || !instance.status || instance.status.kind !== 'connected' || instance.enabled === false) return;
  const id = String((instance && instance.id) || (entry && entry.id) || '').trim();
  const name = String((instance && instance.display_name) || (entry && entry.display_name) || id).trim();
  if (!id && !name) return;
  _connectorsTrackClick('connector_use', { ..._connectorTrackPayload(entry, instance), connector_id: id || name });
  setView('new-chat');
  if (typeof setChatRecipient === 'function') {
    setChatRecipient('new-chat', { kind: 'commander' });
  }
  if (prefill !== undefined) {
    const input = document.getElementById('new-chat-input');
    if (input) {
      input.value = prefill;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  setChatConnector('new-chat', id || name, name || id);
  setTimeout(() => document.getElementById('new-chat-input')?.focus(), 50);
}

async function _toggleConnectorEnabled(entry, instance, nextEnabled, reportError = uiAlert) {
  // Bundle entry: fan out the toggle to every member id; bundle itself isn't an instance.
  const ids = Array.isArray(entry.bundle_member_ids) && entry.bundle_member_ids.length
    ? entry.bundle_member_ids.slice()
    : [(instance && instance.id) || entry.id];
  const payload = {
    ..._connectorTrackPayload(entry, instance),
    enabled: !!nextEnabled,
    instance_count: ids.length,
  };
  const startedAt = performance.now();
  _connectorsTrackClick('connector_enable_toggle', payload);
  try {
    for (const id of ids) {
      const res = await window.cogseed.invoke('connectors.set_enabled', { id, enabled: nextEnabled });
      if (!res || !res.ok) {
        _connectorsTrackEvent('connector_enable_result', {
          ...payload,
          result: 'failure',
          duration_ms: Math.round(performance.now() - startedAt),
        });
        reportError((res && res.error) || t('component.toggle_failed'));
        return;
      }
    }
    _connectorsTrackEvent('connector_enable_result', {
      ...payload,
      result: 'success',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    await loadConnectors();
  } catch (err) {
    _connectorsTrackEvent('connector_enable_result', {
      ...payload,
      result: 'failure',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    _connectorsTrackError('connector_enable', {
      ...payload,
      error_type: _connectorTrackErrorType(err),
    });
    reportError((err && err.message) || t('component.toggle_failed'));
  }
}

function _entryFromInstance(instance) {
  return {
    id: instance.id,
    display_name: instance.display_name || instance.id,
    description_zh: '',
    description_en: '',
    _custom: instance.origin === 'custom',
  };
}

// One-line server summary for a custom card. Main strips transport secrets and
// sends only a display summary.
function _customTransportSummary(instance) {
  const tr = instance && instance.transport;
  if (!tr) return '';
  if (tr.kind === 'streamable-http' || tr.kind === 'stdio') return tr.summary || '';
  return '';
}

async function _quickDisconnect(entry, instance) {
  const name = (instance && instance.display_name) || entry.display_name || entry.id;
  const ok = await uiConfirmDanger({
    title: t('connectors.confirm_disconnect_title', { name }),
    message: t(entry.id === 'tencent-survey' ? 'connectors.survey.disconnect_note' : 'connectors.confirm_disconnect_msg'),
    dangerLabel: t('connectors.action.disconnect'),
  });
  if (!ok) return;
  // Bundle entry: disconnect every member instance. Members not yet installed are skipped (the
  // IPC just returns ok:false / removed:false which we treat as no-op).
  const ids = Array.isArray(entry.bundle_member_ids) && entry.bundle_member_ids.length
    ? entry.bundle_member_ids.slice()
    : [(instance && instance.id) || entry.id];
  const payload = {
    ..._connectorTrackPayload(entry, instance),
    instance_count: ids.length,
  };
  const startedAt = performance.now();
  _connectorsTrackClick('connector_disconnect', payload);
  try {
    for (const id of ids) {
      const res = await window.cogseed.invoke('connectors.remove', { id });
      if (!res || (!res.ok && !/not found/i.test(res.error || ''))) {
        _connectorsTrackEvent('connector_disconnect_result', {
          ...payload,
          result: 'failure',
          duration_ms: Math.round(performance.now() - startedAt),
        });
        uiAlert((res && res.error) || t('connectors.errors.remove_failed'));
        return;
      }
    }
    _connectorsTrackEvent('connector_disconnect_result', {
      ...payload,
      result: 'success',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    await loadConnectors();
  } catch (err) {
    _connectorsTrackEvent('connector_disconnect_result', {
      ...payload,
      result: 'failure',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    _connectorsTrackError('connector_disconnect', {
      ...payload,
      error_type: _connectorTrackErrorType(err),
    });
    uiAlert((err && err.message) || t('connectors.errors.remove_failed'));
  }
}

// ─── Connector usage popup (registry CONN-PV-003) ──────────────────────
// Only registered connectors expose this business composition. uiModal owns the overlay,
// keyboard behavior and focus trap; all controls reuse the shared factories.
const _CONNECTOR_POPUP_PROFILES = {
  'tencent-meeting': { prefix: 'connectors.tencent.examples', keys: ['query', 'summary', 'schedule'], note: 'connectors.tencent.connected.note' },
  'email-163': { prefix: 'connectors.popup.email.examples', note: 'connectors.popup.email.note' },
  'email-enterprise': { prefix: 'connectors.popup.email.examples', note: 'connectors.popup.email.note' },
  'email-qq': { prefix: 'connectors.popup.email.examples', note: 'connectors.popup.email.note' },
  wps: { prefix: 'connectors.popup.wps.examples' },
  wecom: { prefix: 'connectors.popup.wecom.examples' },
  'tencent-docs': { prefix: 'connectors.popup.tencent_docs.examples' },
  'tencent-survey': { prefix: 'connectors.popup.survey.examples', note: 'connectors.popup.survey.note' },
  dingtalk: { prefix: 'connectors.popup.dingtalk.examples' },
  feishu: { prefix: 'connectors.popup.feishu.examples' },
};
let _connectorPopupState = null;
let _connectorAuthorizationUrl = null;
let _surveyAuthorizing = false;

function _connectorHasPopup(id) {
  return Object.prototype.hasOwnProperty.call(_CONNECTOR_POPUP_PROFILES, String(id || ''));
}

function _connectorPopupName(entry) {
  return entry.auth_mode === 'credentials' ? t('connectors.email.' + entry.id) : entry.display_name || entry.id;
}

function _connectorPopupExampleKeys(entry) {
  return _CONNECTOR_POPUP_PROFILES[entry.id]?.keys || ['query', 'summary', 'task'];
}

function _connectorPopupExample(entry, key) {
  const profile = _CONNECTOR_POPUP_PROFILES[entry.id];
  return profile && _connectorPopupExampleKeys(entry).includes(key) ? t(profile.prefix + '.' + key) : '';
}

function _connectorPopupAuthUrlHtml(entry) {
  const notice = _connectorAuthorizationUrl;
  if (!notice || !entry || notice.catalog_id !== entry.id) return '';
  return `
    <div class="connectors-detail-auth-url">
      <p class="connectors-detail-auth-url-label">${escapeHtml(t('connectors.popup.auth_url.label'))}</p>
      <code class="connectors-detail-auth-url-value">${escapeHtml(notice.url)}</code>
      ${_connectorUiButton({
        label: t('connectors.popup.auth_url.copy'),
        role: 'secondary',
        size: 'sm',
        attrs: { 'data-act': 'copy-auth-url' },
      })}
    </div>`;
}

/** Pick this entry's onboarding guidance in the current UI language.
 *
 *  Guidance is product content that travels with the catalog entry (`setup`), the same way
 *  `description_zh` / `description_en` do — an enterprise user must not be left guessing
 *  `npm install -g @larksuite/cli`, and an English user must not be shown Chinese steps. */
function _connectorSetupText(entry) {
  const setup = entry && entry.setup;
  if (!setup) return null;
  const lang = String(typeof getLang === 'function' ? getLang() : 'zh').toLowerCase();
  const zh = lang.startsWith('zh');
  return {
    steps: (zh ? setup.steps_zh : setup.steps_en) || [],
    docsUrl: setup.docs_url || '',
    docsLabel: (zh ? setup.docs_label_zh : setup.docs_label_en) || t('connectors.setup.open_docs'),
    install: setup.install_command || '',
    note: (zh ? setup.credential_note_zh : setup.credential_note_en) || '',
  };
}

/** The onboarding block shown in the detail panel: what to install, what will happen, and where the
 *  credential comes from. Rendered for every entry that ships `setup`; entries without it render
 *  nothing and keep the previous behaviour. */
function _connectorPopupSetupHtml(entry) {
  const text = _connectorSetupText(entry);
  if (!text) return '';
  const steps = text.steps.length
    ? `<ol class="connectors-detail-setup-steps">${text.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>`
    : '';
  const install = text.install
    ? `<div class="connectors-detail-setup-install">
        <p class="connectors-detail-setup-install-label">${escapeHtml(t('connectors.setup.install_label'))}</p>
        <code class="connectors-detail-setup-install-value">${escapeHtml(text.install)}</code>
        ${_connectorUiButton({
          label: t('connectors.setup.copy_command'),
          role: 'secondary',
          size: 'sm',
          attrs: { 'data-act': 'copy-setup-command' },
        })}
      </div>`
    : '';
  const docs = text.docsUrl
    ? `<div class="connectors-detail-setup-docs">${_connectorUiButton({
        label: text.docsLabel,
        role: 'secondary',
        size: 'sm',
        attrs: { 'data-act': 'open-setup-docs' },
      })}</div>`
    : '';
  const note = text.note ? `<p class="connectors-detail-setup-note">${escapeHtml(text.note)}</p>` : '';
  if (!steps && !install && !docs && !note) return '';
  return `<div class="connectors-detail-setup">
      <p class="connectors-detail-setup-title">${escapeHtml(t('connectors.setup.title'))}</p>
      ${steps}${install}${docs}${note}
    </div>`;
}

function _connectorPopupPresentation(entry, instance) {
  const kind = instance && instance.status && instance.status.kind;
  const connected = kind === 'connected';
  const usable = connected && instance.enabled !== false;
  const preparing = _connectorRuntimeProgress(entry);
  const authorizing = (_connectorAuthorizationUrl && _connectorAuthorizationUrl.catalog_id === entry.id)
    || _connectorsState.connecting.has(entry.id)
    || [..._pendingConnectAttempts.values()].some(attempt => attempt.payload.connector_id === entry.id && attempt.ownerKey === _connectorRuntimeKey(entry.id));
  const busy = !!(_connectorPopupState && _connectorPopupState.busy);
  let label = t('connectors.popup.not_connected');
  let message = '';
  let tone = 'idle';
  const connectUnavailable = _isConnectorVisibleDisabled(entry) && !(_isConnectorCliMissing(entry) && entry.runtime_installable);
  let action = { label: t('connectors.action.connect'), role: 'primary', attrs: { 'data-act': 'connect' }, disabled: connectUnavailable };
  if (connected) {
    label = t('connectors.group.connected');
    tone = 'success';
    message = usable ? '' : t('connectors.popup.disabled');
    action = { label: t('connectors.popup.use'), role: 'primary', disabled: !usable || busy, attrs: { 'data-act': 'use-connector' } };
  } else if (preparing) {
    label = _connectorRuntimeLabel(preparing);
    action = { label, role: 'primary', loading: true };
  } else if (authorizing) {
    label = t('connectors.popup.authorizing.title');
    message = t('connectors.popup.authorizing.desc');
    action = { label: t('connectors.action.connecting'), role: 'primary', loading: true };
  } else if (kind === 'degraded' || kind === 'error') {
    label = t(kind === 'degraded' ? 'connectors.status.unverified' : 'connectors.status.error');
    tone = kind === 'degraded' ? 'attention' : 'critical';
    message = _formatConnectorStatusError(instance.status.message);
    action = { label: t(kind === 'degraded' ? 'connectors.action.retry' : 'connectors.popup.reconnect'), role: 'primary', disabled: busy || connectUnavailable, attrs: { 'data-act': kind === 'degraded' ? 'retry-degraded' : 'connect' } };
  } else if (_isConnectorCliMissing(entry)) {
    label = t('connectors.onboarding.cli_missing_title', { name: entry.display_name || entry.id });
    message = _connectorRuntimeErrors.get(_connectorRuntimeKey(entry.id)) || t(entry.runtime_installable ? 'connectors.runtime.required' : 'connectors.runtime.platform_unavailable');
    action = { label: t(entry.runtime_installable ? 'connectors.runtime.install_connect' : 'connectors.action.unavailable'), role: 'primary', disabled: !entry.runtime_installable, attrs: { 'data-act': 'connect' } };
  } else if (_isConnectorVisibleDisabled(entry)) {
    label = t('connectors.popup.unavailable.title');
    message = t('connectors.popup.unavailable.desc');
  }
  const account = String(instance && (instance.email_settings?.address || instance.oauth_grant?.account_label) || '').trim();
  const switchHtml = connected ? `<div class="connector-popup-enable"><span>${escapeHtml(t('connectors.popup.enable'))}</span>${uiSwitch({ label: t('connectors.popup.enable'), checked: instance.enabled !== false, disabled: busy, attrs: { 'data-act': 'toggle-enabled' } })}</div>` : '';
  const examples = _connectorPopupExampleKeys(entry).map(key => _connectorUiButton({
    label: _connectorPopupExample(entry, key), role: 'secondary', iconEnd: 'arrow-right',
    className: 'connector-popup-example', disabled: !usable || busy,
    attrs: { 'data-act': 'example', 'data-example': key },
  })).join('');
  const setup = _connectorPopupSetupHtml(entry);
  const guidance = !connected && setup ? uiAccordion({
    className: 'connector-popup-guidance', defaultOpen: [],
    items: [{ title: t('connectors.setup.title'), bodyHtml: setup }],
  }) : '';
  const bodyHtml = `<div class="connector-popup-content">
    <p class="connector-popup-description">${escapeHtml(pickDesc(entry, typeof getLang === 'function' ? getLang() : 'en'))}</p>
    <div class="connector-popup-status" role="status" aria-live="polite">${uiStatusPill({ label, tone })}${account ? `<span>${escapeHtml(account)}</span>` : ''}</div>
    ${switchHtml}${message ? `<p class="connector-popup-note">${escapeHtml(message)}</p>` : ''}
    ${_connectorPopupAuthUrlHtml(entry)}
    <section class="connector-popup-examples"><h3>${escapeHtml(t('connectors.popup.examples.title'))}</h3>${examples}</section>
    ${_CONNECTOR_POPUP_PROFILES[entry.id]?.note ? `<p class="connector-popup-note">${escapeHtml(t(_CONNECTOR_POPUP_PROFILES[entry.id].note))}</p>` : ''}
    ${guidance}
  </div>`;
  const more = instance ? `<div class="connector-popup-more">
    ${_connectorUiIconButton({ label: t('common.more'), icon: 'more-horizontal', attrs: { id: 'connector-popup-more', 'data-act': 'more', 'aria-expanded': 'false', 'aria-controls': 'connector-popup-menu' } })}
    <div id="connector-popup-menu" class="ui-modal__popover" data-ui-modal-popover data-open="false" data-trigger-id="connector-popup-more" hidden>
      ${_connectorUiButton({ label: t('connectors.action.disconnect'), role: 'danger', size: 'sm', disabled: busy, attrs: { 'data-act': 'disconnect' } })}
    </div></div>` : '';
  const cancel = preparing ? _connectorUiButton({ label: t('common.cancel'), role: 'secondary', attrs: { 'data-act': 'cancel-runtime' } })
    : authorizing ? _connectorUiButton({ label: t('common.cancel'), role: 'secondary', attrs: { 'data-act': 'cancel-authorization' } }) : '';
  return { bodyHtml, footerHtml: more + cancel + _connectorUiButton(action) };
}

function _connectorPopupEntry(id) {
  return _connectorsState.catalog.find(entry => entry && entry.id === id) || { id, display_name: id };
}

function _renderConnectorPopup() {
  const state = _connectorPopupState;
  if (!state) return;
  const entry = _connectorPopupEntry(state.id);
  const instance = _instanceById(state.id);
  const modal = state.modal;
  const active = document.activeElement;
  const focusedAction = active && modal.dialog.contains(active) && active.dataset && active.dataset.act;
  const focusedExample = active && active.dataset && active.dataset.example;
  const body = modal.dialog.querySelector('.ui-modal__body');
  const scrollTop = body.scrollTop;
  const guidanceOpen = !!body.querySelector('.ui-accordion__item[open]');
  const presentation = _connectorPopupPresentation(entry, instance);
  body.innerHTML = presentation.bodyHtml;
  if (guidanceOpen) body.querySelector('.ui-accordion__item')?.setAttribute('open', '');
  body.scrollTop = scrollTop;
  modal.dialog.querySelector('.ui-modal__title').textContent = _connectorPopupName(entry);
  const close = modal.dialog.querySelector('[data-ui-modal-close]');
  close.setAttribute('aria-label', t('common.close'));
  close.setAttribute('title', t('common.close'));
  state.footer.innerHTML = presentation.footerHtml;
  modal.dialog.onclick = event => {
    if (event.target.closest('.connector-popup-more')) return;
    const menu = modal.dialog.querySelector('[data-ui-modal-popover]');
    if (menu) { menu.hidden = true; menu.dataset.open = 'false'; }
    modal.dialog.querySelector('[data-act="more"]')?.setAttribute('aria-expanded', 'false');
  };
  _bindConnectorPopupActions(modal.dialog, entry, instance);
  if (focusedAction) {
    const selector = `[data-act="${focusedAction}"]${focusedExample ? `[data-example="${focusedExample}"]` : ''}`;
    const replacement = modal.dialog.querySelector(selector);
    if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
    else modal.dialog.querySelector('[data-ui-modal-close]')?.focus({ preventScroll: true });
  }
}

function _connectorPopupReturnTarget(id) {
  for (const card of document.querySelectorAll('.connector-card[data-id]')) {
    if (card.dataset.id === id) return card.querySelector('[data-act="open-popup"]');
  }
  return null;
}

function _closeConnectorPopup(restoreFocus = true) {
  const state = _connectorPopupState;
  if (!state) return;
  _connectorPopupState = null;
  state.modal.close(null, 'close');
  if (restoreFocus) _connectorPopupReturnTarget(state.id)?.focus({ preventScroll: true });
}

function _openConnectorPopup(entry, instance) {
  const id = String(entry && entry.id || instance && instance.id || '');
  if (!_connectorHasPopup(id)) return;
  if (_connectorPopupState && _connectorPopupState.id === id) { _renderConnectorPopup(); return; }
  _closeConnectorPopup();
  const modal = uiModal({ title: _connectorPopupName(entry), closeLabel: t('common.close'), size: 'lg', bodyHtml: '', dismissOnBackdrop: true });
  modal.overlay.id = 'connector-use-popup';
  modal.dialog.classList.add('connector-popup');
  const icon = document.createElement('span');
  icon.className = 'connector-popup-icon';
  icon.innerHTML = uiIconHtml(entry.icon_name || 'plug');
  modal.dialog.querySelector('.ui-modal__header').prepend(icon);
  const footer = document.createElement('footer');
  footer.className = 'ui-modal__footer';
  modal.dialog.appendChild(footer);
  const state = { id, modal, footer, busy: false };
  _connectorPopupState = state;
  _renderConnectorPopup();
  modal.then(() => {
    if (_connectorPopupState !== state) return;
    _connectorPopupState = null;
    if (_connectorsViewActive()) _connectorPopupReturnTarget(id)?.focus({ preventScroll: true });
  });
}

function _useConnectorFromPopup(entry, exampleKey) {
  const instance = _instanceById(entry.id);
  if (!instance || instance.status.kind !== 'connected' || instance.enabled === false) return;
  const text = exampleKey ? _connectorPopupExample(entry, exampleKey) : '';
  if (exampleKey && !text) return;
  _closeConnectorPopup(false);
  _useConnector(entry, instance, text);
}

async function _connectFromConnectorPopup(entry) {
  const needsForm = entry.auth_mode === 'credentials'
    || (entry.auth_mode === 'interactive_token' && entry.interactive_auth?.kind === 'paste');
  if (!needsForm) return _runConnect(entry);
  // Transfer ownership to the existing credential dialog; never stack modal keyboard scopes.
  const ownerKey = _connectorRuntimeKey(entry.id);
  _closeConnectorPopup(false);
  await _runConnect(entry);
  if (!_connectorsViewActive() || _connectorPopupState || ownerKey !== _connectorRuntimeKey(entry.id)) return;
  await loadConnectors();
  if (_connectorsViewActive() && !_connectorPopupState && ownerKey === _connectorRuntimeKey(entry.id)) _openConnectorPopup(_connectorPopupEntry(entry.id), _instanceById(entry.id));
}

function _bindConnectorPopupActions(host, entry, instance) {
  const more = host.querySelector('[data-act="more"]');
  if (more) more.addEventListener('focus', () => {
    more.setAttribute('aria-expanded', String(host.querySelector('[data-ui-modal-popover]').dataset.open === 'true'));
  });
  host.querySelectorAll('[data-act]').forEach(button => button.addEventListener('click', async () => {
    const state = _connectorPopupState;
    if (!state || state.busy || button.disabled) return;
    const action = button.dataset.act;
    if (action === 'more') {
      const menu = host.querySelector('[data-ui-modal-popover]');
      const open = menu.dataset.open !== 'true';
      menu.dataset.open = String(open); menu.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      if (open) menu.querySelector('button')?.focus();
      return;
    }
    if (action === 'use-connector' || action === 'example') return _useConnectorFromPopup(entry, button.dataset.example);
    if (action === 'copy-auth-url') return _copyConnectorAuthorizationUrl(entry);
    if (action === 'copy-setup-command') return _copyConnectorSetupCommand(entry);
    if (action === 'open-setup-docs') return _openConnectorSetupDocs(entry);
    if (action === 'connect') return _connectFromConnectorPopup(entry);
    if (action === 'retry-degraded') return _retryConnect(entry, 'connector_degraded_retry');
    if (action === 'cancel-authorization' || action === 'cancel-runtime') {
      const channel = action === 'cancel-runtime' ? 'connectors.cancel_runtime' : 'connectors.cancel_oauth';
      try { await window.cogseed.invoke(channel, { catalog_id: entry.id }); }
      catch (err) { uiToast(_formatConnectError(err), { variant: 'error' }); }
      return;
    }
    if (action === 'disconnect') {
      // The confirmation owns its modal keyboard scope. Re-open usage with the resulting live state.
      _closeConnectorPopup();
      await _quickDisconnect(entry, instance);
      if (_connectorsViewActive() && !_connectorPopupState) _openConnectorPopup(entry, _instanceById(entry.id));
      return;
    }
    if (action === 'toggle-enabled') {
      state.busy = true;
      _renderConnectorPopup();
      try { await _toggleConnectorEnabled(entry, instance, instance.enabled === false, message => uiToast(message, { variant: 'error' })); }
      finally { state.busy = false; if (_connectorPopupState === state) _renderConnectorPopup(); }
    }
  }));
}

/** A `local_cli` connect produces its authorization URL here rather than through a deep link. The
 *  browser is opened by main; if that fails, this URL is the only way forward, so surface it where
 *  the user can copy it instead of leaving it in module state they cannot see. */
function _handleAuthorizationUrl(notice) {
  if (!notice || typeof notice.catalog_id !== 'string' || typeof notice.url !== 'string') return;
  const url = notice.url.trim();
  if (!notice.catalog_id || !url) return;
  if (notice.catalog_id === 'tencent-survey') {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return; }
    if (parsed.origin !== 'https://wj.qq.com' || parsed.pathname !== '/oauth/authorize' || parsed.username || parsed.password) return;
    if (!_surveyAuthorizing) return;
    _connectorAuthorizationUrl = { catalog_id: notice.catalog_id, url };
    if (_connectorsViewActive()) _renderConnectorsGrid();
    return;
  }
  _connectorAuthorizationUrl = { catalog_id: notice.catalog_id, url };
  if (_connectorPopupState && _connectorPopupState.id === notice.catalog_id) {
    _renderConnectorPopup();
    return;
  }
  if (_connectorsViewActive() && _connectorHasPopup(notice.catalog_id)) {
    _openConnectorPopup(_connectorPopupEntry(notice.catalog_id), _instanceById(notice.catalog_id));
    return;
  }
  if (typeof uiToast === 'function') uiToast(t('connectors.popup.auth_url.toast'), { variant: 'warning' });
}

async function _copyConnectorSetupCommand(entry) {
  const text = _connectorSetupText(entry);
  if (!text || !text.install) return;
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard
      || typeof navigator.clipboard.writeText !== 'function') {
      throw new Error('clipboard unavailable');
    }
    await navigator.clipboard.writeText(text.install);
    if (typeof uiToast === 'function') uiToast(t('connectors.setup.copied'), { variant: 'success' });
  } catch (err) {
    _connectorsLog.warn('setup command copy failed', { error: (err && err.message) || String(err) });
    uiAlert(t('connectors.setup.copy_failed'));
  }
}

/** Open the provider's console/docs for this connector. Goes through `auth.openExternal` so the
 *  https-only validation and the OS handler stay in one place. */
async function _openConnectorSetupDocs(entry) {
  const text = _connectorSetupText(entry);
  if (!text || !text.docsUrl) return;
  try {
    const res = await window.cogseed.invoke('auth.openExternal', { url: text.docsUrl });
    if (res && res.ok === false) throw new Error(res.error || 'open failed');
  } catch (err) {
    _connectorsLog.warn('setup docs open failed', { error: (err && err.message) || String(err) });
    uiAlert(t('connectors.setup.open_failed'));
  }
}

async function _copyConnectorAuthorizationUrl(entry) {
  const notice = _connectorAuthorizationUrl;
  if (!notice || !entry || notice.catalog_id !== entry.id) return;
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard
      || typeof navigator.clipboard.writeText !== 'function') {
      throw new Error('clipboard unavailable');
    }
    await navigator.clipboard.writeText(notice.url);
    if (typeof uiToast === 'function') uiToast(t('connectors.popup.auth_url.copied'), { variant: 'success' });
  } catch (err) {
    _connectorsLog.warn('authorization url copy failed', { error: (err && err.message) || String(err) });
    uiAlert(t('connectors.popup.auth_url.copy_failed'));
  }
}

// UI owns credentials. Never persist them in renderer state or forward them to a conversation.
function _openEmailConnectDialog(entry) {
  const enterprise = entry.id === 'email-enterprise';
  const helpUrls = {
    'email-qq': 'https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/authorizationCode',
    'email-163': 'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2a5feb28b66796d3b',
  };
  const hint = () => {
    const url = helpUrls[entry.id];
    if (!url) return escapeHtml(t('connectors.email.hint'));
    const key = 'connectors.email.' + entry.id;
    const guide = `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t(key + '.guide'))}</a>`;
    return escapeHtml(t(key + '.hint')).replace('{guide}', () => guide);
  };
  const installed = _connectorsState.instances.find(row => row.id === entry.id);
  const saved = installed && installed.email_settings || {};
  let savedPasswordAvailable = saved.has_saved_password === true;
  let canReusePassword = savedPasswordAvailable;
  let security = saved.security || 'tls';
  const inputIds = ['email-address', 'email-password'].concat(enterprise ? ['email-host', 'email-port', 'email-username'] : []);
  let busy = false;
  let closed = false;
  const form = () => uiForm({ columns: enterprise ? 2 : 1, ariaLabel: t('connectors.email.title'), fields: [
    { wide: true, html: uiField({ id: 'email-address', label: t('connectors.email.address'), required: true,
      control: { kind: 'input', type: 'email', attrs: { type: 'email', autocomplete: 'username', maxlength: 254 } } }) },
    { wide: true, html: uiField({ id: 'email-password', label: t(entry.id === 'email-enterprise' ? 'connectors.email.password' : 'connectors.email.auth_code'), required: !canReusePassword,
      optionalLabel: t('connectors.email.credential_saved'),
      hint: saved.has_saved_password ? t(canReusePassword ? 'connectors.email.credential_saved_hint' : 'connectors.email.credential_reenter_hint') : undefined,
      control: { kind: 'input', type: 'password', placeholder: canReusePassword ? '••••••••' : '',
        attrs: { type: 'password', autocomplete: 'new-password', maxlength: 2048 } } }) },
    ...(enterprise ? [
      { wide: true, html: uiField({ id: 'email-host', label: t('connectors.email.host'), required: true,
        control: { kind: 'input', placeholder: 'imap.example.com', attrs: { autocomplete: 'off', maxlength: 253 } } }) },
      { html: uiField({ id: 'email-security', label: t('connectors.email.security'), required: true,
        control: { kind: 'select', value: security, options: [
          { value: 'tls', label: 'SSL/TLS' }, { value: 'starttls', label: 'STARTTLS' },
        ] } }) },
      { html: uiField({ id: 'email-port', label: t('connectors.email.port'), required: true,
        control: { kind: 'input', type: 'number', attrs: { min: 1, max: 65535, step: 1 } } }) },
      { wide: true, html: uiField({ id: 'email-username', label: t('connectors.email.username'),
        control: { kind: 'input', placeholder: t('connectors.email.username_hint'), attrs: { autocomplete: 'off', maxlength: 254 } } }) },
      { wide: true, html: `<p class="ui-field__hint">${escapeHtml(t('connectors.email.server_hint'))}</p>` },
    ] : []),
    { wide: true, html: `<p class="ui-field__hint" data-email-hint>${hint()}</p>` },
  ] });
  const ownerKey = _connectorRuntimeKey(entry.id);
  const labels = () => ({ title: t('connectors.email.title') + ' · ' + t('connectors.email.' + entry.id),
    closeLabel: t('common.close'), submitLabel: t('connectors.email.submit'), busyLabel: t('connectors.email.connecting') });
  const modal = uiFormModal({ ...labels(), bodyHtml: form(), initialFocus: '#email-address', onSubmit: submit,
    submitAttrs: { 'data-email-submit': 'true' }, feedbackAttrs: { 'data-email-feedback': 'true' } });
  const field = id => modal.dialog.querySelector('#' + id);
  function syncSavedPasswordState() {
    const address = field('email-address').value.trim();
    canReusePassword = savedPasswordAvailable && address === saved.address && (!enterprise || (
      field('email-host').value.trim().toLowerCase() === saved.host
      && Number(field('email-port').value) === saved.port
      && security === saved.security
      && (field('email-username').value.trim() || address) === saved.username
    ));
    const password = field('email-password');
    // A fixed visual mask is a placeholder, never a credential or a clue to its length.
    password.setAttribute('placeholder', canReusePassword ? '••••••••' : '');
    password.setAttribute('aria-required', String(!canReusePassword));
    if (canReusePassword) password.removeAttribute('required');
    else password.setAttribute('required', '');
    const wrapper = password.closest('.ui-field');
    wrapper.querySelector('.ui-field__requirement').textContent = t(canReusePassword ? 'connectors.email.credential_saved' : 'common.required');
    const note = wrapper.querySelector('.ui-field__hint');
    if (note) note.textContent = t(canReusePassword ? 'connectors.email.credential_saved_hint' : 'connectors.email.credential_reenter_hint');
  }
  async function refreshAndReturnFocus() {
    if (!_connectorsViewActive() || _connectorPopupState || ownerKey !== _connectorRuntimeKey(entry.id)) return;
    await loadConnectors();
    if (!_connectorsViewActive() || _connectorPopupState || ownerKey !== _connectorRuntimeKey(entry.id)) return;
    const card = document.querySelector(`.connector-card[data-id="${entry.id}"]`);
    const trigger = card && (card.querySelector('[data-act="connect"]') || card.querySelector('[data-act="use-connector"]'));
    if (trigger) trigger.focus();
  }
  function renderLabels() {
    if (closed) return;
    const values = inputIds.map(id => field(id).value);
    if (enterprise) field('email-security')._uiSelectApi?.close();
    modal.update({ ...labels(), bodyHtml: form() });
    inputIds.forEach((id, index) => { field(id).value = values[index]; });
    bind();
  }
  function setBusy() { modal.setBusy(busy); }
  async function submit(event) {
    event.preventDefault();
    if (busy || closed) return;
    syncSavedPasswordState();
    const address = field('email-address').value.trim();
    let password = field('email-password').value;
    if (!address || (!password && !canReusePassword)) return;
    const settings = enterprise ? { host: field('email-host').value.trim(), port: Number(field('email-port').value),
      security, username: field('email-username').value.trim() } : undefined;
    if (enterprise && (!settings.host || !Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535)) {
      modal.setFeedback(t('connectors.email.email_invalid_server'));
      return;
    }
    modal.setFeedback('');
    busy = true;
    _connectorsState.connecting.add(entry.id);
    setBusy();
    try {
      const response = password
        ? await window.cogseed.invoke('connectors.connect_email', { catalog_id: entry.id, address, password, ...(settings ? { settings } : {}) })
        : await window.cogseed.invoke('connectors.refresh', { id: entry.id });
      password = '';
      field('email-password').value = '';
      const status = response && response.instance && response.instance.status;
      if (response && response.ok && status && status.kind === 'connected') {
        modal.close(true, 'connected');
        uiToast(t('connectors.email.success'), { variant: 'success' });
      } else if (!closed) {
        savedPasswordAvailable = false;
        syncSavedPasswordState();
        busy = false;
        setBusy();
        field('email-password').focus();
        modal.setFeedback(_formatConnectorStatusError((status && status.message) || (response && response.error) || 'email_connection_failed'));
      }
    } catch (_) {
      password = '';
      if (!closed) {
        savedPasswordAvailable = false;
        syncSavedPasswordState();
        field('email-password').value = '';
        busy = false;
        setBusy();
        field('email-password').focus();
        modal.setFeedback(t('connectors.email.email_connection_failed'));
      }
    } finally {
      busy = false;
      _connectorsState.connecting.delete(entry.id);
      if (closed) await refreshAndReturnFocus();
    }
  }
  function bind() {
    if (enterprise) hydrateUiFormSelects(modal.dialog, { 'email-security': value => {
      if (busy) return;
      const oldDefault = security === 'tls' ? '993' : '143';
      security = value;
      if (field('email-port').value === oldDefault) field('email-port').value = security === 'tls' ? '993' : '143';
      syncSavedPasswordState();
    } });
    inputIds.filter(id => id !== 'email-password').forEach(id => field(id).addEventListener('input', syncSavedPasswordState));
    syncSavedPasswordState();
    setBusy();
  }
  field('email-address').value = saved.address || '';
  if (enterprise) {
    field('email-host').value = saved.host || '';
    field('email-port').value = String(saved.port || (security === 'tls' ? 993 : 143));
    field('email-username').value = saved.username || '';
  }
  bind();
  window.addEventListener('i18n-change', renderLabels);
  modal.then(async () => {
    closed = true;
    if (enterprise) field('email-security')._uiSelectApi?.close();
    field('email-password').value = '';
    window.removeEventListener('i18n-change', renderLabels);
    if (!busy) await refreshAndReturnFocus();
  });
  return modal;
}

/** Connect an `interactive_token` connector whose credential only the user can supply (the `paste`
 *  variant, e.g. Tencent Docs, where the provider issues a token in its own console).
 *
 *  Deliberately separate from `_runConnect`'s normal path: `local_cli` and `browser_poll` both start
 *  work in main and finish asynchronously, while this one cannot even begin until the user has
 *  pasted something — so there is nothing to hand off and the outcome is known when the IPC returns.
 *
 *  The dialog stays in the app: short numbered steps, a button that opens the provider page only when
 *  the user asks for it (never on its own — a browser window popping up before the user has read
 *  anything was the friction this replaced), and the token field. Failures are shown inline so the
 *  user can correct the paste without redoing the flow. */
function _runInteractiveTokenConnect(entry) {
  let setup = _connectorSetupText(entry) || { steps: [], docsUrl: '', docsLabel: '', note: '' };
  const name = entry.display_name || entry.id;
  const fieldId = 'connector-token';
  let busy = false;
  let closed = false;
  const ownerKey = _connectorRuntimeKey(entry.id);
  const body = () => {
    const steps = setup.steps.length
      ? `<ol class="connectors-detail-setup-steps">${setup.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>`
      : `<p>${escapeHtml(t('connectors.interactive_token.prompt'))}</p>`;
    const open = setup.docsUrl
      ? `<div>${_connectorUiButton({
          label: setup.docsLabel,
          role: 'secondary',
          iconEnd: 'external',
          attrs: { 'data-token-open': 'true' },
        })}</div>`
      : '';
    const form = uiForm({
      ariaLabel: t('connectors.interactive_token.title', { name }),
      fields: [
        { wide: true, html: `<div class="connector-token-guidance">${steps}${open}</div>` },
        { wide: true, html: uiField({ id: fieldId, label: t('connectors.interactive_token.field'), required: true, showRequirement: false,
          hint: setup.note || undefined,
          control: { kind: 'input', type: 'password', placeholder: t('connectors.interactive_token.placeholder'),
            attrs: { type: 'password', autocomplete: 'off', spellcheck: 'false', maxlength: 4096 } } }) },
      ],
    });
    return form;
  };
  const labels = () => ({ title: t('connectors.interactive_token.title', { name }), closeLabel: t('common.close'),
    submitLabel: t('connectors.action.connect'), busyLabel: t('connectors.interactive_token.connecting') });
  const modal = uiFormModal({
    ...labels(),
    size: 'md',
    bodyHtml: body(),
    initialFocus: '[data-token-open], #' + fieldId, onSubmit: submit,
    submitAttrs: { 'data-token-submit': 'true' }, feedbackAttrs: { 'data-token-feedback': 'true' },
  });
  modal.dialog.classList.add('connector-token-dialog');
  const input = () => modal.dialog.querySelector('#' + fieldId);
  const setFeedback = message => modal.setFeedback(message);
  const setBusy = value => { busy = value; modal.setBusy(value); };
  async function openPage() {
    try {
      const res = await window.cogseed.invoke('auth.openExternal', { url: setup.docsUrl });
      if (res && res.ok === false) throw new Error(res.error || 'open failed');
    } catch (err) {
      _connectorsLog.warn('token page open failed', { error: (err && err.message) || String(err) });
      if (!closed) setFeedback(t('connectors.setup.open_failed'));
    }
  }
  async function submit(event) {
    event.preventDefault();
    if (busy || closed) return;
    const credential = String(input().value || '').trim();
    if (!credential) { input().focus(); return; }
    const payload = _connectorTrackPayload(entry, null);
    const startedAt = performance.now();
    _connectorsTrackClick('connector_connect', payload);
    setFeedback('');
    setBusy(true);
    _connectorsState.connecting.add(entry.id);
    _renderConnectorsGrid();
    let connected = false;
    let failure = null;
    try {
      const res = await window.cogseed.invoke('connectors.connect_interactive_token', { catalog_id: entry.id, credential });
      const status = res && res.status;
      if (res && res.ok && status && status.kind === 'connected') connected = true;
      else failure = res && res.ok === false
        ? res
        : { code: 'mcp_connect_failed', error: (status && status.message) || t('connectors.errors.connect_failed') };
    } catch (err) {
      failure = err || {};
    } finally {
      _connectorsState.connecting.delete(entry.id);
      _renderConnectorsGrid();
    }
    if (connected) {
      _connectorsTrackEvent('connector_connect_result', { ...payload, result: 'success', duration_ms: Math.round(performance.now() - startedAt) });
      if (!closed) modal.close(true, 'connected');
      uiToast(t('connectors.interactive_token.success', { name }), { variant: 'success' });
    } else if (!closed) {
      // The pasted value stays in the field: a near-miss (wrong block, stray whitespace) is easier
      // to fix by re-copying than by retyping, and the dialog is the only place the user sees why.
      setBusy(false);
      if (!_reportConnectOutcome(payload, startedAt, failure)) setFeedback(_formatConnectError(failure));
      input().focus();
    }
    if (_connectorsViewActive()) loadConnectors();
  }
  function bind() {
    const open = modal.dialog.querySelector('[data-token-open]');
    if (open) open.addEventListener('click', openPage);
  }
  function renderLabels() {
    if (closed) return;
    const value = input().value;
    setup = _connectorSetupText(entry) || { steps: [], docsUrl: '', docsLabel: '', note: '' };
    modal.update({ ...labels(), bodyHtml: body() });
    input().value = value;
    bind();
    setBusy(busy);
  }
  bind();
  window.addEventListener('i18n-change', renderLabels);
  modal.then(async () => {
    closed = true;
    input().value = '';
    window.removeEventListener('i18n-change', renderLabels);
    // A failed attempt refreshes the card grid, so uiModal's original trigger may be detached.
    if (!_connectorsViewActive() || _connectorPopupState || ownerKey !== _connectorRuntimeKey(entry.id)) return;
    await loadConnectors();
    if (!_connectorsViewActive() || _connectorPopupState || ownerKey !== _connectorRuntimeKey(entry.id)) return;
    const card = document.querySelector(`.connector-card[data-id="${entry.id}"]`);
    (card?.querySelector('[data-act="connect"]') || card?.querySelector('[data-act="use-connector"]'))?.focus();
  });
  return modal;
}

async function _prepareConnectorAndConnect(entry) {
  const key = _connectorRuntimeKey(entry.id);
  if (_connectorRuntimePreparing.has(key)) return;
  _connectorRuntimeErrors.delete(key);
  _connectorRuntimePreparing.set(key, { phase: 'downloading' });
  _renderConnectorsGrid();
  let ready = false;
  try {
    const res = await window.cogseed.invoke('connectors.prepare_runtime', { catalog_id: entry.id });
    if (!res || !res.ok || !res.ready) throw res || {};
    ready = true;
  } catch (err) {
    const code = String(err && (err.code || err.error || err.message) || '');
    const message = t(code.includes('connector_runtime_cancelled') ? 'connectors.runtime.cancelled' : code.includes('connector_runtime_integrity_failed') ? 'connectors.runtime.integrity_failed' : 'connectors.runtime.failed');
    _connectorRuntimeErrors.set(key, message);
  } finally {
    _connectorRuntimePreparing.delete(key);
  }
  // Account changes must not authorize the newly active account on completion of an old request.
  if (key !== _connectorRuntimeKey(entry.id)) return;
  await loadConnectors();
  _renderConnectorsGrid();
  if (ready) {
    const refreshed = _connectorsState.catalog.find(e => e.id === entry.id);
    if (refreshed && !_isConnectorVisibleDisabled(refreshed) && key === _connectorRuntimeKey(entry.id)) await _runConnect(refreshed);
  }
}

async function _runConnect(entry) {
  if (_connectorRuntimeProgress(entry)) return;
  if (_isConnectorCliMissing(entry) && entry.runtime_installable) return _prepareConnectorAndConnect(entry);
  if (entry.id === 'tencent-survey' && _surveyAuthorizing) return;
  if (entry.auth_mode === 'credentials') return _openEmailConnectDialog(entry);
  if (_isConnectorVisibleDisabled(entry)) {
    _showConnectorUnavailableToast(entry);
    return;
  }
  // `interactive_token` splits by how the credential is obtained. `paste` needs the user first (and
  // is handled here); `browser_poll` authorizes itself in main, so it falls through to the normal
  // long-running start below and needs no prompt.
  const interactiveAuth = entry.interactive_auth;
  if (entry.auth_mode === 'interactive_token' && interactiveAuth && interactiveAuth.kind === 'paste') {
    return _runInteractiveTokenConnect(entry);
  }
  const payload = _connectorTrackPayload(entry, null);
  const startedAt = performance.now();
  _connectorsTrackClick('connector_connect', payload);
  if (entry.id === 'tencent-survey') _surveyAuthorizing = true;
  let accepted = false;
  // Show a spinner only while main validates and accepts the launch. The renderer must not hold
  // the card in a ten-minute "connecting" state while the user is in an external browser.
  _connectorsState.connecting.add(entry.id);
  _renderConnectorsGrid();
  try {
    const res = await window.cogseed.invoke('connectors.start_oauth', { catalog_id: entry.id });
    if (res && res.ok && res.started && typeof res.attempt_id === 'string' && res.attempt_id) {
      accepted = true;
      _pendingConnectAttempts.set(res.attempt_id, { payload, startedAt, ownerKey: _connectorRuntimeKey(entry.id) });
    } else if (res && !res.ok) {
      _handleConnectFailure(payload, startedAt, res);
    } else {
      _handleConnectFailure(payload, startedAt, { code: 'empty_response' });
    }
  } catch (err) {
    _handleConnectFailure(payload, startedAt, err);
  } finally {
    if (entry.id === 'tencent-survey' && !accepted) _surveyAuthorizing = false;
    _connectorsState.connecting.delete(entry.id);
    _renderConnectorsGrid();
  }
}

function _handleOAuthConnectResult(info) {
  if (!info || typeof info.attempt_id !== 'string' || typeof info.catalog_id !== 'string') return;
  if (info.catalog_id === 'tencent-survey') _surveyAuthorizing = false;
  if (_connectorAuthorizationUrl && _connectorAuthorizationUrl.catalog_id === info.catalog_id) {
    _connectorAuthorizationUrl = null;
  }
  const pending = _pendingConnectAttempts.get(info.attempt_id) || null;
  if (pending) _pendingConnectAttempts.delete(info.attempt_id);
  const entry = _connectorsState.catalog.find((item) => item && item.id === info.catalog_id) || { id: info.catalog_id };
  const payload = pending ? pending.payload : _connectorTrackPayload(entry, null);
  const durationMs = pending
    ? Math.round(performance.now() - pending.startedAt)
    : (Number.isFinite(info.duration_ms) ? info.duration_ms : 0);

  if (info.result === 'success') {
    _connectorsTrackEvent('connector_connect_result', {
      ...payload,
      result: 'success',
      duration_ms: Math.max(0, durationMs),
    });
  } else {
    const errLike = { code: info.code || 'oauth_failed', error: info.error || 'connector authorization failed' };
    const cancelled = _reportConnectOutcome(payload, pending ? pending.startedAt : performance.now(), errLike, durationMs);
    // A transport failure is rendered on the resulting connector card. Other asynchronous
    // failures need an explicit alert now that the initiating IPC has already returned.
    if (!cancelled && errLike.code !== 'mcp_connect_failed') uiAlert(_formatConnectError(errLike));
  }
  if (_connectorsViewActive()) loadConnectors();
}

/** Re-run connect + token refresh for an installed instance (`connectors.refresh`), never OAuth.
 *  Shared by the custom-server retry and the degraded-card retry. */
async function _retryConnect(entry, event) {
  // Bundle cards are synthetic; only their member instances exist in main. Retry every member and
  // report success only when every latest status is actually connected.
  const ids = Array.isArray(entry.bundle_member_ids) && entry.bundle_member_ids.length
    ? entry.bundle_member_ids.slice()
    : [entry.id];
  const payload = { ..._connectorTrackPayload(entry, null), instance_count: ids.length };
  const startedAt = performance.now();
  _connectorsTrackClick(event, payload);
  _connectorsState.connecting.add(entry.id);
  _renderConnectorsGrid();
  try {
    const results = await Promise.all(ids.map(async (id) => {
      try {
        const res = await window.cogseed.invoke('connectors.refresh', { id });
        const status = res && res.instance && res.instance.status;
        if (res && res.ok && status && status.kind === 'connected') return null;
        return (res && (res.error || (status && status.message))) || t('connectors.errors.connect_failed');
      } catch (err) {
        return (err && err.message) || t('connectors.errors.connect_failed');
      }
    }));
    const failures = results.filter(Boolean);
    if (failures.length) {
      _connectorsTrackEvent(`${event}_result`, {
        ...payload,
        result: 'failure',
        duration_ms: Math.round(performance.now() - startedAt),
      });
      uiAlert(_formatConnectorStatusError(failures[0]));
    } else {
      _connectorsTrackEvent(`${event}_result`, {
        ...payload,
        result: 'success',
        duration_ms: Math.round(performance.now() - startedAt),
      });
    }
  } catch (err) {
    _connectorsTrackEvent(`${event}_result`, {
      ...payload,
      result: 'failure',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    _connectorsTrackError(event, {
      ...payload,
      error_type: _connectorTrackErrorType(err),
    });
    uiAlert(_formatConnectorStatusError((err && err.message) || ''));
  } finally {
    _connectorsState.connecting.delete(entry.id);
    await loadConnectors();
  }
}

// "KEY: value" per line → object. Returns null on a malformed line so the
// dialog can refuse submission instead of silently dropping the line.
function _parseHeaderLines(text) {
  const out = {};
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) return null;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

// "KEY=value" per line → object. Same null-on-malformed contract.
function _parseEnvLines(text) {
  const out = {};
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) return null;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

// Add-custom-MCP-server dialog. The form IS the consent surface (plan §C3):
// for stdio the user types the exact command that will run on their machine,
// and the warning line states that plainly. Submission funnels into the
// single validated IPC route `connectors.add_custom`.
function _openAddCustomDialog() {
  let kind = 'streamable-http';
  let busy = false;
  let closed = false;
  const formHtml = () => uiForm({
    ariaLabel: t('connectors.custom.title'),
    fields: [
      {
        wide: true,
        html: uiField({
          id: 'connector-custom-name',
          label: t('connectors.custom.name_label'),
          required: true,
          control: { kind: 'input', attrs: { 'data-f': 'name', maxlength: 64 } },
        }),
      },
      {
        wide: true,
        html: uiField({
          id: 'connector-custom-kind',
          label: t('connectors.custom.kind_label'),
          required: true,
          control: {
            kind: 'select',
            value: kind,
            options: [
              { value: 'streamable-http', label: t('connectors.custom.kind_http') },
              { value: 'stdio', label: t('connectors.custom.kind_stdio') },
            ],
          },
        }),
      },
      {
        wide: true,
        html: `<div class="connector-custom-section" data-sec="http">
          ${uiField({
            id: 'connector-custom-url',
            label: t('connectors.custom.url_label'),
            required: true,
            control: {
              kind: 'input',
              placeholder: 'https://example.com/mcp',
              attrs: { 'data-f': 'url' },
            },
          })}
          ${uiField({
            id: 'connector-custom-headers',
            label: t('connectors.custom.headers_label'),
            control: {
              kind: 'textarea',
              placeholder: 'Authorization: Bearer ...',
              attrs: { 'data-f': 'headers' },
            },
          })}
        </div>`,
      },
      {
        wide: true,
        html: `<div class="connector-custom-section" data-sec="stdio" hidden>
          ${uiField({
            id: 'connector-custom-command',
            label: t('connectors.custom.command_label'),
            required: true,
            control: { kind: 'input', placeholder: 'npx', attrs: { 'data-f': 'command' } },
          })}
          ${uiField({
            id: 'connector-custom-args',
            label: t('connectors.custom.args_label'),
            control: {
              kind: 'textarea',
              placeholder: '-y\n@scope/mcp-server',
              attrs: { 'data-f': 'args' },
            },
          })}
          ${uiField({
            id: 'connector-custom-env',
            label: t('connectors.custom.env_label'),
            control: {
              kind: 'textarea',
              placeholder: 'API_KEY=...',
              attrs: { 'data-f': 'env' },
            },
          })}
          <div class="muted connector-custom-warning">${escapeHtml(t('connectors.custom.stdio_warning'))}</div>
        </div>`,
      },
    ],
  });
  const labels = () => ({ title: t('connectors.custom.title'), closeLabel: t('common.close'),
    submitLabel: t('connectors.custom.submit'), busyLabel: t('connectors.action.connecting'), cancelLabel: t('common.cancel') });
  const modal = uiFormModal({ ...labels(), bodyHtml: formHtml(), initialFocus: '[data-f="name"]',
    submitIcon: 'plug', submitAttrs: { 'data-act': 'ok' }, onSubmit: submit });
  const f = name => modal.dialog.querySelector(`[data-f="${name}"]`);
  const kindHost = () => modal.dialog.querySelector('#connector-custom-kind');
  function syncKindSections(value) {
    kind = value;
    for (const section of modal.dialog.querySelectorAll('[data-sec]')) {
      const inactive = section.getAttribute('data-sec') !== (kind === 'stdio' ? 'stdio' : 'http');
      section.hidden = inactive;
      section.closest('.ui-form__item').hidden = inactive;
      // Inactive required fields must not block native form submission.
      section.querySelectorAll('input, textarea').forEach(control => { control.disabled = inactive || busy; });
    }
  }
  function bind() {
    hydrateUiFormSelects(modal.dialog, { 'connector-custom-kind': value => {
      if (!busy) syncKindSections(value);
    } });
    syncKindSections(kind);
    modal.setBusy(busy);
  }
  function renderLabels() {
    if (closed) return;
    const names = ['name', 'url', 'headers', 'command', 'args', 'env'];
    const values = names.map(name => f(name).value);
    kindHost()._uiSelectApi?.close();
    modal.setBusy(false);
    modal.update({ ...labels(), bodyHtml: formHtml() });
    names.forEach((name, index) => { f(name).value = values[index]; });
    bind();
  }
  async function submit(event) {
    event.preventDefault();
    if (closed || busy) return;
    let transport;
    if (kind === 'stdio') {
      const env = _parseEnvLines(f('env').value);
      if (env === null) { modal.setFeedback(t('connectors.custom.bad_env')); return; }
      transport = {
        kind: 'stdio',
        command: f('command').value.trim(),
        args: f('args').value.split('\n').map((s) => s.trim()).filter(Boolean),
        env,
      };
    } else {
      const headers = _parseHeaderLines(f('headers').value);
      if (headers === null) { modal.setFeedback(t('connectors.custom.bad_headers')); return; }
      transport = { kind: 'streamable-http', url: f('url').value.trim(), headers };
    }
    modal.setFeedback('');
    busy = true;
    modal.setBusy(true);
    const payload = { transport_kind: kind };
    const startedAt = performance.now();
    _connectorsTrackClick('connector_custom_add', payload);
    try {
      const res = await window.cogseed.invoke('connectors.add_custom', {
        display_name: f('name').value.trim(),
        transport,
      });
      if (res && res.ok && res.instance) {
        _connectorsTrackEvent('connector_custom_add_result', {
          ...payload,
          result: 'success',
          duration_ms: Math.round(performance.now() - startedAt),
        });
        modal.close(true, 'connected');
        const st = res.instance.status || {};
        if (st.kind === 'connected') {
          if (typeof uiToast === 'function') uiToast(t('connectors.custom.added'), { variant: 'success' });
        } else if (st.kind === 'error') {
          uiAlert(`${t('connectors.status.error')}: ${_formatConnectorStatusError(st.message)}`);
        } else if (st.kind === 'degraded') {
          // Added, but we could not verify it once — say so rather than falling through silently
          // (the old if/else-if pair had no branch for this and showed nothing at all).
          uiAlert(`${t('connectors.status.unverified')}: ${_formatConnectorStatusError(st.message)}`);
        }
        await loadConnectors();
      } else {
        _connectorsTrackEvent('connector_custom_add_result', {
          ...payload,
          result: 'failure',
          duration_ms: Math.round(performance.now() - startedAt),
        });
        if (!closed) modal.setFeedback((res && res.error) || t('connectors.errors.connect_failed'));
      }
    } catch (err) {
      _connectorsTrackEvent('connector_custom_add_result', {
        ...payload,
        result: 'failure',
        duration_ms: Math.round(performance.now() - startedAt),
      });
      _connectorsTrackError('connector_custom_add', {
        ...payload,
        error_type: _connectorTrackErrorType(err),
      });
      if (!closed) modal.setFeedback((err && err.message) || t('connectors.errors.connect_failed'));
    } finally {
      busy = false;
      if (!closed) {
        modal.setBusy(false);
        syncKindSections(kind);
      }
    }
  }
  bind();
  window.addEventListener('i18n-change', renderLabels);
  modal.then(() => {
    closed = true;
    kindHost()._uiSelectApi?.close();
    ['headers', 'env'].forEach(name => { f(name).value = ''; });
    window.removeEventListener('i18n-change', renderLabels);
  });
  return modal;
}

/** Does this message mean the provider rejected the credential itself?
 *
 *  Matched on the MCP endpoint's own vocabulary, which is stable across providers: an absent header
 *  yields `Bearer token required` / `missing_token`, a bad one `invalid_token` /
 *  `invalid or expired token` / `unauthorized`. */
function _isCredentialRejection(message) {
  return /invalid_token|invalid or expired token|missing_token|bearer token required|unauthorized|token.*(expired|revoked|invalid)/i
    .test(String(message || ''));
}

function _formatConnectError(errLike) {
  const code = errLike && errLike.code;
  const msg = (errLike && (errLike.error || errLike.message)) || '';
  if (/^survey_[a-z_]+$/.test(msg)) return t('connectors.survey.' + msg);
  if (code === 'flow_timeout') return t('connectors.survey.expired');
  if (code === 'connector_unsupported' || /connector_unsupported/i.test(String(msg))) {
    return t('connectors.toast.unsupported');
  }
  if (code === 'missing_required_scopes' || /missing_required_scopes|missing required scopes/i.test(String(msg))) {
    return t('connectors.errors.missing_required_scopes');
  }
  // Credential-shape failures. These used to reach the user as engine internals ("Cannot convert
  // argument to a ByteString because the character at index 58 has a value of 19979"), which named
  // neither the cause nor the fix, so they are mapped to an instruction instead.
  if (code === 'credential_not_a_token' || /no token found in the pasted text/i.test(String(msg))) {
    return t('connectors.errors.credential_not_a_token');
  }
  if (code === 'credential_too_long' || /credential is unreasonably long/i.test(String(msg))) {
    return t('connectors.errors.credential_too_long');
  }
  if (code === 'credential_empty' || /credential is empty/i.test(String(msg))) {
    return t('connectors.errors.credential_empty');
  }
  // `invalid_token` / `invalid or expired token` is the MCP endpoint's own wording (verified against
  // Tencent Docs: an absent header says "Bearer token required", a bad one says "invalid or expired
  // token"). Either way the user's next move is the same: fetch a fresh token and paste it.
  if (_isCredentialRejection(String(msg))) return t('connectors.errors.credential_rejected');
  // The CLI refused outright (organisation policy, revoked app). The vendor's own sentence is the
  // actionable part, so it is carried through verbatim under a localised lead-in.
  if (code === 'authorization_blocked' || /authorization is blocked|authorization was refused/i.test(String(msg))) {
    // Drop the CLI's English "device authorization failed:" lead-in; the localised one replaces it.
    return t('connectors.errors.authorization_blocked', { reason: String(msg).replace(/^device authorization failed:\s*/i, '') });
  }
  if (/fetch failed|network|timeout|timed out|econnreset|econnrefused|eai_again|enotfound/i.test(String(msg))) {
    return _connectorErrorFallback('network');
  }
  return msg || t('connectors.errors.connect_failed');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
  })[c]);
}

function _connectorsViewActive() {
  return currentView === 'connectors' || currentView === 'connections';
}

window.addEventListener('i18n-change', () => {
  if (_connectorsViewActive()) _renderConnectorsGrid();
});


// Refresh the grid when a connector or client-config push arrives. Right now the
// only consumer is the connectors panel itself, but registering at module load lets future
// background events (token expiry notifications etc.) refresh the panel automatically.
if (window.cogseed && typeof window.cogseed.onPushEvent === 'function') {
  try {
    window.cogseed.onPushEvent('connectors:changed', () => {
      if (_connectorsViewActive()) loadConnectors();
    });
    window.cogseed.onPushEvent('connectors:oauth-result', _handleOAuthConnectResult);
    window.cogseed.onPushEvent('connectors:runtime-progress', (info) => {
      if (!info || typeof info.catalog_id !== 'string' || typeof info.user_id !== 'string') return;
      const key = 'cogseed.connectors.renderCache.v' + _CONNECTORS_RENDER_CACHE_VERSION + '.' + info.user_id + ':' + info.catalog_id;
      if (key !== _connectorRuntimeKey(info.catalog_id) || !_connectorRuntimePreparing.has(key)) return;
      if (!['downloading', 'verifying', 'installing'].includes(info.phase)) return;
      _connectorRuntimePreparing.set(key, { phase: info.phase, percent: info.percent });
      // Updating the label in place preserves keyboard focus on Cancel during downloads.
      document.querySelectorAll('.connector-card[data-id]').forEach((card) => {
        if (card.dataset.id !== info.catalog_id) return;
        const label = _connectorRuntimeLabel(info);
        _setConnectorButtonPresentation(card.querySelector('[data-act="runtime-progress"]'), label);
        const status = card.querySelector('.connector-card-runtime');
        if (status) {
          const text = status.querySelector('.ui-status-dot__label');
          if (text) text.textContent = label;
          status.setAttribute('aria-label', label);
          status.title = label;
        }
      });
    });
    // `local_cli` connects produce their authorization URL on this machine instead of through a
    // deep link, so the renderer has to be able to show it as a copyable fallback.
    window.cogseed.onPushEvent('connectors:authorization-url', _handleAuthorizationUrl);
    window.cogseed.onPushEvent('client-config:changed', () => {
      if (_connectorsViewActive()) loadConnectors();
    });
    // Commander-driven custom MCP install: the agent calls add_custom_connector,
    // main pushes the confirm request, the user must approve here before it
    // installs (the stdio command / http url is shown verbatim — the consent
    // surface). Queue FIFO so concurrent installs don't stack dialogs.
    window.cogseed.onPushEvent('connectors:install-confirm', (info) => {
      if (!info || typeof info.request_id !== 'string') return;
      _connectorInstallQueue.push(info);
      _drainConnectorInstallQueue();
    });
  } catch (_err) { /* event not supported; harmless */ }
}

const _connectorInstallQueue = [];
let _connectorInstallDialogOpen = false;

async function _drainConnectorInstallQueue() {
  if (_connectorInstallDialogOpen) return;
  _connectorInstallDialogOpen = true;
  try {
    while (_connectorInstallQueue.length) {
      const info = _connectorInstallQueue.shift();
      const warn = info.kind === 'stdio' ? `\n\n${t('connectors.install_confirm.stdio_warning')}` : '';
      const ok = await uiConfirm({
        message: `${t('connectors.install_confirm.message', { name: info.display_name })}\n\n${info.summary}${warn}`,
        okLabel: t('connectors.install_confirm.approve'),
        cancelLabel: t('connectors.install_confirm.decline'),
      });
      try {
        _connectorsTrackClick('connector_install_confirm_response', {
          approved: !!ok,
          transport_kind: info.kind || '',
        });
        await window.cogseed.invoke('connectors.install_confirm_response', {
          request_id: info.request_id,
          approved: !!ok,
        });
        if (ok && _connectorsViewActive()) loadConnectors();
      } catch (err) {
        _connectorsLog.warn('install confirm response failed', { error: err && err.message });
      }
    }
  } finally {
    _connectorInstallDialogOpen = false;
  }
}
