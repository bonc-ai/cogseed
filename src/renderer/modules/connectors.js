// Connectors panel — curated OAuth-only catalog of MCP-based integrations.
//
// Layout: a single scrollable grid view with two stacked sections — connected on top,
// available below. No tab switching; same shape as the Skills panel's
// Custom / Built-in split. Both groups hide themselves when empty.
//
// Click model: only the action buttons on a card are clickable. Clicking elsewhere on a card
// does nothing — users routinely hovered over cards to read descriptions and the old whole-card
// click handler was firing OAuth flows by accident. Buttons stop propagation as a defence in
// depth.
//
// OAuth flow UX: clicking Connect asks main to open the system browser, then the IPC returns
// immediately. The custom-scheme callback finishes exchange + provisioning independently and
// pushes `connectors:oauth-result` back here. **The card itself does NOT stay busy while the user
// is in the browser** — no authorizing badge, no disabled button. Closing/ignoring the browser is
// abandonment, not a connector failure; a second click simply supersedes the earlier flow.

const _connectorsLog = createLogger('connectors');
const _CONNECTORS_RENDER_CACHE_VERSION = 2;
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
      catalog: _connectorsState.catalog,
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

function _showConnectorCliMissingToast() {
  const message = t('connectors.toast.cli_missing');
  if (typeof uiToast === 'function') uiToast(message, { variant: 'warning' });
  else uiAlert(message);
}

/** Single entry point for a card / detail action that cannot run because the provider is
 *  unavailable — keeps the CLI-missing branch ahead of the generic unsupported path. */
