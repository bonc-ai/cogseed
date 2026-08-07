// Skill-only DOM bindings. Loaded immediately after skills.js when either the
// Skills tab or the chat Agent/Skill picker first needs that surface.

function _initSkillsStaticBindings() {
  const panel = document.getElementById('panel-skills');
  if (panel && panel.dataset.skillBindings === '1') return;
  if (panel) panel.dataset.skillBindings = '1';

  document.getElementById('create-skill-btn')?.addEventListener('click', () => {
    openSkillModal();
  });
  document.getElementById('skills-more-btn')?.addEventListener('click', () => {
    const load = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
    if (typeof load !== 'function') return;
    load('marketplace').then(() => openMarketplace('skill')).catch(() => {});
  });
  document.getElementById('skill-use-btn')?.addEventListener('click', () => {
    if (_selectedSkill && !_skillsCache?.some((s) => s.id === _selectedSkill.id && s.enabled === false)) {
      useSkill(_selectedSkill.id, _selectedSkill.name);
    }
  });
  document.getElementById('skill-edit-btn')?.addEventListener('click', toggleSkillEditMode);
  document.getElementById('skill-delete-btn')?.addEventListener('click', deleteSelectedSkill);
  document.getElementById('skill-upload-marketplace-btn')?.addEventListener('click', () => {
    if (_selectedSkill && typeof openMarketplaceUpload === 'function') {
      openMarketplaceUpload('skill', _selectedSkill.id, _selectedSkill.source);
    }
  });
  document.getElementById('skill-chat-clear-btn')?.addEventListener('click', clearSkillChat);
  document.getElementById('skills-back-btn')?.addEventListener('click', () => _onSkillsBack());
  document.getElementById('skills-source-toggle')?.addEventListener('click', () => _toggleSkillsSource());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const skillsPanel = document.getElementById('panel-skills');
    if (!skillsPanel || !skillsPanel.classList.contains('active')) return;
    const detail = document.getElementById('skills-detail-view');
    if (detail && detail.style.display !== 'none') {
      _onSkillsBack();
      e.preventDefault();
    }
  });
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('skill-row-menu');
    if (!menu || menu.style.display === 'none') return;
    if (menu.contains(e.target)) return;
    if (e.target.closest('[data-skill-more]')) return;
    _closeSkillRowMenu();
  });
  window.addEventListener('scroll', _closeSkillRowMenu, true);
  window.addEventListener('resize', _closeSkillRowMenu);
  window.addEventListener('i18n-change', () => {
    _closeSkillRowMenu();
    if (_skillsCache) renderSkillsGrid(_skillsCache);
  });
  const skillChatInput = document.getElementById('skills-chat-input');
  skillChatInput?.addEventListener('input', () => autoGrow(skillChatInput, 120));
  // Composer chat-use bindings are owned by the eager chat-use core. The
  // binder is idempotent, but Skills navigation must not initialize chat.
}

_initSkillsStaticBindings();

