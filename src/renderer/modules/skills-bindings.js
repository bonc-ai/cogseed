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
    // 技能库现在挂在连接页「技能」tab：仅当该 pane 可见时处理 Esc 返回。
    const skillsPane = document.getElementById('connections-pane-skills');
    if (!skillsPane || skillsPane.hidden) return;
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

function _recallCaptureErrorMessage(error) {
  const raw = String(error && error.message ? error.message : error || '').trim();
  const messages = {
    'conversation has no completed exchange': [
      'cognition.capture_error_no_completed_exchange',
      '当前会话还没有完成一轮问答，暂时无法沉淀。',
    ],
    'conversation is still waiting for a response': [
      'cognition.capture_error_waiting_response',
      '当前会话仍在等待回复，完成后才能沉淀。',
    ],
    'recall capture is disabled': [
      'cognition.capture_error_disabled',
      '沉淀功能已关闭，请先在沉淀设置中开启。',
    ],
    'conversation not found': [
      'cognition.capture_error_conversation_not_found',
      '找不到这个会话，暂时无法沉淀。',
    ],
  };
  const localized = messages[raw];
  if (localized) return _cognitionText(localized[0], localized[1]);
  return raw || _cognitionText('cognition.capture_error_unknown', '沉淀任务发生未知错误');
}

