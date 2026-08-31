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

  // 收起行摘要（N 步 · 工具名 · ↑↓token）：完成后面板收缩成 header 一行，
  // 摘要让这行本身携带"这轮干了什么"，不点开也能扫读。
  const summary = document.createElement('span');
  summary.className = 'cs-panel-summary';

  // 展开指示箭头：▾ 展开 / ▸ 收起。header 整行可点（CLI 习惯），
  // 停止按钮自己 stopPropagation。
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'cs-panel-toggle';
  toggle.textContent = '▾';
  toggle.setAttribute('aria-expanded', 'true');
  toggle.setAttribute('aria-label', '收起过程');
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const body = panel.querySelector('.cs-panel-body');
    _csSetCollapsed(panel, body && body.style.display !== 'none');
  });
  header.addEventListener('click', () => {
    const body = panel.querySelector('.cs-panel-body');
    _csSetCollapsed(panel, body && body.style.display !== 'none');
  });

  // 就近取消（矩阵 #6）：面板运行中显示「停止」，复用主输入区停止按钮的
  // 完整 abort 链（streaming 态下点击发送按钮即中止）——不另铺 IPC。
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'cs-panel-stop';
  stop.textContent = '停止';
  stop.title = '中止本轮执行';
  stop.addEventListener('click', (e) => {
    e.stopPropagation();
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
  header.appendChild(toggle);
  header.appendChild(title);
  header.appendChild(summary);
  header.appendChild(state);
  header.appendChild(stop);

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

/** 展开/收起唯一入口：body 显隐 + chevron 方向 + aria 同步。 */
function _csSetCollapsed(panel, collapsed) {
  const body = panel.querySelector('.cs-panel-body');
  if (!body) return;
  body.style.display = collapsed ? 'none' : '';
  panel.classList.toggle('cs-collapsed', collapsed);
  const chev = panel.querySelector('.cs-panel-toggle');
  if (chev) {
    chev.textContent = collapsed ? '▸' : '▾';
    chev.setAttribute('aria-expanded', String(!collapsed));
    chev.setAttribute('aria-label', collapsed ? '展开过程' : '收起过程');
  }
}

function _csFmtTok(n) {
  return typeof n === 'number' && n >= 10000
    ? `${Math.round(n / 1000)}K` : String(n);
}

/** 收起行摘要：N 步 · 工具名（去重前 3）· ↑↓token。卡片增减/usage 到达/
 *  终态时刷新，让收缩成的一行自己能讲清楚这轮发生了什么。 */
function _csUpdatePanelSummary(panel) {
  const summary = panel.querySelector('.cs-panel-summary');
  if (!summary) return;
  const body = panel.querySelector('.cs-panel-body');
  const toolNames = [];
  let steps = 0;
  for (const card of (body ? body.children : [])) {
    if (!card.dataset || !card.dataset.csItem) continue;
    if (card.classList.contains('cs-usage')) continue;
    steps += 1;
    // 工具名优先读渲染时落在 dataset 的副本（不依赖 innerHTML 子树查询，
    // stub/真实 DOM 行为一致），缺省回退查 .cs-tool-name。
    let n = card.dataset.csName || '';
    if (!n) {
      const nameEl = card.querySelector('.cs-tool-name');
      n = nameEl ? nameEl.textContent.trim() : '';
    }
    if (n && toolNames.indexOf(n) === -1) toolNames.push(n);
  }
  const bits = [];
  if (steps) bits.push(`${steps} 步`);
  if (toolNames.length) {
    bits.push(toolNames.slice(0, 3).join(' · ') + (toolNames.length > 3 ? ' …' : ''));
  }
  const usage = panel.dataset.csUsage;
  if (usage) bits.push(usage);
  summary.textContent = bits.join('　');
}

function _csSetPanelState(panel, status, error) {
  panel.className = _csPanelClass(status);
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  const spinner = panel.querySelector('.cs-spinner');
  if (spinner) spinner.style.display = terminal ? 'none' : '';
  const stopBtn = panel.querySelector('.cs-panel-stop');
  if (stopBtn) stopBtn.style.display = terminal ? 'none' : '';
  const stateEl = panel.querySelector('[data-cs-state]');
  if (stateEl) {
    const label = status === 'completed' ? '已完成'
      : status === 'failed' ? `失败${error ? `：${error}` : ''}`
      : status === 'cancelled' ? '已取消' : '运行中';
    stateEl.textContent = label;
  }
  // 完成即收缩（CLI 行为契约：执行过程实时可见，结束后过程收起，
  // 摘要行 + 点开可看）。失败不收：过程就是排障信息。
  if (terminal && status !== 'failed') {
    _csUpdatePanelSummary(panel);
    _csSetCollapsed(panel, true);
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
  _csUpdatePanelSummary(body.closest('.cs-panel'));
  return card;
}

function _csRenderToolCard(card, payload, status) {
  const p = payload || {};
  // 摘要行读取的名称副本（见 _csUpdatePanelSummary）。
  card.dataset.csName = String(p.toolName || 'tool');
  if (status !== 'completed' && status !== 'failed') card.dataset.csT0 = String(Date.now());
  else if (card.dataset.csDur === undefined && card.dataset.csT0) {
    card.dataset.csDur = String(Math.max(0, Date.now() - Number(card.dataset.csT0)));
  }
  const dur = card.dataset.csDur
    ? ` · ${(Number(card.dataset.csDur) / 1000).toFixed(1)}s` : '';
  const parts = [
    `<div class="cs-row-head">
      <span class="cs-card-ico ${status}">${_csStatusIcon(status)}</span>
      <span class="cs-tool-name">${_csEscapeHtml(p.toolName || 'tool')}</span>
      ${p.argsSummary ? `<span class="cs-tool-args">${_csEscapeHtml(p.argsSummary)}</span>` : ''}
      <span class="cs-row-dur">${dur}</span>
    </div>`,
  ];
  if (p.error) parts.push(`<div class="cs-card-error">${_csEscapeHtml(p.error)}</div>`);
  if (p.output) {
    parts.push(`<div class="cs-card-out"><pre>${_csEscapeHtml(p.output)}</pre></div>`);
  }
  card.innerHTML = parts.join('');
  if (!card.dataset.csClickBound) {
    card.dataset.csClickBound = '1';
    card.addEventListener('click', () => {
      const out = card.querySelector('.cs-card-out');
      if (out) out.style.display = out.style.display === 'none' ? '' : 'none';
    });
  }
}

function _csRenderReasoningCard(card, payload) {
  const text = (payload && payload.text) || '';
  // 思考行不显示内容（对齐 CLI 呈现）：只留「💭 思考」占位行，
  // 点击展开看原文——过程透明但思考文本不占视觉。
  card.innerHTML = `
    <div class="cs-row-head cs-reason-head">
      <span class="cs-card-ico completed">💭</span>
      <span class="cs-reason-label">思考</span>
      ${text ? '<span class="cs-reason-hint">点击查看</span>' : ''}
    </div>
    ${text ? `<div class="cs-reason-full">${_csEscapeHtml(text)}</div>` : ''}`;
  if (!card.dataset.csClickBound) {
    card.dataset.csClickBound = '1';
    card.addEventListener('click', () => {
      card.classList.toggle('cs-open');
    });
  }
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
    <div class="cs-row-head">
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
  // token 摘要挂到面板级：完成收缩后 header 一行仍能看到本轮用量。
  const panel = card.closest('.cs-panel');
  if (panel) {
    panel.dataset.csUsage = [
      typeof p.inputTokens === 'number' ? `↑${_csFmtTok(p.inputTokens)}` : '',
      typeof p.outputTokens === 'number' ? `↓${_csFmtTok(p.outputTokens)}` : '',
    ].filter(Boolean).join(' ');
    _csUpdatePanelSummary(panel);
  }
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

/** 回合收尾：时间线正文交回 conversation 原管道（markdown/结构块保留），
 *  面板内文字段移除，正文回到消息气泡位。anchor=面板后的流式占位消息。 */
function _csFinalizePanelText(panel) {
  const txt = panel.dataset.csText || '';
  let anchor = null;
  if (panel.parentNode) {
    const sibs = Array.from(panel.parentNode.children || []);
    const idx = sibs.indexOf(panel);
    if (idx >= 0 && idx + 1 < sibs.length) anchor = sibs[idx + 1];
  }
  if (txt && anchor) {
    try {
      if (typeof _streamingAppendFinalDelta === 'function') {
        _streamingAppendFinalDelta(anchor, txt);
      } else {
        const finalEl = anchor.querySelector('[data-role="final"]');
        if (finalEl) finalEl.textContent = txt;
      }
    } catch (err) {
      _csLog.warn('timeline text hand-back failed', { error: String(err && err.message || err) });
    }
  }
  for (const seg of Array.from(panel.querySelectorAll('.cs-text'))) seg.remove();
  delete panel.dataset.csText;
}

/** 完成态定位：过程面板移到正文气泡之后——正文是主体、过程摘要是附属，
 *  阅读顺序「先答案，后过程」。执行中面板在正文上方（正文未出）。 */
function _csMovePanelBelowBody(panel) {
  if (!panel.parentNode) return;
  const sibs = Array.from(panel.parentNode.children || []);
  const idx = sibs.indexOf(panel);
  const anchor = idx >= 0 ? sibs[idx + 1] : null;
  if (anchor && anchor.parentNode === panel.parentNode) {
    panel.parentNode.insertBefore(panel, anchor.nextSibling);
  }
}

/** 流结束兜底（conversation 在 reader 循环收尾时调用）：中断/断流时
 *  running 面板的正文也要交回，防止文字困在面板里随收缩一起藏掉。 */
window.chatStreamFinalize = function chatStreamFinalize(cid) {
  for (const [key, panel] of Array.from(_csPanels.entries())) {
    if (cid && !key.startsWith(`${cid}::`)) continue;
    if (panel.classList.contains('running')) {
      _csFinalizePanelText(panel);
      _csSetPanelState(panel, 'cancelled');
      _csMovePanelBelowBody(panel);
    }
  }
};

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
      const { panel, body } = _csEnsurePanel(cid, anchor, turnId);
      if (kind === 'text') {
        // 时间线接管正文（边思考边说边执行的真实交错）：delta 追加到当前
        // 文字段，遇其它 item 关段；全文聚合在 panel.dataset.csText，回合
        // 收尾交回 conversation 原管道渲染（markdown/结构块不损失）。
        const piece = String((payload && payload.delta) || '');
        panel.dataset.csText = (panel.dataset.csText || '') + piece;
        const kids = body.children;
        const last = kids[kids.length - 1];
        let seg = (last && last.className && String(last.className).includes('cs-text')
          && last.dataset.csClosed !== '1') ? last : null;
        if (!seg) {
          seg = document.createElement('div');
          seg.className = 'cs-text';
          body.appendChild(seg);
          _csUpdatePanelSummary(panel);
        }
        seg.textContent += piece;
        return;
      }
      // 非 text item 到达 → 关闭当前文字段（下次正文新开段，保持交错）。
      const kids2 = body.children;
      const openSeg = kids2[kids2.length - 1];
      if (openSeg && String(openSeg.className || '').includes('cs-text')) openSeg.dataset.csClosed = '1';
      const card = _csEnsureItemCard(body, itemId, kind);
      if (kind === 'toolExecution') _csRenderToolCard(card, payload, status);
      else if (kind === 'reasoning') _csRenderReasoningCard(card, payload);
      else if (kind === 'fileChange') _csRenderDiffCard(card, payload);
      else if (kind === 'usage') _csRenderUsageCard(card, payload);
      return;
    }
    if (chatEvent.type === 'chat.turn.completed') {
      const panel = _csPanels.get(_csPanelKey(cid, chatEvent.turnId));
      if (panel) {
        _csFinalizePanelText(panel);
        _csSetPanelState(panel, chatEvent.status, chatEvent.error);
        // 完成态定位：面板移到正文气泡之后（正文主体、过程附属）。
        if (chatEvent.status !== 'failed') _csMovePanelBelowBody(panel);
      }
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

    const panel = _csCreatePanel(cid, turnKey, actorName || '过程');
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
    // 历史回合默认收起（完成态=摘要行，点开看全程）；正文为空的异常
    // 回合（中断占位/HTML 桩）过程即全部内容，调用方传 expanded:true 展开。
    _csSetCollapsed(panel, !(opts && opts.expanded === true));
    // 历史 items 不带 usage 事件：从卡片文本回填 token 摘要，让收起行有用量。
    const usageCard = body.querySelector('.cs-usage');
    if (usageCard && !panel.dataset.csUsage) {
      const txt = usageCard.textContent;
      panel.dataset.csUsage = [
        (txt.match(/↑[\d,]+/) || [''])[0],
        (txt.match(/↓[\d,]+/) || [''])[0],
      ].filter(Boolean).join(' ');
      _csUpdatePanelSummary(panel);
    }
    // 历史重建面板挂在正文气泡之后（完成态定位：正文主体、过程附属）。
    msgDiv.parentNode.insertBefore(panel, msgDiv.nextSibling);
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
