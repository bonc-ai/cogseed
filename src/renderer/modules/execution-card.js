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
        <strong>为什么：</strong>${_escapeHtml(record.why)}
      </div>
      ${record.resources && record.resources.length > 0 ? `
        <div class="execution-resources">
          <strong>涉及资源：</strong>${record.resources.map(r => _escapeHtml(r)).join(', ')}
        </div>
      ` : ''}
      <div class="execution-risk">
        <strong>风险等级：</strong>${getRiskLabel(record.risk)}
      </div>
    </div>
    ${record.output ? `
      <div class="execution-output">
        <pre>${_escapeHtml(record.output)}</pre>
      </div>
    ` : ''}
    ${record.errorMessage ? `
      <div class="execution-error">
        <strong>错误：</strong>${_escapeHtml(record.errorMessage)}
      </div>
    ` : ''}
    <div class="execution-footer">
      <button class="debug-toggle" onclick="window.toggleExecutionDebug('${record.id}')">
        显示命令
      </button>
      <pre class="debug-command hidden">${_escapeHtml(record.rawCommand || '无')}</pre>
    </div>
  `;

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
  switch (risk) {
    case 'low': return '低风险（仅读写项目目录）';
    case 'medium': return '中等风险（涉及网络或脚本执行）';
    case 'high': return '高风险（涉及敏感路径或系统级操作）';
    default: return '未知';
  }
}

/**
 * Get status badge HTML.
 */
function getStatusBadge(status) {
  switch (status) {
    case 'pending': return '<span class="status-badge status-pending">等待中</span>';
    case 'running': return '<span class="status-badge status-running">执行中</span>';
    case 'success': return '<span class="status-badge status-success">已完成</span>';
    case 'failed': return '<span class="status-badge status-failed">失败</span>';
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
    toggle.textContent = '隐藏命令';
  } else {
    command.classList.add('hidden');
    toggle.textContent = '显示命令';
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
    errorDiv.innerHTML = `<strong>错误：</strong>${_escapeHtml(updates.errorMessage)}`;
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