function _showConnectorUnavailableToast(entry) {
  if (_isConnectorCliMissing(entry)) _showConnectorCliMissingToast();
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
  const msg = String(message || '');
  if (/fetch failed|network|timeout|timed out|econnreset|econnrefused|eai_again|enotfound|socket|connection (closed|reset|dropped)|terminated|\brefresh_failed\b|刷新授权失败|failed to refresh authorization|認証の更新に失敗|Falha ao atualizar a autorização/i.test(msg)) {
    return _connectorErrorFallback('network');
  }
  if (/invalid_grant|connector_reconnect_required|reconnect required|grant not found|授权已失效|Authorization expired|認証の有効期限|A autorização expirou/i.test(msg)) {
    return _connectorErrorFallback('reconnect');
  }
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

function _renderConnectorsGrid() {
  const gridView = document.getElementById('connectors-grid-view');
  if (!gridView) return;
  // The detail view owns the pane while it is open. Everything below still runs: one repaint
  // path keeps the card grid and the open detail body consistent after a connect, disconnect or
  // verify settles.
  const detailOpen = _connectorsDetailOpen();
  gridView.style.display = detailOpen ? 'none' : '';
  const detailView = document.getElementById('connectors-detail-view');
  if (detailView) detailView.style.display = detailOpen ? '' : 'none';
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
  // A→Z within each group (CLAUDE.md §8 inventory ordering).
  const cmp = (a, b) => (a.entry.display_name || '').localeCompare(b.entry.display_name || '', undefined, { sensitivity: 'base', numeric: true });
  connectedItems.sort(cmp);
  availableItems.sort(cmp);
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

  if (detailOpen) _renderConnectorDetail();
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

  // Brand-color square per design (Surface E) — applied ONLY to the
  // fallback letter glyph (no icon_svg shipped). When a real icon_svg is
  // present, the SVG carries its own brand colors and a dark tint behind
  // it can swallow monochrome marks (GitHub `fill:#181717` on `#16181d`,
  // Notion `fill:#000` on `#000`, etc.) — the SVG sits on the card's own
  // surface instead.
  const brandTint = _CONNECTOR_BRAND_TINT[e.id] || '#16181d';
  const safeIconSvg = typeof sanitizeSvgIconHtml === 'function' ? sanitizeSvgIconHtml(e.icon_svg) : '';
  const iconHtml = safeIconSvg
    ? `<div class="connector-card-icon is-svg">${safeIconSvg}</div>`
    : `<div class="connector-card-icon is-fallback" style="background:${brandTint}">${escapeHtml((e.display_name || '?').slice(0, 1).toUpperCase())}</div>`;
  // Custom cards have no authored description — show the server summary
  // (url / command) so the user can tell their entries apart.
  const desc = e._custom
    ? _customTransportSummary(instance)
    : pickDesc(e, (typeof getLang === 'function') ? getLang() : 'en');

  const accountLabel = (instance && instance.oauth_grant && instance.oauth_grant.account_label) || '';
  const errorMsg = errored && instance && instance.status && instance.status.message;
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
  const isConnecting = _connectorsState.connecting && _connectorsState.connecting.has(e.id);
  if (isConnecting) {
    action = _connectorUiButton({ label: t('connectors.action.connecting'), role: 'primary', size: 'sm', loading: true, attrs: { 'data-act': 'connect' } });
  } else if (isOAuthPending) {
    action = _connectorUiButton({ label: t('connectors.action.unavailable'), role: 'secondary', size: 'sm', disabled: true });
  } else if (isVisibleDisabled) {
    action = _connectorUiButton({ label: t('connectors.action.connect'), role: 'primary', size: 'sm', icon: 'plug', attrs: { 'data-act': 'unsupported-connect' } });
  } else if (connected) {
    const useTitle = formatChatUseLabel({ kind: 'connector', id: e.id, name: e.display_name || e.id });
    action = _connectorUiButton({ label: t('common.use'), role: 'primary', size: 'sm', className: 'connector-card-use', disabled: !enabledFlag, attrs: { 'data-act': 'use-connector', title: useTitle } });
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
  } else if (_isReconnectableError(e, instance)) {
    action = _connectorUiButton({ label: t('connectors.action.connect'), role: 'primary', size: 'sm', icon: 'plug', attrs: { 'data-act': 'connect' } });
  } else if (errored) {
    action = _connectorUiButton({ label: t('connectors.action.disconnect'), role: 'danger', size: 'sm', attrs: { 'data-act': 'disconnect' } });
  } else {
    action = _connectorUiButton({ label: t('connectors.action.connect'), role: 'primary', size: 'sm', icon: 'plug', attrs: { 'data-act': 'connect' } });
  }

  let secondaryHtml = '';
  if (errorMsg) {
    secondaryHtml = '<div class="connector-card-error"></div>';
  } else if (degradedMsg) {
    secondaryHtml = '<div class="connector-card-unverified"></div>';
  } else if (_isConnectorCliMissing(e)) {
    // The reason is machine-dependent and actionable, so it replaces the account line rather
    // than hiding behind the generic "unsupported" toast.
    secondaryHtml = '<div class="connector-card-cli-missing muted"></div>';
  } else if (accountLabel) {
    secondaryHtml = '<div class="connector-card-account muted"></div>';
  }

  // Detail entry point. Only connectors with a registered detail profile get one, so the rest of
  // the grid keeps its current shape and its "no whole-card click" behaviour (see the module
  // header): the transition is an explicit, keyboard-reachable control.
  const detailAction = _connectorDetailProfile(e.id)
    ? _connectorUiButton({
        label: t('connectors.action.details'),
        role: 'ghost',
        size: 'sm',
        attrs: { 'data-act': 'open-detail' },
      })
    : '';

  card.innerHTML = `
    <div class="connector-card-top">
      ${iconHtml}
      <div class="connector-card-headline">
        <div class="connector-card-name"></div>
        ${secondaryHtml}
      </div>
      ${menuHtml}
    </div>
    <div class="connector-card-desc muted"></div>
    <div class="connector-card-foot">${detailAction}${action}</div>
  `;
  card.querySelector('.connector-card-name').textContent = e.display_name;
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
  } else if (_isConnectorCliMissing(e)) {
    const el = card.querySelector('.connector-card-cli-missing');
    const text = t('connectors.toast.cli_missing');
    el.textContent = text;
    el.title = text;
  } else if (accountLabel) {
    const el = card.querySelector('.connector-card-account');
    el.textContent = accountLabel;
    el.title = accountLabel;
  }

  card.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'connect') _runConnect(e);
      else if (act === 'unsupported-connect') _showConnectorUnavailableToast(e);
      else if (act === 'disconnect') _quickDisconnect(e, instance);
      else if (act === 'menu') _openCardMenu(btn, e, instance);
      else if (act === 'open-detail') _openConnectorDetail(e, instance, btn);
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

function _useConnector(entry, instance) {
  if (!instance || !instance.status || instance.status.kind !== 'connected' || instance.enabled === false) return;
  const id = String((instance && instance.id) || (entry && entry.id) || '').trim();
  const name = String((instance && instance.display_name) || (entry && entry.display_name) || id).trim();
  if (!id && !name) return;
  _connectorsTrackClick('connector_use', { ..._connectorTrackPayload(entry, instance), connector_id: id || name });
  setView('new-chat');
  if (typeof setChatRecipient === 'function') {
    setChatRecipient('new-chat', { kind: 'commander' });
  }
  setChatConnector('new-chat', id || name, name || id);
  setTimeout(() => document.getElementById('new-chat-input')?.focus(), 50);
}

