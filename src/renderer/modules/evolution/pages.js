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

  // 技能选择器:进化控制台不再重复"管技能",只"选一个技能来演化"。
  // 浏览/新建/编辑归技能库。activeId = 当前选中(高亮)。
  function renderSkillSelector(skills, activeId, query) {
    const q = (query || '').trim().toLowerCase();
    const filtered = q
      ? (skills || []).filter(s => (s.name || '').toLowerCase().includes(q) || (s.id || '').toLowerCase().includes(q))
      : (skills || []);
    const hint = '<div class="evo-select-hint">选择要演化的技能，其余页(进化/本体/评估/补丁)将作用于所选技能。技能的浏览、新建、编辑请到「技能库」。</div>';
    const search = `<input type="text" id="evo-skill-search" class="evo-skill-search" placeholder="搜索技能…" value="${escapeHtml(query || '')}" />`;
    if (!skills || !skills.length) return hint + '<div class="evo-empty">技能库暂无技能，请先到「技能库」创建</div>';
    const list = filtered.length
      ? '<ul class="evo-skill-list">' + filtered.map(s => {
          const active = s.id === activeId ? ' evo-skill-item-active' : '';
          return `<li class="evo-skill-item${active}" data-skill-id="${escapeHtml(s.id)}"><span class="evo-skill-name">${escapeHtml(s.name)}</span><span class="evo-skill-cat">${escapeHtml(s.category || '未分类')}</span>${s.id === activeId ? '<span class="evo-skill-selected-tag">已选</span>' : ''}</li>`;
        }).join('') + '</ul>'
      : '<div class="evo-empty">无匹配技能</div>';
    return hint + search + list;
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

  function renderRecommendations(suggestions) {
    if (!suggestions || !suggestions.length) return '<div class="evo-empty">暂无进化建议（绑定领域本体或积累交互记录后生成）</div>';
    return '<ul class="evo-reco-list">' + suggestions.map(s =>
      `<li class="evo-reco-item evo-reco-${escapeHtml(s.severity || 'info')}"><span class="evo-reco-onto">${escapeHtml(s.ontology || '')}</span><span class="evo-reco-rule">${escapeHtml(s.rule || '')}</span><span class="evo-reco-sug">${escapeHtml(s.suggestion || '')}</span></li>`
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

  // 评估标准:人写的分类断言(定性/不变式/边界)+ 正负用例 + 就绪门槛。
  function renderEvalStandard(std) {
    if (!std || !std.assertions) return '<div class="evo-empty">暂无评估标准</div>';
    const a = std.assertions, c = std.cases;
    const readyBadge = std.ready
      ? '<span class="evo-std-ready">已就绪</span>'
      : '<span class="evo-std-notready">未达标</span>';
    const group = (label, items, min) =>
      `<div class="evo-std-group"><div class="evo-std-group-head">${escapeHtml(label)} <span class="evo-std-count">${items.length}/${min}</span></div>`
      + (items.length ? '<ul class="evo-std-items">' + items.map(x => `<li>${escapeHtml(x.text || '')}</li>`).join('') + '</ul>' : '<div class="evo-std-empty">未填写</div>')
      + '</div>';
    return '<div class="evo-std-view">'
      + `<div class="evo-std-header"><span class="evo-section-title">评估标准</span>${readyBadge}</div>`
      + '<div class="evo-std-block-title">断言（共 ' + a.total + '，需 ≥9）</div>'
      + group('定性 qualitative', a.qualitative, a.min_required.qualitative)
      + group('不变式 invariant', a.invariant, a.min_required.invariant)
      + group('边界 boundary', a.boundary, a.min_required.boundary)
      + '<div class="evo-std-block-title">用例（正 ' + c.positive.length + ' / 负 ' + c.negative.length + '，需 ≥' + c.min_positive + ' 正 · ≥' + c.min_negative + ' 负）</div>'
      + '<div class="evo-std-form">'
      + '<input type="text" id="evo-std-assert-text" placeholder="断言内容" />'
      + '<select id="evo-std-assert-type"><option value="qualitative">定性</option><option value="invariant">不变式</option><option value="boundary">边界</option></select>'
      + '<button class="btn btn-sm" id="evo-std-add-assert">加断言</button>'
      + '</div>'
      + '<div class="evo-std-form">'
      + '<input type="text" id="evo-std-case-input" placeholder="用例输入" />'
      + '<select id="evo-std-case-neg"><option value="0">正例</option><option value="1">负例</option></select>'
      + '<button class="btn btn-sm" id="evo-std-add-case">加用例</button>'
      + '<button class="btn btn-sm" id="evo-std-save">保存标准</button>'
      + '</div>'
      + '</div>';
  }

  function renderPatchList(patches) {
    if (!patches || !patches.length) return '<div class="evo-empty">暂无补丁提议</div>';
    return '<ul class="evo-patch-list">' + patches.map(p =>
      `<li class="evo-patch-item" data-patch-id="${escapeHtml(p.id)}"><span class="evo-patch-desc">${escapeHtml(p.description || '')}</span><span class="evo-patch-risk">R${escapeHtml(p.risk_level)}</span><span class="evo-patch-status">${escapeHtml(p.status)}</span></li>`
    ).join('') + '</ul>';
  }

  const api = { escapeHtml, renderDashboard, renderSkillsList, renderSkillSelector, renderKstarTimeline, renderOntologyList, renderOntologyBindings, renderSkillVersions, renderCreateForm, renderInterviewQuestions, renderRecommendations, renderEvalRecord, renderEvalStandard, renderPatchList };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // 测试桥
  else root.EvolutionPages = api;                                             // 浏览器全局
})(typeof window !== 'undefined' ? window : globalThis);
