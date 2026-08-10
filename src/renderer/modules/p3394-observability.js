// P3394 execution observability render helpers. Pure string renderers for tests and UI reuse.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function boundaryLabel(boundary) {
  if (boundary === 'real') return '真实执行';
  if (boundary === 'degraded') return '降级执行';
  if (boundary === 'test-double') return '测试替身';
  return '未知边界';
}

function renderExecutionObservability(data) {
  const contrast = data && data.contrast || {};
  const receipt = data && data.receipt || {};
  const refs = (label, values) => `<div class="p3394-exec-refs"><b>${escapeHtml(label)}</b>: ${escapeHtml((values || []).join(', ') || '无')}</div>`;
  const side = (label, value) => `<div class="p3394-exec-side"><h4>${escapeHtml(label)}</h4><div>状态: ${escapeHtml(value && value.status || 'unknown')}</div><div>Artifacts: ${escapeHtml((value && value.artifactIds || []).length)}</div></div>`;
  return '<section class="p3394-execution-observability">'
    + `<div class="p3394-boundary-label">${escapeHtml(boundaryLabel(contrast.boundary || receipt.boundary))}</div>`
    + '<div class="p3394-exec-compare">' + side('Baseline', contrast.baseline) + side('Treatment', contrast.treatment) + '</div>'
    + `<div>Receipt: ${escapeHtml(receipt.status || 'unknown')}</div>`
    + `<div>Permission: ${escapeHtml(receipt.permissionMode || '')}</div>`
    + refs('Reused refs', receipt.reusedRefs)
    + refs('Omitted refs', receipt.omittedRefs)
    + '</section>';
}

function renderValidationRun(run) {
  if (!run) return '<div class="p3394-empty">暂无验证结果</div>';
  const labels = { pass: '通过', risk: '风险', blocked: '阻断', degraded: '降级' };
  return '<section class="p3394-validation-run">'
    + `<div class="p3394-validation-status">${escapeHtml(labels[run.status] || run.status)}</div>`
    + `<div>Validator: ${escapeHtml(run.validatorVersion || '')}</div>`
    + `<div>Scanned files: ${escapeHtml(run.scannedFiles || 0)}</div>`
    + `<div>Violations: ${escapeHtml((run.violations || []).length)}</div>`
    + `<div>${escapeHtml(boundaryLabel(run.boundary))}</div>`
    + '</section>';
}

if (typeof module !== 'undefined') {
  module.exports = { escapeHtml, boundaryLabel, renderExecutionObservability, renderValidationRun };
}