async function _toggleConnectorEnabled(entry, instance, nextEnabled) {
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
        uiAlert((res && res.error) || t('component.toggle_failed'));
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
    uiAlert((err && err.message) || t('component.toggle_failed'));
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
    message: t('connectors.confirm_disconnect_msg'),
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

// ─── Connector detail view (grid ⇄ detail) ─────────────────────────────
//
// Registered page-local structural composition: docs/renderer-structural-registry.md ›
// CONN-PV-001. It exists for one business surface (the Tencent Meeting connector, whose
// connection is only half the job — the other half is creating an automation task), so it is
// keyed by catalog id rather than extracted into a shared primitive. Only ids present in
// `_CONNECTOR_DETAIL_PROFILES` get a detail entry point, which is what keeps the rest of the
// grid untouched.
//
// No new persisted field: the three-step indicator derives steps 2 and 3 from the same live
// `connected` flag the card uses, and step 1 (`接入前`) is always complete because the user can
// only reach this view from inside the product.
const _CONNECTOR_DETAIL_PROFILES = {
  'tencent-meeting': {
    /** Auto-task template the primary CTA pre-fills (`_AUTO_TEMPLATES` in auto.js). */
    template_id: 'meeting_digest',
    /** Fallback letter-square tint, used only when the catalog ships no `icon_svg`. */
    brand_tint: '#006EFF',
  },
};

function _connectorDetailProfile(id) {
  return _CONNECTOR_DETAIL_PROFILES[String(id || '')] || null;
}

let _connectorDetailState = { id: '', originEl: null };
/** Last `connectors:authorization-url` notice. A `local_cli` connect produces the URL on this
 *  machine instead of going through a deep link, so when the automatic browser launch fails this
 *  is the only recovery path and the user must be able to copy it. */
let _connectorAuthorizationUrl = null;

function _connectorsDetailOpen() {
  return !!(_connectorDetailState.id && _connectorDetailProfile(_connectorDetailState.id));
}

function _connectorDetailInstanceConnected(instance) {
  return !!(instance && instance.status && instance.status.kind === 'connected');
}

function _connectorDetailTopbarHtml(entry) {
  return [
    _connectorUiButton({
      label: t('common.back'),
      role: 'ghost',
      size: 'sm',
      icon: 'arrow-left',
      attrs: { 'data-connectors-detail-back': '1' },
    }),
    _connectorUiIconButton({
      label: t('connectors.tencent.help_label'),
      title: t('connectors.tencent.help'),
      icon: 'info',
      className: 'connectors-detail-info-btn',
      attrs: { 'data-connectors-detail-help': '1' },
    }),
  ].join('');
}

function _connectorDetailIdentityHtml(entry) {
  const e = entry || {};
  const name = String(e.display_name || e.id || '');
  const desc = e._custom ? '' : pickDesc(e, (typeof getLang === 'function') ? getLang() : 'en');
  const profile = _connectorDetailProfile(e.id) || {};
  const safeIconSvg = typeof sanitizeSvgIconHtml === 'function' ? sanitizeSvgIconHtml(e.icon_svg) : '';
  const iconHtml = safeIconSvg
    ? `<div class="connectors-detail-identity-icon">${safeIconSvg}</div>`
    : `<div class="connectors-detail-identity-icon is-fallback" style="background:${escapeHtml(profile.brand_tint || _CONNECTOR_BRAND_TINT[e.id] || '#16181d')}">${escapeHtml(name.slice(0, 1).toUpperCase())}</div>`;
  return `
    <div class="connectors-detail-identity">
      ${iconHtml}
      <div class="connectors-detail-identity-heading">
        <h2 class="connectors-detail-identity-name">${escapeHtml(name)}</h2>
        <p class="connectors-detail-identity-subtitle">${escapeHtml(desc)}</p>
      </div>
    </div>`;
}

/** Three-step progress indicator. Native `<ol>`/`<li>` semantics with `aria-current="step"` on
 *  the live step, plus a visually hidden state word so the marker's meaning does not depend on
 *  colour or on the icon alone. Not interactive — nothing here needs a keyboard contract. */
function _connectorDetailStepsHtml(connected) {
  const stateOf = ['done', connected ? 'done' : 'current', connected ? 'current' : 'todo'];
  const labels = [
    t('connectors.tencent.step.before'),
    t('connectors.tencent.step.authorize'),
    t('connectors.tencent.step.connected'),
  ];
  const stateWords = {
    done: t('connectors.tencent.step.done'),
    current: t('connectors.tencent.step.current'),
    todo: t('connectors.tencent.step.todo'),
  };
  const items = stateOf.map((state, index) => {
    const mark = state === 'done'
      ? uiIconHtml('check-circle', 'ui-icon connectors-detail-step-glyph')
      : '<span class="connectors-detail-step-dot" aria-hidden="true"></span>';
    return `<li class="connectors-detail-step is-${state}"${state === 'current' ? ' aria-current="step"' : ''}>`
      + `<span class="connectors-detail-step-mark">${mark}</span>`
      + `<span class="connectors-detail-step-label">${escapeHtml(labels[index])}</span>`
      + `<span class="ui-visually-hidden">${escapeHtml(stateWords[state])}</span>`
      + '</li>';
  }).join('');
  return `<ol class="connectors-detail-steps" aria-label="${escapeHtml(t('connectors.tencent.steps.aria'))}">${items}</ol>`;
}

function _connectorDetailAuthUrlHtml(entry) {
  const notice = _connectorAuthorizationUrl;
  if (!notice || !entry || notice.catalog_id !== entry.id) return '';
  return `
    <div class="connectors-detail-auth-url">
      <p class="connectors-detail-auth-url-label">${escapeHtml(t('connectors.tencent.auth_url.label'))}</p>
      <code class="connectors-detail-auth-url-value">${escapeHtml(notice.url)}</code>
      ${_connectorUiButton({
        label: t('connectors.tencent.auth_url.copy'),
        role: 'secondary',
        size: 'sm',
        attrs: { 'data-act': 'copy-auth-url' },
      })}
    </div>`;
}

function _connectorDetailMainPanelHtml(entry, instance) {
  const status = (instance && instance.status) || null;
  const kind = (status && status.kind) || '';
  const connected = kind === 'connected';
  const degraded = kind === 'degraded';
  const errored = kind === 'error';
  const cliMissing = _isConnectorCliMissing(entry);
  const unavailable = _isConnectorVisibleDisabled(entry);
  let tone = 'is-idle';
  let iconName = 'plug';
  let title = t('connectors.tencent.pending.title');
  let desc = t('connectors.tencent.pending.desc');
  let cta = _connectorUiButton({
    label: t('connectors.tencent.pending.cta'),
    role: 'primary',
    size: 'md',
    icon: 'plug',
    disabled: unavailable,
    attrs: { 'data-act': 'connect' },
  });
  let note = '';

  if (connected) {
    tone = 'is-ok';
    iconName = 'check-circle';
    title = t('connectors.tencent.connected.title');
    desc = t('connectors.tencent.connected.desc');
    note = t('connectors.tencent.connected.note');
    cta = _connectorUiButton({
      label: t('connectors.tencent.connected.cta'),
      role: 'primary',
      size: 'md',
      attrs: { 'data-act': 'create-automation' },
    });
  } else if (degraded || errored) {
    // An installed-but-broken connector must not be described as "not connected yet": the user
    // would be told to do the one thing they already did. Same truthfulness rule the card
    // follows, and the same recovery actions (`connectors.refresh` for degraded, disconnect for
    // an errored row).
    iconName = 'info';
    title = degraded ? t('connectors.status.unverified') : t('connectors.status.error');
    desc = _formatConnectorStatusError(status && status.message);
    note = degraded ? _formatLastVerified(status && status.last_verified_at) : '';
    cta = degraded
      ? _connectorUiButton({
          label: t('connectors.action.retry'),
          role: 'primary',
          size: 'md',
          icon: 'refresh',
          attrs: { 'data-act': 'retry-degraded' },
        })
      : _connectorUiButton({
          label: t('connectors.action.disconnect'),
          role: 'danger',
          size: 'md',
          attrs: { 'data-act': 'disconnect' },
        });
  } else if (cliMissing) {
    iconName = 'info';
    title = t('connectors.tencent.cli_missing.title');
    desc = t('connectors.tencent.cli_missing.desc');
  } else if (unavailable) {
    iconName = 'info';
    title = t('connectors.tencent.unavailable.title');
    desc = t('connectors.tencent.unavailable.desc');
  }

  return uiCard({
    className: 'connectors-detail-panel',
    attrs: { 'data-connectors-detail-main': '1' },
    bodyHtml: `
      <div class="connectors-detail-hero">
        <span class="connectors-detail-hero-icon ${tone}">${uiIconHtml(iconName, 'ui-icon connectors-detail-hero-glyph')}</span>
        <h3 class="connectors-detail-hero-title">${escapeHtml(title)}</h3>
        <p class="connectors-detail-hero-desc">${escapeHtml(desc)}</p>
        <div class="connectors-detail-hero-actions">
          ${cta}
          ${note ? `<p class="connectors-detail-hero-note">${escapeHtml(note)}</p>` : ''}
        </div>
        ${_connectorDetailAuthUrlHtml(entry)}
      </div>`,
  });
}

function _connectorDetailStatusPanelHtml(entry, instance) {
  const status = (instance && instance.status) || null;
  const kind = (status && status.kind) || '';
  const connected = kind === 'connected';
  const degraded = kind === 'degraded';
  const errored = kind === 'error';
  const pill = connected
    ? uiStatusPill({ label: t('connectors.tencent.status.connected'), tone: 'success', check: true })
    : (degraded
      ? uiStatusPill({ label: t('connectors.status.unverified'), tone: 'attention' })
      : (errored
        ? uiStatusPill({ label: t('connectors.status.error'), tone: 'critical' })
        : uiStatusPill({ label: t('connectors.tencent.status.disconnected'), tone: 'neutral' })));
  const actions = [
    // `查看会议资料` has no target page yet. Rendering it disabled with a visible reason keeps it
    // discoverable and honest instead of shipping a dead link or hiding the row.
    _connectorUiButton({
      label: t('connectors.tencent.status.view_materials'),
      role: 'ghost',
      size: 'sm',
      disabled: true,
      attrs: { 'data-act': 'view-materials', 'aria-disabled': 'true' },
    }),
    `<span class="connectors-detail-soon-hint">${escapeHtml(t('connectors.tencent.status.view_materials_soon'))}</span>`,
  ];
  // Disconnect removes the connector instance. It is offered whenever an instance exists, and it
  // must never sign the user out of the provider CLI — `_quickDisconnect` calls
  // `connectors.remove`, which drops our instance and nothing else.
  if (connected || degraded || errored) {
    actions.push(_connectorUiButton({
      label: t('connectors.tencent.status.disconnect'),
      role: 'danger',
      size: 'sm',
      attrs: { 'data-act': 'disconnect' },
    }));
  }
  return uiCard({
    className: 'connectors-detail-panel',
    attrs: { 'data-connectors-detail-status': '1' },
    bodyHtml: `
      <div class="connectors-detail-panel-head">
        <h3 class="connectors-detail-panel-title">${escapeHtml(t('connectors.tencent.status.title'))}</h3>
        ${pill}
      </div>
      <p class="connectors-detail-panel-scope">${escapeHtml(t('connectors.tencent.status.scope'))}</p>
      <div class="connectors-detail-panel-actions">${actions.join('')}</div>`,
  });
}

function _connectorDetailHtml(entry, instance) {
  const connected = _connectorDetailInstanceConnected(instance);
  return `
    <div class="connectors-detail-column">
      ${_connectorDetailIdentityHtml(entry)}
      ${_connectorDetailStepsHtml(connected)}
      ${_connectorDetailMainPanelHtml(entry, instance)}
      ${_connectorDetailStatusPanelHtml(entry, instance)}
    </div>`;
}

function _renderConnectorDetail() {
  const topbar = document.getElementById('connectors-detail-topbar');
  const body = document.getElementById('connectors-detail-body');
  if (!topbar || !body) return;
  const id = _connectorDetailState.id;
  const instance = _instanceById(id);
  const entry = _connectorsState.catalog.find((item) => item && item.id === id)
    || (instance ? _entryFromInstance(instance) : { id, display_name: id });
  topbar.innerHTML = _connectorDetailTopbarHtml(entry);
  body.innerHTML = _connectorDetailHtml(entry, instance);
  _bindConnectorDetailActions(topbar, entry, instance);
  _bindConnectorDetailActions(body, entry, instance);
  if (typeof hydrateUiIcons === 'function') {
    hydrateUiIcons(topbar);
    hydrateUiIcons(body);
  }
}

function _bindConnectorDetailActions(host, entry, instance) {
  if (!host) return;
  const back = host.querySelector('[data-connectors-detail-back]');
  if (back) back.addEventListener('click', () => _closeConnectorDetail());
  // The "(i)" disclosure: a shared icon button plus the shared alert surface. Deliberately no
  // page-local overlay — the accessible name and the native tooltip both carry the help text, so
  // the explanation is reachable from the keyboard without opening anything.
  const help = host.querySelector('[data-connectors-detail-help]');
  if (help) help.addEventListener('click', () => uiAlert(t('connectors.tencent.help')));
  host.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if (act === 'connect') _runConnect(entry);
      else if (act === 'create-automation') _openConnectorAutomation(entry);
      else if (act === 'disconnect') _quickDisconnect(entry, instance);
      else if (act === 'retry-degraded') _retryConnect(entry, 'connector_degraded_retry');
      else if (act === 'copy-auth-url') _copyConnectorAuthorizationUrl(entry);
    });
  });
}

