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

  // 就近取消（矩阵 #6）：面板运行中显示「停止」，复用主输入区停止按钮的
  // 完整 abort 链（streaming 态下点击发送按钮即中止）——不另铺 IPC。
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'cs-panel-stop';
  stop.textContent = '停止';
  stop.title = '中止本轮执行';
  stop.addEventListener('click', () => {
    const mainStop = document.querySelector('.chat-send-btn.streaming');
    if (mainStop) {
      mainStop.click();
      return;
    }
    // 主按钮不在 streaming 态（如派单后台轮次）——面板自身标记，
    // 由 conversation 的 cancel 管线收尾。
    _csSetPanelState(panel, 'cancelled');
  });

  header.appendChild(spinner);
  header.appendChild(title);
  header.appendChild(state);
  header.appendChild(stop);
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
  const stopBtn = panel.querySelector('.cs-panel-stop');
  if (stopBtn) stopBtn.style.display = status === 'completed' || status === 'failed' || status === 'cancelled' ? 'none' : '';
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

// ── 交互卡（M2：审批/提问） ────────────────────────────────────────────────

function _csReplyInteraction(interactionId, payload) {
  const invoke = window.cogseed && typeof window.cogseed.invoke === 'function'
    ? window.cogseed.invoke
    : null;
  if (!invoke) return;
  invoke('chat.interaction.reply', { interaction_id: interactionId, ...payload })
    .catch((err) => _csLog.warn('interaction reply failed', {
      interactionId,
      error: String(err && err.message || err),
    }));
}

function _csRenderInteractionCard(body, ev) {
  let card = body.querySelector(`[data-cs-interaction="${CSS.escape(ev.interactionId)}"]`);
  if (card) return card;
  card = document.createElement('div');
  card.className = `cs-card cs-interaction ${ev.kind}`;
  card.dataset.csInteraction = ev.interactionId;

  const head = document.createElement('div');
  head.className = 'cs-card-head';
  const ico = document.createElement('span');
  ico.className = 'cs-card-ico inProgress';
  ico.textContent = ev.kind === 'approval' ? '⚠️' : '❓';
  const promptEl = document.createElement('span');
  promptEl.className = 'cs-interaction-prompt';
  promptEl.textContent = ev.prompt;
  head.appendChild(ico);
  head.appendChild(promptEl);
  card.appendChild(head);

  if (ev.detail) {
    const detail = document.createElement('pre');
    detail.className = 'cs-interaction-detail';
    detail.textContent = ev.detail;
    card.appendChild(detail);
  }

  if (ev.kind === 'approval') {
    const actions = document.createElement('div');
    actions.className = 'cs-interaction-actions';
    for (const [decision, label, tone] of [
      ['allow', '允许', 'ok'],
      ['allowAlways', '总是允许', ''],
      ['deny', '拒绝', 'danger'],
    ]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `cs-btn ${tone}`;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        _csReplyInteraction(ev.interactionId, { decision });
      });
      actions.appendChild(btn);
    }
    card.appendChild(actions);
  } else {
    const row = document.createElement('div');
    row.className = 'cs-interactions-input-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cs-interaction-input';
    input.placeholder = '输入回复…';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        _csReplyInteraction(ev.interactionId, { answer: input.value });
        input.disabled = true;
      }
    });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cs-btn ok';
    btn.textContent = '回答';
    btn.addEventListener('click', () => {
      _csReplyInteraction(ev.interactionId, { answer: input.value });
      input.disabled = true;
    });
    row.appendChild(input);
    row.appendChild(btn);
    card.appendChild(row);
  }

  body.appendChild(card);
  return card;
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
    if (chatEvent.type === 'chat.interaction.requested') {
      const { body } = _csEnsurePanel(cid, anchor, chatEvent.turnId);
      _csRenderInteractionCard(body, chatEvent);
      return;
    }
    if (chatEvent.type === 'chat.interaction.closed') {
      for (const panel of _csPanels.values()) {
        const card = panel.querySelector(`[data-cs-interaction="${CSS.escape(chatEvent.interactionId)}"]`);
        if (card) {
          card.classList.add('closed');
          card.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
          return;
        }
      }
      return;
    }
  } catch (err) {
    _csLog.warn('chat-stream render failed', { error: String(err && err.message || err) });
  }
};

