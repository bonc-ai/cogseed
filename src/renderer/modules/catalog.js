// ─── S4 Catalog: platform grouping + unified detail popup ─────────────────
//
// Shared by the Agents and Skills pages (specs/009-agent-skill-pages):
//   • Platform content is one group with no source labels. Installed rows
//     (including legacy bundled `seed_source: builtin` and `default_install`
//     content, which normalize to `marketplace`) come first; catalog rows not
//     yet on this device follow.
//   • Every card opens the same detail popup, built on the connector usage
//     popup layout (`connectors.js` `_openConnectorPopup`, registry CONN-PV-003)
//     and its `.connector-popup-*` styles. Registry entry: S4-PV-001.
//
// Pure helpers (grouping, actions, examples) carry no DOM/IPC so they can be
// unit-tested in a vm context; the popup and catalog loading use the shared
// renderer seams (`uiModal`, `uiButton`, `uiStatusPill`, `t`).
// Lives in the `marketplace` lazy bundle after marketplace.js: install and
// uninstall delegate to `_mpInstall` / `_mpUninstall` via `_mpEnsureState`.

const _catalogLog = typeof createLogger === 'function'
  ? createLogger('catalog')
  : { warn() {}, info() {}, error() {} };

const CATALOG_PAGE_SIZE = 50;
const CATALOG_MAX_PAGES = 10;

// ── Pure helpers ──────────────────────────────────────────────────────────

/** Whether a catalog row is unavailable for new installs (Hub-disabled / delisted). */
function catalogRowBlocked(row) {
  if (!row || !row.id) return true;
  if (typeof HubContentStatus !== 'undefined' && HubContentStatus
    && typeof HubContentStatus.isHubContentDisabled === 'function') {
    try { if (HubContentStatus.isHubContentDisabled(row)) return true; } catch (_) { /* treat as available */ }
  }
  return false;
}

/**
 * Split platform content into installed (first) and not-yet-installed rows.
 * `installed` are local rows whose normalized source is `marketplace`;
 * `catalogRows` are Hub catalog rows. Catalog rows already installed, blocked
 * or missing an id are dropped from the second list.
 * `keepIds` (optional) are rows installed during this page visit: they stay at
 * their catalog position — in `tail` with their local row in `kept` — instead of
 * jumping to the installed block, so the user finds what they just installed.
 */
function catalogSplitPlatform(installed, catalogRows, idOf, keepIds) {
  const getId = typeof idOf === 'function' ? idOf : (row) => row && (row.agent_id || row.id);
  const local = Array.isArray(installed) ? installed.filter(Boolean) : [];
  const localById = new Map(local.map((row) => [String(getId(row) || ''), row]).filter(([id]) => id));
  const keep = keepIds && typeof keepIds.has === 'function' ? keepIds : new Set(Array.isArray(keepIds) ? keepIds.map(String) : []);
  const seen = new Set();
  const notInstalled = [];
  const tail = [];
  const kept = new Map();
  for (const row of Array.isArray(catalogRows) ? catalogRows : []) {
    const id = String((row && row.id) || '');
    if (!id || seen.has(id) || catalogRowBlocked(row)) continue;
    if (localById.has(id)) {
      if (!keep.has(id)) continue;
      kept.set(id, localById.get(id));
    } else {
      notInstalled.push(row);
    }
    seen.add(id);
    tail.push(row);
  }
  return {
    installed: kept.size ? local.filter((row) => !kept.has(String(getId(row) || ''))) : local,
    notInstalled,
    tail,
    kept,
  };
}

/**
 * Which buttons the popup footer shows (spec FR-007). `origin` is one of
 * commander | external | own | platform | package | global.
 */
function catalogPopupActions(origin, state) {
  const s = state || {};
  if (origin === 'platform' && !s.installed) return { primary: s.failed ? 'retry' : 'install', secondary: [] };
  const toggle = s.enabled === false ? 'enable' : 'disable';
  switch (origin) {
    case 'commander': return { primary: 'use', secondary: [] };
    case 'external': return { primary: 'use', secondary: ['manage', toggle] };
    case 'own': return { primary: 'use', secondary: s.contributable ? ['contribute', 'manage', toggle] : ['manage', toggle] };
    case 'package': return { primary: 'use', secondary: [toggle, 'remove'] };
    case 'global': return { primary: 'use', secondary: [toggle] };
    case 'platform':
    // 卸载只在「已安装」页（2026-10-20 定）：弹窗只放和「用」有关的操作。
    // 随包内容不进「已安装」页、用户不管理（2026-10-21 定）：不给停用 / 更新，
    // 只在**用户自己**停用过时留一个「启用」，免得再也开不回来。被 Hub 停用时不给：
    // 用户的启用改不动 Hub 的停用（与智能体行菜单同一口径）。
    default:
      if (s.bundled) return { primary: 'use', secondary: s.enabled === false && !s.hubDisabled ? ['enable'] : [] };
      // 被 Hub 停用：用户的启停改不动它，Hub 也不再给装新版本，弹窗不放开关和更新。
      if (s.hubDisabled) return { primary: 'use', secondary: [] };
      return { primary: 'use', secondary: s.updateAvailable ? ['update', toggle] : [toggle] };
  }
}

