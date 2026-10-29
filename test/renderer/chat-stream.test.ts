// ─── chat-stream 渲染模块测试（stub 全局 DOM + 动态 import） ───────────────
//
// 验证过程活动流（无边框行内时间线）的事件驱动行为：
// 1. turn.started 建活动流（挂消息内部）；同 turn 幂等；运行行含停止；
// 2. 动作行动词映射（读取/运行/MCP…）；text 段与动作行交错；
// 3. 思考行合并连续片段、收行结算时长；
// 4. turn.completed：运行行撤除、纯文字回合连流壳一起撤、失败保留结论行；
// 5. 历史重建幂等、动作行全可见；
// 6. 垃圾事件不抛错（宽容）。
//
// classic script 无 export，通过 stub window/document 全局后动态 import，
// 模块副作用把 chatStreamHandleEvent/chatStreamReset 挂到 window 上。

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface StubEl {
  tagName: string;
  className: string;
  dataset: Record<string, string>;
  innerHTML: string;
  style: Record<string, string>;
  children: StubEl[];
  parentNode: StubEl | null;
  connected: boolean;
  handlers: Record<string, () => void>;
  attrs: Record<string, string>;
  readonly isConnected: boolean;
  textContent: string;
  appendChild(el: StubEl): StubEl;
  insertBefore(node: StubEl, before: StubEl): StubEl;
  querySelector(sel: string): StubEl | null;
  closest(sel: string): StubEl | null;
  remove(): void;
  addEventListener(type: string, fn: () => void): void;
  setAttribute(name: string, value: string): void;
}

function makeEl(tag: string): StubEl {
  const el: StubEl = {
    tagName: tag,
    className: '',
    dataset: {},
    innerHTML: '',
    style: {},
    textContent: '',
    children: [],
    parentNode: null,
    connected: true,
    handlers: {},
    attrs: {},
    get isConnected() { return el.connected; },
  get classList() {
    return {
      add(cls: string) { if (!(` ${el.className} `).includes(` ${cls} `)) el.className = `${el.className} ${cls}`.trim(); },
      remove(cls: string) { el.className = (` ${el.className} `).replace(` ${cls} `, ' ').trim(); },
      contains(cls: string) { return (` ${el.className} `).includes(` ${cls} `); },
      toggle(cls: string, force?: boolean) {
        const has = (` ${el.className} `).includes(` ${cls} `);
        const target = force === undefined ? !has : force;
        if (target && !has) this.add(cls);
        if (!target && has) this.remove(cls);
      },
    };
  },
  // 仅支持类选择器（'.cs-flow'）：沿 parentNode 链找最近的匹配祖先。
  closest(sel: string): StubEl | null {
    const cls = sel.startsWith('.') ? sel.slice(1) : sel;
    let node: StubEl | null = el;
    while (node) {
      if ((` ${node.className} `).includes(` ${cls} `)) return node;
      node = node.parentNode;
    }
    return null;
  },
  querySelectorAll(sel: string): StubEl[] {
    const byTag = sel.match(/^(button|input)$/);
    const byClass = sel.match(/^\.([\w-]+)$/);
    const out: StubEl[] = [];
    const walk = (node: StubEl) => {
      for (const child of node.children) {
        if (byTag && child.tagName.toLowerCase() === byTag[1]) out.push(child);
        else if (byClass && (` ${child.className} `).includes(` ${byClass[1]} `)) out.push(child);
        walk(child);
      }
    };
    walk(el);
    return out;
  },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    addEventListener(type: string, fn: () => void) {
      // 记录首个 handler：徽章点击等交互可在测试里手动触发。
      if (!el.handlers) el.handlers = {};
      if (!el.handlers[type]) el.handlers[type] = fn;
    },
    setAttribute(name: string, value: string) {
      if (!el.attrs) el.attrs = {};
      el.attrs[name] = value;
    },
    getAttribute(name: string) {
      return (el.attrs && el.attrs[name] != null) ? el.attrs[name] : null;
    },
    appendChild(child) {
      // DOM 语义：已在树中的节点先摘除再插入（防重复）。
      if (child.parentNode && Array.isArray(child.parentNode.children)) {
        const oi = child.parentNode.children.indexOf(child);
        if (oi >= 0) child.parentNode.children.splice(oi, 1);
      }
      el.children.push(child); child.parentNode = el; return child;
    },
    insertBefore(node, before) {
      // 经 bind(target) 转发时必须落在 target 上（闭包 el 只作默认宿主）。
      const host: StubEl = this && Array.isArray((this as StubEl).children) ? this as StubEl : el;
      // DOM 语义：已在树中的节点先摘除再插入（移动，不重复）。
      if (node.parentNode && Array.isArray(node.parentNode.children)) {
        const oi = node.parentNode.children.indexOf(node);
        if (oi >= 0) node.parentNode.children.splice(oi, 1);
      }
      const idx = host.children.indexOf(before);
      host.children.splice(idx < 0 ? host.children.length : idx, 0, node);
      node.parentNode = host;
      return node;
    },
    querySelector(sel) {
      const byClass = sel.match(/^\.([\w-]+)$/);
      const byDataItem = sel.match(/^\[data-cs-item="([^"]+)"\]$/);
      const byDataInteraction = sel.match(/^\[data-cs-interaction="([^"]+)"\]$/);
      const walk = (node: StubEl): StubEl | null => {
        for (const child of node.children) {
          if (byClass && (` ${child.className} `).includes(` ${byClass[1]} `)) return child;
          if (byDataItem && child.dataset.csItem === byDataItem[1]) return child;
          if (byDataInteraction && child.dataset.csInteraction === byDataInteraction[1]) return child;
          const nested = walk(child);
          if (nested) return nested;
        }
        return null;
      };
      return walk(el);
    },
    contains(node) {
      // DOM contains 语义（含自身）：prewarm 迁移判定依赖它。
      if (node === el) return true;
      const walk = (n: StubEl): boolean => {
        for (const child of n.children) {
          if (child === node || walk(child)) return true;
        }
        return false;
      };
      return walk(el);
    },
    remove() {
      el.connected = false;
      if (el.parentNode && Array.isArray(el.parentNode.children)) {
        const i = el.parentNode.children.indexOf(el);
        if (i >= 0) el.parentNode.children.splice(i, 1);
      }
    },
  };
  return el;
}