// ── bash 审批桥接（M2.1：敏感操作审批进入消息流上下文） ────────────────────
//
// bash:permission 弹窗（bash_permission.js）照常工作；本桥接把同一请求
// 镜像成当前会话过程面板里的审批卡——用户在消息流上下文里看到"哪一步
// 在等什么批准"，点卡上按钮与点弹窗等效（同走 bash.permission_response，
// 主进程幂等：先到者生效）。无活跃面板（不在聊天视图）时静默跳过。

function _csReplyBashPermission(requestId, decision) {
  const invoke = window.cogseed && typeof window.cogseed.invoke === 'function'
    ? window.cogseed.invoke
    : null;
  if (!invoke) return;
  invoke('bash.permission_response', { request_id: requestId, decision })
    .catch((err) => _csLog.warn('bash permission reply failed', {
      requestId,
      error: String(err && err.message || err),
    }));
}

function _csReplyBridgePermission(requestId, decision) {
  const invoke = window.cogseed && typeof window.cogseed.invoke === 'function'
    ? window.cogseed.invoke
    : null;
  if (!invoke) return;
  invoke('bridge.permission_response', {
    request_id: requestId,
    allow: decision !== 'deny',
    always: decision === 'allow_always',
  })
    .catch((err) => _csLog.warn('bridge permission reply failed', {
      requestId,
      error: String(err && err.message || err),
    }));
}

window.chatStreamBridgeBashPermission = function chatStreamBridgeBashPermission(info, opts) {
  const source = opts && opts.source === 'bridge' ? 'bridge' : 'bash';
  if (!info || typeof info !== 'object' || !info.request_id) return;
  try {
    // cid 匹配的最近面板（审批发生在该会话的执行中）；bridge 请求的 info
    // 无 cid 时挂最近活跃面板。
    let target = null;
    for (const [key, panel] of _csPanels.entries()) {
      if (!panel.isConnected) continue;
      if (info.cid ? key.startsWith(`${info.cid}::`) : true) target = panel;
    }
    if (!target) return;
    const body = target.querySelector('.cs-panel-body');
    if (!body) return;

    let card = body.querySelector(`[data-cs-interaction="${CSS.escape(info.request_id)}"]`);
    if (card) return;
    card = document.createElement('div');
    card.className = 'cs-card cs-interaction approval';
    card.dataset.csInteraction = info.request_id;

    const head = document.createElement('div');
    head.className = 'cs-card-head';
    const ico = document.createElement('span');
    ico.className = 'cs-card-ico inProgress';
    ico.textContent = '⚠️';
    const promptEl = document.createElement('span');
    promptEl.className = 'cs-interaction-prompt';
    const what = info.command || info.operation || '敏感操作';
    promptEl.textContent = `${info.agent_name || info.agent_id || 'agent'} 请求：${what}`;
    head.appendChild(ico);
    head.appendChild(promptEl);
    card.appendChild(head);

    if (info.command || info.subject) {
      const detail = document.createElement('pre');
      detail.className = 'cs-interaction-detail';
      detail.textContent = String(info.command || info.subject);
      card.appendChild(detail);
    }
    if (Array.isArray(info.reasons) && info.reasons.length) {
      const reasons = document.createElement('div');
      reasons.className = 'cs-interaction-reasons';
      reasons.textContent = `风险：${info.reasons.join('、')}`;
      card.appendChild(reasons);
    }

    const actions = document.createElement('div');
    actions.className = 'cs-interaction-actions';
    const reply = source === 'bridge' ? _csReplyBridgePermission : _csReplyBashPermission;
    const buttonSet = source === 'bridge'
      ? [['allow_once', '允许一次', 'ok'], ['allow_always', '总是允许', ''], ['deny', '拒绝', 'danger']]
      : [['allow_once', '允许一次', 'ok'], ['allow_run', '本任务内允许', ''], ['deny', '拒绝', 'danger']];
    for (const [decision, label, tone] of buttonSet) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `cs-btn ${tone}`;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        reply(info.request_id, decision);
      });
      actions.appendChild(btn);
    }
    card.appendChild(actions);
    body.appendChild(card);
  } catch (err) {
    _csLog.warn('bash permission bridge failed', { error: String(err && err.message || err) });
  }
};

window.chatStreamDismissBashPermission = function chatStreamDismissBashPermission(requestId) {
  for (const panel of _csPanels.values()) {
    const card = panel.querySelector(`[data-cs-interaction="${CSS.escape(requestId)}"]`);
    if (card) {
      card.classList.add('closed');
      card.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
      return;
    }
  }
};