/** Popup footer actions plus the one-click 「启用「技能名」」 when a dependency is turned off (FR-027). */
function _catalogViewActions(origin, view) {
  const actions = catalogPopupActions(origin, view);
  if (view && view.enableDep && actions.primary === 'use') actions.secondary = ['enable_dep', ...actions.secondary];
  return actions;
}

/** Examples shown in the popup; falls back to one generic example (spec FR-026). */
function catalogExamples(item, genericText) {
  const raw = item && (item.examples || item.example_prompts);
  const list = (Array.isArray(raw) ? raw : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry && (entry.prompt || entry.text)))
    .map((text) => String(text || '').trim())
    .filter(Boolean);
  if (list.length) return list.slice(0, 5);
  const fallback = String(genericText || '').trim();
  return fallback ? [fallback] : [];
}

// ── Catalog loading (Hub listings, per kind) ─────────────────────────────

const _catalogState = {
  agent: { rows: [], loaded: false, loading: null, error: '' },
  skill: { rows: [], loaded: false, loading: null, error: '' },
};
const _catalogListeners = new Set();

function catalogOnChange(fn) {
  if (typeof fn === 'function') _catalogListeners.add(fn);
  return () => _catalogListeners.delete(fn);
}

function _catalogNotify(kind) {
  for (const fn of _catalogListeners) {
    try { fn(kind); } catch (err) { _catalogLog.warn('catalog listener failed', { error: (err && err.message) || String(err) }); }
  }
}

function catalogRows(kind) {
  const st = _catalogState[kind === 'skill' ? 'skill' : 'agent'];
  return st.rows;
}

function catalogStatus(kind) {
  const st = _catalogState[kind === 'skill' ? 'skill' : 'agent'];
  return { loaded: st.loaded, loading: !!st.loading, error: st.error, signedOut: _catalogAccount.signedOut };
}

// ── Hub sign-in (spec FR-023): signed out → platform shows installed only + a sign-in hint;
//    installing asks to sign in first. Gate closed (`release_enabled: false`) = no sign-in concept,
//    the catalog behaves as before.
const _catalogAccount = { signedOut: false, checked: false, loading: null, wired: false };

function _catalogRefreshAccount() {
  if (_catalogAccount.loading) return _catalogAccount.loading;
  _catalogAccount.loading = (async () => {
    let signedOut = false;
    try {
      const r = await window.cogseed.invoke('hub-account.status', {});
      const status = r && r.status;
      signedOut = !!status && status.release_enabled !== false && status.signed_in === false;
    } catch (_) { signedOut = false; /* unknown → don't hide content */ }
    const changed = signedOut !== _catalogAccount.signedOut || !_catalogAccount.checked;
    _catalogAccount.signedOut = signedOut;
    _catalogAccount.checked = true;
    _catalogAccount.loading = null;
    if (changed) { _catalogNotify('agent'); _catalogNotify('skill'); }
    return signedOut;
  })();
  if (!_catalogAccount.wired && window.cogseed && typeof window.cogseed.onPushEvent === 'function') {
    _catalogAccount.wired = true;
    window.cogseed.onPushEvent('hub-account:login-result', () => {
      void _catalogRefreshAccount().then(() => { catalogLoad('agent', { force: true }); catalogLoad('skill', { force: true }); });
    });
  }
  return _catalogAccount.loading;
}

/** Ask to sign in before an install; resolves true once signed in (or when sign-in isn't required). */
async function catalogEnsureSignedIn(name) {
  if (!await _catalogRefreshAccount()) return true;
  const proceed = typeof uiConfirm === 'function'
    ? await uiConfirm({ message: t('catalog.login_to_install', { name: name || '' }), okLabel: t('catalog.login') })
    : false;
  if (!proceed) return false;
  return _catalogStartLogin();
}

async function _catalogStartLogin() {
  const result = new Promise((resolve) => {
    let done = false;
    let unsubscribe = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (typeof unsubscribe === 'function') unsubscribe();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 5 * 60_000);
    if (window.cogseed && typeof window.cogseed.onPushEvent === 'function') {
      unsubscribe = window.cogseed.onPushEvent('hub-account:login-result', (outcome) => finish(!!outcome && outcome.result === 'success'));
    }
  });
  try { await window.cogseed.invoke('hub-account.start_login', {}); } catch (_) { return false; }
  const ok = await result;
  await _catalogRefreshAccount();
  return ok;
}

