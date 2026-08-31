// ─── chat-stream: 结构化会话事件的过程活动流（conv-core M1） ────────────────
//
// 消费主进程 conversations.sendStream 并行下发的 stream:'chat' 事件
// （chat.turn.started/completed、chat.item 五种 kind），渲染为当前回合的
// 「过程活动流」：没有外框卡片，每个动作就是一行轻量条目（图标 + 动词 +
// 目标 + 增删统计），与正文文字段按真实发生顺序交错，视觉对齐 CLI 活动
// 时间线。正文文本仍走老 delta 通道收尾渲染，本模块跳过 kind:text 的
// 最终渲染、仅在流中承接。
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

/** cid+turnId → 活动流根元素。流式回合切换/视图切换时由 GC 惰性清理。 */
const _csPanels = new Map();

function _csPanelKey(cid, turnId) { return `${cid}::${turnId}`; }

// ── 工具名 → 图标/动词/目标样式映射（视觉对齐 CLI：读取/编辑/运行/MCP…） ──
const _CS_TOOL_STYLES = [
  [['read_file', 'stat_file', 'read_mate_kb', 'kb_read', 'chat_read', 'office_read'], 'search', '读取', 'path'],
  [['search_files', 'grep_files', 'kb_search', 'chat_search', 'web_search'], 'search', '搜索', 'text'],
  [['web_fetch'], 'globe', '抓取', 'text'],
  [['write_file', 'office_create', 'create_artifact', 'create_docx', 'create_pptx', 'create_xlsx', 'markdown_to_pdf', 'html_to_pdf', 'generate_image'], 'edit-pencil', '写入', 'path'],
  [['edit_file', 'office_edit', 'patch_apply'], 'edit-pencil', '编辑', 'path'],
  [['delete_file'], 'trash-2', '删除', 'path'],
  [['bash', 'exec_command', 'interactive_cli_start', 'interactive_cli_send', 'interactive_cli_read', 'interactive_cli_close'], 'terminal', '运行', 'text'],
  [['browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot'], 'globe', '浏览', 'text'],
  [['run_skill'], 'zap', '技能', 'text'],
  [['call_connector_tool', 'list_connector_tools'], 'plug', 'MCP', 'mcp'],
  [['messaging_send', 'p3394_send'], 'send', '发送', 'text'],
  [['cogseed_delegate'], 'send', '派单', 'text'],
  [['manage_execution_plan'], 'list-ordered', '计划', 'text'],
  [['cross_session_memory'], 'book-open', '记忆', 'text'],
];

function _csStyleForTool(toolName) {
  const name = String(toolName || '');
  for (const [names, icon, verb, targetKind] of _CS_TOOL_STYLES) {
    if (names.includes(name)) return { icon, verb, targetKind };
  }
  // 未收录的工具：诚实回退为原名（等宽字体），不硬造动词。
  return { icon: 'box', verb: name || 'tool', targetKind: 'text', raw: true };
}

/** 图标渲染委托共享 icons.js；模块单测环境缺依赖时回退为空（不阻塞渲染）。 */
function _csIco(name) {
  return typeof window !== 'undefined' && typeof window.uiIconHtml === 'function'
    ? window.uiIconHtml(name, 'cs-ico-svg') : '';
}

function _csFileIco(fileName) {
  return typeof window !== 'undefined' && typeof window.fileKindIconHtml === 'function'
    ? window.fileKindIconHtml(fileName) : '';
}

/** argsSummary（JSON 摘要字符串，可能被截断）宽松还原为参数对象。 */
function _csParseArgs(argsSummary) {
  const raw = String(argsSummary || '').trim();
  if (!raw.startsWith('{')) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch { /* 截断/非完整 JSON → 字段扫描 */ }
  // 截断的 JSON 解不动：按字段名直接抠字符串值（截断的命令也能显示前段）。
  const extracted = {};
  for (const field of ['command', 'query', 'pattern', 'path', 'file_path', 'url', 'connector', 'server', 'tool', 'skill_id']) {
    const value = _csPartialJsonField(raw, field);
    if (value) extracted[field] = value;
  }
  return Object.keys(extracted).length ? extracted : null;
}

/** 从可能被截断的 JSON 文本里抠出某个字符串字段的值。
 *  手写字符扫描 + 固定转义表（不动态拼正则/执行串）。field 调用方传白名单。 */
