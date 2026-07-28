// 进化控制台外壳：六页子导航 + 数据拉取 + 挂载。classic script。
(function () {
  const PAGES = [
    { id: 'dashboard', label: '总览' },
    { id: 'skills', label: '技能' },
    { id: 'evolution', label: '进化' },
    { id: 'ontology', label: '本体' },
    { id: 'evals', label: '评估' },
    { id: 'patches', label: '补丁' },
  ];
  let activePage = 'dashboard';
  let activeSkillId = null;

  function el(id) { return document.getElementById(id); }

  function renderNav() {
    const nav = el('evo-console-nav');
    if (!nav) return;
    nav.innerHTML = PAGES.map(p =>
      `<button class="evo-nav-btn${p.id === activePage ? ' active' : ''}" data-evo-page="${p.id}">${p.label}</button>`
    ).join('');
    nav.querySelectorAll('[data-evo-page]').forEach(btn => {
      btn.addEventListener('click', () => switchPage(btn.dataset.evoPage));
    });
  }

  async function loadPage(page) {
    const body = el('evo-console-body');
    if (!body) return;
    body.innerHTML = '<div class="evo-loading">加载中…</div>';
    try {
      const P = window.EvolutionPages;
      if (page === 'dashboard') {
        const d = await window.apiFetch('/api/evolution/dashboard', { method: 'POST', body: '{}' }).then(r => r.json());
        body.innerHTML = P.renderDashboard(d);
      } else if (page === 'skills') {
        const { skills } = await window.apiFetch('/api/skills/list').then(r => r.json());
        body.innerHTML = P.renderSkillsList(skills || []);
        _bindSkillSelect(body);
      } else if (page === 'evolution') {
        const { runs } = await window.apiFetch('/api/evolution/evolve').then(r => r.json());
        const latest = runs && runs[0];
        body.innerHTML = P.renderKstarTimeline(latest || null) + _evolveControls();
        _bindEvolveControls(body);
      } else if (page === 'ontology') {
        if (!activeSkillId) { body.innerHTML = '<div class="evo-empty">先在「技能」页选择一个技能</div>'; return; }
        const { ontologies } = await window.apiFetch(`/api/evolution/ontology/${encodeURIComponent(activeSkillId)}`).then(r => r.json());
        body.innerHTML = P.renderOntologyList(ontologies || []);
      } else if (page === 'evals') {
        if (!activeSkillId) { body.innerHTML = '<div class="evo-empty">先在「技能」页选择一个技能</div>'; return; }
        const rec = await window.apiFetch(`/api/evolution/evals/${encodeURIComponent(activeSkillId)}`).then(r => r.json());
        body.innerHTML = P.renderEvalRecord(rec);
      } else if (page === 'patches') {
        const { runs } = await window.apiFetch('/api/evolution/evolve').then(r => r.json());
        const patches = (runs || []).flatMap(_extractPatches);
        body.innerHTML = P.renderPatchList(patches);
      }
    } catch (e) {
      body.innerHTML = `<div class="evo-error">加载失败：${(e && e.message) || e}</div>`;
    }
  }

  function _extractPatches(run) {
    const govern = (run.steps || []).find(s => s.name === 'Govern');
    if (!govern || !govern.output) return [];
    const o = govern.output;
    return [{ id: run.runId, status: run.status, risk_level: (o.proposal && o.proposal.risk_level) || 0, description: (o.proposal && o.proposal.description) || run.skillId }];
  }

  function _evolveControls() {
    return '<div class="evo-evolve-controls"><button class="btn btn-sm" id="evo-step-btn">推进一步</button><button class="btn btn-sm" id="evo-abort-btn">中止</button></div>';
  }
  function _bindEvolveControls(body) {
    const step = body.querySelector('#evo-step-btn');
    if (step) step.addEventListener('click', async () => {
      const { runs } = await window.apiFetch('/api/evolution/evolve').then(r => r.json());
      const latest = runs && runs[0];
      if (!latest) return;
      await window.apiFetch('/api/evolution/evolve/step', { method: 'POST', body: JSON.stringify({ runId: latest.runId }) });
      loadPage('evolution');
    });
    const abort = body.querySelector('#evo-abort-btn');
    if (abort) abort.addEventListener('click', async () => {
      const { runs } = await window.apiFetch('/api/evolution/evolve').then(r => r.json());
      const latest = runs && runs[0];
      if (!latest) return;
      await window.apiFetch('/api/evolution/evolve/abort', { method: 'POST', body: JSON.stringify({ runId: latest.runId }) });
      loadPage('evolution');
    });
  }
  function _bindSkillSelect(body) {
    body.querySelectorAll('[data-skill-id]').forEach(item => {
      item.addEventListener('click', () => { activeSkillId = item.dataset.skillId; renderNav(); });
    });
  }

  function switchPage(page) { activePage = page; renderNav(); loadPage(page); }

  // 由 boot.js 在进入 evolution 视图时调用。
  window.renderEvolutionConsole = function renderEvolutionConsole() {
    renderNav();
    loadPage(activePage);
  };
})();
