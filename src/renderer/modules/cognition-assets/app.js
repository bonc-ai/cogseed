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

  /** 写操作集合：点击后按钮进入 pending（禁用+变淡），完成或重画后还原。 */
  const WRITE_ACTIONS = new Set([
    'refresh', 'cand-adopt-with-form', 'cand-decide',
    'asset-action', 'asset-recommend-ack', 'select-asset-version', 'delete-asset-version',
    'run-cleanup', 'rollback-cleanup-item', 'cleanup-uncertain-dismiss', 'cleanup-uncertain-defer',
    'inspection-toggle', 'run-inspection', 'run-maintenance', 'purge-deleted-asset', 'inbox-resolve', 'asset-edit-save', 'edit-from-version', 'merge-asset-version', 'merge-asset', 'source-action', 'capture-action', 'organize-conv',
    // A5（2026-09-29）：候选清单读失败的显式重试。
    'retry-candidates',
    // 治理待办就地处断（specs/010 T010）：冲突选边、巡检选边/合并。全部经
    // cognition.inbox.resolve（core.actions 转发，不在渲染层写）。扩权/定级
    // 两类动作已随敏感级机制整体删除（2026-09-28）；「补条件」就地表单已随
    // 两页重整删除，inbox-boundary-save 暂留死码——cognition-actions.json
    // fixture 钉住该 act（双向一致不变量），待 fixture 同步删除后一并清理。
    'inbox-conflict-claim',
    'inbox-inspection-keep', 'inbox-inspection-merge',
    'inbox-boundary-save',
    'capture-review-toggle', 'proof-rate',
    'capture-batch',
    // 经验目录管理（specs/016 US-803）：四个管理动作 + 迁移执行；preview/status
    // 是只读扫描，不进 pending 集（与 refresh 的口径不同：它们有各自的载入态）。
    'experience-status-toggle', 'experience-set-type', 'experience-merge', 'experience-archive', 'experience-migration-run',
    'legacy-memory-run', 'legacy-scoped-memory-run',
    // 标签系统（specs/012 US-201）：单打标/移除/批量执行/管理三动作都是写通道。
    'tag-add', 'tag-remove', 'tag-batch-run', 'tag-rename-save', 'tag-merge-confirm', 'tag-delete',
    // 「记一条」保存（设计 7.2）：走 recall.candidates.save 产生候选。
    'cand-create-save',
    // ranking-weights-save 已随权重卡彻底移除删除（G1 拍板项 #3，2026-09-28）。
  ]);

  /* ────────────────────────── 事件委托 ────────────────────────── */

  function readCandidateForm(anchorEl) {
    // 就近读取（2026-09-15 内嵌表单后一页可能有多张候选卡）：从被点的按钮
    // 向上找最近的表单卡；无锚点时退回全局第一张（兼容旧调用）。
    const card = anchorEl && anchorEl.closest
      ? anchorEl.closest('.ca-candidate-detail')
      : document.querySelector('.ca-candidate-detail');
    if (!card) return null;
    // 只读候选（无任何表单控件）时返回 null：调用方按「未携带编辑」处理，
    // 防止一次「保存并使用」用空串覆盖已有内容。
    if (!card.querySelector('[data-f]')) return null;
    const value = (name) => {
      const el = card.querySelector(`[data-f="${name}"]`);
      return el ? String(el.value || '') : '';
    };
    return {
      suggestedType: String(card.dataset.candType || ''),
      suggestedScope: value('scope'),
      summary: value('summary'),
      judgment: value('judgment'),
      ...(card.querySelector('[data-f="value"]') ? { value: value('value') } : {}),
      ...(card.querySelector('[data-f="uncertainty"]') ? { uncertainty: value('uncertainty') } : {}),
    };
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
      if (assetRow) { router.go({ name: 'overview', assetId: assetRow.dataset.goAsset }); return; }
      const el = event.target.closest('[data-act]');
      if (!el) return;
      const act = el.dataset.act;
      const id = el.dataset.id || '';
      const isWrite = WRITE_ACTIONS.has(act);
      if (isWrite) {
        el.classList.add('is-pending');
        el.setAttribute('disabled', 'disabled');
        el.setAttribute('aria-busy', 'true');
      }
      try {
        switch (act) {
          case 'go-back': {
            // 「返回」= 回到上一个界面（2026-09-29 子安定稿，推翻 09-17 的
            // "按文案回列表"口径）：页面级导航一律压栈，栈里有来路就直接
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
            // 经验详情兜底落「我的认知」经验档（specs/017 整改一：经验页签已收编）。
            const category = name === 'overview'
              ? (S.route.experienceId || String(S.route.category || '') === 'experiences' ? 'experiences' : String(S.route.category || ''))
              : '';
            router.go({ name, category });
            break;
          }
          case 'cand-type': {
            // 类型选择是纯前端态：只更新 chip 选中与卡片 dataset，不触发重画
            // （整页重画会丢失其他字段未保存的输入）。
            const card = el.closest('.ca-candidate-detail');
            if (card) card.dataset.candType = id;
            el.parentElement.querySelectorAll('.ca-chip-opt').forEach((chipEl) => {
              const on = chipEl === el;
              chipEl.classList.toggle('is-green', on);
              chipEl.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
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
          case 'refresh': await NS.reload({ tree: true }); await NS.reload(); break;
          case 'tab': router.go({ name: id }); break;
          case 'filter-cat': router.go({ name: 'overview', category: id }); break;
          // 目录视图切换（2026-09-18）：同一个列表页换一种行形态（模型视角），
          // 不新增 tab。assetView 必须进 router.go 的归一化白名单，否则被丢弃。
          case 'asset-view': router.go(id === 'tree' ? { name: 'tree' } : { name: 'overview', assetView: id === 'catalog' ? 'catalog' : '' }); break;
          // 「管理」模式（specs/018 T031）：目录视图/批量打标/多选默认不可见，
          // 小切换入口收在这里——普通用户默认视图永远只见列表。
          case 'overview-manage-toggle': {
            // 退出判定看「有效管理态」（manage=1 或 catalog 深链或多选），
            // 不能只看 manage 旗标——目录深链进来时 manage='' 但身在管理态，
            // 按 manage 判会把它误判成「进入管理」（迭代轮 1 真机抓出）。
            const inManage = String(S.route.manage || '') === '1'
              || String(S.route.assetView || '') === 'catalog'
              || String(S.route.tagSelect || '') === '1';
            router.go(Object.assign({}, S.route, {
              name: 'overview',
              manage: inManage ? '' : '1',
              // 退出＝回普通视图：目录视图与多选态一并清掉，防
              // manageMode 恒真（出不去）或批量条漏进默认视图。
              assetView: inManage ? '' : String(S.route.assetView || ''),
              tagSelect: inManage ? '' : String(S.route.tagSelect || ''),
            }));
            break;
          }
          case 'go-review': router.go({ name: 'review' }); break;
          // 导语可点数字（specs/018 T010）：滚动到本页对应分区（纯呈现，
          // 不动路由栈——这是页内锚点跳转，不是导航）。
          case 'review-jump': {
            const target = document.getElementById(id);
            if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            break;
          }
          case 'go-organize': router.go({ name: 'activity' }); break;
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
          case 'toggle-source-issues': {
            // 来源异常就地展开（异常驱动：健康时无入口，无常态页）。
            router.go({
              name: 'review',
              sourceIssueOpen: String(S.route.sourceIssueOpen || '') === 'open' ? '' : 'open',
            });
            break;
          }
          case 'toggle-task-failed': {
            // 任务执行失败就地展开（A4，2026-09-29）：逐条列出并给「回到会话」
            // 入口——不再跳系统活动页（那边是低价值排除行，处理不了）。
            router.go({
              name: 'review',
              taskFailedOpen: String(S.route.taskFailedOpen || '') === 'open' ? '' : 'open',
            });
            break;
          }
          case 'retry-candidates': {
            // A5（2026-09-29）：候选清单读失败后的显式重试入口。
            await NS.reload();
            break;
          }
          case 'inbox-boundary-save': {
            // A1（2026-09-29）：缺边界规则的就地补条件表单（specs/010 T028 恢复）。
            // 值就近读本行输入，多值按顿号/逗号拆；空数组也如实提交——后端用
            // 同一道规则闸门判合法性，不通过会带着原因拒绝（不落库）。
            const row = el.closest('.notice-row');
            const readList = (fieldName) => {
              const input = row ? row.querySelector(`[data-f="${fieldName}"]`) : null;
              return String((input && input.value) || '')
                .split(/[、,，;；]/).map((part) => part.trim()).filter(Boolean);
            };
            await A.resolveInboxItem(id, 'set_boundary', {
              applicableWhen: readList('boundary-applicable'),
              forbiddenWhen: readList('boundary-forbidden'),
            });
            break;
          }
          case 'go-organize-settings': router.go({ name: 'settings' }); break;
          case 'nightly-toggle': {
            // 自动维护总开关（2026-09-29 合并）：开 = nightly（并联动「先问我」
            // ——产出进「待我处理」等批准，而非自动采纳）+ 同步启停定期检查
            // （一个开关管两件事：夜间整理对话 + 定期检查资产库）；关 = 回到
            // 纯手动、巡检一并停。开启是额度消耗行为：先确认。
            const on = !(S.captureSettings && String(S.captureSettings.executionPolicy || '') === 'nightly');
            if (on) {
              const ok = await NS.confirmUser(T('cognition.nightly_capture_confirm', '开启后，系统会在夜间自动整理当天结束的会话（消耗模型额度），并定期检查资产库。产出的建议都会先给你过目。确认开启？'));
              if (!ok) break;
            }
            const previous = S.captureSettings;
            const previousInspection = S.inspection;
            const patch = on
              ? { executionPolicy: 'nightly', reviewPolicy: 'manual' }
              : { executionPolicy: 'manual' };
            S.captureSettings = Object.assign({}, previous, patch);
            NS.notify();
            try {
              await A.updateCaptureSettings(patch);
              await A.setInspectionEnabled(on, { silent: true });
            } catch (error) {
              S.captureSettings = previous;
              S.inspection = previousInspection;
              NS.notify();
              throw error;
            }
            break;
          }
          case 'capture-filter': router.go({ name: 'activity', captureBucket: id }); break;
          case 'open-capture-detail': {
            router.go({ name: 'activity', captureId: id });
            void NS.loadCaptureContext(id);
            break;
          }
          case 'open-conversation': NS.openConversation(id); break;
          case 'asset-timeline-retry': await NS.loadAssetTimeline(id, true); break;
          case 'asset-adoption-retry': await NS.loadAdoptionReceipts(id, true); break;
          case 'asset-versions-retry': await NS.loadAssetVersions(id, true); break;
          case 'capture-batch': {
            // 批量动作的条数在渲染时写死进按钮（只数当前已加载且该动作可执行
            // 的行）；这里再次从 store 收敛同一口径，防止路由/数据在确认弹窗
            // 与执行之间变动后多发。只保留批量重试（2026-09-21 原型 v7 定调：
            // 批量「立即整理」入口不迁移，单条任务行的立即整理保留）。
            const runnable = (S.captures || []).filter((capture) => (
              Array.isArray(capture.actions) && capture.actions.includes(el.dataset.batch || '')
            ));
            if (!runnable.length || el.dataset.batch !== 'retry') break;
            const ok = await NS.confirmUser(T('cognition.capture_batch_retry_confirm', '确认重试 {n} 条失败的整理任务？', { n: String(runnable.length) }));
            if (!ok) break;
            await A.captureBatch('retry', runnable.map((capture) => capture.id));
            break;
          }
          case 'open-candidate': router.go({ name: 'review', candidateId: id }); break;
          // 「记一条」（设计 7.2）：手动新建候选——列表页头/空态入口，表单卡
          // 就地展开（candCreate 路由参数），保存走 recall.candidates.save。
          case 'cand-create': router.go({ name: 'overview', candCreate: '1' }); break;
          case 'cand-create-cancel': router.go({ name: 'overview', candCreate: '' }, { replace: true }); break;
          case 'cand-create-save': await A.saveManualCandidate(readCandidateForm(el) || undefined); break;
          case 'open-ontology': await NS.openPersonalOntology(); break;
          case 'open-asset': router.go({ name: 'overview', assetId: id }); break;
          case 'open-overview': router.go({ name: 'overview' }); break;
          case 'cand-adopt-with-form': await A.adoptCandidate(id, readCandidateForm(el) || undefined); break;
          case 'cand-decide': await A.decideCandidate(id, el.dataset.action); break;
          case 'asset-action': await A.assetAction(id, el.dataset.action); break;
          case 'asset-recommend-ack': await A.acknowledgeAssetRecommendation(id); break;
          case 'select-asset-version': await A.selectAssetVersion(id, el.dataset.version || ''); break;
          case 'run-maintenance': await A.runMaintenance(); break;
          case 'run-cleanup': await A.runCleanup(); break;
          case 'inspection-toggle': await A.setInspectionEnabled(!(S.inspection && S.inspection.settings && S.inspection.settings.enabled)); break;
          case 'run-inspection': await A.runInspection(); break;
          case 'purge-deleted-asset': {
            // 真机修复（2026-09-26 T035 取证抓出）：此处曾裸调 confirmUser ——
            // helper 定义在 core.js 闭包、经 NS.confirmUser 暴露，裸引用直接
            // ReferenceError，「立即彻底删除」按钮在真机上一直点不动（测试只打
            // core 动作层， delegation 层的裸引用漏网）。
            const ok = await NS.confirmUser(T('cognition.deleted_purge_confirm', '彻底删除后内容与记录一并清除、不可恢复。确认删除？'), true);
            if (ok) await A.purgeDeletedAsset(id);
            break;
          }
          case 'inbox-resolve': await A.resolveInboxItem(id, el.dataset.action || ''); break;
          /* ── 治理待办就地处断（specs/010 T010 / contracts/renderer-seams §3）─────────
           *  剩冲突选边与巡检选边/合并，全部经 core.actions 走 cognition.inbox.resolve。
           *  扩权/定级档位选择与「补条件」表单已随敏感级机制/两页重整删除
           *  （2026-09-28）；inbox-boundary-save 的 case 留作 fixture 钉住的
           *  死码（见 WRITE_ACTIONS 注释），无渲染入口。 */
          case 'inbox-boundary-save': {
            // 就地读 [data-f]（契约 §4）：多值按顿号/逗号分隔，与资产编辑同口径。
            const form = el.closest('[data-inbox-boundary-form]');
            if (!form) break;
            const readList = (field) => String((form.querySelector(`[data-f="${field}"]`) || {}).value || '')
              .split(/[、,，]/).map((value) => value.trim()).filter(Boolean);
            await A.resolveInboxItem(id, 'set_boundary', {
              applicableWhen: readList('applicableWhen'),
              forbiddenWhen: readList('forbiddenWhen'),
            });
            break;
          }
          case 'inbox-conflict-claim': await A.resolveInboxItem(id, 'claim'); break;
          case 'inbox-inspection-keep': await A.resolveInboxItem(id, 'keep', { targetAssetId: el.dataset.anchor || '' }); break;
          case 'inbox-inspection-merge': await A.resolveInboxItem(id, 'merge', { targetAssetId: el.dataset.anchor || '' }); break;
          case 'go-inbox-asset': router.go({ name: 'overview', assetId: id }); break;
          // 进入整理报告页是页面级导航，必须入栈（2026-09-29 返回跳错根因）：
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
          case 'asset-use-in-chat': await A.attachAssetToConversation(id); break;
          /* ── 标签系统（specs/012 US-201，T010~T013）──────────────────────────
           *  路由类（筛选/多选/弹层开合/行内编辑态）走 router.go 或 store；
           *  写类转调 core.actions 的标签动作（recall.assets.tags.* / recall.tags.*）。 */
          case 'filter-tag': {
            // 标签 chip 多选（默认并集）：点名切换，独立于类型筛选（AND 叠加）。
            const state = NS.parseTagFilterRoute(S.route);
            const key = (value) => String(value || '').trim().toLocaleLowerCase();
            const names = state.names.some((entry) => key(entry) === key(id))
              ? state.names.filter((entry) => key(entry) !== key(id))
              : [...state.names, id];
            router.go({ name: 'overview', category: String(S.route.category || ''), assetView: String(S.route.assetView || ''), tagFilter: NS.joinTagFilter(names), tagMode: state.mode === 'all' ? 'all' : '', tagUntagged: String(S.route.tagUntagged || '') === '1' ? '1' : '', tagSelect: String(S.route.tagSelect || '') === '1' ? '1' : '' });
            break;
          }
          case 'filter-tag-mode': {
            const next = el.dataset.mode === 'all' ? 'all' : '';
            router.go({ name: 'overview', category: String(S.route.category || ''), assetView: String(S.route.assetView || ''), tagFilter: String(S.route.tagFilter || ''), tagMode: next, tagUntagged: String(S.route.tagUntagged || '') === '1' ? '1' : '', tagSelect: String(S.route.tagSelect || '') === '1' ? '1' : '' });
            break;
          }
          case 'filter-untagged': {
            // 「未分类」筛选生效时顺手进入多选态（renderer-seams §1：批量补标入口）；
            // 取消「未分类」时保持用户原有的多选态，不强行退出。
            const on = String(S.route.tagUntagged || '') === '1';
            const keepSelect = String(S.route.tagSelect || '') === '1' ? '1' : '';
            router.go({ name: 'overview', category: String(S.route.category || ''), assetView: String(S.route.assetView || ''), tagFilter: String(S.route.tagFilter || ''), tagMode: String(S.route.tagMode || '') === 'all' ? 'all' : '', tagUntagged: on ? '' : '1', tagSelect: on ? keepSelect : '1' });
            break;
          }
          case 'tag-more': {
            router.go({ name: 'overview', category: String(S.route.category || ''), assetView: String(S.route.assetView || ''), tagFilter: String(S.route.tagFilter || ''), tagMode: String(S.route.tagMode || '') === 'all' ? 'all' : '', tagUntagged: String(S.route.tagUntagged || '') === '1' ? '1' : '', tagSelect: String(S.route.tagSelect || '') === '1' ? '1' : '', tagOverlay: 'more' });
            break;
          }
          case 'tag-manage': {
            router.go(Object.assign({}, S.route, { tagOverlay: 'manage' }));
            break;
          }
          case 'tag-overlay-close': {
            router.go(Object.assign({}, S.route, { tagOverlay: '' }), { replace: true });
            break;
          }
          case 'tag-add': {
            // 预设候选（点已有标签 chip）优先；否则读输入框当前值。
            const preset = el.dataset.preset === '1' ? String(el.dataset.name || '') : '';
            const input = preset ? null : root.querySelector(`[data-tag-input][data-asset-id="${CSS.escape(String(id))}"]`);
            const name = preset || (input ? String(input.value || '') : '');
            await A.addAssetTag(id, name);
            if (input) input.value = '';
            break;
          }
          case 'tag-remove': await A.removeAssetTag(id, el.dataset.name || ''); break;
          case 'tag-select-mode': {
            // 进入/退出多选：退出时清选择（下次进入从零开始）。
            const entering = String(S.route.tagSelect || '') !== '1';
            if (!entering) S.tagSelectIds = [];
            router.go({ name: 'overview', category: String(S.route.category || ''), assetView: String(S.route.assetView || ''), tagFilter: String(S.route.tagFilter || ''), tagMode: String(S.route.tagMode || '') === 'all' ? 'all' : '', tagUntagged: String(S.route.tagUntagged || '') === '1' ? '1' : '', tagSelect: entering ? '1' : '' }, { replace: true });
            NS.notify();
            break;
          }
          case 'tag-select-toggle': {
            const selected = new Set((S.tagSelectIds || []).map(String));
            if (selected.has(String(id))) selected.delete(String(id));
            else selected.add(String(id));
            S.tagSelectIds = [...selected];
            NS.notify();
            break;
          }
          case 'tag-select-all': {
            // 全选本页 = 当前筛选（类型 + 标签）后的可见列表；kstar 档按归边
            // 判定取（与 viewOverview 的 filtered 同一口径）。
            const hidden = ['archived', 'deleted', 'purged', 'revoked'];
            const state = NS.parseTagFilterRoute(S.route);
            const tagActive = Boolean(state.names.length || state.untagged);
            S.tagSelectIds = (S.assets || [])
              .filter((a) => !hidden.includes(String(a.status || 'active')))
              .filter((a) => {
                if (String(S.route.category || '') === 'kstar') return NS.isKstarAsset(a);
                if (S.route.category) return a.type === S.route.category;
                return true;
              })
              .filter((a) => (tagActive ? NS.matchesTagFilter(a, state.names, state.untagged, state.mode) : true))
              .map((a) => String(a.id));
            NS.notify();
            break;
          }
          case 'tag-select-clear': S.tagSelectIds = []; NS.notify(); break;
          case 'tag-batch-op': {
            const op = ['add', 'remove', 'replace'].includes(String(el.dataset.op || '')) ? String(el.dataset.op) : 'add';
            S.tagBatchOp = op;
            NS.notify();
            break;
          }
          case 'tag-batch-run': {
            const input = root.querySelector('[data-tag-batch-input]');
            const names = String(input ? input.value || '' : '')
              .split(/[、;；,，\n]/).map((value) => value.trim()).filter(Boolean);
            await A.batchTags(names);
            if (input && !(S.tagBatch && S.tagBatch.failed && S.tagBatch.failed.length)) input.value = '';
            break;
          }
          case 'tag-batch-dismiss': S.tagBatch = null; NS.notify(); break;
          case 'tag-rename': S.tagManageEdit = String(id || ''); S.tagManageMerge = null; NS.notify(); break;
          case 'tag-rename-save': await A.renameTag(id); break;
          case 'tag-rename-cancel': S.tagManageEdit = ''; NS.notify(); break;
          case 'tag-merge': S.tagManageMerge = { sourceId: String(id || ''), targetName: '' }; S.tagManageEdit = ''; NS.notify(); break;
          case 'tag-merge-target': {
            if (!S.tagManageMerge || String(S.tagManageMerge.sourceId) !== String(id)) break;
            S.tagManageMerge = { ...S.tagManageMerge, targetName: String(el.dataset.name || '') };
            NS.notify();
            break;
          }
          case 'tag-merge-confirm': {
            const state = S.tagManageMerge;
            if (!state || String(state.sourceId) !== String(id)) break;
            await A.mergeTag(state.sourceId, state.targetName);
            break;
          }
          case 'tag-merge-cancel': S.tagManageMerge = null; NS.notify(); break;
          case 'tag-delete': await A.deleteTag(id); break;
          case 'tag-suggestion-merge': {
            // 建议直达（只建议不合并）：预选好目标，进入该源的合并确认态。
            const source = ((S.tags && S.tags.items) || []).find((tag) => String(tag.name) === String(id) && tag.state === 'active');
            if (!source) break;
            S.tagManageMerge = { sourceId: String(source.id), targetName: String(el.dataset.target || '') };
            S.tagManageEdit = '';
            NS.notify();
            break;
          }
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
            NS.notify();
            break;
          }
          case 'edit-from-version': await A.editFromVersion(id, el.dataset.version || ''); break;
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
            // 就地展开不动宿主页（2026-09-17 修，子安实测抓出跳回"我的
            // 认知"）：保持当前 name 与全部详情上下文（候选/资产/采集/
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
          /* ── 经验目录（specs/016 US-801/803）──────────────────────────── */
          case 'open-experience': router.go({ name: 'overview', category: 'experiences', experienceId: id }); break;
          case 'experience-status-toggle': await A.experienceStatusToggle(id, el.dataset.action || 'pause'); break;
          case 'experience-set-type': await A.experienceSetType(id, el.dataset.type || ''); break;
          case 'experience-merge': await A.experienceMerge(id, el.dataset.target || ''); break;
          case 'experience-archive': await A.experienceArchive(id); break;
          case 'experience-migration-preview': await A.experienceMigrationPreview(); break;
          case 'experience-migration-run': {
            // run 必须显式带 assetIds（E7 契约，禁止隐式批量）：单条走
            // data-asset、批量走 data-assets（逗号分隔，来自可见的预览清单）。
            const ids = String(el.dataset.assets || el.dataset.asset || '')
              .split(',').map((value) => value.trim()).filter(Boolean);
            await A.experienceMigrationRun(ids);
            break;
          }
          case 'experience-migration-status': await A.experienceMigrationStatus(); break;
          case 'legacy-memory-refresh': await NS.loadLegacyMemoryMigrationPreview(true); break;
          case 'legacy-memory-run': await A.legacyMemoryMigrationRun(); break;
          case 'legacy-scoped-memory-refresh': await NS.loadLegacyScopedMemoryMigrationPreview(true); break;
          case 'legacy-scoped-memory-run': await A.legacyScopedMemoryMigrationRun(); break;
          case 'source-action': await A.sourceAction(el.dataset.kind || '', id, el.dataset.action); break;
          case 'capture-action': await A.captureAction(id, el.dataset.action); break;
          case 'organize-conv': await A.organizeConversation(id); break;
          // ranking-weights-reset / ranking-weights-save 两 case 已随权重卡
          // 彻底移除删除（G1 拍板项 #3，2026-09-28）；recall.catalog.weights.*
          // 读写通道后端保留。
          case 'capture-review-toggle': {
            // 单选组按所点项设置；点已选中项不重复提交；同样乐观更新。
            const auto = String((S.captureSettings || {}).reviewPolicy || 'auto') === 'auto';
            const next = id === 'auto' ? 'auto' : 'manual';
            if ((next === 'auto') !== auto) {
              const previous = S.captureSettings;
              S.captureSettings = Object.assign({}, previous, { reviewPolicy: next });
              NS.notify();
              try {
                await A.updateCaptureSettings({ reviewPolicy: next });
              } catch (error) {
                S.captureSettings = previous;
                NS.notify();
                throw error;
              }
            }
            break;
          }
          case 'inbox-form-toggle': {
            // 补边界表单展开/收起（specs/018 v2）：纯前端态，不触发重画
            //（重画会丢同页其他未保存输入）。
            const row = el.closest('.inbox-governance-form');
            const body = row ? row.querySelector('[data-inbox-boundary-body]') : null;
            if (body) body.hidden = !body.hidden;
            break;
          }
          case 'toggle-organize-list': {
            S.organizeListExpanded = !S.organizeListExpanded;
            NS.notify();
            break;
          }
          case 'proof-toggle':
            // 使用记录已并入资产详情（2026-09-15）：事件展开/收起保持在
            // 当前资产详情页内切换。
            router.go({
              name: 'overview',
              assetId: String(S.route.assetId || ''),
              // 带全上下文（2026-09-17 审查补）：使用记录与版本区同页，丢了
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
        // reload 重画后原元素已脱离文档，清理无害；未重画时恢复可点。
        if (isWrite) { el.classList.remove('is-pending'); el.removeAttribute('disabled'); }
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
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
      if (event.key === 'Escape' && (S.route.assetId || S.route.experienceId)) router.back();
    });
    // 树光斑悬停提示（原型 #tip 行为）：.spot 自带 data-title/data-sub，
    // 详情异步补数会触发整页重画；短期保存编辑中的控件值，views.js 会从
    // store 草稿恢复，避免用户输入被版本/回执/排序依据响应覆盖。
    root.addEventListener('input', (event) => {
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
      /* 坐标相对树画布（.tip 是 absolute，且 .ca-scroll 有 contain:paint，
         fixed 的视口坐标在这里整体漂移——2026-09-21 真机抓出）。 */
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
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const el = event.target.closest && event.target.closest('[data-act][role="button"], [data-go-asset][role="button"]');
      if (!el || el.getAttribute('aria-disabled') === 'true') return;
      event.preventDefault();
      el.click();
    });
    // tab 行方向键漫游（2026-09-21 原型 v7 a11y 契约）：←/→ 移动焦点，
    // Home/End 跳首尾；tab 是 div[role=button]，无原生方向键语义。
    // 挂 root 委托——bindEvents 先于持久壳首次构建执行，挂 .ca-tabs 会落空。
    root.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabsNav = event.target.closest && event.target.closest('.ca-tabs');
      if (!tabsNav || !(event.target.closest && event.target.closest('.ca-tab'))) return;
      const items = Array.from(tabsNav.querySelectorAll('.ca-tab'));
      const idx = items.indexOf(document.activeElement);
      if (idx < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? items.length - 1
          : (idx + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
      if (items[next] && typeof items[next].focus === 'function') items[next].focus();
    });
    // 标签输入的回车提交（specs/012 T010，Constitution IV 快捷键纪律）：
    // IME 组合中（isComposing / keyCode 229）不触发——中文输入法选字回车
    // 是「确认候选」不是「提交表单」。输入法兜底同款判断。
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      const input = event.target.closest && event.target.closest('[data-tag-input]');
      if (!input) return;
      event.preventDefault();
      const assetId = String(input.dataset.assetId || '');
      if (!assetId) return;
      void (async () => {
        try {
          await A.addAssetTag(assetId, String(input.value || ''));
          input.value = '';
        } catch (error) {
          const message = error && error.code && NS.recallErrorText
            ? NS.recallErrorText(error)
            : String((error && error.message) || error);
          await NS.alertUser(message);
        }
      })();
    });
    // 表单类控件的 change 委托（time input 等）：与 click 同一套 data-act 语义。
    root.addEventListener('change', (event) => {
      const el = event.target.closest && event.target.closest('[data-act="legacy-memory-toggle"]');
      if (!el) return;
      void A.legacyMemoryMigrationToggle(el.dataset.scope, el.dataset.hash, Boolean(el.checked));
    });
    root.addEventListener('change', (event) => {
      const el = event.target.closest && event.target.closest('[data-act="legacy-scoped-memory-toggle"]');
      if (!el) return;
      void A.legacyScopedMemoryMigrationToggle(
        el.dataset.scopeKind, el.dataset.scopeId, el.dataset.hash, Boolean(el.checked),
      );
    });
    root.addEventListener('change', async (event) => {
      const el = event.target.closest && event.target.closest('[data-act="nightly-time"]');
      if (!el) return;
      const value = String(el.value || '').trim();
      if (!/^\d{2}:\d{2}$/.test(value)) return;
      const previous = S.captureSettings;
      S.captureSettings = Object.assign({}, previous, { nightlyStart: value });
      NS.notify();
      try {
        await A.updateCaptureSettings({ nightlyStart: value });
      } catch (error) {
        S.captureSettings = previous;
        NS.notify();
        const message = error && error.code && NS.recallErrorText
          ? NS.recallErrorText(error)
          : String((error && error.message) || error);
        await NS.alertUser(message);
      }
    });
  }

  /* ────────────────────────── 生命周期 ────────────────────────── */

  // 整理进度的 4s 轮询已删（2026-09-27 刷新机制重写）：captures 写入经
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
    // 焦点保持（2026-09-21 原型 v7 a11y 契约）：内容区整体重绘后键盘焦点会
    // 静默落到 body，键盘用户得重新 Tab 整页。渲染前记录焦点控件的定位特征
    // （DOM id/data-key/data-act/data-go-asset），渲染后按特征找回同一控件；找不到时
    // 回落到当前页第一个可聚焦控件——焦点永不落 body。
    NS.onChange(() => {
      const active = document.activeElement;
      const inScroll = active && active.closest && active.closest('#ca-scroll');
      const signature = inScroll ? {
        domId: active.id || '',
        act: active.dataset ? active.dataset.act || '' : '',
        id: active.dataset ? active.dataset.id || '' : '',
        goAsset: active.dataset ? active.dataset.goAsset || '' : '',
        dataKey: active.dataset ? active.dataset.key || (active.closest('[data-key]') && active.closest('[data-key]').dataset.key) || '' : '',
      } : null;
      NS.render();
      const scroll = document.getElementById('ca-scroll');
      if (!scroll || !signature) return;
      let next = null;
      if (signature.domId) next = scroll.querySelector(`#${CSS.escape(signature.domId)}`);
      if (!next && signature.dataKey) {
        const group = scroll.querySelector(`[data-key="${CSS.escape(signature.dataKey)}"]`);
        if (group) next = group.querySelector('button');
      }
      if (!next && signature.goAsset) next = scroll.querySelector(`[data-go-asset="${CSS.escape(signature.goAsset)}"]`);
      if (!next && signature.act) {
        const candidates = Array.from(scroll.querySelectorAll(`[data-act="${CSS.escape(signature.act)}"]`));
        next = candidates.find((el) => !signature.id || (el.dataset && el.dataset.id === signature.id)) || candidates[0];
      }
      if (!next) next = scroll.querySelector('button, [role="button"]');
      if (next && typeof next.focus === 'function') next.focus({ preventScroll: true });
    });
    // tab 自适应：3 个中文 tab 在窄窗口仍可能折行。检测用 Range 取
    // 主标题的**文本行**数（flex 子元素被 blockify，元素级 getClientRects
    // 恒为 1，测不出折行；Range 量的是文本自身），>1 即切紧凑模式
    // （CSS 隐藏副标题腾出宽度）。
    const fitTabs = () => {
      const tabs = document.querySelector('#ca-root .ca-tabs');
      if (!tabs) return;
      const lineCount = (el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getClientRects().length;
      };
      const folded = Array.from(tabs.querySelectorAll('.ca-tab strong')).some((el) => lineCount(el) > 1);
      tabs.classList.toggle('is-compact', folded);
    };
    NS.onChange(() => requestAnimationFrame(fitTabs));
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
    window.addEventListener('resize', () => requestAnimationFrame(fitTabs));
    NS.render();
    // 订阅主进程认知变更广播（唯一刷新入口，2026-09-27 重写）：可见性判定
    // 由 MutationObserver 注入，后台窗口零 IPC，回前台 flush 挂起区块。
    NS.setupChangeRail(panelVisible);
    await NS.reload();
    // 认知树是默认落地页:快照落地后按需补一次树(overview 页也保留补树)。
    if (!S.treeRequested && (S.route.name === 'tree' || S.route.name === 'overview')) { S.treeRequested = true; await NS.reload({ tree: true }); }
    NS.notify();
  }

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

  // 数据变化时：树页/概览页没树就补树（cognition:changed 的 tree 区块会把
  // S.treeRequested 复位，实现"本体/资产变化后懒重建树"）。
  NS.onChange(() => {
    if ((S.route.name === 'tree' || S.route.name === 'overview') && !S.treeRequested && S.loaded) {
      S.treeRequested = true;
      void NS.reload({ tree: true });
    }
  });

  // 范围编辑器和受限候选详情按需读取 Agent / 空间名称；普通浏览资产时
  // 不额外加载目录，候选卡只有在确实展示这些权限边界时才读一次。
  let scopeOptionsRouteKey = '';
  NS.onChange(() => {
    const activeAssetId = S.route.name === 'overview' && S.route.assetEdit === '1'
      ? String(S.route.assetId || '') : '';
    const candidateRoute = S.route.name === 'review' || (S.route.name === 'activity' && Boolean(S.route.captureId));
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

  // 标签系统（specs/012）：资产列表与设置页管理弹层按需拉标签库；管理弹层
  // 再带 retired + 同义建议。弹层接线（uiModalController）在 views.render 尾部调用
  // core.wireTagOverlay——onChange 监听器先于 boot 的渲染监听器注册，放这里
  // 会接到上一帧的 DOM。
  NS.onChange(() => {
    const routeName = String(S.route.name || '');
    const managingFromSettings = routeName === 'settings' && String(S.route.tagOverlay || '') === 'manage';
    if (routeName !== 'overview' && !managingFromSettings) return;
    void NS.loadTags();
    if (String(S.route.tagOverlay || '') === 'manage') {
      void NS.loadTags({ includeRetired: true });
      void NS.loadTagSuggestions();
    }
  });

  // 详情页兜底加载上下文：返回栈回退/深链进入时没有经过 open-capture-detail
  // 分流，这里按当前路由补拉（loadCaptureContext 内部有缓存判重）。
  NS.onChange(() => {
    const captureId = String(S.route.captureId || '');
    const experienceRouteId = String(S.route.experienceId || '');
    if (captureId && (!S.captureContext || S.captureContext.captureId !== captureId)) {
      void NS.loadCaptureContext(captureId);
    }
    // 资产详情版本链同理按需补拉（版本组 2026-09-16）；KSTAR 摘要随详情
    // 一起（2026-09-17 资产侧溯源）。
    const assetId = String(S.route.assetId || '');
    if (assetId && (!S.assetVersions || S.assetVersions.assetId !== assetId)) {
      void NS.loadAssetVersions(assetId);
    }
    if (assetId && (!S.assetTimeline || S.assetTimeline.assetId !== assetId || S.assetTimeline.stale)) {
      void NS.loadAssetTimeline(assetId);
    }
    if (assetId) void NS.loadKstarEpisodeSummaries(assetId);
    // 整理报告：进整理相关页签就补拉一次（内部有缓存判重）。沉淀设置页的
    // 大扫除 section（specs/017 整改三）也要最近报告摘要，一并补拉。
    // 「已删除」页签：保留期剩余天数由服务端现算，进这个页签时补拉一次。
    if (String(S.route.category || '') === 'deleted') void NS.loadDeletedAssets();
    if (['cleanup', 'settings', 'activity'].includes(String(S.route.name || ''))) {
      void NS.loadCleanupReports();
    }
    // 自动维护合并卡（2026-09-29）：settings 页内嵌「最近检查」行，巡检数据
    // 门控补 'settings'——直接落资产设置时不再漏拉（此前开关恒显假「关」）。
    if (['cleanup', 'settings', 'activity'].includes(String(S.route.name || ''))) {
      void NS.loadInspection();
    }
    // 采用回执（2026-09-25 US-602）：详情「实际采用记录」区的唯一数据源。
    if (assetId) void NS.loadAdoptionReceipts(assetId);
    // 排序依据（specs/012 T020 / US-202 AC4）：详情「为什么这一轮排在前面」
    // 小节的数据源（recall.catalog.ranking 只读；app 层装载，见文件底部的
    // 排序依据/权重装载器——core 不动）。
    if (assetId) void loadRankingWhy(assetId);
    // 权重卡数据装载已随权重卡彻底移除删除（G1 拍板项 #3，2026-09-28）；
    // recall.catalog.weights.get 通道后端保留，详情「排序依据」解释仍读
    // recall.catalog.ranking（loadRankingWhy，保留）。
    // 会话标题同理（2026-09-25 US-603）：证据来源与使用记录里的 cid 要翻成
    // 会话名，五处展示同名；来源目录 100 条窗口外的会话靠这个批量口补齐。
    if (assetId) void NS.loadConversationTitles(assetId);
    // 候选详情的 kse 证据 chip 也要真实目标摘要（此前只覆盖资产详情，
    // 候选页 chip 一直显示兜底"一次任务"，2026-09-17 子安实测抓出）。
    const candidateId = String(S.route.candidateId || '');
    if (candidateId) {
      const cand = S.candidates.find((c) => String(c.id) === candidateId);
      if (cand) {
        const candRefs = [...(cand.sourceRefs || []), ...(cand.evidenceRefs || [])];
        const ids = candRefs.map((r) => String(r.id || ''));
        void NS.loadKstarEpisodeSummariesByIds(ids);
        void NS.loadConversationTitlesByIds(candRefs);
      }
    }
    // KSTAR 复盘折叠区（2026-09-17 二次定调）：复盘历史随「我的认知」页
    // 懒加载一次（折叠区默认收起，数据先备好，展开即渲染）。
    if (String(S.route.name || '') === 'overview') void NS.loadKstarEpisodes();
    // 模型自选标记随「我的认知」一起刷新（2026-09-18）：目录视图据此标"模型挂着"。
    if (String(S.route.name || '') === 'overview') void NS.loadModelSelectedAssets();
    // 经验目录（specs/016；specs/017 整改一收编为「我的认知」经验档）：进
    // overview（任何分类档）就拉一次——pillbox 经验档的计数要真实；旧深链
    // name:'experiences' 同样兜住。详情深链补拉 E2；详情证据里的 kse 摘要与
    // 会话标题同时候补——chip 要显示任务目标与会话名，与资产详情同一套批量口
    //（loaders 自带缓存/在途守卫）。
    if (['overview', 'experiences'].includes(String(S.route.name || ''))) {
      void NS.loadExperiences();
      if (experienceRouteId) {
        void NS.loadExperienceDetail(experienceRouteId);
        const loaded = S.experienceDetail;
        if (loaded && !loaded.loading && loaded.experience) {
          const refs = loaded.experience.evidenceRefs || [];
          void NS.loadKstarEpisodeSummariesByIds(refs.map((ref) => String((ref && ref.id) || '')));
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

  /* ────────────────── 排序依据装载器（specs/012 T020） ──────────────────
   * 状态挂在模块闭包 + NS 命名空间（NS.rankingWhy）：core.js 的 store 不动
   * （本轮白名单只开 views/app），视图按 NS 读——与 NS.api / NS.reportBlocked
   * 的既有跨层发布同一模式。权重配置装载器（NS.rankingWeights）已随权重卡
   * 彻底移除删除（G1 拍板项 #3，2026-09-28）。 */

  /** 该资产最近一次真实使用的回合 id：使用记录时间线（refs.taskRunId）优先，
   *  采用回执兜底；都没有 = ''（视图按「这一轮没有进入目录」如实呈现）。 */
  function latestTurnForAsset(assetId) {
    const id = String(assetId || '');
    const fromProofs = (Array.isArray(S.proofs) ? S.proofs : [])
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
  async function loadRankingWhy(assetId) {
    const id = String(assetId || '');
    if (!id) return;
    const turnId = latestTurnForAsset(id);
    if (rankingWhyLast.assetId === id && rankingWhyLast.turnId === turnId) return;
    rankingWhyLast = { assetId: id, turnId };
    NS.rankingWhy = { assetId: id, loading: true };
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
    // 回执到达前用户已切走/换资产：这帧作废（不把 A 资产的拆解画给 B 资产）。
    if (rankingWhyLast.assetId !== id) return;
    NS.rankingWhy = next;
    NS.render();
  }

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