/**
 * What follows the platform cards (spec FR-025): skeleton cards while the catalog is still loading
 * for the first time; a 「平台暂时没有更多」 note once it loaded and nothing is left to install.
 * `pendingTotal` is the not-installed count before search / category filters; `filtering` hides
 * the note while the user is narrowing the list (the empty-search state speaks instead).
 */
function catalogPlatformTail(kind, pendingTotal, filtering) {
  const st = catalogStatus(kind);
  if (st.signedOut) return { cards: '', note: '' };
  if (st.loading && !st.loaded && typeof uiSkeleton === 'function') {
    const card = () => `<div class="ui-resource-card catalog-skeleton-card">${uiSkeleton({ ariaLabel: t('catalog.loading_platform'), withMedia: true })}</div>`;
    return { cards: card() + card(), note: '' };
  }
  if (st.loaded && !st.error && !pendingTotal && !filtering) {
    return { cards: '', note: `<p class="catalog-platform-note">${escapeHtml(t('catalog.platform_no_more'))}</p>` };
  }
  return { cards: '', note: '' };
}

/** Banner above the platform group: signed out → sign-in hint; catalog unreachable → retry. '' otherwise. */
function catalogHomeBannerHtml(kind) {
  const st = catalogStatus(kind);
  if (st.signedOut) {
    return `<div class="marketplace-reconcile-banner catalog-home-banner" data-catalog-banner="login">
        <span>${escapeHtml(t('catalog.login_banner'))}</span>${uiButton({ label: t('catalog.login'), role: 'secondary', size: 'sm', attrs: { 'data-catalog-banner-action': 'login' } })}
      </div>`;
  }
  if (st.error && !st.loading) {
    return `<div class="marketplace-reconcile-banner catalog-home-banner" data-catalog-banner="offline">
        <span>${escapeHtml(t('catalog.offline_banner'))}</span>${uiButton({ label: t('catalog.retry'), role: 'secondary', size: 'sm', attrs: { 'data-catalog-banner-action': 'retry' } })}
      </div>`;
  }
  return '';
}

function catalogWireBanner(rootEl, kind) {
  const btn = rootEl && rootEl.querySelector('[data-catalog-banner-action]');
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (btn.dataset.catalogBannerAction === 'login') {
      if (await _catalogStartLogin()) catalogLoad(kind, { force: true });
    } else {
      catalogLoad(kind, { force: true });
    }
  });
}

/** Fetch every page of the Hub catalog for one kind. Concurrent callers share one request. */
function catalogLoad(kind, opts = {}) {
  const key = kind === 'skill' ? 'skill' : 'agent';
  const st = _catalogState[key];
  if (st.loading) return st.loading;
  if (st.loaded && !opts.force) return Promise.resolve(st.rows);
  const channel = key === 'agent' ? 'marketplace.listAgents' : 'marketplace.listSkills';
  st.loading = (async () => {
    const rows = [];
    await _catalogRefreshAccount();
    try {
      for (let page = 1; page <= CATALOG_MAX_PAGES; page++) {
        const r = await window.cogseed.invoke(channel, { page, size: CATALOG_PAGE_SIZE });
        // IPC 把主进程的失败（断网、Hub 不可用）回成 `{ok:false}` 而不是抛出；不当失败处理，
        // 首页就会把它当成「平台暂无内容」，既不提示也不给重试（FR-023）。
        if (r && r.ok === false) throw new Error(r.error || 'catalog_unavailable');
        const list = (r && Array.isArray(r.list)) ? r.list : [];
        rows.push(...list);
        const total = r && typeof r.total === 'number' ? r.total : rows.length;
        if (list.length < CATALOG_PAGE_SIZE || rows.length >= total) break;
      }
      st.rows = rows;
      st.loaded = true;
      st.error = '';
    } catch (err) {
      st.error = (err && err.message) || String(err);
      // 平台不可用时只显示已安装的（FR-023）：丢掉上次的目录，否则未安装的卡片还在、装不了。
      st.rows = [];
      _catalogLog.warn('catalog load failed', { kind: key, error: st.error });
    } finally {
      st.loading = null;
      _catalogNotify(key);
    }
    return st.rows;
  })();
  _catalogNotify(key);
  return st.loading;
}

// ── Just installed (this page visit) ──────────────────────────────────────
// A fresh install keeps its card where the user clicked it (spec FR-002); the
// list re-sorts only after leaving the page (`catalogResetJustInstalled`, called
// from `setView` and the sub-view switches). `flash` marks the one-time highlight.
const _catalogJustInstalled = { agent: new Map(), skill: new Map() };

