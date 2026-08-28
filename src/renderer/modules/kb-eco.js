// ─── 知识库生态外壳（rail + 子视图容器）— classic script (window.renderKbEco) ───
// 计划书 v1.3 §四.1：总入口 = 侧边栏「自动化」后「知识库」按钮 → 进入知识库生态，
// 生态内 52px rail（知识库/笔记/发现/浏览/Agent/菜单）细分各子视图。
// S1：知识库=已落地（绿点）；笔记/发现=S4（灰点）；浏览/Agent/菜单=预留（灰点）。
(function () {
  const ECO_NAV = [
    { key: 'kb', icon: 'book-open', label: '知识库', status: 'ok' },
    { key: 'notes', icon: 'file-text', label: '笔记', status: 'ok' },
    { key: 'discover', icon: 'sparkles', label: '发现', status: 'ok' },
    { key: 'browse', icon: 'globe', label: '浏览 · 预留', status: 'soon' },
  ];
  const ECO_TAIL = [
    { key: 'agent', icon: 'brain-circuit', label: 'Agent 工作台 · 预留', status: 'soon' },
    { key: 'menu', icon: 'settings', label: '菜单 · 预留', status: 'soon' },
  ];

  function _kbIcon(name) {
    if (typeof window.uiIconHtml === 'function') {
      return window.uiIconHtml(name, 'kb-rail-icon');
    }
    return '<span class="kb-rail-icon">◈</span>';
  }

  function _navBtn(item, active) {
    return `<button type="button" class="kb-rail-btn${active ? ' active' : ''}" data-kb-eco="${item.key}"
      title="${item.label}" aria-label="${item.label}">
      <span class="kb-sdot is-${item.status}"></span>${_kbIcon(item.icon)}</button>`;
  }

  function renderKbEco() {
    const host = document.getElementById('kb-view');
    if (!host || host.querySelector('.kb-eco')) return;
    const nav = ECO_NAV.map((b, i) => _navBtn(b, i === 0)).join('');
    const tail = ECO_TAIL.map((b) => _navBtn(b, false)).join('');
    host.innerHTML = `<div class="kb-eco">
      <nav class="kb-rail">${nav}<div class="kb-rail-spacer"></div>${tail}</nav>
      <div class="kb-eco-body">
        <div class="kb-workbench" id="kb-workbench"></div>
        <div class="kb-eco-pane" id="kb-notes" hidden></div>
        <div class="kb-eco-pane" id="kb-discover" hidden></div>
      </div>
    </div>`;
    host.querySelectorAll('[data-kb-eco]').forEach((btn) => {
      btn.addEventListener('click', () => _activateEco(btn.dataset.kbEco));
    });
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
    const item = [...ECO_NAV, ...ECO_TAIL].find((b) => b.key === key);
    if (typeof uiToast === 'function') {
      uiToast(`「${item ? item.label : key}」模块预留`, { variant: 'info' });
    }
  }

  window.renderKbEco = renderKbEco;
})();