function _focusConnectorDetailBack() {
  const body = document.getElementById('connectors-detail-body');
  const topbar = document.getElementById('connectors-detail-topbar');
  const btn = (topbar && topbar.querySelector('[data-connectors-detail-back]'))
    || (body && body.querySelector('[data-connectors-detail-back]'));
  if (btn && typeof btn.focus === 'function') btn.focus({ preventScroll: true });
}

function _openConnectorDetail(entry, instance, originEl) {
  const id = String((entry && entry.id) || (instance && instance.id) || '');
  if (!id || !_connectorDetailProfile(id)) return;
  const view = document.getElementById('connectors-detail-view');
  // No detail host (partial DOM, e.g. a test double): leave the grid working rather than hiding it.
  if (!view) return;
  if (_connectorDetailState.id !== id) {
    _connectorsTrackClick('connector_detail_open', _connectorTrackPayload(entry, instance));
  }
  _connectorDetailState.id = id;
  _connectorDetailState.originEl = originEl || _connectorDetailState.originEl || null;
  const gridView = document.getElementById('connectors-grid-view');
  if (gridView) gridView.style.display = 'none';
  view.style.display = '';
  _renderConnectorDetail();
  _focusConnectorDetailBack();
}

/** Grid ⇄ detail return. Focus goes back to the card control that opened the view; because the
 *  grid repaint below rebuilds the card, the original node is normally detached and the lookup
 *  falls back to the same control on the re-rendered card. */
