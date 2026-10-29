// ─── 知识库生态外壳（侧栏分类导航 + 子视图容器）— classic script ───
// 计划书 v1.3 §四.1：总入口 = rail「知识库」→ 进入知识库生态。
// v3（specs/008-shell-rail-layout）：原第二栏顶部横向工具栏迁入外壳侧栏
// （#sidebar-kb-nav），主区只留子视图；侧栏宽度/折叠由外壳统一管理，
// 原「仅图标」紧凑开关随之退役。
(function () {
  // 知识库/笔记已落地；发现模块当前为「待开发」占位（不展示内置示例市场数据，避免误导）。
  // label 是中文回退文案，labelKey 才是权威（键在 locales/*.json；缺键时退回 label）。
  const ECO_NAV = [
    { key: 'kb', icon: 'folder', labelKey: 'kb.eco.nav_kb', label: '知识库', status: 'ok' },
    { key: 'notes', icon: 'file-text', labelKey: 'kb.eco.nav_notes', label: '笔记', status: 'ok' },
    { key: 'discover', icon: 'globe', labelKey: 'kb.eco.nav_discover', label: '发现', status: 'soon' },
  ];

  function _kbIcon(name) {
    if (typeof window.uiIconHtml === 'function') {
      return window.uiIconHtml(name, 'kb-eco-icon');
    }
    return '<span class="kb-eco-icon">◈</span>';
  }

  function _mainLabel(label) {
    return String(label).split(' · ')[0];
  }

  function _format(text, vars) {
    return String(text == null ? '' : text).replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, name) => String(vars?.[name] ?? ''));
  }

  function _tr(key, fallback, vars) {
    const value = typeof window.t === 'function' ? window.t(key) : '';
    const text = value && value !== key ? value : fallback;
    return vars ? _format(text, vars) : text;
  }

  /** 每个导航项的当前语言文案（渲染与重标签共用同一处取值，避免两侧漂移）。 */
  function _navLabel(item) {
    return _tr(item.labelKey, item.label);
  }

  function _navBtn(item, active) {
    const label = _navLabel(item);
    const badge = item.status === 'soon'
      ? window.uiBadge({ label: _tr('kb.eco.coming_soon', '待开发'), className: 'kb-eco-tab-soon' })
      : '';
    return `<button type="button" class="kb-eco-tab is-${item.status}${active ? ' active' : ''}" data-kb-eco="${item.key}"
      aria-label="${label}">
      <span class="kb-sdot"></span>${_kbIcon(item.icon)}<span class="kb-eco-tab-label">${_mainLabel(label)}</span>${badge}</button>`;
  }

  /**
   * 语言切换：**只改文本节点与属性，绝不重建 innerHTML**。
   * 因为这个外壳里住着 kb-workbench 列表与 kb-notes 编辑器（contenteditable，草稿只在 DOM 里），
   * 一旦重渲染整个 `.kb-eco`，用户没保存的笔记就没了。
   */
  function _relabelEco() {
    document.querySelectorAll('[data-kb-eco]').forEach((btn) => {
      const item = ECO_NAV.find((b) => b.key === btn.dataset.kbEco);
      if (!item) return;
      const label = _navLabel(item);
      btn.setAttribute('aria-label', label);
      const text = btn.querySelector('.kb-eco-tab-label');
      if (text) text.textContent = _mainLabel(label);
      // 徽标是 uiBadge 渲染的纯文本 span（见 ui-status.js），可直接改文本
      const badge = btn.querySelector('.kb-eco-tab-soon');
      if (badge) badge.textContent = _tr('kb.eco.coming_soon', '待开发');
    });
    const nav = document.getElementById('kb-eco-nav');
    if (nav) nav.setAttribute('aria-label', _tr('sidebar.kb', '知识库'));
    // The header holds no editor state, so re-rendering it is safe.
    _syncPageHeader();
  }
  window.addEventListener('i18n-change', _relabelEco);

  // Shared page header (specs/008 D12): the title follows the active section.
  let _activeKey = ECO_NAV[0].key;
  function _pageHeader(key) {
    const item = ECO_NAV.find((b) => b.key === key) || ECO_NAV[0];
    return typeof window.uiPageHeader === 'function'
      ? window.uiPageHeader({ title: _mainLabel(_navLabel(item)) })
      : '';
  }
  function _syncPageHeader() {
    const header = document.getElementById('kb-page-header');
    if (header) header.innerHTML = _pageHeader(_activeKey);
  }

  function renderKbEco() {
    const host = document.getElementById('kb-view');
    if (!host || host.querySelector('.kb-eco')) return;
    const navHost = document.getElementById('sidebar-kb-nav');
    const nav = ECO_NAV.map((b, i) => _navBtn(b, i === 0)).join('');
    if (navHost) {
      navHost.innerHTML = `<nav class="kb-eco-tabs sidebar-nav" id="kb-eco-nav" aria-label="${_tr('sidebar.kb', '知识库')}">${nav}</nav>`;
    }
    host.innerHTML = `<div class="kb-eco">
      <div class="kb-eco-page-header" id="kb-page-header">${_pageHeader(_activeKey)}</div>
      <div class="kb-eco-body">
        <div class="kb-workbench" id="kb-workbench"></div>
        <div class="kb-eco-pane" id="kb-notes" hidden></div>
        <div class="kb-eco-pane" id="kb-discover" hidden></div>
      </div>
    </div>`;
    (navHost || host).querySelectorAll('[data-kb-eco]').forEach((btn) => {
      btn.addEventListener('click', () => _activateEco(btn.dataset.kbEco));
    });
  }

  function _activateEco(key) {
    document.querySelectorAll('[data-kb-eco]').forEach((b) => {
      b.classList.toggle('active', b.dataset.kbEco === key);
    });
    if (ECO_NAV.some((item) => item.key === key)) {
      _activeKey = key;
      _syncPageHeader();
    }
    const wb = document.getElementById('kb-workbench');
    const notes = document.getElementById('kb-notes');
    const disc = document.getElementById('kb-discover');
    if (key === 'kb') {
      if (wb) wb.hidden = false;
      if (notes) notes.hidden = true;
      if (disc) disc.hidden = true;
      if (typeof renderKbWorkbench === 'function') renderKbWorkbench();
      return;
    }
    if (key === 'notes') {
      if (wb) wb.hidden = true;
      if (disc) disc.hidden = true;
      if (notes) {
        notes.hidden = false;
        if (typeof renderKbNotes === 'function') renderKbNotes();
      }
      return;
    }
    if (key === 'discover') {
      if (wb) wb.hidden = true;
      if (notes) notes.hidden = true;
      if (disc) {
        disc.hidden = false;
        if (typeof renderKbDiscover === 'function') renderKbDiscover();
      }
      return;
    }
    const item = ECO_NAV.find((b) => b.key === key);
    if (typeof uiToast === 'function') {
      uiToast(_tr('kb.eco.module_reserved', '「{name}」模块预留', { name: item ? _mainLabel(_navLabel(item)) : key }), { variant: 'info' });
    }
  }

  window.renderKbEco = renderKbEco;
})();