function _initSkillsCognitionBindings() {
  const panel = document.getElementById('panel-recall');
  if (!panel || panel.dataset.cognitionBindings === '1') return;
  panel.dataset.cognitionBindings = '1';

  const refreshPersonalOntologyAfterPromotion = async () => {
    if (typeof window.refreshPersonalOntology !== 'function') return true;
    try {
      await window.refreshPersonalOntology();
      return true;
    } catch (error) {
      if (typeof _skillsLog !== 'undefined' && typeof _skillsLog.warn === 'function') {
        _skillsLog.warn('Personal ontology projection refresh deferred', error);
      }
      const message = _cognitionText(
        'personalOntology.profile_sync_warning',
        '资产已保存，个人画像自动更新未完成，稍后可重试。',
      );
      try {
        if (typeof uiToast === 'function') uiToast(message, { variant: 'warning' });
        else if (typeof uiAlert === 'function') await uiAlert(message);
      } catch (_) {
        // The formal asset is already persisted; feedback failure must not turn it into a save error.
      }
      return false;
    }
  };

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
  const cognitionMain = document.getElementById('skills-cognition-main');
  // Chromium normally chains a wheel gesture from an inner scroll box to its
  // parent. Electron can stop that chain when the inner box reaches an edge,
  // leaving the whole Recall window apparently stuck. Find scrollable
  // ancestors dynamically so every nested workbench gets the same handoff.
  panel.addEventListener('wheel', (event) => {
    if (!cognitionMain || event.defaultPrevented || event.ctrlKey || !event.deltaY) return;

    const canScroll = (element) => {
      if (!element || element === cognitionMain) return false;
      const style = typeof window.getComputedStyle === 'function'
        ? window.getComputedStyle(element)
        : null;
      const overflowY = style?.overflowY || element.style?.overflowY || '';
      return /^(auto|scroll|overlay)$/.test(overflowY)
        && element.scrollHeight > element.clientHeight + 1;
    };
    const canConsume = (element) => {
      const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      return event.deltaY < 0
        ? element.scrollTop > 0
        : element.scrollTop < maxScrollTop - 1;
    };

    let target = event.target;
    if (target && target.nodeType !== 1) target = target.parentElement;
    while (target && target !== cognitionMain && target !== panel) {
      if (canScroll(target) && canConsume(target)) return;
      target = target.parentElement;
    }

    const maxMainScrollTop = Math.max(0, cognitionMain.scrollHeight - cognitionMain.clientHeight);
    if (!maxMainScrollTop) return;
    const next = Math.max(0, Math.min(maxMainScrollTop, cognitionMain.scrollTop + event.deltaY));
    if (next === cognitionMain.scrollTop) return;
    cognitionMain.scrollTop = next;
    event.preventDefault();
  }, { capture: true, passive: false });
  // tab 条与页头辅助入口（管理来源 / 沉淀活动）用同一套切换逻辑：辅助入口
  // 打开的仍是既有的 page body，只是不占任务视图的位置。
  document.querySelectorAll('.skills-cognition-console').forEach((console_) => {
    if (console_.dataset.cognitionPageNav === '1') return;
    console_.dataset.cognitionPageNav = '1';
    console_.addEventListener('click', (event) => {
      const button = event.target.closest('[data-cognition-page]');
      if (!button || !console_.contains(button)) return;
      switchSkillsCognitionPage(button.dataset.cognitionPage || 'inbox');
    });
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
    switchSkillsCognitionPage(tabs[nextIndex].dataset.cognitionPage || 'inbox');
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

  const renderActiveAssetSurface = () => {
    if (_skillsCognitionState.page === 'governance') renderSkillsCognitionGovernance();
    else renderSkillsCognitionAssets();
  };

  const runRecallAssetAction = async (control, actionName, assetId) => {
    if (!actionName || !assetId || control.dataset.busy === '1') return;
    control.dataset.busy = '1'; control.disabled = true;
    try {
      if (actionName === 'versions') {
        _skillsCognitionState.assetHistoryById ||= {};
        _skillsCognitionState.visibleAssetHistoryId = assetId;
        _skillsCognitionState.assetHistoryById[assetId] = { loading: true };
        renderActiveAssetSurface();
        // diff 与版本一起取：只有版本号和时间的话，"回滚到此版本"对用户就是
        // 盲赌——他只能靠时间戳猜哪一版是他要的。diff 取不到不该让版本面板
        // 打不开，所以单独兜底。
        const [result, diffResult] = await Promise.all([
          window.cogseed.invoke('recall.assets.versions', { assetId }),
          window.cogseed.invoke('cognition.assets.diff', { assetId }).catch(() => null),
        ]);
        if (!result?.ok) throw new Error(result?.error || 'recall asset versions failed');
        _skillsCognitionState.assetHistoryById[assetId] = {
          loading: false,
          versions: result.versions || [],
          audit: result.audit || [],
          diffs: diffResult?.ok ? (diffResult.diffs || []) : [],
        };
        renderActiveAssetSurface();
        return;
      }
      if (actionName === 'chain') {
        _skillsCognitionState.assetChainById ||= {};
        _skillsCognitionState.visibleAssetChainId = assetId;
        _skillsCognitionState.assetChainById[assetId] = { loading: true };
        renderActiveAssetSurface();
        const [chainResult, usageResult, proofResult] = await Promise.all([
          window.cogseed.invoke('recall.cognitionChain.read', { assetId }),
          // 使用记录与证明取不到都不该让整个履历打不开——它们是补充，
          // 履历本身来自回执。
          window.cogseed.invoke('recall.usage.list', { assetId }).catch(() => null),
          window.cogseed.invoke('recall.proofs.list', { assetId }).catch(() => null),
        ]);
        if (!chainResult?.ok) throw new Error(chainResult?.error || 'recall cognition chain failed');
        _skillsCognitionState.assetChainById[assetId] = {
          loading: false,
          chain: chainResult.chain || null,
          usage: usageResult?.usage || [],
          proofs: proofResult?.proofs || [],
        };
        renderActiveAssetSurface();
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
        renderActiveAssetSurface();
      }
      if (actionName === 'chain') {
        _skillsCognitionState.assetChainById ||= {};
        _skillsCognitionState.assetChainById[assetId] = { loading: false, error: (error && error.message) || String(error) };
        renderActiveAssetSurface();
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
    // ── 使用与证明 ──────────────────────────────────────────────────
    const proofEvent = event.target.closest('[data-recall-proof-event]');
    if (proofEvent) {
      // 再点一次收起，和版本面板的开合一致。
      const next = proofEvent.dataset.recallProofEvent || '';
      _skillsCognitionState.selectedProofEventId = _skillsCognitionState.selectedProofEventId === next ? '' : next;
      renderSkillsCognitionProofs();
      return;
    }
    const proofFeedback = event.target.closest('[data-recall-proof-feedback]');
    if (proofFeedback) {
      if (proofFeedback.dataset.busy === '1') return;
      const feedback = proofFeedback.dataset.recallProofFeedback;
      const proofId = proofFeedback.dataset.recallProofFeedbackProof;
      const taskRunId = proofFeedback.dataset.recallProofFeedbackTask;
      // 评价必须落到一条具体的证明或任务上。两者都没有时不该发请求——
      // 一次无法归属的评价写进去，之后没人能说清它评的是哪次复用。
      if (!feedback || (!proofId && !taskRunId)) return;
      proofFeedback.dataset.busy = '1'; proofFeedback.disabled = true;
      try {
        const result = proofId
          ? await window.cogseed.invoke('recall.proofs.effectiveness.feedback', { transferProofId: proofId, feedback })
          : await window.cogseed.invoke('recall.proofs.effectiveness.feedbackForTask', { taskRunId, feedback });
        if (!result?.ok) throw new Error(result?.error || 'effectiveness feedback failed');
        // 评价会推进成熟度，所以整份快照都要重取，不能只重画本页。
        await loadSkillsCognitionSnapshot();
        // 评价推进了成熟度，事实链变了，这里必须重取而不是重画。
        await loadCognitionProofs();
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
      } finally {
        proofFeedback.dataset.busy = '0'; proofFeedback.disabled = false;
      }
      return;
    }

    const reload = event.target.closest('[data-cognition-reload]');
    if (reload) {
      if (reload.dataset.busy === '1') return;
      reload.dataset.busy = '1'; reload.disabled = true;
      try {
        await loadSkillsCognitionSnapshot();
        if (_skillsCognitionState.assetCategoryFilter === 'personal'
          && typeof window.refreshPersonalOntology === 'function') {
          await window.refreshPersonalOntology();
        }
      } finally {
        reload.dataset.busy = '0'; reload.disabled = false;
      }
      return;
    }

    const pageLink = event.target.closest('[data-cognition-page-link]');
    if (pageLink) {
      // 跨页跳转可以顺带带上落点。「使用与证明」的「查看资产」按钮同时挂了
      // page-link 和 ability-asset-id：这个分支在下面那个资产分支之前命中并
      // return，不在这里取 id 的话，用户点过去只是换了一页，要看的那条资产
      // 仍然没被选中——证明链就此断在最后一步。
      const targetAssetId = pageLink.dataset.abilityAssetId || '';
      if (targetAssetId) {
        _skillsCognitionState.selectedAssetId = targetAssetId;
        const targetAsset = (_skillsCognitionState.assets || []).find((item) => item.id === targetAssetId);
        if (targetAsset) _skillsCognitionState.assetCategoryFilter = targetAsset.category || targetAsset.type || '';
      }
      switchSkillsCognitionPage(pageLink.dataset.cognitionPageLink || 'inbox');
      return;
    }

    const candidatePoolLink = event.target.closest('[data-recall-candidate-pool-link]');
    if (candidatePoolLink) {
      switchSkillsCognitionPage('captures');
      setTimeout(() => {
        document.getElementById('skills-cognition-capture-review-body')
          ?.scrollIntoView?.({ block: 'start' });
      }, 0);
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

    const governanceAction = event.target.closest('[data-cognition-governance-action]');
    if (governanceAction) {
      const actionName = governanceAction.dataset.cognitionGovernanceAction || '';
      const assetId = governanceAction.dataset.cognitionGovernanceAsset || '';
      if (actionName && assetId) await runRecallAssetAction(governanceAction, actionName, assetId);
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
      renderActiveAssetSurface();
      return;
    }

    const crossScope = event.target.closest('[data-recall-cross-scope]');
    if (crossScope) {
      const assetId = crossScope.dataset.recallCrossScope;
      const confirmed = crossScope.dataset.recallCrossScopeNext === '1';
      if (!assetId || crossScope.dataset.busy === '1') return;
      crossScope.dataset.busy = '1'; crossScope.disabled = true;
      try {
        const result = await window.cogseed.invoke('recall.assets.crossScope', { assetId, confirmed });
        if (!result?.ok) throw new Error(result?.error || 'cross-scope confirmation failed');
        // 资产列表里那份要跟着更新，否则面板重画时按钮又弹回旧状态。
        const list = _skillsCognitionState.assets || [];
        const index = list.findIndex((item) => item.id === assetId);
        if (index >= 0) list[index] = result.asset;
        renderActiveAssetSurface();
        uiToast(_cognitionText(
          confirmed ? 'cognition.cross_scope_confirmed_done' : 'cognition.cross_scope_withdrawn_done',
          confirmed ? '已允许跨作用域使用' : '已撤回跨作用域许可',
        ), { variant: 'success' });
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
      } finally {
        crossScope.dataset.busy = '0'; crossScope.disabled = false;
      }
      return;
    }

    if (event.target.closest('[data-recall-asset-chain-close]')) {
      _skillsCognitionState.visibleAssetChainId = '';
      renderActiveAssetSurface();
      return;
    }

    const governanceAsset = event.target.closest('[data-cognition-governance-select]');
    if (governanceAsset) {
      _skillsCognitionState.selectedAssetId = governanceAsset.dataset.cognitionGovernanceSelect || '';
      _skillsCognitionState.visibleAssetHistoryId = '';
      _skillsCognitionState.visibleAssetChainId = '';
      renderSkillsCognitionGovernance();
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
      const selectedAsset = (_skillsCognitionState.assets || []).find((item) => item.id === _skillsCognitionState.selectedAssetId);
      if (selectedAsset) _skillsCognitionState.assetCategoryFilter = selectedAsset.category || selectedAsset.type || '';
      switchSkillsCognitionPage('assets');
      return;
    }

    const receiptAsset = event.target.closest('[data-recall-open-asset]');
    if (receiptAsset) {
      const assetId = receiptAsset.dataset.recallOpenAsset || '';
      if (!assetId) return;
      _skillsCognitionState.selectedAssetId = assetId;
      _skillsCognitionState.assetCategoryFilter = '';
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

    const manualOpen = event.target.closest('[data-recall-manual-open]');
    if (manualOpen) {
      const captureId = manualOpen.dataset.recallManualOpen || '';
      if (!captureId) return;
      const visibleCaptures = [...(_skillsCognitionState.captures || []), ...(_skillsCognitionState.recentCaptures || [])];
      const shouldLoad = _skillsCognitionState.captureFilter !== 'all'
        || !visibleCaptures.some((capture) => capture.id === captureId);
      _skillsCognitionState.captureFilter = 'all';
      _skillsCognitionState.captureNextCursor = null;
      try {
        if (shouldLoad) await loadRecallCaptureTasks();
        _skillsCognitionState.selectedCaptureId = captureId;
        renderSkillsCognitionCaptures();
        setTimeout(() => {
          const row = Array.from(document.querySelectorAll('[data-recall-capture-select]'))
            .find((item) => item.dataset.recallCaptureSelect === captureId);
          if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
        }, 0);
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
      }
      return;
    }

    const manualAdd = event.target.closest('[data-recall-manual-add]');
    if (manualAdd) {
      const conversationId = manualAdd.dataset.recallManualAdd || '';
      if (!conversationId || manualAdd.dataset.busy === '1') return;
      manualAdd.dataset.busy = '1'; manualAdd.disabled = true;
      const actionLabel = typeof manualAdd.querySelector === 'function'
        ? manualAdd.querySelector('.recall-manual-conversation-action')
        : null;
      const previousActionLabel = actionLabel?.textContent || '';
      if (actionLabel) actionLabel.textContent = _cognitionText('cognition.capture_manual_history_processing', '正在创建任务');
      try {
        const result = await window.cogseed.invoke('recall.captures.historicalAutoStart', { conversationId });
        if (!result?.ok) throw new Error(result?.error || _cognitionText('cognition.capture_manual_history_create_failed', '启动提取失败'));
        _skillsCognitionState.captureFilter = 'all';
        _skillsCognitionState.captureNextCursor = null;
        _skillsCognitionState.selectedCaptureId = result.capture?.id || '';
        await loadRecallCaptureTasks();
        loadSkillsCognitionSnapshot().catch(() => {});
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert(_recallCaptureErrorMessage(error));
        renderSkillsCognitionCaptures();
      } finally {
        if (actionLabel && previousActionLabel) actionLabel.textContent = previousActionLabel;
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
        _skillsCognitionState.selectedAssetId = _captureLinkedAssetIds(capture)[0] || '';
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
        if (typeof uiAlert === 'function') await uiAlert(_recallCaptureErrorMessage(error));
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
        if (typeof uiAlert === 'function') await uiAlert(_recallCaptureErrorMessage(error));
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

    // 候选现在有独立详情页：带着 id 进去，而不是把用户扔回沉淀活动列表里
    // 自己找。取不到 id 才退回列表——那说明调用方没给，进详情页只会是空壳。
    const openCandidate = event.target.closest('[data-cognition-open-candidate]');
    if (openCandidate) {
      const candidateId = openCandidate.dataset.cognitionOpenCandidate || '';
      if (!candidateId) {
        switchSkillsCognitionPage('captures');
        return;
      }
      _skillsCognitionState.selectedCandidateId = candidateId;
      switchSkillsCognitionPage('candidate');
      return;
    }

    // 「使用与证明」的分层筛选。纯前端过滤既有事实链，不重新取数——换一层看
    // 法不该让用户等一次网络往返。
    const proofFilter = event.target.closest('[data-cognition-proof-filter]');
    if (proofFilter) {
      const next = proofFilter.dataset.cognitionProofFilter || 'all';
      if (next === _skillsCognitionState.proofFilter) return;
      _skillsCognitionState.proofFilter = next;
      _skillsCognitionState.selectedProofEventId = '';
      renderSkillsCognitionProofs();
      return;
    }

    // Skill 版本回滚走真实通道（cognition.skills.rollback）。回滚会改变下一次
    // 匹配任务实际使用的版本，所以先确认——这一步不可由一次误点完成。
    const skillRollback = event.target.closest('[data-cognition-skill-rollback]');
    if (skillRollback) {
      const skillId = skillRollback.dataset.cognitionSkillRollback || '';
      const version = skillRollback.dataset.cognitionSkillVersion || '';
      if (!skillId || !version || skillRollback.dataset.busy === '1') return;
      const message = _cognitionText(
        'cognition.skillupdate_rollback_confirm',
        '回滚后，下一次匹配任务将使用 v{v}；更高版本仍然保留，历史结果不会被修改。确认回滚？',
      ).replace('{v}', version);
      if (typeof uiConfirm !== 'function' || !(await uiConfirm(message))) return;
      skillRollback.dataset.busy = '1'; skillRollback.disabled = true;
      try {
        const result = await window.cogseed.invoke('cognition.skills.rollback', { skillId, version });
        if (!result?.ok) throw new Error(result?.error || 'skill rollback failed');
        if (typeof uiToast === 'function') {
          uiToast(_cognitionText('cognition.skillupdate_rollback_done', '已回滚到 v{v}').replace('{v}', version), { variant: 'success' });
        }
        const current = _skillsCognitionState.skillUpdate || {};
        await loadCognitionSkillUpdate(current.assetId, skillId);
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
      } finally {
        skillRollback.dataset.busy = '0'; skillRollback.disabled = false;
      }
      return;
    }

    const treeReload = event.target.closest('[data-cognition-tree-reload]');
    if (treeReload) {
      void loadCognitionTree({ rebuild: true });
      return;
    }

    // 管理来源统计条上的「需授权 / 失败记录」→ 定位到出问题的那一组。数出了
    // 问题却点不进去，用户就得自己从五组来源里逐条翻找那一条坏的。
    const sourceLocate = event.target.closest('[data-cognition-source-locate]');
    if (sourceLocate) {
      const kind = sourceLocate.dataset.cognitionSourceLocate;
      const selector = kind === 'auth'
        ? '[data-cognition-source-group="auth"]'
        : '[data-cognition-source-group-failed]';
      const target = document.querySelector(selector);
      if (!target) return;
      // 折叠组要先展开，否则滚过去看到的还是一行收起的摘要。
      if (target.tagName === 'DETAILS') target.open = true;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('is-located');
      setTimeout(() => target.classList.remove('is-located'), 1600);
      return;
    }

    // 「版本与治理」里带候选的资产 → Skill 更新候选页。资产必须真的生成过
    // Skill 才有版本可比，所以 skillId 取不到就不跳：跳过去只会是一页空壳。
    const openSkillUpdate = event.target.closest('[data-cognition-open-skill-update]');
    if (openSkillUpdate) {
      const assetId = openSkillUpdate.dataset.cognitionOpenSkillUpdate || '';
      const asset = (_skillsCognitionState.assets || []).find((item) => item.id === assetId);
      const skillId = asset?.generatedSkillId || '';
      if (!skillId) return;
      switchSkillsCognitionPage('skillupdate');
      void loadCognitionSkillUpdate(assetId, skillId);
      return;
    }

    // develop 侧的候选溯源能力：从一条候选找回它所属的沉淀任务，必要时翻页
    // 继续拉取，再滚动到那一行。合并时它没有被丢掉，而是从"点候选的默认去向"
    // 降级成候选详情页里的一个显式入口——v0.7 里点候选要进的是决定面，而
    // "这条候选是哪次沉淀产生的"是另一个问题，值得单独一次点击。
    const locateCandidateCapture = event.target.closest('[data-cognition-locate-candidate-capture]');
    if (locateCandidateCapture) {
      const candidateId = locateCandidateCapture.dataset.cognitionLocateCandidateCapture || '';
      if (!candidateId) return;
      const candidate = (_skillsCognitionState.recallCandidates || [])
        .find((item) => item && item.id === candidateId);
      const findCapture = () => [...(_skillsCognitionState.captures || []), ...(_skillsCognitionState.recentCaptures || [])]
        .find((capture) => Array.isArray(capture?.candidateIds) && capture.candidateIds.includes(candidateId)
          || (candidate?.taskRunId && (capture?.terminalRunId === candidate.taskRunId || capture?.taskRunId === candidate.taskRunId)));
      _skillsCognitionState.captureFilter = 'all';
      _skillsCognitionState.captureNextCursor = null;
      try {
        let capture = findCapture();
        if (!capture && typeof loadRecallCaptureTasks === 'function') {
          await loadRecallCaptureTasks();
          capture = findCapture();
          while (!capture && _skillsCognitionState.captureNextCursor) {
            const cursorBeforeLoad = _skillsCognitionState.captureNextCursor;
            await loadRecallCaptureTasks({ append: true });
            capture = findCapture();
            if (_skillsCognitionState.captureNextCursor === cursorBeforeLoad) break;
          }
        }
        _skillsCognitionState.selectedCaptureId = capture?.id || '';
        switchSkillsCognitionPage('captures');
        setTimeout(() => {
          const taskRow = typeof document.querySelectorAll === 'function'
            ? [...document.querySelectorAll('[data-recall-capture-select]')].find((item) => item.dataset.recallCaptureSelect === capture?.id)
            : null;
          const candidateRow = typeof document.querySelectorAll === 'function'
            ? [...document.querySelectorAll('[data-recall-candidate-id]')].find((item) => item.dataset.recallCandidateId === candidateId)
            : null;
          (taskRow || candidateRow)?.scrollIntoView?.({ block: 'center' });
        }, 0);
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert(_recallCaptureErrorMessage(error));
      }
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
        const result = await window.cogseed.invoke(channel, payload);
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
      const selectedIds = _skillsCognitionState.candidatePoolSelectionInitialized
        ? new Set(Array.isArray(_skillsCognitionState.selectedRecallCandidateIds) ? _skillsCognitionState.selectedRecallCandidateIds : [])
        : null;
      const candidateIds = (_skillsCognitionState.recallCandidates || [])
        .filter((candidate) => candidate.status === 'pending_review' && candidate.risk !== 'high'
          && (!selectedIds || selectedIds.has(candidate.id)))
        .map((candidate) => candidate.id);
      const includesPersonal = (_skillsCognitionState.recallCandidates || []).some((candidate) =>
        candidateIds.includes(candidate.id) && candidate.suggestedType === 'personal',
      );
      if (!candidateIds.length) return;
      promoteAll.dataset.busy = '1'; promoteAll.disabled = true;
      _skillsCognitionState.writingRecallCandidateBatch = true;
      const failures = [];
      try {
        const result = await window.cogseed.invoke('recall.candidates.promoteBatch', { candidateIds });
        if (!result?.ok) throw new Error(result?.error || 'recall candidate batch action failed');
        failures.push(...(result.failed || []));
        await loadSkillsCognitionSnapshot().catch(() => {});
        const profileSynced = !includesPersonal || await refreshPersonalOntologyAfterPromotion();
        if (failures.length) {
          const message = _cognitionText(
            'cognition.capture_save_all_partial',
            '已保存 {success} 条，{failed} 条失败；失败内容已保留，可单独重试。',
          ).replace('{success}', String(candidateIds.length - failures.length)).replace('{failed}', String(failures.length));
          if (typeof uiAlert === 'function') await uiAlert(message);
        } else if (profileSynced && typeof uiToast === 'function') {
          uiToast(_cognitionText('cognition.capture_save_all_done', '已全部写入 Recall'), { variant: 'success' });
        }
      } catch (error) {
        if (typeof uiAlert === 'function') {
          await uiAlert((error && error.message) || String(error));
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
        let channel = actionName === 'promote' ? 'recall.candidates.promote' : actionName === 'reject' ? 'recall.candidates.reject' : actionName === 'ignore' ? 'recall.candidates.ignore' : actionName === 'keep-current' ? 'recall.candidates.keepCurrent' : actionName === 'defer' ? 'recall.candidates.defer' : actionName === 'resume' ? 'recall.candidates.resume' : '';
        let payload = { candidateId };
        const candidate = (_skillsCognitionState.recallCandidates || []).find((item) => item.id === candidateId);
        let riskAcknowledged = false;
        if (actionName === 'promote' || actionName === 'save-and-promote') {
          if (candidate?.risk === 'high') {
            const confirmed = typeof uiConfirm === 'function' && await uiConfirm({
              message: _cognitionText('cognition.candidate_high_risk_confirm', '这是高风险资产变更。确认继续保存吗？'),
              okLabel: _cognitionText('common.confirm', '确认'),
              cancelLabel: _cognitionText('common.cancel', '取消'),
            });
            if (!confirmed) return;
            riskAcknowledged = true;
            if (actionName === 'promote') payload = { candidateId, riskAcknowledged: true };
          }
        }
        if (actionName === 'save-and-promote') {
          const card = recallAction.closest('[data-recall-candidate-id]');
          if (!card || !candidate) throw new Error('recall candidate unavailable');
          channel = 'recall.candidates.update';
          const evidenceText = card.querySelector('[data-recall-edit-evidence]')?.value || '';
          const sourceRefs = evidenceText.split(/[\n,]/).map((value) => value.trim()).filter(Boolean).map((value) => {
            const divider = value.indexOf(':');
            return divider > 0 ? { kind: value.slice(0, divider), id: value.slice(divider + 1) } : { kind: 'memory', id: value };
          });
          const conditionLines = (selector) => String(card.querySelector(selector)?.value || '')
            .split('\n').map((value) => value.trim()).filter(Boolean);
          payload = { candidateId, judgment: card.querySelector('[data-recall-edit-judgment]')?.value || '', value: candidate.value || '', summary: card.querySelector('[data-recall-edit-summary]')?.value || '', suggestedScope: card.querySelector('[data-recall-edit-scope]')?.value || '', suggestedType: card.querySelector('[data-recall-edit-type]')?.value || '', suggestedAction: candidate.suggestedAction || 'create', risk: candidate.risk || 'low', sourceRefs, evidenceRefs: sourceRefs, applicableWhen: conditionLines('[data-recall-edit-applicable]'), forbiddenWhen: conditionLines('[data-recall-edit-forbidden]'), expiresAt: candidate.expiresAt, taskRunId: candidate.taskRunId, targetAssetId: candidate.targetAssetId };
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
          const promoted = await window.cogseed.invoke('recall.candidates.promote', { candidateId, ...(riskAcknowledged ? { riskAcknowledged: true } : {}) });
          if (!promoted?.ok) throw new Error(promoted?.error || 'recall candidate action failed');
        }
        _skillsCognitionState.editingRecallCandidateId = '';
        _skillsCognitionState.writingRecallCandidateId = '';
        await loadSkillsCognitionSnapshot();
        const promotedType = actionName === 'save-and-promote' ? payload.suggestedType : candidate?.suggestedType;
        if ((actionName === 'promote' || actionName === 'save-and-promote')
          && promotedType === 'personal') {
          await refreshPersonalOntologyAfterPromotion();
        }
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

  });

  panel.addEventListener('change', async (event) => {
    const candidateSelect = event.target.closest?.('[data-recall-candidate-select]');
    if (candidateSelect) {
      const candidateId = candidateSelect.dataset.recallCandidateSelect || '';
      const selected = new Set(Array.isArray(_skillsCognitionState.selectedRecallCandidateIds)
        ? _skillsCognitionState.selectedRecallCandidateIds : []);
      if (candidateSelect.checked) selected.add(candidateId);
      else selected.delete(candidateId);
      _skillsCognitionState.selectedRecallCandidateIds = [...selected];
      _skillsCognitionState.candidatePoolSelectionInitialized = true;
      renderSkillsCognitionCandidates();
      return;
    }
    const candidateSelectAll = event.target.closest?.('[data-recall-candidate-select-all]');
    if (candidateSelectAll) {
      const ids = (_skillsCognitionState.recallCandidates || [])
        .filter((candidate) => candidate.status === 'pending_review' && candidate.risk !== 'high')
        .map((candidate) => candidate.id);
      _skillsCognitionState.selectedRecallCandidateIds = candidateSelectAll.checked ? ids : [];
      _skillsCognitionState.candidatePoolSelectionInitialized = true;
      renderSkillsCognitionCandidates();
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
    renderSkillsCognitionInbox();
    renderSkillsCognitionSources();
    renderSkillsCognitionCaptures();
    renderSkillsCognitionCandidates();
    renderSkillsCognitionAssets();
    renderSkillsCognitionGovernance();
    if (_skillsCognitionState.assetCategoryFilter === 'personal'
      && typeof window.renderPersonalOntology === 'function') {
      window.renderPersonalOntology();
    }
  });

}

_initSkillsCognitionBindings();