function _closeConnectorDetail() {
  const id = _connectorDetailState.id;
  if (!id) return;
  const origin = _connectorDetailState.originEl;
  _connectorDetailState.id = '';
  _connectorDetailState.originEl = null;
  const view = document.getElementById('connectors-detail-view');
  const topbar = document.getElementById('connectors-detail-topbar');
  const body = document.getElementById('connectors-detail-body');
  if (topbar) topbar.innerHTML = '';
  if (body) body.innerHTML = '';
  if (view) view.style.display = 'none';
  _renderConnectorsGrid();
  const target = (origin && origin.isConnected) ? origin : _connectorDetailReturnTarget(id);
  if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
}

function _connectorDetailReturnTarget(id) {
  const cards = document.querySelectorAll('.connector-card[data-id]');
  for (const card of cards) {
    if (card.dataset && card.dataset.id === id) return card.querySelector('[data-act="open-detail"]');
  }
  return null;
}

/** Escape leaves the detail view for the grid — the same document-level pattern the marketplace
 *  detail view uses. IME composition is ignored, and an open shared modal keeps its own Escape
 *  handling so one Escape never both dismisses a dialog and changes the page. */
function _connectorDetailKeydown(event) {
  if (!_connectorDetailState.id || !_connectorsViewActive()) return;
  if (!event || event.isComposing || event.keyCode === 229) return;
  if (event.key !== 'Escape') return;
  // Only when the detail view is the surface the user is actually looking at: the selection
  // survives a tab or sub-view switch, and Escape there belongs to whatever replaced it.
  const view = document.getElementById('connectors-detail-view');
  if (!view || view.style.display === 'none') return;
  const pane = document.getElementById('connections-pane-mcp');
  if (pane && pane.hidden) return;
  const target = event.target;
  if (target && typeof target.closest === 'function' && target.closest('.ui-modal-overlay')) return;
  event.stopPropagation();
  _closeConnectorDetail();
}

