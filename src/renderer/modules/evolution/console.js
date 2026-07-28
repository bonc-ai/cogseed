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
  let skillQuery = '';

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
        let html = P.renderSkillSelector(skills || [], activeSkillId, skillQuery);
        if (activeSkillId) {
          const { versions } = await window.apiFetch(`/api/evolution/skills/${encodeURIComponent(activeSkillId)}/versions`).then(r => r.json());
          const latestVer = (versions && versions[0] && versions[0].version) || '0.1.0';
          html += '<div class="evo-skill-versions"><div class="evo-section-title">所选技能 · 版本历史</div>'
            + `<button class="btn btn-sm" id="evo-skill-export-btn" data-version="${latestVer}">导出为 .zip</button>`
            + P.renderSkillVersions(versions || []) + '</div>';
        }
        body.innerHTML = html;
        _bindSkillSelect(body);
        _bindSkillExport(body);
        _bindSkillSearch(body);
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
        const std = await window.apiFetch(`/api/evolution/evals/${encodeURIComponent(activeSkillId)}/standard`).then(r => r.json());
        const rec = await window.apiFetch(`/api/evolution/evals/${encodeURIComponent(activeSkillId)}`).then(r => r.json());
        body.innerHTML = P.renderEvalStandard(std) + P.renderEvalRecord(rec);
        _bindEvalStandard(body, std);
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
      item.addEventListener('click', () => {
        activeSkillId = item.dataset.skillId;
        renderNav();
        loadPage('skills'); // 重渲染:显示所选技能的版本历史/导出 + 高亮
      });
    });
  }

  function _bindSkillSearch(body) {
    const input = body.querySelector('#evo-skill-search');
    if (!input) return;
    input.addEventListener('input', () => {
      skillQuery = input.value || '';
      const list = body.querySelector('.evo-skill-list') || body.querySelector('.evo-empty');
      // 仅重渲染列表部分,避免输入框失焦。简单起见整页重载并把焦点还原。
      const caret = input.selectionStart;
      loadPage('skills').then(() => {
        const again = document.getElementById('evo-skill-search');
        if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch (e) {} }
      });
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

  function _bindEvalStandard(body, std) {
    // 从已存视图重建可编辑缓冲(展平回原始 assertions/cases)。
    const buf = {
      assertions: [
        ...(std.assertions.qualitative || []),
        ...(std.assertions.invariant || []),
        ...(std.assertions.boundary || []),
      ],
      cases: [
        ...(std.cases.positive || []).map(c => ({ ...c, negative: false })),
        ...(std.cases.negative || []).map(c => ({ ...c, negative: true })),
      ],
    };
    const addAssert = body.querySelector('#evo-std-add-assert');
    if (addAssert) addAssert.addEventListener('click', () => {
      const text = (body.querySelector('#evo-std-assert-text') || {}).value || '';
      const type = (body.querySelector('#evo-std-assert-type') || {}).value || 'qualitative';
      if (!text.trim()) return;
      buf.assertions.push({ type, text: text.trim() });
      const input = body.querySelector('#evo-std-assert-text'); if (input) input.value = '';
    });
    const addCase = body.querySelector('#evo-std-add-case');
    if (addCase) addCase.addEventListener('click', () => {
      const input = (body.querySelector('#evo-std-case-input') || {}).value || '';
      const neg = (body.querySelector('#evo-std-case-neg') || {}).value === '1';
      if (!input.trim()) return;
      buf.cases.push({ input: input.trim(), negative: neg });
      const el = body.querySelector('#evo-std-case-input'); if (el) el.value = '';
    });
    const saveBtn = body.querySelector('#evo-std-save');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      if (!activeSkillId) return;
      await window.apiFetch(`/api/evolution/evals/${encodeURIComponent(activeSkillId)}/standard`, {
        method: 'POST', body: JSON.stringify({ assertions: buf.assertions, cases: buf.cases }),
      });
      loadPage('evals');
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
