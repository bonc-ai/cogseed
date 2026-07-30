// 个人本体候选审阅面板 — classic script (window.renderPersonalOntology)
(function () {
  const _personalOntologyLog = createLogger('personal-ontology');
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _t(key, fallback) {
    try { if (typeof t === 'function') { const v = t(key); if (v && v !== key) return v; } } catch (_) {}
    return fallback;
  }

  function _notifyFail(prefix, err) {
    const msg = (err && err.message) ? err.message : String(err || '');
    try {
      if (typeof uiAlert === 'function') uiAlert(msg ? `${prefix}: ${msg}` : prefix);
      else _personalOntologyLog.warn(prefix, { error: msg });
    } catch (_) {}
  }

  async function _readApiResult(response, fallback) {
    const data = await response.json();
    if (!data || data.ok === false) throw new Error((data && data.error) || fallback);
    return data;
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
      overlay.hidden = false;
      overlay.classList.add('open');
      textarea.focus();

      function cleanup(value) {
        overlay.classList.remove('open');
        overlay.hidden = true;
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
    _personalOntologyLog.info('render candidates');
    const statsEl = document.getElementById('personal-onto-stats');
    const bodyEl = document.getElementById('personal-onto-body');
    const actionsEl = document.getElementById('personal-onto-actions');

    if (!statsEl || !bodyEl) {
      _personalOntologyLog.warn('missing candidate panel DOM', { stats: !!statsEl, body: !!bodyEl });
      return;
    }

    bodyEl.innerHTML = '<div class="personal-onto-loading">' + _t('personalOntology.loading', '加载中...') + '</div>';

    try {
      const data = await _readApiResult(
        await window.apiFetch('/api/personalOntology/candidates'),
        _t('personalOntology.load_error', '加载失败'),
      );

      // 渲染统计
      statsEl.innerHTML = renderStats(data);

      // 渲染候选列表
      const candidates = (data.candidate_updates || []);
      const blocked = (data.blocked_items || []);

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

      // 绑定确认/驳回按钮
      bindActions(data);

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
      _personalOntologyLog.error('render failed', { error: (err && err.message) || String(err) });
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

  async function confirmCandidate(candidateId) {
    if (!candidateId) return;
    try {
      await _readApiResult(await window.apiFetch('/api/personalOntology/candidates/confirm', {
        method: 'POST',
        body: JSON.stringify({ candidateId }),
      }), _t('personalOntology.confirm_error', '确认失败'));
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
      await _readApiResult(await window.apiFetch('/api/personalOntology/candidates/reject', {
        method: 'POST',
        body: JSON.stringify({ candidateId, reason: reason || '' }),
      }), _t('personalOntology.reject_error', '驳回失败'));
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
      await _readApiResult(await window.apiFetch('/api/personalOntology/candidates/confirmBatch', {
        method: 'POST',
        body: JSON.stringify({ candidateIds }),
      }), _t('personalOntology.confirm_all_error', '批量确认失败'));
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
      await _readApiResult(await window.apiFetch('/api/personalOntology/candidates/rejectBatch', {
        method: 'POST',
        body: JSON.stringify({ candidateIds, reason: reason || '' }),
      }), _t('personalOntology.reject_all_error', '批量驳回失败'));
      renderPersonalOntology();
    } catch (err) {
      _notifyFail(_t('personalOntology.reject_all_error', '批量驳回失败'), err);
    }
  }

  window.renderPersonalOntology = renderPersonalOntology;
  _personalOntologyLog.info('module loaded');
})();
