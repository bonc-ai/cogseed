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
    const value = (name) => {
      const el = card.querySelector(`[data-f="${name}"]`);
      return el ? String(el.value || '') : '';
    };
    return {
      suggestedType: value('type'),
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
          case 'go-sources': router.go({ name: 'manage', manageTab: 'sources' }); break;
          case 'go-organize': router.go({ name: 'manage', manageTab: 'organize' }); break;
          case 'open-candidate': router.go({ name: 'review', candidateId: id }); break;
          case 'open-asset': router.go({ name: 'overview', assetId: id }); break;
          case 'open-overview': router.go({ name: 'overview' }); break;
          case 'open-evidence': router.go({ name: 'evidence' }); break;
          case 'cand-adopt-with-form': await A.adoptCandidate(id, readCandidateForm() || undefined); break;
          case 'cand-decide': await A.decideCandidate(id, el.dataset.action); break;
          case 'asset-action': await A.assetAction(id, el.dataset.action); break;
          case 'source-action': await A.sourceAction(el.dataset.kind || '', id, el.dataset.action); break;
          case 'capture-action': await A.captureAction(id, el.dataset.action); break;
          case 'organize-conv': await A.organizeConversation(id); break;
          case 'capture-policy': await A.updateCaptureSettings({ executionPolicy: id }); break;
          case 'capture-toggle': {
            const enabled = !(S.captureSettings && S.captureSettings.enabled !== false);
            await A.updateCaptureSettings({ enabled });
            break;
          }
          case 'capture-review-toggle': {
            const auto = String((S.captureSettings || {}).reviewPolicy || 'auto') === 'auto';
            await A.updateCaptureSettings({ reviewPolicy: auto ? 'manual' : 'auto' });
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
        await NS.alertUser(String((error && error.message) || error));
      } finally {
        // reload 重画后原元素已脱离文档，清理无害；未重画时恢复可点。
        if (isWrite) { el.classList.remove('is-pending'); el.removeAttribute('disabled'); }
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && S.route.assetId) router.back();
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
})();
