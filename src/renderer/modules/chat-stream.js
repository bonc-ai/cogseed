// ─── chat-stream: 结构化会话事件的过程面板（conv-core M1） ─────────────────
//
// 消费主进程 conversations.sendStream 并行下发的 stream:'chat' 事件
// （chat.turn.started/completed、chat.item 五种 kind），渲染为当前回合的
// 「过程面板」：每个工具调用一张实时卡片（进行中/完成/失败三态、输出可
// 折叠）、思考提示折叠条、用量条。正文文本仍走老 delta 通道渲染，本模块
// 跳过 kind:text 不重复显示。
//
// 契约见 design/conv-core/spec.md；事件形状的事实源在主进程
// src/main/features/chat_events/schema.ts。
//
// 接入点：conversation.js `_handleStreamEvent` 的 stream:'chat' 分支调用
// window.chatStreamHandleEvent(cid, anchorEl, chatEvent)。

const _csLog = typeof createLogger === 'function'
  ? createLogger('chat-stream')
  : { info() {}, warn() {}, error() {} };

function _csEscapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** cid+turnId → 面板根元素。流式回合切换/视图切换时由 GC 惰性清理。 */
const _csPanels = new Map();

function _csPanelKey(cid, turnId) { return `${cid}::${turnId}`; }

function _csStatusIcon(status) {
  if (status === 'completed') return '✓';
  if (status === 'failed') return '✗';
  return '◌';
}

function _csPanelClass(status) {
  if (status === 'completed') return 'cs-panel done';
  if (status === 'failed') return 'cs-panel failed';
  if (status === 'cancelled') return 'cs-panel cancelled';
  return 'cs-panel running';
}

function _csCreatePanel(cid, turnId, actorId) {
  const panel = document.createElement('div');
  panel.className = 'cs-panel running';
  panel.dataset.csTurn = turnId;
  panel.dataset.csActor = actorId || '';

  const header = document.createElement('div');
  header.className = 'cs-panel-header';

  const spinner = document.createElement('span');
  spinner.className = 'cs-spinner';
  spinner.setAttribute('aria-hidden', 'true');

  const title = document.createElement('span');
  title.className = 'cs-panel-title';
  title.textContent = actorId || turnId;

  const state = document.createElement('span');
  state.className = 'cs-panel-state';
  state.dataset.csState = '';
  state.textContent = '运行中';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'cs-panel-toggle';
  toggle.textContent = '收起';
  toggle.setAttribute('aria-expanded', 'true');
  toggle.addEventListener('click', () => {
    const body = panel.querySelector('.cs-panel-body');
    if (!body) return;
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : '';
    toggle.textContent = open ? '展开' : '收起';
    toggle.setAttribute('aria-expanded', String(!open));
  });

  header.appendChild(spinner);
  header.appendChild(title);
  header.appendChild(state);
  header.appendChild(toggle);

  const body = document.createElement('div');
  body.className = 'cs-panel-body';
  panel.appendChild(header);
  panel.appendChild(body);
  return panel;
}

function _csEnsurePanel(cid, anchor, turnId, actorId) {
  const key = _csPanelKey(cid, turnId);
  let panel = _csPanels.get(key);
  if (panel && panel.isConnected) return { panel, body: panel.querySelector('.cs-panel-body') };
  panel = _csCreatePanel(cid, turnId, actorId);
  // 面板挂在流式占位气泡之前：先见过程，后见正文，与阅读动线一致。
  anchor.parentNode && anchor.parentNode.insertBefore(panel, anchor);
  _csPanels.set(key, panel);
  // 惰性清理：超过 40 个面板时丢最老的已完成面板，防长会话 DOM 无界。
  if (_csPanels.size > 40) {
    const firstKey = _csPanels.keys().next().value;
    const oldest = _csPanels.get(firstKey);
    if (oldest && !oldest.classList.contains('running')) {
      oldest.remove();
      _csPanels.delete(firstKey);
    }
  }
  return { panel, body: panel.querySelector('.cs-panel-body') };
}

function _csSetPanelState(panel, status, error) {
  panel.className = _csPanelClass(status);
  const spinner = panel.querySelector('.cs-spinner');
  if (spinner) spinner.style.display = status === 'completed' || status === 'failed' || status === 'cancelled' ? 'none' : '';
  const stateEl = panel.querySelector('[data-cs-state]');
  if (stateEl) {
    const label = status === 'completed' ? '已完成'
      : status === 'failed' ? `失败${error ? `：${error}` : ''}`
      : status === 'cancelled' ? '已取消' : '运行中';
    stateEl.textContent = label;
  }
}

// ── Item 卡片 ───────────────────────────────────────────────────────────────

