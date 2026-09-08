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
  it('rate is disabled (rateText always null)', () => {
    expect(messageMetricsLine(base)?.rateText).toBeNull();
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
    expect(f.inText).toBe('1K'); // 对账口径三项和（合并定稿）；主读数走 inFreshText
    expect(f.outText).toBe('100');
    expect(f.costText).toBeNull();
    // 上下文占用 = 最近一次 usage 的 prompt 侧压力 input+cacheRead+cacheWrite
    // （100+500+0=600，600/4000=15%，与 DSH pressureFrom 口径一致）
    expect(f.ctxText).toBe('600/4K·15%');
    expect(f.ctxHot).toBe(false);
  });
  it('cache hit uses billedInput denominator (DSH parity), inText keeps 3-term sum', () => {
    const f = foldSessionMetrics(
      [m({ usage: { inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 100 } })],
      { contextWindow: null, price: null },
    );
    // 300/(100+300+100)=60%，含 cacheWrite（与 DSH billedInputTokens 口径一致；
    // 2026-09-08 合并定稿：cacheHitText 统一 PR198 的 DSH 口径）
    expect(f.cacheHitText).toBe('60%');
    // inText 对账口径（PR198）：input+cacheRead+cacheWrite 三项和；
    // 主显示读数走 inFreshText（2026-09-08 分层定稿）
    expect(f.inText).toBe('500');
    // 展示层拆分（4a）：纯 fresh 输入与缓存读单独输出，供主读数拆开标注
    expect(f.inFreshText).toBe('100');
    expect(f.cacheReadText).toBe('300');
  });
  it('inFreshText/cacheReadText stay null when no fresh input or no cache read', () => {
    const noCache = foldSessionMetrics(
      [m({ usage: { inputTokens: 200, outputTokens: 10 } })],
      { contextWindow: null, price: null },
    );
    expect(noCache.inFreshText).toBe('200');
    expect(noCache.cacheReadText).toBeNull();
    const onlyCache = foldSessionMetrics(
      [m({ usage: { cacheReadTokens: 400, outputTokens: 10 } })],
      { contextWindow: null, price: null },
    );
    expect(onlyCache.inFreshText).toBeNull();
    expect(onlyCache.cacheReadText).toBe('400');
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
