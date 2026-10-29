// ─── 过程折叠第二刀：chat.* 事件的 actor 归属锚点 ────────────────────────────
//
// 契约（2026-10-13 需求 B/C）：`chat.turn.started` 带 actorId，活动流必须挂到
// **该 actor 自己的**占位气泡；后续只带 turnId 的 chat.item / turn.completed
// 复用同一锚点。不这样做时派单链里 commander 与 worker 的活动流同挂发送占位
// → 折叠条归属错（看起来像主 Agent 在执行）、一次任务画成两条并行线。
//
// conversation.js 是 classic script，用源码抽取 + vm 注入 `_ensureActorPlaceholder`
// 桩验证解析契约（与 conversation-handoff-process.test.ts 同法）。

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function extractConst(name: string): string {
  const re = new RegExp(`const ${name} = [^;]*;`);
  const m = source.match(re);
  if (!m) throw new Error(`missing const ${name}`);
  return m[0];
}

interface AnchorEl { id: string; parentElement: { id: string } | null }
interface EnsureCall { cid: string; actorId: string; turnId: unknown; fallback: AnchorEl | null; contentBearing: boolean }

function makeEl(id: string, attached = true): AnchorEl {
  return { id, parentElement: attached ? { id: `${id}-host` } : null };
}

function loadResolver() {
  const combined = [
    extractConst('_chatStreamAnchors'),
    extractFunction('_normaliseTurnId'),
    extractFunction('_chatAnchorKey'),
    extractFunction('_forgetChatStreamAnchors'),
    extractFunction('_resolveChatStreamAnchor'),
    extractFunction('_yieldedFloorActor'),
    '({ resolve: _resolveChatStreamAnchor, forget: _forgetChatStreamAnchors, yielded: _yieldedFloorActor, anchors: _chatStreamAnchors, calls, placeholders })',
  ].join('\n');
  const calls: EnsureCall[] = [];
  const placeholders: Record<string, AnchorEl | null> = {
    commander: makeEl('ph-commander'),
    w1: makeEl('ph-w1'),
    detached: makeEl('ph-detached', false),
  };
  const ctx = {
    calls,
    placeholders,
    currentCid: 'c-1',
    _ensureActorPlaceholder: (cid: string, actorId: string, fallback: AnchorEl | null, turnId: unknown, _msg?: unknown, _started?: unknown, opts?: { contentBearing?: boolean }) => {
      calls.push({ cid, actorId, turnId, fallback, contentBearing: !!opts?.contentBearing });
      return placeholders[actorId] ?? null;
    },
  };
  vm.createContext(ctx);
  return vm.runInContext(combined, ctx) as {
    resolve: (cid: string, ev: unknown, fallback: AnchorEl | null, turnIdHint?: unknown) => AnchorEl | null;
    forget: (cid: string) => void;
    yielded: (state: unknown) => string;
    anchors: Map<string, { el: AnchorEl; actorId: string }>;
    calls: EnsureCall[];
    placeholders: Record<string, AnchorEl | null>;
  };
}