describe('chat-stream module', () => {
  let anchor: StubEl;
  let root: StubEl;
  let inserts: { node: StubEl; before: StubEl }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;

  const handle = (ev: unknown) => g.window.chatStreamHandleEvent('c-1', anchor, ev);
  const bodyOf = (flow: StubEl) => flow.querySelector('.cs-flow-body')!;

  beforeEach(async () => {
    vi.resetModules();
    anchor = makeEl('div');
    root = makeEl('div');
    root.appendChild(anchor);
    inserts = [];
    const realInsert = anchor.insertBefore.bind(anchor.parentNode as StubEl);
    // 活动流挂载走 anchor.insertBefore(flow, anchor)（anchor.parentNode 宿主）。
    (anchor.parentNode as StubEl).insertBefore = (node, before) => {
      inserts.push({ node, before });
      return realInsert(node, before);
    };
    // 活动流现挂在消息（anchor）内部：监听 anchor 的 append/insert 供断言。
    const realAppendA = anchor.appendChild.bind(anchor);
    anchor.appendChild = (node) => {
      inserts.push({ node, before: null });
      return realAppendA(node);
    };
    const realInsertA = anchor.insertBefore.bind(anchor);
    anchor.insertBefore = (node, before) => {
      inserts.push({ node, before });
      return realInsertA(node, before);
    };
    g.window = g; // classic script 通过 window.* 挂载
    g.document = { createElement: (tag: string) => makeEl(tag) };
    g.CSS = { escape: (v: string) => v };
    // 计时器 stub：渲染模块的「工作中」计时行不真起 interval（防悬挂）。
    g.setInterval = () => 0;
    g.clearInterval = () => {};
    g.createLogger = () => ({ info() {}, warn(...a: unknown[]) { console.warn('[chat-stream]', ...a); }, error() {} });
    await import('../../src/renderer/modules/chat-stream.js');
  });

  it('turn.started 在消息内部建活动流（正文区之前），同 turn 幂等，消息头挂计时徽章', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'commander', startedAt: '' });
    expect(inserts).toHaveLength(1);
    // 活动流是消息（anchor）的子元素——cogseed 图标下、正文上。
    expect(inserts[0].node.parentNode).toBe(anchor);

    handle({ type: 'chat.item', turnId: 'T1', itemId: 'i1', kind: 'reasoning', status: 'completed', payload: { text: 'x' } });
    expect(inserts).toHaveLength(1);
    const flow = inserts[0].node;
    expect(flow.className).toContain('cs-flow');
    expect(flow.className).toContain('running');
    // 计时/收起徽章（消息头不存在时落流内首行兜底）：工作中 + 计时。
    // 就近停止按钮已移除（无实际作用，2026-09-08）。
    const badge = flow.querySelector('.cs-badge')!;
    expect(badge).toBeTruthy();
    expect(badge.querySelector('.cs-badge-label')!.textContent).toBe('工作中');
    expect(badge.querySelector('.cs-badge-elapsed')).toBeTruthy();
    expect(flow.querySelector('.cs-badge-stop')).toBeNull();
  });

  it('运行态徽章持续显示工具计数，模型重试与恢复输出更新可见状态', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } });
    const flow = inserts[0].node;
    const badge = flow.querySelector('.cs-badge')!;
    expect(badge.querySelector('.cs-badge-label')!.textContent).toBe('工具执行中');
    expect(badge.querySelector('.cs-badge-tools')!.textContent).toBe('1 次工具调用');
    expect(badge.querySelector('.cs-badge-elapsed')).toBeTruthy();

    g.window.chatStreamSetRuntimeStatus('c-1', anchor, { type: 'retry', attempt: 2 });
    expect(badge.querySelector('.cs-badge-label')!.textContent).toBe('模型连接中断，正在重试（第 2 次）');

    handle({ type: 'chat.item', turnId: 'T1', itemId: 'text1', kind: 'text', status: 'inProgress', payload: { delta: '继续' } });
    expect(badge.querySelector('.cs-badge-label')!.textContent).toBe('继续生成中');
  });

  it('徽章点击：紧凑 → 展开 → 收起（运行中默认只留正文）', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } });
    const badge = flow.querySelector('.cs-badge')!;
    const body = bodyOf(flow);
    // 运行中默认紧凑：过程行由 class 收起，正文区本身仍可见（运行中的回答
    // 是直接流进 body 的，整块隐藏会把它一起藏掉）。
    expect(flow.dataset.csCompact).toBe('1');
    expect(flow.className).toContain('cs-compact');
    expect(body.style.display).not.toBe('none');
    expect(badge.getAttribute('aria-expanded')).toBe('false');
    // 点一次 → 展开过程行。
    (badge.handlers.click!)();
    expect(flow.dataset.csCompact).toBe('0');
    expect(flow.className).not.toContain('cs-compact');
    expect(badge.getAttribute('aria-expanded')).toBe('true');
    // 再点 → 整块收起。
    (badge.handlers.click!)();
    expect(body.style.display).toBe('none');
    expect(flow.dataset.csCollapsed).toBe('1');
    expect(badge.getAttribute('aria-expanded')).toBe('false');
    // 收起态优先恢复整块，而不是回到紧凑。
    (badge.handlers.click!)();
    expect(body.style.display).not.toBe('none');
    expect(flow.dataset.csCollapsed).toBe('0');
    expect(flow.dataset.csCompact).toBe('0');
  });

  it('运行中紧凑态只收过程行：正文段与审批卡不进 cs-compact 隐藏范围（COGSEED-497）', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'r1', kind: 'reasoning', status: 'inProgress', payload: { delta: '先看看仓库结构' } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'x1', kind: 'text', status: 'inProgress', payload: { delta: '正在整理结论：' } });
    const body = bodyOf(flow);
    const rows = body.children.filter((c) => String(c.className).split(' ').includes('cs-row'));
    const text = body.children.filter((c) => String(c.className).includes('cs-text'));
    // 过程行（思考/工具）是 CSS 的隐藏对象；正文段不在隐藏范围里。
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(text.length).toBe(1);
    expect(String(text[0].className)).not.toContain('cs-row');
    // 交互卡同样保留：审批/提问不能被紧凑态困住。
    g.window.chatStreamBridgeBashPermission!({ request_id: 'bp-497', cid: 'c-1', command: 'ls' });
    const card = flow.querySelector('[data-cs-interaction="bp-497"]')!;
    expect(card.className).toContain('cs-card');
    expect(card.className).not.toContain('cs-row');
    // 样式钩子改名即失效：class 名是 chat-stream.css 的选择器契约。
    expect(flow.className).toContain('cs-compact');
  });

  it('失败/取消终态放开紧凑态：过程行要能看出是哪一步挂的（COGSEED-497）', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } });
    expect(flow.dataset.csCompact).toBe('1');
    handle({ type: 'chat.turn.completed', turnId: 'T1', status: 'failed', error: 'boom', endedAt: '' });
    expect(flow.dataset.csCompact).toBe('0');
    expect(bodyOf(flow).style.display).not.toBe('none');
    expect(flow.querySelector('.cs-badge-label')!.textContent).toContain('失败');
  });

  it('消息带 chat-msg-header 时徽章挂头部主路径（不在流内）', () => {
    // 真机流式占位消息结构：msg > .chat-msg-header + .chat-bubble。
    const headerMsg = makeEl('div');
    const header = makeEl('div');
    header.className = 'chat-msg-header';
    const bubble = makeEl('div');
    bubble.className = 'chat-bubble';
    headerMsg.appendChild(header);
    headerMsg.appendChild(bubble);
    root.appendChild(headerMsg);

    g.window.chatStreamHandleEvent('c-1', headerMsg, { type: 'chat.turn.started', turnId: 'H1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = headerMsg.children.find((c) => String(c.className).includes('cs-flow'))!;
    expect(flow).toBeTruthy();
    // 徽章在头部（不在流子树里），且不再走流内兜底行；停止按钮已移除。
    const badge = header.querySelector('.cs-badge')!;
    expect(badge).toBeTruthy();
    expect(header.querySelector('.cs-badge-stop')).toBeNull();
    expect(flow.querySelector('.cs-badge')).toBeNull();
    expect(flow.querySelector('.cs-badge-row')).toBeNull();
    // 头部徽章点击同样能展开/收起流的正文（运行中默认紧凑 → 展开 → 收起）。
    (badge.handlers.click!)();
    expect(flow.querySelector('.cs-flow-body')!.style.display).not.toBe('none');
    expect(flow.dataset.csCompact).toBe('0');
    (badge.handlers.click!)();
    expect(flow.querySelector('.cs-flow-body')!.style.display).toBe('none');
    // 流移除时头部徽章一并清理。
    g.window.chatStreamReset();
    expect(badge.connected).toBe(false);
    expect(header.querySelector('.cs-badge')).toBeNull();
  });

  it('收起状态下审批/提问卡到达时自动展开（含 bash 审批镜像）', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } });
    const badge = flow.querySelector('.cs-badge')!;
    // 紧凑 → 展开 → 收起，先造出「收起」的真实前置状态。
    (badge.handlers.click!)();
    (badge.handlers.click!)();
    expect(flow.querySelector('.cs-flow-body')!.style.display).toBe('none');

    // chat.interaction 到达 → 自动展开。
    handle({ type: 'chat.interaction.requested', turnId: 'T1', interactionId: 'ix-9', kind: 'question', prompt: '用哪个？', timeoutMs: 30000 });
    expect(flow.querySelector('.cs-flow-body')!.style.display).not.toBe('none');
    expect(flow.dataset.csCollapsed).toBe('0');

    // 再次收起后 bash 审批镜像到达 → 同样自动展开。
    (badge.handlers.click!)();
    const bridge = g.window.chatStreamBridgeBashPermission as (i: unknown) => void;
    bridge({ request_id: 'bp-9', cid: 'c-1', command: 'rm -rf x' });
    expect(flow.querySelector('.cs-flow-body')!.style.display).not.toBe('none');
  });

  it('bash 审批卡摘要单行截断，完整命令留在 detail 块（COGSEED-486）', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    // 长 URL + 连续长串：正是把卡片 min-content 顶出对话区的形态。
    const longCmd = `curl -sSL "https://api.github.com/repos/bonc-ai/cogseed/releases?x=${'a'.repeat(180)}"`;
    const bridge = g.window.chatStreamBridgeBashPermission as (i: unknown) => void;
    bridge({ request_id: 'bp-486', cid: 'c-1', agent_name: 'Commander', command: longCmd });

    const card = flow.querySelector('[data-cs-interaction="bp-486"]')!;
    // approval 类名是 CSS 单行截断的作用域，别名变了视觉修复就失效。
    expect(card.className).toContain('approval');
    const prompt = card.querySelector('.cs-interaction-prompt')!;
    expect(prompt.textContent).toContain('Commander 请求：');
    // 摘要受限且省略号收尾，不把全文塞进摘要行。
    expect(prompt.textContent.length).toBeLessThan(longCmd.length);
    expect(prompt.textContent.endsWith('…')).toBe(true);
    expect(prompt.textContent).not.toContain(longCmd);
    // 全文仍完整保留在 detail 块（可滚动查看），截断不丢信息。
    expect(card.querySelector('.cs-interaction-detail')!.textContent).toBe(longCmd);
  });

  it('bash 审批卡风险码走 i18n 映射，未命中退回原始码（COGSEED-486）', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    g.t = (key: string) => (key === 'bash.permission.reason.network_egress' ? '向网络发送数据' : key);
    try {
      const bridge = g.window.chatStreamBridgeBashPermission as (i: unknown) => void;
      bridge({ request_id: 'bp-risk', cid: 'c-1', command: 'curl https://x', reasons: ['network_egress', 'unmapped_code'] });
    } finally {
      delete g.t;
    }
    const reasons = flow.querySelector('[data-cs-interaction="bp-risk"]')!
      .querySelector('.cs-interaction-reasons')!;
    // 已映射的码显示中文短语；没有翻译的码保留原始值，不能吞掉风险信息。
    expect(reasons.textContent).toBe('风险：向网络发送数据、unmapped_code');
  });

  it('失败徽章 title 携带完整错误（悬停兜底），初始 aria/title 齐全', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    const badge = flow.querySelector('.cs-badge')!;
    // 运行中默认紧凑：徽章读作「展开过程」（点一次才轮到展开/收起）。
    expect(badge.getAttribute('aria-label')).toBe('展开过程');
    expect(badge.getAttribute('title')).toBe('收起/展开过程');
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'f1', kind: 'toolExecution', status: 'failed', payload: { toolName: 'bash', argsSummary: 'ls', error: 'boom' } });
    handle({ type: 'chat.turn.completed', turnId: 'T1', status: 'failed', error: 'fetch failed: timeout after 75001ms', endedAt: '' });
    expect(badge.getAttribute('title')).toContain('fetch failed: timeout after 75001ms');
  });

  it('toolExecution 动词映射：bash→运行+命令、read_file→读取+文件名/目录、未知工具显原名', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'inProgress', payload: { toolName: 'bash', argsSummary: '{"command":"ls -la"}' } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't2', kind: 'toolExecution', status: 'completed', payload: { toolName: 'read_file', argsSummary: '{"path":"/Users/an/opensource/cogseed/src/app.ts"}' } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't3', kind: 'toolExecution', status: 'completed', payload: { toolName: 'my_tool', argsSummary: '{"x":1}' } });

    const body = bodyOf(flow);
    const bash = body.children.find((c) => c.dataset.csItem === 't1')!;
    expect(bash.innerHTML).toContain('运行');
    expect(bash.innerHTML).toContain('ls -la');
    const read = body.children.find((c) => c.dataset.csItem === 't2')!;
    expect(read.innerHTML).toContain('读取');
    expect(read.innerHTML).toContain('app.ts');
    expect(read.innerHTML).toContain('/Users/an/opensource/cogseed/src');
    const unknown = body.children.find((c) => c.dataset.csItem === 't3')!;
    expect(unknown.innerHTML).toContain('my_tool');
  });

  it('思考行合并连续片段，非思考 item 到达时收行并结算时长', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'r1', kind: 'reasoning', status: 'completed', payload: { text: '先想' } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'r2', kind: 'reasoning', status: 'completed', payload: { text: '一下' } });
    const body = bodyOf(flow);
    const thinks = body.children.filter((c) => String(c.className).includes('cs-row-think'));
    expect(thinks).toHaveLength(1);
    expect(thinks[0].dataset.csFull).toBe('先想一下');
    // DSH 形态：结构一次建好，标题/摘要/全文各就各位。
    expect(thinks[0].querySelector('.cs-verb')!.textContent).toBe('思考');
    expect(thinks[0].querySelector('.cs-think-live-text')!.textContent).toBe('先想一下');
    expect(thinks[0].querySelector('.cs-think-full')!.textContent).toBe('先想一下');

    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } });
    expect(thinks[0].dataset.csClosed).toBe('1');
    expect(String(thinks[0].querySelector('.cs-think-dur')!.textContent)).toContain('持续了');
  });

  it('思考实时流式（2026-09-11 需求变更）：inProgress 增量逐段落入但行默认折叠，completed 前缀去重不重复', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'r1', kind: 'reasoning', status: 'inProgress', payload: { delta: '正在' } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'r1', kind: 'reasoning', status: 'inProgress', payload: { delta: '读取文件…' } });
    const body = bodyOf(flow);
    let thinks = body.children.filter((c) => String(c.className).includes('cs-row-think'));
    expect(thinks).toHaveLength(1);
    // 进行中：增量聚合保留（点开可见全文），但行默认折叠——不自动 cs-open，
    // 进度由行内 cs-think-live 单行实时预览承担。
    expect(thinks[0].dataset.csFull).toBe('正在读取文件…');
    expect(String(thinks[0].className)).not.toContain('cs-open');
    // completed 整段（=已画前缀，无尾部差额）：不重复落入。
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'r1', kind: 'reasoning', status: 'completed', payload: { text: '正在读取文件…' } });
    thinks = body.children.filter((c) => String(c.className).includes('cs-row-think'));
    expect(thinks).toHaveLength(1);
    expect(thinks[0].dataset.csFull).toBe('正在读取文件…');
    // completed 带尾部差额（实时流只画到一半的补齐场景）：只补差额。
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'r2', kind: 'reasoning', status: 'completed', payload: { text: '正在读取文件…还有后续' } });
    expect(thinks[0].dataset.csFull).toBe('正在读取文件…还有后续');
  });

  it('思考内容常显单行预览、点击展开纯文本全文（2026-09-11 方案 C）', () => {
    handle({ type: 'chat.turn.started', turnId: 'T2', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    handle({ type: 'chat.item', turnId: 'T2', itemId: 'r1', kind: 'reasoning', status: 'inProgress', payload: { delta: '核对 131072 的来源与回退链路' } });
    const body = bodyOf(flow);
    let thinks = body.children.filter((c) => String(c.className).includes('cs-row-think'));
    expect(thinks).toHaveLength(1);
    // 运行中：单行预览在，且标了 streaming（CSS 据此加右端渐隐与扫光）。
    const live = thinks[0].querySelector('.cs-think-live')!;
    expect(live).toBeTruthy();
    expect(live.dataset.streaming).toBe('1');
    // 收行（后续工具行到来）：预览不再消失，全文块存在但默认收起。
    handle({ type: 'chat.item', turnId: 'T2', itemId: 't1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } });
    thinks = body.children.filter((c) => String(c.className).includes('cs-row-think'));
    expect(thinks[0].dataset.csClosed).toBe('1');
    // 回归锚点：收行后内容必须仍可见（071bd064 曾把这里清空为只剩时长）。
    expect(thinks[0].querySelector('.cs-think-live')).toBeTruthy();
    expect(thinks[0].querySelector('.cs-think-full')!.textContent).toBe('核对 131072 的来源与回退链路');
    // 收行后不再 streaming：渐隐/扫光停掉，摘要换成「首行」。
    expect(thinks[0].querySelector('.cs-think-live')!.dataset.streaming).toBeUndefined();
    expect(String(thinks[0].className)).not.toContain('cs-open');
    // 点击行 → 展开纯文本全文（fake DOM 用记录的 handler 触发）。
    (thinks[0].handlers.click!)();
    expect(String(thinks[0].className)).toContain('cs-open');
  });

  it('思考行是 DSH 式 disclosure：单行摘要 + 圆点 + 扫光层，键盘可开合（COGSEED-497 形态）', () => {
    handle({ type: 'chat.turn.started', turnId: 'TD', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    handle({ type: 'chat.item', turnId: 'TD', itemId: 'r1', kind: 'reasoning', status: 'inProgress', payload: { delta: '第一段：先核对需求\n\n第二段：再看实现' } });
    const think = bodyOf(flow).children.find((c) => String(c.className).includes('cs-row-think'))!;

    // 收起态只有一行：标题 + 用时 + 圆点 + 摘要，正文块默认不显示。
    const head = think.querySelector('.cs-think-head')!;
    expect(head).toBeTruthy();
    expect(head.getAttribute('role')).toBe('button');
    expect(head.getAttribute('tabindex')).toBe('0');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(think.querySelector('.cs-think-sep')).toBeTruthy();
    expect(think.querySelector('.cs-think-shimmer-sweep')).toBeTruthy();
    // 运行中摘要取最后一行（当前想到哪）；扫光层与摘要同文。
    expect(think.querySelector('.cs-think-live-text')!.textContent).toBe('第二段：再看实现');
    expect(think.querySelector('.cs-think-sweep-text')!.textContent).toBe('第二段：再看实现');
    // 紧凑态只留这一条：运行中的思考行带 data-cs-live，收行后摘掉。
    expect(think.dataset.csLive).toBe('1');
    // 键盘开合：Enter/Space 走同一条 disclosure 路径。
    const keydown = think.handlers.keydown as unknown as (e: { key: string; preventDefault(): void }) => void;
    keydown({ key: 'Enter', preventDefault() {} });
    expect(String(think.className)).toContain('cs-open');
    expect(head.getAttribute('aria-expanded')).toBe('true');
    keydown({ key: ' ', preventDefault() {} });
    expect(String(think.className)).not.toContain('cs-open');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    // 展开后在正文里拖选文字不该把行收起来（点击正文不算开关）。
    const click = think.handlers.click as unknown as (e: unknown) => void;
    click({ target: think.querySelector('.cs-think-full') });
    expect(String(think.className)).not.toContain('cs-open');
    click({ target: head });
    expect(String(think.className)).toContain('cs-open');
    // 收行：摘要换成首行（『这段在想什么』），不再 streaming。
    handle({ type: 'chat.item', turnId: 'TD', itemId: 't1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } });
    expect(think.querySelector('.cs-think-live-text')!.textContent).toBe('第一段：先核对需求');
    expect(think.querySelector('.cs-think-live')!.dataset.streaming).toBeUndefined();
    expect(think.dataset.csLive).toBeUndefined();
  });

  it('prewarm 发送即起计（2026-09-09）：面板与计时立即存在，真 turnId 首事件迁移接管', () => {
    const prewarm = g.window.chatStreamPrewarm as (c: string, m: unknown, t: number) => void;
    expect(typeof prewarm).toBe('function');
    prewarm('c-1', anchor, Date.now() - 2500);
    // 发送瞬间：pending 流已建（徽章+计时走秒），不等模型首事件。
    let flow = inserts[inserts.length - 1].node;
    expect(String(flow.className)).toContain('cs-flow');
    expect(flow.dataset.csPending).toBe('1');
    const badge = flow._csBadge as StubEl;
    const elapsed = badge && badge.querySelector('.cs-badge-elapsed');
    expect(elapsed && String(elapsed.textContent)).toContain('2 秒');
    // 首 turn.started（真 turnId）到达：pending 迁移接管为同一流，计时起点保留。
    handle({ type: 'chat.turn.started', turnId: 'real-1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow2 = g.window.chatStreamHasPanel('c-1');
    expect(flow2).toBe(true);
    const taken = inserts[inserts.length - 1].node;
    expect(taken).toBe(flow); // 同一流被复用（未新建）
    expect(flow.dataset.csPending).toBe('');
    expect(flow.dataset.csTurn).toBe('real-1');
    expect(Number(flow.dataset.csT0)).toBeLessThanOrEqual(Date.now() - 2500);
  });

  it('时间线接管正文：text 段交错、完成交回清空、思考行随之收行', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'i1', kind: 'text', status: 'inProgress', payload: { delta: '我先查一下：' } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'inProgress', payload: { toolName: 'bash', argsSummary: 'ls' } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', output: 'ok' } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'i1', kind: 'text', status: 'inProgress', payload: { delta: '查完了。' } });

    const flow = inserts[0].node;
    const body = bodyOf(flow);
    const segs = body.children.filter((c) => String(c.className).includes('cs-text'));
    // 文字与工具行交错：两段文字夹一个工具行。
    expect(segs).toHaveLength(2);
    expect(segs[0].textContent).toBe('我先查一下：');
    expect(segs[1].textContent).toBe('查完了。');
    // 中间段被工具行关闭（cs-closed），最终段保持开放。
    expect(segs[0].dataset.csClosed).toBe('1');
    expect(segs[1].dataset.csClosed).toBeUndefined();

    // turn.completed：交回只针对开放段（最终正文'查完了。'，交回在测试
    // 环境无 _streamingAppendFinalDelta/finalEl 落点，观测时间线侧）——
    // 已关闭的中间段保留在时间线按原时序展示，开放段移除。
    handle({ type: 'chat.turn.completed', turnId: 'T1', status: 'completed', endedAt: '' });
    const restSegs = flow.querySelectorAll('.cs-text');
    expect(restSegs).toHaveLength(1);
    expect(restSegs[0].textContent).toBe('我先查一下：');
    expect(flow.className).toContain('done');
    expect(flow.className).not.toContain('running');
    expect(flow.isConnected).toBe(true);
    // 完成后停止按钮撤除；徽章定格为「已完成」（收起开关保留）。
    expect(flow.querySelector('.cs-badge-stop')).toBeNull();
    expect(flow.querySelector('.cs-badge')!.querySelector('.cs-badge-label')!.textContent).toBe('已完成');

    // finalize 兜底：running 流（断流场景）被收尾为 cancelled。
    handle({ type: 'chat.turn.started', turnId: 'T2', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({ type: 'chat.item', turnId: 'T2', itemId: 'i2', kind: 'text', status: 'inProgress', payload: { delta: '做到一半' } });
    const fin = g.window.chatStreamFinalize as (c: string) => void;
    fin('c-1');
    const p2 = inserts[inserts.length - 1].node;
    expect(p2.className).toContain('cs-flow');
    expect(p2.className).toContain('cancelled');
    expect(p2.querySelectorAll('.cs-text')).toHaveLength(0);
  });

  it('纯文字回合完成时连流壳一起撤；失败保留结论行不丢失过程', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'i1', kind: 'text', status: 'inProgress', payload: { delta: '只是回答' } });
    const flow = inserts[0].node;
    handle({ type: 'chat.turn.completed', turnId: 'T1', status: 'completed', endedAt: '' });
    // 无动作行 → 空 shell 撤除，不留视觉残渣。
    expect(flow.isConnected).toBe(false);

    // 失败：徽章变红色结论行，过程行保留（排障信息）。
    handle({ type: 'chat.turn.started', turnId: 'T2', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({ type: 'chat.item', turnId: 'T2', itemId: 'f1', kind: 'toolExecution', status: 'failed', payload: { toolName: 'bash', argsSummary: 'ls', error: 'boom' } });
    handle({ type: 'chat.turn.completed', turnId: 'T2', status: 'failed', error: 'boom', endedAt: '' });
    const failed = inserts[inserts.length - 1].node;
    expect(failed.className).toContain('failed');
    const badge = failed.querySelector('.cs-badge')!;
    expect(badge.querySelector('.cs-badge-label')!.textContent).toContain('boom');
    expect(failed.querySelector('.cs-badge-stop')).toBeNull();
  });

  it('toolExecution 三相位更新同一行', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't9', kind: 'toolExecution', status: 'inProgress', payload: { toolName: 'bash', argsSummary: '{"command":"npm test"}' } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't9', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', output: 'done' } });

    const flow = inserts[0].node;
    const body = bodyOf(flow);
    const rows = body.children.filter((c) => c.dataset.csItem === 't9');
    expect(rows).toHaveLength(1);
    expect(rows[0].innerHTML).toContain('done');
  });

  it('end/progress 相位不丢 start 的参数（dataset 累积）；progress 的 message 保留为输出', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'inProgress', payload: { toolName: 'bash', argsSummary: '{"command":"npm run typecheck"}' } });
    // progress：无 argsSummary、带 message。
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'inProgress', payload: { toolName: 'bash', output: 'running…' } });
    // end：真机 tool_end 不带 arguments——参数必须还在。
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', output: 'ok' } });
    const row = bodyOf(flow).children.find((c) => c.dataset.csItem === 't1')!;
    expect(row.innerHTML).toContain('npm run typecheck');
    expect(row.innerHTML).toContain('ok');
  });

  it('截断 JSON 的 argsSummary 按字段扫描提取命令，不显示原始 JSON', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    const truncated = '{"command":"cd /tmp && echo \\"hello world\\" && ls -la","timeoutMs":5000';
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'inProgress', payload: { toolName: 'bash', argsSummary: truncated } });
    const row = bodyOf(flow).children.find((c) => c.dataset.csItem === 't1')!;
    expect(row.innerHTML).toContain('cd /tmp &amp;&amp; echo &quot;hello world&quot; &amp;&amp; ls -la');
    expect(row.innerHTML).not.toContain('&quot;command&quot;');
  });

  it('时间线接管正文：text 段交错、完成交回清空、思考行随之收行', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'i1', kind: 'text', status: 'inProgress', payload: { delta: '我先查一下：' } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'inProgress', payload: { toolName: 'bash', argsSummary: 'ls' } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', output: 'ok' } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'i1', kind: 'text', status: 'inProgress', payload: { delta: '查完了。' } });

    const flow = inserts[0].node;
    const body = bodyOf(flow);
    const segs = body.children.filter((c) => String(c.className).includes('cs-text'));
    // 文字与工具行交错：两段文字夹一个工具行。
    expect(segs).toHaveLength(2);
    expect(segs[0].textContent).toBe('我先查一下：');
    expect(segs[1].textContent).toBe('查完了。');
    // 中间段被工具行关闭（cs-closed），最终段保持开放。
    expect(segs[0].dataset.csClosed).toBe('1');
    expect(segs[1].dataset.csClosed).toBeUndefined();

    // turn.completed：交回只针对开放段（最终正文'查完了。'，交回在测试
    // 环境无 _streamingAppendFinalDelta/finalEl 落点，观测时间线侧）——
    // 已关闭的中间段保留在时间线按原时序展示，开放段移除。
    handle({ type: 'chat.turn.completed', turnId: 'T1', status: 'completed', endedAt: '' });
    const restSegs = flow.querySelectorAll('.cs-text');
    expect(restSegs).toHaveLength(1);
    expect(restSegs[0].textContent).toBe('我先查一下：');
    expect(flow.className).toContain('done');
    expect(flow.className).not.toContain('running');
    expect(flow.isConnected).toBe(true);
    // 完成后停止按钮撤除；徽章定格为「已完成」（收起开关保留）。
    expect(flow.querySelector('.cs-badge-stop')).toBeNull();
    expect(flow.querySelector('.cs-badge')!.querySelector('.cs-badge-label')!.textContent).toBe('已完成');

    // finalize 兜底：running 流（断流场景）被收尾为 cancelled。
    handle({ type: 'chat.turn.started', turnId: 'T2', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({ type: 'chat.item', turnId: 'T2', itemId: 'i2', kind: 'text', status: 'inProgress', payload: { delta: '做到一半' } });
    const fin = g.window.chatStreamFinalize as (c: string) => void;
    fin('c-1');
    const p2 = inserts[inserts.length - 1].node;
    expect(p2.className).toContain('cs-flow');
    expect(p2.className).toContain('cancelled');
    expect(p2.querySelectorAll('.cs-text')).toHaveLength(0);
  });

  it('投影器的工具后 \\n\\n 分隔 delta 不在时间线里产生空行段，聚合文本保留', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'i1', kind: 'text', status: 'inProgress', payload: { delta: '\n\n' } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'i1', kind: 'text', status: 'inProgress', payload: { delta: '正文第一段。' } });
    const flow = inserts[0].node;
    const body = bodyOf(flow);
    const segs = body.children.filter((c) => String(c.className).includes('cs-text'));
    expect(segs).toHaveLength(1);
    // 段首空白被剥掉（时间线显示）；段文本经 dataset.csSeg 聚合（收尾
    // 只交回开放段，不再做全文 csText 聚合）。
    expect(segs[0].textContent).toBe('正文第一段。');
    expect(segs[0].dataset.csSeg).toBe('正文第一段。');
    expect(flow.dataset.csText).toBeUndefined();
  });

  it('文字段 rAF 合帧：帧延迟时画的是帧内最新全文，不停在调度那一刻的旧快照（真机 09-12 中间叙述截断）', () => {
    // 真机事故：窗口被遮挡/后台节流时 rAF 不跑；一段叙述的全部增量在同一帧
    // 窗口内到达，帧恢复后只画出「第一个增量那一刻」的前缀（如「我先」），
    // 其余内容被 _csSegRaf 吞掉、再无重绘——中间叙述永久截断。
    const frames: Array<() => void> = [];
    g.requestAnimationFrame = (cb: () => void) => { frames.push(cb); return frames.length; };
    try {
      handle({ type: 'chat.turn.started', turnId: 'T-raf', cid: 'c-1', actorId: 'a', startedAt: '' });
      handle({ type: 'chat.item', turnId: 'T-raf', itemId: 'i1', kind: 'text', status: 'inProgress', payload: { delta: '我先' } });
      handle({ type: 'chat.item', turnId: 'T-raf', itemId: 'i1', kind: 'text', status: 'inProgress', payload: { delta: '实际探一下自己的运行时状态，再回答——不靠猜。' } });
      const flow = inserts[0].node;
      const seg = bodyOf(flow).children.filter((c) => String(c.className).includes('cs-text'))[0];
      // 同一帧窗口内后续增量不重复排队（合帧不变），但帧内必须读最新文本。
      expect(frames).toHaveLength(1);
      frames.splice(0).forEach((cb) => cb());
      expect(seg.textContent).toBe('我先实际探一下自己的运行时状态，再回答——不靠猜。');
      // 帧跑完后的新增量照常再排一帧并追上。
      handle({ type: 'chat.item', turnId: 'T-raf', itemId: 'i1', kind: 'text', status: 'inProgress', payload: { delta: '（补）' } });
      expect(frames).toHaveLength(1);
      frames.splice(0).forEach((cb) => cb());
      expect(seg.textContent).toBe('我先实际探一下自己的运行时状态，再回答——不靠猜。（补）');
    } finally {
      delete g.requestAnimationFrame;
    }
  });

  it('usage 行渲染并含上下文告警，diff 行渲染增删统计与着色行', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'u1', kind: 'usage', status: 'completed', payload: { inputTokens: 100, contextWindowRatio: 0.92 } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'd1', kind: 'fileChange', status: 'completed', payload: { filePath: '/a/b.ts', diff: '+added\n-removed\n ctx' } });
    const flow = inserts[0].node;
    const body = bodyOf(flow);
    const usage = body.children.find((c) => c.dataset.csItem === 'u1');
    expect(usage!.innerHTML).toContain('上下文接近上限');
    const diff = body.children.find((c) => c.dataset.csItem === 'd1');
    expect(diff!.innerHTML).toContain('编辑');
    expect(diff!.innerHTML).toContain('b.ts');
    expect(diff!.innerHTML).toContain('+1');
    expect(diff!.innerHTML).toContain('−1');
    expect(diff!.innerHTML).toContain('cs-diff-line add');
    expect(diff!.innerHTML).toContain('cs-diff-line del');
  });

  it('补收的内核工具也有中文动词：列目录/知识库/素材/对端/任务/能力', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    const item = (id: string, name: string, args: string) =>
      handle({ type: 'chat.item', turnId: 'T1', itemId: id, kind: 'toolExecution', status: 'completed', payload: { toolName: name, argsSummary: args } });
    item('a1', 'list_files', '{"path":"/tmp/x"}');
    item('a2', 'kb_list', '{}');
    item('a3', 'material_list', '{}');
    item('a4', 'p3394_peers', '{}');
    item('a5', 'auto_tasks_list', '{"project_id":"__current__"}');
    item('a6', 'search_ability_assets', '{"query":"harness"}');
    // stub 里 innerHTML 不反映 appendChild 的子元素：逐行取行内 HTML。
    const html = bodyOf(flow).children.map((r) => r.innerHTML).join('|');
    expect(html).toContain('列目录');
    expect(html).toContain('知识库');
    expect(html).toContain('素材');
    expect(html).toContain('对端');
    expect(html).toContain('任务');
    expect(html).toContain('能力');
  });

  it('发送类工具显示「→ 对端：消息摘要」，不摆原始 JSON', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'm1', kind: 'toolExecution', status: 'inProgress', payload: { toolName: 'p3394_send', argsSummary: '{"peer":"workbuddy","message":"连通性实测：请用一句话确认你已收到这条跨-agent 消息"}' } });
    const row = bodyOf(flow).children.find((c) => c.dataset.csItem === 'm1')!;
    expect(row.innerHTML).toContain('发送');
    expect(row.innerHTML).toContain('→ workbuddy');
    expect(row.innerHTML).toContain('连通性实测');
    expect(row.innerHTML).not.toContain('&quot;peer&quot;');
  });

  it('运行中时间线末尾有加载中指示，终态移除', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    expect(flow.querySelector('.cs-loading')).toBeTruthy();
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } });
    expect(flow.querySelector('.cs-loading')).toBeTruthy();
    handle({ type: 'chat.turn.completed', turnId: 'T1', status: 'completed', endedAt: '' });
    expect(flow.querySelector('.cs-loading')).toBeNull();
    // 纯文字回合：loading 撤掉后 body 为空 → 连流壳一起撤（既有契约）。
    handle({ type: 'chat.turn.started', turnId: 'T2', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({ type: 'chat.item', turnId: 'T2', itemId: 'i1', kind: 'text', status: 'inProgress', payload: { delta: '只是回答' } });
    const flow2 = inserts[inserts.length - 1].node;
    handle({ type: 'chat.turn.completed', turnId: 'T2', status: 'completed', endedAt: '' });
    expect(flow2.isConnected).toBe(false);
  });

  it('reset 清空活动流；垃圾事件不抛错', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    g.window.chatStreamReset();
    expect(inserts[0].node.connected).toBe(false);

    expect(() => handle(null)).not.toThrow();
    expect(() => handle({ type: 'chat.future' })).not.toThrow();
  });

  // ── 切换对话后计时停摆的回归（根因：ticker 因 isConnected 自杀无重启 +
  //    历史态流被 live 事件复用时形态不升级） ──────────────────────────────
  it('切换会话（DOM 断开致 ticker 自杀）后复用运行流：计时自愈重启且起点不变', () => {
    let intervalCalls = 0;
    g.setInterval = () => { intervalCalls += 1; return intervalCalls; };
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'commander', startedAt: '' });
    const flow = inserts[0].node;
    expect(intervalCalls).toBe(1);
    const t0 = flow.dataset.csT0;

    // 模拟会话切换：container 清空 → flow 断开 → 下一次 tick 自杀（ticker 清空）。
    flow.connected = false;
    flow._csTicker = null;
    flow.connected = true;

    // live 事件继续到达并复用同一流 → 应自愈重启，且沿用原起点（不重置为 now）。
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'i1', kind: 'reasoning', status: 'completed', payload: { text: 'x' } });
    expect(intervalCalls).toBe(2);
    expect(flow.dataset.csT0).toBe(t0);
  });

  it('切换回来后历史重放先建历史态流：live 事件到达时升级运行形态并启动计时', () => {
    let intervalCalls = 0;
    g.setInterval = () => { intervalCalls += 1; return intervalCalls; };
    const msgDiv = makeEl('div');
    anchor.appendChild(msgDiv);
    const items = [
      { type: 'turn', turn: { type: 'chat.turn.started', turnId: 'T2', startedAt: '2026-09-12T10:00:00.000Z' } },
      { type: 'chatItem', item: { type: 'chat.item', turnId: 'T2', itemId: 'i1', kind: 'reasoning', status: 'completed', payload: { text: 'x' } } },
    ];
    // 历史重放：回合无 turn.completed（任务仍在跑）——现状按完成态建流。
    const ok = g.window.chatStreamRenderPersisted('c-1', msgDiv, items, { actorName: 'commander', turnId: 'T2' });
    expect(ok).toBe(true);
    const flow = msgDiv.querySelector('.cs-flow')!;
    const badge = flow.querySelector('.cs-badge')!;
    expect(badge.querySelector('.cs-badge-label')!.textContent).toBe('已完成');
    expect(badge.querySelector('.cs-badge-elapsed')).toBeNull();
    expect(intervalCalls).toBe(0);

    // live 事件到达（回合其实仍活跃）→ 升级：补计时位、文案回「工作中」、启动 ticker。
    handle({ type: 'chat.item', turnId: 'T2', itemId: 'i2', kind: 'reasoning', status: 'inProgress', payload: { delta: 'y' } });
    expect(badge.querySelector('.cs-badge-elapsed')).toBeTruthy();
    expect(badge.querySelector('.cs-badge-label')!.textContent).toBe('工作中');
    expect(intervalCalls).toBe(1);
  });

  it('终态流不被 live 迟到事件复活（csTerminal 保护）', () => {
    let intervalCalls = 0;
    g.setInterval = () => { intervalCalls += 1; return intervalCalls; };
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'i1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } });
    handle({ type: 'chat.turn.completed', turnId: 'T1', status: 'completed', endedAt: '' });
    const before = intervalCalls;

    // 迟到事件（usage 收尾等）复用终态流：不得重启计时。
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'u1', kind: 'usage', status: 'completed', payload: { text: 'tokens' } });
    expect(intervalCalls).toBe(before);
    expect(flow.querySelector('.cs-badge-label')!.textContent).toBe('已完成');
  });

  it('interaction.requested 渲染审批卡，closed 撤卡禁用', () => {
    const replies: unknown[] = [];
    g.window.cogseed = { invoke: (_ch: string, payload: unknown) => { replies.push(payload); return Promise.resolve({ ok: true }); } };

    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({
      type: 'chat.interaction.requested', turnId: 'T1', interactionId: 'ix-1', kind: 'approval',
      prompt: '执行危险命令？', detail: 'rm -rf dist', timeoutMs: 30000, approvalCategory: 'bash',
    });

    const body = bodyOf(inserts[0].node);
    const card = body.children.find((c) => (c.dataset as Record<string, string>).csInteraction === 'ix-1');
    expect(card).toBeTruthy();
    // detail 以 <pre> 文本呈现（DOM 构建，不走 innerHTML）。
    const detail = card!.children.find((c) => c.className.includes('cs-interaction-detail'));
    expect(detail!.textContent).toContain('rm -rf dist');
    const actions = card!.children.find((c) => c.className.includes('cs-interaction-actions'))!;
    const deny = actions.children.find((b) => (b.textContent || '') === '拒绝')! as StubEl & { handlers: Record<string, () => void> };
    // 点击链路依赖真实 DOM 事件，stub 环境只验证按钮存在与文案。
    expect(deny).toBeTruthy();

    handle({ type: 'chat.interaction.closed', interactionId: 'ix-1', reason: 'answered' });
    expect(card!.className).toContain('closed');
  });

  it('interaction 提问卡渲染输入行', () => {
    handle({ type: 'chat.turn.started', turnId: 'T2', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({
      type: 'chat.interaction.requested', turnId: 'T2', interactionId: 'q-1', kind: 'question',
      prompt: '用哪个分支？', timeoutMs: 30000,
    });
    const body = bodyOf(inserts[0].node);
    const card = body.children.find((c) => (c.dataset as Record<string, string>).csInteraction === 'q-1');
    expect(card).toBeTruthy();
    expect(card!.innerHTML).not.toContain('cs-interaction-actions');
  });

  it('bash 审批桥接：镜像卡挂同 cid 流，dismiss 撤卡，无流时跳过', () => {
    const bridge = g.window.chatStreamBridgeBashPermission as (i: unknown) => void;
    const dismiss = g.window.chatStreamDismissBashPermission as (id: string) => void;

    // 无流：静默跳过不抛错。
    expect(() => bridge({ request_id: 'bp-1', cid: 'c-9', command: 'rm -rf x' })).not.toThrow();

    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    bridge({
      request_id: 'bp-1', cid: 'c-1', agent_name: 'coder',
      command: 'rm -rf dist', reasons: ['dangerous_delete'],
    });
    const body = bodyOf(inserts[0].node);
    const card = body.children.find((c) => (c.dataset as Record<string, string>).csInteraction === 'bp-1');
    expect(card).toBeTruthy();
    const detail = card!.children.find((c) => c.className.includes('cs-interaction-detail'));
    expect(detail!.textContent).toContain('rm -rf dist');
    const reasons = card!.children.find((c) => c.className.includes('cs-interaction-reasons'));
    expect(reasons!.textContent).toContain('dangerous_delete');
    const actions = card!.children.find((c) => c.className.includes('cs-interaction-actions'))!;
    expect(actions.children).toHaveLength(3);

    dismiss('bp-1');
    expect(card!.className).toContain('closed');
  });

  it('bridge 审批镜像：总是允许按钮、回复走 bridge 通道', () => {
    const replies: Array<[string, unknown]> = [];
    g.window.cogseed = {
      invoke: (ch: string, payload: unknown) => { replies.push([ch, payload]); return Promise.resolve({ ok: true }); },
    };
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const bridge = g.window.chatStreamBridgeBashPermission as (i: unknown, o?: unknown) => void;
    bridge({ request_id: 'br-1', operation: '外部服务调用 mail.send' }, { source: 'bridge' });

    const body = bodyOf(inserts[0].node);
    const card = body.children.find((c) => (c.dataset as Record<string, string>).csInteraction === 'br-1');
    expect(card).toBeTruthy();
    const actions = card!.children.find((c) => c.className.includes('cs-interaction-actions'))!;
    const labels = actions.children.map((b) => b.textContent);
    expect(labels).toContain('总是允许');
    expect(labels).not.toContain('本任务内允许');
  });

  it('chatStreamHasPanel 按 cid 判定；历史重建：动作行全可见、无运行行、幂等', () => {
    const hasPanel = g.window.chatStreamHasPanel as (c: string) => boolean;
    expect(hasPanel('c-1')).toBe(false);
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    expect(hasPanel('c-1')).toBe(true);
    expect(hasPanel('c-other')).toBe(false);

    const render = g.window.chatStreamRenderPersisted as (c: string, m: unknown, i: unknown, o?: unknown) => boolean;
    const msgDiv = makeEl('div');
    root.appendChild(msgDiv);
    const items = [
      { type: 'progress', text: '先想一下' },
      { type: 'event', event: { stream: 'tool', data: { phase: 'start', id: 't1', name: 'bash', arguments: { command: 'ls' } } } },
      { type: 'event', event: { stream: 'tool', data: { phase: 'end', id: 't1', name: 'bash', output: 'ok' } } },
      { type: 'progress', text: '再想想' },
    ];
    expect(render('c-1', msgDiv, items, { actorName: 'agent', turnId: 'hist-1' })).toBe(true);

    const flow = msgDiv.children.find((c) => (c.dataset as Record<string, string>).csTurn === 'c-1::hist-1')!;
    expect(flow).toBeTruthy();
    // 流在消息内部（msgDiv 的子元素）。
    expect(flow.parentNode).toBe(msgDiv);
    expect(flow.className).toContain('done');
    // 历史流徽章只做收起开关（无计时数据不显示时长）；完成后默认收起
    // （交互设计 2026-09-08：过程区块折叠成摘要行，点徽章展开回看）。
    const histBadge = flow.querySelector('.cs-badge')!;
    expect(histBadge).toBeTruthy();
    expect(histBadge.querySelector('.cs-badge-elapsed')).toBeNull();
    expect(histBadge.querySelector('.cs-badge-label')!.textContent).toBe('已完成');
    const body = bodyOf(flow);
    expect(body.style.display).toBe('none');
    expect(flow.dataset.csCollapsed).toBe('1');
    const rows = body.children.filter((c) => c.className.includes('cs-toolExecution'));
    expect(rows).toHaveLength(1);
    expect(rows[0].innerHTML).toContain('ok');
    expect(rows[0].innerHTML).toContain('运行');
    expect(rows[0].innerHTML).toContain('ls');
    // progress 文本 → 思考行；中间的思考行（后面跟了工具）必须已收行——
    // 不再挂着 "…" 占位。
    const thinks = body.children.filter((c) => String(c.className).includes('cs-row-think'));
    expect(thinks).toHaveLength(2);
    expect(thinks[0].dataset.csClosed).toBe('1');
    expect(flow.innerHTML).not.toContain('…');

    // 同 turnId 重建幂等：旧流移除、只留一个。
    render('c-1', msgDiv, items, { actorName: 'agent', turnId: 'hist-1' });
    const flows = msgDiv.children.filter((c) => (c.dataset as Record<string, string>).csTurn === 'c-1::hist-1');
    expect(flows).toHaveLength(1);

    // 空数组/缺父节点返回 false。
    expect(render('c-1', msgDiv, [], {})).toBe(false);
  });

  it.each(['failed', 'cancelled', 'completed', 'waiting_user'])('replays the native Runtime task terminal state: %s', (status) => {
    const msgDiv = makeEl('div');
    root.appendChild(msgDiv);
    const items = [
      { type: 'event', event: { stream: 'task.started' } },
      { type: 'progress', text: '<agent-res' },
      { type: 'progress', text: 'ult status="waiting_input" />' },
      { type: 'progress', text: '<context-patch>{"facts_add":[]}</context-patch>' },
      { type: 'progress', text: 'Please confirm the existing minutes.' },
      { type: 'event', event: { stream: `task.${status}`, data: { code: 'transcript_correction_incomplete' } } },
    ];
    expect(g.window.chatStreamRenderPersisted('c-1', msgDiv, items, { turnId: 'native', finalText: 'Please confirm the existing minutes.' })).toBe(true);
    const flow = msgDiv.children.find(c => c.dataset.csTurn === 'c-1::native')!;
    expect(flow.className).toContain(status === 'completed' ? 'done' : status === 'waiting_user' ? 'waiting_input' : status);
    if (status === 'completed') expect(flow.querySelector('.cs-badge-label')).toBeNull();
    else expect(flow.querySelector('.cs-badge-label')!.textContent).toBe(status === 'failed' ? '失败' : status === 'cancelled' ? '已取消' : '等待确认');
    expect(flow.querySelectorAll('.cs-row-think')).toHaveLength(0);
  });

  it('历史重建（新格式）：chatItem/turn 重放含权威计时，正文段与老条目不重复渲染', () => {
    const render = g.window.chatStreamRenderPersisted as (c: string, m: unknown, i: unknown, o?: unknown) => boolean;
    const msgDiv = makeEl('div');
    root.appendChild(msgDiv);
    const t0 = 1700000000000;
    const items = [
      { type: 'chatItem', item: { type: 'chat.turn.started', turnId: 'nt1', cid: 'c-2', actorId: 'a', startedAt: new Date(t0).toISOString() } },
      // 老格式混排条目应被新格式路径忽略（不是回退渲染，是跳过）。
      { type: 'progress', text: '老格式混排不渲染' },
      { type: 'chatItem', item: { type: 'chat.item', turnId: 'nt1', itemId: 'nt1:tool:1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'npm test', output: 'done', timing: { startedAtMs: t0, completedAtMs: t0 + 1500 } } } },
      // 中间正文段（被后续 item 截断的 completed 整段）：消息体只有最终
      // 段，这些段落必须渲染进历史面板，否则展开永远缺 AI 中间输出。
      { type: 'chatItem', item: { type: 'chat.item', turnId: 'nt1', itemId: 'nt1:text:0', kind: 'text', status: 'completed', payload: { delta: '中间正文应在历史流' } } },
      // 最终段/增量条目（inProgress）：历史重建跳过（终稿已在消息体，防重复）。
      { type: 'chatItem', item: { type: 'chat.item', turnId: 'nt1', itemId: 'nt1:text:1', kind: 'text', status: 'inProgress', payload: { delta: '正文不应出现在历史流' } } },
      { type: 'turn', turn: { type: 'chat.turn.completed', turnId: 'nt1', status: 'completed', durationMs: 2600, endedAt: new Date(t0 + 2600).toISOString() } },
      // 幻影第二回合（修复前写入的脏数据）：重放必须收编进同一时间线。
      { type: 'chatItem', item: { type: 'chat.turn.started', turnId: 'ph-x', cid: 'c-2', actorId: 'a', startedAt: new Date(t0 + 3000).toISOString() } },
      { type: 'chatItem', item: { type: 'chat.item', turnId: 'ph-x', itemId: 'ph-x:tool:9', kind: 'toolExecution', status: 'completed', payload: { toolName: 'web_search', output: 'ok' } } },
      { type: 'turn', turn: { type: 'chat.turn.completed', turnId: 'ph-x', status: 'completed', durationMs: 1000, endedAt: new Date(t0 + 4000).toISOString() } },
    ];
    expect(render('c-2', msgDiv, items, { actorName: 'agent' })).toBe(true);

    const flow = msgDiv.children.find((c) => (c.dataset as Record<string, string>).csTurn === 'nt1')!;
    expect(flow).toBeTruthy();
    expect(flow.parentNode).toBe(msgDiv);
    expect(flow.className).toContain('done');

    const body = bodyOf(flow);
    const rows = body.children.filter((c) => c.className.includes('cs-toolExecution'));
    expect(rows).toHaveLength(2);
    expect(rows[0].innerHTML).toContain('done');
    expect(rows[0].innerHTML).toContain('npm test');
    // 工具行不再显示耗时（2026-09-11 需求变更：本地 CLI 毫秒级耗时信息
    // 量低），行内只有目标与展开区；徽章仍显示整段总耗时与工具数 2。
    expect(rows[0].innerHTML).not.toContain('cs-dur');
    expect(rows[0].innerHTML).not.toContain('1 秒');
    expect(rows[1].innerHTML).toContain('搜索');
    expect(rows[1].innerHTML).toContain('ok');
    const badge = flow.querySelector('.cs-badge')!;
    expect(badge).toBeTruthy();
    const elapsed = badge.querySelector('.cs-badge-elapsed')!;
    expect(elapsed).toBeTruthy();
    // 整秒计数（任务耗时 2026-09-09 修订：去小数位）。
    expect(elapsed.textContent).toContain('4 秒');
    const tools = badge.querySelector('.cs-badge-tools')!;
    expect(tools).toBeTruthy();
    expect(tools.textContent).toContain('2');
    // 中间正文段进入历史流（stub 的 innerHTML 非递归，按子元素断言）；
    // 最终段（inProgress）与老格式混排不进入。
    const textRows = body.children.filter((c) => c.className.includes('cs-text'));
    expect(textRows).toHaveLength(1);
    expect(textRows[0].textContent).toContain('中间正文应在历史流');
    expect(flow.innerHTML).not.toContain('正文不应出现在历史流');
    expect(flow.innerHTML).not.toContain('老格式混排');
    expect(textRows[0].textContent).not.toContain('正文不应出现在历史流');

    // 同 turnId 重建幂等。
    render('c-2', msgDiv, items, { actorName: 'agent' });
    const flows = msgDiv.children.filter((c) => (c.dataset as Record<string, string>).csTurn === 'nt1');
    expect(flows).toHaveLength(1);
  });

  it('同消息头多回合：新徽章收编旧徽章（移入各自流体并折叠），消息头只留一枚', () => {
    const handle = g.window.chatStreamHandleEvent as (c: string, m: unknown, e: unknown) => void;
    const msgDiv = makeEl('div');
    root.appendChild(msgDiv);
    const header = makeEl('div');
    header.className = 'chat-msg-header';
    msgDiv.appendChild(header);

    // 回合 1：started → tool 行（流保持运行态，徽章在消息头）。
    handle('c-3', msgDiv, { type: 'chat.turn.started', turnId: 'ph1', cid: 'c-3', actorId: 'a', startedAt: '' });
    handle('c-3', msgDiv, { type: 'chat.item', turnId: 'ph1', itemId: 'ph1:tool:1', kind: 'toolExecution', status: 'inProgress', payload: { toolName: 'bash' } });
    const flow1 = msgDiv.children.find((c) => (c.dataset as Record<string, string>).csTurn === 'ph1')!;
    expect(flow1).toBeTruthy();
    expect(header.querySelectorAll('.cs-badge').length).toBe(1);

    // 回合 2（幻影/后续回合）：同头新建流 → 旧徽章被收编进旧流体，消息头只留新徽章。
    handle('c-3', msgDiv, { type: 'chat.turn.started', turnId: 'ph2', cid: 'c-3', actorId: 'a', startedAt: '' });
    const flow2 = msgDiv.children.find((c) => (c.dataset as Record<string, string>).csTurn === 'ph2')!;
    expect(flow2).toBeTruthy();
    expect(header.querySelectorAll('.cs-badge').length).toBe(1);
    expect(flow1.dataset.csSuperseded).toBe('1');
    // 旧徽章移入旧流体的 cs-badge-row，仍可点击开合。
    const movedRow = flow1.querySelector('.cs-badge-row')!;
    expect(movedRow).toBeTruthy();
    expect(movedRow.querySelector('.cs-badge')).toBeTruthy();
    // 旧流体被折叠（body 隐藏），过程行保留不丢。
    expect(flow1.querySelector('.cs-flow-body')!.style.display).toBe('none');
    // 过程行保留（折叠只是隐藏，不删行）：动词「运行」可查。
    const keptRows = (flow1.querySelector('.cs-flow-body')!.children as unknown as Array<{ className: string; innerHTML: string }>)
      .filter((c) => String(c.className).includes('cs-toolExecution'));
    expect(keptRows).toHaveLength(1);
    expect(keptRows[0].innerHTML).toContain('运行');
  });

  // ── 过程折叠第二刀（2026-10-13）：归属 + 默认折叠 + 移交终态化 ──────────

  it('worker 回合：折叠条写明归属且默认折叠，点击展开可见步骤（需求 B/断言 2、3）', () => {
    const handleW = g.window.chatStreamHandleEvent as (c: string, m: unknown, e: unknown, o?: unknown) => void;
    const workerAnchor = makeEl('div');
    root.appendChild(workerAnchor);
    const header = makeEl('div');
    header.className = 'chat-msg-header';
    workerAnchor.appendChild(header);

    handleW('c-1', workerAnchor, { type: 'chat.turn.started', turnId: 'TW', cid: 'c-1', actorId: 'w1', startedAt: '' },
      { actorId: 'w1', actorName: '内容创作Agent', collapseByDefault: true });
    handleW('c-1', workerAnchor, { type: 'chat.item', turnId: 'TW', itemId: 'TW:tool:1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } });

    const flow = workerAnchor.children.find((c) => (c.dataset as Record<string, string>).csTurn === 'TW')!;
    expect(flow).toBeTruthy();
    expect(flow.dataset.csActor).toBe('w1');
    const badge = header.querySelector('.cs-badge')!;
    // 归属标题：折叠条写明是「谁」的执行过程，不再是无人称的「工作中」。
    expect(badge.querySelector('.cs-badge-owner')!.textContent).toBe('内容创作Agent 的执行过程');
    // 默认折叠：页面高度不因 worker 过程增长。
    expect(flow.dataset.csCollapsed).toBe('1');
    expect(flow.querySelector('.cs-flow-body')!.style.display).toBe('none');
    expect(badge.getAttribute('aria-expanded')).toBe('false');
    // 点击展开 → 可见该 actor 的步骤；再点折叠。
    (badge.handlers.click!)();
    expect(flow.querySelector('.cs-flow-body')!.style.display).not.toBe('none');
    expect(flow.dataset.csCollapsed).toBe('0');
    const rows = (flow.querySelector('.cs-flow-body')!.children as unknown as Array<{ innerHTML: string }>)
      .filter((c) => String((c as unknown as { className: string }).className).includes('cs-toolExecution'));
    expect(rows).toHaveLength(1);
    (badge.handlers.click!)();
    expect(flow.dataset.csCollapsed).toBe('1');
  });

  it('主 Agent 运行中默认紧凑：过程行收起、正文区仍可见（COGSEED-497）', () => {
    const handleW = g.window.chatStreamHandleEvent as (c: string, m: unknown, e: unknown, o?: unknown) => void;
    handleW('c-1', anchor, { type: 'chat.turn.started', turnId: 'TC', cid: 'c-1', actorId: 'commander', startedAt: '' },
      { actorId: 'commander', actorName: 'cogseed', collapseByDefault: false });
    const flow = inserts[0].node;
    // 不整块折叠（运行中的回答要能看见），但思考/工具行默认不铺开。
    expect(flow.querySelector('.cs-flow-body')!.style.display).not.toBe('none');
    expect(flow.dataset.csCompact).toBe('1');
    expect(flow.querySelector('.cs-badge')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('话权交给 agent 后交出方立即终态化：去运行态/去计时/折叠为「已移交」（需求 A/断言 1）', () => {
    const handleW = g.window.chatStreamHandleEvent as (c: string, m: unknown, e: unknown, o?: unknown) => void;
    handleW('c-1', anchor, { type: 'chat.turn.started', turnId: 'TC', cid: 'c-1', actorId: 'commander', startedAt: '' },
      { actorId: 'commander', actorName: 'cogseed' });
    handleW('c-1', anchor, { type: 'chat.item', turnId: 'TC', itemId: 'TC:tool:1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } });
    const cmdFlow = inserts[0].node;
    expect(cmdFlow.className).toContain('running');

    (g.window.chatStreamYieldFloor as (c: string, f: string) => void)('c-1', 'w1');

    expect(cmdFlow.className).not.toContain('running');
    expect(cmdFlow.dataset.csHandedOff).toBe('1');
    const badge = cmdFlow.querySelector('.cs-badge')!;
    expect(badge.querySelector('.cs-badge-label')!.textContent).toBe('已移交');
    // 计时停：ticker 不再存活（stub setInterval 返回 0，用折叠态与文案判定）。
    expect(cmdFlow.dataset.csCollapsed).toBe('1');
    // loading 指示随运行态撤除。
    expect(cmdFlow.querySelector('.cs-loading')).toBeNull();
    // 移交后到达的迟到 item 不复活运行态（只有真正在跑的 actor 是活动元素）。
    handleW('c-1', anchor, { type: 'chat.item', turnId: 'TC', itemId: 'TC:tool:2', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls -la' } });
    expect(cmdFlow.className).not.toContain('running');
    expect(badge.querySelector('.cs-badge-label')!.textContent).toBe('已移交');
  });

  it('移交终态化只作用于非新话权方，且重复调用幂等', () => {
    const handleW = g.window.chatStreamHandleEvent as (c: string, m: unknown, e: unknown, o?: unknown) => void;
    const workerAnchor = makeEl('div');
    root.appendChild(workerAnchor);
    handleW('c-1', anchor, { type: 'chat.turn.started', turnId: 'TC', cid: 'c-1', actorId: 'commander', startedAt: '' }, { actorId: 'commander' });
    handleW('c-1', workerAnchor, { type: 'chat.turn.started', turnId: 'TW', cid: 'c-1', actorId: 'w1', startedAt: '' }, { actorId: 'w1' });
    const cmdFlow = inserts.find((i) => (i.node.dataset as Record<string, string>).csTurn === 'TC')!.node;
    const workerFlow = workerAnchor.children.find((c) => (c.dataset as Record<string, string>).csTurn === 'TW')!;

    const yieldFloor = g.window.chatStreamYieldFloor as (c: string, f: string) => void;
    yieldFloor('c-1', 'w1');
    yieldFloor('c-1', 'w1');
    // 交出方冻结，新话权方保持运行态。
    expect(cmdFlow.dataset.csHandedOff).toBe('1');
    expect(workerFlow.className).toContain('running');
    expect(workerFlow.dataset.csHandedOff).toBeUndefined();
  });

  it('折叠态也看得出「在跑」：徽章常显旋转指示，终态/移交才移除（真机 2026-10-14）', () => {
    const handleW = g.window.chatStreamHandleEvent as (c: string, m: unknown, e: unknown, o?: unknown) => void;
    const workerAnchor = makeEl('div');
    root.appendChild(workerAnchor);
    const header = makeEl('div');
    header.className = 'chat-msg-header';
    workerAnchor.appendChild(header);

    handleW('c-1', workerAnchor, { type: 'chat.turn.started', turnId: 'TW', cid: 'c-1', actorId: 'w1', startedAt: '' },
      { actorId: 'w1', actorName: '内容创作Agent', collapseByDefault: true });
    const flow = workerAnchor.children.find((c) => (c.dataset as Record<string, string>).csTurn === 'TW')!;
    const badge = header.querySelector('.cs-badge')!;
    // 折叠：过程区不可见；但徽章上的运行指示必须还在，否则用户看不到任何"在跑"的证据。
    expect(flow.dataset.csCollapsed).toBe('1');
    expect(flow.querySelector('.cs-flow-body')!.style.display).toBe('none');
    expect(badge.querySelector('.cs-badge-live')).toBeTruthy();
    // stub 不解析 innerHTML，按标记断言（同既有「加载中指示」用例）。
    expect(badge.querySelector('.cs-badge-live')!.innerHTML).toContain('cs-loading-spinner');

    // 终态：指示移除、徽章定格。
    handleW('c-1', workerAnchor, { type: 'chat.item', turnId: 'TW', itemId: 'TW:t1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } });
    handleW('c-1', workerAnchor, { type: 'chat.turn.completed', turnId: 'TW', status: 'completed', endedAt: '' });
    expect(badge.querySelector('.cs-badge-live')).toBeNull();
    expect(badge.querySelector('.cs-badge-label')!.textContent).toBe('已完成');
  });

  it('移交冻结时移除运行指示，话权回来再恢复', () => {
    const handleW = g.window.chatStreamHandleEvent as (c: string, m: unknown, e: unknown, o?: unknown) => void;
    const yieldFloor = g.window.chatStreamYieldFloor as (c: string, f: string) => void;
    handleW('c-1', anchor, { type: 'chat.turn.started', turnId: 'TC', cid: 'c-1', actorId: 'commander', startedAt: '' }, { actorId: 'commander' });
    const cmdFlow = inserts[0].node;
    const badge = cmdFlow.querySelector('.cs-badge')!;
    expect(badge.querySelector('.cs-badge-live')).toBeTruthy();

    yieldFloor('c-1', 'w1');
    expect(badge.querySelector('.cs-badge-live')).toBeNull();

    handleW('c-1', anchor, { type: 'chat.item', turnId: 'TC', itemId: 'TC:t2', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'pwd' } }, { actorId: 'commander', floorActor: 'commander' });
    expect(badge.querySelector('.cs-badge-live')).toBeTruthy();
  });

  it('历史重放的终态徽章没有运行指示（不编造「在跑」）', () => {
    const render = g.window.chatStreamRenderPersisted as (c: string, m: unknown, i: unknown, o?: unknown) => boolean;
    const msgDiv = makeEl('div');
    root.appendChild(msgDiv);
    render('c-hist', msgDiv, [
      { type: 'turn', turn: { type: 'chat.turn.started', turnId: 'H1', cid: 'c-hist', actorId: 'commander', startedAt: '' } },
      { type: 'turn', turn: { type: 'chat.turn.completed', turnId: 'H1', status: 'completed', endedAt: '' } },
      { type: 'chatItem', item: { type: 'chat.item', turnId: 'H1', itemId: 'H1:t1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } } },
    ], {});
    const badge = msgDiv.querySelector('.cs-badge');
    expect(badge).toBeTruthy();
    expect(badge!.querySelector('.cs-badge-live')).toBeNull();
  });

  it('话权回到交出方：撤销「已移交」冻结并恢复运行态（运行指示 = 持有 floor）', () => {    const handleW = g.window.chatStreamHandleEvent as (c: string, m: unknown, e: unknown, o?: unknown) => void;
    handleW('c-1', anchor, { type: 'chat.turn.started', turnId: 'TC', cid: 'c-1', actorId: 'commander', startedAt: '' }, { actorId: 'commander' });
    handleW('c-1', anchor, { type: 'chat.item', turnId: 'TC', itemId: 'TC:tool:1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } }, { floorActor: 'w1' });
    const cmdFlow = inserts[0].node;
    (g.window.chatStreamYieldFloor as (c: string, f: string) => void)('c-1', 'w1');
    expect(cmdFlow.dataset.csHandedOff).toBe('1');
    const badge = cmdFlow.querySelector('.cs-badge')!;
    expect(badge.querySelector('.cs-badge-label')!.textContent).toBe('已移交');

    // 工人结束、话权回到 commander，它继续产出 → 恢复运行态与计时。
    handleW('c-1', anchor, { type: 'chat.item', turnId: 'TC', itemId: 'TC:tool:2', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'pwd' } }, { actorId: 'commander', floorActor: 'commander' });
    expect(cmdFlow.dataset.csHandedOff).toBeUndefined();
    expect(cmdFlow.className).toContain('running');
    expect(cmdFlow.querySelector('.cs-loading')).toBeNull();
    // 展开状态保持用户/上一次收尾的选择（这里移交时被收成摘要行）。
    expect(cmdFlow.dataset.csCollapsed).toBe('1');
  });
});
