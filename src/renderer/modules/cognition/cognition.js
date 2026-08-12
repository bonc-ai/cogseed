// 认知成长页：分页摘要负责导航，完整资产按需加载后才展示证据和执行动作。
(function () {
  const PAGE_SIZE = 50;
  const STAGES = new Set(['seed', 'sprout', 'growing', 'bright']);
  const REVIEW_STATES = new Set(['pending', 'confirmed', 'deferred', 'invalidated']);
  let summaries = [];
  const details = new Map();
  let activeId = null;
  let view = 'tree';
  let listLoading = false;
  let detailLoadingId = null;
  let listRequestSequence = 0;
  let detailRequestSequence = 0;
  let pagination = { page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 0 };

  function el(id) { return document.getElementById(id); }
  function translate(key, fallback, vars) {
    if (typeof t === 'function') {
      const translated = t(key, vars);
      if (translated && translated !== key) return translated;
    }
    return fallback;
  }
  function apiError(error) {
    return error && error.message ? error.message : String(error || translate('cognition.error.generic', '操作失败'));
  }
  function showError(error) {
    const page = el('cognition-page');
    if (!page) return;
    let notice = page.querySelector('.cognition-error');
    if (!notice) {
      notice = document.createElement('div');
      notice.className = 'cognition-error';
      page.prepend(notice);
    }
    notice.textContent = apiError(error);
  }
  function clearError() {
    el('cognition-page')?.querySelector('.cognition-error')?.remove();
  }
  function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }
  function isNonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0;
  }
  function isPositiveInteger(value) {
    return Number.isInteger(value) && value >= 1;
  }
  function isInvalidation(value) {
    return value === undefined || (isRecord(value)
      && typeof value.at === 'string'
      && ['removed', 'replaced', 'content_changed', 'metadata_missing'].includes(value.reason));
  }
  function isEvidence(value) {
    return isRecord(value)
      && typeof value.id === 'string' && !!value.id
      && ['conversation', 'project', 'execution', 'manual'].includes(value.kind)
      && typeof value.summary === 'string'
      && typeof value.sourceLabel === 'string'
      && typeof value.createdAt === 'string';
  }
  function isReuseEvent(value) {
    return isRecord(value)
      && typeof value.id === 'string' && !!value.id
      && typeof value.sourceLabel === 'string'
      && typeof value.createdAt === 'string';
  }
  function isTransition(value) {
    return isRecord(value)
      && typeof value.id === 'string' && !!value.id
      && ['created', 'evidence_added', 'confirmation_requested', 'defer_requested', 'confirmed', 'reconfirmed', 'deferred', 'reused', 'invalidated'].includes(value.kind)
      && typeof value.at === 'string';
  }
  function isSummary(value) {
    return isRecord(value)
      && typeof value.id === 'string' && !!value.id
      && typeof value.title === 'string'
      && typeof value.summary === 'string'
      && STAGES.has(value.stage)
      && REVIEW_STATES.has(value.reviewState)
      && isNonNegativeInteger(value.evidenceCount)
      && isNonNegativeInteger(value.reuseCount)
      && typeof value.updatedAt === 'string'
      && isInvalidation(value.invalidation);
  }
  function isFullAsset(value) {
    return isRecord(value)
      && typeof value.id === 'string' && !!value.id
      && typeof value.title === 'string'
      && typeof value.summary === 'string'
      && STAGES.has(value.stage)
      && REVIEW_STATES.has(value.reviewState)
      && Array.isArray(value.evidence) && value.evidence.every(isEvidence)
      && Array.isArray(value.reuseEvents) && value.reuseEvents.every(isReuseEvent)
      && (value.transitions === undefined || (Array.isArray(value.transitions) && value.transitions.every(isTransition)))
      && typeof value.updatedAt === 'string'
      && isInvalidation(value.invalidation);
  }
  function assertFullAsset(value, message) {
    if (!isFullAsset(value)) throw new Error(message);
    return value;
  }
  function isAssetPage(value) {
    return isRecord(value)
      && Array.isArray(value.items) && value.items.every(isSummary)
      && isPositiveInteger(value.page)
      && isPositiveInteger(value.pageSize)
      && isNonNegativeInteger(value.total)
      && isNonNegativeInteger(value.totalPages)
      && value.totalPages === Math.ceil(value.total / value.pageSize)
      && (value.totalPages === 0 ? value.page === 1 : value.page <= value.totalPages);
  }
  function isPageChannelUnavailable(error) {
    const message = apiError(error).toLowerCase();
    const namesPageChannel = message.includes('cognition.assets.page')
      || message.includes('/api/cognition/assets/page');
    return namesPageChannel && (
      message.includes('unknown channel')
      || message.includes('unknown route')
      || message.includes('no handler')
      || message.includes('not registered')
      || message.includes('unsupported channel')
    );
  }
  function summaryFromAsset(asset) {
    return {
      id: asset.id,
      title: asset.title,
      summary: asset.summary,
      stage: asset.stage,
      reviewState: asset.reviewState,
      evidenceCount: asset.evidence.length,
      reuseCount: asset.reuseEvents.length,
      updatedAt: typeof asset.updatedAt === 'string' ? asset.updatedAt : '',
      ...(asset.confirmationRequestedAt ? { confirmationRequestedAt: asset.confirmationRequestedAt } : {}),
      ...(asset.invalidation ? { invalidation: asset.invalidation } : {}),
    };
  }
  function summaryFingerprint(summary) {
    const invalidation = summary.invalidation;
    return JSON.stringify({
      id: summary.id,
      title: summary.title,
      summary: summary.summary,
      stage: summary.stage,
      reviewState: summary.reviewState,
      evidenceCount: summary.evidenceCount,
      reuseCount: summary.reuseCount,
      updatedAt: summary.updatedAt,
      confirmationRequestedAt: summary.confirmationRequestedAt || null,
      invalidation: invalidation ? {
        at: invalidation.at,
        reason: invalidation.reason,
        previousRecordId: invalidation.previousRecordId || null,
      } : null,
    });
  }
  function assetsMatchSummary(asset, summary) {
    return !!asset && !!summary
      && summaryFingerprint(summaryFromAsset(asset)) === summaryFingerprint(summary);
  }
  function adoptPageSummaries(items) {
    for (const summary of items) {
      const cached = details.get(summary.id);
      if (cached && !assetsMatchSummary(cached, summary)) details.delete(summary.id);
    }
    summaries = items;
  }
  function visibleSummaries() {
    return view === 'pending'
      ? summaries.filter((asset) => asset.reviewState !== 'confirmed')
      : summaries;
  }
  function ensureActiveSummary() {
    const visible = visibleSummaries();
    if (!visible.some((asset) => asset.id === activeId)) activeId = visible[0]?.id || null;
  }
  function selectedAsset() {
    return activeId ? details.get(activeId) || null : null;
  }
  function updateAsset(asset, options = {}) {
    asset = assertFullAsset(asset, translate('cognition.error.invalid_response', '认知操作返回无效'));
    details.set(asset.id, asset);
    const summary = summaryFromAsset(asset);
    const index = summaries.findIndex((item) => item.id === asset.id);
    if (options.moveToFirstPage) {
      const pageSize = Math.max(1, pagination.pageSize || PAGE_SIZE);
      summaries = [summary, ...summaries.filter((item) => item.id !== asset.id)].slice(0, pageSize);
      const total = pagination.total + (options.isNew ? 1 : 0);
      pagination = {
        ...pagination,
        page: 1,
        total,
        totalPages: Math.ceil(total / pageSize),
      };
    } else if (index >= 0) summaries = summaries.map((item, itemIndex) => itemIndex === index ? summary : item);
    activeId = asset.id;
  }
  function currentValidPage() {
    return Math.min(Math.max(1, pagination.page), Math.max(1, pagination.totalPages));
  }
  async function reloadAfterMutation() {
    await loadCognitionAssets(currentValidPage());
  }

  function render() {
    const page = el('cognition-page');
    if (!page || !window.CognitionPages) return;
    ensureActiveSummary();
    page.innerHTML = window.CognitionPages.renderCognitionPage({
      assets: summaries,
      activeId,
      activeAsset: selectedAsset(),
      detailLoading: !!activeId && detailLoadingId === activeId,
      listLoading,
      pagination,
      view,
    });
    bind(page);
  }

  async function parseResponse(response, fallback) {
    let result;
    try {
      result = await response.json();
    } catch (error) {
      throw new Error(fallback, { cause: error });
    }
    if (!response.ok) throw new Error(result?.error || fallback);
    return result;
  }

  async function loadLegacyAssets(requestSequence) {
    const response = await window.apiFetch('/api/cognition/assets');
    const result = await parseResponse(response, translate('cognition.error.load_failed', '认知数据加载失败'));
    if (!result || !Array.isArray(result.assets) || !result.assets.every(isFullAsset)) {
      throw new Error(translate('cognition.error.invalid_response', '认知数据格式无效'));
    }
    if (requestSequence !== listRequestSequence) return;
    details.clear();
    for (const asset of result.assets) details.set(asset.id, asset);
    summaries = result.assets.map(summaryFromAsset);
    pagination = {
      page: 1,
      pageSize: Math.max(PAGE_SIZE, summaries.length),
      total: summaries.length,
      totalPages: summaries.length ? 1 : 0,
    };
  }

  async function loadCognitionAssets(requestedPage = pagination.page) {
    const pageNumber = isPositiveInteger(requestedPage) ? requestedPage : 1;
    const requestSequence = ++listRequestSequence;
    listLoading = true;
    render();
    let pageLoaded = false;
    let failure = null;
    try {
      try {
        const response = await window.apiFetch(`/api/cognition/assets/page?page=${pageNumber}&pageSize=${PAGE_SIZE}`);
        const result = await parseResponse(response, translate('cognition.error.load_failed', '认知数据加载失败'));
        if (!isAssetPage(result?.page)) throw new Error(translate('cognition.error.invalid_response', '认知数据格式无效'));
        if (requestSequence === listRequestSequence) {
          const activeDetail = activeId ? details.get(activeId) : null;
          const activeSummary = result.page.items.find((item) => item.id === activeId);
          const preservesMutationDetail = assetsMatchSummary(activeDetail, activeSummary);
          adoptPageSummaries(result.page.items);
          if (preservesMutationDetail) details.set(activeDetail.id, activeDetail);
          pagination = {
            page: result.page.page,
            pageSize: result.page.pageSize,
            total: result.page.total,
            totalPages: result.page.totalPages,
          };
          pageLoaded = true;
        }
      } catch (pageError) {
        if (requestSequence !== listRequestSequence) return;
        if (!isPageChannelUnavailable(pageError)) throw pageError;
        await loadLegacyAssets(requestSequence);
      }
    } catch (error) {
      if (requestSequence === listRequestSequence) failure = error;
    } finally {
      if (requestSequence === listRequestSequence) {
        listLoading = false;
        ensureActiveSummary();
        clearError();
        render();
        if (failure) showError(failure);
        else if (pageLoaded) void loadActiveAsset();
      }
    }
  }

  async function loadActiveAsset(options = {}) {
    const assetId = activeId;
    if (!assetId || (!options.force && details.has(assetId))) {
      detailLoadingId = null;
      render();
      return;
    }
    const requestSequence = ++detailRequestSequence;
    detailLoadingId = assetId;
    render();
    let failure = null;
    try {
      const response = await window.apiFetch(`/api/cognition/assets/${encodeURIComponent(assetId)}`);
      const result = await parseResponse(response, translate('cognition.error.detail_failed', '认知详情加载失败'));
      if (!isFullAsset(result?.asset) || result.asset.id !== assetId) {
        throw new Error(translate('cognition.error.invalid_response', '认知数据格式无效'));
      }
      if (requestSequence !== detailRequestSequence || activeId !== assetId) return;
      details.set(assetId, result.asset);
      clearError();
    } catch (error) {
      if (requestSequence === detailRequestSequence && activeId === assetId) failure = error;
    } finally {
      if (requestSequence === detailRequestSequence && detailLoadingId === assetId) {
        detailLoadingId = null;
        render();
        if (failure) showError(failure);
      }
    }
  }

  async function postAction(path, payload) {
    const response = await window.apiFetch(path, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
    const result = await parseResponse(response, translate('cognition.error.action_failed', '认知操作失败'));
    const asset = assertFullAsset(result?.asset, translate('cognition.error.invalid_response', '认知操作返回无效'));
    updateAsset(asset, { moveToFirstPage: true });
    clearError();
    render();
    await reloadAfterMutation();
  }

  async function createAsset(form) {
    const title = String(form.querySelector('#cognition-create-title')?.value || '').trim();
    const summary = String(form.querySelector('#cognition-create-summary')?.value || '').trim();
    if (!title || !summary) return;
    const submit = form.querySelector('button[type="submit"]');
    if (submit?.disabled) return;
    if (submit) submit.disabled = true;
    try {
      const response = await window.apiFetch('/api/cognition/assets', {
        method: 'POST',
        body: JSON.stringify({ title, summary }),
      });
      const result = await parseResponse(response, translate('cognition.error.create_failed', '认知创建失败'));
      const asset = assertFullAsset(result?.asset, translate('cognition.error.invalid_response', '认知操作返回无效'));
      updateAsset(asset, { moveToFirstPage: true, isNew: true });
      view = 'tree';
      clearError();
      render();
      await reloadAfterMutation();
    } catch (error) {
      showError(error);
    } finally {
      if (submit?.isConnected) submit.disabled = false;
    }
  }

  async function addEvidence(asset) {
    if (typeof uiPrompt !== 'function') return;
    const summary = (await uiPrompt(translate('cognition.prompt.evidence_summary', '请输入证据摘要'), ''))?.trim();
    if (!summary) return;
    const sourceLabel = (await uiPrompt(translate('cognition.prompt.evidence_source', '请输入证据来源'), '当前会话'))?.trim();
    if (!sourceLabel) return;
    await postAction(`/api/cognition/assets/${encodeURIComponent(asset.id)}/evidence`, {
      kind: 'manual', summary, sourceLabel,
    });
  }

  async function recordReuse(asset) {
    if (typeof uiPrompt !== 'function') return;
    const sourceLabel = (await uiPrompt(translate('cognition.prompt.reuse_source', '请输入本次复用场景'), '当前会话'))?.trim();
    if (!sourceLabel) return;
    await postAction(`/api/cognition/assets/${encodeURIComponent(asset.id)}/reuse`, { sourceLabel });
  }

  function closeCaptureOverlay(overlay, onKeyDown, trigger, onBackdropClick) {
    if (onKeyDown) document.removeEventListener('keydown', onKeyDown, true);
    if (onBackdropClick) overlay?.removeEventListener('click', onBackdropClick);
    overlay?.remove();
    if (trigger?.isConnected && typeof trigger.focus === 'function') trigger.focus();
  }

  function openCognitionCapture(input = {}) {
    if (!window.CognitionPages || typeof window.CognitionPages.renderCognitionCapture !== 'function') return false;
    if (document.querySelector('.cognition-capture-overlay')) return false;
    const payload = input && typeof input === 'object' ? input : {};
    const conversationId = String(payload.conversationId || '').trim();
    const messageId = String(payload.messageId || '').trim();
    if (!conversationId || !messageId) return false;
    const trigger = document.activeElement;
    const overlay = document.createElement('div');
    const rendered = document.createElement('div');
    rendered.className = 'cognition-capture-overlay';
    if (!rendered) return false;
    const renderMarkup = (state, values = {}) => {
      rendered.innerHTML = window.CognitionPages.renderCognitionCapture({
        state,
        title: values.title || '',
        summary: values.summary || '',
        evidence: values.evidence || '',
        sourceLabel: values.sourceLabel || '',
        conversationId,
        error: values.error || '',
      });
    };
    renderMarkup('loading');
    document.body.appendChild(rendered);
    let closed = false;
    const onKeyDown = (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        closed = true;
        closeCaptureOverlay(rendered, onKeyDown, trigger, onBackdropClick);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(rendered.querySelectorAll(
        'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hidden);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onBackdropClick = (event) => {
      if (event.target === rendered) {
        closed = true;
        closeCaptureOverlay(rendered, onKeyDown, trigger, onBackdropClick);
      }
    };
    const bindControls = () => {
      rendered.querySelectorAll('[data-cognition-capture-cancel]').forEach((button) => {
        button.addEventListener('click', () => {
          closed = true;
          closeCaptureOverlay(rendered, onKeyDown, trigger, onBackdropClick);
        });
      });
      const form = rendered.querySelector('[data-cognition-capture-form]');
      if (!form || !form.querySelector('[data-cognition-capture-submit]')) return;
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const title = String(form.querySelector('[data-cognition-capture-title]')?.value || '').trim();
        const captureSummary = String(form.querySelector('[data-cognition-capture-summary]')?.value || '').trim();
        const evidenceSummary = String(form.querySelector('[data-cognition-capture-evidence]')?.value || '').trim();
        const sourceLabel = String(form.querySelector('[data-cognition-capture-source]')?.value || '').trim();
        if (!title || !captureSummary || !evidenceSummary || !sourceLabel) return;
        const submit = form.querySelector('[data-cognition-capture-submit]');
        if (submit?.disabled) return;
        if (submit) submit.disabled = true;
        try {
          const response = await window.apiFetch('/api/cognition/assets/capture', {
            method: 'POST',
            body: JSON.stringify({
              title,
              summary: captureSummary,
              evidence: {
                kind: 'conversation',
                summary: evidenceSummary,
                sourceLabel,
                conversationId,
              },
            }),
          });
          const result = await parseResponse(response, translate('cognition.error.action_failed', '认知操作失败'));
          const asset = assertFullAsset(result?.asset, translate('cognition.error.invalid_response', '认知操作返回无效'));
          updateAsset(asset, { moveToFirstPage: true, isNew: true });
          clearError();
          if (!document.querySelector('[data-personal-onto-workspace-pane="growth"]')?.hidden) render();
          void reloadAfterMutation();
          closed = true;
          closeCaptureOverlay(rendered, onKeyDown, trigger, onBackdropClick);
          if (typeof uiToast === 'function') uiToast(translate('cognition.capture.saved', '已保存到待确认认知'), { variant: 'success' });
        } catch (error) {
          if (submit) submit.disabled = false;
          let errorNode = form.querySelector('[data-cognition-capture-error]');
          if (!errorNode) {
            errorNode = document.createElement('p');
            errorNode.dataset.cognitionCaptureError = '1';
            errorNode.className = 'cognition-capture-error';
            form.querySelector('.cognition-capture-body')?.appendChild(errorNode);
          }
          errorNode.textContent = apiError(error);
        }
      });
    };
    rendered.addEventListener('click', onBackdropClick);
    document.addEventListener('keydown', onKeyDown, true);
    bindControls();
    const generate = async () => {
      try {
        if (!window.cogseed || typeof window.cogseed.invoke !== 'function') throw new Error(translate('cognition.capture.generation_failed', '认知草稿生成失败，请稍后重试。'));
        const result = await window.cogseed.invoke('cognition.capture.draft', { conversationId, messageId });
        if (closed || !rendered.isConnected) return;
        if (!result || result.ok === false) throw new Error(String(result?.error || translate('cognition.capture.generation_failed', '认知草稿生成失败，请稍后重试。')));
        if (result.status === 'not_reusable') {
          renderMarkup('error', { error: result.reason || translate('cognition.capture.no_candidate', '这条回复没有足够的可复用工作方式。') });
          bindControls();
          return;
        }
        const draft = result.draft;
        if (result.status !== 'ready' || !draft || typeof draft.title !== 'string'
            || typeof draft.summary !== 'string' || typeof draft.evidenceSummary !== 'string'
            || typeof draft.sourceLabel !== 'string') {
          throw new Error(translate('cognition.capture.generation_failed', '认知草稿生成失败，请稍后重试。'));
        }
        renderMarkup('ready', {
          title: draft.title,
          summary: draft.summary,
          evidence: draft.evidenceSummary,
          sourceLabel: draft.sourceLabel,
        });
        bindControls();
        rendered.querySelector('[data-cognition-capture-title]')?.focus();
      } catch (error) {
        if (closed || !rendered.isConnected) return;
        renderMarkup('error', { error: apiError(error) || translate('cognition.capture.generation_failed', '认知草稿生成失败，请稍后重试。') });
        bindControls();
      }
    };
    void generate();
    return true;
  }

  function bind(page) {
    page.querySelectorAll('[data-cognition-view]').forEach((button) => {
      button.addEventListener('click', () => {
        view = button.dataset.cognitionView || 'tree';
        ensureActiveSummary();
        render();
        void loadActiveAsset();
      });
    });
    page.querySelectorAll('[data-cognition-select]').forEach((button) => {
      button.addEventListener('click', () => {
        activeId = button.dataset.cognitionSelect || null;
        render();
        void loadActiveAsset();
      });
    });
    page.querySelectorAll('[data-cognition-page]').forEach((button) => {
      button.addEventListener('click', () => {
        const requestedPage = Number(button.dataset.cognitionPage);
        if (!button.disabled && isPositiveInteger(requestedPage)) void loadCognitionAssets(requestedPage);
      });
    });
    page.querySelectorAll('[data-cognition-action]').forEach((button) => {
      button.addEventListener('click', async () => {
        const action = button.dataset.cognitionAction;
        const asset = selectedAsset();
        if (action === 'open-create') {
          const form = page.querySelector('#cognition-create-form');
          if (form) form.hidden = false;
          page.querySelector('#cognition-create-title')?.focus();
          return;
        }
        if (action === 'cancel-create') {
          const form = page.querySelector('#cognition-create-form');
          if (form) form.hidden = true;
          return;
        }
        if (action === 'retry-detail') {
          void loadActiveAsset({ force: true });
          return;
        }
        if (!asset || button.dataset.cognitionBusy === '1') return;
        button.dataset.cognitionBusy = '1';
        button.disabled = true;
        try {
          if (action === 'confirm') await postAction(`/api/cognition/assets/${encodeURIComponent(asset.id)}/confirm`);
          else if (action === 'defer') await postAction(`/api/cognition/assets/${encodeURIComponent(asset.id)}/defer`);
          else if (action === 'add-evidence') await addEvidence(asset);
          else if (action === 'reuse') await recordReuse(asset);
          else if (action === 'view-history') { view = 'history'; render(); }
        } catch (error) {
          showError(error);
        } finally {
          if (button.isConnected) {
            delete button.dataset.cognitionBusy;
            button.disabled = false;
          }
        }
      });
    });
    page.querySelector('#cognition-create-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void createAsset(event.currentTarget);
    });
  }

  window.renderCognitionPage = function renderCognitionPage() {
    if (!listLoading) void loadCognitionAssets(pagination.page);
    else render();
  };
  window.openCognitionCapture = openCognitionCapture;
  window.addEventListener('i18n-change', () => {
    if (!document.querySelector('[data-personal-onto-workspace-pane="growth"]')?.hidden) render();
  });
})();
