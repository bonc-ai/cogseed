// ─── 知识库生态外壳（顶部横向工具栏 + 子视图容器）— classic script ───
// 计划书 v1.3 §四.1：总入口 = 侧边栏「自动化」后「知识库」按钮 → 进入知识库生态。
// v2（按产品评审建议）：移除 52px 图标竖栏 → 6 个入口迁移为**第二栏顶部的横向
// 工具栏**（图标+文字，可切紧凑「仅图标」，localStorage 记忆），释放横向空间。
(function () {
  // 知识库/笔记已落地；发现模块当前为「待开发」占位（不展示内置示例市场数据，避免误导）。
  // label 是中文回退文案，labelKey 才是权威（键在 locales/*.json；缺键时退回 label）。
  const ECO_NAV = [
    { key: 'kb', icon: 'folder', labelKey: 'kb.eco.nav_kb', label: '知识库', status: 'ok' },
    { key: 'notes', icon: 'file-text', labelKey: 'kb.eco.nav_notes', label: '笔记', status: 'ok' },
    { key: 'discover', icon: 'globe', labelKey: 'kb.eco.nav_discover', label: '发现', status: 'soon' },
  ];
  const COMPACT_KEY = 'cogseed.kb.eco.compact';
  let _compact = false;
  try { _compact = localStorage.getItem(COMPACT_KEY) === '1'; } catch (_) { /* ignore */ }

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

  function _compactButton() {
    const label = _compact
      ? _tr('kb.eco.show_labels', '显示图标和文字')
      : _tr('kb.eco.hide_labels', '仅显示图标');
    return window.uiIconButton({
      label,
      icon: 'panel-list',
      className: 'kb-eco-compact',
      attrs: { id: 'kb-eco-compact', 'aria-pressed': String(_compact) },
    });
  }

  function _navBtn(item, active) {
    const label = _navLabel(item);
    const badge = item.status === 'soon'
      ? window.uiBadge({ label: _tr('kb.eco.coming_soon', '待开发'), className: 'kb-eco-tab-soon' })
      : '';
    return `<button type="button" class="kb-eco-tab is-${item.status}${active ? ' active' : ''}" data-kb-eco="${item.key}"
      title="${label}" aria-label="${label}">
      <span class="kb-sdot"></span>${_kbIcon(item.icon)}<span class="kb-eco-tab-label">${_mainLabel(label)}</span>${badge}</button>`;
  }

  function _applyCompact() {
    document.querySelectorAll('.kb-eco').forEach((el) => el.classList.toggle('kb-eco--compact', _compact));
    const btn = document.getElementById('kb-eco-compact');
    if (btn) {
      const label = _compact
        ? _tr('kb.eco.show_labels', '显示图标和文字')
        : _tr('kb.eco.hide_labels', '仅显示图标');
      btn.title = label;
      btn.setAttribute('aria-label', label);
      btn.setAttribute('aria-pressed', String(_compact));
    }
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
      btn.title = label;
      btn.setAttribute('aria-label', label);
      const text = btn.querySelector('.kb-eco-tab-label');
      if (text) text.textContent = _mainLabel(label);
      // 徽标是 uiBadge 渲染的纯文本 span（见 ui-status.js），可直接改文本
      const badge = btn.querySelector('.kb-eco-tab-soon');
      if (badge) badge.textContent = _tr('kb.eco.coming_soon', '待开发');
    });
    _applyCompact();
  }
  window.addEventListener('i18n-change', _relabelEco);

  function renderKbEco() {
    const host = document.getElementById('kb-view');
    if (!host || host.querySelector('.kb-eco')) return;
    const nav = ECO_NAV.map((b, i) => _navBtn(b, i === 0)).join('');
    host.innerHTML = `<div class="kb-eco">
      <div class="kb-eco-topnav">
        <div class="kb-eco-tabs">${nav}</div>
        ${_compactButton()}
      </div>
      <div class="kb-eco-body">
        <div class="kb-workbench" id="kb-workbench"></div>
        <div class="kb-eco-pane" id="kb-notes" hidden></div>
        <div class="kb-eco-pane" id="kb-discover" hidden></div>
      </div>
    </div>`;
    host.querySelectorAll('[data-kb-eco]').forEach((btn) => {
      btn.addEventListener('click', () => _activateEco(btn.dataset.kbEco));
    });
    document.getElementById('kb-eco-compact')?.addEventListener('click', () => {
      _compact = !_compact;
      try { localStorage.setItem(COMPACT_KEY, _compact ? '1' : '0'); } catch (_) { /* ignore */ }
      _applyCompact();
    });
    _applyCompact();
  }

  function _activateEco(key) {
    document.querySelectorAll('[data-kb-eco]').forEach((b) => {
      b.classList.toggle('active', b.dataset.kbEco === key);
    });
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