function catalogJustInstalledIds(kind) {
  return new Set(_catalogJustInstalled[kind === 'skill' ? 'skill' : 'agent'].keys());
}

/** True once per fresh install: the first render that shows the installed card highlights it. */
function catalogTakeJustInstalledFlash(kind, id) {
  const entry = _catalogJustInstalled[kind === 'skill' ? 'skill' : 'agent'].get(String(id || ''));
  if (!entry || !entry.flash) return false;
  entry.flash = false;
  return true;
}

function catalogResetJustInstalled() {
  _catalogJustInstalled.agent.clear();
  _catalogJustInstalled.skill.clear();
}

/** Install (or update) a catalog row through the existing marketplace install flow.
 *  Resolves true when installed; never navigates (spec FR-010). */
async function catalogInstall(kind, row, opts = {}) {
  if (!row || !row.id || typeof _mpInstall !== 'function') return false;
  if (!await catalogEnsureSignedIn(row.name || row.id)) return false;
  if (typeof _mpEnsureState === 'function') _mpEnsureState();
  const key = kind === 'skill' ? 'skill' : 'agent';
  const install = _mpInstall(key, row.id, row, { quiet: true });
  _catalogNotify(key);
  let ok = false;
  try {
    ok = (await install) === true;
    if (ok && !opts.update) _catalogJustInstalled[key].set(String(row.id), { flash: true });
    return ok;
  } finally { _catalogNotify(key); }
}

async function catalogUninstall(kind, id) {
  if (!id || typeof _mpUninstall !== 'function') return false;
  if (typeof _mpEnsureState === 'function') _mpEnsureState();
  const key = kind === 'skill' ? 'skill' : 'agent';
  try { return (await _mpUninstall(key, id)) === true; } finally { _catalogNotify(key); }
}

function _catalogKey(kind, id) { return `${kind === 'skill' ? 'skill' : 'agent'}:${id}`; }
function _catalogMp() { return typeof _mpState !== 'undefined' && _mpState ? _mpState : null; }

function catalogIsInstalling(kind, id) {
  const mp = _catalogMp();
  return !!mp && !!mp.installing && mp.installing.has(_catalogKey(kind, id));
}

/** Last install failure text for this item (cleared on the next attempt), or ''. */
function catalogInstallFailure(kind, id) {
  const mp = _catalogMp();
  return (mp && mp.installFailed && mp.installFailed.get(_catalogKey(kind, id))) || '';
}

/** The Hub catalog row for an installed item when the Hub has a newer version, else null. */
function catalogUpdateRow(kind, id) {
  if (!id || typeof _mpInstallStatus !== 'function' || !_catalogMp()) return null;
  const row = catalogRows(kind).find((r) => r && String(r.id) === String(id));
  if (!row) return null;
  try { return _mpInstallStatus(kind === 'skill' ? 'skill' : 'agent', row).updateAvailable ? row : null; } catch (_) { return null; }
}

// ── 已安装的智能体 / 技能（list rows, spec FR-014～016） ─────────────────

/*
 * Row shape used below: { id, name, desc, category, version, avatarHtml, enabled,
 *   updateVersion (newer Hub version or ''), blocked (Hub-disabled / dependency off), pills: [{label, tone}] }.
 * Interaction is delegated by the page via `data-catalog-row` / `data-catalog-row-action`.
 */

/** Needs the user's attention: an update, something blocking use, or turned off. */
function _catalogRowNeedsAttention(r) {
  return !!(r && (r.updateVersion || r.blocked || r.enabled === false));
}

/** Rows that need attention first (spec 2026-10-20 redesign), each group by name. */
function catalogInstalledSort(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && r.id) : [];
  const byName = (a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, { numeric: true, sensitivity: 'base' });
  return [...list.filter(_catalogRowNeedsAttention).sort(byName), ...list.filter((r) => !_catalogRowNeedsAttention(r)).sort(byName)];
}

/** Status filter: '' all · 'update' has a newer version · 'off' turned off. */
function catalogInstalledFilter(rows, filter) {
  const list = Array.isArray(rows) ? rows : [];
  if (filter === 'update') return list.filter((r) => r && r.updateVersion);
  if (filter === 'off') return list.filter((r) => r && r.enabled === false);
  return list;
}

/** Counts for the filter labels and the summary line. */
function catalogInstalledSummary(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  return {
    total: list.length,
    off: list.filter((r) => r.enabled === false).length,
    update: list.filter((r) => r.updateVersion).length,
  };
}

