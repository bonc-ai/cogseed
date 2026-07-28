// 六页纯渲染：数据 → HTML 字符串。无 DOM 副作用，可单测。
(function (root) {
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function degradedBanner(degraded) {
    return degraded ? '<div class="evo-degraded-banner">本视图为规则降级结果（未接入模型）</div>' : '';
  }

  function statCard(label, value) {
    return `<div class="evo-stat-card"><div class="evo-stat-value">${escapeHtml(value)}</div><div class="evo-stat-label">${escapeHtml(label)}</div></div>`;
  }

  function renderDashboard(d) {
    return degradedBanner(d.degraded) + '<div class="evo-stat-row">' + [
      statCard('技能数', d.skillCount),
      statCard('已启用技能', d.enabledSkillCount),
      statCard('待审补丁', d.pendingReviewCount),
      statCard('进化运行', d.evolutionRunCount),
      statCard('进行中', d.runningEvolutionCount),
    ].join('') + '</div>';
  }

  function renderSkillsList(skills) {
    if (!skills || !skills.length) return '<div class="evo-empty">暂无技能</div>';
    return '<ul class="evo-skill-list">' + skills.map(s =>
      `<li class="evo-skill-item" data-skill-id="${escapeHtml(s.id)}"><span class="evo-skill-name">${escapeHtml(s.name)}</span><span class="evo-skill-cat">${escapeHtml(s.category || '未分类')}</span></li>`
    ).join('') + '</ul>';
  }

  function renderKstarTimeline(run) {
    if (!run || !run.steps) return '<div class="evo-empty">尚未开始进化运行</div>';
    return '<ol class="kstar-timeline">' + run.steps.map(st => {
      const deg = st.degraded ? '<span class="kstar-step-degraded">规则降级</span>' : '';
      return `<li class="kstar-step kstar-step-${escapeHtml(st.status)}"><span class="kstar-step-no">${st.step}</span><span class="kstar-step-name">${escapeHtml(st.name)}</span><span class="kstar-step-status">${escapeHtml(st.status)}</span>${deg}</li>`;
    }).join('') + '</ol>';
  }

  function renderOntologyList(ontologies) {
    if (!ontologies || !ontologies.length) return '<div class="evo-empty">暂无绑定本体</div>';
    return '<ul class="evo-onto-list">' + ontologies.map(o =>
      `<li class="evo-onto-item">${escapeHtml(o.title || o.id || '')}</li>`
    ).join('') + '</ul>';
  }

  function renderCreateForm() {
    return '<div class="evo-create-form">'
      + '<div class="evo-section-title">创建技能</div>'
      + '<input type="text" id="evo-create-name" placeholder="技能名称" />'
      + '<input type="text" id="evo-create-purpose" placeholder="用途（做什么）" />'
      + '<input type="text" id="evo-create-triggers" placeholder="触发场景（逗号分隔）" />'
      + '<button class="btn btn-sm" id="evo-create-intent-btn">捕获意图</button>'
      + '<button class="btn btn-sm" id="evo-create-draft-btn">创建草稿</button>'
      + '<div class="evo-create-questions" id="evo-create-questions"></div>'
      + '</div>';
  }

  function renderInterviewQuestions(questions) {
    if (!questions || !questions.length) return '';
    return '<div class="evo-section-title">访谈问题</div><ul class="evo-question-list">'
      + questions.map(q => `<li>${escapeHtml(q)}</li>`).join('') + '</ul>';
  }

  function renderSkillVersions(versions) {
    if (!versions || !versions.length) return '<div class="evo-empty">暂无版本记录</div>';
    return '<ul class="evo-version-list">' + versions.map(v =>
      `<li class="evo-version-item"><span class="evo-version-tag">v${escapeHtml(v.version)}</span><span class="evo-version-at">${escapeHtml(v.at || '')}</span>${v.note ? `<span class="evo-version-note">${escapeHtml(v.note)}</span>` : ''}</li>`
    ).join('') + '</ul>';
  }

  // 本体页:展示已绑定 id + 一个绑定输入。refs 为已绑定本体 id 列表。
  function renderOntologyBindings(refs) {
    const list = (refs && refs.length)
      ? '<ul class="evo-onto-list">' + refs.map(id =>
          `<li class="evo-onto-item" data-onto-id="${escapeHtml(id)}"><span>${escapeHtml(id)}</span><button class="btn btn-sm evo-onto-unbind" data-onto-id="${escapeHtml(id)}">解绑</button></li>`
        ).join('') + '</ul>'
      : '<div class="evo-empty">暂无绑定本体</div>';
    const form = '<div class="evo-onto-bind-form"><input type="text" id="evo-onto-bind-input" placeholder="本体 id" /><button class="btn btn-sm" id="evo-onto-bind-btn">绑定</button></div>';
    return list + form;
  }

  function renderEvalRecord(rec) {
    if (!rec || !rec.cases || !rec.cases.length) return '<div class="evo-empty">暂无评估用例</div>';
    const cases = rec.cases.map(c =>
      `<li class="evo-eval-case"><div class="evo-eval-input">${escapeHtml(c.input)}</div><ul class="evo-eval-assertions">${(c.assertions || []).map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul></li>`
    ).join('');
    const lastRun = rec.runs && rec.runs[0];
    const summary = lastRun ? `<div class="evo-eval-summary">通过率 ${Math.round((lastRun.passRate || 0) * 100)}%${lastRun.degraded ? '（规则降级）' : ''}</div>` : '';
    return summary + '<ul class="evo-eval-cases">' + cases + '</ul>';
  }

  function renderPatchList(patches) {
    if (!patches || !patches.length) return '<div class="evo-empty">暂无补丁提议</div>';
    return '<ul class="evo-patch-list">' + patches.map(p =>
      `<li class="evo-patch-item" data-patch-id="${escapeHtml(p.id)}"><span class="evo-patch-desc">${escapeHtml(p.description || '')}</span><span class="evo-patch-risk">R${escapeHtml(p.risk_level)}</span><span class="evo-patch-status">${escapeHtml(p.status)}</span></li>`
    ).join('') + '</ul>';
  }

  const api = { escapeHtml, renderDashboard, renderSkillsList, renderKstarTimeline, renderOntologyList, renderOntologyBindings, renderSkillVersions, renderCreateForm, renderInterviewQuestions, renderEvalRecord, renderPatchList };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // 测试桥
  else root.EvolutionPages = api;                                             // 浏览器全局
})(typeof window !== 'undefined' ? window : globalThis);
