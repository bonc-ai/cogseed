/* ============================================================================
 * 认知资产 · 引导层（cognition-assets/app.js）
 *
 * 唯一职责：把 core + views 接到真实 DOM 上。
 *  - 挂载：渲染进 #panel-recall > #ca-root；
 *  - 事件：全面板一个委托层（data-act / data-go），新交互只登记一处；
 *  - 生命周期：面板首次激活时拉数据；概览页按需拉认知树。
 * ========================================================================== */
(function () {
  'use strict';

  const NS = window.CogAssets;
  if (!NS) return;
  const { store: S, router, actions: A, T } = NS;

  let booted = false;
  const currentRun = () => S.route.name === 'activity' && S.route.activityRunId
    ? { activityRunId: S.route.activityRunId } : {};

  /** 写操作集合：点击后按钮进入 pending（禁用+变淡），完成或重画后还原。 */
  const WRITE_ACTIONS = new Set([
    'refresh', 'cand-adopt-with-form', 'cand-decide', 'formation-recheck',

    'asset-action', 'asset-recommend-ack', 'select-asset-version', 'delete-asset-version',
    'rollback-cleanup-item', 'cleanup-uncertain-dismiss', 'cleanup-uncertain-defer',
    'asset-edit-save', 'edit-from-version', 'merge-asset-version', 'merge-asset', 'source-action',
    // 治理待办就地处断：冲突选边、巡检选边/合并、补边界。
    // 全部经 cognition.inbox.resolve，由 core.actions 转发，不在渲染层写数据。



    'proof-rate',
    'nightly-toggle', 'nightly-scan-now', 'nightly-scan-stop', 'auto-approval-toggle', 'nightly-model-remove', 'nightly-model-up', 'nightly-model-down', 'nightly-model-reset', 'nightly-window-save', 'nightly-window-reset',

    // 经验目录管理：四个管理动作 + 迁移执行；preview/status
    // 是只读扫描，不进 pending 集（与 refresh 的口径不同：它们有各自的载入态）。
    'experience-status-toggle', 'experience-set-type', 'experience-merge', 'experience-archive', 'experience-migration-run',

    // 「记一条」保存：走 recall.candidates.save 产生候选。
  ]);

  /* ────────────────────────── 事件委托 ────────────────────────── */

  function readCandidateForm(anchorEl) {
    // 就近读取：从被点的按钮
    // 向上找最近的表单卡；无锚点时退回全局第一张（兼容旧调用）。
    const card = anchorEl && anchorEl.closest
      ? anchorEl.closest('.ca-candidate-detail') || anchorEl.closest('.ca-activity-detail')?.querySelector('.ca-candidate-detail')
      : document.querySelector('.ca-candidate-detail');
    if (!card) return null;
    // 只读候选（无任何表单控件）时返回 null：调用方按「未携带编辑」处理，
    // 防止一次「保存并使用」用空串覆盖已有内容。
    if (!card.querySelector('[data-f]')) return null;
    const candidate = S.candidates.find(item => item.id === card.dataset.candId);
    if (candidate?.contentOrganization) return { outputs: NS.candidate.readOrganizationOutputs(candidate, card) };
    const value = (name) => {
      const el = card.querySelector(`[data-f="${name}"]`);
      return el ? String(el.value || '') : '';
    };
    return {
      suggestedType: String(card.dataset.candType || ''),
      suggestedScope: card.querySelector('[data-f="scope"]')?.dataset.savedScope ?? value('scope'),
      summary: value('summary'),
      judgment: value('judgment'),
      ...(card.querySelector('[data-f="contentCategory"]') ? { contentCategory: value('contentCategory') } : {}),
      ...(card.querySelector('[data-f="value"]') ? { value: value('value') } : {}),
      ...(card.querySelector('[data-f="uncertainty"]') ? { uncertainty: value('uncertainty') } : {}),
      ...(card.querySelector('[data-f="applicable"]') ? { applicableWhen: value('applicable').split(/\r?\n/).map(v => v.trim()).filter(Boolean) } : {}),
      ...(card.querySelector('[data-f="forbidden"]') ? { forbiddenWhen: value('forbidden').split(/\r?\n/).map(v => v.trim()).filter(Boolean) } : {}),
    };
  }

  // 侧栏页签（specs/008-shell-rail-layout）：页签导航迁出 #ca-root，root 上的
  // 委托够不到，这里在侧栏宿主上单独挂点击 / 键盘激活 / 方向键漫游。
  function bindSidebarTabs(host) {
    if (!host || typeof host.addEventListener !== 'function') return;
    host.addEventListener('click', (event) => {
      const tab = event.target.closest && event.target.closest('.ca-tab[data-act="tab"]');
      if (!tab || tab.getAttribute('aria-disabled') === 'true') return;
      router.go({ name: tab.dataset.id || '' });
    });
    host.addEventListener('keydown', (event) => {
      const tab = event.target.closest && event.target.closest('.ca-tab');
      if (!tab || tab.getAttribute('aria-disabled') === 'true') return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        tab.click();
        return;
      }
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const items = Array.from(host.querySelectorAll('.ca-tab'));
      const idx = items.indexOf(tab);
      if (idx < 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? items.length - 1
          : (idx + step + items.length) % items.length;
      if (items[next] && typeof items[next].focus === 'function') items[next].focus();
    });
  }

  function bindEvents(root) {
    root.addEventListener('click', async (event) => {
      const openMore = root.querySelector && root.querySelector('.ca-more-wrap [data-asset-more]');
      if (openMore && !openMore.hidden && !event.target.closest('.ca-more-wrap')) {
        openMore.hidden = true;
        const trigger = openMore.closest('.ca-more-wrap')?.querySelector('[data-act="toggle-asset-more"]');
        if (trigger) { trigger.classList.remove('is-open'); trigger.setAttribute('aria-expanded', 'false'); }
      }
      const assetRow = event.target.closest('[data-go-asset]');
      if (assetRow) {
        if (S.route.name === 'overview' && NS.library && !(await NS.library.guardNavigation())) return;
        if (S.route.name === 'activity' && NS.activityController && !(await NS.activityController.guardNavigation())) return;
        router.go({ name: 'overview', assetId: assetRow.dataset.goAsset });
        NS.library?.revealAsset(assetRow.dataset.goAsset);
        return;
      }
      const el = event.target.closest('[data-act]');
      if (!el || el.getAttribute('aria-disabled') === 'true') return;
      const act = el.dataset.act;
      if (act === 'activity-history') event.preventDefault();
      const id = el.dataset.id || '';
      if (NS.library && NS.library.shouldGuard(act) && !(await NS.library.guardNavigation())) return;
      if (NS.library && await NS.library.handleClick(el)) return;
      if (NS.activityController && await NS.activityController.handleClick(el)) return;
      if (S.route.name === 'activity' && NS.activityController
        && ['tab', 'go-back', 'go-review', 'go-organize-settings', 'open-asset', 'go-inbox-asset', 'open-conversation', 'open-review-source', 'open-cleanup', 'open-cleanup-report', 'open-candidate', 'cand-decide'].includes(act)
        && !(await NS.activityController.guardNavigation())) return;
      const isWrite = WRITE_ACTIONS.has(act);
      if (isWrite) {
        el.classList.add('is-pending');
        el.setAttribute('disabled', 'disabled');
        el.setAttribute('aria-busy', 'true');
      }
      try {
        switch (act) {
          case 'go-back': {
            // 「返回」回到上一个界面：页面级导航一律压栈，栈里有来路就直接
            // router.back()——从系统活动点「看报告」进报告页，返回就回系统
            // 活动。栈空（深链进入/整页刷新丢栈）时按详情类型归位到对应主
            // 页面兜底（资产详情保留分类筛选）。
            if (Array.isArray(S.backStack) && S.backStack.length) {
              router.back();
              break;
            }
            const name = S.route.candidateId ? 'review'
              : (S.route.captureId || S.route.name === 'activity' || S.route.name === 'settings') ? 'activity'
                : 'overview';
            // 经验详情兜底落「我的认知」经验档。
            const category = name === 'overview'
              ? (S.route.experienceId || String(S.route.category || '') === 'experiences' ? 'experiences' : String(S.route.category || ''))
              : '';
            router.go({ name, category });
            break;
          }
          case 'toggle-asset-more': {
            const wrap = el.closest('.ca-more-wrap');
            const menu = wrap ? wrap.querySelector('[data-asset-more]') : null;
            if (menu) {
              menu.hidden = !menu.hidden;
              el.classList.toggle('is-open', !menu.hidden);
              el.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
            }
            break;
          }
          case 'refresh':
            await NS.reload();
            if (['activity', 'settings', 'cleanup'].includes(S.route.name)) await Promise.all([
              NS.loadInspection(true), NS.loadCleanupReports(true),
            ]);
            break;
          // 旧个人本体候选先转入 Recall 共同审核；不再直写 USER.md / MEMORY.md。
          case 'tab': router.go({ name: id }); break;
          case 'filter-cat': router.go({ name: 'overview', category: id }); break;
          // 目录视图切换：同一个列表页换一种行形态（模型视角），
          // 不新增 tab。assetView 必须进 router.go 的归一化白名单，否则被丢弃。
          case 'asset-view': router.go(id === 'tree' ? { name: 'tree' } : { name: 'overview', assetView: id === 'catalog' ? 'catalog' : '' }); break;
          case 'go-review': router.go({ name: 'activity' }); break;
          case 'go-run-review': {
            const runId = S.captureStats?.sweep?.receipt?.runId;
            if (runId) router.go({ name: 'activity', activityRunId: String(runId) });
            break;
          }
          case 'go-configure-model': {
            // configuration_required 的处理出口：模型配置在应用设置页
            // 「设置 → 配置」的模型区。与 model-chip.js / kb-workbench.js 同一条缝：
            // 设置页懒加载，tab 与锚点必须挂在 setView 上，否则落到默认的「数据」tab。
            if (typeof window.setView === 'function') {
              window.setView('settings', undefined, { settingsTab: 'configuration', settingsAnchor: 'models' });
            }
            if (typeof window.activateSettingsTab === 'function') {
              window.activateSettingsTab('configuration', { anchor: 'models' });
            }
            break;
          }
          case 'go-organize-settings': {
            router.go({ name: 'settings' });
            const focusOrganize = () => {
              const node = document.getElementById('ca-settings-organize');
              if (!node) return;
              node.scrollIntoView({ block: 'start' });
              if (typeof node.focus === 'function') node.focus({ preventScroll: true });
            };
            if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => window.requestAnimationFrame(focusOrganize));
            else focusOrganize();
            break;
          }
          case 'auto-approval-toggle':
            await NS.assetSettings.toggleAutoApproval();
            break;
          case 'nightly-model-add': case 'nightly-model-remove': case 'nightly-model-up':
          case 'nightly-model-down': case 'nightly-model-reset': case 'nightly-model-retry':
            await NS.assetSettings.modelAction(act, el, root);
            break;
          case 'nightly-window-save': case 'nightly-window-reset':
            await NS.assetSettings.windowAction(act, el, root);
            break;
          case 'nightly-toggle': {
            // 夜间发现统管对话发现与已有内容整理，不改变资产使用状态。
            const on = !(S.captureSettings && S.captureSettings.enabled !== false);
            if (on) {
              const ok = await NS.confirmUser(T('cognition.nightly_discovery_confirm', '开启夜间发现？系统将检查新对话并整理已有认知与本体，会消耗模型额度；已有内容的整理建议由你确认后保存。'));
              if (!ok) break;
            }
            const previous = S.captureSettings;
            const patch = { enabled: on };
            S.captureSettings = Object.assign({}, previous, patch);
            NS.notify();
            try {
              await A.updateCaptureSettings(patch);
            } catch (error) {
              S.captureSettings = previous;
              NS.notify();
              throw error;
            }
            break;
          }
          case 'nightly-scan-stop': await A.stopNightlyScan(); break;
          case 'deleted-retry': await A.loadDeletedAssets(true); break;
          case 'nightly-scan-now': {
            await A.runNightlyScanNow();
            break;
          }
          case 'open-review-source': {
            const [kind, targetId] = String(el.dataset.evidenceKey || '').split(':');
            const activity = ['candidate', 'asset'].includes(kind) && S.route.name === 'activity';
            const library = kind === 'asset' && S.route.name === 'overview';
            if (!targetId || (!activity && !library)) break;
            const result = await NS.api.call('recall.reviewEvidence.read', kind === 'candidate' ? { candidateId: targetId } : { assetId: targetId });
            const evidence = result.items?.find(item => item.ref?.id === id && item.ref?.kind === el.dataset.sourceKind);
            S.reviewEvidence = S.reviewEvidence || {};
            S.reviewEvidence[el.dataset.evidenceKey] = { loaded: true, items: result.items || [] };
            NS.notify();
            if (evidence?.state !== 'available' || !(evidence.openTarget || evidence.conversationId)) throw new Error(T('cognition.activity_source_changed', '来源内容发生变化，需要重新核对原文。'));
            const target = evidence.openTarget || { conversationId: evidence.conversationId };
            if (target.attachmentName) {
              const file = await window.cogseed.invoke('attachments.absPath', { cid: target.conversationId, name: target.attachmentName });
              if (!file?.ok || typeof openChatFileViewer !== 'function') throw new Error(T('cognition.source_unavailable_label', '来源记录不可用'));
              (activity ? NS.activityController : NS.library)?.closeForSourcePreview();
              await openChatFileViewer(file.path, target.attachmentName, { cid: target.conversationId });
            } else NS.openConversation(target.conversationId);
            break;
          }
          case 'open-conversation': NS.openConversation(id); break;
          case 'asset-timeline-retry': await NS.loadAssetTimeline(id, true); break;
          case 'asset-adoption-retry': await NS.loadAdoptionReceipts(id, true); break;
          case 'asset-versions-retry': await NS.loadAssetVersions(id, true); break;
          case 'activity-row': { const row = (S.activityRows || []).find(item => item.key === id); if (row) router.go(Object.assign({ name: 'activity', activityView: S.route.activityView || 'attention' }, currentRun(), row.route)); break; }
          case 'activity-page': router.go({ name: 'activity', ...currentRun(), activityView: S.route.activityView, activityQuery: S.route.activityQuery, activityPage: id }, { replace: true }); break;
          case 'open-candidate': router.go({ name: 'activity', ...currentRun(), candidateId: id }); break;
          case 'open-ontology': await NS.openPersonalOntology({ moduleId: el.dataset.moduleId || '', recordId: el.dataset.recordId || '', recordVersion: el.dataset.recordVersion || '' }); break;
          case 'open-asset': router.go({ name: 'overview', assetId: id }); NS.library?.revealAsset(id); break;
          case 'open-overview': router.go({ name: 'overview' }); break;
          case 'cand-adopt-with-form': await A.adoptCandidate(id, readCandidateForm(el) || undefined); break;
          case 'cand-decide': await A.decideCandidate(id, el.dataset.action); break;
          case 'asset-action': await A.assetAction(id, el.dataset.action); break;
          case 'asset-recommend-ack': await A.acknowledgeAssetRecommendation(id); break;
          case 'select-asset-version': await A.selectAssetVersion(id, el.dataset.version || ''); break;
          case 'go-inbox-asset': router.go({ name: 'overview', assetId: id }); NS.library?.revealAsset(id); break;
          // 进入整理报告页是页面级导航，必须入栈：
          // 此前两处带 replace:true，来源页（系统活动/资产设置）没进栈，返回
          // 时弹到更早逛过的历史页。就地状态翻转才用 replace，页面切换不用。
          case 'open-cleanup': router.go({ name: 'cleanup', cleanupReportId: '' }); break;
          case 'open-cleanup-report': router.go({ name: 'cleanup', cleanupReportId: String(el.dataset.report || '') }); break;
          case 'rollback-cleanup-item': await A.rollbackCleanupItem(id, el.dataset.version || ''); break;
          case 'cleanup-uncertain-dismiss': await A.decideCleanupItem(String(el.dataset.report || ''), id, 'reject'); break;
          case 'cleanup-uncertain-defer': await A.decideCleanupItem(String(el.dataset.report || ''), id, 'defer'); break;
          case 'delete-asset-version': await A.deleteAssetVersion(id, el.dataset.version || ''); break;
          case 'edit-asset': {
            // 进入/退出编辑态（纯路由切换，不压返回栈）。
            if (S.route.assetEdit) {
              const drafts = Object.assign({}, S.assetEditDrafts || {});
              delete drafts[id];
              S.assetEditDrafts = drafts;
            }
            router.go({ name: 'overview', assetId: String(S.route.assetId || ''), assetEdit: S.route.assetEdit ? '' : '1' }, { replace: true });
            break;
          }
          case 'asset-edit-save': await A.editAsset(id); break;
          case 'asset-edit-cancel': {
            const drafts = Object.assign({}, S.assetEditDrafts || {});
            delete drafts[id];
            S.assetEditDrafts = drafts;
            router.go({ name: 'overview', assetId: String(S.route.assetId || ''), assetEdit: '' }, { replace: true });
            break;
          }
          case 'asset-scope-options-retry':
            await A.loadAssetScopeOptions();
            break;
          case 'asset-scope-unrestrict': {
            const form = el.closest('.ca-asset-edit');
            const kind = String(el.dataset.kind || '');
            const field = kind === 'agent' ? 'agentIds' : kind === 'space' ? 'workspaceIds' : '';
            if (!form || !field || String(form.dataset.assetEditId || '') !== id) break;
            const drafts = S.assetEditDrafts || {};
            const current = drafts[id] || {};
            const scopeSelection = Object.assign({}, current.scopeSelection || {}, { [field]: [] });
            const scopeUnrestrict = Array.from(new Set([...(current.scopeUnrestrict || []), kind]));
            S.assetEditDrafts = Object.assign({}, drafts, {
              [id]: Object.assign({}, current, { scopeSelection, scopeUnrestrict }),
            });
            if (NS.library && S.route.name === 'overview') NS.library.state.dirty = true;
            NS.notify();
            break;
          }
          case 'edit-from-version':
            await A.editFromVersion(id, el.dataset.version || '');
            if (NS.library && S.route.assetEdit) NS.library.state.dirty = true;
            break;
          case 'merge-asset-version': await A.mergeAssetVersion(id, el.dataset.version || ''); break;
          case 'open-asset-version': {
            // 点版本行就地展开/收起（模式同 open-kstar-episode）：再点同一行
            // 收起；展开态只存路由键，数据已在 store.assetVersions 里。
            const prev = String(S.route.assetVersionId || '');
            const next = String(el.dataset.version || '');
            const open = next && next !== prev ? next : '';
            router.go({ name: 'overview', assetId: String(S.route.assetId || ''), assetVersionId: open }, { replace: true });
            break;
          }
          case 'diff-asset-version': {
            // 展开块内「与在用版对比」：就地开/收（数据已在渲染层，前端自算）。
            // 必须带全 route 上下文（含 assetVersionId）——否则展开块被默认值清掉。
            const cur = String(S.route.assetVersionDiff || '');
            const next = String(el.dataset.version || '');
            router.go({ name: 'overview', assetId: String(S.route.assetId || ''), assetVersionId: String(S.route.assetVersionId || ''), assetVersionDiff: next && next !== cur ? next : '' }, { replace: true });
            break;
          }
          case 'toggle-asset-versions-noise': {
            router.go({ name: 'overview', assetId: String(S.route.assetId || ''), assetVersionId: String(S.route.assetVersionId || ''), assetVersionsExpanded: S.route.assetVersionsExpanded ? '' : '1' }, { replace: true });
            break;
          }
          case 'open-kstar-episode': {
            // 再点同一 chip 或点「收起」（id 空）即收起；展开时拉详情。
            // 就地展开不动宿主页：保持当前 name 与全部详情上下文（候选/资产/采集/
            // 版本/经验键），只切 kstarEpisodeId——此前 name 硬编码 overview，
            // 在候选详情点复盘 chip 会整页跳走。
            const prev = String(S.route.kstarEpisodeId || '');
            const next = String(el.dataset.id || '');
            const open = next && next !== prev ? next : '';
            router.go({
              name: String(S.route.name || 'overview'),
              assetId: String(S.route.assetId || ''),
              candidateId: String(S.route.candidateId || ''),
              captureId: String(S.route.captureId || ''),
              assetVersionId: String(S.route.assetVersionId || ''),
              assetVersionDiff: String(S.route.assetVersionDiff || ''),
              experienceId: String(S.route.experienceId || ''),
              kstarEpisodeId: open,
            }, { replace: true });
            if (open) void NS.loadKstarEpisode(open);
            break;
          }
          case 'merge-asset': await A.mergeAssets(id, el.dataset.target || ''); break;
          /* ── 经验目录──────────────────────────── */
          case 'open-experience': router.go({ name: 'overview', category: 'experiences', experienceId: id }); break;
          case 'experience-status-toggle': await A.experienceStatusToggle(id, el.dataset.action || 'pause'); break;
          case 'experience-set-type': await A.experienceSetType(id, el.dataset.type || ''); break;
          case 'experience-merge': await A.experienceMerge(id, el.dataset.target || ''); break;
          case 'experience-archive': await A.experienceArchive(id); break;
          case 'experience-migration-preview': await A.experienceMigrationPreview(); break;
          case 'experience-migration-run': {
            // run 必须显式带 assetIds，禁止隐式批量：单条走
            // data-asset、批量走 data-assets（逗号分隔，来自可见的预览清单）。
            const ids = String(el.dataset.assets || el.dataset.asset || '')
              .split(',').map((value) => value.trim()).filter(Boolean);
            await A.experienceMigrationRun(ids);
            break;
          }
          case 'experience-migration-status': await A.experienceMigrationStatus(); break;
          case 'source-action': await A.sourceAction(el.dataset.kind || '', id, el.dataset.action); break;
          case 'proof-toggle':
            // 使用记录已并入资产详情：事件展开/收起保持在
            // 当前资产详情页内切换。
            router.go({
              name: 'overview',
              assetId: String(S.route.assetId || ''),
              // 带全上下文：使用记录与版本区同页，丢了
              // assetVersionId/kstarEpisodeId 会把就地展开的版本/复盘收起。
              assetVersionId: String(S.route.assetVersionId || ''),
              assetVersionDiff: String(S.route.assetVersionDiff || ''),
              kstarEpisodeId: String(S.route.kstarEpisodeId || ''),
              proofEventId: String(S.route.proofEventId) === id ? '' : id,
            });
            break;
          case 'proof-rate': {
            // 说明是可选的：先写再点评，说明随评价一起附上。
            const zone = el.closest('.ca-rating');
            const noteEl = zone ? zone.querySelector('textarea[data-f="note"]') : null;
            const note = noteEl ? String(noteEl.value || '').trim() : '';
            await A.rateProof(id, el.dataset.feedback, note ? { note } : undefined);
            break;
          }
          default: break;
        }
      } catch (error) {
        // 带错误码的走候选/晋升码表翻译；手动沉淀类错误走 capture 文案；
        // 都不是则透出原始消息（不吞失败）。
        const message = error && error.code && NS.recallErrorText
          ? NS.recallErrorText(error)
          : (NS.captureErrorText ? NS.captureErrorText(error) : String((error && error.message) || error));
        await NS.alertUser(message);
      } finally {
        NS.library?.actionFinished();
        // reload 重画后原元素已脱离文档，清理无害；未重画时恢复可点。
        if (isWrite) { el.classList.remove('is-pending'); el.removeAttribute('disabled'); el.removeAttribute('aria-busy'); }
      }
    });
    document.addEventListener('keydown', async (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (NS.library && await NS.library.handleKeydown(event)) return;
      if (event.key === 'Escape') {
        const more = root.querySelector && root.querySelector('.ca-more-wrap [data-asset-more]');
        if (more && !more.hidden) {
          more.hidden = true;
          const trigger = more.closest('.ca-more-wrap')?.querySelector('[data-act="toggle-asset-more"]');
          if (trigger) { trigger.classList.remove('is-open'); trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); }
          event.preventDefault();
          return;
        }
      }
      const overlay = document.querySelector?.('.ui-modal:not([hidden]), .ca-modal:not([hidden]), .chat-file-viewer.is-open');
      const overlayOpen = !!overlay && (typeof overlay.getClientRects !== 'function' || (!overlay.closest?.('[hidden]') && overlay.getClientRects().length > 0));
      if (event.key === 'Escape' && !event.defaultPrevented && !overlayOpen && (S.route.assetId || S.route.experienceId)) router.back();
    });
    // 树光斑悬停提示（原型 #tip 行为）：.spot 自带 data-title/data-sub，
    // 详情异步补数会触发整页重画；短期保存编辑中的控件值，views.js 会从
    // store 草稿恢复，避免用户输入被版本/回执/排序依据响应覆盖。
    root.addEventListener('input', (event) => {
      if (NS.library) void NS.library.handleInput(event);
      const field = event.target.closest && event.target.closest('.ca-asset-edit [data-f]');
      const form = field && field.closest('.ca-asset-edit');
      const assetId = form ? String(form.dataset.assetEditId || '') : '';
      const name = field ? String(field.dataset.f || '') : '';
      if (!assetId || !name) return;
      const drafts = S.assetEditDrafts || {};
      S.assetEditDrafts = Object.assign({}, drafts, {
        [assetId]: Object.assign({}, drafts[assetId] || {}, { [name]: String(field.value || '') }),
      });
    });
    root.addEventListener('change', (event) => {
      const categoryField = event.target.closest?.('.ca-asset-edit select[data-f="contentCategory"]');
      const categoryAssetId = categoryField?.closest('.ca-asset-edit')?.dataset.assetEditId;
      if (categoryAssetId) {
        S.assetEditDrafts = { ...S.assetEditDrafts, [categoryAssetId]: { ...S.assetEditDrafts?.[categoryAssetId], contentCategory: categoryField.value } };
      }
      if (NS.library) void NS.library.handleInput(event);
      const field = event.target.closest && event.target.closest('.ca-asset-edit input[data-scope-kind]');
      const form = field && field.closest('.ca-asset-edit');
      const assetId = form ? String(form.dataset.assetEditId || '') : '';
      const kind = field ? String(field.dataset.scopeKind || '') : '';
      if (!assetId || !['agent', 'space'].includes(kind)) return;
      const policyField = kind === 'agent' ? 'agentIds' : 'workspaceIds';
      const scopedInputs = Array.from(form.querySelectorAll(`input[data-scope-kind="${kind}"]`));
      const selected = scopedInputs.filter((input) => input.checked)
        .map((input) => String(input.dataset.scopeId || '')).filter(Boolean);
      const drafts = S.assetEditDrafts || {};
      const current = drafts[assetId] || {};
      const asset = (S.assets || []).find((item) => String(item.id) === assetId);
      const policy = asset && asset.scopePolicy && typeof asset.scopePolicy === 'object' ? asset.scopePolicy : {};
      const scopeUnrestrict = Array.isArray(current.scopeUnrestrict) ? current.scopeUnrestrict : [];
      const existingIds = Array.isArray(policy[policyField]) ? policy[policyField] : [];
      if (!selected.length && existingIds.length > 0 && !scopeUnrestrict.includes(kind)) {
        const priorSelection = current.scopeSelection && Object.prototype.hasOwnProperty.call(current.scopeSelection, policyField)
          ? current.scopeSelection[policyField] : existingIds;
        const priorIds = new Set(Array.isArray(priorSelection) ? priorSelection.map((value) => String(value)) : existingIds.map((value) => String(value)));
        scopedInputs.forEach((input) => { input.checked = priorIds.has(String(input.dataset.scopeId || '')); });
        NS.toast(T('cognition.asset_scope_edit_limit_note', '当前有限定范围：仅勾选对象可以使用。至少保留一个；要取消整项限制，请点“取消此项限制”。'), 'warning');
        return;
      }
      const scopeSelection = Object.assign({}, current.scopeSelection || {}, { [policyField]: selected });
      const nextScopeUnrestrict = scopeUnrestrict.filter((entry) => entry !== kind);
      S.assetEditDrafts = Object.assign({}, drafts, {
        [assetId]: Object.assign({}, current, { scopeSelection, scopeUnrestrict: nextScopeUnrestrict }),
      });
    });
    // 鼠标进出示一条跟随光标的黑底提示——树上节点密度高，常显标签会糊。
    const treeTip = () => document.getElementById('ca-tree-tip');
    root.addEventListener('mouseover', (event) => {
      const spot = event.target.closest && event.target.closest('.spot[data-title]');
      const tip = treeTip();
      if (!tip) return;
      if (!spot) { tip.classList.remove('show'); return; }
      const sub = spot.dataset.sub || '';
      tip.textContent = spot.dataset.title + (sub ? ` — ${sub}` : '');
      tip.classList.add('show');
    /* 坐标相对树画布；.ca-scroll 有 contain:paint，不能使用 fixed 视口坐标。 */
      const stage = tip.closest('.tree-stage');
      if (!stage) return;
      const stageRect = stage.getBoundingClientRect();
      const rect = tip.getBoundingClientRect();
      tip.style.left = `${Math.min(event.clientX - stageRect.left + 14, stageRect.width - rect.width - 12)}px`;
      tip.style.top = `${Math.max(8, event.clientY - stageRect.top - 40)}px`;
    });
    root.addEventListener('mouseout', (event) => {
      const spot = event.target.closest && event.target.closest('.spot[data-title]');
      if (!spot) return;
      const tip = treeTip();
      if (tip) tip.classList.remove('show');
    });
    // div[role=button] 控件（行、chip 单选、tab、折叠头）不含原生 button 的
    // 键盘激活，Enter/Space 在委托层统一转成 click，保持键盘可达。
    root.addEventListener('input', event => {
      if (event.target?.matches?.('[data-window-field]')) { NS.assetSettings.windowInput(event); return; }
      if (NS.activityController?.handleInput(event)) return;
      if (event.isComposing || event.target?.id !== 'ca-activity-search') return;
      router.go({ name: 'activity', ...currentRun(), activityView: S.route.activityView, activityDone: S.route.activityDone, activityQuery: event.target.value }, { replace: true });
    });
    root.addEventListener('change', event => {
      // 原生下拉的最终选择也写入草稿，覆盖只派发 change 的输入路径。
      if (event.target?.matches?.('.ca-activity-detail select[data-f]')) NS.activityController?.handleInput(event);
    });
    root.addEventListener('dragstart', event => NS.assetSettings.modelDragStart(event, root));
    root.addEventListener('dragover', event => NS.assetSettings.modelDragOver(event, root));
    root.addEventListener('drop', event => { void NS.assetSettings.modelDrop(event, root); });
    root.addEventListener('dragend', () => NS.assetSettings.clearModelDrag(root));
    root.addEventListener('keydown', event => { void NS.assetSettings.modelSortKeydown(event, root); });
    root.addEventListener('keydown', async (event) => {
      if (NS.activityController && await NS.activityController.handleKeydown(event)) return;
      if (event.isComposing || event.keyCode === 229 || (event.key !== 'Enter' && event.key !== ' ')) return;
      const el = event.target.closest && event.target.closest('[data-act][role="button"], [data-go-asset][role="button"], tr[data-act="activity-row"]');
      if (!el || el.getAttribute('aria-disabled') === 'true') return;
      event.preventDefault();
      el.click();
    });
    // tab 行方向键漫游：←/→ 移动焦点，
    // Home/End 跳首尾；tab 是 div[role=button]，无原生方向键语义。
    // 挂 root 委托——bindEvents 先于持久壳首次构建执行，挂 .ca-tabs 会落空。
    root.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabsNav = event.target.closest && event.target.closest('.ca-tabs');
      if (!tabsNav || !(event.target.closest && event.target.closest('.ca-tab'))) return;
      const items = Array.from(tabsNav.querySelectorAll('.ca-tab:not([aria-disabled="true"])'));
      const idx = items.indexOf(document.activeElement);
      if (idx < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? items.length - 1
          : (idx + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
      if (items[next] && typeof items[next].focus === 'function') items[next].focus();
    });
  }

  /* ────────────────────────── 生命周期 ────────────────────────── */

  // 整理进度的 4s 轮询已删：captures 写入经
  // recall store 广播 cognition:changed，订阅中枢直接重拉 captures 区块，
  // 状态推进实时到达，不再定时问。

  function panelVisible() {
    const panel = document.getElementById('panel-recall');
    if (!panel) return false;
    return panel.classList.contains('active') && !panel.hidden;
  }

  async function boot() {
    if (booted) return;
    const root = document.getElementById('ca-root');
    if (!root) return;
    booted = true;
    bindEvents(root);
    bindSidebarTabs(document.getElementById('sidebar-recall-nav'));
    // 焦点保持：内容区整体重绘后键盘焦点会
    // 静默落到 body，键盘用户得重新 Tab 整页。渲染前记录焦点控件的定位特征
    // （DOM id/data-key/data-act/data-go-asset），渲染后按特征找回同一控件；找不到时
    // 回落到当前页第一个可聚焦控件——焦点永不落 body。
    // 一次路由加载会连续 notify 每个区块；合并到一帧只做一次整页重建。
    let scheduledRender = 0;
    NS.onChange(() => {
      if (scheduledRender) return;
      const render = () => {
        scheduledRender = 0;
        const active = document.activeElement;
        const hadActivityDrawer = !!root.querySelector('.ca-activity-detail.is-drawer-open');
        const inScroll = active && active.closest && active.closest('#ca-scroll');
        const signature = inScroll ? {
          domId: active.id || '',
          act: active.dataset ? active.dataset.act || '' : '',
          id: active.dataset ? active.dataset.id || '' : '',
          goAsset: active.dataset ? active.dataset.goAsset || '' : '',
          dataKey: active.dataset ? active.dataset.key || (active.closest('[data-key]') && active.closest('[data-key]').dataset.key) || '' : '',
        } : null;
        NS.render();
        // Rendering resolves the default selection on first entry and filtering.
        if (panelVisible() && S.route.name === 'activity' && !S.route.captureId) {
          const id = S.route.candidateId || S.activityDetailTarget?.candidateId;
          if (id) void NS.loadReviewEvidence('candidate', id);
        }
        const scroll = document.getElementById('ca-scroll');
        if (!scroll) return;
        const drawer = scroll.querySelector('.ca-activity-detail.is-drawer-open');
        const scope = drawer || scroll;
        const focusable = el => !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
          && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0;
        const first = selector => Array.from(scope.querySelectorAll(selector)).find(focusable);
        // A native focused button may blur as soon as a decision disables it,
        // before this render captures its signature. Keep modal focus legal
        // across that await and after the saved action disappears from the DOM.
        if (!signature) {
          if (!panelVisible() || (!drawer && !hadActivityDrawer)) return;
          if (drawer?.contains(document.activeElement)) return;
          const fallback = drawer ? first('[data-act="activity-close"], button:not(:disabled)')
            : first('[data-act="activity-select"][aria-pressed="true"]') || first('[data-act="activity-select"]') || first('button, [role="button"]');
          fallback?.focus({ preventScroll: true });
          return;
        }
        let next = null;
        if (signature.domId) next = scope.querySelector(`#${CSS.escape(signature.domId)}`);
        if (!next && signature.dataKey) {
          const group = scope.querySelector(`[data-key="${CSS.escape(signature.dataKey)}"]`);
          if (group) next = group.querySelector('button');
        }
        if (!next && signature.goAsset) next = scope.querySelector(`[data-go-asset="${CSS.escape(signature.goAsset)}"]`);
        if (!next && signature.act) {
          const candidates = Array.from(scope.querySelectorAll(`[data-act="${CSS.escape(signature.act)}"]`)).filter(focusable);
          next = candidates.find((el) => !signature.id || (el.dataset && el.dataset.id === signature.id)) || candidates[0];
        }
        if (!focusable(next)) next = drawer ? first('[data-act="activity-close"], button:not(:disabled)')
          : hadActivityDrawer ? first('[data-act="activity-select"][aria-pressed="true"]') || first('[data-act="activity-select"]') || first('button, [role="button"]')
            : first('button, [role="button"]');
        if (next && typeof next.focus === 'function') next.focus({ preventScroll: true });
      };
      if (typeof requestAnimationFrame === 'function') scheduledRender = requestAnimationFrame(render);
      else { scheduledRender = 1; Promise.resolve().then(render); }
    });
    // 认知树按容器实测像素作画（原型 drawTree 同款）：宽度变了必须重画，
    // 否则 viewBox 与容器对不上，树会被拉伸。rAF 合帧 + 抖动守卫避免拖拽
    // 窗口时每像素一次全量重绘。
    let treeResizeFrame = 0;
    let lastTreeWidth = 0;
    window.addEventListener('resize', () => {
      if (S.route.name !== 'tree') return;
      const svg = document.getElementById('ca-tree-svg');
      const width = svg ? svg.clientWidth : 0;
      if (!width || width === lastTreeWidth) return;
      lastTreeWidth = width;
      if (treeResizeFrame) cancelAnimationFrame(treeResizeFrame);
      treeResizeFrame = requestAnimationFrame(() => { treeResizeFrame = 0; NS.render(); });
    });
    NS.render();
    // 订阅主进程认知变更广播（唯一刷新入口，重写）：可见性判定
    // 由 MutationObserver 注入，后台窗口零 IPC，回前台 flush 挂起区块。
    NS.setupChangeRail(panelVisible);
    await NS.loadRoute();
  }

  // Route readiness is separate from the application-wide refresh state.
  NS.onChange(() => { if (booted && panelVisible()) void NS.loadRoute(); });

  function scheduleBoot() {
    const panel = document.getElementById('panel-recall');
    if (!panel) return;
    const observer = new MutationObserver(() => {
      if (panelVisible()) {
        boot();
        // 面板回到前台：补拉隐藏期间挂起的区块（cognition:changed 中枢记账）。
        void NS.flushPendingRefresh();
      }
    });
    observer.observe(panel, { attributes: true, attributeFilter: ['class', 'hidden'], childList: true, subtree: false });
    // 面板可能已经处于激活态（深链进来）。
    if (panelVisible()) boot();
  }

  // 范围编辑器和受限候选详情按需读取 Agent / 空间名称；普通浏览资产时
  // 不额外加载目录，候选卡只有在确实展示这些权限边界时才读一次。
  let scopeOptionsRouteKey = '';
  NS.onChange(() => {
    if (!panelVisible()) return;
    const activeAssetId = S.route.name === 'overview' && S.route.assetEdit === '1'
      ? String(S.route.assetId || '') : '';
    const candidateRoute = S.route.name === 'activity';
    const needsCandidateDirectory = candidateRoute && (Array.isArray(S.candidates) ? S.candidates : []).some((candidate) => {
      const policy = candidate && candidate.scopePolicy && typeof candidate.scopePolicy === 'object' ? candidate.scopePolicy : {};
      return (Array.isArray(policy.agentIds) && policy.agentIds.length > 0)
        || (Array.isArray(policy.workspaceIds) && policy.workspaceIds.length > 0);
    });
    const nextKey = activeAssetId
      ? `asset:${activeAssetId}`
      : needsCandidateDirectory ? `candidate:${S.route.name}:${String(S.route.candidateId || S.route.captureId || '')}` : '';
    if (nextKey === scopeOptionsRouteKey) return;
    scopeOptionsRouteKey = nextKey;
    if (nextKey) void A.loadAssetScopeOptions();
  });

  // 详情页兜底加载上下文：返回栈回退/深链进入时没有经过 open-capture-detail
  // 分流，这里按当前路由补拉（loadCaptureContext 内部有缓存判重）。
  NS.onChange(() => {
    if (!panelVisible()) return;
    if (S.route.name === 'settings') void NS.assetSettings.loadModels();
    const captureId = String(S.route.captureId || '');
    const experienceRouteId = String(S.route.experienceId || '');
    if (captureId && (!S.captureContext || S.captureContext.captureId !== captureId)) {
      void NS.loadCaptureContext(captureId);
    }
    // Compact details need only content/boundaries. Editing may need snapshots;
    // versions/usage/ranking otherwise belong to their explicit dialog entry.
    const assetId = String(S.route.assetId || '');
    if (assetId && S.route.assetEdit === '1' && (!S.assetVersions || S.assetVersions.assetId !== assetId)) {
      void NS.loadAssetVersions(assetId);
    }
    if (assetId) void NS.loadAssetEvidence(assetId);
    const candidate = S.candidates.find(item => item.id === (S.route.candidateId || S.activityDetailTarget?.candidateId));
    if (S.route.name === 'activity' && candidate?.ontologyFormation) void NS.loadActivityOntology();
    const candidateAssetId = candidate?.promotedAssetId || candidate?.targetAssetId;
    if (S.route.name === 'activity' && candidateAssetId) {
      if (S.assetVersions?.assetId !== candidateAssetId) void NS.loadAssetVersions(candidateAssetId);
      void NS.loadAssetEvidence(candidateAssetId);
    }
    const approval = (S.assetApprovals || []).find(item => String(item.id) === String(S.route.approvalId || S.activityDetailTarget?.approvalId || ''));
    if (S.route.name === 'activity' && approval && (!S.assetVersions || S.assetVersions.assetId !== approval.assetId)) {
      void NS.loadAssetVersions(approval.assetId);
      void NS.loadAssetEvidence(approval.assetId);
    }
    // 整理报告：进整理相关页签就补拉一次（内部有缓存判重）。沉淀设置页的
    // 大扫除 section也要最近报告摘要，一并补拉。
    // 「已删除」页签：保留期剩余天数由服务端现算，进这个页签时补拉一次。
    if (String(S.route.category || '') === 'deleted') void A.loadDeletedAssets();
    if (['cleanup', 'settings', 'activity'].includes(String(S.route.name || ''))) {
      void NS.loadCleanupReports();
    }
    // 自动维护合并卡：settings 页内嵌「最近检查」行，巡检数据
    // 门控补 'settings'——直接落资产设置时不再漏拉（此前开关恒显假「关」）。
    if (['cleanup', 'settings', 'activity'].includes(String(S.route.name || ''))) {
      void NS.loadInspection();
    }
    // 会话标题同理：证据来源与使用记录里的 cid 要翻成
    // 会话名，五处展示同名；来源目录 100 条窗口外的会话靠这个批量口补齐。
    if (assetId) void NS.loadConversationTitles(assetId);
    if (String(S.route.name || '') === 'overview' && !experienceRouteId) {
      if (!S.assetScopeOptions || S.assetScopeOptions.status === 'idle') void A.loadAssetScopeOptions();
      if (S.libraryView?.status === 'deleted' || S.libraryView?.status === 'all') void A.loadDeletedAssets();
    }
    // 候选详情的 kse 证据 chip 也读取真实目标摘要，不能只覆盖资产详情。
    const candidateId = String(S.route.candidateId || '');
    if (candidateId) {
      const cand = S.candidates.find((c) => String(c.id) === candidateId);
      if (cand) {
        const candRefs = [...(cand.sourceRefs || []), ...(cand.evidenceRefs || [])];
        void NS.loadConversationTitlesByIds(candRefs);
      }
    }
    // Only the legacy catalog exposes model-selected attachments.
    if (S.route.assetView === 'catalog') void NS.loadModelSelectedAssets();
    // The normal library has no experience counter; read its directory on demand.
    if (S.route.category === 'experiences' || experienceRouteId) {
      void NS.loadExperiences();
      if (experienceRouteId) {
        void NS.loadExperienceDetail(experienceRouteId);
        const loaded = S.experienceDetail;
        if (loaded && !loaded.loading && loaded.experience) {
          const refs = loaded.experience.evidenceRefs || [];
          void NS.loadConversationTitlesByIds(refs);
        }
      }
    }
  });

  /** 静默刷新指示：同页 reload（操作后/轮询）期间顶部走一条细进度条。
   *  首载不走这里（那时是骨架）；放在 render 之后执行，避免给旧 DOM 挂类。 */
  function syncRefreshIndicator() {
    const app = document.querySelector('#ca-root .ca-app');
    if (!app) return;
    app.classList.toggle('is-refreshing', Boolean(S.loading && S.loaded));
  }
  NS.onChange(() => { requestAnimationFrame(syncRefreshIndicator); });

  /* 排序依据装载器：视图通过 NS.rankingWhy 读取结果，与 NS.api 的跨层发布方式一致。 */

  /** 该资产最近一次真实使用的回合 id：使用记录时间线（refs.taskRunId）优先，
   *  采用回执兜底；都没有 = ''（视图按「这一轮没有进入目录」如实呈现）。 */
  function latestTurnForAsset(assetId) {
    const id = String(assetId || '');
    const detail = S.assetTimeline;
    const proofs = detail?.assetId === id && !detail.loading && !detail.failed && Array.isArray(detail.items)
      ? detail.items : S.proofs;
    const fromProofs = (Array.isArray(proofs) ? proofs : [])
      .filter((p) => String(((p && p.refs) || {}).assetId || '') === id && String(((p && p.refs) || {}).taskRunId || ''))
      .sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')));
    if (fromProofs.length) return String(fromProofs[0].refs.taskRunId || '');
    const adoptions = (S.adoptionReceipts && String(S.adoptionReceipts.assetId || '') === id
      && Array.isArray(S.adoptionReceipts.items)) ? S.adoptionReceipts.items : [];
    const newest = [...adoptions].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
    return newest ? String(newest.taskRunId || '') : '';
  }

  let rankingWhyLast = { assetId: '', turnId: null };
  /** 详情「为什么这一轮排在前面」：先定位回合，再查该回合该资产的回执拆解。
   *  同资产同回合只拉一次；换回合（新一轮使用记录落进时间线）会自动重拉。 */
  async function loadRankingWhy(assetId, force) {
    const id = String(assetId || '');
    if (!id) return;
    const turnId = latestTurnForAsset(id);
    if (!force && NS.rankingWhy && rankingWhyLast.assetId === id && rankingWhyLast.turnId === turnId) return;
    rankingWhyLast = { assetId: id, turnId };
    const state = NS.rankingWhy = { assetId: id, loading: true };
    NS.render();
    let next;
    try {
      let item = null;
      if (turnId) {
        const result = await NS.api.call('recall.catalog.ranking', { taskRunId: turnId, assetId: id, limit: 1 });
        item = (Array.isArray(result.items) ? result.items : [])[0] || null;
      }
      next = { assetId: id, ...(turnId ? { turnId } : {}), ...(item ? { item } : {}) };
    } catch (error) {
      next = { assetId: id, ...(turnId ? { turnId } : {}), failed: true, error: String((error && error.message) || error) };
    }
    // 回执到达前用户已切走/换资产/换回合：这帧作废（不把 A 资产的拆解画给
    // B 资产，也不把旧回合的拆解盖到新回合上——与发起判重双键对称）。
    if (NS.rankingWhy !== state) return;
    NS.rankingWhy = next;
    NS.notify();
  }

  NS.loadRankingWhy = loadRankingWhy;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleBoot, { once: true });
  } else {
    scheduleBoot();
  }

  // 语言切换：视图全部在渲染时取文案。持久壳的页签标题也是渲染产物，
  // 传 rebuild 让壳整体重建跟上新语言（旧实现曾在 skills-bindings.js 里
  // 重画，随瘦身丢失）。
  window.addEventListener('i18n-change', () => { if (booted) NS.render({ rebuild: true }); });
})();
