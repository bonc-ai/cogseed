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
        let html = P.renderCreateForm() + P.renderSkillsList(skills || []);
        if (activeSkillId) {
          const { versions } = await window.apiFetch(`/api/evolution/skills/${encodeURIComponent(activeSkillId)}/versions`).then(r => r.json());
          const latestVer = (versions && versions[0] && versions[0].version) || '0.1.0';
          html += '<div class="evo-skill-versions"><div class="evo-section-title">版本历史</div>'
            + `<button class="btn btn-sm" id="evo-skill-export-btn" data-version="${latestVer}">导出为 .zip</button>`
            + P.renderSkillVersions(versions || []) + '</div>';
        }
        body.innerHTML = html;
        _bindSkillSelect(body);
        _bindSkillExport(body);
        _bindCreateWizard(body);
      } else if (page === 'evolution') {
        const { runs } = await window.apiFetch('/api/evolution/evolve').then(r => r.json());
        const latest = runs && runs[0];
        let html = P.renderKstarTimeline(latest || null) + _evolveControls();
        if (activeSkillId) {
          const reco = await window.apiFetch(`/api/evolution/skills/${encodeURIComponent(activeSkillId)}/recommend`).then(r => r.json());
          html += '<div class="evo-reco-section"><div class="evo-section-title">进化建议</div>' + P.renderRecommendations((reco && reco.suggestions) || []) + '</div>';
        }
        body.innerHTML = html;
        _bindEvolveControls(body);
      } else if (page === 'ontology') {
        if (!activeSkillId) { body.innerHTML = '<div class="evo-empty">先在「技能」页选择一个技能</div>'; return; }
        const { refs } = await window.apiFetch(`/api/evolution/ontology/${encodeURIComponent(activeSkillId)}/bindings`).then(r => r.json());
        body.innerHTML = P.renderOntologyBindings(refs || []);
        _bindOntologyControls(body);
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

  function _bindCreateWizard(body) {
    const intentBtn = body.querySelector('#evo-create-intent-btn');
    const draftBtn = body.querySelector('#evo-create-draft-btn');
    const read = () => ({
      name: (body.querySelector('#evo-create-name') || {}).value || '',
      purpose: (body.querySelector('#evo-create-purpose') || {}).value || '',
      triggers: (body.querySelector('#evo-create-triggers') || {}).value || '',
    });
    if (intentBtn) intentBtn.addEventListener('click', async () => {
      const { name, purpose, triggers } = read();
      if (!name.trim() || !purpose.trim()) return;
      const res = await window.apiFetch('/api/evolution/skills/capture-intent', {
        method: 'POST',
        body: JSON.stringify({ name, purpose, trigger_contexts: triggers.split(',').map(s => s.trim()).filter(Boolean) }),
      }).then(r => r.json());
      const box = body.querySelector('#evo-create-questions');
      if (box && res && res.ok) box.innerHTML = window.EvolutionPages.renderInterviewQuestions(res.questions || []);
    });
    if (draftBtn) draftBtn.addEventListener('click', async () => {
      const { name, purpose } = read();
      if (!name.trim()) return;
      const res = await window.apiFetch('/api/evolution/skills/create-draft', {
        method: 'POST', body: JSON.stringify({ name, description: purpose, category: '' }),
      }).then(r => r.json());
      if (res && res.ok) loadPage('skills');
    });
  }

  function _bindSkillExport(body) {
    const btn = body.querySelector('#evo-skill-export-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!activeSkillId) return;
      const version = btn.dataset.version || '0.1.0';
      const res = await window.apiFetch(`/api/evolution/skills/${encodeURIComponent(activeSkillId)}/export`, { method: 'POST', body: JSON.stringify({ version }) }).then(r => r.json());
      if (res && res.ok && res.zipPath) {
        btn.textContent = '已导出: ' + res.zipPath.split('/').pop();
      } else {
        btn.textContent = '导出失败';
      }
    });
  }

  function _bindOntologyControls(body) {
    const bindBtn = body.querySelector('#evo-onto-bind-btn');
    if (bindBtn) bindBtn.addEventListener('click', async () => {
      const input = body.querySelector('#evo-onto-bind-input');
      const ontologyId = (input && input.value || '').trim();
      if (!ontologyId || !activeSkillId) return;
      await window.apiFetch(`/api/evolution/ontology/${encodeURIComponent(activeSkillId)}/bind`, { method: 'POST', body: JSON.stringify({ ontologyId }) });
      loadPage('ontology');
    });
    body.querySelectorAll('.evo-onto-unbind').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ontologyId = btn.dataset.ontoId;
        if (!ontologyId || !activeSkillId) return;
        await window.apiFetch(`/api/evolution/ontology/${encodeURIComponent(activeSkillId)}/unbind`, { method: 'POST', body: JSON.stringify({ ontologyId }) });
        loadPage('ontology');
      });
    });
  }

  function switchPage(page) { activePage = page; renderNav(); loadPage(page); }

  // 由 boot.js 在进入 evolution 视图时调用。
  window.renderEvolutionConsole = function renderEvolutionConsole() {
    renderNav();
    loadPage(activePage);
  };
})();
