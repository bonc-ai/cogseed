/**
 * glossary-confirm — 高危候选点选确认的 token 状态机
 *
 * 这组测试守的是"用户到底授权了什么"这件事，因为它是**唯一**能把
 * `risk=high` 的中文短词放进正式产物的闸门：
 *   - 令牌一次性：同一次授权不能重放；
 *   - 令牌绑定正文：用户对着 A 稿点的勾，不能套到 B 稿上（`stale`）；
 *   - 只认发卡时真实存在的 entryRef：渲染层传来别的 ref 一律丢弃；
 *   - 空集是合法结果（用户全不选），不等于失败。
 *
 * 数据隔离：`test/setup-env.ts` 已把数据根指到本轮临时目录。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// 广播会被打桩：这些用例只验证状态机，不验证渲染层。
const broadcasts: Array<{ channel: string; payload: unknown }> = [];
vi.mock('../../../../src/main/ipc', () => ({
  broadcastToRenderer: (channel: string, payload: unknown) => {
    broadcasts.push({ channel, payload });
  },
}));

import {
  buildConfirmItems,
  listPendingGlossaryConfirmations,
  consumeGlossaryConfirmation,
  createGlossaryConfirmation,
  markGlossaryConfirmationVisible,
  resolveGlossaryConfirmation,
  waitForGlossaryConfirmationVisible,
} from '../../../../src/main/model/core-agent/glossary-confirm';
import type { CorrectionCandidate } from '../../../../src/main/features/transcript_auto_correct';

function candidate(over: Partial<CorrectionCandidate>): CorrectionCandidate {
  return {
    entryRef: 'g_1',
    wrong: '健全',
    correct: '鉴权',
    action: 'replace',
    confidence: 1,
    riskLevel: 'high',
    context: '生态健全度',
    span: { start: 0, end: 2 },
    ignoredCount: 0,
    contextAllow: [],
    ...over,
  } as CorrectionCandidate;
}

const TEXT = '生态健全度不足，另外 coxy 也要改。';

beforeEach(() => {
  broadcasts.length = 0;
});

describe('buildConfirmItems：按 entryRef 聚合，同词只问一次', () => {
  it('同一 entryRef 的多次命中合并成一条，count 累加', () => {
    const items = buildConfirmItems([
      candidate({ entryRef: 'g_a', span: { start: 0, end: 2 } }),
      candidate({ entryRef: 'g_a', span: { start: 10, end: 12 } }),
      candidate({ entryRef: 'g_b', wrong: 'coxy', correct: 'Cogseed', span: { start: 20, end: 24 } }),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].entryRef).toBe('g_a');
    expect(items[0].count).toBe(2);
    expect(items[1].entryRef).toBe('g_b');
    expect(items[1].count).toBe(1);
  });

  it('丢弃没有 entryRef 的候选，并截断上下文预览', () => {
    const items = buildConfirmItems([
      candidate({ entryRef: '', span: { start: 0, end: 2 } }),
      candidate({ entryRef: 'g_c', context: 'x'.repeat(200) }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].context.length).toBeLessThanOrEqual(60);
  });

  it('尊重条数上限（卡片是给人点的，不能无限长）', () => {
    const many = Array.from({ length: 60 }, (_v, i) => candidate({ entryRef: `g_${i}` }));
    expect(buildConfirmItems(many, 40)).toHaveLength(40);
  });
});

describe('发卡 + 可见回执', () => {
  it('createGlossaryConfirmation 广播 confirmation_required 并下发票据', async () => {
    const promise = createGlossaryConfirmation({
      text: TEXT,
      docId: 'doc_1',
      items: buildConfirmItems([candidate({})]),
      cid: 'c1',
      turnId: 't1',
    });
    // 渲染层回执前，卡片视为不可见。
    const token = await (async () => {
      // 先让广播发生，再回执。
      await Promise.resolve();
      const pending = broadcasts.find((b) => b.channel === 'transcript_glossary.confirmation_required');
      expect(pending).toBeTruthy();
      const payload = pending!.payload as { confirm_id: string; items: unknown[]; cid: string; turn_id: string };
      expect(payload.items).toHaveLength(1);
      expect(payload.cid).toBe('c1');
      expect(payload.turn_id).toBe('t1');
      markGlossaryConfirmationVisible(payload.confirm_id);
      return payload.confirm_id;
    })();
    const res = await promise;
    expect(res.token).toBe(token);
    expect(res.visible).toBe(true);
  });

  it('渲染层没回执时 visible=false（调用方据此改用文字问），但令牌仍可用', async () => {
    const p = createGlossaryConfirmation({
      text: TEXT,
      docId: 'doc_2',
      items: buildConfirmItems([candidate({})]),
    });
    const res = await p; // 等满 ACK 超时（1200ms）
    expect(res.visible).toBe(false);
    expect(res.token).toBeTruthy();
    expect(resolveGlossaryConfirmation(res.token, ['g_1'])).toBe(true);
  }, 10_000);

  it('waitForGlossaryConfirmationVisible 对未知令牌返回 false（不挂起）', async () => {
    await expect(waitForGlossaryConfirmationVisible('nope', 50)).resolves.toBe(false);
  });

  it('markGlossaryConfirmationVisible 对未知令牌返回 false', () => {
    expect(markGlossaryConfirmationVisible('nope')).toBe(false);
  });
});

describe('resolveGlossaryConfirmation：只接受发卡时存在的 entryRef', () => {
  async function issue(text = TEXT, refs = ['g_1', 'g_2']) {
    const p = createGlossaryConfirmation({
      text,
      docId: 'doc_r',
      items: refs.map((r) => buildConfirmItems([candidate({ entryRef: r })])[0]),
    });
    await Promise.resolve();
    const payload = broadcasts[0].payload as { confirm_id: string };
    return payload.confirm_id;
  }

  it('未在清单里的 entryRef 被丢弃（不信任渲染层传来的任意集合）', async () => {
    const token = await issue();
    expect(resolveGlossaryConfirmation(token, ['g_1', 'g_injected', 'g_2'])).toBe(true);
    const res = consumeGlossaryConfirmation(token, TEXT);
    expect(res.outcome).toBe('accepted');
    if (res.outcome === 'accepted') {
      expect(res.acceptedIds.sort()).toEqual(['g_1', 'g_2']);
    }
  });

  it('acceptAll 勾选全部', async () => {
    const token = await issue();
    resolveGlossaryConfirmation(token, [], true);
    const res = consumeGlossaryConfirmation(token, TEXT);
    expect(res.outcome).toBe('accepted');
    if (res.outcome === 'accepted') expect(res.acceptedIds.sort()).toEqual(['g_1', 'g_2']);
  });

  it('空集是合法结果（用户全不选）', async () => {
    const token = await issue();
    resolveGlossaryConfirmation(token, []);
    const res = consumeGlossaryConfirmation(token, TEXT);
    expect(res.outcome).toBe('accepted');
    if (res.outcome === 'accepted') expect(res.acceptedIds).toEqual([]);
  });

  it('重复 resolve 被拒（令牌只能被答复一次）', async () => {
    const token = await issue();
    expect(resolveGlossaryConfirmation(token, ['g_1'])).toBe(true);
    expect(resolveGlossaryConfirmation(token, ['g_2'])).toBe(false);
  });

  it('未知令牌 resolve 返回 false', () => {
    expect(resolveGlossaryConfirmation('nope', ['g_1'])).toBe(false);
  });
});

describe('consumeGlossaryConfirmation：一次性 + 绑定正文', () => {
  async function issue(text = TEXT) {
    const p = createGlossaryConfirmation({
      text,
      docId: 'doc_c',
      items: buildConfirmItems([candidate({})]),
    });
    await Promise.resolve();
    const payload = broadcasts[0].payload as { confirm_id: string };
    return payload.confirm_id;
  }

  it('未点选前是 pending（模型应结束本轮等用户）', async () => {
    const token = await issue();
    expect(consumeGlossaryConfirmation(token, TEXT).outcome).toBe('pending');
  });

  it('消费即删除，不可重放', async () => {
    const token = await issue();
    resolveGlossaryConfirmation(token, ['g_1']);
    expect(consumeGlossaryConfirmation(token, TEXT).outcome).toBe('accepted');
    expect(consumeGlossaryConfirmation(token, TEXT).outcome).toBe('invalid');
  });

  it('正文变了 → stale（用户对着 A 稿点的勾不能套到 B 稿）', async () => {
    const token = await issue();
    resolveGlossaryConfirmation(token, ['g_1']);
    expect(consumeGlossaryConfirmation(token, TEXT + '多了几个字').outcome).toBe('stale');
  });

  it('stale 之后令牌作废，不能再用正确正文抢救', async () => {
    const token = await issue();
    resolveGlossaryConfirmation(token, ['g_1']);
    expect(consumeGlossaryConfirmation(token, 'different').outcome).toBe('stale');
    expect(consumeGlossaryConfirmation(token, TEXT).outcome).toBe('invalid');
  });

  it('未知令牌 → invalid', () => {
    expect(consumeGlossaryConfirmation('nope', TEXT).outcome).toBe('invalid');
  });
});

describe('durable pending card recovery', () => {
  it('returns visible but unanswered cards only to their owning user and conversation', async () => {
    const uid = 'glossary-recovery-user';
    const created = createGlossaryConfirmation({ userId: uid, cid: 'recovery-conv',
      text: TEXT, docId: 'recovery-doc', items: buildConfirmItems([candidate({})]) });
    const payload = broadcasts.at(-1)!.payload as { confirm_id: string };
    markGlossaryConfirmationVisible(payload.confirm_id);
    await created;
    expect(listPendingGlossaryConfirmations(uid, 'recovery-conv')).toHaveLength(1);
    expect(listPendingGlossaryConfirmations('other-user', 'recovery-conv')).toEqual([]);
    expect(listPendingGlossaryConfirmations(uid, 'other-conv')).toEqual([]);
    // Reading the recovery view must never decide or consume a token.
    expect(consumeGlossaryConfirmation(payload.confirm_id, TEXT, { userId: uid, cid: 'recovery-conv', docId: 'recovery-doc' })).toEqual({ outcome: 'pending' });
    resolveGlossaryConfirmation(payload.confirm_id, [], false);
    expect(listPendingGlossaryConfirmations(uid, 'recovery-conv')).toEqual([]);
  });
});
