(function () {
  const ACTIONS = {
    save: 'save',
    projectContext: 'project-context',
    revise: 'revise',
    taskContract: 'task-contract',
    confirm: 'confirm',
    start: 'start',
  };

  function _crList(items, mapper) {
    const rows = Array.isArray(items) ? items.slice(0, 8) : [];
    if (!rows.length) return '<li class="muted">-</li>';
    return rows.map((item) => `<li>${escapeHtml(mapper(item))}</li>`).join('');
  }

  function _crJoined(items) {
    return Array.isArray(items) && items.length ? items.map(String).join(', ') : '-';
  }

  function _crValue(value) {
    return escapeHtml(String(value || ''));
  }

  function _guideStepKey(state) {
    if (!state || !state.draft) return 'companion.repro.guide.intent_first';
    if (!state.reference_manifest) return 'companion.repro.guide.need_import';
    if (!state.project_context) return 'companion.repro.guide.need_context';
    if (!state.task_contract) return 'companion.repro.guide.need_contract';
    if (!state.task_contract.confirmed_at) return 'companion.repro.guide.need_confirmation';
    return 'companion.repro.guide.ready_to_execute';
  }

  function _guideChecklist(state) {
    const draftDone = !!state?.draft;
    const manifestDone = !!state?.reference_manifest;
    const contextDone = !!state?.project_context;
    const contractDone = !!state?.task_contract;
    const confirmed = !!state?.task_contract?.confirmed_at;
    const rows = [
      ['companion.repro.guide.need_import', manifestDone || draftDone],
      ['companion.repro.guide.need_context', contextDone],
      ['companion.repro.guide.need_contract', contractDone],
      ['companion.repro.guide.need_confirmation', confirmed],
    ];
    return rows.map(([key, done]) => `<li class="${done ? 'is-done' : ''}">${done ? '✓' : '•'} ${escapeHtml(t(key))}</li>`).join('');
  }

  function _guideHistory(messages) {
    const rows = Array.isArray(messages) ? messages.slice(-12) : [];
    if (!rows.length) return '';
    return `<section class="companion-repro-guide-history"><h3>${escapeHtml(t('companion.repro.guide.history'))}</h3>${rows.map((msg) => {
      const role = msg && msg.role === 'user' ? 'user' : 'assistant';
      return `<div class="companion-repro-guide-message is-${role}"><span>${escapeHtml(role === 'user' ? t('companion.repro.guide.user') : t('companion.repro.guide.assistant'))}</span><p>${escapeHtml(String(msg?.text || ''))}</p></div>`;
    }).join('')}</section>`;
  }

  function shouldHandleChatMessage(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    return /(论文|paper|GitHub|github|repo|仓库|复现|跑一下|run)/i.test(value)
      && /(论文|paper|GitHub|github|repo|仓库|复现)/i.test(value);
  }

  function renderState(state) {
    const s = state && typeof state === 'object' ? state : {};
    const manifest = s.reference_manifest || {};
    const context = s.project_context || {};
    const contract = s.task_contract || {};
    const draft = s.draft || {};
    const confirmed = !!contract.confirmed_at;
    return `
      <div class="companion-repro-card">
        <div class="companion-repro-head">
          <div>
            <div class="companion-repro-title">${escapeHtml(t('companion.repro.title'))}</div>
            <div class="companion-repro-subtitle">${escapeHtml(t('companion.repro.subtitle'))}</div>
          </div>
          <span class="companion-repro-chip ${confirmed ? 'is-confirmed' : 'is-draft'}">${escapeHtml(t(confirmed ? 'companion.repro.confirmed' : 'companion.repro.unconfirmed'))}</span>
        </div>
        <section class="companion-repro-guide">
          <h3>${escapeHtml(t('companion.repro.guide.title'))}</h3>
          <p>${escapeHtml(t(_guideStepKey(s)))}</p>
          <ul>${_guideChecklist(s)}</ul>
        </section>
        ${_guideHistory(s.guide_messages)}
        <details class="companion-repro-section companion-repro-advanced">
          <summary>${escapeHtml(t('companion.repro.advanced'))}</summary>
          <div class="companion-repro-grid">
            <label>${escapeHtml(t('companion.repro.paper_title'))}<input data-companion-repro-field="paper_title" value="${_crValue(draft.paper_title)}" /></label>
            <label>${escapeHtml(t('companion.repro.repo_url'))}<input data-companion-repro-field="repo_url" value="${_crValue(draft.repo_url)}" /></label>
            <label>${escapeHtml(t('companion.repro.commit'))}<input data-companion-repro-field="commit" value="${_crValue(draft.commit)}" /></label>
            <label>${escapeHtml(t('companion.repro.workspace_path'))}<input data-companion-repro-field="workspace_path" value="${_crValue(draft.workspace_path)}" /></label>
          </div>
          <label class="companion-repro-wide">${escapeHtml(t('companion.repro.paper_selection'))}<textarea data-companion-repro-field="paper_selection" rows="3">${_crValue(draft.paper_selection)}</textarea></label>
          <label class="companion-repro-wide">${escapeHtml(t('companion.repro.user_intent'))}<textarea data-companion-repro-field="user_intent" rows="2" placeholder="${escapeHtml(t('companion.repro.guide.intent_placeholder'))}">${_crValue(draft.user_intent)}</textarea></label>
          <div class="companion-repro-actions"><button type="button" class="btn primary small" data-companion-repro-action="${ACTIONS.save}">${escapeHtml(t('companion.repro.save_import'))}</button></div>
        </details>
        <section class="companion-repro-section">
          <h3>${escapeHtml(t('companion.repro.manifest'))}</h3>
          <div class="companion-repro-meta">${escapeHtml(String(manifest.repo_url || '-'))} · ${escapeHtml(String(manifest.commit || '-'))}</div>
          <div class="companion-repro-columns">
            <div><h4>${escapeHtml(t('companion.repro.included'))}</h4><ul>${_crList(manifest.included_files, (file) => file.path || '')}</ul></div>
            <div><h4>${escapeHtml(t('companion.repro.skipped'))}</h4><ul>${_crList(manifest.skipped_files, (file) => `${file.path || ''}${file.reason ? ` (${file.reason})` : ''}`)}</ul></div>
          </div>
          <button type="button" class="btn small" data-companion-repro-action="${ACTIONS.projectContext}">${escapeHtml(t('companion.repro.generate_context'))}</button>
        </section>
        <section class="companion-repro-section">
          <h3>${escapeHtml(t('companion.repro.project_context'))}</h3>
          <p>${escapeHtml(String(context.project_goal || '-'))}</p>
          <div class="companion-repro-meta">${escapeHtml(t('companion.repro.tech_stack'))}: ${escapeHtml(_crJoined(context.tech_stack))}</div>
          <ul>${_crList(context.uncertainties, (item) => item)}</ul>
          <div class="companion-repro-grid">
            <input data-companion-repro-revision="before" placeholder="${escapeHtml(t('companion.repro.revision_before'))}" />
            <input data-companion-repro-revision="after" placeholder="${escapeHtml(t('companion.repro.revision_after'))}" />
            <input data-companion-repro-revision="reason" placeholder="${escapeHtml(t('companion.repro.revision_reason'))}" />
          </div>
          <button type="button" class="btn small" data-companion-repro-action="${ACTIONS.revise}">${escapeHtml(t('companion.repro.apply_revision'))}</button>
        </section>
        <section class="companion-repro-section">
          <h3>${escapeHtml(t('companion.repro.task_contract'))}</h3>
          <p>${escapeHtml(String(contract.goal || '-'))}</p>
          <h4>${escapeHtml(t('companion.repro.success_criteria'))}</h4><ul>${_crList(contract.success_criteria, (item) => item)}</ul>
          <h4>${escapeHtml(t('companion.repro.plan'))}</h4><ul>${_crList(contract.plan, (item) => item)}</ul>
          <h4>${escapeHtml(t('companion.repro.risks'))}</h4><ul>${_crList(contract.risks, (item) => item)}</ul>
          <div class="companion-repro-actions">
            <button type="button" class="btn small" data-companion-repro-action="${ACTIONS.taskContract}">${escapeHtml(t('companion.repro.generate_contract'))}</button>
            <button type="button" class="btn primary small" data-companion-repro-action="${ACTIONS.confirm}">${escapeHtml(t('companion.repro.confirm_contract'))}</button>
            <button type="button" class="btn primary small" data-companion-repro-action="${ACTIONS.start}"${confirmed ? '' : ' disabled'}>${escapeHtml(t('companion.repro.start_execution'))}</button>
          </div>
        </section>
      </div>`;
  }

  function _readDraft(root) {
    const field = (name) => root.querySelector(`[data-companion-repro-field="${name}"]`)?.value || '';
    return {
      paper_title: field('paper_title').trim(),
      paper_selection: field('paper_selection').trim(),
      repo_url: field('repo_url').trim(),
      commit: field('commit').trim(),
      workspace_path: field('workspace_path').trim(),
      user_intent: field('user_intent').trim(),
    };
  }

  async function mount(cid) {
    const host = document.getElementById('companion-repro-host');
    if (!host || !cid) return;
    const refresh = async () => {
      let state = null;
      try {
        const res = await window.cogseed.invoke('companionRepro.getState', { cid });
        state = res && res.state;
      } catch (_) { state = null; }
      host.innerHTML = renderState(state);
    };
    await refresh();
    if (host.dataset.companionReproBound === '1') return;
    host.dataset.companionReproBound = '1';
    host.addEventListener('click', async (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('[data-companion-repro-action]') : null;
      if (!btn || btn.disabled) return;
      const action = btn.dataset.companionReproAction;
      try {
        if (action === ACTIONS.save) {
          await window.cogseed.invoke('companionRepro.saveDraft', { cid, draft: _readDraft(host) });
        } else if (action === ACTIONS.projectContext) {
          await window.cogseed.invoke('companionRepro.generateProjectContext', { cid });
        } else if (action === ACTIONS.revise) {
          await window.cogseed.invoke('companionRepro.applyProjectContextRevision', {
            cid,
            before: host.querySelector('[data-companion-repro-revision="before"]')?.value || '',
            after: host.querySelector('[data-companion-repro-revision="after"]')?.value || '',
            reason: host.querySelector('[data-companion-repro-revision="reason"]')?.value || '',
          });
        } else if (action === ACTIONS.taskContract) {
          await window.cogseed.invoke('companionRepro.generateTaskContract', { cid });
        } else if (action === ACTIONS.confirm) {
          await window.cogseed.invoke('companionRepro.confirmTaskContract', { cid });
        } else if (action === ACTIONS.start) {
          const res = await window.cogseed.invoke('companionRepro.startExecution', { cid });
          if (!res || !res.ok) throw new Error(res?.error || 'start failed');
        }
        await refresh();
      } catch (err) {
        try { await uiAlert((err && err.message) || t('companion.repro.failed')); } catch (_) {}
      }
    });
  }

  async function handleChatMessage(cid, text, opts = {}) {
    if (!cid || !shouldHandleChatMessage(text)) return false;
    const append = typeof opts.append === 'function' ? opts.append : null;
    if (append) append('user', text);
    const res = await window.cogseed.invoke('companionRepro.submitGuideMessage', { cid, text });
    const messages = Array.isArray(res?.state?.guide_messages) ? res.state.guide_messages : [];
    const last = messages[messages.length - 1];
    if (append && last?.role === 'assistant') append('assistant', last.text || '');
    await mount(cid);
    return true;
  }

  window.CompanionRepro = { renderState, mount, shouldHandleChatMessage, handleChatMessage };
}());
