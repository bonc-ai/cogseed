import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  resetUsageLedgerForTests,
  appendUsageEvent,
  flushUsageLedger,
  usageStatsSince,
  usageLedgerDir,
  readUsageEvents,
  aggregateUsage,
} from '../../../src/main/features/usage_ledger';
import type { ModelUsageEvent } from '../../../src/main/model/core-agent/usage-events';

// Usage 账本 —— 事实流水，按月 jsonl 追加（<uid>/local/usage/usage-YYYY-MM.jsonl）。
// 与 workspace_meta 的「派生缓存」不同：这份数据丢了不可重建，所以追加写、
// 永不覆盖。统计起点（since）随首条记录写入，界面用它明示「旧消耗不可回溯」。

const uid = '12155733';

function event(over: Partial<ModelUsageEvent> = {}): ModelUsageEvent {
  return {
    at: Date.parse('2026-08-26T10:00:00Z'),
    userId: uid,
    sessionId: 's1',
    conversationId: 'c1',
    agentId: 'a1',
    providerId: 'openai',
    modelId: 'gpt-5',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    totalTokens: 165,
    durationMs: 1200,
    status: 'completed',
    ...over,
  };
}

beforeEach(async () => {
  resetUsageLedgerForTests();
  await flushUsageLedger();
  fs.rmSync(usageLedgerDir(uid), { recursive: true, force: true });
});

afterEach(async () => {
  resetUsageLedgerForTests();
});

describe('usage ledger', () => {
  it('buffers appended events and writes them to the month file on flush', async () => {
    appendUsageEvent(uid, event());
    // 未 flush 前不落盘（缓冲合写是设计行为，不是丢失）
    const monthFile = path.join(usageLedgerDir(uid), 'usage-2026-08.jsonl');
    expect(fs.existsSync(monthFile)).toBe(false);

    await flushUsageLedger();
    const lines = fs.readFileSync(monthFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ agentId: 'a1', totalTokens: 165 });
  });

  it('writes the stats-since marker with the first record and never overwrites it', async () => {
    appendUsageEvent(uid, event());
    await flushUsageLedger();
    const sinceFile = path.join(usageLedgerDir(uid), 'since.json');
    expect(fs.existsSync(sinceFile)).toBe(true);
    const since = JSON.parse(fs.readFileSync(sinceFile, 'utf8')) as { since: string };
    expect(since.since).toBe('2026-08-26T10:00:00.000Z');
    expect(usageStatsSince(uid)).toBe('2026-08-26T10:00:00.000Z');

    // 更早的一条新记录不得把起点往前挪之外的情况：更晚的记录也不改起点
    appendUsageEvent(uid, event({ at: Date.parse('2026-08-27T10:00:00Z') }));
    await flushUsageLedger();
    expect(usageStatsSince(uid)).toBe('2026-08-26T10:00:00.000Z');
  });

  it('flushes automatically once the buffer reaches the batch threshold', async () => {
    const monthFile = path.join(usageLedgerDir(uid), 'usage-2026-08.jsonl');
    for (let i = 0; i < 50; i += 1) {
      appendUsageEvent(uid, event({ at: Date.parse('2026-08-26T10:00:00Z') + i }));
    }
    // 阈值触发的 flush 是异步在途写，等它完成再断言
    await flushUsageLedger();
    expect(fs.existsSync(monthFile)).toBe(true);
    const lines = fs.readFileSync(monthFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(50);
  });

  it('reads events across month files within a time range', async () => {
    appendUsageEvent(uid, event({ at: Date.parse('2026-07-31T23:00:00Z') }));
    appendUsageEvent(uid, event({ at: Date.parse('2026-08-01T01:00:00Z') }));
    appendUsageEvent(uid, event({ at: Date.parse('2026-08-15T00:00:00Z') }));
    await flushUsageLedger();

    const july = await readUsageEvents(uid, Date.parse('2026-07-01T00:00:00Z'), Date.parse('2026-08-01T00:00:00Z'));
    expect(july).toHaveLength(1);

    const both = await readUsageEvents(uid, Date.parse('2026-07-01T00:00:00Z'), Date.parse('2026-09-01T00:00:00Z'));
    expect(both).toHaveLength(3);
  });

  it('keeps per-user directories isolated', async () => {
    const other = '99999999';
    appendUsageEvent(uid, event());
    appendUsageEvent(other, event({ userId: other }));
    await flushUsageLedger();
    const mine = await readUsageEvents(uid, 0, Date.parse('2027-01-01T00:00:00Z'));
    const theirs = await readUsageEvents(other, 0, Date.parse('2027-01-01T00:00:00Z'));
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(theirs[0].userId).toBe(other);
    fs.rmSync(usageLedgerDir(other), { recursive: true, force: true });
  });
});