/** Primary CTA: land on the automation page with the meeting-digest template pre-filled.
 *  The template grid only exists in the empty state, so the dialog pre-fill path is the only
 *  reliable route. auto.js is a lazily loaded feature, hence the loader hop before reaching into
 *  it; `_autoApplyTemplate` opens the dialog itself, so calling `openAutoTaskDialog` too would
 *  open it twice. */
function _openConnectorAutomation(entry) {
  const profile = _connectorDetailProfile(entry && entry.id);
  const templateId = (profile && profile.template_id) || '';
  _connectorsTrackClick('connector_detail_automation', _connectorTrackPayload(entry, _instanceById(entry && entry.id)));
  if (typeof setView === 'function') setView('auto');
  const run = () => {
    if (templateId && typeof window.applyAutoTemplate === 'function') {
      window.applyAutoTemplate(templateId);
      return;
    }
    if (typeof window.openAutoTaskDialog === 'function') window.openAutoTaskDialog({});
  };
  const loader = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
  if (typeof loader !== 'function') {
    run();
    return;
  }
  Promise.resolve(loader('auto')).then(run).catch((err) => {
    _connectorsLog.warn('auto feature load failed', { error: (err && err.message) || String(err) });
  });
}

/** A `local_cli` connect produces its authorization URL here rather than through a deep link. The
 *  browser is opened by main; if that fails, this URL is the only way forward, so surface it where
 *  the user can copy it instead of leaving it in module state they cannot see. */