function catalogInstalledFilterHtml(summary, value) {
  if (typeof window.uiSegmentedControl !== 'function') return '';
  const s = summary || { total: 0, off: 0, update: 0 };
  return window.uiSegmentedControl({
    ariaLabel: t('catalog.installed_filter_label'),
    value: value || '',
    className: 'catalog-installed-filter',
    items: [
      { label: t('catalog.installed_filter_all', { n: s.total }), value: '', attrs: { 'data-catalog-filter': '' } },
      { label: t('catalog.installed_filter_update', { n: s.update }), value: 'update', attrs: { 'data-catalog-filter': 'update' } },
      { label: t('catalog.installed_filter_off', { n: s.off }), value: 'off', attrs: { 'data-catalog-filter': 'off' } },
    ],
  });
}

/** Breadcrumb for the toolbar's left side: 「‹ 返回技能 / 已安装的技能」. */
function catalogInstalledCrumbHtml(kind, backAttrs) {
  const isSkill = kind === 'skill';
  return `<div class="catalog-installed-crumb">${uiButton({
    label: t(isSkill ? 'catalog.back_skills' : 'catalog.back_agents'), role: 'ghost', size: 'sm', icon: 'chevron-left', attrs: backAttrs || {},
  })}<span class="catalog-subview-sep" aria-hidden="true">/</span><strong>${escapeHtml(t(isSkill ? 'catalog.installed_skills_title' : 'catalog.installed_agents_title'))}</strong></div>`;
}

function catalogInstalledSummaryHtml(kind, summary) {
  const s = summary || { total: 0, off: 0, update: 0 };
  const parts = [t(kind === 'skill' ? 'catalog.installed_summary_skills' : 'catalog.installed_summary_agents', { n: s.total })];
  if (s.off) parts.push(t('catalog.installed_summary_off', { n: s.off }));
  if (s.update) parts.push(t('catalog.installed_summary_update', { n: s.update }));
  return `<p class="catalog-installed-summary">${escapeHtml(parts.join(' · '))}${escapeHtml(t('catalog.installed_summary_hint'))}</p>`;
}

/**
 * Card grid, three per row on desktop (2026-10-20, after the WorkBuddy / 豆包 manage pages):
 * avatar · name with status pills · two-line description, switch and 「⋯」 top-right.
 */
function catalogInstalledGridHtml(rows, kind) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && r.id) : [];
  const pill = (p) => (typeof uiStatusPill === 'function' ? uiStatusPill({ label: p.label, tone: p.tone || 'neutral' }) : escapeHtml(p.label));
  const cards = list.map((r) => {
    const on = r.enabled !== false;
    const name = String(r.name || r.id);
    const pills = (Array.isArray(r.pills) ? r.pills : []).filter((p) => p && p.label).map(pill).join('');
    // 被 Hub 停用的行开关置灰：用户的启停改不动 Hub 的停用（与智能体行菜单同一口径）。
    const toggle = typeof uiSwitch === 'function' ? uiSwitch({
      label: `${t(on ? 'catalog.disable' : 'catalog.enable')} ${name}`,
      checked: on,
      disabled: !!r.hubDisabled,
      attrs: { 'data-catalog-row-action': 'toggle' },
    }) : '';
    const more = typeof uiIconButton === 'function' ? uiIconButton({
      label: `${t('catalog.more_actions')} ${name}`, icon: 'more-horizontal', size: 'sm',
      attrs: { 'data-catalog-row-action': 'more' },
    }) : '';
    return `<div class="catalog-installed-card${on ? '' : ' is-off'}" data-catalog-row="${escapeHtml(r.id)}" data-catalog-kind="${kind === 'skill' ? 'skill' : 'agent'}">
        <span class="catalog-installed-card__avatar">${r.avatarHtml || ''}</span>
        <div class="catalog-installed-card__text">
          <strong class="catalog-installed-card__name">${escapeHtml(name)}</strong>
          ${pills ? `<span class="catalog-installed-card__pills">${pills}</span>` : ''}
          <p class="catalog-installed-card__desc">${escapeHtml(r.desc || t('catalog.no_desc'))}</p>
        </div>
        <span class="catalog-installed-card__actions">${toggle}${more}</span>
      </div>`;
  }).join('');
  return `<div class="catalog-installed-grid">${cards}</div>`;
}

// ── Row 「⋯」 menu (installed view). Uninstall lives here, not beside every switch. ──

function catalogCloseRowMenu() {
  const menu = document.getElementById('catalog-row-menu');
  if (menu) menu.remove();
  document.removeEventListener('mousedown', _catalogRowMenuOutside, true);
  document.removeEventListener('keydown', _catalogRowMenuKey, true);
}

function _catalogRowMenuOutside(e) {
  const menu = document.getElementById('catalog-row-menu');
  if (menu && !menu.contains(e.target)) catalogCloseRowMenu();
}

function _catalogRowMenuKey(e) {
  if (e.key === 'Escape') catalogCloseRowMenu();
}