function _csPartialJsonField(source, field) {
  const text = String(source || '');
  const key = `"${field}"`;
  let at = text.indexOf(key);
  while (at !== -1) {
    let i = at + key.length;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i += 1;
    if (text[i] === ':') {
      i += 1;
      while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i += 1;
      if (text[i] === '"') {
        i += 1;
        let raw = '';
        while (i < text.length && text[i] !== '"') {
          if (text[i] === '\\' && i + 1 < text.length) {
            raw += text[i] + text[i + 1];
            i += 2;
          } else {
            raw += text[i];
            i += 1;
          }
        }
        return _csUnescapeJson(raw);
      }
    }
    at = text.indexOf(key, at + key.length);
  }
  return '';
}

const _CS_ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function _csUnescapeJson(raw) {
  if (raw.indexOf('\\') === -1) return raw;
  return raw.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (m, g) => {
    if (g[0] === 'u') return String.fromCharCode(parseInt(g.slice(1), 16));
    return _CS_ESCAPES[g] || g;
  });
}

function _csFirstArg(args, keys) {
  if (!args || typeof args !== 'object') return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function _csFmtDur(ms) {
  const total = Math.max(1, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return `${total} 秒`;
  return `${Math.floor(total / 60)} 分 ${total % 60} 秒`;
}

// ── 活动流骨架（每回合一个，无外框；计时/收起徽章挂消息头） ────────────────

function _csStopTicker(flow) {
  if (flow && flow._csTicker) {
    clearInterval(flow._csTicker);
    flow._csTicker = null;
  }
}

function _csStartTicker(flow, startedAtMs) {
  // 徽章挂在消息头（flow 子树之外），必须从引用里找，不能 querySelector。
  const badge = flow._csBadge;
  const label = badge && badge.querySelector('.cs-badge-elapsed');
  if (!label) return;
  const t0 = Number(startedAtMs) || Date.now();
  flow.dataset.csT0 = String(t0);
  // 立即先画一次（此刻 badge 尚未插入 DOM，isConnected 检查只放在轮询里）。
  label.textContent = _csFmtDur(Date.now() - t0);
  flow._csTicker = setInterval(() => {
    if (!flow.isConnected) { _csStopTicker(flow); return; }
    label.textContent = _csFmtDur(Date.now() - t0);
  }, 1000);
}

/** 收起/展开时间线正文（徽章点击唯一入口；aria 同步）。 */
function _csSetCollapsed(flow, collapsed) {
  const body = flow.querySelector('.cs-flow-body');
  if (!body) return;
  body.style.display = collapsed ? 'none' : '';
  flow.dataset.csCollapsed = collapsed ? '1' : '0';
  const badge = flow._csBadge;
  if (badge) {
    badge.dataset.csCollapsed = collapsed ? '1' : '0';
    badge.setAttribute('aria-expanded', String(!collapsed));
    badge.setAttribute('aria-label', collapsed ? '展开过程' : '收起过程');
  }
}

/** 交互卡（审批/提问）到达时若时间线被收起，自动展开一次——审批/提问
 *  只有时间线这一个入口，不能困在收起的区域里等到超时。 */
function _csExpandIfCollapsed(flow) {
  if (flow && flow.dataset.csCollapsed === '1') _csSetCollapsed(flow, false);
}

/** 计时/收起徽章：消息头里 cogseed 名字右侧，点击收起下方工具调用区。
 *  运行中 label=工作中（实时计时），终态定格 label=已工作；历史无计时
 *  数据只显示「已工作」（不编造时长）。 */
function _csCreateBadge(flow, opts) {
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'cs-badge';
  badge.dataset.csCollapsed = '0';
  badge.setAttribute('aria-expanded', 'true');
  badge.setAttribute('aria-label', '收起过程');
  badge.setAttribute('title', '收起/展开过程');
  const label = document.createElement('span');
  label.className = 'cs-badge-label';
  label.textContent = (opts && opts.terminalLabel) ? '已工作' : '工作中';
  badge.appendChild(label);
  if (!(opts && opts.noElapsed)) {
    const elapsed = document.createElement('span');
    elapsed.className = 'cs-badge-elapsed';
    badge.appendChild(elapsed);
  }
  badge.addEventListener('click', () => {
    _csSetCollapsed(flow, flow.dataset.csCollapsed !== '1');
  });
  flow._csBadge = badge;
  return badge;
}

/** 徽章+停止的宿主：优先消息头（cogseed 名字右侧），找不到退回流内首行。 */
function _csBadgeHost(flow, anchor) {
  const header = anchor && anchor.querySelector ? anchor.querySelector('.chat-msg-header') : null;
  if (header) return header;
  let row = flow.querySelector('.cs-badge-row');
  if (!row) {
    row = document.createElement('div');
    row.className = 'cs-badge-row';
    flow.insertBefore(row, flow.firstChild);
  }
  return row;
}

function _csCreateFlow(cid, turnId, opts) {
  const flow = document.createElement('div');
  flow.className = 'cs-flow running';
  flow.dataset.csTurn = turnId;
  if (cid) flow.dataset.csCid = cid;

  const body = document.createElement('div');
  body.className = 'cs-flow-body';
  flow.appendChild(body);

  const host = _csBadgeHost(flow, opts && opts.anchor);
  if (!(opts && opts.noStatus)) {
    host.appendChild(_csCreateBadge(flow, opts));
    // 就近停止（矩阵 #6）：仅运行中显示，复用主输入区停止按钮的完整
    // abort 链；主按钮不在 streaming 态（派单后台轮次）时由流自身标记，
    // 由 conversation 的 cancel 管线收尾。
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'cs-badge-stop';
    stop.textContent = '停止';
    stop.title = '中止本轮执行';
    stop.addEventListener('click', () => {
      const mainStop = document.querySelector('.chat-send-btn.streaming');
      if (mainStop) {
        mainStop.click();
        return;
      }
      _csSetFlowState(flow, 'cancelled');
    });
    host.appendChild(stop);
    flow._csStopBtn = stop;
    _csStartTicker(flow, opts && opts.startedAtMs);
  } else {
    // 历史/完成态：徽章只做收起开关（无计时数据不编造时长）。
    host.appendChild(_csCreateBadge(flow, { terminalLabel: true, noElapsed: true }));
  }
  return flow;
}

/** 流移除唯一入口：连同挂在消息头上的徽章/停止一起清掉。 */
function _csRemoveFlow(flow) {
  if (!flow) return;
  if (flow._csBadge) flow._csBadge.remove();
  if (flow._csStopBtn) flow._csStopBtn.remove();
  _csStopTicker(flow);
  flow.remove();
}

function _csBubbleLooksEmpty(bubble) {
  if (!bubble) return false;
  if (String(bubble.textContent || '').trim()) return false;
  // 有可见媒体/结构块不算空（避免误伤带隐藏骨架的消息）。
  return !bubble.querySelector('img, video, audio, iframe, canvas, svg, pre, code, blockquote, table, ul, ol, hr, .chat-attachments, .chat-artifacts, .chat-plan-announce, .chat-reference-bundle, .recall-citations');
}

function _csEnsureFlow(cid, anchor, turnId, opts) {
  const key = _csPanelKey(cid, turnId);
  let flow = _csPanels.get(key);
  if (flow && flow.isConnected) return { flow, body: flow.querySelector('.cs-flow-body') };
  flow = _csCreateFlow(cid, turnId, { ...opts, anchor });
  // 活动流挂在消息元素内部：消息头（cogseed 图标/名字）之后、正文容器
  // 之前——过程是消息的组成部分（图标下、正文上），执行中与完成态
  // 同位，收尾无需再移动。流式占位与历史渲染的消息结构都取
  // .chat-bubble（正文容器）为锚；查不到时退到消息末尾。
  const bubble = anchor && anchor.querySelector
    ? anchor.querySelector('.chat-bubble, [data-role="final"]') : null;
  if (bubble) anchor.insertBefore(flow, bubble);
  else if (anchor && anchor.appendChild) anchor.appendChild(flow);
  // 运行中正文都在时间线里：气泡此时是空的，把空底条藏掉（视觉对齐 CLI：
  // 运行中没有空泡壳），收尾交回正文时恢复。
  if (bubble && _csBubbleLooksEmpty(bubble)) {
    bubble.style.display = 'none';
    flow.dataset.csBubbleHidden = '1';
  }
  _csPanels.set(key, flow);
  // 惰性清理：超过 40 个流时丢最老的已完成流，防长会话 DOM 无界。
  if (_csPanels.size > 40) {
    const firstKey = _csPanels.keys().next().value;
    const oldest = _csPanels.get(firstKey);
    if (oldest && !oldest.classList.contains('running')) {
      _csRemoveFlow(oldest);
      _csPanels.delete(firstKey);
    }
  }
  return { flow, body: flow.querySelector('.cs-flow-body') };
}

/** 回合终态：徽章定格为「已工作 总时长」（历史无数据只显示已工作），
 *  停止按钮撤除，计时器停止；收起开关保留（点击可开合时间线）。 */
function _csSetFlowState(flow, status, error, endedAtMs) {
  flow.classList.remove('running', 'done', 'failed', 'cancelled');
  flow.classList.add(status === 'completed' ? 'done' : status);
  _csStopTicker(flow);
  if (flow._csStopBtn) {
    flow._csStopBtn.remove();
    flow._csStopBtn = null;
  }
  const badge = flow._csBadge;
  if (badge) {
    const label = badge.querySelector('.cs-badge-label');
    if (label) {
      label.textContent = status === 'failed' ? `失败${error ? `：${error}` : ''}`
        : status === 'cancelled' ? '已取消' : '已工作';
    }
    // 失败详情被徽章省略号截断时，悬停 title 兜底看全文。
    if (status === 'failed' && error && label) badge.setAttribute('title', label.textContent);
    const elapsed = badge.querySelector('.cs-badge-elapsed');
    if (elapsed) {
      const t0 = Number(flow.dataset.csT0);
      const end = Number(endedAtMs) || Date.now();
      elapsed.textContent = t0 ? _csFmtDur(Math.max(0, end - t0)) : '';
    }
  }
  if (status !== 'completed') return;
  // 完成即收尾；纯文字回合（无任何动作行）连流壳+徽章一起撤，不留空壳。
  const body = flow.querySelector('.cs-flow-body');
  if (!body || !body.children.length) {
    for (const [key, mapped] of Array.from(_csPanels.entries())) {
      if (mapped === flow) _csPanels.delete(key);
    }
    _csRemoveFlow(flow);
  }
}

// ── 行渲染（无边框：一行一动作） ──────────────────────────────────────────

function _csEnsureItemRow(body, itemId, kind) {
  let row = body.querySelector(`[data-cs-item="${CSS.escape(itemId)}"]`);
  if (row) return row;
  // cs-row 提供行布局基座（flex/间距/hover）；cs-{kind} 供测试与定制区分。
  row = document.createElement('div');
  row.className = `cs-row cs-item cs-${kind}`;
  row.dataset.csItem = itemId;
  body.appendChild(row);
  return row;
}

/** 彩色文件类型图标（icons.js 的文件族），外包一层定位 span；无依赖时省略。 */
function _csFileIcoSpan(fileName) {
  const svg = _csFileIco(fileName);
  return svg ? `<span class="cs-file-ico">${svg}</span>` : '';
}

/** 目标片段：路径类 → 彩色文件图标 + 文件名 + 目录（均等宽、可截断）；
 *  MCP → 服务名 · 工具名；其余 → 单行等宽摘要。 */
function _csTargetHtml(targetKind, args, rawSummary) {
  if (targetKind === 'mcp') {
    const server = _csFirstArg(args, ['connector', 'server', 'server_name', 'name'])
      || (rawSummary || '');
    const tool = _csFirstArg(args, ['tool', 'tool_name', 'method']);
    return `<span class="cs-file-name">${_csEscapeHtml(server)}</span>`
      + (tool ? `<span class="cs-row-dim">· ${_csEscapeHtml(tool)}</span>` : '');
  }
  const path = _csFirstArg(args, ['path', 'file_path', 'filePath', 'file']);
  if (path && (targetKind === 'path' || /[\\/]/.test(path))) {
    const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    const base = sep >= 0 ? path.slice(sep + 1) : path;
    const dir = sep >= 0 ? path.slice(0, sep) : '';
    return `${_csFileIcoSpan(base)}`
      + `<span class="cs-file-name" title="${_csEscapeHtml(path)}">${_csEscapeHtml(base)}</span>`
      + (dir ? `<span class="cs-file-dir">${_csEscapeHtml(dir)}</span>` : '');
  }
  const text = _csFirstArg(args, ['command', 'query', 'pattern', 'url', 'skill_id', 'subject']);
  const shown = text || rawSummary || '';
  return shown ? `<span class="cs-target" title="${_csEscapeHtml(shown)}">${_csEscapeHtml(shown)}</span>` : '';
}

/** fileChange diff → +N/−N 统计（与行内统计同源：行前缀计数）。 */
function _csDiffStats(diff) {
  let adds = 0;
  let dels = 0;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) adds += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) dels += 1;
  }
  return { adds, dels };
}

