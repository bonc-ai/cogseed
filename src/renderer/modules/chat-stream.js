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
  [['list_files', 'list_visible_files'], 'folder', '列目录', 'path'],
  [['search_files', 'grep_files', 'kb_search', 'chat_search', 'web_search'], 'search', '搜索', 'text'],
  [['web_fetch'], 'globe', '抓取', 'text'],
  [['write_file', 'office_create', 'create_artifact', 'create_docx', 'create_pptx', 'create_xlsx', 'markdown_to_pdf', 'html_to_pdf', 'generate_image'], 'edit-pencil', '写入', 'path'],
  [['edit_file', 'office_edit', 'patch_apply'], 'edit-pencil', '编辑', 'path'],
  [['delete_file'], 'trash-2', '删除', 'path'],
  [['bash', 'exec_command', 'interactive_cli_start', 'interactive_cli_send', 'interactive_cli_read', 'interactive_cli_close'], 'terminal', '运行', 'text'],
  [['browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot'], 'globe', '浏览', 'text'],
  [['run_skill'], 'zap', '技能', 'text'],
  [['skill_search', 'skill_list'], 'zap', '技能', 'text'],
  [['call_connector_tool', 'list_connector_tools'], 'plug', 'MCP', 'mcp'],
  [['messaging_send', 'p3394_send'], 'send', '发送', 'message'],
  [['cogseed_delegate'], 'send', '派单', 'message'],
  [['cogseed_tasks', 'auto_tasks_list'], 'list', '任务', 'text'],
  [['p3394_peers'], 'users', '对端', 'text'],
  [['kb_list'], 'book-open', '知识库', 'text'],
  [['material_list'], 'database', '素材', 'text'],
  [['search_ability_assets'], 'search', '能力', 'text'],
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
  for (const field of ['command', 'query', 'pattern', 'path', 'file_path', 'url', 'skill_id', 'peer', 'to', 'target', 'message', 'text', 'content', 'task', 'connector', 'server', 'tool']) {
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
  // 亚秒级显示毫秒（2026-09-11：本地 CLI 工具普遍几十毫秒完成，整秒
  // 取整把真实耗时吞成"0 秒"，看起来像计时坏了——真机两轮误报）。
  const v = Math.max(0, Number(ms) || 0);
  if (v < 1000) return `${Math.round(v)}ms`;
  const total = Math.floor(v / 1000);
  if (total < 60) return `${total} 秒`;
  return `${Math.floor(total / 60)} 分 ${total % 60} 秒`;
}

/** 任务总耗时格式（交互设计 2026-09-09 修订）：整秒计数（「1 秒」「2 秒」，
 *  不带小数位）——本地发送时刻到本地收尾时刻的纯本地差值；分位为 0 时
 *  省略分。发送瞬间即显示「0 秒」起跳。 */
