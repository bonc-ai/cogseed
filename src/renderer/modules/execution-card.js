// ─── Execution Card (unified execution record UI) ─────────────────────────
//
// Renders ExecutionRecord in a consistent format whether the execution is
// in progress or completed. Replaces raw command display with human-readable
// intent cards showing "what/why/resources/risk".
//
// Usage:
//   const card = renderExecutionCard(executionRecord);
//   messageContainer.appendChild(card);

console.log('[execution-card] execution-card.js module loading...');

const _ecLog = typeof createLogger === 'function' ? createLogger('execution-card') : { info() {}, warn() {}, error() {} };

/**
 * Render an execution record as a DOM element.
 * @param {Object} record - ExecutionRecord from backend
 * @returns {HTMLElement} - Card element
 */
function renderExecutionCard(record) {
  const card = document.createElement('div');
  card.className = `execution-card risk-${record.risk} status-${record.status}`;
  card.dataset.executionId = record.id;

  // Risk icon
  const riskIcon = getRiskIcon(record.risk);

  // Status badge
  const statusBadge = getStatusBadge(record.status);

  // Build card content
  card.innerHTML = `
    <div class="execution-card-header">
      <span class="execution-icon">${riskIcon}</span>
      <span class="execution-intent">${_escapeHtml(record.intent)}</span>
      ${statusBadge}
    </div>
    <div class="execution-details">
      <div class="execution-why">
        <strong data-i18n="execution_card.why">${_escapeHtml(t('execution_card.why', '为什么：'))}</strong>${_escapeHtml(record.why)}
      </div>
      ${record.resources && record.resources.length > 0 ? `
        <div class="execution-resources">
          <strong data-i18n="execution_card.resources">${_escapeHtml(t('execution_card.resources', '涉及资源：'))}</strong>${record.resources.map(r => _escapeHtml(r)).join(', ')}
        </div>
      ` : ''}
      <div class="execution-risk">
        <strong data-i18n="execution_card.risk_level">${_escapeHtml(t('execution_card.risk_level', '风险等级：'))}</strong><span data-i18n="${getRiskKey(record.risk)}">${_escapeHtml(getRiskLabel(record.risk))}</span>
      </div>
    </div>
    ${record.output ? `
      <div class="execution-output">
        <pre>${_escapeHtml(record.output)}</pre>
      </div>
    ` : ''}
    ${record.errorMessage ? `
      <div class="execution-error">
        <strong data-i18n="execution_card.error">${_escapeHtml(t('execution_card.error', '错误：'))}</strong>${_escapeHtml(record.errorMessage)}
      </div>
    ` : ''}
    <div class="execution-footer">
      <button class="debug-toggle" data-i18n="execution_card.show_command" onclick="window.toggleExecutionDebug('${record.id}')">
        ${_escapeHtml(t('execution_card.show_command', '显示命令'))}
      </button>
      <pre class="debug-command hidden"${record.rawCommand ? '' : ' data-i18n="execution_card.no_command"'}>${_escapeHtml(record.rawCommand || t('execution_card.no_command', '无'))}</pre>
    </div>
  `;

  if (typeof applyDomI18n === 'function') applyDomI18n(card);

  return card;
}

/**
 * Get risk icon emoji.
 */
function getRiskIcon(risk) {
  switch (risk) {
    case 'low': return '✅';
    case 'medium': return '⚠️';
    case 'high': return '🔴';
    default: return '❓';
  }
}

/**
 * Get risk label text.
 */
function getRiskLabel(risk) {
  return t(getRiskKey(risk), risk === 'low'
    ? '低风险（仅读写项目目录）'
    : risk === 'medium'
      ? '中等风险（涉及网络或脚本执行）'
      : risk === 'high'
        ? '高风险（涉及敏感路径或系统级操作）'
        : '未知');
}

function getRiskKey(risk) {
  if (risk === 'low' || risk === 'medium' || risk === 'high') return `execution_card.risk.${risk}`;
  return 'execution_card.risk.unknown';
}

/**
 * Get status badge HTML.
 */
function getStatusBadge(status) {
  switch (status) {
    case 'pending': return `<span class="status-badge status-pending" data-i18n="execution_card.status.pending">${_escapeHtml(t('execution_card.status.pending', '等待中'))}</span>`;
    case 'running': return `<span class="status-badge status-running" data-i18n="execution_card.status.running">${_escapeHtml(t('execution_card.status.running', '执行中'))}</span>`;
    case 'success': return `<span class="status-badge status-success" data-i18n="execution_card.status.success">${_escapeHtml(t('execution_card.status.success', '已完成'))}</span>`;
    case 'failed': return `<span class="status-badge status-failed" data-i18n="execution_card.status.failed">${_escapeHtml(t('execution_card.status.failed', '失败'))}</span>`;
    default: return '';
  }
}

/**
 * Toggle debug command visibility.
 */
window.toggleExecutionDebug = function(executionId) {
  const card = document.querySelector(`[data-execution-id="${executionId}"]`);
  if (!card) return;

  const toggle = card.querySelector('.debug-toggle');
  const command = card.querySelector('.debug-command');

  if (command.classList.contains('hidden')) {
    command.classList.remove('hidden');
    toggle.dataset.i18n = 'execution_card.hide_command';
    toggle.textContent = t('execution_card.hide_command', '隐藏命令');
  } else {
    command.classList.add('hidden');
    toggle.dataset.i18n = 'execution_card.show_command';
    toggle.textContent = t('execution_card.show_command', '显示命令');
  }
};

/**
 * Update an existing execution card (for realtime updates).
 */
function updateExecutionCard(executionId, updates) {
  const card = document.querySelector(`[data-execution-id="${executionId}"]`);
  if (!card) {
    _ecLog.warn('execution card not found for update', { executionId });
    return;
  }

  // Update status badge
  if (updates.status) {
    const oldBadge = card.querySelector('.status-badge');
    if (oldBadge) {
      const newBadge = document.createElement('span');
      newBadge.outerHTML = getStatusBadge(updates.status);
      oldBadge.replaceWith(newBadge);
    }
    card.className = card.className.replace(/status-\w+/, `status-${updates.status}`);
  }

  // Update output
  if (updates.output !== undefined) {
    let outputDiv = card.querySelector('.execution-output');
    if (!outputDiv) {
      outputDiv = document.createElement('div');
      outputDiv.className = 'execution-output';
      card.querySelector('.execution-footer').before(outputDiv);
    }
    outputDiv.innerHTML = `<pre>${_escapeHtml(updates.output)}</pre>`;
  }

  // Update error message
  if (updates.errorMessage) {
    let errorDiv = card.querySelector('.execution-error');
    if (!errorDiv) {
      errorDiv = document.createElement('div');
      errorDiv.className = 'execution-error';
      card.querySelector('.execution-footer').before(errorDiv);
    }
    errorDiv.innerHTML = `<strong data-i18n="execution_card.error">${_escapeHtml(t('execution_card.error', '错误：'))}</strong>${_escapeHtml(updates.errorMessage)}`;
    if (typeof applyDomI18n === 'function') applyDomI18n(errorDiv);
  }
}

/**
 * Escape HTML to prevent XSS.
 */
function _escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Expose to global scope
window.renderExecutionCard = renderExecutionCard;
window.updateExecutionCard = updateExecutionCard;

console.log('[execution-card] execution-card.js module loaded successfully');