function _csRenderToolRow(row, payload, status) {
  const p = payload || {};
  // 事件按相位增量到达：start 带参数、progress 带 message、end 带输出/错误
  // （end 不带 arguments！）。dataset 累积已见字段——后到相位重绘时不得把
  // start 的目标抹掉，否则行会退化成光秃秃的动词（真机踩过的坑）。
  if (p.argsSummary) row.dataset.csArgs = String(p.argsSummary);
  if (p.output) row.dataset.csOut = String(p.output);
  const argsSummary = p.argsSummary || row.dataset.csArgs || '';
  const output = p.output || row.dataset.csOut || '';
  const args = _csParseArgs(argsSummary);
  const style = _csStyleForTool(p.toolName);
  const failed = status === 'failed';
  const target = _csTargetHtml(style.targetKind, args, argsSummary);
  const hover = [p.toolName, argsSummary].filter(Boolean).join(' ');
  // 行 = 一行内联摘要（cs-row-line）+ 块级展开区（错误/输出，点行开合）。
  const line = [
    `<span class="cs-ico${failed ? ' failed' : ''}">${_csIco(style.icon)}</span>`,
    `<span class="cs-verb${failed ? ' failed' : ''}${style.raw ? ' raw' : ''}">${_csEscapeHtml(style.verb)}</span>`,
    target,
  ];
  const blocks = [];
  if (p.error) blocks.push(`<div class="cs-row-error">${_csEscapeHtml(p.error)}</div>`);
  if (output) blocks.push(`<div class="cs-row-out"><pre>${_csEscapeHtml(output)}</pre></div>`);
  row.innerHTML = `<div class="cs-row-line">${line.join('')}</div>${blocks.join('')}`;
  if (hover) row.title = hover;
  if (!row.dataset.csClickBound) {
    row.dataset.csClickBound = '1';
    row.addEventListener('click', () => {
      row.classList.toggle('cs-open');
    });
  }
}

