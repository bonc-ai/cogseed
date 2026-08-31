// ─── 知识库生态外壳（顶部横向工具栏 + 子视图容器）— classic script ───
// 计划书 v1.3 §四.1：总入口 = 侧边栏「自动化」后「知识库」按钮 → 进入知识库生态。
// v2（按产品评审建议）：移除 52px 图标竖栏 → 6 个入口迁移为**第二栏顶部的横向
// 工具栏**（图标+文字，可切紧凑「仅图标」，localStorage 记忆），释放横向空间。
(function () {
  // 只保留已落地入口（知识库/笔记/发现）；浏览/Agent/菜单为预留项，不展示避免误导。
  const ECO_NAV = [
    { key: 'kb', icon: 'folder', label: '知识库', status: 'ok' },
    { key: 'notes', icon: 'file-text', label: '笔记', status: 'ok' },
    { key: 'discover', icon: 'globe', label: '发现', status: 'ok' },
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

  function _navBtn(item, active) {
    return `<button type="button" class="kb-eco-tab is-${item.status}${active ? ' active' : ''}" data-kb-eco="${item.key}"
      title="${item.label}" aria-label="${item.label}">
      <span class="kb-sdot"></span>${_kbIcon(item.icon)}<span class="kb-eco-tab-label">${_mainLabel(item.label)}</span></button>`;
  }

  function _applyCompact() {
    document.querySelectorAll('.kb-eco').forEach((el) => el.classList.toggle('kb-eco--compact', _compact));
    const btn = document.getElementById('kb-eco-compact');
    if (btn) btn.title = _compact ? '切换为「图标 + 文字」' : '切换为「仅图标」';
  }

  function renderKbEco() {
    const host = document.getElementById('kb-view');
    if (!host || host.querySelector('.kb-eco')) return;
    const nav = ECO_NAV.map((b, i) => _navBtn(b, i === 0)).join('');
    host.innerHTML = `<div class="kb-eco">
      <div class="kb-eco-topnav">
        <div class="kb-eco-tabs">${nav}</div>
        <button type="button" class="kb-eco-compact" id="kb-eco-compact" title="切换为「仅图标」">≡</button>
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
      uiToast(`「${item ? _mainLabel(item.label) : key}」模块预留`, { variant: 'info' });
    }
  }

  window.renderKbEco = renderKbEco;
})();
