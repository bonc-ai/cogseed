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
    // 计时/收起徽章（消息头不存在时落流内首行兜底）：工作中 + 计时 + 停止。
    const badge = flow.querySelector('.cs-badge')!;
    expect(badge).toBeTruthy();
    expect(badge.querySelector('.cs-badge-label')!.textContent).toBe('工作中');
    expect(badge.querySelector('.cs-badge-elapsed')).toBeTruthy();
    expect(flow.querySelector('.cs-badge-stop')).toBeTruthy();
  });

  it('徽章点击收起/展开时间线正文', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    const flow = inserts[0].node;
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } });
    const badge = flow.querySelector('.cs-badge')!;
    const body = bodyOf(flow);
    expect(body.style.display).not.toBe('none');
    // 点击 → 收起；再点 → 展开。
    (badge.handlers.click!)();
    expect(body.style.display).toBe('none');
    expect(flow.dataset.csCollapsed).toBe('1');
    expect(badge.getAttribute('aria-expanded')).toBe('false');
    (badge.handlers.click!)();
    expect(body.style.display).not.toBe('none');
    expect(flow.dataset.csCollapsed).toBe('0');
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
    expect(thinks[0].innerHTML).toContain('思考');

    handle({ type: 'chat.item', turnId: 'T1', itemId: 't1', kind: 'toolExecution', status: 'completed', payload: { toolName: 'bash', argsSummary: 'ls' } });
    expect(thinks[0].dataset.csClosed).toBe('1');
    expect(thinks[0].innerHTML).toContain('持续了');
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
    expect(flow.dataset.csText).toBe('我先查一下：查完了。');

    // turn.completed：交回（_streamingAppendFinalDelta 不在测试环境，走
    // finalEl fallback 亦无），段移除、聚合清空；有动作行 → 流保留为 done。
    handle({ type: 'chat.turn.completed', turnId: 'T1', status: 'completed', endedAt: '' });
    expect(flow.querySelectorAll('.cs-text')).toHaveLength(0);
    expect(flow.dataset.csText).toBeUndefined();
    expect(flow.className).toContain('done');
    expect(flow.className).not.toContain('running');
    expect(flow.isConnected).toBe(true);
    // 完成后停止按钮撤除；徽章定格为「已工作」（收起开关保留）。
    expect(flow.querySelector('.cs-badge-stop')).toBeNull();
    expect(flow.querySelector('.cs-badge')!.querySelector('.cs-badge-label')!.textContent).toBe('已工作');

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
    expect(flow.dataset.csText).toBe('我先查一下：查完了。');

    // turn.completed：交回（_streamingAppendFinalDelta 不在测试环境，走
    // finalEl fallback 亦无），段移除、聚合清空；有动作行 → 流保留为 done。
    handle({ type: 'chat.turn.completed', turnId: 'T1', status: 'completed', endedAt: '' });
    expect(flow.querySelectorAll('.cs-text')).toHaveLength(0);
    expect(flow.dataset.csText).toBeUndefined();
    expect(flow.className).toContain('done');
    expect(flow.className).not.toContain('running');
    expect(flow.isConnected).toBe(true);
    // 完成后停止按钮撤除；徽章定格为「已工作」（收起开关保留）。
    expect(flow.querySelector('.cs-badge-stop')).toBeNull();
    expect(flow.querySelector('.cs-badge')!.querySelector('.cs-badge-label')!.textContent).toBe('已工作');

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
    // 段首空白被剥掉（时间线显示），聚合文本保留（markdown 分段需要）。
    expect(segs[0].textContent).toBe('正文第一段。');
    expect(flow.dataset.csText).toBe('\n\n正文第一段。');
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

  it('reset 清空活动流；垃圾事件不抛错', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    g.window.chatStreamReset();
    expect(inserts[0].node.connected).toBe(false);

    expect(() => handle(null)).not.toThrow();
    expect(() => handle({ type: 'chat.future' })).not.toThrow();
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
    // 历史流徽章只做收起开关（无计时数据不显示时长）；动作行全部可见。
    const histBadge = flow.querySelector('.cs-badge')!;
    expect(histBadge).toBeTruthy();
    expect(histBadge.querySelector('.cs-badge-elapsed')).toBeNull();
    expect(histBadge.querySelector('.cs-badge-label')!.textContent).toBe('已工作');
    const body = bodyOf(flow);
    expect(body.style.display).not.toBe('none');
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
});