function _csRenderDiffRow(row, payload) {
  const p = payload || {};
  const diff = String(p.diff || '');
  const { adds, dels } = _csDiffStats(diff);
  const sep = Math.max(String(p.filePath || '').lastIndexOf('/'), String(p.filePath || '').lastIndexOf('\\'));
  const base = sep >= 0 ? String(p.filePath).slice(sep + 1) : String(p.filePath || '');
  const dir = sep >= 0 ? String(p.filePath).slice(0, sep) : '';
  const lines = diff.split('\n').slice(0, 400).map((line) => {
    const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add'
      : line.startsWith('-') && !line.startsWith('---') ? 'del' : 'ctx';
    return `<span class="cs-diff-line ${cls}">${_csEscapeHtml(line)}</span>`;
  }).join('');
  row.innerHTML = `
    <div class="cs-row-line">
      <span class="cs-ico">${_csIco('edit-pencil')}</span>
      <span class="cs-verb">编辑</span>
      ${_csFileIcoSpan(base)}
      <span class="cs-file-name" title="${_csEscapeHtml(p.filePath || '')}">${_csEscapeHtml(base)}</span>
      ${dir ? `<span class="cs-file-dir">${_csEscapeHtml(dir)}</span>` : ''}
      ${adds ? `<span class="cs-add">+${adds}</span>` : ''}
      ${dels ? `<span class="cs-del">−${dels}</span>` : ''}
    </div>
    ${diff ? `<div class="cs-diff-body">${lines}</div>` : ''}`;
  if (!row.dataset.csClickBound) {
    row.dataset.csClickBound = '1';
    row.addEventListener('click', () => {
      row.classList.toggle('cs-open');
    });
  }
}

