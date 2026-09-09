// ─── interaction-hub 单元测试 ───────────────────────────────────────────────
//
// 契约语义（spec.md「事件契约」Interaction 部分）：
// 1. approval 三决策 + 超时拒绝；
// 2. question 文本回复 + 超时放弃（无 answer）；
// 3. 晚到回复幂等（未知/已关闭 id 返回 false，不误答新交互）；
// 4. Turn 取消连带关闭（decision=deny）；
// 5. broadcast 失败立即拒绝（不悬等超时）。

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _setBroadcastForTest,
  cancelInteractionsForTurn,
  pendingInteractionCount,
  requestInteraction,
  respondInteraction,
} from '../../../../src/main/features/chat_events/interaction-hub';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    uid: 'u1',
    cid: 'c1',
    turnId: 'T1',
    kind: 'approval' as const,
    prompt: '执行 rm -rf dist？',
    detail: 'rm -rf dist',
    approvalCategory: 'bash' as const,
    timeoutMs: 60,
    ...overrides,
  };
}

// 取消所有未决交互，隔离用例间的 pending 状态。
afterEach(() => {
  cancelInteractionsForTurn('*');
});

describe('interaction hub', () => {
  it('approval：allow / allowAlways / deny 三决策', async () => {
    const events: unknown[] = [];
    _setBroadcastForTest((_uid, ev) => events.push(ev));
    const requestedIds = () => events
      .filter((e) => (e as { type: string }).type === 'chat.interaction.requested')
      .map((e) => (e as { interactionId: string }).interactionId);

    const p1 = requestInteraction(baseInput());
    expect(respondInteraction(requestedIds()[0], { decision: 'allow' })).toBe(true);
    await expect(p1).resolves.toMatchObject({ reason: 'answered', decision: 'allow' });

    const p2 = requestInteraction(baseInput({ prompt: '写文件？' }));
    respondInteraction(requestedIds()[1], { decision: 'allowAlways' });
    await expect(p2).resolves.toMatchObject({ decision: 'allowAlways' });

    const p3 = requestInteraction(baseInput({ prompt: '调外部服务？' }));
    respondInteraction(requestedIds()[2], { decision: 'nope' }); // 未知值一律 deny
    await expect(p3).resolves.toMatchObject({ decision: 'deny' });

    // 每次交互广播 requested + closed 成对出现。
    expect(events.filter((e) => (e as { type: string }).type === 'chat.interaction.requested')).toHaveLength(3);
    expect(events.filter((e) => (e as { type: string }).type === 'chat.interaction.closed')).toHaveLength(3);
  });

  it('超时按 deny 处理且带 closed(timeout) 事件', async () => {
    vi.useFakeTimers();
    try {
      const events: unknown[] = [];
      _setBroadcastForTest((_uid, ev) => events.push(ev));
      const p = requestInteraction(baseInput({ timeoutMs: 50 }));
      vi.advanceTimersByTime(60);
      await expect(p).resolves.toMatchObject({ reason: 'timeout', decision: 'deny' });
      const closed = events.find((e) => (e as { type: string }).type === 'chat.interaction.closed') as { reason: string };
      expect(closed.reason).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('question：文本回复；超时无 answer', async () => {
    const events: unknown[] = [];
    _setBroadcastForTest((_uid, ev) => events.push(ev));

    vi.useFakeTimers();
    try {
      const p = requestInteraction(baseInput({ kind: 'question', prompt: '用哪个分支？', timeoutMs: 50 }));
      const id = (events[0] as { interactionId: string }).interactionId;
      respondInteraction(id, { answer: 'feature/x' });
      await expect(p).resolves.toMatchObject({ reason: 'answered', answer: 'feature/x' });

      const p2 = requestInteraction(baseInput({ kind: 'question', prompt: '还要继续吗？', timeoutMs: 50 }));
      vi.advanceTimersByTime(60);
      const r = await p2;
      expect(r.reason).toBe('timeout');
      expect(r.answer).toBeUndefined();
      expect(r.decision).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('晚到回复幂等：未知 id 拒收，不误伤进行中的新交互', async () => {
    const events: unknown[] = [];
    _setBroadcastForTest((_uid, ev) => events.push(ev));

    vi.useFakeTimers();
    try {
      const p1 = requestInteraction(baseInput({ timeoutMs: 50 }));
      const id1 = (events[0] as { interactionId: string }).interactionId;
      vi.advanceTimersByTime(60);
      await p1;
      // 已超时关闭后再回复 → false。
      expect(respondInteraction(id1, { decision: 'allow' })).toBe(false);

      // 新交互不受旧回复影响。
      const p2 = requestInteraction(baseInput({ prompt: '第二条', timeoutMs: 5000 }));
      const id2 = (events[events.length - 1] as { interactionId: string }).interactionId;
      expect(id2).not.toBe(id1);
      respondInteraction(id2, { decision: 'deny' });
      await expect(p2).resolves.toMatchObject({ decision: 'deny' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('Turn 取消连带关闭该 Turn 全部未决交互', async () => {
    const events: unknown[] = [];
    _setBroadcastForTest((_uid, ev) => events.push(ev));

    const p1 = requestInteraction(baseInput({ turnId: 'TX', prompt: 'A', timeoutMs: 60000 }));
    const p2 = requestInteraction(baseInput({ turnId: 'TX', prompt: 'B', timeoutMs: 60000 }));
    requestInteraction(baseInput({ turnId: 'TY', prompt: '其他 Turn', timeoutMs: 60000 }));

    expect(pendingInteractionCount()).toBe(3);
    const closed = cancelInteractionsForTurn('TX');
    expect(closed).toBe(2);

    await expect(p1).resolves.toMatchObject({ reason: 'turnCancelled', decision: 'deny' });
    await expect(p2).resolves.toMatchObject({ reason: 'turnCancelled' });
    // TY 不受影响。
    expect(pendingInteractionCount()).toBe(1);
    cancelInteractionsForTurn('TY');
  });

  it('broadcast 抛错立即拒绝（快速失败不等超时）', async () => {
    _setBroadcastForTest(() => { throw new Error('push channel broken'); });
    const p = requestInteraction(baseInput({ timeoutMs: 60000 }));
    await expect(p).resolves.toMatchObject({ reason: 'timeout', decision: 'deny' });
  });
});