function _csFmtTaskDur(ms) {
  const v = Math.max(0, Number(ms) || 0);
  const sec = Math.floor(v / 1000);
  if (sec < 60) return `${sec} 秒`;
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
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
  // 任务耗时本地计时：startedAtMs 已是发送链路传入的本地发送时刻（或
  // 事件时间戳兜底）——记到 _csLocalSendMs 供终态定格复用同一起点。
  const t0 = Number(startedAtMs) || Date.now();
  flow.dataset.csT0 = String(t0);
  flow._csLocalSendMs = t0;
  // 立即先画一次（此刻 badge 尚未插入 DOM，isConnected 检查只放在轮询里）。
  label.textContent = _csFmtTaskDur(Date.now() - t0);
  flow._csTicker = setInterval(() => {
    if (!flow.isConnected) { _csStopTicker(flow); return; }
    label.textContent = _csFmtTaskDur(Date.now() - t0);
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
 *  运行中 label=工作中（实时计时），终态定格 label=已完成；历史无计时
 *  数据只显示「已完成」（不编造时长）。 */
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
  label.textContent = (opts && opts.terminalLabel) ? '已完成' : '工作中';
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

/** 同一消息头只保留一枚徽章：新回合建流时，把同头旧徽章移回各自流体首行
 *  并折叠收起。多回合（commander+派单链 worker）徽章横向堆满消息头且幻影
 *  回合永久「工作中」的真机踩坑（收编轮反馈）。旧流过程行保留在体内，
 *  展开旧徽章仍可回看；计时冻结不编造。 */
function _csConsolidateHeaderBadges(flow, host) {
  if (!host) return;
  for (const [, oldFlow] of _csPanels) {
    if (oldFlow === flow || !oldFlow._csBadge) continue;
    if (oldFlow._csBadge.parentNode !== host) continue;
    let row = oldFlow.querySelector('.cs-badge-row');
    if (!row) {
      row = document.createElement('div');
      row.className = 'cs-badge-row';
      oldFlow.insertBefore(row, oldFlow.firstChild);
    }
    row.appendChild(oldFlow._csBadge);
    _csStopTicker(oldFlow);
    _csSetCollapsed(oldFlow, true);
    oldFlow.dataset.csSuperseded = '1';
  }
}
/** 徽章挂进消息头时与「模型名称」芯片换位（交互设计 2026-09-08 截图要求）：
 *  徽章（+停止钮）占据 exec-meta 原位置（发送者名后），exec-meta 挪到消息头
 *  末尾。exec-meta 缺省（或宿主是流内徽章行 fallback）时退化为末尾追加。 */
function _csMountBadgeInHost(host, badge, stopBtn) {
  const execMeta = host && host.classList && host.classList.contains('chat-msg-header')
    ? host.querySelector('.chat-msg-exec-meta')
    : null;
  if (!execMeta) {
    host.appendChild(badge);
    if (stopBtn) host.appendChild(stopBtn);
    return;
  }
  host.insertBefore(badge, execMeta);
  if (stopBtn) host.insertBefore(stopBtn, execMeta);
  host.appendChild(execMeta);
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
  _csConsolidateHeaderBadges(flow, host);
  if (!(opts && opts.noStatus)) {
    // 运行中的「加载中」指示：时间线末尾（order 兜底永远最后），让用户
    // 知道过程还在继续；终态时移除。
    const loading = document.createElement('div');
    loading.className = 'cs-loading';
    loading.innerHTML = `<span class="cs-loading-spinner">${_csIco('loader')}</span>`;
    body.appendChild(loading);

    const badge = _csCreateBadge(flow, opts);
    // 就近停止按钮已移除（交互设计 2026-09-08：该按钮无实际作用——主输入区
    // 停止按钮已覆盖完整 abort 链，此副本平时不可达）；徽章单独挂载。
    _csMountBadgeInHost(host, badge, null);
    _csStartTicker(flow, opts && opts.startedAtMs);
  } else {
    // 历史/完成态：徽章只做收起开关（无计时数据不编造时长）。
    _csMountBadgeInHost(host, _csCreateBadge(flow, { terminalLabel: true, noElapsed: true }), null);
  }
  return flow;
}

/** 流移除唯一入口：连同挂在消息头上的徽章/停止一起清掉。 */
function _csRemoveFlow(flow) {
  if (!flow) return;
  if (flow._csBadge) flow._csBadge.remove();
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
  // 复用判定（真机踩坑 2026-09-08 两轮）：仅判 isConnected 不够——历史渲染
  // 在尚未挂入文档的 msgDiv 上重放，首轮建的流未 connected，后续每条
  // chatItem 都被判「流不在」而各自新建（12:12 一条消息 14 个幽灵面板事故）。
  // 「connected 或就在本 anchor 消息树内」都算活着：同一消息树里已注册的流
  // 就是可复用的那条，与它在不在文档无关。
  if (flow && (flow.isConnected || !!(anchor && anchor.contains && anchor.contains(flow)))) {
    return { flow, body: flow.querySelector('.cs-flow-body') };
  }
  // 发送即起计的 pending 流接管（交互设计 2026-09-09 需求：计时器在发送
  // 那一刻出现，不等模型首事件）：prewarm 建的流挂在同一 anchor 消息树
  // 内、以占位 turnId 注册——真 turnId 的首条事件到达时迁移 key 并转正。
  if (!flow && anchor) {
    for (const [pendingKey, pendingFlow] of _csPanels.entries()) {
      if (pendingFlow.dataset.csPending !== '1') continue;
      if (!(anchor.contains && anchor.contains(pendingFlow))) continue;
      _csPanels.delete(pendingKey);
      pendingFlow.dataset.csPending = '';
      pendingFlow.dataset.csTurn = turnId;
      _csPanels.set(key, pendingFlow);
      return { flow: pendingFlow, body: pendingFlow.querySelector('.cs-flow-body') };
    }
  }
  // 注册表残留清理（真机踩坑 2026-09-08）：同 key 的 disconnected 旧流
  // 先从注册表移除，防止 size 膀胀与惰性清理误删活跃流；不调用
  // _csRemoveFlow（旧 DOM 已销毁，重复 remove 无害但多余）。
  if (flow) _csPanels.delete(key);
  flow = _csCreateFlow(cid, turnId, { ...opts, anchor });
  // 活动流挂在消息元素内部：消息头（cogseed 图标/名字）之后、正文容器
  // 之前——过程是消息的组成部分（图标下、正文上），执行中与完成态
  // 同位，收尾无需再移动。流式占位与历史渲染的消息结构都取
  // .chat-bubble（正文容器）为锚；查不到时退到消息末尾。
  const bubble = anchor && anchor.querySelector
    ? anchor.querySelector('.chat-bubble, [data-role="final"]') : null;
  if (bubble) anchor.insertBefore(flow, bubble);
  else if (anchor && anchor.appendChild) anchor.appendChild(flow);
  // 老 liveness strip（执行中…+计时+三点动画）与头部徽章职责重复：flow
  // 一出现就让它退场——activityDone 让它的计时器自清、后续更新早退。
  const legacyActivity = anchor.querySelector
    ? anchor.querySelector('[data-role="activity"]') : null;
  if (legacyActivity) {
    legacyActivity.style.display = 'none';
    anchor.dataset.activityDone = '1';
  }
  // 占位气泡里的三点打字动画同理（flow 已在跑，三点是重复活性指示）。
  const legacyThinking = bubble && bubble.querySelector
    ? bubble.querySelector('.stream-thinking') : null;
  if (legacyThinking) legacyThinking.style.display = 'none';
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

/** 回合终态：徽章定格为「已完成 总时长」（历史无数据只显示已完成），
 *  停止按钮撤除，计时器停止；收起开关保留（点击可开合时间线）。 */
function _csSetFlowState(flow, status, error, endedAtMs) {
  flow.classList.remove('running', 'done', 'failed', 'cancelled');
  flow.classList.add(status === 'completed' ? 'done' : status);
  _csStopTicker(flow);
  // 加载指示随终态退场（过程已结束，没有"还有下一步"）。
  const loading = flow.querySelector('.cs-loading');
  if (loading) loading.remove();
  const badge = flow._csBadge;
  if (badge) {
    const label = badge.querySelector('.cs-badge-label');
    if (label) {
      label.textContent = status === 'failed' ? `失败${error ? `：${error}` : ''}`
        : status === 'cancelled' ? '已取消' : '已完成';
    }
    // 工具数与状态拆开展示（交互设计 2026-09-08：「已完成 4个工具」混杂不清，
    // 拆为独立「N 次工具调用」段，无工具行时整段不显示）。
    let tools = badge.querySelector('.cs-badge-tools');
    if (!tools) {
      tools = document.createElement('span');
tools.className = 'cs-badge-tools';
      badge.appendChild(tools);
    }
    let toolCount = 0;
    const bodyEl = flow.querySelector('.cs-flow-body');
    if (bodyEl && bodyEl.children) {
      for (let i = 0; i < bodyEl.children.length; i++) {
        if (String(bodyEl.children[i].className || '').includes('cs-toolExecution')) toolCount++;
      }
    }
    tools.textContent = toolCount > 0 ? `${toolCount} 次工具调用` : '';
    // 失败详情被徽章省略号截断时，悬停 title 兜底看全文。
    if (status === 'failed' && error && label) badge.setAttribute('title', label.textContent);
    // 终态耗时：csT0 有权威值时补建 elapsed 元素（历史重放的 noStatus 徽章
    // 天生无此元素——存储补差后有权威 timing，老格式无 csT0 仍不显示）。
    const t0v = Number(flow.dataset.csT0);
    let elapsed = badge.querySelector('.cs-badge-elapsed');
    if (!elapsed && Number.isFinite(t0v) && t0v > 0) {
      elapsed = document.createElement('span');
      elapsed.className = 'cs-badge-elapsed';
      badge.appendChild(elapsed);
    }
    if (elapsed) {
      const t0 = Number(flow.dataset.csT0);
      // 终态定格（交互设计 2026-09-08 任务耗时需求）：t0 优先来自本地发送时刻
      // （localSendMs 链路），终点用本地墙钟收尾——整段计时纯本地。
      // 展示格式「X分X.X秒」（分 0 省略，秒保留 1 位小数）。
      const localAnchor = flow._csLocalSendMs;
      const effT0 = Number.isFinite(localAnchor) && localAnchor > 0 ? localAnchor : t0;
      const end = Number(endedAtMs) || Date.now();
      elapsed.textContent = effT0 ? _csFmtTaskDur(Math.max(0, end - effT0)) : '';
    }
  }
  if (status !== 'completed') return;
  // 完成即收尾（交互设计 2026-09-08）：过程区块默认收起——运行中展开跟踪、
  // 完成后自动折叠成徽章摘要行，点击徽章可再展开回看。
  if (flow.dataset.csCollapsed !== '1') _csSetCollapsed(flow, true);
  // 纯文字回合（无任何动作行）连流壳+徽章一起撤，不留空壳。
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
 *  MCP → 服务名 · 工具名；发送类 → 对端：消息摘要；其余 → 单行等宽摘要。 */
function _csTargetHtml(targetKind, args, rawSummary) {
  if (targetKind === 'mcp') {
    const server = _csFirstArg(args, ['connector', 'server', 'server_name', 'name'])
      || (rawSummary || '');
    const tool = _csFirstArg(args, ['tool', 'tool_name', 'method']);
    return `<span class="cs-file-name">${_csEscapeHtml(server)}</span>`
      + (tool ? `<span class="cs-row-dim">· ${_csEscapeHtml(tool)}</span>` : '');
  }
  if (targetKind === 'message') {
    // 发送/派单：给"用户视角"的目标感——→ 对端：消息前段（而非原始 JSON）。
    const peer = _csFirstArg(args, ['peer', 'to', 'target', 'agent', 'agent_name', 'agent_id', 'recipient']);
    const text = _csFirstArg(args, ['message', 'text', 'content', 'task', 'prompt']);
    const peerPart = peer ? `<span class="cs-file-name">→ ${_csEscapeHtml(peer)}</span>` : '';
    const bodyPart = text
      ? `<span class="cs-target">${_csEscapeHtml(text)}</span>`
      : (rawSummary ? `<span class="cs-target">${_csEscapeHtml(rawSummary)}</span>` : '');
    return peerPart + bodyPart;
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
  // 工具耗时不再显示（2026-09-11 需求变更）：本地 CLI 工具普遍毫秒级完成，
  // 数字信息量低还占行宽；timing 数据仍随条目保留，需要时悬停/调试可查。
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
  // 显示分层（交互设计 2026-09-08 20:22 确认方案）：主显示只露裸输入+输出
  // （真实增量，数值小且直观）；缓存命中率 ≥50% 显示正向标记「缓存 xx%」
  // （大数不吓人，省钱变亮点）；四项全量明细放悬停 title。与页脚
  // messageMetricsLine 同口径。
  const bareIn = numOr0(p.inputTokens);
  const cacheRead = numOr0(p.cacheReadTokens);
  const out = numOr0(p.outputTokens);
  if (bareIn > 0 || out > 0) bits.push(`↑${bareIn.toLocaleString()}`);
  if (out > 0) bits.push(`↓${out.toLocaleString()}`);
  const hitDenom = bareIn + cacheRead;
  if (hitDenom > 0 && cacheRead / hitDenom >= 0.5) {
    bits.push(`缓存 ${Math.round((cacheRead / hitDenom) * 100)}%`);
  }
  if (p.estimatedCost != null) bits.push(`≈$${p.estimatedCost}`);
  if (numOr0(p.contextWindowRatio) > 0) {
    const pct = Math.round(p.contextWindowRatio * 100);
    bits.push(`ctx ${pct}%`);
    if (pct >= 85) bits.push('<span class="cs-ctx-warn">上下文接近上限</span>');
  }
  if (!bits.length) return;
  const cacheWrite = numOr0(p.cacheWriteTokens);
  const title = (bareIn + cacheRead + cacheWrite + out) > 0
    ? `裸输入 ${bareIn.toLocaleString()} · 缓存读 ${cacheRead.toLocaleString()} · 缓存写 ${cacheWrite.toLocaleString()} · 输出 ${out.toLocaleString()}`
    : '';
  row.innerHTML = `<div class="cs-usage-row"${title ? ` title="${_csEscapeHtml(title)}"` : ''}>${bits.join(' · ')}</div>`;
}

function numOr0(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

// ── 思考行（合并连续片段为一行，收行时结算时长） ──────────────────────────

function _csThinkDurText(row) {
  // 运行中：实时秒数推进（PRD FR-5「进行中显示 …s」）；结束时定格实测值。
  // 无 t0（历史重放无计时锚点）运行中只显示省略号——不编造时长。
  if (row.dataset.csClosed !== '1') {
    const t0 = Number(row.dataset.csT0);
    return t0 ? `· ${_csFmtDur(Date.now() - t0)}` : '…';
  }
  const t0 = Number(row.dataset.csT0);
  if (!t0 || !row.dataset.csDur) return '';
  return `· 持续了 ${_csFmtDur(Number(row.dataset.csDur))}`;
}
// 注：重放推导计时（历史思考行时长）在 chatItem 重放循环里按
// 「上一锚点→下一锚点」窗口写回 csT0/csDur——见该处的推导注释。

function _csRenderThinkRow(row) {
  // 单行预览常显（2026-09-11 方案 C）：不管运行中还是已收行，都显示思考
  // 内容的一行预览（最后一个非空行，尾部截断）——收行后内容不再消失。
  let live = '';
  if (row.dataset.csFull) {
    const tl = String(row.dataset.csFull).split('\n').filter(Boolean).pop() || '';
    if (tl) live = `<span class="cs-think-live">${_csEscapeHtml(tl.slice(-90))}</span>`;
  }
  // 点击行展开全文：纯文本块，无边框/底色/圆角（不算卡片）。
  const full = row.dataset.csFull
    ? `<div class="cs-think-full">${_csEscapeHtml(row.dataset.csFull)}</div>` : '';
  row.innerHTML = `
    <div class="cs-row-line">
      <span class="cs-ico">${_csIco('brain-circuit')}</span>
      <span class="cs-verb">思考</span>
      <span class="cs-row-dim cs-think-dur">${_csThinkDurText(row)}</span>
      ${live}
    </div>
    ${full}`;
}

/** 文字段实时 markdown 渲染（交互设计 2026-09-08：流式期间 # ** 等符号裸露）。
 *  rAF 节流逐段渲染；renderer 不可用（测试 stub）退化为纯文本。渲染失败
 *  静默回退 textContent，正文永不丢。 */
function _csPaintTextSeg(seg) {
  const raw = seg.dataset.csSeg || '';
  const paint = () => {
    if (typeof renderMarkdownFull === 'function') {
      try {
        seg.innerHTML = `<div class="markdown-body">${renderMarkdownFull(raw)}</div>`;
        return;
      } catch (_) { /* 回退纯文本 */ }
    }
    seg.textContent = raw;
  };
  if (typeof requestAnimationFrame === 'function') {
    if (seg._csSegRaf) return;
    seg._csSegRaf = true;
    requestAnimationFrame(() => { seg._csSegRaf = false; paint(); });
  } else {
    paint();
  }
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
    // 点击行展开/收起全文（方案 C：纯文本块，无卡片样式）。
    row.addEventListener('click', () => row.classList.toggle('cs-open'));
    body.appendChild(row);
  }
  if (text) row.dataset.csFull = (row.dataset.csFull || '') + text;
  _csRenderThinkRow(row);
  return row;
}

/** 收思考行：结算时长。endAtMs 提供时（重放推导：下一带时间条目/回合
 *  终点的权威时刻）优先用它——重放行的 csT0 是加载墙钟而非真实起点，
 *  墙钟差是假时长；真实起点 = 终点 - 推导窗。无任何计时数据只定稿。 */
function _csCloseThinkRow(body, silent, endAtMs) {
  const kids = body.children;
  const last = kids[kids.length - 1];
  if (!last || !String(last.className || '').includes('cs-row-think') || last.dataset.csClosed === '1') return;
  last.dataset.csClosed = '1';
  if (Number.isFinite(endAtMs)) {
    // 重放推导：写入真实终点 + 标记起点待回填（csDur 由调用处根据推导窗写）。
    last.dataset.csTEnd = String(endAtMs);
  } else if (!silent && last.dataset.csT0) {
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

/** 回合收尾：时间线「开放段」（最终正文）交回 conversation 原管道
 *  （markdown/结构块保留），流内文字段只移除开放段——已关闭段
 *  （cs-closed=被工具/思考截断的中间叙述）保留在时间线里按原时序
 *  展示（实机反馈 2026-09-09：展开执行过程只见工具调用，AI 的中间
 *  叙述无处可见）。流宿主=消息元素。 */
function _csFinalizePanelText(flow) {
  // 开放段（无 cs-closed 标记）= 回合收尾时仍未被截断的最后一段 =
  // 最终正文；已关闭段是中间叙述，留在过程时间线。
  const openSegs = [];
  let openText = '';
  for (const seg of Array.from(flow.querySelectorAll('.cs-text'))) {
    if (seg.dataset.csClosed === '1') continue;
    openText += String(seg.dataset.csSeg || '');
    openSegs.push(seg);
  }
  const anchor = flow.parentNode;
  // 收尾无开放段（最后动作是工具/思考、无最终叙述）时，对齐 bus 的
  // 回退语义（final 分支：segmentText 空则正文取全文）——交回全部文字
  // 段聚合并清空：实时与重放一致、正文与过程区不重复（否则实时气泡
  // 空占位、重放却按 GroupMessage.text 显示全文，刷新即跳变）。
  let handBack = openText;
  let removeSegs = openSegs;
  if (!openText) {
    const all = Array.from(flow.querySelectorAll('.cs-text'));
    if (all.length) {
      handBack = all.map((s) => String(s.dataset.csSeg || '')).join('');
      removeSegs = all;
    }
  }
  if (handBack && anchor) {
    try {
      if (typeof _streamingAppendFinalDelta === 'function') {
        _streamingAppendFinalDelta(anchor, handBack);
      } else {
        const finalEl = anchor.querySelector('[data-role="final"]');
        if (finalEl) finalEl.textContent = handBack;
      }
    } catch (err) {
      _csLog.warn('timeline text hand-back failed', { error: String(err && err.message || err) });
    }
  }
  for (const seg of removeSegs) seg.remove();
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
    // 注意：不要在这里按 anchor.isConnected 拦截——历史渲染在尚未挂入
    // 文档的 msgDiv 上重放（detached 是合法中间态），拦截会把全部条目
    // 吞掉、面板永久空壳（2026-09-08 点击徽章无反应事故）。断链竞态由
    // _csEnsureFlow 的复用判定（connected 或在本 anchor 树内）吸收。
    if (chatEvent.type === 'chat.turn.started') {
      // 任务耗时本地计时（交互设计 2026-09-08）：优先用渲染进程捕获的
      // 「用户点击发送」墙钟（anchor.dataset.localSendMs，sendInConversation
      // 在 onAssistantStart 挂载）——本地发送→本地收尾，全程不依赖模型
      // 侧时间数据（模型收到时刻/开始思考/吞吐）。缺省回退事件时间戳。
      const localSend = Number(anchor && anchor.dataset && anchor.dataset.localSendMs);
      _csEnsureFlow(cid, anchor, chatEvent.turnId, {
        startedAtMs: (Number.isFinite(localSend) && localSend > 0)
          ? localSend
          : (chatEvent.startedAt ? Date.parse(chatEvent.startedAt) : Date.now()),
      });
      return;
    }
    if (chatEvent.type === 'chat.item') {
      const { kind, status, itemId, payload, turnId } = chatEvent;
      const { flow, body } = _csEnsureFlow(cid, anchor, turnId);
      if (kind === 'text') {
        // 时间线接管正文（边思考边说边执行的真实交错）：delta 追加到当前
        // 文字段，遇其它 item 关段；回合收尾只把「开放段」（最终正文）
        // 交回 conversation 原管道渲染（markdown/结构块不损失），已关闭
        // 段（中间叙述）留在时间线按原时序展示。
        _csCloseThinkRow(body);
        const piece = String((payload && payload.delta) || '');
        const kids = body.children;
        const last = kids[kids.length - 1];
        let seg = (last && last.className && String(last.className).includes('cs-text')
          && last.dataset.csClosed !== '1') ? last : null;
        if (!seg) {
          // 投影器在工具行后会补发 '\n\n' 分隔 delta（供 markdown 段落分隔）；
          // 时间线段剥掉段首空白（行间距已分隔），否则渲染出一块空行。
          const lead = piece.replace(/^[ \t\r\n]+/, '');
          if (!lead && !piece.trim()) return;
          seg = document.createElement('div');
          seg.className = 'cs-text';
          body.appendChild(seg);
          seg.dataset.csSeg = lead;
          _csPaintTextSeg(seg);
          return;
        }
        seg.dataset.csSeg = (seg.dataset.csSeg || '') + piece;
        _csPaintTextSeg(seg);
        return;
      }
      // 非文字 item：关闭当前文字段与思考行（下次各自新开段，保持交错）。
      // 例外：usage 等收尾行不截断正文——与 bus flushTextSegmentForPersist
      // 的截断语义对齐（只有工具/思考 flush；usage 后的叙述仍是最终段的
      // 一部分）。否则最终段被 usage 关掉后收尾交不回气泡、正文困在过程区。
      const cutsText = kind !== 'usage';
      const kids2 = body.children;
      const openSeg = kids2[kids2.length - 1];
      if (cutsText && openSeg && String(openSeg.className || '').includes('cs-text')) openSeg.dataset.csClosed = '1';
      if (kind === 'reasoning') {
        const rDelta = String((payload && payload.delta) || '');
        const rFull = String((payload && payload.text) || '');
        if (status === 'inProgress') {
          // 思考实时流式：增量逐段落入思考行。默认折叠（2026-09-11 需求
          // 变更：交互过程不再自动展开全文）——行内 cs-think-live 保留单行
          // 实时预览，用户点击行才展开 cs-think-full 全文。
          if (rDelta) {
            _csAppendReasoning(body, rDelta);
          }
          return;
        }
        // completed：与思考行已画内容做前缀去重——实时流此前已按 delta
        // 画过（整段=已画前缀+尾部差额），只补差额防重复；重放无前置
        // 增量，整段落入新行（历史 completed 条目无 inProgress 落盘）。
        const kids3 = body.children;
        const openThink = kids3[kids3.length - 1];
        const liveThink = openThink && String(openThink.className || '').includes('cs-row-think')
          && openThink.dataset.csClosed !== '1' ? openThink : null;
        if (liveThink && rFull && rFull.startsWith(String(liveThink.dataset.csFull || ''))) {
          const tail = rFull.slice(String(liveThink.dataset.csFull || '').length);
          if (tail) _csAppendReasoning(body, tail);
        } else {
          _csAppendReasoning(body, rFull);
        }
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

/** 发送即起计（交互设计 2026-09-09 需求：计时器在用户点击发送那一刻立即
 *  出现，不等模型首事件——首 token 前有数秒空窗）。以占位 turnId 建
 *  pending 流（徽章+计时+loading 全套挂载），真 turnId 的首条事件到达
 *  时由 _csEnsureFlow 迁移接管；发送失败无事件时 chatStreamFinalize
 *  的 cid 兜底把它收尾为 cancelled，不泄漏。 */
window.chatStreamPrewarm = function chatStreamPrewarm(cid, anchor, startedAtMs) {
  if (!anchor) return;
  const pendingTurnId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { flow } = _csEnsureFlow(cid, anchor, pendingTurnId, {
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
  });
  if (flow) flow.dataset.csPending = '1';
};

/**
 * 完成/历史态重建：从消息持久化的 process items 重建活动流，插在消息元素
 * 内部（消息头之后、正文之前）。conv-core 统一过程 UI——_renderPersistedProcess
 * 检测到本函数可用时全部委托过来，老 details 折叠卡退役（chat-stream.js 加载
 * 失败的极端场景仍走老路径兜底）。历史流没有运行行：动作行全部可见（与实时
 * 完成态一致）。
 *
 * 双格式：process 字段自存储补差起与 chat_events 结构化条目双写——
 *   {type:'chatItem', item} / {type:'turn', turn}（含权威 timing 与总耗时）
 * 有新条目时优先走事件重放（复用实时 handleEvent 全部渲染语义，含计时徽章
 * 与自动收束），重放异常或老消息回退下方老格式路径（无计时不编造）。
 */
window.chatStreamRenderPersisted = function chatStreamRenderPersisted(cid, msgDiv, items, opts) {
  if (!Array.isArray(items) || !items.length || !msgDiv || !msgDiv.parentNode) return false;
  const chatEntries = items.filter(function (it) {
    return it && (it.type === 'chatItem' || it.type === 'turn');
  });
  if (chatEntries.length) {
    try {
      // 幻影回合收编：多回合条目统一重放进一条规范时间线——
      // turn.started/completed 不再逐回合建流/定格（那会各自发徽章
      // 且幻影永不终态），消息头只留一枚终态徽章，总耗时取末终态。
      // turnId 选取（真机踩坑 2026-09-08）：条目时间序首个真实 turnId 优先
      // 于 opts.turnId——历史 API 的消息对象常缺 turn_id，调用方只能传
      // m:<msgId> 兜底；用兜底 key 建流后，恢复/观察管线按真实 turnId 喂
      // 事件会另起 live 流，同屏两条（徽章收编一条、行在另一条，点徽章
      // 收起的永远是空的那条）。多回合条目仍收编进首回合 key（幻影收编
      // 约定不变）。
      let turnId = '';
      let startedAtMs = NaN; let endedAtMs = NaN;
      let lastStatus = 'completed'; let lastError;
      let lastDurMs = NaN;
      for (const entry of chatEntries) {
        const ev = entry.type === 'chatItem' ? entry.item : entry.turn;
        if (!ev || typeof ev !== 'object') continue;
        if (!turnId && typeof ev.turnId === 'string' && ev.turnId) turnId = ev.turnId;
        if (ev.type === 'chat.turn.started') {
          const t = ev.startedAt ? Date.parse(ev.startedAt) : NaN;
          if (!Number.isFinite(startedAtMs) && Number.isFinite(t)) startedAtMs = t;
        } else if (ev.type === 'chat.turn.completed') {
          lastStatus = ev.status || lastStatus;
          if (ev.error) lastError = ev.error;
          const t = ev.endedAt ? Date.parse(ev.endedAt) : NaN;
          if (Number.isFinite(t)) endedAtMs = Number.isFinite(endedAtMs) ? Math.max(endedAtMs, t) : t;
          const d = ev.durationMs;
          if (Number.isFinite(d)) lastDurMs = d;
        }
      }
      if (!turnId) turnId = (opts && opts.turnId) || '';
      if (!turnId) turnId = (msgDiv.dataset && msgDiv.dataset.msgId) || ('hist-' + Date.now());
      const replayKey = _csPanelKey(cid, turnId);
      const old = _csPanels.get(replayKey);
      if (old) _csRemoveFlow(old);
      // 同消息可能残留旧回合的孤儿流（会话切换 container.innerHTML=''
      // 销毁后注册表未清）：重放前一并清扫，防止幽灵面板叠加（真机踩坑
      // 2026-09-08 中午）。判定必须加 parentElement——历史加载本身就在
      // detached fragment 上逐条重放（晚 17:40 踩坑：只判 isConnected 会把
      // fragment 里前一条消息刚建的合法流当孤儿清掉，最终只有最新一条
      // 回合保得住面板）。innerHTML='' 销毁的节点 parentElement 为 null，
      // fragment 内的流挂在各自 msgDiv 下——以此区分孤儿与在树流。
      for (const [k, stale] of Array.from(_csPanels.entries())) {
        if (k.startsWith(cid + '::') && !stale.isConnected && !stale.parentElement) {
          _csPanels.delete(k);
          _csRemoveFlow(stale);
        }
      }
      // 规范流：noStatus（无 loading/停止/计时器），ensure 负责挂载+注册。
      _csEnsureFlow(cid, msgDiv, turnId, { noStatus: true });
      const flow = _csPanels.get(replayKey);
      if (!flow) return false;
      if (Number.isFinite(startedAtMs)) flow.dataset.csT0 = String(startedAtMs);
      else if (Number.isFinite(endedAtMs) && Number.isFinite(lastDurMs)) flow.dataset.csT0 = String(endedAtMs - lastDurMs);
      // 思考行推导计时（交互设计 2026-09-08 PRD A1：历史思考块旁也显示实测
      // 耗时）。reasoning 条目无 timing，但相邻条目有权威时间锚：
      //   锚点序列 = turn.startedAt / 工具 timing.startedAtMs / 回合 endedAtMs
      // 思考行 i 的时长 = [前一锚点, 后一锚点] 窗口（思考被下一动作截断）。
      // 重放是瞬时的：先按序喂条目建行（csT0 为加载墙钟，不可信），再按
      // 锚点窗口回填真实 csT0/csDur。首锚缺失（老数据）不回填——不编造。
      const _anchors = [];
      for (const entry of chatEntries) {
        if (entry.type !== 'chatItem') continue;
        const ev = entry.item;
        if (!ev || typeof ev !== 'object') continue;
        if (ev.type === 'chat.turn.started' && ev.startedAt) {
          const t = Date.parse(ev.startedAt);
          if (Number.isFinite(t)) _anchors.push(t);
        } else if (ev.type === 'chat.item') {
          const tm = (ev.payload && ev.payload.timing) || {};
          if (Number.isFinite(tm.startedAtMs)) _anchors.push(tm.startedAtMs);
        } else if (ev.type === 'chat.turn.completed' && ev.endedAt) {
          const t = Date.parse(ev.endedAt);
          if (Number.isFinite(t)) _anchors.push(t);
        }
      }
      for (const entry of chatEntries) {
        if (entry.type !== 'chatItem') continue;
        const ev = entry.item;
        if (!ev || typeof ev !== 'object' || ev.type !== 'chat.item') continue;
        // 文本段（交互设计 2026-09-08：展开缺 AI 中间输出）：completed 的整段
        // 条目是「被后续工具/思考截断的中间正文」——消息体只有最终段，这些
        // 不落面板就永远丢了；inProgress 增量条目（CLI 逐 token 旧格式）
        // 与最终段跳过，防与消息体重复。
        if (ev.kind === 'text' && ev.status !== 'completed') continue;
        // 兜底（真机踩坑 2026-09-08 16:20）：含 ::: 结构指令（dashboard/
        // chart-bar 等组件源码）的段落属于最终稿内容——面板以纯文本显示
        // 就是"源码外露"，且与正文渲染好的可视化面板重复。过程面板只收
        // 人读中间叙述，结构化成品留给正文管道。
        if (ev.kind === 'text' && /(^|\n):::/.test(String((ev.payload && ev.payload.delta) || ''))) continue;
        // 重放期间消息行若被并发 reconcile 重建（anchor 换节点），feed 会
        // 落进旧树里的流（不可见，无害）；规范流仍收尾。
        window.chatStreamHandleEvent(cid, msgDiv, Object.assign({}, ev, { turnId }));
      }
      // 思考行回填：按锚点窗口逐行写真实 t0/dur（行序 = 建行序 = 条目序）。
      {
        // 尾锚兜底：条目缺 turn.completed（重试中断等）时，用下方推导的
        // endMs（metrics.completedAt 链）补——思考行被回合终点截断。
        const anchors = _anchors.slice();
        if (Number.isFinite(endedAtMs) && (anchors.length < 2 || anchors[anchors.length - 1] < endedAtMs)) {
          anchors.push(endedAtMs);
        }
        const thinkRows = Array.from(flow.querySelectorAll('.cs-row-think'));
        let prevEnd = anchors.length ? anchors[0] : NaN;
        for (let i = 0; i < thinkRows.length; i++) {
          // 该行的截断锚 = 其后首个更大锚点（多行共享同一窗口时后续行
          // 窗口为 0——真实情况是并行重试叙述，显示 0 优于假时长）。
          const nextAnchor = anchors.find((a) => a > prevEnd);
          if (!Number.isFinite(prevEnd) || !Number.isFinite(nextAnchor) || nextAnchor < prevEnd) continue;
          const row = thinkRows[i];
          row.dataset.csClosed = '1';
          row.dataset.csT0 = String(prevEnd);
          row.dataset.csDur = String(Math.max(0, nextAnchor - prevEnd));
          prevEnd = nextAnchor;
          _csRenderThinkRow(row);
        }
      }
      let endMs = endedAtMs;
      if (!Number.isFinite(endMs) && Number.isFinite(lastDurMs)) {
        const t0 = Number(flow.dataset.csT0);
        endMs = Number.isFinite(t0) ? t0 + lastDurMs : Date.now();
      }
      // 无权威终态时刻（缺 turn.completed 条目）不编造时长：清掉 csT0，
      // 否则 _csSetFlowState 会拿 Date.now() 当终点，把「回合开始至今」
      // 算成假耗时（真机踩坑：29 秒的回合显示 47 分钟）。
      if (!Number.isFinite(endMs)) delete flow.dataset.csT0;
      // 终态兜底（真机踩坑 2026-09-08）：重放目标是历史消息——无论条目里
      // 有没有 turn 终态，面板必须离开 running。detached 重放（历史渲染
      // 先建树后挂文档）同样定格：DOM 操作不依赖 connected，跳过只会留下
      // running 残壳。
      _csSetFlowState(flow, lastStatus, lastError, Number.isFinite(endMs) ? endMs : undefined);
      // 重放循环可能经 ensure 新建过中间流（同 key 断链重建），确保注册
      // 表里最终态就是这个 flow。
      _csPanels.set(replayKey, flow);
      return true;
    } catch (err) {
      _csLog.warn('chat entries replay failed, falling back to legacy items', { error: (err && err.message) || String(err) });
    }
  }
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
    // 思考行时长（交互设计 2026-09-08 PRD A1）：legacy progress 落盘无逐条
    // timing，但多数消息带权威 metrics 窗（msgDiv._msgMetrics.startedAt →
    // completedAt，由 appendChatMessage 在重放前挂载）。纯思考回合整段
    // 思考落在一个窗口内；窗口缺失（极老数据）仍只定稿不编造。
    _csCloseThinkRow(body, true);
    {
      const mt = msgDiv._msgMetrics || null;
      const ms = mt && Number(mt.startedAt);
      const me = mt && Number(mt.completedAt);
      if (Number.isFinite(ms) && Number.isFinite(me) && me > ms) {
        for (const row of Array.from(flow.querySelectorAll('.cs-row-think'))) {
          row.dataset.csClosed = '1';
          row.dataset.csT0 = String(ms);
          row.dataset.csDur = String(me - ms);
          _csRenderThinkRow(row);
        }
      }
    }
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