function _csRenderUsageRow(row, payload) {
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
  row.innerHTML = `<div class="cs-usage-row">${bits.join(' · ')}</div>`;
}

// ── 思考行（合并连续片段为一行，收行时结算时长） ──────────────────────────

function _csThinkDurText(row) {
  if (row.dataset.csClosed !== '1') return '…';
  const t0 = Number(row.dataset.csT0);
  if (!t0 || !row.dataset.csDur) return '';
  return `· 持续了 ${_csFmtDur(Number(row.dataset.csDur))}`;
}

function _csRenderThinkRow(row) {
  const full = row.dataset.csFull
    ? `<div class="cs-think-full">${_csEscapeHtml(row.dataset.csFull)}</div>` : '';
  row.innerHTML = `
    <div class="cs-row-line">
      <span class="cs-ico">${_csIco('brain-circuit')}</span>
      <span class="cs-verb">思考</span>
      <span class="cs-row-dim cs-think-dur">${_csThinkDurText(row)}</span>
    </div>
    ${full}`;
}

/** 追加思考片段：最近一行思考行仍开着就续写，否则新开一行。 */
function _csAppendReasoning(body, text) {
  let row = null;
  const kids = body.children;
  const last = kids[kids.length - 1];
  if (last && String(last.className || '').includes('cs-row-think') && last.dataset.csClosed !== '1') {
    row = last;
  } else {
    row = document.createElement('div');
    row.className = 'cs-row cs-row-think';
    row.dataset.csT0 = String(Date.now());
    row.addEventListener('click', () => row.classList.toggle('cs-open'));
    body.appendChild(row);
  }
  if (text) row.dataset.csFull = (row.dataset.csFull || '') + text;
  _csRenderThinkRow(row);
  return row;
}