/** 该会话是否存在活跃面板——conversation.js 据此停画老过程 rail（去重）。 */
window.chatStreamHasPanel = function chatStreamHasPanel(cid) {
  for (const [key, panel] of _csPanels.entries()) {
    if (panel.isConnected && key.startsWith(`${cid}::`)) return true;
  }
  return false;
};

/**
 * 完成/历史态重建：从消息持久化的 process items（老格式 progress/event）
 * 重建 Turn 过程面板，插在消息元素之前。conv-core 统一过程 UI——
 * _renderPersistedProcess 检测到本函数可用时全部委托过来，老 details
 * 折叠卡退役（chat-stream.js 加载失败的极端场景仍走老路径兜底）。
 */
window.chatStreamRenderPersisted = function chatStreamRenderPersisted(cid, msgDiv, items, opts) {
  if (!Array.isArray(items) || !items.length || !msgDiv || !msgDiv.parentNode) return false;
  try {
    const actorName = (opts && opts.actorName) || '';
    const turnKey = _csPanelKey(cid, (opts && opts.turnId) || (msgDiv.dataset && msgDiv.dataset.msgId) || `hist-${Date.now()}`);
    // 同一消息重复重建（刷新/回滚重放）幂等：先移除旧面板。
    const existing = _csPanels.get(turnKey);
    if (existing) existing.remove();

    const panel = _csCreatePanel(cid, turnKey, actorName);
    const body = panel.querySelector('.cs-panel-body');
    const toolCards = new Map();
    for (const item of items) {
      const evt = item && (item.event || null);
      const data = evt && evt.stream === 'tool' ? (evt.data || {}) : null;
      if (data && typeof data === 'object') {
        const toolId = String(data.id || '');
        const itemId = `${turnKey}:tool:${toolId || Math.random().toString(36).slice(2, 8)}`;
        const payload = {
          toolName: String(data.name || 'tool'),
          ...(typeof data.arguments === 'object' && data.arguments
            ? { argsSummary: JSON.stringify(data.arguments).slice(0, 120) }
            : (typeof data.arguments === 'string' ? { argsSummary: data.arguments.slice(0, 120) } : {})),
          ...(typeof data.output === 'string' ? { output: data.output.slice(0, 4000) } : {}),
          ...(typeof data.result_preview === 'string' && !data.output
            ? { output: data.result_preview.slice(0, 4000) } : {}),
          ...(data.isError === true
            ? { error: typeof data.errorCode === 'string' ? data.errorCode : 'tool_error' } : {}),
        };
        const status = data.phase === 'end'
          ? (data.isError === true ? 'failed' : 'completed')
          : 'inProgress';
        const card = _csEnsureItemCard(body, itemId, 'toolExecution');
        _csRenderToolCard(card, payload, status);
        toolCards.set(toolId, itemId);
        continue;
      }
      // progress 纯文本与其余事件流（context/compaction/runtime…）→ 思考条。
      const text = (item && typeof item.text === 'string' && item.text)
        || (evt && evt.stream ? `[${evt.stream}] ${String((evt.data && evt.data.phase) || '')}`.trim() : '');
      if (!text) continue;
      const card = _csEnsureItemCard(body, `${turnKey}:r:${_csPanels.size}:${Math.random().toString(36).slice(2, 8)}`, 'reasoning');
      _csRenderReasoningCard(card, { text });
    }
    if (!body.children.length) { panel.remove(); return false; }
    _csSetPanelState(panel, 'completed');
    // 完成态默认展开（过程可见是 conv-core 的核心诉求）；用户可一键收起。
    // 老线程回放不想全展开时，调用方传 expanded:false 显式收起。
    if (opts && opts.expanded === false) {
      const bodyEl = panel.querySelector('.cs-panel-body');
      const toggle = panel.querySelector('.cs-panel-toggle');
      if (bodyEl && toggle) {
        bodyEl.style.display = 'none';
        toggle.textContent = '展开';
        toggle.setAttribute('aria-expanded', 'false');
      }
    }
    msgDiv.parentNode.insertBefore(panel, msgDiv);
    _csPanels.set(turnKey, panel);
    return true;
  } catch (err) {
    _csLog.warn('persisted process rebuild failed', { error: String(err && err.message || err) });
    return false;
  }
};

/** 视图切换/历史重建时丢弃全部面板（conversation.js 重建消息列表后调用）。 */
window.chatStreamReset = function chatStreamReset() {
  for (const panel of _csPanels.values()) panel.remove();
  _csPanels.clear();
};

_csLog.info('chat-stream module loaded');