function _handleAuthorizationUrl(notice) {
  if (!notice || typeof notice.catalog_id !== 'string' || typeof notice.url !== 'string') return;
  const url = notice.url.trim();
  if (!notice.catalog_id || !url) return;
  _connectorAuthorizationUrl = { catalog_id: notice.catalog_id, url };
  if (_connectorDetailState.id === notice.catalog_id) {
    _renderConnectorDetail();
    return;
  }
  if (_connectorsViewActive() && _connectorDetailProfile(notice.catalog_id)) {
    _openConnectorDetail({ id: notice.catalog_id }, _instanceById(notice.catalog_id), null);
    return;
  }
  if (typeof uiToast === 'function') uiToast(t('connectors.tencent.auth_url.toast'), { variant: 'warning' });
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
    if (typeof uiToast === 'function') uiToast(t('connectors.tencent.auth_url.copied'), { variant: 'success' });
  } catch (err) {
    _connectorsLog.warn('authorization url copy failed', { error: (err && err.message) || String(err) });
    uiAlert(t('connectors.tencent.auth_url.copy_failed'));
  }
}

async function _runConnect(entry) {
  if (_isConnectorVisibleDisabled(entry)) {
    _showConnectorUnavailableToast(entry);
    return;
  }
  const payload = _connectorTrackPayload(entry, null);
  const startedAt = performance.now();
  _connectorsTrackClick('connector_connect', payload);
  // Show a spinner only while main validates and accepts the launch. The renderer must not hold
  // the card in a ten-minute "connecting" state while the user is in an external browser.
  _connectorsState.connecting.add(entry.id);
  _renderConnectorsGrid();
  try {
    const res = await window.cogseed.invoke('connectors.start_oauth', { catalog_id: entry.id });
    if (res && res.ok && res.started && typeof res.attempt_id === 'string' && res.attempt_id) {
      _pendingConnectAttempts.set(res.attempt_id, { payload, startedAt });
    } else if (res && !res.ok) {
      _handleConnectFailure(payload, startedAt, res);
    } else {
      _handleConnectFailure(payload, startedAt, { code: 'empty_response' });
    }
  } catch (err) {
    _handleConnectFailure(payload, startedAt, err);
  } finally {
    _connectorsState.connecting.delete(entry.id);
    _renderConnectorsGrid();
  }
}

