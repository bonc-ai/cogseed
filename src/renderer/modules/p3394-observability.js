// P3394 execution observability render helpers. Pure string renderers for tests and UI reuse.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function localizedText(key, fallback) {
  if (typeof t !== 'function') return fallback;
  const value = t(key);
  return value === key ? fallback : value;
}

function boundaryKey(boundary) {
  if (boundary === 'real') return 'p3394.observability.boundary.real';
  if (boundary === 'degraded') return 'p3394.observability.boundary.degraded';
  if (boundary === 'test-double') return 'p3394.observability.boundary.test_double';
  return 'p3394.observability.boundary.unknown';
}

function boundaryLabel(boundary) {
  const fallbacks = {
    real: '真实执行',
    degraded: '降级执行',
    'test-double': '测试替身',
  };
  return localizedText(boundaryKey(boundary), fallbacks[boundary] || '未知边界');
}

function statusKey(status) {
  const normalized = String(status || '').toLowerCase();
  const known = ['pending', 'running', 'completed', 'success', 'failed', 'cancelled'];
  return known.includes(normalized) ? `p3394.observability.execution_status.${normalized}` : '';
}

function statusLabel(status) {
  const key = statusKey(status);
  const fallbacks = {
    pending: '等待中', running: '执行中', completed: '已完成',
    success: '已完成', failed: '失败', cancelled: '已取消',
  };
  return key ? localizedText(key, fallbacks[status] || String(status)) : String(status || 'unknown');
}

function renderExecutionObservability(data) {
  const contrast = data && data.contrast || {};
  const receipt = data && data.receipt || {};
  const refs = (key, fallback, values) => `<div class="p3394-exec-refs"><b data-i18n="${key}">${escapeHtml(localizedText(key, fallback))}</b>: ${(values || []).length ? escapeHtml(values.join(', ')) : `<span data-i18n="p3394.observability.none">${escapeHtml(localizedText('p3394.observability.none', '无'))}</span>`}</div>`;
  const side = (key, fallback, value) => {
    const rawStatus = value && value.status || 'unknown';
    const statusI18n = statusKey(rawStatus);
    return `<div class="p3394-exec-side"><h4 data-i18n="${key}">${escapeHtml(localizedText(key, fallback))}</h4><div><span data-i18n="p3394.observability.status">${escapeHtml(localizedText('p3394.observability.status', '状态'))}</span>: <span${statusI18n ? ` data-i18n="${statusI18n}"` : ''}>${escapeHtml(statusLabel(rawStatus))}</span></div><div><span data-i18n="p3394.observability.artifacts">${escapeHtml(localizedText('p3394.observability.artifacts', '产物'))}</span>: ${escapeHtml((value && value.artifactIds || []).length)}</div></div>`;
  };
  const boundary = contrast.boundary || receipt.boundary;
  const receiptStatusKey = statusKey(receipt.status);
  return '<section class="p3394-execution-observability">'
    + `<div class="p3394-boundary-label" data-i18n="${boundaryKey(boundary)}">${escapeHtml(boundaryLabel(boundary))}</div>`
    + '<div class="p3394-exec-compare">' + side('p3394.observability.baseline', 'Baseline', contrast.baseline) + side('p3394.observability.treatment', 'Treatment', contrast.treatment) + '</div>'
    + `<div><span data-i18n="p3394.observability.receipt">${escapeHtml(localizedText('p3394.observability.receipt', 'Receipt'))}</span>: <span${receiptStatusKey ? ` data-i18n="${receiptStatusKey}"` : ''}>${escapeHtml(statusLabel(receipt.status))}</span></div>`
    + `<div><span data-i18n="p3394.observability.permission">${escapeHtml(localizedText('p3394.observability.permission', 'Permission'))}</span>: ${escapeHtml(receipt.permissionMode || '')}</div>`
    + refs('p3394.observability.reused_refs', 'Reused refs', receipt.reusedRefs)
    + refs('p3394.observability.omitted_refs', 'Omitted refs', receipt.omittedRefs)
    + '</section>';
}

function renderValidationRun(run) {
  if (!run) return `<div class="p3394-empty" data-i18n="p3394.observability.validation_empty">${escapeHtml(localizedText('p3394.observability.validation_empty', '暂无验证结果'))}</div>`;
  const labels = { pass: '通过', risk: '风险', blocked: '阻断', degraded: '降级' };
  const statusI18n = `p3394.observability.validation_status.${run.status}`;
  return '<section class="p3394-validation-run">'
    + `<div class="p3394-validation-status" data-i18n="${statusI18n}">${escapeHtml(localizedText(statusI18n, labels[run.status] || run.status))}</div>`
    + `<div><span data-i18n="p3394.observability.validator">${escapeHtml(localizedText('p3394.observability.validator', 'Validator'))}</span>: ${escapeHtml(run.validatorVersion || '')}</div>`
    + `<div><span data-i18n="p3394.observability.scanned_files">${escapeHtml(localizedText('p3394.observability.scanned_files', 'Scanned files'))}</span>: ${escapeHtml(run.scannedFiles || 0)}</div>`
    + `<div><span data-i18n="p3394.observability.violations">${escapeHtml(localizedText('p3394.observability.violations', 'Violations'))}</span>: ${escapeHtml((run.violations || []).length)}</div>`
    + `<div data-i18n="${boundaryKey(run.boundary)}">${escapeHtml(boundaryLabel(run.boundary))}</div>`
    + '</section>';
}

if (typeof module !== 'undefined') {
  module.exports = { escapeHtml, boundaryLabel, renderExecutionObservability, renderValidationRun };
}