describe('usage aggregation', () => {
  async function seed(): Promise<void> {
    appendUsageEvent(uid, event({
      at: Date.parse('2026-08-26T10:00:00Z'), agentId: 'a1', conversationId: 'c1',
      inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800, totalTokens: 2000,
    }));
    appendUsageEvent(uid, event({
      at: Date.parse('2026-08-26T11:00:00Z'), agentId: 'a1', conversationId: 'c2',
      inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, totalTokens: 600,
    }));
    appendUsageEvent(uid, event({
      at: Date.parse('2026-08-27T09:00:00Z'), agentId: 'a2', conversationId: 'c1',
      inputTokens: 100, outputTokens: 50, totalTokens: 150,
      cacheReadTokens: undefined, cacheWriteTokens: undefined,
    }));
    await flushUsageLedger();
  }

  beforeEach(async () => {
    resetUsageLedgerForTests();
    await flushUsageLedger();
    fs.rmSync(usageLedgerDir(uid), { recursive: true, force: true });
    await seed();
  });

  const range = {
    from: Date.parse('2026-08-26T00:00:00Z'),
    to: Date.parse('2026-08-27T23:59:59Z'),
  };

  it('aggregates by day with token sums and call counts', async () => {
    const res = await aggregateUsage(uid, { dimension: 'day', ...range });
    expect(res.empty).toBe(false);
    expect(res.buckets).toHaveLength(2);
    const d26 = res.buckets.find((b) => b.key === '2026-08-26');
    expect(d26).toMatchObject({ calls: 2, inputTokens: 1500, outputTokens: 300, cacheReadTokens: 800 });
    const d27 = res.buckets.find((b) => b.key === '2026-08-27');
    expect(d27).toMatchObject({ calls: 1, inputTokens: 100 });
  });

  it('aggregates by agent and by conversation', async () => {
    const byAgent = await aggregateUsage(uid, { dimension: 'agent', ...range });
    expect(byAgent.buckets.find((b) => b.key === 'a1')).toMatchObject({ calls: 2, totalTokens: 2600 });
    expect(byAgent.buckets.find((b) => b.key === 'a2')).toMatchObject({ calls: 1 });

    const byConv = await aggregateUsage(uid, { dimension: 'conversation', ...range });
    expect(byConv.buckets.find((b) => b.key === 'c1')).toMatchObject({ calls: 2 });
    expect(byConv.buckets.find((b) => b.key === 'c2')).toMatchObject({ calls: 1 });
  });

  it('reports cache hit rate only when cache data exists, never as fake zero', async () => {
    const byAgent = await aggregateUsage(uid, { dimension: 'agent', ...range });
    const a1 = byAgent.buckets.find((b) => b.key === 'a1');
    // a1: cacheRead 800 / (input 1500 + cacheRead 800) = 0.3478…
    expect(a1?.cacheHitRate).toBeCloseTo(800 / 2300, 4);
    // a2 无任何 cache 字段记录 → rate 必须是 undefined，不许拿 0 冒充
    const a2 = byAgent.buckets.find((b) => b.key === 'a2');
    expect(a2?.cacheHitRate).toBeUndefined();
  });

  it('marks empty explicitly when the range has no records and always carries since', async () => {
    const res = await aggregateUsage(uid, {
      dimension: 'day',
      from: Date.parse('2025-01-01T00:00:00Z'),
      to: Date.parse('2025-01-31T00:00:00Z'),
    });
    expect(res.empty).toBe(true);
    expect(res.buckets).toEqual([]);
    expect(res.since).toBe('2026-08-26T10:00:00.000Z');
  });

  it('rejects unknown dimensions', async () => {
    await expect(aggregateUsage(uid, { dimension: 'nonsense' as 'day', ...range }))
      .rejects.toThrow(/dimension/);
  });
});