function _handleOAuthConnectResult(info) {
  if (!info || typeof info.attempt_id !== 'string' || typeof info.catalog_id !== 'string') return;
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
  const overlay = document.createElement('div');
  overlay.className = 'ui-modal-overlay';
  const formHtml = uiForm({
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
            value: 'streamable-http',
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
    actions: [
      { label: t('common.cancel'), role: 'secondary', attrs: { 'data-act': 'cancel' } },
      { label: t('connectors.custom.submit'), role: 'primary', icon: 'plug', attrs: { 'data-act': 'ok' } },
    ],
  });
  overlay.innerHTML = `
    <section class="ui-modal connector-custom-dialog" role="dialog" aria-modal="true" aria-labelledby="connector-custom-title">
      <header class="ui-modal__header">
        <div class="ui-modal__heading">
          <h2 class="ui-modal__title" id="connector-custom-title">${escapeHtml(t('connectors.custom.title'))}</h2>
        </div>
      </header>
      <div class="ui-modal__body">
        ${formHtml}
      </div>
    </section>
  `;
  document.body.appendChild(overlay);

  const f = (name) => overlay.querySelector(`[data-f="${name}"]`);
  const secHttp = overlay.querySelector('[data-sec="http"]');
  const secStdio = overlay.querySelector('[data-sec="stdio"]');
  const syncKindSections = (value) => {
    const stdio = value === 'stdio';
    secHttp.hidden = stdio;
    secStdio.hidden = !stdio;
  };
  const kindHost = overlay.querySelector('#connector-custom-kind');
  let kindSelect = null;
  if (typeof hydrateUiFormSelects === 'function') {
    hydrateUiFormSelects(overlay, { 'connector-custom-kind': syncKindSections });
    kindSelect = kindHost && kindHost._uiSelectApi;
  }
  const readKind = () => (kindSelect && typeof kindSelect.getValue === 'function'
    ? kindSelect.getValue()
    : 'streamable-http');
  syncKindSections(readKind());
  const form = overlay.querySelector('form');
  if (form) form.addEventListener('submit', (event) => event.preventDefault());

  // 四项行为（ESC / 背景滚动锁定 / 焦点陷阱 / 焦点回归）统一走 uiModalController。
  const dialog = overlay.querySelector('[role="dialog"]');
  const controller = typeof uiModalController === 'function'
    ? uiModalController({ overlay, dialog, initialFocus: '[data-f="name"]', onClose: () => overlay.remove() })
    : null;
  const close = () => {
    if (controller) controller.close('action');
    else overlay.remove();
  };
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', close);

  const okBtn = overlay.querySelector('[data-act="ok"]');
  okBtn.addEventListener('click', async () => {
    const kind = readKind();
    let transport;
    if (kind === 'stdio') {
      const env = _parseEnvLines(f('env').value);
      if (env === null) { uiAlert(t('connectors.custom.bad_env')); return; }
      transport = {
        kind: 'stdio',
        command: f('command').value.trim(),
        args: f('args').value.split('\n').map((s) => s.trim()).filter(Boolean),
        env,
      };
    } else {
      const headers = _parseHeaderLines(f('headers').value);
      if (headers === null) { uiAlert(t('connectors.custom.bad_headers')); return; }
      transport = { kind: 'streamable-http', url: f('url').value.trim(), headers };
    }
    okBtn.disabled = true;
    okBtn.classList.add('is-loading');
    okBtn.setAttribute('aria-busy', 'true');
    _setConnectorButtonPresentation(okBtn, t('connectors.action.connecting'));
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
        close();
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
        uiAlert((res && res.error) || t('connectors.errors.connect_failed'));
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
      uiAlert((err && err.message) || t('connectors.errors.connect_failed'));
    } finally {
      okBtn.disabled = false;
      okBtn.classList.remove('is-loading');
      okBtn.removeAttribute('aria-busy');
      _setConnectorButtonPresentation(okBtn, t('connectors.custom.submit'));
    }
  });
  if (controller) controller.open();
  else setTimeout(() => f('name').focus(), 0);
}

function _formatConnectError(errLike) {
  const code = errLike && errLike.code;
  const msg = (errLike && (errLike.error || errLike.message)) || '';
  if (code === 'connector_unsupported' || /connector_unsupported/i.test(String(msg))) {
    return t('connectors.toast.unsupported');
  }
  if (code === 'missing_required_scopes' || /missing_required_scopes|missing required scopes/i.test(String(msg))) {
    return t('connectors.errors.missing_required_scopes');
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

// Escape returns from the detail view to the grid (see `_connectorDetailKeydown`).
document.addEventListener('keydown', _connectorDetailKeydown);

// Refresh the grid when a connector or client-config push arrives. Right now the
// only consumer is the connectors panel itself, but registering at module load lets future
// background events (token expiry notifications etc.) refresh the panel automatically.
if (window.cogseed && typeof window.cogseed.onPushEvent === 'function') {
  try {
    window.cogseed.onPushEvent('connectors:changed', () => {
      if (_connectorsViewActive()) loadConnectors();
    });
    window.cogseed.onPushEvent('connectors:oauth-result', _handleOAuthConnectResult);
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
