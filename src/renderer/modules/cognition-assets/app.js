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
    'asset-action', 'source-action', 'capture-action', 'organize-conv',
    'capture-policy', 'capture-toggle', 'capture-review-toggle', 'proof-rate',
  ]);

  /* ────────────────────────── 事件委托 ────────────────────────── */

  function readCandidateForm() {
    const card = document.querySelector('.ca-candidate-detail');
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
      if (isWrite) { el.classList.add('is-pending'); el.setAttribute('disabled', 'disabled'); }
      try {
        switch (act) {
          case 'go-back': router.back(); break;
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
          case 'toggle-proof-asset': {
            const key = String(id);
            if (S.expandedProofs.has(key)) S.expandedProofs.delete(key);
            else S.expandedProofs.add(key);
            NS.notify();
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
          case 'manage-tab': router.go({ name: 'manage', manageTab: id }); break;
          case 'filter-cat': router.go({ name: 'overview', category: id }); break;
          case 'go-review': router.go({ name: 'review' }); break;
          case 'go-sources': router.go({ name: 'manage', manageTab: 'sources', sourceKind: '' }); break;
          case 'go-source-kind': router.go({ name: 'manage', manageTab: 'sources', sourceKind: id }); break;
          case 'go-sources-overview': router.go({ name: 'manage', manageTab: 'sources', sourceKind: '' }); break;
          case 'go-experiences': router.go({ name: 'experiences' }); break;
          case 'go-organize': router.go({ name: 'manage', manageTab: 'organize' }); break;
          case 'open-candidate': router.go({ name: 'review', candidateId: id }); break;
          case 'open-ontology': await NS.openPersonalOntology(); break;
          case 'open-asset': router.go({ name: 'overview', assetId: id }); break;
          case 'open-overview': router.go({ name: 'overview' }); break;
          case 'open-evidence': router.go({ name: 'evidence' }); break;
          case 'cand-adopt-with-form': await A.adoptCandidate(id, readCandidateForm() || undefined); break;
          case 'cand-decide': await A.decideCandidate(id, el.dataset.action); break;
          case 'asset-action': await A.assetAction(id, el.dataset.action); break;
          case 'source-action': await A.sourceAction(el.dataset.kind || '', id, el.dataset.action); break;
          case 'capture-action': await A.captureAction(id, el.dataset.action); break;
          case 'organize-conv': await A.organizeConversation(id); break;
          case 'capture-policy': {
            // 分段单选：点已选中项不重复提交。
            const current = String((S.captureSettings || {}).executionPolicy || 'smart');
            if (id && id !== current) await A.updateCaptureSettings({ executionPolicy: id });
            break;
          }
          case 'capture-toggle': {
            const enabled = !(S.captureSettings && S.captureSettings.enabled !== false);
            if (!enabled) {
              // 关闭自动整理是破坏性操作（新候选不再被发现）：确认+后果说明。
              const ok = await NS.confirmUser(T('cognition.capture_disable_confirm', '关闭后新会话不再自动提炼候选，已有的资产与记录不受影响。确认关闭自动整理？'));
              if (!ok) break;
            }
            await A.updateCaptureSettings({ enabled });
            break;
          }
          case 'capture-review-toggle': {
            // 单选组按所点项设置；点已选中项不重复提交。
            const auto = String((S.captureSettings || {}).reviewPolicy || 'auto') === 'auto';
            const next = id === 'auto' ? 'auto' : 'manual';
            if ((next === 'auto') !== auto) await A.updateCaptureSettings({ reviewPolicy: next });
            break;
          }
          case 'toggle-organize-list': {
            S.organizeListExpanded = !S.organizeListExpanded;
            NS.notify();
            break;
          }
          case 'proof-toggle':
            router.go({ name: 'evidence', proofEventId: String(S.route.proofEventId) === id ? '' : id });
            break;
          case 'proof-rate': {
            // 说明是可选的：先写再点评，说明随评价一起附上。
            const zone = el.closest('.ca-rating');
            const noteEl = zone ? zone.querySelector('textarea[data-f="note"]') : null;
            const note = noteEl ? String(noteEl.value || '').trim() : '';
            await A.rateProof(id, el.dataset.feedback, note ? { note } : undefined);
            break;
          }
          case 'noop': break;
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
  }

  /* ────────────────────────── 生命周期 ────────────────────────── */

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
    // tab 自适应：6 个中文 tab 在窄窗口会挤压折行——重画后检测每个 tab 是否
    // 被压到内容放不下，是则切紧凑模式（CSS 隐藏副标题小字腾出宽度）。
    NS.onChange(() => {
      requestAnimationFrame(() => {
        const tabs = document.querySelector('#ca-root .ca-tabs');
        if (!tabs) return;
        const squeezed = Array.from(tabs.children).some((tab) => tab.scrollWidth > tab.clientWidth);
        tabs.classList.toggle('is-compact', squeezed);
      });
    });
    // tab 自适应：6 个中文 tab 在窄窗口会被压到折行。检测用 Range 取
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleBoot, { once: true });
  } else {
    scheduleBoot();
  }

  // 语言切换：视图全部在渲染时取文案，整页重画即可跟上（旧实现曾在
  // skills-bindings.js 里重画，随瘦身丢失）。
  window.addEventListener('i18n-change', () => { if (booted) NS.render(); });
})();