/** 收思考行：结算时长（persisted 无计时数据时只定稿不留空时长）。 */
function _csCloseThinkRow(body, silent) {
  const kids = body.children;
  const last = kids[kids.length - 1];
  if (!last || !String(last.className || '').includes('cs-row-think') || last.dataset.csClosed === '1') return;
  last.dataset.csClosed = '1';
  if (!silent && last.dataset.csT0) {
    last.dataset.csDur = String(Math.max(0, Date.now() - Number(last.dataset.csT0)));
  }
  _csRenderThinkRow(last);
}

// ── 交互卡（M2：审批/提问——需要按钮/输入，保留轻边框卡） ──────────────────

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
  ico.innerHTML = _csIco('shield');
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
 *  流内文字段移除，正文回到消息气泡位。流宿主=消息元素。 */
function _csFinalizePanelText(flow) {
  const txt = flow.dataset.csText || '';
  const anchor = flow.parentNode;
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
  for (const seg of Array.from(flow.querySelectorAll('.cs-text'))) seg.remove();
  delete flow.dataset.csText;
  // 恢复运行时隐藏的空气泡（正文已交回，气泡重新有内容）。
  if (flow.dataset.csBubbleHidden === '1') {
    const bubble = anchor && anchor.querySelector
      ? anchor.querySelector('.chat-bubble, [data-role="final"]') : null;
    if (bubble) bubble.style.display = '';
    delete flow.dataset.csBubbleHidden;
  }
}

/** 流结束兜底（conversation 在 reader 循环收尾时调用）：中断/断流时
 *  running 流的正文也要交回，防止文字困在流里。 */
window.chatStreamFinalize = function chatStreamFinalize(cid) {
  for (const [key, flow] of Array.from(_csPanels.entries())) {
    if (cid && !key.startsWith(`${cid}::`)) continue;
    if (flow.classList.contains('running')) {
      _csCloseThinkRow(flow.querySelector('.cs-flow-body') || flow);
      _csFinalizePanelText(flow);
      _csSetFlowState(flow, 'cancelled');
    }
  }
};

// ── 事件入口（conversation.js 调用） ───────────────────────────────────────