function _initSkillsCognitionBindings() {
  const panel = document.getElementById('panel-skills');
  if (!panel || panel.dataset.cognitionBindings === '1') return;
  panel.dataset.cognitionBindings = '1';

  document.getElementById('skills-cognition-tabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cognition-page]');
    if (!button) return;
    switchSkillsCognitionPage(button.dataset.cognitionPage || 'overview');
  });

  document.getElementById('ability-assets-tabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-ability-assets-view]');
    if (!button) return;
    const view = button.dataset.abilityAssetsView === 'tree' ? 'tree' : 'list';
    _skillsCognitionState.assetView = view;
    document.querySelectorAll('[data-ability-assets-view]').forEach((el) => el.classList.toggle('is-active', el === button));
    renderSkillsCognitionAssets();
  });

  panel.addEventListener('click', async (event) => {
    const pageLink = event.target.closest('[data-cognition-page-link]');
    if (pageLink) {
      switchSkillsCognitionPage(pageLink.dataset.cognitionPageLink || 'overview');
      return;
    }

    const openReceipt = event.target.closest('[data-cognition-open-receipt]');
    if (openReceipt) {
      await openSkillsCognitionReceiptDetail(openReceipt.dataset.cognitionOpenReceipt);
      return;
    }

    const openCandidate = event.target.closest('[data-cognition-open-candidate]');
    if (openCandidate) {
      switchSkillsCognitionPage('candidates');
      return;
    }

    const abilityCategory = event.target.closest('[data-ability-asset-category]');
    if (abilityCategory) {
      const category = abilityCategory.dataset.abilityAssetCategory || '';
      _skillsCognitionState.assetCategoryFilter = _skillsCognitionState.assetCategoryFilter === category ? '' : category;
      _skillsCognitionState.selectedAssetId = '';
      renderSkillsCognitionAssets();
      return;
    }

    const abilityAsset = event.target.closest('[data-ability-asset-id]');
    if (abilityAsset) {
      _skillsCognitionState.selectedAssetId = abilityAsset.dataset.abilityAssetId || '';
      renderSkillsCognitionAssets();
      return;
    }

    const openSkill = event.target.closest('[data-cognition-open-skill]');
    if (openSkill) {
      switchSkillsCognitionPage('skills');
      const skill = _skillsCache?.find((item) => item.id === openSkill.dataset.cognitionOpenSkill);
      if (skill) _showSkillsDetailView(skill.source, skill.id);
      return;
    }

    const openPersonalOntology = event.target.closest('[data-cognition-open-personal-ontology]');
    if (openPersonalOntology) {
      _setViewFromSidebar('personal-ontology');
      return;
    }

    const rollback = event.target.closest('[data-cognition-rollback-skill]');
    if (rollback) {
      try {
        await rollbackSkillCognitionVersionFromDetail(rollback.dataset.cognitionRollbackSkill, rollback.dataset.cognitionVersion);
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
      }
      return;
    }

    const recallAction = event.target.closest('[data-recall-candidate-action]');
    if (recallAction) {
      const candidateId = recallAction.dataset.recallCandidateId;
      const actionName = recallAction.dataset.recallCandidateAction;
      if (!candidateId || !actionName || recallAction.dataset.busy === '1') return;
      if (actionName === 'edit') { _skillsCognitionState.editingRecallCandidateId = candidateId; renderSkillsCognitionCandidates(); return; }
      if (actionName === 'cancel-edit') { _skillsCognitionState.editingRecallCandidateId = ''; renderSkillsCognitionCandidates(); return; }
      recallAction.dataset.busy = '1'; recallAction.disabled = true;
      try {
        let channel = actionName === 'promote' ? 'recall.candidates.promote' : actionName === 'reject' ? 'recall.candidates.reject' : actionName === 'defer' ? 'recall.candidates.defer' : actionName === 'resume' ? 'recall.candidates.resume' : '';
        let payload = { candidateId };
        if (actionName === 'save-edit') {
          const card = recallAction.closest('[data-recall-candidate-id]');
          const candidate = (_skillsCognitionState.recallCandidates || []).find((item) => item.id === candidateId);
          if (!card || !candidate) throw new Error('recall candidate unavailable');
          channel = 'recall.candidates.update';
          const evidenceText = card.querySelector('[data-recall-edit-evidence]')?.value || '';
          const sourceRefs = evidenceText.split(/[\n,]/).map((value) => value.trim()).filter(Boolean).map((value) => {
            const divider = value.indexOf(':');
            return divider > 0 ? { kind: value.slice(0, divider), id: value.slice(divider + 1) } : { kind: 'memory', id: value };
          });
          payload = { candidateId, judgment: card.querySelector('[data-recall-edit-judgment]')?.value || '', summary: card.querySelector('[data-recall-edit-summary]')?.value || '', suggestedScope: card.querySelector('[data-recall-edit-scope]')?.value || '', suggestedType: card.querySelector('[data-recall-edit-type]')?.value || '', sourceRefs };
        }
        if (!channel) return;
        const result = await window.orkas.invoke(channel, payload);
        if (!result?.ok) throw new Error(result?.error || 'recall candidate action failed');
        _skillsCognitionState.editingRecallCandidateId = '';
        await loadSkillsCognitionSnapshot();
      } catch (error) { if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error)); }
      finally { recallAction.dataset.busy = '0'; recallAction.disabled = false; }
      return;
    }

    const action = event.target.closest('[data-cognition-candidate-action]');
    if (!action) return;
    if (action.dataset.cognitionCandidateAction === 'open-personal-ontology') {
      _setViewFromSidebar('personal-ontology');
      return;
    }
    if (action.dataset.cognitionCandidateAction === 'source') return;
    if (action.dataset.cognitionCandidateAction === 'import-to-recall') {
      const candidateId = action.dataset.cognitionCandidateId;
      if (!candidateId || action.dataset.busy === '1') return;
      action.dataset.busy = '1'; action.disabled = true;
      try {
        const result = await window.orkas.invoke('recall.candidates.importPersonalOntology', { candidateId });
        if (!result?.ok) throw new Error(result?.error || 'personal ontology import failed');
        await loadSkillsCognitionSnapshot();
      } catch (error) { if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error)); }
      finally { action.dataset.busy = '0'; action.disabled = false; }
      return;
    }
    const source = action.dataset.cognitionCandidateSource;
    const candidateId = action.dataset.cognitionCandidateId;
    if (!source || !candidateId || action.dataset.busy === '1') return;
    action.dataset.busy = '1';
    action.disabled = true;
    try {
      const decision = action.dataset.cognitionCandidateAction === 'accept' ? 'accept' : 'reject';
      const result = await window.orkas.invoke('cognition.candidates.decide', {
        source,
        candidateId,
        decision,
      });
      if (!result?.ok) throw new Error(result?.error || 'candidate decision failed');
      await loadSkillsCognitionSnapshot();
    } catch (error) {
      if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
    } finally {
      action.dataset.busy = '0';
      action.disabled = false;
    }
  });

  window.addEventListener('i18n-change', () => {
    renderSkillsCognitionOverview();
    renderSkillsCognitionCandidates();
    renderSkillsCognitionReceipts();
    renderSkillsCognitionAssets();
  });

  initSkillsCognitionConsole();
}

_initSkillsCognitionBindings();