function _csEnsureItemCard(body, itemId, kind) {
  let card = body.querySelector(`[data-cs-item="${CSS.escape(itemId)}"]`);
  if (card) return card;
  card = document.createElement('div');
  card.className = `cs-card cs-${kind}`;
  card.dataset.csItem = itemId;
  body.appendChild(card);
  return card;
}

function _csRenderToolCard(card, payload, status) {
  const p = payload || {};
  const parts = [
    `<div class="cs-card-head">
      <span class="cs-card-ico ${status}">${_csStatusIcon(status)}</span>
      <span class="cs-tool-name">${_csEscapeHtml(p.toolName || 'tool')}</span>
      ${p.argsSummary ? `<span class="cs-tool-args">${_csEscapeHtml(p.argsSummary)}</span>` : ''}
    </div>`,
  ];
  if (p.error) parts.push(`<div class="cs-card-error">${_csEscapeHtml(p.error)}</div>`);
  if (p.output) {
    parts.push(`<div class="cs-card-out"><pre>${_csEscapeHtml(p.output)}</pre></div>`);
  }
  card.innerHTML = parts.join('');
}

function _csRenderReasoningCard(card, payload) {
  const text = (payload && payload.text) || '';
  card.innerHTML = `
    <div class="cs-card-head cs-reason-head">
      <span class="cs-card-ico completed">💭</span>
      <span class="cs-reason-text">${_csEscapeHtml(text)}</span>
    </div>`;
}

function _csRenderDiffCard(card, payload) {
  const p = payload || {};
  const diff = String(p.diff || '');
  const lines = diff.split('\n').slice(0, 400).map((line) => {
    const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add'
      : line.startsWith('-') && !line.startsWith('---') ? 'del' : 'ctx';
    return `<span class="cs-diff-line ${cls}">${_csEscapeHtml(line)}</span>`;
  }).join('');
  card.innerHTML = `
    <div class="cs-card-head">
      <span class="cs-card-ico completed">✎</span>
      <span class="cs-diff-path">${_csEscapeHtml(p.filePath || '')}</span>
      ${p.summary ? `<span class="cs-diff-summary">${_csEscapeHtml(p.summary)}</span>` : ''}
    </div>
    <div class="cs-diff-body">${lines}</div>`;
}

function _csRenderUsageCard(card, payload) {
  const p = payload || {};
  const bits = [];
  if (p.inputTokens != null) bits.push(`↑${p.inputTokens.toLocaleString()}`);
  if (p.outputTokens != null) bits.push(`↓${p.outputTokens.toLocaleString()}`);
  if (p.estimatedCost != null) bits.push(`≈$${p.estimatedCost}`);
  if (p.contextWindowRatio != null) {
    const pct = Math.round(p.contextWindowRatio * 100);
    bits.push(`ctx ${pct}%`);
    if (pct >= 85) bits.push('<span class="cs-ctx-warn">上下文接近上限</span>');
  }
  if (!bits.length) return;
  card.innerHTML = `<div class="cs-usage">${bits.join(' · ')}</div>`;
}

// ── 事件入口（conversation.js 调用） ───────────────────────────────────────

window.chatStreamHandleEvent = function chatStreamHandleEvent(cid, anchor, chatEvent) {
  if (!chatEvent || typeof chatEvent !== 'object') return;
  try {
    if (chatEvent.type === 'chat.turn.started') {
      _csEnsurePanel(cid, anchor, chatEvent.turnId, chatEvent.actorId);
      return;
    }
    if (chatEvent.type === 'chat.item') {
      const { kind, status, itemId, payload, turnId } = chatEvent;
      if (kind === 'text') return; // 正文走老 delta 通道，不重复渲染
      const { body } = _csEnsurePanel(cid, anchor, turnId);
      const card = _csEnsureItemCard(body, itemId, kind);
      if (kind === 'toolExecution') _csRenderToolCard(card, payload, status);
      else if (kind === 'reasoning') _csRenderReasoningCard(card, payload);
      else if (kind === 'fileChange') _csRenderDiffCard(card, payload);
      else if (kind === 'usage') _csRenderUsageCard(card, payload);
      return;
    }
    if (chatEvent.type === 'chat.turn.completed') {
      const panel = _csPanels.get(_csPanelKey(cid, chatEvent.turnId));
      if (panel) _csSetPanelState(panel, chatEvent.status, chatEvent.error);
      return;
    }
    // interaction.requested/closed 在 M2 接入（见 ledger）。
  } catch (err) {
    _csLog.warn('chat-stream render failed', { error: String(err && err.message || err) });
  }
};

/** 视图切换/历史重建时丢弃全部面板（conversation.js 重建消息列表后调用）。 */
window.chatStreamReset = function chatStreamReset() {
  for (const panel of _csPanels.values()) panel.remove();
  _csPanels.clear();
};

_csLog.info('chat-stream module loaded');