describe('chat.* 过程折叠锚点（按 actor 归属）', () => {
  it('turn.started 用 actorId 领养该 actor 自己的气泡，并把锚点记进 (cid, turnId)', () => {
    const r = loadResolver();
    const fallback = makeEl('send-placeholder');
    const got = r.resolve('c-1', { type: 'chat.turn.started', turnId: 'T1', actorId: 'w1' }, fallback);
    expect(got).toBe(r.placeholders.w1);
    expect(r.calls).toEqual([{ cid: 'c-1', actorId: 'w1', turnId: 'T1', fallback, contentBearing: true }]);
    expect(r.anchors.get('c-1::turn:T1')).toEqual({ el: r.placeholders.w1, actorId: 'w1' });
  });

  it('后续 chat.item / turn.completed 只带 turnId 也回查同一锚点（不再领养）', () => {
    const r = loadResolver();
    const fallback = makeEl('send-placeholder');
    r.resolve('c-1', { type: 'chat.turn.started', turnId: 'T1', actorId: 'w1' }, fallback);
    const other = makeEl('other-placeholder');
    expect(r.resolve('c-1', { type: 'chat.item', turnId: 'T1' }, other)).toBe(r.placeholders.w1);
    expect(r.resolve('c-1', { type: 'chat.turn.completed', turnId: 'T1', status: 'completed' }, other))
      .toBe(r.placeholders.w1);
    expect(r.calls).toHaveLength(1);
  });

  it('commander 与 worker 各自回合拿到各自气泡（一次任务不是两条并行线）', () => {
    const r = loadResolver();
    const fallback = makeEl('send-placeholder');
    const cmdAnchor = r.resolve('c-1', { type: 'chat.turn.started', turnId: 'T-cmd', actorId: 'commander' }, fallback);
    const workerAnchor = r.resolve('c-1', { type: 'chat.turn.started', turnId: 'T-w1', actorId: 'w1' }, fallback);
    expect(cmdAnchor).toBe(r.placeholders.commander);
    expect(workerAnchor).toBe(r.placeholders.w1);
    expect(cmdAnchor).not.toBe(workerAnchor);
    expect(r.resolve('c-1', { type: 'chat.item', turnId: 'T-w1' }, fallback)).toBe(r.placeholders.w1);
    expect(r.resolve('c-1', { type: 'chat.item', turnId: 'T-cmd' }, fallback)).toBe(r.placeholders.commander);
  });

  it('领养失败（无占位/已脱树）退回调用方给的兜底锚点，不产生 target missing', () => {
    const r = loadResolver();
    const fallback = makeEl('send-placeholder');
    expect(r.resolve('c-1', { type: 'chat.turn.started', turnId: 'T9', actorId: 'ghost' }, fallback)).toBe(fallback);
    expect(r.resolve('c-1', { type: 'chat.turn.started', turnId: 'T10', actorId: 'detached' }, fallback)).toBe(fallback);
  });

  it('锚点被历史重建摘出 DOM：按 actor 重新领养/新建，不把活动流画进脱树节点', () => {
    // 真机 2026-10-14 00:30：commander 派单后 seg 气泡被历史回放重建摘掉，
    // 发送占位同时脱树 → 收尾综合的 30 条 process 事件全被丢弃。
    const r = loadResolver();
    const fallback = makeEl('send-placeholder');
    r.resolve('c-1', { type: 'chat.turn.started', turnId: 'T1', actorId: 'commander' }, fallback);
    expect(r.calls).toHaveLength(1);
    r.placeholders.commander!.parentElement = null;
    fallback.parentElement = null;
    r.placeholders.commander = makeEl('ph-commander-rebuilt');
    const again = r.resolve('c-1',
      { type: 'chat.item', turnId: 'T1', itemId: 'i1', kind: 'text', status: 'inProgress', payload: { delta: 'x' } },
      fallback);
    expect(again).toBe(r.placeholders.commander);
    expect(again).not.toBe(fallback);
    // 重新领养必须标记「带内容」：空内容的状态扫描仍不许 mint 出闪空气泡。
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]).toMatchObject({ actorId: 'commander', contentBearing: true });
    expect(r.anchors.get('c-1::turn:T1')).toEqual({ el: r.placeholders.commander, actorId: 'commander' });
  });

  it('重新领养也拿不到活气泡时才退回兜底（不制造第二个锚点）', () => {
    const r = loadResolver();
    const fallback = makeEl('send-placeholder');
    r.resolve('c-1', { type: 'chat.turn.started', turnId: 'T1', actorId: 'w1' }, fallback);
    r.placeholders.w1!.parentElement = null;
    fallback.parentElement = null;
    expect(r.resolve('c-1', { type: 'chat.item', turnId: 'T1' }, fallback)).toBe(fallback);
  });

  it('未知 turnId 与其它 cid 落回兜底锚点（跨会话不串流）', () => {    const r = loadResolver();
    const fallback = makeEl('send-placeholder');
    r.resolve('c-1', { type: 'chat.turn.started', turnId: 'T1', actorId: 'w1' }, fallback);
    expect(r.resolve('c-1', { type: 'chat.item', turnId: 'T-other' }, fallback)).toBe(fallback);
    expect(r.resolve('c-2', { type: 'chat.item', turnId: 'T1' }, fallback)).toBe(fallback);
    expect(r.resolve('', { type: 'chat.item', turnId: 'T1' }, fallback)).toBe(fallback);
  });

  it('会话切换/重发时清掉该 cid 的锚点（不复用已作废的 DOM 节点）', () => {
    const r = loadResolver();
    const fallback = makeEl('send-placeholder');
    r.resolve('c-1', { type: 'chat.turn.started', turnId: 'T1', actorId: 'w1' }, fallback);
    r.resolve('c-2', { type: 'chat.turn.started', turnId: 'T2', actorId: 'commander' }, fallback);
    r.forget('c-1');
    expect(r.anchors.has('c-1::turn:T1')).toBe(false);
    expect(r.anchors.has('c-2::turn:T2')).toBe(true);
    expect(r.resolve('c-1', { type: 'chat.item', turnId: 'T1' }, fallback)).toBe(fallback);
  });
});

describe('话权归属判定（交出方终态化的触发条件）', () => {
  // 「运行指示 = 持有 floor」：只有话权落到**某个 agent** 时才需要把交出方
  // 终态化；空 / commander / user 都不触发（否则主 Agent 一开局就被冻结）。
  it('只有 floor 落到 agent 时返回该 agent，其余一律不触发', () => {
    const r = loadResolver();
    expect(r.yielded({ active_recipient: 'w1' })).toBe('w1');
    expect(r.yielded({ active_recipient: 'agent-2a2d' })).toBe('agent-2a2d');
    expect(r.yielded({ active_recipient: '' })).toBe('');
    expect(r.yielded({ active_recipient: 'commander' })).toBe('');
    expect(r.yielded({ active_recipient: 'user' })).toBe('');
    expect(r.yielded({})).toBe('');
    expect(r.yielded(undefined)).toBe('');
  });
});
