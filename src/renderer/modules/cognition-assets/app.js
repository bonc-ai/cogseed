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

  let treeRequested = false;
  let booted = false;

  /** 写操作集合：点击后按钮进入 pending（禁用+变淡），完成或重画后还原。 */
  const WRITE_ACTIONS = new Set([
    'refresh', 'cand-adopt-with-form', 'cand-decide',
    'asset-action', 'select-asset-version', 'delete-asset-version', 'asset-edit-save', 'edit-from-version', 'merge-asset-version', 'merge-asset', 'source-action', 'capture-action', 'organize-conv',
    'capture-toggle', 'capture-review-toggle', 'proof-rate',
    'capture-batch',
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
    };
  }

  function bindEvents(root) {
    root.addEventListener('click', async (event) => {
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
            // 「返回」按文案回列表（2026-09-17 修）：此前是 router.back()——
            // "返回上一步"，从候选/整理详情跳进资产详情后，点返回退回的是
            // 跳转前的深层页而不是列表，与按钮文案不符。按详情类型归位到
            // 对应列表根（资产详情保留分类筛选）；仍压栈，需要时可再进详情。
            const name = S.route.candidateId ? 'review'
              : (S.route.captureId || S.route.name === 'organize' || S.route.name === 'organize-settings') ? 'organize'
                : 'overview';
            router.go({ name, category: name === 'overview' ? String(S.route.category || '') : '' });
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
            if (menu) { menu.hidden = !menu.hidden; el.classList.toggle('is-open', !menu.hidden); }
            break;
          }
          case 'refresh': await NS.reload({ tree: true }); await NS.reload(); break;
          case 'tab': router.go({ name: id }); break;
          case 'filter-cat': router.go({ name: 'overview', category: id }); break;
          // 目录视图切换（2026-09-18）：同一个列表页换一种行形态（模型视角），
          // 不新增 tab。assetView 必须进 router.go 的归一化白名单，否则被丢弃。
          case 'asset-view': router.go({ name: 'overview', assetView: id === 'catalog' ? 'catalog' : '' }); break;
          case 'go-review': router.go({ name: 'review' }); break;
          case 'go-organize': router.go({ name: 'organize' }); break;
          case 'go-configure-model': {
            // configuration_required 的处理出口：模型配置在应用设置页（与
            // kb-workbench 等模块同一条 setView('settings') 通道）。
            if (typeof window.setView === 'function') window.setView('settings');
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
          case 'go-organize-settings': router.go({ name: 'organize-settings' }); break;
          case 'nightly-toggle': {
            // 夜间自动沉淀开关：开 = nightly（并联动「先问我」——产出进
            // 「待我处理」等批准，而非自动采纳）；关 = 回到纯手动。
            // 开启是额度消耗行为：先确认。
            const on = !(S.captureSettings && String(S.captureSettings.executionPolicy || '') === 'nightly');
            if (on) {
              const ok = await NS.confirmUser(T('cognition.nightly_capture_confirm', '开启后，夜间会在所选时间自动整理当天结束的会话，每次整理都会消耗模型额度。确认开启？'));
              if (!ok) break;
            }
            const previous = S.captureSettings;
            const patch = on
              ? { executionPolicy: 'nightly', reviewPolicy: 'manual' }
              : { executionPolicy: 'manual' };
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
          case 'capture-filter': router.go({ name: 'organize', captureBucket: id }); break;
          case 'open-capture-detail': {
            router.go({ name: 'organize', captureId: id });
            void NS.loadCaptureContext(id);
            break;
          }
          case 'open-conversation': NS.openConversation(id); break;
          case 'capture-batch': {
            // 批量动作的条数在渲染时写死进按钮（只数当前已加载且该动作可执行
            // 的行）；这里再次从 store 收敛同一口径，防止路由/数据在确认弹窗
            // 与执行之间变动后多发。
            const runnable = (S.captures || []).filter((capture) => (
              Array.isArray(capture.actions) && capture.actions.includes(el.dataset.batch || '')
            ));
            if (!runnable.length) break;
            const action = el.dataset.batch === 'retry' ? 'retry' : 'run_now';
            const ok = action === 'retry'
              ? await NS.confirmUser(T('cognition.capture_batch_retry_confirm', '确认重试 {n} 条失败的整理任务？', { n: String(runnable.length) }))
              : await NS.confirmUser(T('cognition.capture_batch_run_confirm', '将立即整理 {n} 个会话，每条都会消耗模型额度。确认开始？', { n: String(runnable.length) }));
            if (!ok) break;
            await A.captureBatch(action, runnable.map((capture) => capture.id));
            break;
          }
          case 'open-candidate': router.go({ name: 'review', candidateId: id }); break;
          case 'open-ontology': await NS.openPersonalOntology(); break;
          case 'open-asset': router.go({ name: 'overview', assetId: id }); break;
          case 'open-overview': router.go({ name: 'overview' }); break;
          case 'cand-adopt-with-form': await A.adoptCandidate(id, readCandidateForm(el) || undefined); break;
          case 'cand-decide': await A.decideCandidate(id, el.dataset.action); break;
          case 'asset-action': await A.assetAction(id, el.dataset.action); break;
          case 'select-asset-version': await A.selectAssetVersion(id, el.dataset.version || ''); break;
          case 'delete-asset-version': await A.deleteAssetVersion(id, el.dataset.version || ''); break;
          case 'edit-asset': {
            // 进入/退出编辑态（纯路由切换，不压返回栈）。
            router.go({ name: 'overview', assetId: String(S.route.assetId || ''), assetEdit: S.route.assetEdit ? '' : '1' }, { replace: true });
            break;
          }
          case 'asset-edit-save': await A.editAsset(id); break;
          case 'asset-edit-cancel': router.go({ name: 'overview', assetId: String(S.route.assetId || ''), assetEdit: '' }, { replace: true }); break;
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
            // 版本键），只切 kstarEpisodeId——此前 name 硬编码 overview，
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
              kstarEpisodeId: open,
            }, { replace: true });
            if (open) void NS.loadKstarEpisode(open);
            break;
          }
          case 'merge-asset': await A.mergeAssets(id, el.dataset.target || ''); break;
          case 'source-action': await A.sourceAction(el.dataset.kind || '', id, el.dataset.action); break;
          case 'capture-action': await A.captureAction(id, el.dataset.action); break;
          case 'organize-conv': await A.organizeConversation(id); break;
          case 'capture-toggle': {
            const enabled = !(S.captureSettings && S.captureSettings.enabled !== false);
            if (!enabled) {
              // 关闭自动整理是破坏性操作（新候选不再被发现）：确认+后果说明。
              const ok = await NS.confirmUser(T('cognition.capture_disable_confirm', '关闭后新会话不再自动提炼候选，已有的资产与记录不受影响。确认关闭自动整理？'));
              if (!ok) break;
            }
            const previousSettings = S.captureSettings;
            S.captureSettings = Object.assign({}, previousSettings, { enabled });
            NS.notify();
            try {
              await A.updateCaptureSettings({ enabled });
            } catch (error) {
              S.captureSettings = previousSettings;
              NS.notify();
              throw error;
            }
            break;
          }
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
      if (event.key === 'Escape' && S.route.assetId) router.back();
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
    // 表单类控件的 change 委托（time input 等）：与 click 同一套 data-act 语义。
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

  let capturePollTimer = null;
  /** 整理进行中的轻量轮询（4s）：「从历史会话整理」与整理详情页需要看到
   *  extracting → 完成/失败的状态推进（页面无推送通道）。存在 active 任务
   *  且用户停在这两个页面时才拉快照；状态离开 active 自动停。 */
  async function capturePollTick() {
    capturePollTimer = null;
    if (!booted || !panelVisible()) return;
    const onLivePage = S.route.name === 'organize';
    const hasActive = (S.captures || []).some((capture) => capture && capture.bucket === 'active');
    if (!onLivePage || !hasActive) return;
    await NS.reload();
    // reload 被 loading 守卫吞掉时不会触发 notify，这里兜底续上（有守卫不会重复）。
    scheduleCapturePoll();
  }
  function scheduleCapturePoll() {
    if (capturePollTimer) return;
    capturePollTimer = setTimeout(capturePollTick, 4000);
  }

  function panelVisible() {
    const panel = document.getElementById('panel-recall');
    if (!panel) return false;
    return panel.classList.contains('active') || !panel.hidden;
  }

  async function boot() {
    if (booted) return;
    const root = document.getElementById('ca-root');
    if (!root) return;
    booted = true;
    bindEvents(root);
    NS.onChange(NS.render);
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
    window.addEventListener('resize', () => requestAnimationFrame(fitTabs));
    NS.render();
    await NS.reload();
    // 概览是树的第一眼：快照落地后按需补一次树。
    if (!treeRequested && S.route.name === 'overview') { treeRequested = true; await NS.reload({ tree: true }); }
    NS.notify();
  }

  function scheduleBoot() {
    const panel = document.getElementById('panel-recall');
    if (!panel) return;
    const observer = new MutationObserver(() => {
      if (panelVisible()) { boot(); }
    });
    observer.observe(panel, { attributes: true, attributeFilter: ['class', 'hidden'], childList: true, subtree: false });
    // 面板可能已经处于激活态（深链进来）。
    if (panelVisible()) boot();
  }

  // 数据变化时：概览页没树就补树。
  NS.onChange(() => {
    if (S.route.name === 'overview' && !treeRequested && S.loaded) {
      treeRequested = true;
      void NS.reload({ tree: true });
    }
  });

  // 每次重画后排一次轮询检查（条件不满足时 tick 自行退出）。
  NS.onChange(() => { scheduleCapturePoll(); });

  // 详情页兜底加载上下文：返回栈回退/深链进入时没有经过 open-capture-detail
  // 分流，这里按当前路由补拉（loadCaptureContext 内部有缓存判重）。
  NS.onChange(() => {
    const captureId = String(S.route.captureId || '');
    if (captureId && (!S.captureContext || S.captureContext.captureId !== captureId)) {
      void NS.loadCaptureContext(captureId);
    }
    // 资产详情版本链同理按需补拉（版本组 2026-09-16）；KSTAR 摘要随详情
    // 一起（2026-09-17 资产侧溯源）。
    const assetId = String(S.route.assetId || '');
    if (assetId && (!S.assetVersions || S.assetVersions.assetId !== assetId)) {
      void NS.loadAssetVersions(assetId);
    }
    if (assetId) void NS.loadKstarEpisodeSummaries(assetId);
    // 候选详情的 kse 证据 chip 也要真实目标摘要（此前只覆盖资产详情，
    // 候选页 chip 一直显示兜底"一次任务"，2026-09-17 子安实测抓出）。
    const candidateId = String(S.route.candidateId || '');
    if (candidateId) {
      const cand = S.candidates.find((c) => String(c.id) === candidateId);
      if (cand) {
        const ids = [...(cand.sourceRefs || []), ...(cand.evidenceRefs || [])].map((r) => String(r.id || ''));
        void NS.loadKstarEpisodeSummariesByIds(ids);
      }
    }
    // KSTAR 复盘折叠区（2026-09-17 二次定调）：复盘历史随「我的认知」页
    // 懒加载一次（折叠区默认收起，数据先备好，展开即渲染）。
    if (String(S.route.name || '') === 'overview') void NS.loadKstarEpisodes();
  });

  /** 静默刷新指示：同页 reload（操作后/轮询）期间顶部走一条细进度条。
   *  首载不走这里（那时是骨架）；放在 render 之后执行，避免给旧 DOM 挂类。 */
  function syncRefreshIndicator() {
    const app = document.querySelector('#ca-root .ca-app');
    if (!app) return;
    app.classList.toggle('is-refreshing', Boolean(S.loading && S.loaded));
  }
  NS.onChange(() => { requestAnimationFrame(syncRefreshIndicator); });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleBoot, { once: true });
  } else {
    scheduleBoot();
  }

  // 语言切换：视图全部在渲染时取文案，整页重画即可跟上（旧实现曾在
  // skills-bindings.js 里重画，随瘦身丢失）。
  window.addEventListener('i18n-change', () => { if (booted) NS.render(); });
})();