window.chatStreamHandleEvent = function chatStreamHandleEvent(cid, anchor, chatEvent) {
  if (!chatEvent || typeof chatEvent !== 'object') return;
  try {
    if (chatEvent.type === 'chat.turn.started') {
      _csEnsureFlow(cid, anchor, chatEvent.turnId, {
        startedAtMs: chatEvent.startedAt ? Date.parse(chatEvent.startedAt) : Date.now(),
      });
      return;
    }
    if (chatEvent.type === 'chat.item') {
      const { kind, status, itemId, payload, turnId } = chatEvent;
      const { flow, body } = _csEnsureFlow(cid, anchor, turnId);
      if (kind === 'text') {
        // 时间线接管正文（边思考边说边执行的真实交错）：delta 追加到当前
        // 文字段，遇其它 item 关段；全文聚合在 flow.dataset.csText，回合
        // 收尾交回 conversation 原管道渲染（markdown/结构块不损失）。
        _csCloseThinkRow(body);
        const piece = String((payload && payload.delta) || '');
        flow.dataset.csText = (flow.dataset.csText || '') + piece;
        const kids = body.children;
        const last = kids[kids.length - 1];
        let seg = (last && last.className && String(last.className).includes('cs-text')
          && last.dataset.csClosed !== '1') ? last : null;
        if (!seg) {
          // 投影器在工具行后会补发 '\n\n' 分隔 delta（供 markdown 段落分隔）；
          // 时间线段剥掉段首空白（行间距已分隔），否则渲染出一块空行。聚合
          // 文本（flow.dataset.csText）不受影响，交回后 markdown 仍需要它。
          const lead = piece.replace(/^[ \t\r\n]+/, '');
          if (!lead && !piece.trim()) return;
          seg = document.createElement('div');
          seg.className = 'cs-text';
          body.appendChild(seg);
          seg.textContent += lead;
          return;
        }
        seg.textContent += piece;
        return;
      }
      // 非文字 item：关闭当前文字段与思考行（下次各自新开段，保持交错）。
      const kids2 = body.children;
      const openSeg = kids2[kids2.length - 1];
      if (openSeg && String(openSeg.className || '').includes('cs-text')) openSeg.dataset.csClosed = '1';
      if (kind === 'reasoning') {
        _csAppendReasoning(body, String((payload && payload.text) || ''));
        return;
      }
      _csCloseThinkRow(body);
      const row = _csEnsureItemRow(body, itemId, kind);
      if (kind === 'toolExecution') _csRenderToolRow(row, payload, status);
      else if (kind === 'fileChange') _csRenderDiffRow(row, payload);
      else if (kind === 'usage') _csRenderUsageRow(row, payload);
      return;
    }
    if (chatEvent.type === 'chat.turn.completed') {
      const flow = _csPanels.get(_csPanelKey(cid, chatEvent.turnId));
      if (flow) {
        _csCloseThinkRow(flow.querySelector('.cs-flow-body') || flow);
        _csFinalizePanelText(flow);
        _csSetFlowState(flow, chatEvent.status, chatEvent.error,
          chatEvent.endedAt ? Date.parse(chatEvent.endedAt) : undefined);
      }
      return;
    }
    if (chatEvent.type === 'chat.interaction.requested') {
      const { flow, body } = _csEnsureFlow(cid, anchor, chatEvent.turnId);
      _csRenderInteractionCard(body, chatEvent);
      // 收起状态下到达的审批/提问卡自动展开（唯一入口，不能藏在折叠区）。
      _csExpandIfCollapsed(flow);
      return;
    }
    if (chatEvent.type === 'chat.interaction.closed') {
      for (const flow of _csPanels.values()) {
        const card = flow.querySelector(`[data-cs-interaction="${CSS.escape(chatEvent.interactionId)}"]`);
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
// 镜像成当前会话活动流里的审批卡——用户在消息流上下文里看到"哪一步
// 在等什么批准"，点卡上按钮与点弹窗等效（同走 bash.permission_response，
// 主进程幂等：先到者生效）。无活跃流（不在聊天视图）时静默跳过。

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
    // cid 匹配的最近流（审批发生在该会话的执行中）；bridge 请求的 info
    // 无 cid 时挂最近活跃流。
    let target = null;
    for (const [key, flow] of _csPanels.entries()) {
      if (!flow.isConnected) continue;
      if (info.cid ? key.startsWith(`${info.cid}::`) : true) target = flow;
    }
    if (!target) return;
    const body = target.querySelector('.cs-flow-body');
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
    ico.innerHTML = _csIco('shield');
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
    // 镜像审批同样不能困在收起的时间线里（弹窗兜底只在 bash 侧存在）。
    _csExpandIfCollapsed(target);
  } catch (err) {
    _csLog.warn('bash permission bridge failed', { error: String(err && err.message || err) });
  }
};

window.chatStreamDismissBashPermission = function chatStreamDismissBashPermission(requestId) {
  for (const flow of _csPanels.values()) {
    const card = flow.querySelector(`[data-cs-interaction="${CSS.escape(requestId)}"]`);
    if (card) {
      card.classList.add('closed');
      card.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
      return;
    }
  }
};

/** 该会话是否存在活跃流——conversation.js 据此停画老过程 rail（去重）。 */
window.chatStreamHasPanel = function chatStreamHasPanel(cid) {
  for (const [key, flow] of _csPanels.entries()) {
    if (flow.isConnected && key.startsWith(`${cid}::`)) return true;
  }
  return false;
};

/**
 * 完成/历史态重建：从消息持久化的 process items（老格式 progress/event）
 * 重建活动流，插在消息元素内部（消息头之后、正文之前）。conv-core 统一
 * 过程 UI——_renderPersistedProcess 检测到本函数可用时全部委托过来，老
 * details 折叠卡退役（chat-stream.js 加载失败的极端场景仍走老路径兜底）。
 * 历史流没有运行行：动作行全部可见（与实时完成态一致）。
 */
window.chatStreamRenderPersisted = function chatStreamRenderPersisted(cid, msgDiv, items, opts) {
  if (!Array.isArray(items) || !items.length || !msgDiv || !msgDiv.parentNode) return false;
  try {
    const turnKey = _csPanelKey(cid, (opts && opts.turnId) || (msgDiv.dataset && msgDiv.dataset.msgId) || `hist-${Date.now()}`);
    // 同一消息重复重建（刷新/回滚重放）幂等：先移除旧流。
    const existing = _csPanels.get(turnKey);
    if (existing) _csRemoveFlow(existing);

    const flow = _csCreateFlow(cid, turnKey, { noStatus: true, anchor: msgDiv });
    const body = flow.querySelector('.cs-flow-body');
    for (const item of items) {
      const evt = item && (item.event || null);
      const data = evt && evt.stream === 'tool' ? (evt.data || {}) : null;
      if (data && typeof data === 'object') {
        // 工具到达 = 当前思考行结束（历史无计时数据，silent 只定稿不留空时长）。
        _csCloseThinkRow(body, true);
        const toolId = String(data.id || '');
        const itemId = `${turnKey}:tool:${toolId || Math.random().toString(36).slice(2, 8)}`;
        const payload = {
          toolName: String(data.name || 'tool'),
          ...(typeof data.arguments === 'object' && data.arguments
            ? { argsSummary: JSON.stringify(data.arguments).slice(0, 300) }
            : (typeof data.arguments === 'string' ? { argsSummary: data.arguments.slice(0, 300) } : {})),
          ...(typeof data.output === 'string' ? { output: data.output.slice(0, 4000) } : {}),
          ...(typeof data.result_preview === 'string' && !data.output
            ? { output: data.result_preview.slice(0, 4000) } : {}),
          ...(data.isError === true
            ? { error: typeof data.errorCode === 'string' ? data.errorCode : 'tool_error' } : {}),
        };
        const status = data.phase === 'end'
          ? (data.isError === true ? 'failed' : 'completed')
          : 'inProgress';
        const row = _csEnsureItemRow(body, itemId, 'toolExecution');
        _csRenderToolRow(row, payload, status);
        continue;
      }
      // progress 纯文本与其余事件流（context/compaction/runtime…）→ 思考行。
      const text = (item && typeof item.text === 'string' && item.text)
        || (evt && evt.stream ? `[${evt.stream}] ${String((evt.data && evt.data.phase) || '')}`.trim() : '');
      if (!text) continue;
      _csAppendReasoning(body, text);
    }
    if (!body.children.length) { _csRemoveFlow(flow); return false; }
    // 历史无计时数据：思考行只定稿，不显示时长（不编造）。
    _csCloseThinkRow(body, true);
    _csSetFlowState(flow, 'completed');
    // 历史重建流同样挂在消息内部（消息头之后、正文容器之前），与
    // 实时路径同位。
    const bubble = msgDiv.querySelector('.chat-bubble, [data-role="final"]');
    if (bubble) msgDiv.insertBefore(flow, bubble);
    else msgDiv.appendChild(flow);
    _csPanels.set(turnKey, flow);
    return true;
  } catch (err) {
    _csLog.warn('persisted process rebuild failed', { error: String(err && err.message || err) });
    return false;
  }
};

/** 视图切换/历史重建时丢弃全部流（conversation.js 重建消息列表后调用）。 */
window.chatStreamReset = function chatStreamReset() {
  for (const flow of _csPanels.values()) _csRemoveFlow(flow);
  _csPanels.clear();
};

_csLog.info('chat-stream module loaded');
