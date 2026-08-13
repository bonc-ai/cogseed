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

  panel.addEventListener('input', (event) => {
    const search = event.target.closest('.asset-search');
    if (!search) return;
    _skillsCognitionState.assetSearchQuery = search.value || '';
    renderSkillsCognitionAssets();
    const next = document.querySelector('#skills-cognition-assets-body .asset-search');
    if (next) {
      next.focus();
      const end = next.value.length;
      if (typeof next.setSelectionRange === 'function') next.setSelectionRange(end, end);
    }
  });

  const cognitionTabs = document.getElementById('skills-cognition-tabs');
  cognitionTabs?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cognition-page]');
    if (!button) return;
    switchSkillsCognitionPage(button.dataset.cognitionPage || 'overview');
  });
  cognitionTabs?.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...cognitionTabs.querySelectorAll('[role="tab"]')];
    const currentIndex = tabs.indexOf(event.target.closest('[role="tab"]'));
    if (currentIndex < 0 || !tabs.length) return;
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[nextIndex].focus();
    switchSkillsCognitionPage(tabs[nextIndex].dataset.cognitionPage || 'overview');
  });

  const runSourceAction = async (control, actionName, kind, sourceId) => {
    if (!actionName || !kind || !sourceId || control.dataset.busy === '1') return;
    control.dataset.busy = '1'; control.disabled = true;
    try {
      if (actionName === 'remove') {
        const impactResult = await window.cogseed.invoke('recall.sources.removeImpact', { kind, sourceId });
        if (!impactResult?.ok) throw new Error(impactResult?.error || 'recall source impact failed');
        const affected = Number(impactResult.impact?.affectedAssetCount) || 0;
        const sourceName = control.closest('.recall-source-item')?.querySelector('.recall-source-item-main strong')?.textContent?.trim() || sourceId;
        const message = _cognitionText(
          'cognition.source_remove_message',
          '移除后不会删除原会话或原文件。请选择是否同时撤销由此来源形成的 Recall 记忆。\n\n来源：{name}\n关联记忆：{count} 条',
        ).replace('{name}', sourceName).replace('{count}', String(affected));
        const choice = typeof uiChoice === 'function' ? await uiChoice({
          title: _cognitionText('cognition.source_remove_title', '从 Recall 移除来源'),
          message,
          choices: [
            { id: 'keep_assets', label: _cognitionText('cognition.source_remove_keep_assets', '仅停止后续使用') },
            { id: 'revoke_assets', label: _cognitionText('cognition.source_remove_revoke_assets', '同时撤销关联记忆'), style: 'danger' },
          ],
        }) : (await uiConfirm(message) ? 'keep_assets' : null);
        if (!choice) return;
        const result = await window.cogseed.invoke('recall.sources.remove', {
          kind,
          sourceId,
          revokeAssets: choice === 'revoke_assets',
        });
        if (!result?.ok) throw new Error(result?.error || 'recall source removal failed');
        if (Array.isArray(result.result?.failedAssetIds) && result.result.failedAssetIds.length) {
          throw new Error(_cognitionText('cognition.source_remove_partial', '来源已移除，但部分关联记忆撤销失败，请重试'));
        }
        if (typeof uiToast === 'function') uiToast(_cognitionText('cognition.source_remove_done', '来源已从 Recall 移除'), { variant: 'success' });
      } else {
        const channels = {
          pause: 'recall.sources.pause',
          resume: 'recall.sources.resume',
          retry: 'recall.sources.retry',
          reconnect: 'recall.sources.reconnect',
        };
        const channel = channels[actionName];
        if (!channel) return;
        const result = await window.cogseed.invoke(channel, { kind, sourceId });
        if (!result?.ok) throw new Error(result?.error || 'recall source action failed');
      }
      await loadSkillsCognitionSnapshot();
    } catch (error) {
      if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
    } finally {
      control.dataset.busy = '0'; control.disabled = false;
    }
  };

  const runRecallAssetAction = async (control, actionName, assetId) => {
    if (!actionName || !assetId || control.dataset.busy === '1') return;
    control.dataset.busy = '1'; control.disabled = true;
    try {
      if (actionName === 'versions') {
        _skillsCognitionState.assetHistoryById ||= {};
        _skillsCognitionState.visibleAssetHistoryId = assetId;
        _skillsCognitionState.assetHistoryById[assetId] = { loading: true };
        renderSkillsCognitionAssets();
        const result = await window.cogseed.invoke('recall.assets.versions', { assetId });
        if (!result?.ok) throw new Error(result?.error || 'recall asset versions failed');
        _skillsCognitionState.assetHistoryById[assetId] = {
          loading: false,
          versions: result.versions || [],
          audit: result.audit || [],
        };
        renderSkillsCognitionAssets();
        return;
      }
      // 不可逆或有时限的动作必须先确认。归档与恢复不确认：它们随时可撤销，
      // 每一步都拦一下只会让用户养成闭眼点确认的习惯，真正危险的那次也就拦不住。
      const confirmations = {
        revoke: ['cognition.asset_revoke_confirm', '确认从 Recall 中移除这条记忆？原始会话和文件不会被删除。'],
        delete: ['cognition.asset_delete_confirm', '删除后进入保留期，期内可以恢复；保留期过后将无法找回。确认删除？'],
        purge: ['cognition.asset_purge_confirm', '彻底清除会删掉这条认知的内容和全部历史版本，且无法恢复。确认清除？'],
      };
      const confirmation = confirmations[actionName];
      if (confirmation) {
        const message = _cognitionText(confirmation[0], confirmation[1]);
        if (typeof uiConfirm !== 'function' || !(await uiConfirm(message))) return;
      }
      const channels = {
        pause: 'recall.assets.pause',
        resume: 'recall.assets.resume',
        revoke: 'recall.assets.revoke',
        archive: 'recall.assets.archive',
        restore: 'recall.assets.restore',
        delete: 'recall.assets.delete',
        purge: 'recall.assets.purge',
      };
      const channel = channels[actionName];
      if (!channel) return;
      const result = await window.cogseed.invoke(channel, { assetId });
      if (!result?.ok) throw new Error(result?.error || 'recall asset action failed');
      await loadSkillsCognitionSnapshot();
      if (typeof uiToast === 'function') {
        const done = {
          pause: '已暂停使用', resume: '已恢复使用', revoke: '已移除',
          archive: '已归档', restore: '已恢复', delete: '已删除，保留期内可恢复',
          purge: '已彻底清除',
        };
        uiToast(_cognitionText(`cognition.asset_action_${actionName}_done`, done[actionName] || '已完成'), { variant: 'success' });
      }
    } catch (error) {
      _skillsCognitionState.assetHistoryById ||= {};
      if (actionName === 'versions') {
        _skillsCognitionState.assetHistoryById[assetId] = { loading: false, error: (error && error.message) || String(error) };
        renderSkillsCognitionAssets();
      }
      if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
    } finally {
      control.dataset.busy = '0'; control.disabled = false;
    }
  };

  const runRecallAssetRollback = async (control, assetId, version) => {
    if (!assetId || !version || control.dataset.busy === '1') return;
    control.dataset.busy = '1'; control.disabled = true;
    try {
      const result = await window.cogseed.invoke('recall.assets.rollback', { assetId, version });
      if (!result?.ok) throw new Error(result?.error || 'recall asset rollback failed');
      await loadSkillsCognitionSnapshot();
      if (typeof uiToast === 'function') {
        uiToast(_cognitionText('cognition.asset_action_rollback_done', '已回滚到所选版本'), { variant: 'success' });
      }
    } catch (error) {
      if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
    } finally {
      control.dataset.busy = '0'; control.disabled = false;
    }
  };

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
      switchSkillsCognitionPage(pageLink.dataset.cognitionPageLink || 'overview');
      return;
    }

    const sourceAction = event.target.closest('[data-cognition-source-action]');
    if (sourceAction) {
      const actionName = sourceAction.dataset.cognitionSourceAction || '';
      const kind = sourceAction.dataset.cognitionSourceKind || '';
      const sourceId = sourceAction.dataset.cognitionSourceId || '';
      await runSourceAction(sourceAction, actionName, kind, sourceId);
      return;
    }

    const sourceMore = event.target.closest('[data-cognition-source-more]');
    if (sourceMore) {
      const kind = sourceMore.dataset.cognitionSourceKind || '';
      const sourceId = sourceMore.dataset.cognitionSourceId || '';
      const actions = String(sourceMore.dataset.cognitionSourceActions || '').split(',').filter(Boolean);
      if (!kind || !sourceId || !actions.length || typeof showContextMenu !== 'function') return;
      const rect = sourceMore.getBoundingClientRect();
      showContextMenu({
        clientX: event.clientX || rect.right,
        clientY: event.clientY || rect.bottom,
      }, actions.map((actionName) => ({
        label: _cognitionSourceActionLabel(actionName),
        icon: actionName === 'remove' ? 'trash-2' : 'pause',
        onClick: () => { void runSourceAction(sourceMore, actionName, kind, sourceId); },
      })));
      return;
    }

    const assetMore = event.target.closest('[data-recall-asset-more]');
    if (assetMore) {
      const assetId = assetMore.dataset.recallAssetMore || '';
      const actions = String(assetMore.dataset.recallAssetActions || '').split(',').filter(Boolean);
      if (!assetId || !actions.length || typeof showContextMenu !== 'function') return;
      const rect = assetMore.getBoundingClientRect();
      showContextMenu({
        clientX: event.clientX || rect.right,
        clientY: event.clientY || rect.bottom,
      }, actions.map((actionName) => ({
        label: _recallAssetActionLabel(actionName),
        icon: ({
          pause: 'pause', resume: 'play', archive: 'archive', restore: 'rotate-ccw',
          delete: 'trash-2', purge: 'trash-2', revoke: 'trash-2', versions: 'history',
        })[actionName] || 'pause',
        onClick: () => runRecallAssetAction(assetMore, actionName, assetId),
      })));
      return;
    }

    const assetRollback = event.target.closest('[data-recall-asset-rollback]');
    if (assetRollback) {
      const assetId = assetRollback.dataset.recallAssetRollback || '';
      const version = assetRollback.dataset.recallAssetVersion || '';
      if (assetId && version) await runRecallAssetRollback(assetRollback, assetId, version);
      return;
    }

    if (event.target.closest('[data-recall-asset-history-close]')) {
      _skillsCognitionState.visibleAssetHistoryId = '';
      renderSkillsCognitionAssets();
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

    const openAsset = event.target.closest('[data-cognition-open-asset]');
    if (openAsset) {
      _skillsCognitionState.selectedAssetId = openAsset.dataset.cognitionOpenAsset || '';
      switchSkillsCognitionPage('assets');
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

    const captureSettingsToggle = event.target.closest('[data-recall-capture-settings-toggle]');
    if (captureSettingsToggle) {
      _skillsCognitionState.captureSettingsExpanded = !_skillsCognitionState.captureSettingsExpanded;
      renderSkillsCognitionCaptures();
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

    const manualAdd = event.target.closest('[data-recall-manual-add]');
    if (manualAdd) {
      const conversationId = manualAdd.dataset.recallManualAdd || '';
      if (!conversationId || manualAdd.dataset.busy === '1') return;
      manualAdd.dataset.busy = '1'; manualAdd.disabled = true;
      try {
        const result = await window.cogseed.invoke('recall.captures.manualCreate', { conversationId });
        if (!result?.ok) throw new Error(result?.error || _cognitionText('cognition.capture_manual_history_create_failed', '加入沉淀任务失败'));
        _skillsCognitionState.captureFilter = 'all';
        _skillsCognitionState.captureNextCursor = null;
        _skillsCognitionState.selectedCaptureId = '';
        await loadRecallCaptureTasks();
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
        renderSkillsCognitionCaptures();
      } finally {
        manualAdd.dataset.busy = '0'; manualAdd.disabled = false;
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

    const reviewPolicy = event.target.closest('[data-recall-review-policy]');
    if (reviewPolicy) {
      const policy = reviewPolicy.dataset.recallReviewPolicy;
      if (!['auto', 'manual'].includes(policy) || reviewPolicy.dataset.busy === '1') return;
      reviewPolicy.dataset.busy = '1'; reviewPolicy.disabled = true;
      try { await updateRecallCaptureSettings({ reviewPolicy: policy }); }
      catch (error) { if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error)); }
      finally { reviewPolicy.dataset.busy = '0'; reviewPolicy.disabled = false; }
      return;
    }

    const captureAction = event.target.closest('[data-recall-capture-action]');
    if (captureAction) {
      const captureId = captureAction.dataset.recallCaptureId;
      const actionName = captureAction.dataset.recallCaptureAction;
      if (!captureId || !actionName || captureAction.dataset.busy === '1') return;
      const visibleCaptures = [...(_skillsCognitionState.captures || []), ...(_skillsCognitionState.recentCaptures || [])];
      const capture = visibleCaptures.find((item) => item.id === captureId);
      if (actionName === 'open-conversation') {
        if (capture?.conversationId && typeof setView === 'function') setView('conversation', capture.conversationId);
        return;
      }
      if (actionName === 'view-candidates') {
        switchSkillsCognitionPage('captures');
        setTimeout(() => document.getElementById('skills-cognition-capture-review-body')?.scrollIntoView({ block: 'start' }), 0);
        return;
      }
      if (actionName === 'view-assets') {
        _skillsCognitionState.selectedAssetId = capture?.linkedAssetIds?.[0] || '';
        _skillsCognitionState.assetCategoryFilter = '';
        switchSkillsCognitionPage('assets');
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
        const result = await window.cogseed.invoke(channel, { captureId });
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
        const result = await window.cogseed.invoke('recall.captures.retry', { captureId });
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
        const result = await window.cogseed.invoke('recall.teaching.revoke', { signalId });
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

    const openCandidate = event.target.closest('[data-cognition-open-candidate]');
    if (openCandidate) {
      switchSkillsCognitionPage('captures');
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

    const abilityAssetAction = event.target.closest('[data-ability-asset-action]');
    if (abilityAssetAction) {
      const assetId = abilityAssetAction.dataset.abilityAssetId;
      const action = abilityAssetAction.dataset.abilityAssetAction;
      if (!assetId || !action || abilityAssetAction.dataset.busy === '1') return;
      const selected = (_skillsCognitionState.assets || []).find((item) => item.id === assetId);
      const defaultReason = selected?.recommendationReason || selected?.scopePolicy?.purposeTags?.join(', ') || '';
      const promptLabel = action === 'acknowledge-recommendation'
        ? '请输入确认建议的原因：'
        : action === 'pause'
          ? '请输入暂停原因：'
          : action === 'resume'
            ? '请输入恢复原因：'
            : '请输入撤销原因：';
      const reason = typeof uiPrompt === 'function'
        ? await uiPrompt(promptLabel, defaultReason)
        : window.prompt(promptLabel, defaultReason);
      if (reason === null) return;
      const trimmed = String(reason || '').trim();
      if (!trimmed) return;
      abilityAssetAction.dataset.busy = '1'; abilityAssetAction.disabled = true;
      try {
        const channel = action === 'pause' ? 'recall.assets.pause'
          : action === 'resume' ? 'recall.assets.resume'
          : action === 'revoke' ? 'recall.assets.revoke'
          : 'recall.assets.update';
        const payload = action === 'acknowledge-recommendation'
          ? { assetId, reason: trimmed, acknowledgeRecommendation: true }
          : { assetId, note: trimmed };
        const result = await window.orkas.invoke(channel, payload);
        if (!result?.ok) throw new Error(result?.error || 'recall asset governance action failed');
        await loadSkillsCognitionSnapshot();
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
      } finally {
        abilityAssetAction.dataset.busy = '0'; abilityAssetAction.disabled = false;
      }
      return;
    }

    const abilityAsset = event.target.closest('[data-ability-asset-id]');
    if (abilityAsset) {
      _skillsCognitionState.selectedAssetId = abilityAsset.dataset.abilityAssetId || '';
      renderSkillsCognitionAssets();
      return;
    }

    const configureSkillModel = event.target.closest('[data-recall-skill-configure]');
    if (configureSkillModel) {
      openRecallSkillModelSettings();
      return;
    }

    const importSkill = event.target.closest('[data-recall-skill-import]');
    if (importSkill) {
      const assetId = importSkill.dataset.recallSkillImport || '';
      if (!assetId || importSkill.dataset.busy === '1') return;
      importSkill.dataset.busy = '1'; importSkill.disabled = true;
      const idleLabel = importSkill.textContent;
      importSkill.textContent = _cognitionText('cognition.skill_importing', '正在加入…');
      try { await importRecallSkillFromAsset(assetId); }
      catch (error) { if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error)); }
      finally { importSkill.dataset.busy = '0'; importSkill.disabled = false; importSkill.textContent = idleLabel; }
      return;
    }

    const generateSkill = event.target.closest('[data-recall-skill-generate]');
    if (generateSkill) {
      const assetId = generateSkill.dataset.recallSkillGenerate || '';
      if (!assetId || generateSkill.dataset.busy === '1') return;
      generateSkill.dataset.busy = '1'; generateSkill.disabled = true;
      const idleLabel = generateSkill.textContent;
      generateSkill.textContent = _cognitionText('cognition.skill_draft_generating', '正在生成…');
      try { await generateRecallSkillFromAsset(assetId); }
      catch (error) { if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error)); }
      finally { generateSkill.dataset.busy = '0'; generateSkill.disabled = false; generateSkill.textContent = idleLabel; }
      return;
    }

    const openSkill = event.target.closest('[data-cognition-open-skill]');
    if (openSkill) {
      const skillId = openSkill.dataset.cognitionOpenSkill || '';
      if (!skillId) return;
      _setViewFromSidebar('skills');
      try {
        await _showSkillsDetailView('custom', skillId, { expandSource: false });
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
      }
      return;
    }

    const promoteAll = event.target.closest('[data-recall-candidate-promote-all]');
    if (promoteAll) {
      if (promoteAll.dataset.busy === '1' || _skillsCognitionState.writingRecallCandidateBatch) return;
      const selectedCapture = (_skillsCognitionState.captures || [])
        .find((capture) => capture.id === _skillsCognitionState.selectedCaptureId);
      const selectedIds = selectedCapture ? new Set(selectedCapture.candidateIds || []) : null;
      const candidateIds = (_skillsCognitionState.recallCandidates || [])
        .filter((candidate) => (candidate.status === 'pending' || candidate.status === 'deferred')
          && (!selectedIds || selectedIds.has(candidate.id)))
        .map((candidate) => candidate.id);
      if (!candidateIds.length) return;
      promoteAll.dataset.busy = '1'; promoteAll.disabled = true;
      _skillsCognitionState.writingRecallCandidateBatch = true;
      const failures = [];
      try {
        for (const candidateId of candidateIds) {
          _skillsCognitionState.writingRecallCandidateId = candidateId;
          renderSkillsCognitionCaptures();
          try {
            const result = await window.cogseed.invoke('recall.candidates.promote', { candidateId });
            if (!result?.ok) throw new Error(result?.error || 'recall candidate action failed');
            if (result.candidate) {
              _skillsCognitionState.recallCandidates = (_skillsCognitionState.recallCandidates || [])
                .map((candidate) => candidate.id === candidateId ? result.candidate : candidate);
            }
            if (result.asset) {
              const assets = new Map((_skillsCognitionState.assets || []).map((asset) => [asset.id, asset]));
              assets.set(result.asset.id, result.asset);
              _skillsCognitionState.assets = Array.from(assets.values());
            }
          } catch (error) {
            failures.push({ candidateId, error });
          }
        }
        await loadSkillsCognitionSnapshot().catch(() => {});
        if (failures.length) {
          const message = _cognitionText(
            'cognition.capture_save_all_partial',
            '已保存 {success} 条，{failed} 条失败；失败内容已保留，可单独重试。',
          ).replace('{success}', String(candidateIds.length - failures.length)).replace('{failed}', String(failures.length));
          if (typeof uiAlert === 'function') await uiAlert(message);
        } else if (typeof uiToast === 'function') {
          uiToast(_cognitionText('cognition.capture_save_all_done', '已全部写入 Recall'), { variant: 'success' });
        }
      } finally {
        _skillsCognitionState.writingRecallCandidateId = '';
        _skillsCognitionState.writingRecallCandidateBatch = false;
        promoteAll.dataset.busy = '0'; promoteAll.disabled = false;
        renderSkillsCognitionCaptures();
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
        if (actionName === 'save-and-promote') {
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
        if (actionName === 'promote' || actionName === 'save-and-promote') {
          _skillsCognitionState.writingRecallCandidateId = candidateId;
          renderSkillsCognitionCaptures();
          renderSkillsCognitionCandidates();
        }
        const result = await window.cogseed.invoke(channel, payload);
        if (!result?.ok) throw new Error(result?.error || 'recall candidate action failed');
        if (actionName === 'save-and-promote') {
          const promoted = await window.cogseed.invoke('recall.candidates.promote', { candidateId });
          if (!promoted?.ok) throw new Error(promoted?.error || 'recall candidate action failed');
        }
        _skillsCognitionState.editingRecallCandidateId = '';
        _skillsCognitionState.writingRecallCandidateId = '';
        await loadSkillsCognitionSnapshot();
      } catch (error) {
        if (actionName === 'promote' || actionName === 'save-and-promote') await loadSkillsCognitionSnapshot().catch(() => {});
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
      }
      finally {
        _skillsCognitionState.writingRecallCandidateId = '';
        recallAction.dataset.busy = '0'; recallAction.disabled = false;
      }
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
        const result = await window.cogseed.invoke('recall.candidates.importPersonalOntology', { candidateId });
        if (!result?.ok) throw new Error(result?.error || 'personal ontology import failed');
        await loadSkillsCognitionSnapshot();
      } catch (error) { if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error)); }
      finally { action.dataset.busy = '0'; action.disabled = false; }
      return;
    }
    const source = action.dataset.cognitionCandidateSource;
    const candidateId = action.dataset.cognitionCandidateId;
    if (!source || !candidateId || action.dataset.busy === '1') return;
    // Deep review is a read-only probe: it runs both gate layers and reports,
    // without deciding the candidate. Model failure is reported as
    // "unavailable" rather than as a clean pass.
    if (action.dataset.cognitionCandidateAction === 'deep-review') {
      action.dataset.busy = '1'; action.disabled = true;
      try {
        const res = await window.orkas.invoke('cognition.candidates.deepReview', { source, candidateId });
        if (!res?.ok) throw new Error(res?.error || 'deep review failed');
        const r = res.review || {};
        const lines = [
          `${_cognitionText('cognition.security', '安全检查')}: ${r.status || 'unknown'}`,
          `${_cognitionText('cognition.findings', '发现')}: ${r.findingCount || 0}`,
        ];
        if (r.topRule) lines.push(r.topRule);
        if (r.degradedReason) lines.push(_cognitionText('cognition.security_degraded', '深度审查不可用'));
        if (typeof uiAlert === 'function') await uiAlert(lines.join('\n'));
        await loadSkillsCognitionSnapshot();
      } catch (error) { if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error)); }
      finally { action.dataset.busy = '0'; action.disabled = false; }
      return;
    }
    const decided = action.dataset.cognitionCandidateAction;
    // 四决定（PRD §5.6）：accept / modify / defer / reject；其余动作已在前面分支处理。
    if (decided !== 'accept' && decided !== 'modify' && decided !== 'defer' && decided !== 'reject') return;
    action.dataset.busy = '1';
    action.disabled = true;
    try {
      const result = await window.cogseed.invoke('cognition.candidates.decide', {
        source,
        candidateId,
        decision: decided,
      });
      // A gate block is an expected outcome with structured findings, not a
      // generic failure — explain what was found rather than showing the raw
      // error string. The block itself is not user-overridable.
      if (result && result.ok === false && result.code === 'cognition_gate_blocked') {
        const findings = (result.gate && result.gate.findings) || [];
        const lines = findings.slice(0, 5).map((f) => `· ${f.rule}${f.field ? ` (${f.field})` : ''}`);
        const title = (typeof t === 'function' ? t('cognition.gate_blocked_title') : '') || '';
        const header = title && title !== 'cognition.gate_blocked_title'
          ? title
          : '该候选未通过安全检查，无法保存为正式资产';
        if (typeof uiAlert === 'function') await uiAlert([header, ...lines].join('\n'));
        await loadSkillsCognitionSnapshot();
        return;
      }
      if (!result?.ok) throw new Error(result?.error || 'candidate decision failed');
      await loadSkillsCognitionSnapshot();
    } catch (error) {
      if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
    } finally {
      action.dataset.busy = '0';
      action.disabled = false;
    }
  });

  panel.addEventListener('change', async (event) => {
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
    renderSkillsCognitionSources();
    renderSkillsCognitionCaptures();
    renderSkillsCognitionCandidates();
    renderSkillsCognitionAssets();
  });

}

_initSkillsCognitionBindings();
