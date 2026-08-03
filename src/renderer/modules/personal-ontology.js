// 个人本体候选审阅面板 — classic script (window.renderPersonalOntology)
(function () {
  let _pocWorkspaceView = 'candidates';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _t(key, fallback) {
    try { if (typeof t === 'function') { const v = t(key); if (v && v !== key) return v; } } catch (_) {}
    return fallback;
  }

  function _tv(key, vars, fallback) {
    try { if (typeof t === 'function') { const v = t(key, vars); if (v && v !== key) return v; } } catch (_) {}
    return fallback;
  }

  function _notifyFail(prefix, err) {
    const msg = (err && err.message) ? err.message : String(err || '');
    try {
      if (typeof uiAlert === 'function') uiAlert(msg ? `${prefix}: ${msg}` : prefix);
      else console.warn('[personal-ontology]', prefix, msg);
    } catch (_) {}
  }

  function _renderWorkspaceView() {
    document.querySelectorAll('[data-personal-onto-workspace-tab]').forEach((button) => {
      const active = button.dataset.personalOntoWorkspaceTab === _pocWorkspaceView;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll('[data-personal-onto-workspace-pane]').forEach((pane) => {
      pane.hidden = pane.dataset.personalOntoWorkspacePane !== _pocWorkspaceView;
    });
    if (_pocWorkspaceView === 'growth' && typeof window.renderCognitionPage === 'function') {
      window.renderCognitionPage();
    }
  }

  function _bindWorkspaceTabs() {
    const buttons = Array.from(document.querySelectorAll('[data-personal-onto-workspace-tab]'));
    buttons.forEach((button, index) => {
      if (button.dataset.personalOntoWorkspaceBound === '1') return;
      button.dataset.personalOntoWorkspaceBound = '1';
      button.addEventListener('click', () => {
        _pocWorkspaceView = button.dataset.personalOntoWorkspaceTab === 'growth' ? 'growth' : 'candidates';
        _renderWorkspaceView();
      });
      button.addEventListener('keydown', (event) => {
        let nextIndex = null;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % buttons.length;
        else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + buttons.length) % buttons.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = buttons.length - 1;
        if (nextIndex === null) return;
        event.preventDefault();
        buttons[nextIndex].click();
        buttons[nextIndex].focus();
      });
    });
    _renderWorkspaceView();
  }

  // ── "选择去向" state ─────────────────────────────────────────────────────
  // 记忆分组列表：本页打开时拉一次，供每张候选卡片的去向选择器复用。
  let _pocGroups = [];
  let _pocGroupsLoaded = false;
  // 每张候选卡片的去向选择状态： candidate_id -> { toGlobalMemory: bool, groupIds: Set<string> }
  // 默认勾选"全局记忆"，维持现有默认行为，不因新功能改变老用户习惯。
  const _pocDestState = new Map();

  function _pocDestFor(candidateId) {
    let state = _pocDestState.get(candidateId);
    if (!state) {
      state = { toGlobalMemory: true, groupIds: new Set() };
      _pocDestState.set(candidateId, state);
    }
    return state;
  }

  async function _pocLoadGroups() {
    try {
      const res = await window.orkas.invoke('personalOntology.groups.list', {});
      _pocGroups = (res && res.ok !== false && Array.isArray(res.groups)) ? res.groups : [];
    } catch (_) {
      _pocGroups = [];
    }
    _pocGroupsLoaded = true;
  }

  // Show a modal to collect reject reason. Returns Promise<string|null>.
  // null = user cancelled; '' = confirmed with no reason.
  function showRejectReasonModal() {
    return new Promise((resolve) => {
      const overlay = document.getElementById('personal-onto-modal');
      const textarea = document.getElementById('personal-onto-modal-reason');
      const okBtn = document.getElementById('personal-onto-modal-ok');
      const cancelBtn = document.getElementById('personal-onto-modal-cancel');
      if (!overlay || !textarea) { resolve(''); return; }

      textarea.value = '';
      overlay.style.display = 'flex';
      textarea.focus();

      function cleanup(value) {
        overlay.style.display = 'none';
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onOverlay);
        document.removeEventListener('keydown', onKey);
        resolve(value);
      }

      function onOk() { cleanup(textarea.value || ''); }
      function onCancel() { cleanup(null); }
      function onOverlay(e) { if (e.target === overlay) cleanup(null); }
      function onKey(e) {
        if (e.key === 'Escape') cleanup(null);
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); cleanup(textarea.value || ''); }
      }

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      overlay.addEventListener('click', onOverlay);
      document.addEventListener('keydown', onKey);
    });
  }

  // 状态统计卡片 —— 候选处理后直接从池里消失，只统计"待确认"和"已阻断"
  function renderStats(data) {
    const pending = (data.candidate_updates || []).length;
    const blocked = (data.blocked_items || []).length;

    return `<div class="personal-onto-stats-row">
      <div class="personal-onto-stat-card">
        <div class="personal-onto-stat-value">${pending}</div>
        <div class="personal-onto-stat-label">${_t('personalOntology.pending', '待确认')}</div>
      </div>
      <div class="personal-onto-stat-card personal-onto-stat-card-blocked">
        <div class="personal-onto-stat-value">${blocked}</div>
        <div class="personal-onto-stat-label">${_t('personalOntology.blocked', '已阻断')}</div>
      </div>
    </div>`;
  }

  // "选择去向"面板 —— 常驻在卡片上（不是点确认弹出二次面板，避免多一次点击）。
  // 默认勾选"全局记忆"；可以额外多选任意数量的已有分组；提供"新建分组"的内联
  // 输入框入口。
  function renderDestinationPanel(candidateId) {
    const state = _pocDestFor(candidateId);
    const groupRows = _pocGroups.map((g) => {
      const checked = state.groupIds.has(g.group_id);
      return `
        <label class="personal-onto-dest-group-row">
          <input type="checkbox" class="personal-onto-dest-group-checkbox"
                 data-candidate-id="${escapeHtml(candidateId)}" data-group-id="${escapeHtml(g.group_id)}"
                 ${checked ? 'checked' : ''} />
          <span>${escapeHtml(g.title || '')}</span>
        </label>`;
    }).join('');

    return `
      <div class="personal-onto-dest-panel" data-candidate-id="${escapeHtml(candidateId)}">
        <div class="personal-onto-dest-title">${_t('personalOntology.dest_title', '选择去向')}</div>
        <label class="personal-onto-dest-global-row">
          <input type="checkbox" class="personal-onto-dest-global-checkbox"
                 data-candidate-id="${escapeHtml(candidateId)}" ${state.toGlobalMemory ? 'checked' : ''} />
          <span>${_t('personalOntology.dest_global_memory', '全局记忆')}</span>
        </label>
        ${_pocGroupsLoaded && !_pocGroups.length
          ? `<div class="personal-onto-dest-empty muted">${_t('personalOntology.dest_no_groups', '暂无记忆分组')}</div>`
          : `<div class="personal-onto-dest-groups">${groupRows}</div>`}
        <div class="personal-onto-dest-create-row">
          <input type="text" class="personal-onto-dest-new-group-input"
                 data-candidate-id="${escapeHtml(candidateId)}"
                 placeholder="${escapeHtml(_t('personalOntology.dest_new_group_placeholder', '新建分组名称...'))}" />
          <button type="button" class="btn btn-sm personal-onto-dest-create-btn" data-candidate-id="${escapeHtml(candidateId)}">
            ${_t('personalOntology.dest_create_group_btn', '新建')}
          </button>
        </div>
      </div>`;
  }

  // 单个候选卡片 —— 展示人读摘要 + 记忆去向，不再是原始 JSON payload
  function renderCandidateCard(candidate) {
    const kindLabel = {
      preference: _t('personalOntology.kind_preference', '偏好'),
      instance: _t('personalOntology.kind_instance', '实例'),
      property: _t('personalOntology.kind_property', '属性'),
      relation: _t('personalOntology.kind_relation', '关系'),
      rule: _t('personalOntology.kind_rule', '规则'),
    }[candidate.kind] || candidate.kind;

    const confidenceLabel = {
      low: _t('personalOntology.confidence_low', '低'),
      medium: _t('personalOntology.confidence_medium', '中'),
      high: _t('personalOntology.confidence_high', '高'),
    }[candidate.confidence] || candidate.confidence;

    const scopeLabel = candidate.memory_scope === 'shared'
      ? _t('personalOntology.scope_shared', '共享记忆')
      : _t('personalOntology.scope_user', '个人画像');

    const actions = `<button class="btn btn-sm personal-onto-btn-confirm" data-candidate-id="${escapeHtml(candidate.candidate_id)}">${_t('personalOntology.confirm_btn', '确认')}</button>
         <button class="btn btn-sm personal-onto-btn-reject" data-candidate-id="${escapeHtml(candidate.candidate_id)}">${_t('personalOntology.reject_btn', '驳回')}</button>`;

    return `<div class="personal-onto-card" data-candidate-id="${escapeHtml(candidate.candidate_id)}">
      <div class="personal-onto-card-header">
        <span class="personal-onto-card-kind">${escapeHtml(kindLabel)}</span>
        <span class="personal-onto-card-confidence">${_t('personalOntology.confidence', '置信度')}: ${escapeHtml(confidenceLabel)}</span>
        <span class="personal-onto-card-scope">${escapeHtml(scopeLabel)}</span>
      </div>
      <div class="personal-onto-card-body">
        <div class="personal-onto-card-field personal-onto-card-summary">${escapeHtml(candidate.summary || candidate.memory_text || '-')}</div>
        ${candidate.registry_like_path ? `<div class="personal-onto-card-field"><strong>${_t('personalOntology.path', '路径')}:</strong> ${escapeHtml(candidate.registry_like_path)}</div>` : ''}
        ${candidate.diff_summary ? `<div class="personal-onto-card-field"><strong>${_t('personalOntology.diff', '差异')}:</strong> ${escapeHtml(candidate.diff_summary)}</div>` : ''}
        <div class="personal-onto-card-field"><strong>${_t('personalOntology.sources', '来源')}:</strong> ${candidate.source_memory_refs && candidate.source_memory_refs.length ? escapeHtml(candidate.source_memory_refs.join(', ')) : '-'}</div>
      </div>
      ${renderDestinationPanel(candidate.candidate_id)}
      <div class="personal-onto-card-actions">${actions}</div>
    </div>`;
  }

  // 阻断项卡片
  function renderBlockedCard(item) {
    return `<div class="personal-onto-blocked-card">
      <div class="personal-onto-blocked-header">
        <span class="personal-onto-blocked-icon">⚠</span>
        <span class="personal-onto-blocked-source">${escapeHtml(item.source_ref || '-')}</span>
      </div>
      <div class="personal-onto-blocked-body">
        <div class="personal-onto-blocked-field"><strong>${_t('personalOntology.blocked_reason', '原因')}:</strong> ${escapeHtml(item.reason || '-')}</div>
        <div class="personal-onto-blocked-field"><strong>${_t('personalOntology.blocked_fix', '修复建议')}:</strong> ${escapeHtml(item.required_fix || '-')}</div>
      </div>
    </div>`;
  }

  // 渲染主体
  async function renderPersonalOntology() {
    _bindWorkspaceTabs();
    const statsEl = document.getElementById('personal-onto-stats');
    const bodyEl = document.getElementById('personal-onto-body');
    const actionsEl = document.getElementById('personal-onto-actions');

    if (!statsEl || !bodyEl) {
      _notifyFail(_t('personalOntology.load_error', '加载失败'), new Error('personal ontology panel is incomplete'));
      return;
    }

    bodyEl.innerHTML = '<div class="personal-onto-loading">' + _t('personalOntology.loading', '加载中...') + '</div>';

    try {
      const [data] = await Promise.all([
        window.orkas.invoke('personalOntology.candidates.list'),
        _pocLoadGroups(),
      ]);

      // 渲染统计
      statsEl.innerHTML = renderStats(data);

      // 渲染候选列表
      const candidates = (data.candidate_updates || []);
      const blocked = (data.blocked_items || []);

      // 已处理过的候选（不再在池里）没必要继续占内存里的去向选择状态。
      const liveIds = new Set(candidates.map((c) => c.candidate_id));
      for (const id of _pocDestState.keys()) {
        if (!liveIds.has(id)) _pocDestState.delete(id);
      }

      if (!candidates.length && !blocked.length) {
        bodyEl.innerHTML = '<div class="personal-onto-empty">' + _t('personalOntology.empty', '暂无候选') + '</div>';
        actionsEl.innerHTML = '';
        return;
      }

      let html = '';

      if (candidates.length > 0) {
        html += `<div class="personal-onto-section"><h3 class="personal-onto-section-title">${_t('personalOntology.candidates_title', '候选列表')}</h3>`;
        html += '<div class="personal-onto-cards">';
        for (const c of candidates) {
          html += renderCandidateCard(c);
        }
        html += '</div></div>';
      }

      if (blocked.length > 0) {
        html += `<div class="personal-onto-section"><h3 class="personal-onto-section-title">${_t('personalOntology.blocked_title', '阻断项')}</h3>`;
        html += '<div class="personal-onto-blocked-cards">';
        for (const b of blocked) {
          html += renderBlockedCard(b);
        }
        html += '</div></div>';
      }

      bodyEl.innerHTML = html;

      // 绑定确认/驳回按钮 + 去向选择器
      bindActions(data);
      bindDestinationControls(bodyEl);

      // 顶部批量操作按钮 —— 候选池里的都是待确认（处理过的已经从池里消失）
      if (candidates.length > 0) {
        actionsEl.innerHTML = `<button class="btn btn-sm" id="personal-onto-confirm-all">${_t('personalOntology.confirm_all_btn', '全部确认')}</button>
          <button class="btn btn-sm" id="personal-onto-reject-all">${_t('personalOntology.reject_all_btn', '全部驳回')}</button>`;
        document.getElementById('personal-onto-confirm-all')?.addEventListener('click', () => confirmAll(candidates));
        document.getElementById('personal-onto-reject-all')?.addEventListener('click', () => rejectAll(candidates));
      } else {
        actionsEl.innerHTML = '';
      }

    } catch (err) {
      _notifyFail(_t('personalOntology.load_error', '加载失败'), err);
      bodyEl.innerHTML = '<div class="personal-onto-error">' + _t('personalOntology.load_error', '加载失败') + ': ' + escapeHtml((err && err.message) || String(err)) + '</div>';
    }
  }

  function bindActions(data) {
    const bodyEl = document.getElementById('personal-onto-body');
    if (!bodyEl) return;

    bodyEl.querySelectorAll('.personal-onto-btn-confirm').forEach(btn => {
      btn.addEventListener('click', () => confirmCandidate(btn.dataset.candidateId));
    });

    bodyEl.querySelectorAll('.personal-onto-btn-reject').forEach(btn => {
      btn.addEventListener('click', () => rejectCandidate(btn.dataset.candidateId));
    });
  }

  // 只重绘一张卡片的去向面板（新建分组后要刷新分组列表勾选项，不需要重绘整页）。
  function _rerenderDestinationPanel(candidateId) {
    const card = document.querySelector(`.personal-onto-card[data-candidate-id="${CSS.escape(candidateId)}"]`);
    if (!card) return;
    const old = card.querySelector('.personal-onto-dest-panel');
    if (!old) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderDestinationPanel(candidateId);
    old.replaceWith(wrapper.firstElementChild);
    bindDestinationControls(card);
  }

  function bindDestinationControls(root) {
    root.querySelectorAll('.personal-onto-dest-global-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => {
        _pocDestFor(cb.dataset.candidateId).toGlobalMemory = cb.checked;
      });
    });

    root.querySelectorAll('.personal-onto-dest-group-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => {
        const state = _pocDestFor(cb.dataset.candidateId);
        if (cb.checked) state.groupIds.add(cb.dataset.groupId);
        else state.groupIds.delete(cb.dataset.groupId);
      });
    });

    root.querySelectorAll('.personal-onto-dest-create-btn').forEach((btn) => {
      btn.addEventListener('click', () => _createGroupInline(btn.dataset.candidateId));
    });

    root.querySelectorAll('.personal-onto-dest-new-group-input').forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          _createGroupInline(input.dataset.candidateId);
        }
      });
    });
  }

  async function _createGroupInline(candidateId) {
    const input = document.querySelector(`.personal-onto-dest-new-group-input[data-candidate-id="${CSS.escape(candidateId)}"]`);
    const title = (input && input.value || '').trim();
    if (!title) return;
    try {
      const res = await window.orkas.invoke('personalOntology.groups.create', { title });
      if (!res || res.ok === false) {
        _notifyFail(_t('personalOntology.dest_create_group_error', '新建分组失败'), new Error(res && res.error || ''));
        return;
      }
      await _pocLoadGroups();
      // 新建的分组默认直接勾选上，省一次手动勾选。
      if (res.group) _pocDestFor(candidateId).groupIds.add(res.group.group_id);
      _rerenderDestinationPanel(candidateId);
    } catch (err) {
      _notifyFail(_t('personalOntology.dest_create_group_error', '新建分组失败'), err);
    }
  }

  function _destPayloadFor(candidateId) {
    const state = _pocDestFor(candidateId);
    return {
      toGlobalMemory: !!state.toGlobalMemory,
      toGroupIds: Array.from(state.groupIds),
    };
  }

  // 把 confirmCandidate/confirmCandidates 返回体里"分组写入失败"的部分翻译成
  // 一句可读提示——让 UI 层能分别提示"全局记忆写入失败"和"某个分组写入失败"。
  function _destResultToWarnings(res) {
    const warnings = [];
    if (res && res.globalMemory && res.globalMemory.ok === false) {
      warnings.push(_tv('personalOntology.dest_global_failed', { error: res.globalMemory.error || '' },
        `全局记忆写入失败: ${res.globalMemory.error || ''}`));
    }
    if (res && Array.isArray(res.groups)) {
      res.groups.forEach((g) => {
        if (g.ok === false) {
          const group = _pocGroups.find((x) => x.group_id === g.groupId);
          const label = group ? group.title : g.groupId;
          warnings.push(_tv('personalOntology.dest_group_failed', { group: label, error: g.error || '' },
            `分组「${label}」写入失败: ${g.error || ''}`));
        }
      });
    }
    return warnings;
  }

  async function confirmCandidate(candidateId) {
    if (!candidateId) return;
    try {
      const res = await window.orkas.invoke('personalOntology.candidates.confirm', {
        candidateId,
        ...(_destPayloadFor(candidateId)),
      });
      const warnings = _destResultToWarnings(res);
      if (res && res.ok === false) {
        _notifyFail(_t('personalOntology.confirm_error', '确认失败'), new Error((res.error || warnings.join('; ')) || ''));
        return;
      }
      if (warnings.length) {
        try {
          if (typeof uiToast === 'function') warnings.forEach((w) => uiToast(w, { variant: 'warning' }));
          else warnings.forEach((w) => console.warn('[personal-ontology]', w));
        } catch (_) {}
      }
      _pocDestState.delete(candidateId);
      renderPersonalOntology(); // 重新渲染
    } catch (err) {
      _notifyFail(_t('personalOntology.confirm_error', '确认失败'), err);
    }
  }

  async function rejectCandidate(candidateId) {
    if (!candidateId) return;
    const reason = await showRejectReasonModal();
    if (reason === null) return; // 用户取消
    try {
      await window.orkas.invoke('personalOntology.candidates.reject', { candidateId, reason: reason || '' });
      _pocDestState.delete(candidateId);
      renderPersonalOntology();
    } catch (err) {
      _notifyFail(_t('personalOntology.reject_error', '驳回失败'), err);
    }
  }

  async function confirmAll(pending) {
    if (!pending || !pending.length) return;
    if (!confirm(_t('personalOntology.confirm_all_prompt', `确认全部 ${pending.length} 个候选？`))) return;
    try {
      const candidateIds = pending.map(c => c.candidate_id);
      // 批量操作对这批候选统一使用第一条的去向选择（跟审阅面板"批量操作走同一份
      // 选择去向"的产品预期一致；逐条不同去向需要逐个点"确认"）。
      const dest = candidateIds.length ? _destPayloadFor(candidateIds[0]) : { toGlobalMemory: true, toGroupIds: [] };
      const res = await window.orkas.invoke('personalOntology.candidates.confirmBatch', { candidateIds, ...dest });
      if (res && res.failedIds && res.failedIds.length) {
        try {
          if (typeof uiToast === 'function') {
            uiToast(_tv('personalOntology.confirm_all_partial', { n: res.failedIds.length }, `${res.failedIds.length} 条确认失败`), { variant: 'warning' });
          }
        } catch (_) {}
      }
      candidateIds.forEach((id) => _pocDestState.delete(id));
      renderPersonalOntology();
    } catch (err) {
      _notifyFail(_t('personalOntology.confirm_all_error', '批量确认失败'), err);
    }
  }

  async function rejectAll(pending) {
    if (!pending || !pending.length) return;
    const reason = await showRejectReasonModal();
    if (reason === null) return;
    try {
      const candidateIds = pending.map(c => c.candidate_id);
      await window.orkas.invoke('personalOntology.candidates.rejectBatch', { candidateIds, reason: reason || '' });
      candidateIds.forEach((id) => _pocDestState.delete(id));
      renderPersonalOntology();
    } catch (err) {
      _notifyFail(_t('personalOntology.reject_all_error', '批量驳回失败'), err);
    }
  }

  window.renderPersonalOntology = renderPersonalOntology;
  window.openPersonalOntologyGrowth = function openPersonalOntologyGrowth() {
    _pocWorkspaceView = 'growth';
    _renderWorkspaceView();
  };
  window.addEventListener('i18n-change', () => {
    if (document.getElementById('panel-personal-ontology')?.classList.contains('active')) {
      renderPersonalOntology();
    }
  });
})();
