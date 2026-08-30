// ─── chat-stream 渲染模块测试（stub 全局 DOM + 动态 import） ───────────────
//
// 验证过程面板的事件驱动行为：
// 1. turn.started 建面板（挂 anchor 之前）；同 turn 幂等复用；
// 2. toolExecution 三相位更新同一卡片；text kind 跳过（老通道渲染）；
// 3. turn.completed 收尾状态类名；reset 清空；
// 4. 垃圾事件不抛错（宽容）。
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
  readonly isConnected: boolean;
  textContent: string;
  appendChild(el: StubEl): StubEl;
  insertBefore(node: StubEl, before: StubEl): StubEl;
  querySelector(sel: string): StubEl | null;
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
    get isConnected() { return el.connected; },
  get classList() {
    return {
      add(cls: string) { if (!(` ${el.className} `).includes(` ${cls} `)) el.className = `${el.className} ${cls}`.trim(); },
      remove(cls: string) { el.className = (` ${el.className} `).replace(` ${cls} `, ' ').trim(); },
      toggle(cls: string) { if ((` ${el.className} `).includes(` ${cls} `)) this.remove(cls); else this.add(cls); },
    };
  },
  querySelectorAll(sel: string): StubEl[] {
    const byTag = sel.match(/^(button|input)$/);
    const out: StubEl[] = [];
    const walk = (node: StubEl) => {
      for (const child of node.children) {
        if (byTag && child.tagName.toLowerCase() === byTag[1]) out.push(child);
        walk(child);
      }
    };
    walk(el);
    return out;
  },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    addEventListener(_type: string, _fn: () => void) { /* stub */ },
    setAttribute() { /* stub */ },
    appendChild(child) { el.children.push(child); child.parentNode = el; return child; },
    insertBefore(node, before) {
      // 经 bind(target) 转发时必须落在 target 上（闭包 el 只作默认宿主）。
      const host: StubEl = this && Array.isArray((this as StubEl).children) ? this as StubEl : el;
      const idx = host.children.indexOf(before);
      host.children.splice(idx < 0 ? host.children.length : idx, 0, node);
      node.parentNode = host;
      return node;
    },
    querySelector(sel) {
      const byClass = sel.match(/^\.([\w-]+)$/);
      const byDataState = sel.match(/^\[data-cs-state\]$/);
      const byDataItem = sel.match(/^\[data-cs-item="([^"]+)"\]$/);
      const byDataInteraction = sel.match(/^\[data-cs-interaction="([^"]+)"\]$/);
      const walk = (node: StubEl): StubEl | null => {
        for (const child of node.children) {
          if (byClass && (` ${child.className} `).includes(` ${byClass[1]} `)) return child;
          if (byDataState && child.dataset.csState !== undefined) return child;
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

  beforeEach(async () => {
    vi.resetModules();
    anchor = makeEl('div');
    root = makeEl('div');
    root.appendChild(anchor);
    inserts = [];
    const realInsert = anchor.insertBefore.bind(anchor.parentNode as StubEl);
    // 面板挂载走 anchor.parentNode.insertBefore(panel, anchor)。
    (anchor.parentNode as StubEl).insertBefore = (node, before) => {
      inserts.push({ node, before });
      return realInsert(node, before);
    };
    g.window = g; // classic script 通过 window.* 挂载
    g.document = { createElement: (tag: string) => makeEl(tag) };
    g.CSS = { escape: (v: string) => v };
    g.createLogger = () => ({ info() {}, warn() {}, error() {} });
    await import('../../src/renderer/modules/chat-stream.js');
  });

  it('turn.started 创建面板挂 anchor 之前，同 turn 幂等', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'commander', startedAt: '' });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].before).toBe(anchor);

    handle({ type: 'chat.item', turnId: 'T1', itemId: 'i1', kind: 'reasoning', status: 'completed', payload: { text: 'x' } });
    expect(inserts).toHaveLength(1);
  });

  it('toolExecution 三相位更新同一卡片', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't9', kind: 'toolExecution', status: 'inProgress', payload: { toolName: 'Bash', argsSummary: 'npm test' } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 't9', kind: 'toolExecution', status: 'completed', payload: { toolName: 'Bash', output: 'done' } });

    const panel = inserts[0].node;
    const body = panel.querySelector('.cs-panel-body')!;
    const cards = body.children.filter((c) => c.dataset.csItem === 't9');
    expect(cards).toHaveLength(1);
    expect(cards[0].innerHTML).toContain('Bash');
    expect(cards[0].innerHTML).toContain('done');
  });

  it('text kind 跳过（老 delta 通道渲染正文）', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'tx', kind: 'text', status: 'inProgress', payload: { delta: '正文' } });
    const body = inserts[0].node.querySelector('.cs-panel-body')!;
    expect(body.children.some((c) => c.dataset.csItem === 'tx')).toBe(false);
  });

  it('turn.completed 收尾并更新状态类名', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({ type: 'chat.turn.completed', turnId: 'T1', status: 'completed', endedAt: '' });
    expect(inserts[0].node.className).toContain('done');

    handle({ type: 'chat.turn.started', turnId: 'T2', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({ type: 'chat.turn.completed', turnId: 'T2', status: 'failed', error: 'boom', endedAt: '' });
    const failed = inserts[1].node;
    expect(failed.className).toContain('failed');
    expect(failed.querySelector('[data-cs-state]')!.textContent).toContain('boom');
  });

  it('usage 卡渲染并含上下文告警，diff 卡渲染增删行', () => {
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'u1', kind: 'usage', status: 'completed', payload: { inputTokens: 100, contextWindowRatio: 0.92 } });
    handle({ type: 'chat.item', turnId: 'T1', itemId: 'd1', kind: 'fileChange', status: 'completed', payload: { filePath: '/a.ts', diff: '+added\n-removed\n ctx' } });
    const panel = inserts[0].node;
    const body = panel.querySelector('.cs-panel-body')!;
    const usage = body.children.find((c) => c.dataset.csItem === 'u1');
    expect(usage!.innerHTML).toContain('上下文接近上限');
    const diff = body.children.find((c) => c.dataset.csItem === 'd1');
    expect(diff!.innerHTML).toContain('cs-diff-line add');
    expect(diff!.innerHTML).toContain('cs-diff-line del');
  });

  it('reset 清空面板；垃圾事件不抛错', () => {
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

    const body = inserts[0].node.querySelector('.cs-panel-body')!;
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
    const body = inserts[0].node.querySelector('.cs-panel-body')!;
    const card = body.children.find((c) => (c.dataset as Record<string, string>).csInteraction === 'q-1');
    expect(card).toBeTruthy();
    expect(card!.innerHTML).not.toContain('cs-interaction-actions');
  });

  it('bash 审批桥接：镜像卡挂同 cid 面板，dismiss 撤卡，无面板时跳过', () => {
    const bridge = g.window.chatStreamBridgeBashPermission as (i: unknown) => void;
    const dismiss = g.window.chatStreamDismissBashPermission as (id: string) => void;

    // 无面板：静默跳过不抛错。
    expect(() => bridge({ request_id: 'bp-1', cid: 'c-9', command: 'rm -rf x' })).not.toThrow();

    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    bridge({
      request_id: 'bp-1', cid: 'c-1', agent_name: 'coder',
      command: 'rm -rf dist', reasons: ['dangerous_delete'],
    });
    const body = inserts[0].node.querySelector('.cs-panel-body')!;
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

    const body = inserts[0].node.querySelector('.cs-panel-body')!;
    const card = body.children.find((c) => (c.dataset as Record<string, string>).csInteraction === 'br-1');
    expect(card).toBeTruthy();
    const actions = card!.children.find((c) => c.className.includes('cs-interaction-actions'))!;
    const labels = actions.children.map((b) => b.textContent);
    expect(labels).toContain('总是允许');
    expect(labels).not.toContain('本任务内允许');
  });

  it('chatStreamHasPanel 按 cid 判定；历史重建：tool start/end 合并一卡、默认收起、幂等', () => {
    const hasPanel = g.window.chatStreamHasPanel as (c: string) => boolean;
    expect(hasPanel('c-1')).toBe(false);
    handle({ type: 'chat.turn.started', turnId: 'T1', cid: 'c-1', actorId: 'a', startedAt: '' });
    expect(hasPanel('c-1')).toBe(true);
    expect(hasPanel('c-other')).toBe(false);

    const render = g.window.chatStreamRenderPersisted as (c: string, m: unknown, i: unknown, o?: unknown) => boolean;
    const msgDiv = makeEl('div');
    root.appendChild(msgDiv);
    const items = [
      { type: 'event', event: { stream: 'tool', data: { phase: 'start', id: 't1', name: 'Bash', arguments: { command: 'ls' } } } },
      { type: 'event', event: { stream: 'tool', data: { phase: 'end', id: 't1', name: 'Bash', output: 'ok' } } },
      { type: 'progress', text: '思考中' },
    ];
    expect(render('c-1', msgDiv, items, { actorName: 'agent', turnId: 'hist-1' })).toBe(true);

    const panel = root.children.find((c) => (c.dataset as Record<string, string>).csTurn === 'c-1::hist-1')!;
    expect(panel).toBeTruthy();
    const body = panel.querySelector('.cs-panel-body')!;
    const cards = body.children.filter((c) => c.className.includes('cs-toolExecution'));
    expect(cards).toHaveLength(1);
    expect(cards[0].innerHTML).toContain('ok');
    expect(panel.className).toContain('done');
    // 默认展开（过程可见）；显式 expanded:false 才收起。
    expect(body.style.display).not.toBe('none');
    render('c-1', msgDiv, items, { actorName: 'agent', turnId: 'hist-1', expanded: false });
    const collapsed = root.children.find((c) => (c.dataset as Record<string, string>).csTurn === 'c-1::hist-1')!;
    expect(collapsed.querySelector('.cs-panel-body')!.style.display).toBe('none');

    // 同 turnId 重建幂等：旧面板移除、只留一个。
    render('c-1', msgDiv, items, { actorName: 'agent', turnId: 'hist-1' });
    const panels = root.children.filter((c) => (c.dataset as Record<string, string>).csTurn === 'c-1::hist-1');
    expect(panels).toHaveLength(1);

    // 空数组/缺父节点返回 false。
    expect(render('c-1', msgDiv, [], {})).toBe(false);
  });
});
