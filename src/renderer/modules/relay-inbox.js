/**
 * A2A relay inbox (H-04) — the receiving end, on screen.
 *
 * The hub hands us cross-side messages; main consumes them (the relay deletes on
 * delivery, so it can only have one reader) and pushes them here on `a2a:relay`.
 * This module paints them above the composer with the marks the product requires:
 * 「对方可见」on every cross-side message and「X 的助理」for a reply from the peer's
 * assistant.
 *
 * The strip is also where the reception decision becomes visible (AC-04/05): a
 * first question from a contact waits for「确认接待」, and once the receiver has
 * accepted, the assistant answers on its own — the strip says so and offers no
 * reply button, because the answer is already being produced in the conversation.
 * Deciding and running both live in main (`a2a.relay-pump` / `a2a.reception.*`);
 * this module only asks and paints, so nothing here can widen what the assistant
 * may do.
 *
 * Kept as its own strip rather than mixed into the transcript: the transcript is
 * owned by the group-chat renderer, and injecting into it from a push handler would
 * fight with its ordering rules. The reception conversation itself carries the
 * exchange (peer question + assistant answer as real bubbles).
 */
(function () {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;
  const MAX_ROWS = 20;
  /** 每条消息的接待状态：waiting/answering/answered/failed/ignored/answered_by_me。 */
  const RELAY_STATES = ['waiting', 'answering', 'answered', 'failed', 'ignored', 'answered_by_me'];
  /** 与主进程接待暂存一致：等待确认超过 10 分钟就不再可操作（C09）。 */
  const RECEPTION_TTL_MS = 10 * 60 * 1000;
  let messages = [];
  /** messageId → 该行按 receivedAt + TTL 到点的移除计时器；只是内存视图，重绘不叠加。 */
  const expiryTimers = new Map();
  let unsubscribe = null;

  function tr(key, fallback, vars) {
    let text = fallback;
    try {
      if (typeof root.t === 'function') {
        const value = root.t(key, vars || {});
        if (value && value !== key) text = String(value);
      }
    } catch (_) { /* i18n 未加载 */ }
    // 有的语言包/旧版本不带插值：兜底自己替换一次。
    return String(text).replace(/\{(\w+)\}/g, (_, name) => (vars && vars[name] != null ? String(vars[name]) : `{${name}}`));
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function host() {
    return typeof document !== 'undefined' ? document.getElementById('a2a-relay-strip') : null;
  }

  function api() {
    const bridge = root.cogseed;
    return bridge && typeof bridge.invoke === 'function' ? bridge : null;
  }

  function icon(name) {
    return typeof root.uiIconHtml === 'function' ? root.uiIconHtml(name) : '';
  }

  /** 只有共享按钮存在时才渲染动作：没有共享原语就不手写控件（Renderer 结构策略）。 */
  function button(label, attrs, role) {
    if (typeof root.uiButton !== 'function') return '';
    return root.uiButton({ label, role: role || 'secondary', size: 'sm', attrs });
  }

  /** 状态行：接待进行到哪一步（AC-04/05），统一用共享的状态胶囊。 */
  function stateLine(message) {
    const state = message.relayState;
    if (!state || state === 'ignored') return '';
    // 对方的回答本身就是内容，不需要再标「已回复」。
    if (message.kind === 'answer') return '';
    const map = {
      waiting: ['a2a.reception.awaiting', '等你确认是否接待', 'warning'],
      answering: ['a2a.reception.answering', '助理正在回答', 'info'],
      answered: ['a2a.reception.answered', '助理已回复', 'success'],
      failed: ['a2a.reception.failed', '没能回答', 'danger'],
      answered_by_me: ['a2a.reception.answered_by_me', '已回复', 'success'],
    };
    const entry = map[state];
    if (!entry) return '';
    // 确认前对方又发了几条：合成一条并标出条数。
    const pending = state === 'waiting' && Number(message.pendingCount) > 1
      ? ` · ${tr('a2a.reception.pending_count', '共 {n} 条', { n: Number(message.pendingCount) })}`
      : '';
    const label = `${tr(entry[0], entry[1])}${pending}`;
    if (typeof root.uiStatusPill === 'function') {
      return root.uiStatusPill({
        label,
        tone: entry[2],
        attrs: { 'data-a2a-reception-state': state },
      });
    }
    // 共享胶囊不可用时只写文字，不另造一种视觉变体。
    return `<span class="a2a-relay-state" role="status">${esc(label)}</span>`;
  }

  /** 等待确认时只给两个选择：接待 / 暂不接待。打开会话靠整行点击，不再单列按钮。 */
  function questionActions(message) {
    if (message.kind !== 'question' || message.relayState !== 'waiting') return '';
    const buttons = [
      button(tr('a2a.reception.confirm', '确认接待'), {
        'data-relay-confirm': message.messageId, 'data-a2a-reception-action': 'confirm',
      }, 'primary'),
      button(tr('a2a.reception.decline', '暂不接待'), {
        'data-relay-skip': message.messageId, 'data-a2a-reception-action': 'decline',
      }),
    ];
    return `<div class="a2a-relay-actions">${buttons.join('')}</div>`;
  }

  function rowHtml(message, opts = {}) {
    const inline = opts.inline === true;
    const marks = root.a2aMessageMarks;
    const source = message.kind === 'answer'
      ? (marks ? marks.sourceLabel('remote', message.fromName || '') : '')
      : (marks ? marks.sourceLabel('peer', message.fromName || '') : '');
    // sourceLabel 自带「对方可见」；下面再补一次会重复两枚，剥掉后统一在行尾给一次。
    const badge = marks ? marks.visBadge() : '';
    const sourceOnly = String(source).replace(/<span class="a2a-vis"[\s\S]*?<\/span>/g, '');
    // 已处理的条目压成两行；等本人确认的问题保留全文——判定要看完整问题。
    // 进入会话后已处理的条目会被当作已读收掉；等待确认的行留在卡片里，正文照给
    //（等待态会话记录里没有气泡，这里是唯一能看到问题原文的地方）。
    const compact = !!message.relayState && message.relayState !== 'waiting';
    // 消息已经在当前会话里（inline）时没有「打开会话」可做；此时行不可点，
    // 否则点一下就把等待确认的那行收起来，确认按钮跟着消失。
    const canOpen = !!message.conversationId && !inline;
    return `<div class="a2a-relay-row${compact ? ' is-compact' : ''}" data-relay-message="${esc(message.messageId)}" data-relay-state="${esc(message.relayState || '')}"${message.conversationId ? ` data-relay-cid="${esc(message.conversationId)}"` : ''}${canOpen ? ` title="${esc(tr('a2a.relay.open_hint', '打开这条会话'))}" role="link" tabindex="0"` : ''}>
        ${sourceOnly}
        ${badge}
        ${stateLine(message)}
        ${questionActions(message)}
        ${inline && message.relayState !== 'waiting' ? '' : `<div class="a2a-relay-body">${esc(message.text)}</div>`}
        ${canOpen ? `<span class="a2a-relay-open-mark" aria-hidden="true">${icon('chevron-right')}</span>` : ''}
      </div>`;
  }

  let viewCid = null;
  function currentConversationId() {
    if (viewCid !== null) return viewCid;
    try {
      return typeof root.getCurrentConversationId === 'function' ? String(root.getCurrentConversationId() || '') : '';
    } catch (_) {
      return '';
    }
  }

  function render() {
    // 先按时间事实收掉过期行，再让计时器与剩余行对齐：页面隐藏/重绘都不会
    // 给同一行叠加第二个计时器，过期行也不会因为「没点确认」而一直留在条上。
    pruneExpired();
    syncExpiryTimers();
    const el = host();
    if (!el) return;
    const openCid = currentConversationId();
    // 进入会话或停留期间收到终态都算已读；进行中的问题仍需留给后续结果更新。
    if (openCid) {
      messages = messages.filter((row) => !(row.conversationId === openCid
        && ['answered', 'failed', 'ignored', 'answered_by_me'].includes(row.relayState)));
    }
    // 当前会话里已经能看到问答气泡的，收件箱不再重复一遍（只留别的会话的）。
    // 例外：等本人确认的那条必须一直显示——「确认接待」只在这里，藏掉就等于
    // 打开会话后无处可确认。
    const visible = messages.filter((row) => row.relayState !== 'ignored'
      && (row.relayState === 'waiting' || !(openCid && row.conversationId === openCid)));
    if (!visible.length) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    el.innerHTML = `<div class="a2a-relay-strip" role="log" aria-live="polite">
      <div class="a2a-relay-head"><span class="a2a-relay-title">${esc(tr('a2a.relay.title', '来自对方的消息'))}</span></div>
      ${visible.map((row) => rowHtml(row, { inline: !!openCid && row.conversationId === openCid })).join('')}
    </div>`;
    bind(el);
  }

  function bind(el) {
    // 整行可点：跳到所属的 A2A 会话，已读终态统一由 render 收起。
    const openRow = (node) => {
      const cid = node.getAttribute('data-relay-cid');
      if (!cid) return;
      try {
        if (typeof root.setView === 'function') root.setView('conversation', cid);
      } catch (_) { /* 切换失败时保留入口 */ }
    };
    el.querySelectorAll('[data-relay-cid][role="link"]').forEach((node) => {
      node.addEventListener('click', () => openRow(node));
      node.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openRow(node);
      });
    });
    const stop = (fn) => (node) => node.addEventListener('click', (event) => {
      event.stopPropagation();
      fn(node);
    });
    el.querySelectorAll('[data-relay-confirm]').forEach(stop((node) => { void confirmReception(node.getAttribute('data-relay-confirm')); }));
    el.querySelectorAll('[data-relay-skip]').forEach(stop((node) => { void declineReception(node.getAttribute('data-relay-skip')); }));
  }

  function setState(messageId, state, extra) {
    if (!RELAY_STATES.includes(state)) return;
    messages = messages.map((row) => (
      row.messageId === messageId ? { ...row, ...(extra || {}), relayState: state } : row
    ));
    render();
  }

  /** 终态条目放久了自己离场，收件箱不留一堆已经处理过的历史。 */
  const SETTLED_TTL_MS = 30 * 60 * 1000;
  function pruneSettled(now = Date.now()) {
    const before = messages.length;
    messages = messages.filter((row) => {
      if (!row.relayState || row.relayState === 'waiting' || row.relayState === 'answering') return true;
      const at = Date.parse(String(row.createdAt || ''));
      return !Number.isFinite(at) || now - at < SETTLED_TTL_MS;
    });
    return before !== messages.length;
  }

  function drop(messageId) {
    messages = messages.filter((row) => row.messageId !== messageId);
    render();
  }

  /**
   * 按会话收行：确认/拒绝失败时，收件箱里的同一行可能已经被新问题合并成另一个
   * messageId（Q1 弹窗 → Q2 重开）。只按旧 messageId 收会留下「已经不能点的旧行」
   * 或收错行，所以失败路径统一按会话收，再让主进程投影补回真正的当前 pending。
   */
  function dropConversation(conversationId) {
    messages = messages.filter((row) => row.conversationId !== conversationId);
    render();
  }

  function find(messageId) {
    return messages.find((row) => row.messageId === messageId) || null;
  }

  /** 行的原始时间锚点：主进程投影/推送带来的 receivedAt，缺省回落原消息时间。 */
  function receivedAtOf(row) {
    const raw = String((row && (row.receivedAt || row.createdAt)) || '');
    const at = Date.parse(raw);
    return Number.isFinite(at) ? at : null;
  }

  /** 只有「等本人确认」的行有 10 分钟失效率；已处理的行走自己的终态 TTL。 */
  function waitingDeadline(row) {
    if (!row || row.relayState !== 'waiting') return null;
    const at = receivedAtOf(row);
    return at === null ? null : at + RECEPTION_TTL_MS;
  }

  function isWaitingExpired(row, now = Date.now()) {
    const deadline = waitingDeadline(row);
    return deadline !== null && now >= deadline;
  }

  function clearExpiryTimer(messageId) {
    const timer = expiryTimers.get(messageId);
    if (timer === undefined) return;
    clearTimeout(timer);
    expiryTimers.delete(messageId);
  }

  function clearExpiryTimers() {
    for (const timer of expiryTimers.values()) clearTimeout(timer);
    expiryTimers.clear();
  }

  /** 到点自动收行，不需要用户点确认/拒绝；离场后不再保留可操作按钮。 */
  function pruneExpired(now = Date.now()) {
    const before = messages.length;
    messages = messages.filter((row) => {
      if (!isWaitingExpired(row, now)) return true;
      clearExpiryTimer(row.messageId);
      return false;
    });
    return before !== messages.length;
  }

  function scheduleExpiry(row) {
    const deadline = waitingDeadline(row);
    const messageId = String(row.messageId || '');
    if (deadline === null || !messageId) return;
    const timer = setTimeout(() => {
      expiryTimers.delete(messageId);
      // 到点即收：即使系统时钟随后被回拨，也不让过期行继续留在屏幕上。
      messages = messages.filter((item) => item.messageId !== messageId);
      render();
    }, Math.max(0, deadline - Date.now()));
    if (timer && typeof timer.unref === 'function') timer.unref();
    expiryTimers.set(messageId, timer);
  }

  /** 让计时器集合与当前内存行一致：重绘不重复堆，行离场就撤销。 */
  function syncExpiryTimers() {
    const waiting = new Map();
    for (const row of messages) {
      if (row.relayState === 'waiting') waiting.set(row.messageId, row);
    }
    for (const [messageId, timer] of [...expiryTimers.entries()]) {
      const row = waiting.get(messageId);
      if (!row || waitingDeadline(row) === null) {
        clearTimeout(timer);
        expiryTimers.delete(messageId);
      }
    }
    for (const row of waiting.values()) {
      if (!expiryTimers.has(row.messageId)) scheduleExpiry(row);
    }
  }

  /** 缺时间锚点的来访按「现在到达」计时，避免无时间行永远留在收件箱。 */
  function withReceivedAt(row) {
    return receivedAtOf(row) === null ? { ...row, receivedAt: new Date().toISOString() } : row;
  }

  /**
   * 主进程说「这条问题来了」：等本人确认就显示动作，已经交给助理就显示进行中。
   * 决策在主进程（`relay-pump`），这里只照着画。
   */
  function upsert(message, state, extra) {
    pruneExpired();
    const existing = find(message.messageId);
    if (existing) {
      setState(message.messageId, state, extra);
      return;
    }
    // 同一次来访在确认前又来一条：合成一条，正文取最新，计数 +1。
    // 一个来访只该有一个「接待」决定；留两行会让用户以为要确认两次。
    if (state === 'waiting' && message.kind === 'question') {
      const pendingIndex = messages.findIndex((row) => row.conversationId === message.conversationId
        && row.relayState === 'waiting' && row.kind === 'question');
      if (pendingIndex >= 0) {
        const previous = messages[pendingIndex];
        // 同一次来访的新问题按**新消息时间**重新起算：主进程替换 pending 时也
        // 用新问题的 createdAt 作 receivedAt，渲染层计时必须跟它一致。
        const mergedAt = String((extra && extra.receivedAt) || message.receivedAt || message.createdAt || '');
        const merged = withReceivedAt({
          ...previous,
          ...message,
          ...(extra || {}),
          relayState: 'waiting',
          receivedAt: mergedAt || new Date().toISOString(),
          pendingCount: (Number(previous.pendingCount) || 1) + 1,
        });
        messages = messages.map((row, index) => (index === pendingIndex ? merged : row));
        render();
        return;
      }
    }
    messages = [...messages, withReceivedAt({ ...message, ...(extra || {}), relayState: state })].slice(-MAX_ROWS);
    render();
  }

  /**
   * 可接访的助理候选：空值＝CogSeed 自己的助理（默认），其余是用户自己的 Agent。
   * 主进程只读投影返回可接访的 Agent，不触发普通目录的迁移或缓存写入。
   */
  function receptionAgentOptions(rows, selected) {
    const options = [{
      value: '',
      label: tr('a2a.reception.assistant_default', 'CogSeed 助理（默认）'),
    }];
    // 只有内进程 Agent 能接访（外部 CLI/网关会被主进程拒绝）：先在候选里滤掉，
    // 免得用户从四十多项里挑一个提交后才被告知不能用。
    const kindOf = (row) => String(row && row.runtime && row.runtime.kind ? row.runtime.kind : '');
    const eligible = (row) => !!row
      && row.enabled !== false
      && kindOf(row) !== 'cli'
      && kindOf(row) !== 'p3394-gateway';
    const sorted = rows.filter(eligible).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    for (const row of sorted) {
      const value = String((row && row.agent_id) || '');
      if (!value) continue;
      options.push({ value, label: String(row.name || value) });
    }
    const chosen = String(selected || '');
    if (chosen && !options.some((option) => option.value === chosen)) {
      options.push({ value: chosen, label: chosen });
    }
    return options;
  }

  /** 助理字段：选择谁来接待这次来访。 */
  function assistantField(options) {
    if (typeof root.uiField !== 'function' || typeof root.uiSelect !== 'function') return '';
    return root.uiField({
      id: 'a2a-reception-assistant',
      label: tr('a2a.reception.assistant', '由谁接待'),
      hint: tr('a2a.reception.assistant_hint', '只有本机 Agent 可以接待；外部 CLI Agent 不会接访。'),
      showRequirement: false,
      control: {
        kind: 'select',
        native: true,
        value: options.value || '',
        options: options.options || [],
        className: 'a2a-reception-select',
        attrs: { 'data-a2a-reception-input': 'assistant' },
      },
    });
  }

  /**
   * 接待范围：只有工作区是必须当场定的（助理的读根）。
   * 表单只用共享控件（`uiField` + `uiInput`）；没有共享原语就不渲染这个字段，
   * 而不是手写一个输入框。
   */
  /**
   * 接待范围：选本机已有的工作空间（空间）即可，不再让本人手填路径。
   * 选「自定义目录…」时才展开路径输入 + 选择文件夹（兜底）。
   * 下拉与自定义行同时渲染，靠 change 切换显示，避免整块重绘丢焦点。
   */
  function workspaceField(options) {
    if (typeof root.uiField !== 'function') return '';
    const custom = !!options.custom;
    const selectField = typeof root.uiSelect === 'function'
      ? root.uiField({
        id: 'a2a-reception-workspace',
        label: tr('a2a.reception.workspace', '接待范围（工作区）'),
        hint: tr('a2a.reception.workspace_hint', '确认本次接待使用的目录；写入和执行仍需逐次批准。'),
        showRequirement: false,
        control: {
          kind: 'select',
          native: true,
          value: options.value || '',
          options: options.options || [],
          className: 'a2a-reception-select',
          attrs: { 'data-a2a-reception-input': 'space' },
        },
      })
      : '';
    // Business content inside the shared form, updated from the server for every
    // selection. No preview path is treated as a client-side grant.
    const previewRow = `<p class="a2a-reception-default-path" data-a2a-reception-preview="1" aria-live="polite">${options.preview ? esc(tr('a2a.reception.workspace_resolved', '本次接待目录')) + ' ' + esc(options.preview) : ''}</p>`;
    const pick = button(tr('a2a.reception.pick', '选择文件夹'), { 'data-a2a-reception-pick': '1' });
    const customRow = `<div class="a2a-reception-custom"${custom ? '' : ' hidden'}>${root.uiField({
      id: 'a2a-reception-path',
      label: tr('a2a.reception.workspace_path', '目录路径'),
      showRequirement: false,
      control: {
        kind: 'input',
        value: options.path || '',
        placeholder: options.placeholder || '',
        attrs: { 'data-a2a-reception-input': 'workspace' },
      },
    })}<div class="a2a-reception-pick">${pick}</div></div>`;
    return `${selectField}${previewRow}${customRow}`;
  }

  /** 空间下拉的候选项：默认工作区 / 本机空间 / 自定义目录。 */
  function receptionSpaceOptions(rows, defaultWorkspace) {
    const options = [
      { value: '', label: tr('a2a.reception.workspace_default', '默认工作区') },
    ];
    for (const space of rows) {
      const sid = String((space && space.space_id) || '');
      if (!sid) continue;
      const name = String(space.name || sid);
      options.push({ value: `space:${sid}`, label: name });
    }
    options.push({ value: 'custom', label: tr('a2a.reception.workspace_custom', '自定义目录…') });
    if (defaultWorkspace) {
      return { options, value: 'custom', path: String(defaultWorkspace) };
    }
    return { options, value: '', path: '' };
  }

  /**
   * 确认接待（D-04）：选范围 → 主进程把会话切到 active 并开跑。
   * 弹窗走共享的 `uiFormModal`，提交失败把原因写回弹窗而不是静默关闭。
   */
  /** 确认/拒绝失败的把人话写清楚；会话已经不存在的，顺手收掉这一行。 */
  const RECEPTION_GONE = ['not an a2a conversation', 'not a reception conversation'];
  /** 主进程的 pending 绑定已被清理（迟到确认），与「会话不存在」不是同一类。 */
  const PENDING_GONE = 'pending reception not found';
  function receptionErrorText(code) {
    if (code === 'assistant_unavailable') return tr('a2a.reception.assistant_unavailable', '这个 Agent 不能接访，请换一个');
    if (code === 'workspace_preview_changed') return tr('a2a.reception.workspace_changed', '目录已变化。请查看更新后的预览，再确认接待。');
    if (code === 'space not found') return tr('a2a.reception.space_missing', '这个空间已不可用，请重新选择。');
    if (code === 'workspace grant is unavailable' || code === 'workspace state unavailable') return tr('a2a.reception.workspace_unavailable', '已授权目录不可用，无法开始接待。');
    if (code === 'workspace is not a directory') return tr('a2a.reception.workspace_invalid', '这个目录不可用，请换一个工作空间');
    if (code === 'reception is not waiting') return tr('a2a.reception.not_waiting', '这次来访已经处理过了');
    if (code === 'reception_expired') return tr('a2a.reception.expired', '这条来访已超过 10 分钟，不能再接待');
    if (code === 'reception_stale_pending') return tr('a2a.reception.stale_pending', '这条来访已经被新的问题替换，请在新的一行上重新确认');
    if (code === PENDING_GONE) return tr('a2a.reception.pending_gone', '这条来访已经失效（可能刚被清理），已为你刷新待确认列表');
    if (RECEPTION_GONE.includes(code)) return tr('a2a.reception.gone', '这条来访已经不存在了（可能已被清理）');
    return code || tr('a2a.reception.confirm_failed', '没能开始接待，请重试。');
  }

  async function confirmReception(messageId) {
    const bridge = api();
    const message = find(messageId);
    if (!bridge || !message) return;
    if (typeof root.uiFormModal !== 'function') return;
    let setup;
    try { setup = await bridge.invoke('a2a.reception.setup', {}); }
    catch (_) { /* 无法读取目录时保留默认和自定义范围，提交仍由主进程验证。 */ }
    const agentOptions = receptionAgentOptions(Array.isArray(setup?.agents) ? setup.agents : [], message.defaultAgentId || '');
    const space = receptionSpaceOptions(Array.isArray(setup?.spaces) ? setup.spaces : [], String(message.defaultWorkspace || ''));
    let expectedPreview = null;
    let previewSelection = '';
    let previewGeneration = 0;
    let closed = false;
    let submitting = false;
    let feedbackCode = '';
    const selection = () => {
      const selected = modal.dialog.querySelector('[data-a2a-reception-input="space"]');
      const input = modal.dialog.querySelector('[data-a2a-reception-input="workspace"]');
      const value = selected ? String(selected.value || '') : '';
      return value.startsWith('space:') ? { spaceId: value.slice(6) }
        : value === 'custom' ? { workspace: input ? input.value : '' } : { workspace: '' };
    };
    const showPreview = () => {
      const node = modal.dialog.querySelector('[data-a2a-reception-preview]');
      if (node) node.textContent = expectedPreview
        ? `${tr('a2a.reception.workspace_resolved', '本次接待目录')} ${expectedPreview.root}` : '';
    };
    const showFeedback = code => {
      feedbackCode = code || '';
      modal.setFeedback(code ? receptionErrorText(code) : '');
    };
    const updateSubmit = () => {
      const submit = modal.dialog.querySelector('[data-ui-form-submit]');
      if (submit) submit.disabled = submitting || !expectedPreview;
    };
    const refreshPreview = async () => {
      const generation = ++previewGeneration;
      const picked = selection();
      const key = JSON.stringify(picked);
      expectedPreview = null;
      previewSelection = '';
      showPreview();
      updateSubmit();
      showFeedback('');
      // Empty custom is invalid; it must never silently request the default.
      if (picked.workspace !== undefined && modal.dialog.querySelector('[data-a2a-reception-input="space"]')?.value === 'custom'
        && !String(picked.workspace).trim()) {
        showFeedback('workspace is not a directory');
        return;
      }
      try {
        const result = await bridge.invoke('a2a.reception.preview', { conversationId: message.conversationId, ...picked });
        if (closed || generation !== previewGeneration) return;
        if (result?.preview?.root && result.preview.snapshot) {
          expectedPreview = result.preview;
          previewSelection = key;
        } else showFeedback(String(result?.error || 'workspace is not a directory'));
      } catch (_) {
        if (!closed && generation === previewGeneration) showFeedback('workspace is not a directory');
      }
      if (!closed && generation === previewGeneration) { showPreview(); updateSubmit(); }
    };
    const modal = root.uiFormModal({
      title: tr('a2a.reception.modal_title', '确认接待'),
      closeLabel: tr('a2a.reception.cancel', '取消'),
      submitLabel: tr('a2a.reception.submit', '开始接待'),
      busyLabel: tr('a2a.reception.busy', '正在开始…'),
      cancelLabel: tr('a2a.reception.cancel', '取消'),
      bodyHtml: typeof root.uiForm === 'function'
        ? root.uiForm({
          ariaLabel: tr('a2a.reception.modal_title', '确认接待'),
          fields: [
            { html: assistantField({ value: message.defaultAgentId || '', options: agentOptions }) },
            { html: workspaceField({ value: space.value, options: space.options, custom: space.value === 'custom', path: space.path, preview: message.workspacePreview }) },
          ],
        })
        : workspaceField({ value: message.defaultWorkspace || '', preview: message.workspacePreview }),
      onSubmit: async () => {
        if (submitting || closed) return;
        const picked = selection();
        if (!expectedPreview || previewSelection !== JSON.stringify(picked)) {
          await refreshPreview();
          return;
        }
        submitting = true;
        ++previewGeneration;
        modal.setBusy(true);
        try {
          const agentInput = modal.dialog.querySelector('[data-a2a-reception-input="assistant"]');
          const result = await bridge.invoke('a2a.reception.confirm', {
            conversationId: message.conversationId,
            expectedMessageId: message.messageId,
            ...picked,
            expectedPreview,
            assistantAgentId: agentInput ? agentInput.value : '',
          });
          if (closed) return;
          if (!result || result.confirmed !== true) {
            const code = String((result && result.error) || '');
            submitting = false;
            modal.setBusy(false);
            if (code === 'workspace_preview_changed' && result.preview?.root && result.preview.snapshot) {
              expectedPreview = result.preview;
              previewSelection = JSON.stringify(picked);
              showPreview();
            } else if (code === 'workspace is not a directory' || code === 'space not found' || code === 'workspace grant is unavailable') {
              expectedPreview = null;
              showPreview();
            }
            showFeedback(code);
            updateSubmit();
            // 会话已经不在（清场/被删）、暂存已过期、pending 绑定已被清理，或这次
            // 来访已被新问题替换：这一行没有再确认的价值，收掉并提示一次——过期/
            // 旧问题的正文与「确认接待」都不能继续留在屏幕上，也不能让用户以为
            // 已经确认。
            if (RECEPTION_GONE.includes(code) || code === PENDING_GONE
              || code === 'reception_expired' || code === 'reception_stale_pending') {
              modal.close(code === 'reception_expired' ? 'expired'
                : code === 'reception_stale_pending' ? 'stale' : 'gone');
              dropConversation(message.conversationId);
              if (typeof root.uiToast === 'function') root.uiToast(receptionErrorText(code), { variant: 'warning' });
              // 旧行被 Q2 替换 / pending 已被清理时，主进程投影里可能仍有一条真正
              // 待确认的来访：从投影补回来，提示里的「刷新」才有可点的行。
              if (code === 'reception_stale_pending' || code === PENDING_GONE) void hydratePending(bridge);
            }
            return;
          }
          setState(messageId, result.started === false ? 'waiting' : 'answering');
          modal.close(result);
          // 确认后直接落到这条会话：回答会出现在那里的气泡里，不用再去侧栏找。
          try {
            if (typeof root.setView === 'function') root.setView('conversation', message.conversationId);
          } catch (_) { /* 视图切换失败不影响接待 */ }
        } catch (_) {
          if (closed) return;
          submitting = false;
          modal.setBusy(false);
          showFeedback('');
          modal.setFeedback(tr('a2a.reception.confirm_failed', '没能开始接待，请重试。'));
          updateSubmit();
        }
      },
    });
    // Shared modal owns cancellation/focus/Escape. Closing performs no Main write.
    const localize = () => {
      const agentInput = modal.dialog.querySelector('[data-a2a-reception-input="assistant"]');
      const workspaceInput = modal.dialog.querySelector('[data-a2a-reception-input="workspace"]');
      const spaceInput = modal.dialog.querySelector('[data-a2a-reception-input="space"]');
      const fields = [assistantField({ value: agentInput?.value || '', options: agentOptions.map(option => ({ ...option,
        label: option.value === '' ? tr('a2a.reception.assistant_default', 'CogSeed 助理（默认）') : option.label })) }),
        workspaceField({ value: spaceInput?.value || '', options: space.options.map(option => ({ ...option,
          label: option.value === '' ? tr('a2a.reception.workspace_default', '默认工作区')
            : option.value === 'custom' ? tr('a2a.reception.workspace_custom', '自定义目录…') : option.label })),
          custom: spaceInput?.value === 'custom', path: workspaceInput?.value || '' })];
      modal.update({ title: tr('a2a.reception.modal_title', '确认接待'), closeLabel: tr('a2a.reception.cancel', '取消'),
        submitLabel: tr('a2a.reception.submit', '开始接待'), busyLabel: tr('a2a.reception.busy', '正在开始…'),
        cancelLabel: tr('a2a.reception.cancel', '取消'),
        bodyHtml: root.uiForm({ ariaLabel: tr('a2a.reception.modal_title', '确认接待'), fields: fields.map(html => ({ html })) }) });
      bindScope();
      showPreview();
      showFeedback(feedbackCode);
      updateSubmit();
    };
    const bindScope = () => {
      const spaceSelect = modal.dialog.querySelector('[data-a2a-reception-input="space"]');
      const customRow = modal.dialog.querySelector('.a2a-reception-custom');
      spaceSelect?.addEventListener('change', () => {
        if (customRow) customRow.hidden = spaceSelect.value !== 'custom';
        void refreshPreview();
      });
      modal.dialog.querySelector('[data-a2a-reception-input="workspace"]')?.addEventListener('input', () => { void refreshPreview(); });
      modal.dialog.querySelectorAll('[data-a2a-reception-pick]').forEach(node => {
        node.addEventListener('click', async () => {
          const picked = await bridge.invoke('common.pickDirectory', {});
          if (closed || submitting) return;
          const input = modal.dialog.querySelector('[data-a2a-reception-input="workspace"]');
          if (picked && !picked.cancelled && picked.path && input) { input.value = picked.path; void refreshPreview(); }
        });
      });
    };
    if (typeof modal.then === 'function') modal.then(() => {
      closed = true;
      ++previewGeneration;
      root.removeEventListener('i18n-change', localize);
    });
    root.addEventListener('i18n-change', localize);
    bindScope();
    void refreshPreview();
  }

  /** 拒绝这次来访：会话记为 refused，不给对端发任何话（拒绝本身就是不回答）。 */
  async function declineReception(messageId) {
    const bridge = api();
    const message = find(messageId);
    if (!bridge || !message) return;
    try {
      const res = await bridge.invoke('a2a.reception.decline', {
        conversationId: message.conversationId,
        expectedMessageId: message.messageId,
      });
      if (res && res.declined === false) {
        const code = String(res.error || '');
        // 过期/被替换/已清场：这一行不能再用，收掉并说明原因；被新问题替换时从
        // 投影补回真正的当前 pending，用户不会误以为已经拒绝成功。
        if (RECEPTION_GONE.includes(code)
          || code === 'reception_expired' || code === 'reception_stale_pending') {
          dropConversation(message.conversationId);
          if (typeof root.uiToast === 'function') root.uiToast(receptionErrorText(code), { variant: 'warning' });
          if (code === 'reception_stale_pending') void hydratePending(bridge);
          return;
        }
      }
    } catch (_) { /* 取消失败仍然把这一行收起 */ }
    drop(messageId);
  }

  /** 主进程推送：问题、跨方消息、接待结果都从这里进来。 */
  function onRelayEvent(event) {
    if (!event) return;
    // 接待结果只带 messageId（结果产生时那条消息可能已经不在条上了）。
    if (event.type === 'reception-result') {
      if (event.messageId) setState(event.messageId, event.status === 'answered' ? 'answered' : 'failed');
      return;
    }
    if (!event.message) return;
    const message = event.message;
    if (event.type === 'question') {
      const extra = {
        ...(event.defaultWorkspace ? { defaultWorkspace: event.defaultWorkspace } : {}),
        ...(event.defaultAgentId ? { defaultAgentId: event.defaultAgentId } : {}),
        // D4 预览：主进程只读解析出的默认接待根，确认前展示给本人。
        ...(event.workspacePreview ? { workspacePreview: event.workspacePreview } : {}),
        // 原始时间锚点：主进程投影/推送带 receivedAt 时以它为准，否则由
        // withReceivedAt 回落消息时间；TTL 从它起算，不随重绘续期。
        ...(event.receivedAt ? { receivedAt: String(event.receivedAt) } : {}),
      };
      upsert(message, event.awaitingConfirmation ? 'waiting' : 'answering', extra);
      return;
    }
    if (event.type === 'message') {
      // 对方的回答没有「等谁确认」这一步，直接按已处理收：否则这类条目既不参与
      // 已读（进会话收掉），也不会过期，会在卡片里越堆越多。
      upsert(message, 'answered');
      return;
    }
    if (event.type === 'ignored') {
      // 不是联系人 / 已结束：不给入口，也不留在条上。
      upsert(message, 'ignored');
    }
  }

  function start() {
    if (unsubscribe) return;
    const bridge = api();
    if (!bridge || typeof bridge.onPushEvent !== 'function') return;
    try {
      unsubscribe = bridge.onPushEvent('a2a:relay', (event) => {
        try { onRelayEvent(event); } catch (_) { /* 单条事件失败不影响收件箱 */ }
      });
    } catch (_) { /* 通道未放行 */ }
    try {
      root.addEventListener('cogseed:view-changed', (event) => {
        const detail = (event && event.detail) || {};
        // 广播早于 boot 里 currentCid 的赋值，所以这里记下来，render 用它判断
        // 「这条消息是不是已经在当前会话里显示过了」。
        viewCid = detail.view === 'conversation' && detail.cid ? String(detail.cid) : '';
        render();
      });
    } catch (_) { /* 无 DOM 事件能力 */ }
    void hydratePending(bridge);
  }

  /** 收件箱只活在内存里，重启就空；主进程按会话 marker + 记录重建待确认来访，
   *  否则重启后「等待你确认」的来访没有任何可点的确认入口。
   *
   *  行身份必须是主进程投影里的真实 `messageId`：确认/拒绝带着它回主进程做绑定
   *  校验，合成 id（如 `pending:<cid>`）会让「用户看到的那条」与「实际确认的那条」
   *  脱钩，Q1→Q2 重开后就会确认错对象。缺 messageId 的投影无法安全操作，跳过。 */
  async function hydratePending(bridge) {
    if (!bridge || typeof bridge.invoke !== 'function') return;
    let result = null;
    try { result = await bridge.invoke('a2a.reception.pending', {}); } catch (_) { return; }
    // 投影读回来之前内存里可能已经有过期行；先剪除，避免刷新把旧行又刷出来。
    let changed = pruneExpired();
    const rows = Array.isArray(result && result.pending) ? result.pending : [];
    for (const row of rows) {
      const cid = String(row.conversationId || '');
      const messageId = String(row.messageId || '');
      if (!cid || !messageId) continue;
      // 只跳过「已经有一条等待确认」的会话；同会话的已回答行不该挡住 Q2 的补投影。
      if (messages.some((item) => item.conversationId === cid && item.relayState === 'waiting')) continue;
      const receivedAt = String(row.receivedAt || '');
      const candidate = withReceivedAt({
        messageId,
        conversationId: cid,
        fromAccount: String(row.fromAccount || ''),
        kind: 'question',
        text: String(row.text || ''),
        workspacePreview: String(row.workspacePreview || ''),
        defaultWorkspace: String(row.defaultWorkspace || ''),
        defaultAgentId: String(row.defaultAgentId || ''),
        fromName: String(row.fromName || row.peerName || ''),
        relayState: 'waiting',
        ...(receivedAt ? { receivedAt } : {}),
        createdAt: receivedAt || new Date().toISOString(),
      });
      // 主进程投影已按 TTL 过滤；这里再按同一时间事实 fail closed，防止旧响应
      // 在重新确认窗口里把过期行补回界面。
      if (isWaitingExpired(candidate)) continue;
      messages = messages.concat([candidate]);
      changed = true;
    }
    if (changed) render();
  }

  function stop() {
    clearExpiryTimers();
    if (typeof unsubscribe === 'function') unsubscribe();
    unsubscribe = null;
  }

  root.a2aRelayInbox = {
    start,
    stop,
    clear: () => { messages = []; clearExpiryTimers(); render(); },
    // 测试缝：推送一条主进程事件（真实环境只来自 `a2a:relay`）。
    _push: (event) => onRelayEvent(event),
    // 测试缝：只读地看当前状态，不暴露可变引用。
    _state: () => messages.map((row) => ({ messageId: row.messageId, relayState: row.relayState })),
    // 测试缝：观察内存计时器是否随行/停止被正确清理。
    _timerCount: () => expiryTimers.size,
  };
})();