/** items: [{ id, label, danger? }]; onPick(id) runs after the menu closes. */
function catalogOpenRowMenu(anchorEl, items, onPick) {
  catalogCloseRowMenu();
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.id && it.label);
  if (!anchorEl || !list.length) return;
  const menu = document.createElement('div');
  menu.id = 'catalog-row-menu';
  menu.className = 'catalog-row-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = list.map((it) => `<div class="catalog-row-menu-item${it.danger ? ' is-danger' : ''}" role="menuitem" tabindex="0" data-catalog-menu="${escapeHtml(it.id)}">${escapeHtml(it.label)}</div>`).join('');
  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  const margin = 8;
  const left = Math.max(margin, Math.min(rect.right - box.width, window.innerWidth - box.width - margin));
  const below = rect.bottom + 4 + box.height <= window.innerHeight - margin;
  menu.style.left = `${left}px`;
  menu.style.top = `${below ? rect.bottom + 4 : Math.max(margin, rect.top - box.height - 4)}px`;
  const pick = (el) => {
    const id = el && el.dataset.catalogMenu;
    catalogCloseRowMenu();
    if (id && typeof onPick === 'function') onPick(id);
  };
  menu.addEventListener('click', (e) => pick(e.target.closest('[data-catalog-menu]')));
  menu.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e.target.closest('[data-catalog-menu]')); } });
  setTimeout(() => {
    document.addEventListener('mousedown', _catalogRowMenuOutside, true);
    document.addEventListener('keydown', _catalogRowMenuKey, true);
  }, 0);
  menu.querySelector('[data-catalog-menu]')?.focus();
}

/**
 * Confirm a disable / uninstall that affects agents using this skill (spec FR-027, UI-07).
 * Resolves true to continue. No dependents → true without asking.
 */
async function catalogConfirmDependents(action, skillName, agentNames) {
  const names = (Array.isArray(agentNames) ? agentNames : []).filter(Boolean);
  if (!names.length) return true;
  if (typeof uiModal !== 'function') return true;
  const isUninstall = action === 'uninstall';
  const bodyHtml = `<p>${escapeHtml(t(isUninstall ? 'catalog.dependents_uninstall_body' : 'catalog.dependents_disable_body', { name: skillName }))}</p>
    <ul class="ui-modal__list">${names.map((n) => `<li><strong>${escapeHtml(n)}</strong></li>`).join('')}</ul>`;
  const result = await uiModal({
    title: t(isUninstall ? 'catalog.dependents_uninstall_title' : 'catalog.dependents_disable_title', { name: skillName }),
    bodyHtml,
    closeLabel: t('common.close'),
    actions: [
      { id: 'cancel', label: t('common.cancel'), role: 'secondary' },
      { id: 'go', label: t(isUninstall ? 'catalog.uninstall' : 'catalog.disable'), role: 'primary' },
    ],
  });
  return !!result && result.value === 'go';
}

// ── Unified detail popup ─────────────────────────────────────────────────

let _catalogPopup = null;

function _catalogPopupPrimaryHtml(label, action, installing) {
  return uiButton({
    label, role: 'primary', size: 'lg', loading: !!installing, disabled: !!installing,
    attrs: { 'data-catalog-action': action },
  });
}

function _catalogPopupReplacePrimary(state, html) {
  const current = state.modal.dialog.querySelector('.ui-modal__footer > [data-catalog-action]:last-child');
  if (!current) return;
  current.insertAdjacentHTML('afterend', html);
  current.remove();
  if (typeof hydrateUiIcons === 'function') hydrateUiIcons(state.modal.dialog);
}

/** Example clicked on an item not yet installed: lock the popup while installing. */
function _catalogPopupSetInstalling(state, on) {
  const kind = state.view.kind === 'skill' ? 'skill' : 'agent';
  const action = on ? 'install' : 'retry';
  _catalogPopupReplacePrimary(state, _catalogPopupPrimaryHtml(on ? t('catalog.installing') : _catalogActionLabel(action, kind), action, on));
  for (const btn of state.modal.dialog.querySelectorAll('[data-catalog-example]')) btn.disabled = !!on;
}

function _catalogPopupShowFailure(state) {
  _catalogPopupSetInstalling(state, false);
  const text = catalogInstallFailure(state.view.kind, state.view.id) || t('catalog.install_failed_chip');
  const content = state.modal.dialog.querySelector('.catalog-popup-content');
  if (!content) return;
  let note = content.querySelector('.catalog-popup-failed');
  if (!note) {
    note = document.createElement('p');
    note.className = 'connector-popup-note catalog-popup-failed';
    content.prepend(note);
  }
  note.textContent = text;
}

function closeCatalogPopup() {
  const current = _catalogPopup;
  _catalogPopup = null;
  if (current && current.modal) current.modal.close(null, 'close');
}

