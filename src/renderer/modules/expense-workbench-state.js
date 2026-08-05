/* Pure state and validation helpers for the embedded reimbursement workbench. */
(function () {
  'use strict';

  const PAGES = Object.freeze([
    'assistant',
    'applications',
    'precheck',
    'overview',
    'reviews',
    'connections',
    'audit',
  ]);

  const OPERATION_LABELS = Object.freeze({
    configure: 'configure',
    create: 'create',
    save: 'save',
    materials: 'materials',
    precheck: 'precheck',
    report: 'report',
    'formal-report': 'formal-report',
    submit: 'submit',
    'submit-status': 'submit-status',
    'recover-submission': 'recover-submission',
    'retry-feishu': 'retry-feishu',
    'retry-feishu-notifications': 'retry-feishu-notifications',
    assistant: 'assistant',
    'settings-preflight': 'settings-preflight',
  });

  function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function createState(seed) {
    const source = isRecord(seed) ? seed : {};
    const page = PAGES.includes(source.page) ? source.page : 'assistant';
    return {
      page,
      pageEpoch: Number.isInteger(source.pageEpoch) && source.pageEpoch >= 0 ? source.pageEpoch : 0,
      applications: Array.isArray(source.applications) ? source.applications.slice() : [],
      selectedId: typeof source.selectedId === 'string' ? source.selectedId : '',
      selectedApplication: isRecord(source.selectedApplication) ? source.selectedApplication : null,
      precheck: isRecord(source.precheck) ? source.precheck : null,
      reviews: Array.isArray(source.reviews) ? source.reviews.slice() : [],
      audit: Array.isArray(source.audit) ? source.audit.slice() : [],
      stats: isRecord(source.stats) ? source.stats : null,
      settings: isRecord(source.settings) ? source.settings : null,
      feishuPreflight: isRecord(source.feishuPreflight) ? source.feishuPreflight : null,
      assistantMessage: typeof source.assistantMessage === 'string' ? source.assistantMessage : '',
      message: typeof source.message === 'string' ? source.message : '',
      loading: source.loading === true,
      error: isRecord(source.error) ? source.error : null,
      conflict: isRecord(source.conflict) ? source.conflict : null,
      recovery: isRecord(source.recovery) ? source.recovery : null,
      progress: isRecord(source.progress) ? source.progress : null,
      busy: isRecord(source.busy) ? { ...source.busy } : {},
    };
  }

  function isPage(value) {
    return typeof value === 'string' && PAGES.includes(value);
  }

  function isOperationKey(value) {
    return typeof value === 'string'
      && (Object.prototype.hasOwnProperty.call(OPERATION_LABELS, value) || /^approval-.+/.test(value));
  }

  function nextPageEpoch(state, page) {
    if (!isRecord(state)) throw new Error('workbench state is required');
    if (!isPage(page)) throw new Error('workbench page is invalid');
    const next = Number.isInteger(state.pageEpoch) && state.pageEpoch >= 0 ? state.pageEpoch + 1 : 1;
    state.page = page;
    state.pageEpoch = next;
    state.loading = true;
    state.error = null;
    state.message = '';
    return next;
  }

  function isCurrentEpoch(state, epoch) {
    return isRecord(state) && Number.isInteger(epoch) && state.pageEpoch === epoch;
  }

  function setLoading(state, loading) {
    if (!isRecord(state)) throw new Error('workbench state is required');
    state.loading = loading === true;
  }

  function setProgress(state, operation, message, status) {
    if (!isRecord(state)) throw new Error('workbench state is required');
    if (operation !== null && !isOperationKey(operation)) {
      throw new Error('workbench operation is invalid');
    }
    if (message !== null && typeof message !== 'string') throw new Error('progress message is invalid');
    if (status !== null && !['running', 'success', 'error', 'cancelled'].includes(status)) {
      throw new Error('progress status is invalid');
    }
    state.progress = operation === null
      ? null
      : { operation, message: message || '', status: status || 'running' };
  }

  function setBusy(state, operation, busy) {
    if (!isRecord(state)) throw new Error('workbench state is required');
    if (!isOperationKey(operation)) throw new Error('workbench operation is invalid');
    if (!isRecord(state.busy)) state.busy = {};
    if (busy) state.busy[operation] = true;
    else delete state.busy[operation];
  }

  function isBusy(state, operation) {
    return isRecord(state) && isRecord(state.busy) && state.busy[operation] === true;
  }

  function normalizeError(error, fallbackMessage) {
    const source = isRecord(error) ? error : {};
    const cause = error instanceof Error ? error : null;
    const code = typeof source.code === 'string' && source.code ? source.code : 'workbench_operation_failed';
    const message = typeof source.message === 'string' && source.message
      ? source.message
      : (cause && cause.message ? cause.message : fallbackMessage || '报销工作台操作失败');
    return {
      code,
      message: message.slice(0, 1_000),
      retryable: source.retryable === true || /retry|timeout|unavailable|network/i.test(code),
    };
  }

  function parseDraftText(value) {
    if (typeof value !== 'string' || value.length > 1_000_000) {
      return { ok: false, code: 'draft_too_large', message: '草稿内容过大，无法安全处理。' };
    }
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch (_) {
      return { ok: false, code: 'draft_invalid_json', message: '草稿数据不是有效 JSON。' };
    }
    const validation = validateDraftPayload(parsed);
    return validation.ok ? { ok: true, value: parsed } : validation;
  }

  function validateDraftPayload(value) {
    if (!isRecord(value)) return { ok: false, code: 'draft_not_object', message: '草稿必须是 JSON 对象。' };
    if (!Array.isArray(value.expense_items) || value.expense_items.length === 0) {
      return { ok: false, code: 'draft_missing_items', message: '至少填写一笔费用明细后再保存。' };
    }
    if (value.expense_items.length > 1_000) {
      return { ok: false, code: 'draft_too_many_items', message: '费用明细数量超过安全上限。' };
    }
    for (const item of value.expense_items) {
      if (!isRecord(item) || typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount <= 0) {
        return { ok: false, code: 'draft_invalid_amount', message: '每笔费用明细都必须包含大于 0 的金额。' };
      }
    }
    return { ok: true, value };
  }

  function applyVersionGuard(state, expectedVersion, incomingVersion) {
    if (!isRecord(state)) throw new Error('workbench state is required');
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new Error('expected version is invalid');
    if (!Number.isInteger(incomingVersion) || incomingVersion < 0) throw new Error('incoming version is invalid');
    if (incomingVersion < expectedVersion) {
      state.conflict = { expectedVersion, incomingVersion, kind: 'stale_response' };
      return false;
    }
    state.conflict = null;
    return true;
  }

  function clearTransient(state) {
    if (!isRecord(state)) throw new Error('workbench state is required');
    state.error = null;
    state.conflict = null;
    state.recovery = null;
    state.message = '';
    state.progress = null;
  }

  const api = {
    PAGES,
    createState,
    isPage,
    nextPageEpoch,
    isCurrentEpoch,
    setLoading,
    setProgress,
    setBusy,
    isBusy,
    normalizeError,
    parseDraftText,
    validateDraftPayload,
    applyVersionGuard,
    clearTransient,
  };

  if (typeof window !== 'undefined') window.expenseWorkbenchState = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
}());
