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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    addEventListener(_type: string, _fn: () => void) { /* stub */ },
    setAttribute() { /* stub */ },
    appendChild(child) { el.children.push(child); child.parentNode = el; return child; },
    insertBefore(node, before) {
      const idx = el.children.indexOf(before);
      el.children.splice(idx < 0 ? el.children.length : idx, 0, node);
      node.parentNode = el;
      return node;
    },
    querySelector(sel) {
      const byClass = sel.match(/^\.([\w-]+)$/);
      const byDataState = sel.match(/^\[data-cs-state\]$/);
      const byDataItem = sel.match(/^\[data-cs-item="([^"]+)"\]$/);
      const walk = (node: StubEl): StubEl | null => {
        for (const child of node.children) {
          if (byClass && (` ${child.className} `).includes(` ${byClass[1]} `)) return child;
          if (byDataState && child.dataset.csState !== undefined) return child;
          if (byDataItem && child.dataset.csItem === byDataItem[1]) return child;
          const nested = walk(child);
          if (nested) return nested;
        }
        return null;
      };
      return walk(el);
    },
    remove() { el.connected = false; },
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
});
