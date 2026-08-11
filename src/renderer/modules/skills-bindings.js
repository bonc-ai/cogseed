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
  const panel = document.getElementById('panel-recall');
  if (!panel || panel.dataset.cognitionBindings === '1') return;
  panel.dataset.cognitionBindings = '1';

  document.getElementById('skills-cognition-tabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cognition-page]');
    if (!button) return;
    openRecallTarget(button.dataset.cognitionPage || 'overview');
  });

  document.getElementById('skills-cognition-deposition-tabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cognition-deposition-view]');
    if (!button) return;
    _skillsCognitionState.depositionView = button.dataset.cognitionDepositionView || 'candidates';
    renderSkillsCognitionDeposition();
  });

  document.getElementById('ability-assets-tabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-ability-assets-view]');
    if (!button) return;
    const view = button.dataset.abilityAssetsView === 'tree' ? 'tree' : 'list';
    _skillsCognitionState.assetSubview = view;
    document.querySelectorAll('[data-ability-assets-view]').forEach((el) => el.classList.toggle('is-active', el === button));
    renderSkillsCognitionAssets();
  });

  panel.addEventListener('click', async (event) => {
    const reload = event.target.closest('[data-cognition-reload]');
    if (reload) {
      if (reload.dataset.busy === '1') return;
      reload.dataset.busy = '1'; reload.disabled = true;
      try {
        await loadSkillsCognitionSnapshot();
      } finally {
        reload.dataset.busy = '0'; reload.disabled = false;
      }
      return;
    }

    const pageLink = event.target.closest('[data-cognition-page-link]');
    if (pageLink) {
      openRecallTarget(pageLink.dataset.cognitionPageLink || 'overview', {
        depositionView: pageLink.dataset.cognitionDepositionTarget,
        assetSubview: pageLink.dataset.cognitionAssetSubview,
        category: pageLink.dataset.cognitionAssetCategory,
      });
      return;
    }

    const category = event.target.closest('[data-cognition-candidate-category]');
    if (category) {
      _skillsCognitionState.candidateCategoryFilter = category.dataset.cognitionCandidateCategory || '';
      renderSkillsCognitionCandidates();
      return;
    }

    const sourceConversation = event.target.closest('[data-cognition-source-conversation]');
    if (sourceConversation) {
      const conversationId = sourceConversation.dataset.cognitionSourceConversation;
      if (conversationId && typeof setView === 'function') setView('conversation', conversationId);
      return;
    }

    if (event.target.closest('[data-cognition-open-connectors]')) {
      _setViewFromSidebar('connectors');
      return;
    }

    const contextSelect = event.target.closest('[data-recall-context-select]');
    if (contextSelect) {
      _skillsCognitionState.selectedContextKey = contextSelect.dataset.recallContextSelect || '';
      renderSkillsCognitionContext();
      return;
    }

    const ontologyGroup = event.target.closest('[data-recall-ontology-group]');
    if (ontologyGroup) {
      const groupId = ontologyGroup.dataset.recallOntologyGroup || '';
      if (!groupId || ontologyGroup.dataset.busy === '1') return;
      _skillsCognitionState.selectedOntologyGroupId = groupId;
      ontologyGroup.dataset.busy = '1'; ontologyGroup.disabled = true;
      try { await loadRecallOntologyGroup(groupId); }
      catch (error) { if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error)); }
      finally { ontologyGroup.dataset.busy = '0'; ontologyGroup.disabled = false; renderSkillsCognitionOntology(); }
      return;
    }

    const openAsset = event.target.closest('[data-cognition-open-asset]');
    if (openAsset) {
      _skillsCognitionState.selectedAssetId = openAsset.dataset.cognitionOpenAsset || '';
      openRecallTarget('assets');
      return;
    }

    const captureFilter = event.target.closest('[data-recall-capture-filter]');
    if (captureFilter) {
      const filter = captureFilter.dataset.recallCaptureFilter || 'all';
      if (!_CAPTURE_FILTERS.includes(filter) || filter === _skillsCognitionState.captureFilter) return;
      _skillsCognitionState.captureFilter = filter;
      _skillsCognitionState.captureNextCursor = null;
      _skillsCognitionState.selectedCaptureId = '';
      try { await loadRecallCaptureTasks(); }
      catch (error) { if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error)); }
      return;
    }

    const captureSelect = event.target.closest('[data-recall-capture-select]');
    if (captureSelect) {
      const captureId = captureSelect.dataset.recallCaptureSelect || '';
      _skillsCognitionState.selectedCaptureId = _skillsCognitionState.selectedCaptureId === captureId ? '' : captureId;
      renderSkillsCognitionCaptures();
      return;
    }

    const captureLoadMore = event.target.closest('[data-recall-capture-load-more]');
    if (captureLoadMore) {
      if (captureLoadMore.dataset.busy === '1') return;
      captureLoadMore.dataset.busy = '1'; captureLoadMore.disabled = true;
      try { await loadRecallCaptureTasks({ append: true }); }
      catch (error) { if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error)); }
      finally { captureLoadMore.dataset.busy = '0'; captureLoadMore.disabled = false; }
      return;
    }

    const manualCreate = event.target.closest('[data-recall-manual-create]');
    if (manualCreate) {
      const conversationIds = Array.isArray(_skillsCognitionState.selectedHistoricalConversationIds)
        ? [..._skillsCognitionState.selectedHistoricalConversationIds]
        : [];
      if (!conversationIds.length || manualCreate.dataset.busy === '1') return;
      manualCreate.dataset.busy = '1'; manualCreate.disabled = true;
      const created = [];
      try {
        for (const conversationId of conversationIds) {
          const result = await window.orkas.invoke('recall.captures.manualCreate', { conversationId });
          if (!result?.ok) throw new Error(result?.error || _cognitionText('cognition.capture_manual_history_create_failed', '加入沉淀任务失败'));
          created.push(conversationId);
        }
        _skillsCognitionState.selectedHistoricalConversationIds = [];
        _skillsCognitionState.captureFilter = 'all';
        _skillsCognitionState.captureNextCursor = null;
        _skillsCognitionState.selectedCaptureId = '';
        await loadRecallCaptureTasks();
      } catch (error) {
        _skillsCognitionState.selectedHistoricalConversationIds = conversationIds.filter((id) => !created.includes(id));
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
        renderSkillsCognitionCaptures();
      } finally {
        manualCreate.dataset.busy = '0'; manualCreate.disabled = false;
      }
      return;
    }

    const capturePolicy = event.target.closest('[data-recall-capture-policy]');
    if (capturePolicy) {
      const executionPolicy = capturePolicy.dataset.recallCapturePolicy;
      if (!['smart', 'nightly', 'manual'].includes(executionPolicy) || capturePolicy.dataset.busy === '1') return;
      capturePolicy.dataset.busy = '1'; capturePolicy.disabled = true;
      try { await updateRecallCaptureSettings({ executionPolicy }); }
      catch (error) { if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error)); }
      finally { capturePolicy.dataset.busy = '0'; capturePolicy.disabled = false; }
      return;
    }

    const captureAction = event.target.closest('[data-recall-capture-action]');
    if (captureAction) {
      const captureId = captureAction.dataset.recallCaptureId;
      const actionName = captureAction.dataset.recallCaptureAction;
      if (!captureId || !actionName || captureAction.dataset.busy === '1') return;
      if (actionName === 'open-conversation') {
        const capture = (_skillsCognitionState.captures || []).find((item) => item.id === captureId);
        if (capture?.conversationId && typeof setView === 'function') setView('conversation', capture.conversationId);
        return;
      }
      if (actionName === 'view-candidates') {
        openRecallTarget('candidates');
        return;
      }
      if (actionName === 'cancel' && typeof uiConfirm === 'function') {
        const confirmed = await uiConfirm(_cognitionText('cognition.capture_cancel_confirm', '确认取消这个沉淀任务？'));
        if (!confirmed) return;
      }
      const channels = {
        pause: 'recall.captures.pause',
        resume: 'recall.captures.resume',
        cancel: 'recall.captures.cancel',
        retry: 'recall.captures.retry',
        'run-now': 'recall.captures.runNow',
      };
      const channel = channels[actionName];
      if (!channel) return;
      captureAction.dataset.busy = '1'; captureAction.disabled = true;
      try {
        const result = await window.orkas.invoke(channel, { captureId });
        if (!result?.ok) throw new Error(result?.error || 'recall capture action failed');
        await loadRecallCaptureTasks();
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
      } finally {
        captureAction.dataset.busy = '0'; captureAction.disabled = false;
      }
      return;
    }

    const retryCapture = event.target.closest('[data-recall-capture-retry]');
    if (retryCapture) {
      const captureId = retryCapture.dataset.recallCaptureRetry;
      if (!captureId || retryCapture.dataset.busy === '1') return;
      retryCapture.dataset.busy = '1'; retryCapture.disabled = true;
      try {
        const result = await window.orkas.invoke('recall.captures.retry', { captureId });
        if (!result?.ok) throw new Error(result?.error || 'recall capture retry failed');
        await loadSkillsCognitionSnapshot();
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
      } finally {
        retryCapture.dataset.busy = '0'; retryCapture.disabled = false;
      }
      return;
    }

    const revokeTeaching = event.target.closest('[data-recall-teaching-revoke]');
    if (revokeTeaching) {
      const signalId = revokeTeaching.dataset.recallTeachingRevoke;
      if (!signalId || revokeTeaching.dataset.busy === '1') return;
      revokeTeaching.dataset.busy = '1'; revokeTeaching.disabled = true;
      try {
        const result = await window.orkas.invoke('recall.teaching.revoke', { signalId });
        if (!result?.ok) throw new Error(result?.error || 'teaching signal revoke failed');
        await loadSkillsCognitionSnapshot();
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
      } finally {
        revokeTeaching.dataset.busy = '0'; revokeTeaching.disabled = false;
      }
      return;
    }

    const configureCapture = event.target.closest('[data-recall-capture-settings]');
    if (configureCapture) {
      _setViewFromSidebar('settings');
      if (typeof window.activateSettingsTab === 'function') window.activateSettingsTab('credentials');
      setTimeout(() => document.getElementById('settings-model-authorizations')?.scrollIntoView({ block: 'start' }), 0);
      return;
    }

    const openReceipt = event.target.closest('[data-cognition-open-receipt]');
    if (openReceipt) {
      await openSkillsCognitionReceiptDetail(openReceipt.dataset.cognitionOpenReceipt);
      return;
    }

    const openReuse = event.target.closest('[data-cognition-open-reuse]');
    if (openReuse) {
      const assetId = openReuse.dataset.cognitionOpenReuse || '';
      const asset = (_skillsCognitionState.assets || []).find((item) => item.id === assetId);
      const receiptIds = new Set(Array.isArray(asset?.receiptRefs) ? asset.receiptRefs : []);
      const receipt = (_skillsCognitionState.receipts || []).find((item) => receiptIds.has(item.executionId) || receiptIds.has(item.receiptId) || (Array.isArray(item.reusedRefs) && item.reusedRefs.includes(assetId)));
      const receiptId = receipt?.executionId || receipt?.receiptId || '';
      if (receiptId) await openSkillsCognitionReceiptDetail(receiptId);
      else renderSkillsCognitionAssets();
      setTimeout(() => document.querySelector?.('.ability-asset-reuse-summary')?.scrollIntoView({ block: 'start' }), 0);
      return;
    }

    const openCandidate = event.target.closest('[data-cognition-open-candidate]');
    if (openCandidate) {
      openRecallTarget('candidates');
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
      _setViewFromSidebar('skills');
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

      // Notify interactive tour that user has reviewed a cognition
      if (typeof window.interactiveTour !== 'undefined' && window.interactiveTour.markRecallReviewed) {
        window.interactiveTour.markRecallReviewed();
      }
    } catch (error) {
      if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
    } finally {
      action.dataset.busy = '0';
      action.disabled = false;
    }
  });

  panel.addEventListener('change', async (event) => {
    const manualConversation = event.target.closest('[data-recall-manual-conversation]');
    if (manualConversation) {
      const conversationId = manualConversation.dataset.recallManualConversation;
      const selected = new Set(Array.isArray(_skillsCognitionState.selectedHistoricalConversationIds)
        ? _skillsCognitionState.selectedHistoricalConversationIds
        : []);
      if (conversationId) {
        if (manualConversation.checked) selected.add(conversationId);
        else selected.delete(conversationId);
      }
      _skillsCognitionState.selectedHistoricalConversationIds = Array.from(selected);
      renderSkillsCognitionCaptures();
      return;
    }
    const enabled = event.target.closest('[data-recall-capture-enabled]');
    const catchUp = event.target.closest('[data-recall-capture-catch-up]');
    const quietMinutes = event.target.closest('[data-recall-capture-quiet-minutes]');
    const nightStart = event.target.closest('[data-recall-capture-night-start]');
    const nightEnd = event.target.closest('[data-recall-capture-night-end]');
    let patch = null;
    if (enabled) patch = { enabled: !!enabled.checked };
    else if (catchUp) patch = { catchUpMissed: !!catchUp.checked };
    else if (quietMinutes) patch = { quietMinutes: Number(quietMinutes.value) };
    else if (nightStart) patch = { nightlyStart: nightStart.value };
    else if (nightEnd) patch = { nightlyEnd: nightEnd.value };
    if (!patch || event.target.dataset.busy === '1') return;
    event.target.dataset.busy = '1'; event.target.disabled = true;
    try { await updateRecallCaptureSettings(patch); }
    catch (error) {
      if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
      await loadSkillsCognitionSnapshot();
    } finally {
      event.target.dataset.busy = '0'; event.target.disabled = false;
    }
  });

  window.addEventListener('i18n-change', () => {
    renderSkillsCognitionOverview();
    renderSkillsCognitionDeposition();
    renderSkillsCognitionBrain();
    renderSkillsCognitionContext();
    renderSkillsCognitionOntology();
    renderSkillsCognitionReceipts();
    renderSkillsCognitionAssets();
  });

}

_initSkillsCognitionBindings();
