// Skill-only DOM bindings. Loaded immediately after skills.js when either the
// Skills tab or the chat Agent/Skill picker first needs that surface.

/**
 * 效果评价失败时给用户看的话。
 *
 * 后端抛的 message 是内部契约语言（`no successful transfer proof for task run`
 * / `effectiveness proof requires a successful transfer` / `... verified
 * transfer receipt`），过去被原样 `uiAlert` 出去。按 `err.code` 翻译——码由
 * `recall/proof-service.ts::recallProofError` 打上，IPC 分发器已透传到返回体。
 * 取不到已知码时退回原始 error，宁可露出英文也不吞掉失败。
 */
function _recallProofErrorText(result) {
  const code = String((result && result.code) || '');
  const text = (key, fallback) => (typeof t === 'function' && t(key) !== key ? t(key) : fallback);
  if (code === 'E_RECALL_NO_SUCCESSFUL_TRANSFER') {
    return text('cognition.proof_rating_blocked_no_transfer',
      '这次复用还没有形成迁移证明，暂时不能评价。任务结束并留下复用回执后，这里会出现评价入口。');
  }
  if (code === 'E_RECALL_TRANSFER_NOT_SUCCEEDED') {
    return text('cognition.proof_rating_blocked_rejected',
      '这次没能把资产带入目标会话，没有可评价的复用。');
  }
  if (code === 'E_RECALL_TRANSFER_RECEIPT_MISSING') {
    return text('cognition.proof_rating_blocked_no_receipt',
      '这次迁移证明没有绑定复用回执，无法核对究竟带入了什么，因此不开放效果评价。');
  }
  return (result && result.error) || 'effectiveness feedback failed';
}

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

/**
 * 从认知树点叶子跳转后的视口定位。
 *
 * 目标布局（用户主要看资产详情）：
 *   屏幕最上面 → 四类资产卡（大框架：哪几类、各几条）
 *   紧接着下面 → 资产详情
 *
 * 四类卡在 DOM 里位于树内容之后、资产工作台之前，所以滚动定位到四类卡即可：
 * 视口顶部是四类卡，下方就是资产详情，不用滑过整棵树。
 */
