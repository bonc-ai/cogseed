import { describe, it, expect } from 'vitest';
import {
  formatTokens, formatDuration, formatRate, formatLatency,
  messageMetricsLine, foldSessionMetrics,
} from '../../src/renderer/modules/conversation-metrics.js';

describe('formatTokens', () => {
  it('compacts like DSH', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(517)).toBe('517');
    expect(formatTokens(12200)).toBe('12.2K');
    expect(formatTokens(517000)).toBe('517K');
    expect(formatTokens(1200000)).toBe('1.2M');
  });
});

describe('formatDuration', () => {
  it('seconds under a minute, minutes beyond', () => {
    expect(formatDuration(45_200)).toBe('45.2s');
    expect(formatDuration(162_000)).toBe('2m42s');
  });
});

describe('formatRate / formatLatency', () => {
  it('one decimal under 10, integer from 10', () => {
    expect(formatRate(4.42)).toBe('4.4');
    expect(formatRate(146.6)).toBe('147');
    expect(formatLatency(2_140)).toBe('2.1');
    expect(formatLatency(12_300)).toBe('12');
  });
});

describe('messageMetricsLine', () => {
  const base = {
    startedAt: 1_000, firstTokenAt: 3_100, completedAt: 69_100,
    usage: { inputTokens: 12_200, outputTokens: 940 },
  };
  it('derives duration/latency/rate and omits rate when tools present', () => {
    const line = messageMetricsLine({ ...base, toolCalls: 3 });
    expect(line).not.toBeNull();
    expect(line.durationMs).toBe(68_100);
    expect(line.latencyText).toBe('2.1');
    expect(line.rateText).toBeNull();
    expect(line.inText).toBe('12.2K');
    expect(line.outText).toBe('940');
  });
  it('computes rate for tool-free turns', () => {
    expect(messageMetricsLine(base)?.rateText).toBe('14'); // 940 tok / 66s ≈ 14.2
  });
  it('returns null when nothing recorded', () => {
    expect(messageMetricsLine(null)).toBeNull();
  });
  it('builds cache title lines', () => {
    const line = messageMetricsLine({
      ...base,
      usage: { ...base.usage, cacheReadTokens: 50_000, cacheWriteTokens: 1_000 },
    });
    expect(line.titleLines.join(' ')).toContain('50K');
  });
});

describe('foldSessionMetrics', () => {
  const m = (over) => ({
    startedAt: 0, firstTokenAt: 2_000, completedAt: 10_000, ...over,
  });
  it('sums turns/steps/tokens and computes cache hit', () => {
    const f = foldSessionMetrics([
      m({ usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 300 } }),
      m({ usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 500 }, toolCalls: 2 }),
    ], { contextWindow: 4_000, price: null });
    expect(f.turns).toBe(2);
    // steps = Σ toolCalls（0 + 2 = 2），与设计 §98「步 = 该消息内工具调用次数」一致
    expect(f.steps).toBe(2);
    expect(f.cacheHitText).toBe('80%');
    expect(f.inText).toBe('1K');
    expect(f.outText).toBe('100');
    expect(f.costText).toBeNull();
    // 上下文占用 = 最近一次 usage 的 input+output（100+50=150，150/4000≈3.75%→4%）
    expect(f.ctxText).toBe('150/4K·4%');
    expect(f.ctxHot).toBe(false);
  });
  it('cache hit uses input+cacheRead denominator (dashboard ledger parity), inText keeps 3-term sum', () => {
    const f = foldSessionMetrics(
      [m({ usage: { inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 100 } })],
      { contextWindow: null, price: null },
    );
    // 300/(100+300)=75%，不含 cacheWrite（与 usage_ledger.ts dashboard 口径一致）
    expect(f.cacheHitText).toBe('75%');
    // inText 口径不变：input+cacheRead+cacheWrite 三项和
    expect(f.inText).toBe('500');
  });
  it('flags ctx >= 80%', () => {
    const f = foldSessionMetrics(
      [m({ usage: { inputTokens: 3_300, outputTokens: 0 } })],
      { contextWindow: 4_000, price: null },
    );
    expect(f.ctxHot).toBe(true);
  });
  it('estimates cost only with price', () => {
    const f = foldSessionMetrics(
      [m({ usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } })],
      { contextWindow: null, price: { in: 2, out: 8, cacheRead: 0.5, cacheWrite: 2 } },
    );
    // 单价为 ¥/百万 token：1M×2 + 1M×8 = ¥10
    expect(f.costText).toBe('¥10.00');
  });
});