function _catalogActionLabel(action, kind) {
  switch (action) {
    case 'use': return t(kind === 'skill' ? 'catalog.use_skill' : 'catalog.use_agent');
    case 'install': return t('catalog.install'); // 与卡片按钮、参考稿一致（2026-10-19 定）
    case 'retry': return t('catalog.retry');
    case 'update': return t('catalog.update');
    case 'enable': return t('catalog.enable');
    case 'disable': return t('catalog.disable');
    case 'uninstall': return t('catalog.uninstall');
    case 'remove': return t('catalog.remove');
    case 'manage': return t('catalog.manage');
    case 'contribute': return t('agents.contribute');
    default: return action;
  }
}

/**
 * Open the unified detail popup.
 * view: { kind, origin, id, name, meta, description, tags, examples, skills, does,
 *         iconHtml, installed, enabled, contributable, installing, blockedReason }
 * handlers: { use(text|null), install(), enable(), disable(), uninstall(), remove(),
 *             manage(), contribute(), sendExample(text) }
 */
function openCatalogPopup(view, handlers) {
  if (!view || typeof uiModal !== 'function') return null;
  closeCatalogPopup();
  const kind = view.kind === 'skill' ? 'skill' : 'agent';
  const actions = _catalogViewActions(view.origin, view);
  const enabled = view.enabled !== false;
  const usable = enabled && !view.blockedReason;
  const name = String(view.name || view.id || '');
  const examples = catalogExamples(view, t('catalog.generic_example', { name }));
  const examplesHint = !usable ? t('catalog.examples_hint_disabled')
    : (actions.primary === 'install' || actions.primary === 'retry') ? t('catalog.examples_hint_install')
      : t('catalog.examples_hint_ready');
  const exampleDisabled = !usable || !!view.installing;
  const tags = Array.isArray(view.tags) ? view.tags.filter(Boolean) : [];
  const skills = Array.isArray(view.skills) ? view.skills.filter((s) => s && s.name) : [];
  const does = Array.isArray(view.does) ? view.does.filter(Boolean) : [];
  const pill = (label, tone) => (typeof uiStatusPill === 'function' ? uiStatusPill({ label, tone }) : escapeHtml(label));
  const bodyHtml = `<div class="connector-popup-content catalog-popup-content">
      ${view.description ? `<p class="connector-popup-description">${escapeHtml(view.description)}</p>` : ''}
      ${tags.length ? `<div class="catalog-popup-tags">${tags.map((tag) => `<span class="agent-card-chip">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
      ${!enabled ? `<p class="connector-popup-note">${escapeHtml(t('catalog.disabled_note'))}</p>` : ''}
      ${view.blockedReason ? `<p class="connector-popup-note">${escapeHtml(view.blockedReason)}</p>` : ''}
      ${view.failed ? `<p class="connector-popup-note catalog-popup-failed">${escapeHtml(view.failed)}</p>` : ''}
      ${view.updateAvailable ? `<p class="connector-popup-note">${escapeHtml(t('catalog.update_hint'))}</p>` : ''}
      ${does.length ? `<section class="connector-popup-examples catalog-popup-does-card"><h3>${escapeHtml(t('catalog.does_title'))}</h3><ul class="catalog-popup-does">${does.map((x) => `<li><span class="catalog-popup-does-check" data-ui-icon="check"></span><span>${escapeHtml(x)}</span></li>`).join('')}</ul></section>` : ''}
      ${examples.length ? `<section class="connector-popup-examples"><h3>${escapeHtml(t(kind === 'skill' ? 'catalog.examples_title_skill' : 'catalog.examples_title_agent'))} <small class="connector-popup-note">${escapeHtml(examplesHint)}</small></h3>
        ${examples.map((text, i) => uiButton({
    label: `“${text}”`, role: 'secondary', iconEnd: 'message-square', className: 'connector-popup-example',
    disabled: exampleDisabled, attrs: { 'data-catalog-example': String(i) },
  })).join('')}</section>` : ''}
      ${kind === 'agent' && skills.length ? `<section class="connector-popup-examples"><h3>${escapeHtml(t('catalog.skills_title'))}</h3>
        <div class="catalog-popup-skills">${skills.map((s) => `<span class="catalog-popup-skill">${escapeHtml(s.name)} ${s.off ? pill(t('catalog.skill_off'), 'attention') : s.unavailable ? pill(t('catalog.skill_unavailable'), 'attention') : pill(s.ready === false ? t('catalog.skill_with_install') : t('catalog.skill_ready'), s.ready === false ? 'neutral' : 'success')}</span>`).join('')}</div></section>` : ''}
    </div>`;
  const modal = uiModal({ title: name, description: view.meta || '', closeLabel: t('common.close'), size: 'lg', bodyHtml, dismissOnBackdrop: true });
  modal.dialog.classList.add('connector-popup', 'catalog-popup');
  if (view.iconHtml) {
    const icon = document.createElement('span');
    icon.className = 'connector-popup-icon catalog-popup-icon';
    icon.innerHTML = view.iconHtml;
    modal.dialog.querySelector('.ui-modal__header')?.prepend(icon);
  }
  const primaryLabel = view.installing ? t('catalog.installing') : _catalogActionLabel(actions.primary, kind);
  const primary = uiButton({
    label: primaryLabel,
    role: 'primary',
    size: 'lg',
    icon: actions.primary === 'use' ? 'send' : undefined,
    loading: !!view.installing,
    disabled: !!view.installing || (actions.primary === 'use' && !usable),
    attrs: { 'data-catalog-action': actions.primary },
  });
  const secondary = actions.secondary.map((a) => uiButton({
    label: a === 'enable_dep' ? t('catalog.enable_dep', { name: view.enableDep.name }) : _catalogActionLabel(a, kind),
    role: a === 'enable_dep' ? 'primary' : 'secondary',
    attrs: { 'data-catalog-action': a },
  })).join('');
  const footer = document.createElement('footer');
  footer.className = 'ui-modal__footer';
  footer.innerHTML = `${secondary ? `<div class="connector-popup-more catalog-popup-secondary">${secondary}</div>` : ''}${primary}`;
  modal.dialog.appendChild(footer);
  if (typeof hydrateUiIcons === 'function') hydrateUiIcons(modal.dialog);
  const state = { modal, view };
  _catalogPopup = state;
  const run = (fn, ...args) => { if (typeof fn === 'function') return fn(...args); return undefined; };
  modal.dialog.addEventListener('click', (e) => {
    const exampleBtn = e.target.closest('[data-catalog-example]');
    if (exampleBtn && !exampleBtn.disabled) {
      const text = examples[Number(exampleBtn.dataset.catalogExample)] || '';
      if (view.installed) {
        closeCatalogPopup();
        run(handlers && handlers.sendExample, text);
        return;
      }
      // 未安装：弹窗留着显示「安装中…」；装好由处理函数关弹窗并带示例进入任务，
      // 装失败就地显示原因和「重试」（spec FR-008）。
      _catalogPopupSetInstalling(state, true);
      void Promise.resolve(run(handlers && handlers.sendExample, text)).catch(() => false).then((ok) => {
        if (_catalogPopup !== state) return;
        if (ok === false) _catalogPopupShowFailure(state);
        else closeCatalogPopup();
      });
      return;
    }
    const actionBtn = e.target.closest('[data-catalog-action]');
    if (!actionBtn || actionBtn.disabled) return;
    const action = actionBtn.dataset.catalogAction;
    closeCatalogPopup();
    run(handlers && handlers[action === 'retry' ? 'install' : action]);
  });
  modal.then(() => { if (_catalogPopup === state) _catalogPopup = null; });
  return modal;
}

window.catalogSplitPlatform = catalogSplitPlatform;
window.catalogPopupActions = catalogPopupActions;
window.catalogExamples = catalogExamples;
window.catalogLoad = catalogLoad;
window.catalogRows = catalogRows;
window.catalogStatus = catalogStatus;
window.catalogOnChange = catalogOnChange;
window.catalogInstall = catalogInstall;
window.catalogJustInstalledIds = catalogJustInstalledIds;
window.catalogTakeJustInstalledFlash = catalogTakeJustInstalledFlash;
window.catalogResetJustInstalled = catalogResetJustInstalled;
window.catalogUninstall = catalogUninstall;
window.catalogIsInstalling = catalogIsInstalling;
window.catalogInstallFailure = catalogInstallFailure;
window.catalogEnsureSignedIn = catalogEnsureSignedIn;
window.catalogHomeBannerHtml = catalogHomeBannerHtml;
window.catalogPlatformTail = catalogPlatformTail;
window.catalogWireBanner = catalogWireBanner;
window.catalogUpdateRow = catalogUpdateRow;
window.catalogInstalledSort = catalogInstalledSort;
window.catalogInstalledFilter = catalogInstalledFilter;
window.catalogInstalledSummary = catalogInstalledSummary;
window.catalogInstalledFilterHtml = catalogInstalledFilterHtml;
window.catalogInstalledCrumbHtml = catalogInstalledCrumbHtml;
window.catalogInstalledSummaryHtml = catalogInstalledSummaryHtml;
window.catalogInstalledGridHtml = catalogInstalledGridHtml;
window.catalogOpenRowMenu = catalogOpenRowMenu;
window.catalogCloseRowMenu = catalogCloseRowMenu;
window.catalogConfirmDependents = catalogConfirmDependents;
window.openCatalogPopup = openCatalogPopup;
window.closeCatalogPopup = closeCatalogPopup;