function _scrollCognitionToAssetsWorkbench() {
  setTimeout(() => {
    const grid = document.querySelector('#skills-cognition-assets-summary .ability-asset-summary-grid');
    const el = grid || document.getElementById('skills-cognition-assets-body');
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, 0);
}

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
    const manualSearch = event.target.closest('[data-recall-manual-search]');
    if (manualSearch) {
      _skillsCognitionState.manualSearchQuery = manualSearch.value || '';
      renderSkillsCognitionCaptures();
      const next = document.querySelector('[data-recall-manual-search]');
      if (next) {
        next.focus();
        const end = next.value.length;
        if (typeof next.setSelectionRange === 'function') next.setSelectionRange(end, end);
      }
      return;
    }
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

  /**
   * 认知资产页的成功回执。
   *
   * 失败一直有 `uiAlert`，成功却只靠"列表变了"来暗示——治理/回滚/升级这几条早就
   * 有 toast，但候选决定、效果评价、来源开关、教学撤销这些**更高频**的动作没有。
   * 用户点完只看到列表刷新一下，无法确认系统究竟做了哪件事（尤其"稍后"和"忽略"
   * 在列表上的表现几乎一样）。
   *
   * 只在**动作成功**后调用；失败路径仍走 `uiAlert`，两者不要合并——toast 会自动
   * 消失，失败必须留在屏幕上等用户确认。
   *
   * **绝不能抛**：调用点全部在动作的 try 块里，回执之后才是
   * `loadSkillsCognitionSnapshot()`。这个函数一旦抛，异常会被动作自己的 catch 接住
   * ——动作其实成功了，界面却既不刷新又弹一句报错。一个纯装饰的提示不该有能力
   * 打断关键路径，所以整体包 try/catch，取不到译文就用兜底原文。
   */
  const _cognitionNotifyDone = (key, fallback) => {
    try {
      if (typeof uiToast !== 'function') return;
      const text = typeof _cognitionText === 'function' ? _cognitionText(key, fallback) : fallback;
      uiToast(text, { variant: 'success' });
    } catch {
      /* 提示失败不影响动作本身 */
    }
  };

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
        _cognitionNotifyDone(`cognition.source_action_${actionName}_done`, {
          pause: '已暂停这个来源', resume: '已恢复这个来源',
          retry: '已重新读取', reconnect: '已重新连接',
        }[actionName] || '已完成');
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
    // 「更好了」先开取证面板，不直接落账：这是唯一能把成熟度推到
    // effectiveness_validated 的结论，PRD 3.6 要求它有可比依据。
    const evidenceOpen = event.target.closest('[data-recall-proof-evidence-open]');
    if (evidenceOpen) {
      _skillsCognitionState.proofRatingDraft = { eventId: evidenceOpen.dataset.recallProofEvidenceOpen };
      renderSkillsCognitionProofs();
      return;
    }
    const evidenceCancel = event.target.closest('[data-recall-proof-evidence-cancel]');
    if (evidenceCancel) {
      _skillsCognitionState.proofRatingDraft = null;
      renderSkillsCognitionProofs();
      return;
    }
    const evidenceSubmit = event.target.closest('[data-recall-proof-evidence-submit]');
    if (evidenceSubmit) {
      if (evidenceSubmit.dataset.busy === '1') return;
      const proofId = evidenceSubmit.dataset.recallProofEvidenceSubmit;
      if (!proofId) return;
      const panel = evidenceSubmit.closest('.recall-proof-rating');
      const note = String(panel?.querySelector('[data-recall-proof-evidence-note]')?.value || '').trim();
      // 勾选项就是用户认下的依据。没勾任何一条时照样提交——后端会如实把它
      // 记成 Evidence 不足，这比替用户凑一条引用诚实。
      const evidenceRefs = Array.from(panel?.querySelectorAll('[data-recall-proof-evidence]:checked') || [])
        .map((box) => ({
          kind: box.dataset.evidenceKind,
          subtype: box.dataset.evidenceSubtype,
          id: box.dataset.evidenceId,
        }))
        .filter((ref) => ref.kind && ref.id);
      if (!note) {
        if (typeof uiAlert === 'function') {
          await uiAlert(t('cognition.proof_evidence_note_required') !== 'cognition.proof_evidence_note_required'
            ? t('cognition.proof_evidence_note_required')
            : '先写一句你观察到的变化——这句话就是这次评价的依据。');
        }
        return;
      }
      evidenceSubmit.dataset.busy = '1'; evidenceSubmit.disabled = true;
      try {
        const result = await window.cogseed.invoke('recall.proofs.effectiveness.feedback', {
          transferProofId: proofId, feedback: 'positive', note, evidenceRefs,
        });
        if (!result?.ok) throw new Error(_recallProofErrorText(result));
        _skillsCognitionState.proofRatingDraft = null;
        // 不说"已验证有效"——能不能推动成熟度由后端按有无可追溯引用判定，这里
        // 只回执"记下了"，免得没有引用时用户以为已经升档。
        _cognitionNotifyDone('cognition.proof_rating_done', '已记下这次评价');
        await loadSkillsCognitionSnapshot();
        await loadCognitionProofs();
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
      } finally {
        evidenceSubmit.dataset.busy = '0'; evidenceSubmit.disabled = false;
      }
      return;
    }
    const proofFeedback = event.target.closest('[data-recall-proof-feedback]');
    if (proofFeedback) {
      if (proofFeedback.dataset.busy === '1') return;
      const feedback = proofFeedback.dataset.recallProofFeedback;
      const proofId = proofFeedback.dataset.recallProofFeedbackProof;
      // 评价必须落到一条具体的迁移证明上。**只走 proof 通道**：
      // `feedbackForTask` 的后端前置条件与它完全相同（都要求 status='succeeded'
      // 且已绑回执的迁移证明），按 taskRunId 再走一遍只是第二条注定失败的路径
      // ——用户在「已带入本次任务」下点评价吃到的
      // `no successful transfer proof for task run` 就是从那条路来的。
      // 渲染侧的闸门在 skills.js::_proofRatingEligibility。
      if (!feedback || !proofId) return;
      proofFeedback.dataset.busy = '1'; proofFeedback.disabled = true;
      try {
        // 只走 proof 通道（M-10）：`feedbackForTask` 的后端前置条件与它完全相同，
        // 第二条路只会让用户吃到 `no successful transfer proof for task run`。
        // origin/develop 的 M-4 曾在这里自动附一条指向本次证明自身的
        // execution_evaluation 证据；本分支改为「带入正确」走取证面板，由用户写下
        // 观察并勾选可回查的依据——自引用能让成熟度升上去，但升上去的
        // effectiveness_validated 不再代表有可比依据。两者取后者。
        const result = await window.cogseed.invoke('recall.proofs.effectiveness.feedback', { transferProofId: proofId, feedback });
        // 后端这几种失败是内部契约语言，直接 alert 出去用户读不懂。按稳定 code
        // 翻成人话；渲染闸门正常时走不到这里，这是数据在渲染与点击之间发生
        // 变化的兜底。
        if (!result?.ok) throw new Error(_recallProofErrorText(result));
        _cognitionNotifyDone('cognition.proof_rating_done', '已记下这次评价');
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

    // 「我的认知树」二级页面（四类资产 + 详情）的返回按钮：回到树视图。
    const subviewTree = event.target.closest('[data-cognition-subview-tree]');
    if (subviewTree) {
      _skillsCognitionState.assetSubview = 'tree';
      renderSkillsCognitionAssets();
      setTimeout(() => {
        const top = document.getElementById('skills-cognition-assets-summary');
        if (top && typeof top.scrollIntoView === 'function') top.scrollIntoView({ block: 'start' });
      }, 0);
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
      // 认知树的大叶（一类资产一片）同时挂 page-link 和 ability-asset-category：
      // 点大叶 = 进入「我的认知树」的二级页面（四类资产 + 详情）并筛到那一类。
      const targetCategory = pageLink.dataset.abilityAssetCategory || '';
      if (targetCategory) {
        _skillsCognitionState.assetCategoryFilter = targetCategory;
        _skillsCognitionState.selectedAssetId = '';
      }
      // 带资产落点（叶子/查看资产）的跳转进入二级页面：树是这一页的一级视图，
      // 点叶子要看的是详细的四类资产。
      if (targetAssetId || targetCategory) _skillsCognitionState.assetSubview = 'assets';
      switchSkillsCognitionPage(pageLink.dataset.cognitionPageLink || 'inbox');
      // 跳进二级页面后定位到四类资产卡（屏幕最上面），下方就是资产详情。
      if (targetCategory || targetAssetId) _scrollCognitionToAssetsWorkbench();
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
      // 点叶子进入二级页面（四类资产 + 详情），树是这一页的一级视图。
      _skillsCognitionState.assetSubview = 'assets';
      switchSkillsCognitionPage('assets');
      // 定位到四类资产卡（屏幕最上面），下方就是该资产的详情——用户主要看的是详情。
      _scrollCognitionToAssetsWorkbench();
      return;
    }

    const receiptAsset = event.target.closest('[data-recall-open-asset]');
    if (receiptAsset) {
      const assetId = receiptAsset.dataset.recallOpenAsset || '';
      if (!assetId) return;
      _skillsCognitionState.selectedAssetId = assetId;
      _skillsCognitionState.assetCategoryFilter = '';
      _skillsCognitionState.assetSubview = 'assets';
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
        _cognitionNotifyDone(`cognition.capture_action_${actionName}_done`, {
          pause: '已暂停这个沉淀任务', resume: '已继续这个沉淀任务',
          cancel: '已取消这个沉淀任务', retry: '已重新排入沉淀队列',
          'run-now': '已开始执行',
        }[actionName] || '已完成');
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
        _cognitionNotifyDone('cognition.teaching_revoke_done', '已撤销这条教学回执');
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

    const skillDecision = event.target.closest('[data-cognition-skill-decision]');
    if (skillDecision) {
      const decision = skillDecision.dataset.cognitionSkillDecision || '';
      const assetId = skillDecision.dataset.cognitionSkillAsset || '';
      const draftHash = skillDecision.dataset.cognitionSkillDraftHash || '';
      if (!assetId || !draftHash || !['accept', 'defer', 'reject'].includes(decision) || skillDecision.dataset.busy === '1') return;
      const messageKey = decision === 'accept' ? 'cognition.skillupdate_accept_confirm'
        : decision === 'defer' ? 'cognition.skillupdate_defer_confirm' : 'cognition.skillupdate_reject_confirm';
      const fallback = decision === 'accept' ? '确认接受这次 Skill 升级？'
        : decision === 'defer' ? '暂缓这次升级，保留当前版本？' : '拒绝这次升级？';
      if (typeof uiConfirm === 'function' && !(await uiConfirm(_cognitionText(messageKey, fallback)))) return;
      skillDecision.dataset.busy = '1'; skillDecision.disabled = true;
      try {
        const result = await window.cogseed.invoke('recall.skills.decide', { assetId, draftHash, decision });
        if (!result?.ok) throw new Error(result?.error || 'skill decision failed');
        if (typeof uiToast === 'function') uiToast(_cognitionText(`cognition.skillupdate_${decision}_done`, decision === 'accept' ? 'Skill 已升级' : decision === 'defer' ? '已暂缓升级' : '已拒绝本次升级'), { variant: 'success' });
        const current = _skillsCognitionState.skillUpdate || {};
        await loadCognitionSkillUpdate(assetId, current.skillId || '');
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
      } finally {
        skillDecision.dataset.busy = '0'; skillDecision.disabled = false;
      }
      return;
    }

    // Skill 版本回滚走真实通道（cognition.skills.rollback）。回滚会改变下一次
    // 匹配任务实际使用的版本，所以先确认——这一步不可由一次误点完成。
    const skillRollback = event.target.closest('[data-cognition-skill-rollback]');
    if (skillRollback) {
      const skillId = skillRollback.dataset.cognitionSkillRollback || '';
      const version = skillRollback.dataset.cognitionSkillVersion || '';
      if (!skillId || !version || skillRollback.dataset.busy === '1') return;
      let rollbackPreview;
      try {
        const previewResult = await window.cogseed.invoke('cognition.skills.rollback.preview', { skillId, version });
        if (!previewResult?.ok) throw new Error(previewResult?.error || 'skill rollback preview failed');
        rollbackPreview = previewResult.preview;
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
        return;
      }
      const message = _cognitionText(
        'cognition.skillupdate_rollback_confirm',
        '回滚后，下一次匹配任务将使用 v{v}；更高版本仍然保留，历史结果不会被修改。确认回滚？',
      ).replace('{v}', version)
        + `\n\n${rollbackPreview?.rollbackScope === 'skill_md_only'
          ? _cognitionText('cognition.skillupdate_rollback_legacy_scope', '这是旧版本记录，只会恢复 SKILL.md，不会恢复其他文件；本次会生成新的兼容版本。')
          : _cognitionText('cognition.skillupdate_rollback_full_scope', '将恢复完整 Skill 文件树，新增、删除和脚本变化都会纳入新版本。')}`
        + (rollbackPreview?.diff
          ? `\n${_cognitionText('cognition.skillupdate_rollback_diff_summary', '文件变化：新增 {a}，修改 {m}，删除 {d}。')
            .replace('{a}', String(rollbackPreview.diff.added || 0))
            .replace('{m}', String(rollbackPreview.diff.modified || 0))
            .replace('{d}', String(rollbackPreview.diff.deleted || 0))}`
          : '')
        + (rollbackPreview?.nextVersion
          ? `\n${_cognitionText('cognition.skillupdate_rollback_new_version', '确认后生成新版本 v{v}。').replace('{v}', rollbackPreview.nextVersion)}`
          : '');
      if (typeof uiConfirm !== 'function' || !(await uiConfirm(message))) return;
      skillRollback.dataset.busy = '1'; skillRollback.disabled = true;
      try {
        const result = await window.cogseed.invoke('cognition.skills.rollback', {
          skillId,
          version,
          ...(rollbackPreview?.currentManifestHash ? { expectedManifestHash: rollbackPreview.currentManifestHash } : {}),
          ...(rollbackPreview?.currentRevisionId ? { expectedRevisionId: rollbackPreview.currentRevisionId } : {}),
          ...(rollbackPreview?.rollbackScope === 'skill_md_only' ? { allowPartialLegacy: true } : {}),
        });
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

    // 管理来源：五类概览卡就地展开条目，不新增二级页——这一页先回答"系统能从
    // 哪五类地方发现认知"，条目是钻进去之后的事。
    const sourceExpand = event.target.closest('[data-cognition-source-expand]');
    if (sourceExpand) {
      const kind = sourceExpand.dataset.cognitionSourceExpand || '';
      if (!kind) return;
      const open = Array.isArray(_skillsCognitionState.expandedSourceKinds)
        ? _skillsCognitionState.expandedSourceKinds
        : [];
      _skillsCognitionState.expandedSourceKinds = open.includes(kind)
        ? open.filter((item) => item !== kind)
        : [...open, kind];
      renderSkillsCognitionSources();
      return;
    }

    const treeReload = event.target.closest('[data-cognition-tree-reload]');
    if (treeReload) {
      void loadCognitionTree({ rebuild: true });
      return;
    }

    // 「非资产分流」：展开一条接续快照 / 读取失败后重试。两个入口都落在真实
    // 通道上（recall.continuation.read / .list），页面上没有点了不动的按钮。
    const reviewHistoryReload = event.target.closest('[data-cognition-review-history-reload]');
    if (reviewHistoryReload) {
      void loadCognitionReviewHistory();
      return;
    }

    // 空种子页的「去开始一次任务」：复用侧栏既有的新建任务入口，不另起一条
    // 建会话路径——那会绕开 new-chat 已有的空间/草稿处理。
    const seedNewTask = event.target.closest('[data-cognition-seed-new-task]');
    if (seedNewTask) {
      document.getElementById('new-chat-btn')?.click();
      return;
    }

    const continuationOpen = event.target.closest('[data-cognition-continuation-open]');
    if (continuationOpen) {
      void openCognitionContinuation(continuationOpen.dataset.cognitionContinuationOpen);
      return;
    }
    const continuationReload = event.target.closest('[data-cognition-continuation-reload]');
    if (continuationReload) {
      void loadCognitionContinuation();
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
      // 卡片收着的话先展开：用户点这一格是要看"到底哪几条出了问题"，滚过去只
      // 看到一张收起的卡等于没回答。展开会重画，所以要重新查一次节点再滚。
      const kindToOpen = target.querySelector('[data-cognition-source-expand]')?.dataset.cognitionSourceExpand || '';
      const open = Array.isArray(_skillsCognitionState.expandedSourceKinds)
        ? _skillsCognitionState.expandedSourceKinds
        : [];
      if (kindToOpen && !open.includes(kindToOpen)) {
        _skillsCognitionState.expandedSourceKinds = [...open, kindToOpen];
        renderSkillsCognitionSources();
      }
      const located = document.querySelector(selector) || target;
      located.scrollIntoView({ behavior: 'smooth', block: 'center' });
      located.classList.add('is-located');
      setTimeout(() => located.classList.remove('is-located'), 1600);
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
        _cognitionNotifyDone(`cognition.asset_action_${action}_done`, {
          pause: '已暂停使用', resume: '已恢复使用', revoke: '已移除',
          'acknowledge-recommendation': '已确认这条建议',
        }[action] || '已完成');
        await loadSkillsCognitionSnapshot();
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
      } finally {
        abilityAssetAction.dataset.busy = '0'; abilityAssetAction.disabled = false;
      }
      return;
    }

    // 正式资产内容编辑：confirmed Candidate 之后的唯一修改出口。保存走
    // recall.assets.update，由后端生成新版本；这里不自己拼版本号。
    const assetEditOpen = event.target.closest('[data-recall-asset-edit-open]');
    if (assetEditOpen) {
      const assetId = assetEditOpen.dataset.recallAssetEditOpen || '';
      if (!assetId || assetEditOpen.dataset.busy === '1') return;
      // 列表里的 assets 是精简视图（没有 statement / applicableWhen /
      // forbiddenWhen），拿它填表单会让三个框空着——用户一保存就把资产已有的
      // 边界写成空数组。编辑必须基于权威记录，读不到就不开编辑器。
      assetEditOpen.dataset.busy = '1'; assetEditOpen.disabled = true;
      try {
        const result = await window.cogseed.invoke('recall.assets.read', { assetId });
        if (!result?.ok || !result.asset) throw new Error(result?.error || 'recall asset read failed');
        _skillsCognitionState.editingAssetRecord = result.asset;
        _skillsCognitionState.editingAssetId = assetId;
        renderSkillsCognitionGovernance();
      } catch (error) {
        _skillsCognitionState.editingAssetId = '';
        _skillsCognitionState.editingAssetRecord = null;
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
      } finally {
        assetEditOpen.dataset.busy = '0'; assetEditOpen.disabled = false;
      }
      return;
    }
    const assetEditCancel = event.target.closest('[data-recall-asset-edit-cancel]');
    if (assetEditCancel) {
      _skillsCognitionState.editingAssetId = '';
      _skillsCognitionState.editingAssetRecord = null;
      renderSkillsCognitionGovernance();
      return;
    }
    const assetEditSave = event.target.closest('[data-recall-asset-edit-save]');
    if (assetEditSave) {
      const assetId = assetEditSave.dataset.recallAssetEditSave || '';
      if (!assetId || assetEditSave.dataset.busy === '1') return;
      const editor = assetEditSave.closest('[data-recall-asset-editor]');
      if (!editor) return;
      const readValue = (selector) => (editor.querySelector(selector)?.value ?? '').trim();
      const readLines = (selector) => (editor.querySelector(selector)?.value ?? '')
        .split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 32);
      const statement = readValue('[data-recall-asset-edit-statement]');
      if (!statement) {
        if (typeof uiAlert === 'function') await uiAlert(_cognitionText('cognition.asset_edit_statement_required', '资产内容不能为空'));
        return;
      }
      const reason = readValue('[data-recall-asset-edit-reason]')
        || _cognitionText('cognition.asset_edit_default_reason', '用户修改了资产内容');
      assetEditSave.dataset.busy = '1'; assetEditSave.disabled = true;
      try {
        const result = await window.cogseed.invoke('recall.assets.update', {
          assetId,
          statement,
          scope: readValue('[data-recall-asset-edit-scope]'),
          applicableWhen: readLines('[data-recall-asset-edit-applicable]'),
          forbiddenWhen: readLines('[data-recall-asset-edit-forbidden]'),
          reason,
        });
        if (!result?.ok) throw new Error(result?.error || 'recall asset update failed');
        _skillsCognitionState.editingAssetId = '';
        _skillsCognitionState.editingAssetRecord = null;
        // 版本历史已经变了：清掉缓存的历史，让治理页重新读到新版本与本次改动。
        if (_skillsCognitionState.assetHistoryById) delete _skillsCognitionState.assetHistoryById[assetId];
        _cognitionNotifyDone('cognition.asset_edit_done', '已保存为新版本');
        await loadSkillsCognitionSnapshot();
      } catch (error) {
        if (typeof uiAlert === 'function') await uiAlert((error && error.message) || String(error));
      } finally {
        assetEditSave.dataset.busy = '0'; assetEditSave.disabled = false;
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
        // 批量入库池取 capability，不取 raw status：否则 weak_observation 候选
        // 全被过滤掉，selectedCount 恒为 0，按钮永远是灰的。
        .filter((candidate) => _recallCandidateCapabilities(candidate).canBatchSelect
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
        // Buttons also carry the candidate id; start at the parent so the
        // container is selected. Resolve the card only for actions that read
        // card fields, keeping lightweight DOM adapters safe for simple actions.
        const card = (candidate?.suggestedType === 'personal' || actionName === 'save-and-promote')
          ? (() => {
            const parent = recallAction.parentElement;
            const fromParent = typeof parent?.closest === 'function'
              ? parent.closest('[data-recall-candidate-id]') : null;
            return fromParent || (typeof recallAction.closest === 'function'
              ? recallAction.closest('[data-recall-candidate-id]') : null);
          })()
          : null;
        const readProfileTarget = () => {
          if (candidate?.suggestedType !== 'personal' || !card) return undefined;
          const encoded = card.querySelector('[data-recall-profile-target]')?.value || '';
          if (!encoded) return undefined;
          try {
            const target = JSON.parse(decodeURIComponent(encoded));
            if (!target || !target.groupId || !target.section || !target.fieldName) return undefined;
            return target;
          } catch (_) {
            return undefined;
          }
        };
        const profileTarget = readProfileTarget();
        let riskAcknowledged = false;
        if (actionName === 'promote' && profileTarget) payload = { candidateId, profileTarget };
        if (actionName === 'promote' || actionName === 'save-and-promote') {
          if (candidate?.risk === 'high') {
            const confirmed = typeof uiConfirm === 'function' && await uiConfirm({
              message: _cognitionText('cognition.candidate_high_risk_confirm', '这是高风险资产变更。确认继续保存吗？'),
              okLabel: _cognitionText('common.confirm', '确认'),
              cancelLabel: _cognitionText('common.cancel', '取消'),
            });
            if (!confirmed) return;
            riskAcknowledged = true;
            if (actionName === 'promote') payload = { candidateId, riskAcknowledged: true, ...(profileTarget ? { profileTarget } : {}) };
          }
        }
        if (actionName === 'save-and-promote') {
          if (!card || !candidate) throw new Error('recall candidate unavailable');
          channel = 'recall.candidates.update';
          // 只有页面上**真的渲染了**的字段才参与提交。候选详情页没有适用/禁止
          // 范围输入框，早先无条件读取会把它们提交成空数组——一次「确认并限域」
          // 就把候选原有的边界抹掉，晋升出来的规则也就没了边界。
          const evidenceEl = card.querySelector('[data-recall-edit-evidence]');
          const sourceRefs = evidenceEl
            ? String(evidenceEl.value || '').split(/[\n,]/).map((value) => value.trim()).filter(Boolean).map((value) => {
              const divider = value.indexOf(':');
              return divider > 0 ? { kind: value.slice(0, divider), id: value.slice(divider + 1) } : { kind: 'memory', id: value };
            })
            : (candidate.sourceRefs || []);
          const conditionLines = (selector, current) => {
            const el = card.querySelector(selector);
            if (!el) return Array.isArray(current) ? current : [];
            return String(el.value || '').split('\n').map((value) => value.trim()).filter(Boolean);
          };
          payload = { candidateId, judgment: card.querySelector('[data-recall-edit-judgment]')?.value || '', value: candidate.value || '', summary: card.querySelector('[data-recall-edit-summary]')?.value || '', suggestedScope: card.querySelector('[data-recall-edit-scope]')?.value || '', suggestedType: card.querySelector('[data-recall-edit-type]')?.value || '', suggestedAction: candidate.suggestedAction || 'create', risk: candidate.risk || 'low', sourceRefs, evidenceRefs: evidenceEl ? sourceRefs : (candidate.evidenceRefs || sourceRefs), applicableWhen: conditionLines('[data-recall-edit-applicable]', candidate.applicableWhen), forbiddenWhen: conditionLines('[data-recall-edit-forbidden]', candidate.forbiddenWhen), expiresAt: candidate.expiresAt, taskRunId: candidate.taskRunId, targetAssetId: candidate.targetAssetId };
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
          const promoted = await window.cogseed.invoke('recall.candidates.promote', {
            candidateId,
            ...(riskAcknowledged ? { riskAcknowledged: true } : {}),
            ...(profileTarget ? { profileTarget } : {}),
          });
          if (!promoted?.ok) throw new Error(promoted?.error || 'recall candidate action failed');
        }
        _skillsCognitionState.editingRecallCandidateId = '';
        _skillsCognitionState.writingRecallCandidateId = '';
        await loadSkillsCognitionSnapshot();
        const promotedType = actionName === 'save-and-promote' ? payload.suggestedType : candidate?.suggestedType;
        // 个人本体的晋升多一步画像刷新，那一步失败时会自己弹一句
        // 「资产已保存，个人画像自动更新未完成」——那句话已经包含了"保存成功"。
        // 所以回执放在它之后、且只在它没说话时才发：一次点击只该有一条 toast，
        // 叠两条（成功 + 警告）既吵又自相矛盾。
        const profileSynced = (actionName === 'promote' || actionName === 'save-and-promote')
          && promotedType === 'personal'
          ? await refreshPersonalOntologyAfterPromotion()
          : true;
        // 六种决定在列表上的表现很接近（都是这一条消失），不给回执用户分不清
        // 自己刚才是"拒绝"还是"稍后"。晋升单独说"已成为正式资产"——那是唯一
        // 会长出叶片的一种，和其余五种不是一回事。
        // 决定刚落账，历史带必须重取——E2E 上用户期望"从待办消失、同时出现在
        // 已处理"是一次动作的两面。不重取的话要等下次进页才看得到。
        if (typeof loadCognitionReviewHistory === 'function') await loadCognitionReviewHistory();
        if (profileSynced) {
          _cognitionNotifyDone(`cognition.candidate_${actionName}_done`, {
            promote: '已确认，成为正式资产', 'save-and-promote': '已保存并确认为正式资产',
            reject: '已拒绝这条候选', ignore: '已忽略这条候选',
            defer: '已放到「可以稍后」', resume: '已重新放回待处理',
            'keep-current': '保持当前版本不变',
          }[actionName] || '已完成');
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
        .filter((candidate) => _recallCandidateCapabilities(candidate).canBatchSelect)
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

// ─── 外部入口：从会话消息的 [asset:<id>] 引用卡跳转到认知资产详情页 ──────
// conversation.js 懒加载 skills feature 后调用；不依赖调用方已在认知资产页。
window.openCognitionAssetById = function openCognitionAssetById(assetId) {
  if (!assetId) return false;
  _skillsCognitionState.selectedAssetId = String(assetId);
  _skillsCognitionState.assetCategoryFilter = '';
  switchSkillsCognitionPage('assets');
  if (typeof _setViewFromSidebar === 'function') _setViewFromSidebar('recall');
  else if (typeof setView === 'function') setView('recall');
  return true;
};
