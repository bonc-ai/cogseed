import { describe, it, expect } from 'vitest';
import {
  formatTokens, formatDuration, formatRate, formatLatency,
  messageMetricsLine, foldSessionMetrics, cacheHitPercentText, tokenUsageMetrics,
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
    usage: { inputTokens: 12_200, outputTokens: 940, cacheReadTokens: 0, cacheWriteTokens: 0 },
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
  it('metrics without usage (CLI turn after stats retirement) renders time-only, no crash', () => {
    // 2026-09-11 codex 会话整页加载失败事故的回归锚点：bus 剥 usage 后
    // metrics 只剩时间戳时保持未知，只展示已知的时间信息。
    const line = messageMetricsLine({
      startedAt: 1_000, firstTokenAt: 3_100, completedAt: 69_100,
    });
    expect(line).not.toBeNull();
    expect(line.durationMs).toBe(68_100);
    expect(line.inText).toBeNull();
    expect(line.outText).toBeNull();
    expect(line.cacheBadgeText).toBeNull();
  });
  it('hostile usage shapes never throw (2026-09-14 加固 fixtures)', () => {
    const shapes = [
      { usage: null },
      { usage: {} },
      { usage: { inputTokens: -5, outputTokens: 'x', cacheReadTokens: NaN } },
      { usage: 7 },
      { firstTokenAt: null },                       // 无 usage 且无 ttft → 提前返回
      { startedAt: 'bad', firstTokenAt: 2, completedAt: 3 },
      null,                                          // 整条 metrics 为空
      undefined,
    ];
    for (const extra of shapes) {
      const base = { startedAt: 1_000, firstTokenAt: 3_100, completedAt: 69_100 };
      const input = extra === null ? null : (extra === undefined ? undefined : { ...base, ...extra });
      expect(() => messageMetricsLine(input)).not.toThrow();
      const line = messageMetricsLine(input);
      if (line !== null) {
        expect(Number.isFinite(line.durationMs ?? NaN) || line.durationMs === null).toBe(true);
      }
    }
  });
});

describe('foldSessionMetrics', () => {
  const m = (over) => ({
    startedAt: 0, firstTokenAt: 2_000, completedAt: 10_000, ...over,
  });
  it('sums turns/steps/tokens and computes cache hit', () => {
    const f = foldSessionMetrics([
      m({ usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 0 } }),
      m({ usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 500, cacheWriteTokens: 0 }, toolCalls: 2 }),
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
  it('occupancy prefers lastCallUsage over the whole-run accumulation (2026-09-11)', () => {
    // 真机事故回归锚点：单轮 33 步工具循环，累加 usage 566K 被当作窗口占用
    // 显示。占用必须读最后一次调用的 prompt 侧用量；消耗行（inText 等）继续
    // 用累加口径。
    const f = foldSessionMetrics(
      [m({ usage: {
        inputTokens: 60_713, outputTokens: 17_083, cacheReadTokens: 505_216, cacheWriteTokens: 0,
        lastCallUsage: { inputTokens: 2_100, outputTokens: 900, cacheReadTokens: 15_400, cacheWriteTokens: 0 },
      } })],
      { contextWindow: 1_048_576, price: null },
    );
    // 占用 = lastCallUsage 的 prompt 侧三项和 = 17.5K（input 2.1K + 缓存读
    // 15.4K，不含 output；而非累加的 566K）
    expect(f.ctxText).toBe('17.5K/1M·2%');
    expect(f.ctxHot).toBe(false);
    // 消耗口径不变：inText 仍是累加三项和 566K
    expect(f.inText).toBe('566K');
    // 无 lastCallUsage 时回退累加（旧数据/CLI 回合兼容）
    const g = foldSessionMetrics(
      [m({ usage: { inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 0 } })],
      { contextWindow: 4_000, price: null },
    );
    expect(g.ctxText).toBe('400/4K·10%');
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
  it('preserves known zero fresh input while omitting a zero cache-read detail', () => {
    const noCache = foldSessionMetrics(
      [m({ usage: { inputTokens: 200, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } })],
      { contextWindow: null, price: null },
    );
    expect(noCache.inFreshText).toBe('200');
    expect(noCache.cacheReadText).toBeNull();
    const onlyCache = foldSessionMetrics(
      [m({ usage: { inputTokens: 0, cacheReadTokens: 400, cacheWriteTokens: 0, outputTokens: 10 } })],
      { contextWindow: null, price: null },
    );
    expect(onlyCache.inFreshText).toBe('0');
    expect(onlyCache.cacheReadText).toBe('400');
  });
  it('flags ctx >= 80%', () => {
    const f = foldSessionMetrics(
      [m({ usage: { inputTokens: 3_300, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } })],
      { contextWindow: 4_000, price: null },
    );
    expect(f.ctxHot).toBe(true);
  });
  it('estimates cost only with price', () => {
    const f = foldSessionMetrics(
      [m({ usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 } })],
      { contextWindow: null, price: { in: 2, out: 8, cacheRead: 0.5, cacheWrite: 2 } },
    );
    // 单价为 ¥/百万 token：1M×2 + 1M×8 = ¥10
    expect(f.costText).toBe('¥10.00');
  });
});

// 缓存命中率口径（对齐 DSH dsh-client-ui-chat::formatCacheHitPercent，见模块头注释）：
// 分母 = billedInput = input+cacheRead+cacheWrite；"部分命中"绝不允许显示成 100%。
// 这条公式以前只有实现没有测试——口径漂移过一次就会让 UI 撒谎，所以在此锁住。
describe('cacheHitPercentText', () => {
  it('denominator is the full prompt side (includes cacheWrite)', () => {
    // 50 命中 /(50 裸输入 + 50 命中 + 100 写入) = 25%
    expect(cacheHitPercentText(50, 50, 100)).toBe('25%');
    // 写入不计入分母时会算成 50%——那是口径错误
    expect(cacheHitPercentText(50, 50, 100)).not.toBe('50%');
  });

  it('reports 0% for uncached prompt input and null when nothing was billed', () => {
    expect(cacheHitPercentText(0, 100, 0)).toBe('0%');
    expect(cacheHitPercentText(0, 0, 0)).toBeNull();
  });

  it('reports 100% only when every billed token was a cache read', () => {
    expect(cacheHitPercentText(100, 0, 0)).toBe('100%');
    expect(cacheHitPercentText(10, 0, 10)).toBe('50%');
  });

  it('never rounds a partial hit up to 100%', () => {
    for (const [read, input, expected] of [
      [9999, 1, '99.99%'],
      [999999, 1, '99.9999%'],
      [99, 1, '99%'],
      [99999, 3, '99.997%'],
    ] as const) {
      const text = cacheHitPercentText(read, input, 0);
      expect(text, `${read}/${read + input}`).toBe(expected);
      expect(text, `${read}/${read + input}`).not.toBe('100%');
    }
  });
});


describe('cache accounting presence contract', () => {
  const complete = { inputTokens: 50, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 50 };
  const metric = (usage) => ({ startedAt: 0, firstTokenAt: 10, completedAt: 100, usage });

  it('uses the same full denominator for the compact badge and exact hit text', () => {
    const line = messageMetricsLine(metric(complete));
    expect(line.cacheHitText).toBe('50%');
    expect(line.cacheBadgeText).toBe('缓存 50%');
    expect(messageMetricsLine(metric({ ...complete, cacheWriteTokens: 150 })).cacheBadgeText).toBeNull();
  });

  it.each(['inputTokens', 'cacheReadTokens', 'cacheWriteTokens'])('does not turn missing %s into an exact total or ratio', (key) => {
    const partial = { ...complete };
    delete partial[key];
    const line = messageMetricsLine(metric(partial));
    expect(line.cacheHitText).toBeNull();
    expect(line.cacheBadgeText).toBeNull();
    expect(line.inText).toMatch(/^≥/);
    expect(line.inFreshText).toBeNull();
    expect(line.cacheReadText).toBeNull(); // Existing page template would otherwise synthesize 0%.
    expect(line.titleLines.join(' ')).not.toContain('缓存命中');
    expect(cacheHitPercentText(partial.cacheReadTokens, partial.inputTokens, partial.cacheWriteTokens)).toBeNull();
  });

  it.each([undefined, null, -1, NaN, Infinity, '0'])('does not use invalid/missing counters in exact cache ratios: %s', (unknown) => {
    expect(cacheHitPercentText(0, 100, unknown)).toBeNull();
    expect(cacheHitPercentText(unknown, 100, 0)).toBeNull();
    expect(cacheHitPercentText(100, unknown, 0)).toBeNull();
  });

  it('distinguishes explicit zero, unknown output and fully cached input', () => {
    const zero = messageMetricsLine(metric({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }));
    expect(zero.inText).toBe('0');
    expect(zero.inFreshText).toBe('0');
    expect(zero.outText).toBe('0');
    expect(zero.cacheHitText).toBeNull();
    const cached = messageMetricsLine(metric({ inputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 0 }));
    expect(cached.inText).toBe('100');
    expect(cached.inFreshText).toBe('0');
    expect(cached.cacheHitText).toBe('100%');
    expect(cached.outText).toBe('—');
  });

  it('preserves observed lower bounds across incomplete turns and suppresses incomplete cost estimates', () => {
    const folded = foldSessionMetrics([metric(complete), metric({ inputTokens: 20, outputTokens: 5 })], {
      contextWindow: 1000, price: { in: 1, out: 1, cacheRead: 1, cacheWrite: 1 },
    });
    expect(folded.inText).toBe('≥220');
    expect(folded.outText).toBe('15');
    expect(folded.cacheHitText).toBeNull();
    expect(folded.cacheReadText).toBeNull();
    expect(folded.inFreshText).toBeNull();
    expect(folded.ctxText).toBe('≥20');
    expect(folded.ctxHot).toBe(false);
    expect(folded.costText).toBeNull();
  });

  it('does not reuse stale context or report zero tokens after a turn with no usage', () => {
    const folded = foldSessionMetrics([metric(complete), metric(undefined)], { contextWindow: 1000 });
    expect(folded.inText).toBe('≥200');
    expect(folded.outText).toBe('≥10');
    expect(folded.cacheHitText).toBeNull();
    expect(folded.ctxText).toBeNull();
    expect(foldSessionMetrics([metric(undefined)]).inText).toBe('—');
    expect(foldSessionMetrics([metric(undefined)]).outText).toBe('—');
  });

  it('uses final-call completeness independently of accumulated completeness, including all-cache and zero calls', () => {
    const accumulated = { inputTokens: 200, outputTokens: 20, lastCallUsage: { inputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 0 } };
    expect(foldSessionMetrics([metric(accumulated)], { contextWindow: 1000 }).ctxText).toBe('100/1K·10%');
    expect(foldSessionMetrics([metric({ ...complete, lastCallUsage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } })], { contextWindow: 1000 }).ctxText).toBe('0/1K·0%');
    expect(foldSessionMetrics([metric({ ...complete, lastCallUsage: {} })], { contextWindow: 1000 }).ctxText).toBeNull();
    expect(foldSessionMetrics([metric({ inputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 0 })], { contextWindow: 1000 }).ctxText).toBe('100/1K·10%');
  });

  it('rounds observed lower bounds down and hides unsafe exact sums', () => {
    expect(messageMetricsLine(metric({ inputTokens: 1299 })).inText).toBe('≥1.2K');
    expect(messageMetricsLine(metric({ inputTokens: 199_999 })).inText).toBe('≥199K');
    const edge = { inputTokens: 0, outputTokens: 0, cacheReadTokens: Number.MAX_SAFE_INTEGER, cacheWriteTokens: 1 };
    expect(messageMetricsLine(metric(edge)).cacheHitText).toBeNull();
    expect(messageMetricsLine(metric(edge)).inText).toMatch(/^≥/);
    const folded = foldSessionMetrics([metric({ ...complete, cacheReadTokens: Number.MAX_SAFE_INTEGER }), metric(complete)]);
    expect(folded.cacheHitText).toBeNull();
    expect(folded.inText).toMatch(/^≥/);
  });
});


describe('authoritative complete input', () => {
  const partial = { totalInputTokens: 200, cacheReadTokens: 120, outputTokens: 10 };
  const metric = (usage) => ({ startedAt: 0, firstTokenAt: 10, completedAt: 100, usage });
  const price = { in: 1, out: 2, cacheRead: 0.1, cacheWrite: 1 };

  it('uses a raw total with missing write/input without fabricating a breakdown or price', () => {
    expect(tokenUsageMetrics(partial)).toMatchObject({
      hasUsage: true, totalInputTokens: 200, inputTokens: null, cacheWriteTokens: null,
      inText: '200', inFreshText: null, cacheReadText: null, cacheHitText: '60%', cacheBadgeText: '缓存 60%',
    });
    expect(messageMetricsLine(metric(partial))).toMatchObject({ inText: '200', cacheBadgeText: '缓存 60%' });
    expect(messageMetricsLine(metric(partial)).titleLines.join(' ')).not.toContain('未缓存输入');
    expect(foldSessionMetrics([metric(partial)], { price, contextWindow: 250 })).toMatchObject({
      inText: '200', inFreshText: null, cacheReadText: null, cacheHitText: '60%', costText: null, ctxText: '200/250·80%', ctxHot: true,
    });
  });

  it.each([null, undefined, -1, NaN, Infinity, '200', 199.5, Number.MAX_SAFE_INTEGER + 1, 99, 149])('rejects explicit invalid or conflicting total %s even with complete legacy buckets', totalInputTokens => {
    const usage = { inputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 0, totalInputTokens };
    expect(tokenUsageMetrics(usage)).toMatchObject({ totalInputTokens: null, cacheHitText: null, cacheBadgeText: null });
    expect(foldSessionMetrics([metric(usage)], { price })).toMatchObject({ cacheHitText: null, costText: null });
  });

  it('preserves known totals without read and preserves explicit zero', () => {
    expect(tokenUsageMetrics({ totalInputTokens: 200 })).toMatchObject({ hasUsage: true, inText: '200', cacheHitText: null });
    expect(tokenUsageMetrics({ totalInputTokens: 0, cacheReadTokens: 0 })).toMatchObject({ inText: '0', cacheHitText: null });
    expect(tokenUsageMetrics({ totalInputTokens: 100, cacheReadTokens: 100 })).toMatchObject({ cacheHitText: '100%' });
    expect(tokenUsageMetrics({ totalInputTokens: 10000, cacheReadTokens: 9999 })).toMatchObject({ cacheHitText: '99.99%' });
    expect(tokenUsageMetrics({ totalInputTokens: 100, cacheReadTokens: 101 })).toMatchObject({ totalInputTokens: null, cacheHitText: null });
  });

  it('folds raw and complete legacy totals per turn, never completing partial turns from other turns', () => {
    const old = { inputTokens: 50, cacheReadTokens: 50, cacheWriteTokens: 0, outputTokens: 5 };
    expect(foldSessionMetrics([metric(partial), metric(old)], { price })).toMatchObject({ inText: '300', cacheHitText: '57%', costText: null });
    expect(foldSessionMetrics([metric(partial), metric({ inputTokens: 20, outputTokens: 5 })])).toMatchObject({ inText: '≥220', cacheHitText: null });
    expect(foldSessionMetrics([metric(partial), metric({ totalInputTokens: 100, outputTokens: 5 })])).toMatchObject({ inText: '300', cacheHitText: null });
    expect(foldSessionMetrics([metric({ totalInputTokens: Number.MAX_SAFE_INTEGER }), metric(partial)])).toMatchObject({ cacheHitText: null });
    expect(foldSessionMetrics([metric({ totalInputTokens: Number.MAX_SAFE_INTEGER }), metric(partial)]).inText).toMatch(/^≥/);
  });

  it('uses nested raw totals for current context independently of turn totals', () => {
    expect(foldSessionMetrics([metric({ ...partial, lastCallUsage: { totalInputTokens: 80, cacheReadTokens: 60 } })], { contextWindow: 100 })).toMatchObject({ inText: '200', ctxText: '80/100·80%', ctxHot: true });
    expect(foldSessionMetrics([metric({ ...partial, lastCallUsage: { totalInputTokens: 40, cacheReadTokens: 60 } })], { contextWindow: 100 }).ctxHot).toBe(false);
  });
});


describe('recovered SDK input with authoritative total', () => {
  const usage = { inputTokens: 100, totalInputTokens: 100, cacheReadTokens: 80, outputTokens: 10 };
  const metric = (u) => ({ startedAt: 0, completedAt: 100, usage: u });
  it('keeps the raw denominator and ratio while treating SDK input as an unknown fresh breakdown', () => {
    expect(tokenUsageMetrics(usage)).toMatchObject({
      totalInputTokens: 100, inputTokens: null, cacheReadTokens: 80, cacheWriteTokens: null,
      inText: '100', inFreshText: null, cacheReadText: null, cacheHitText: '80%', cacheBadgeText: '缓存 80%',
    });
    expect(messageMetricsLine(metric(usage)).titleLines.join(' ')).not.toContain('未缓存输入');
    expect(foldSessionMetrics([metric(usage), metric(usage)], { contextWindow: 200, price: { in: 1, out: 2 } })).toMatchObject({
      inText: '200', cacheHitText: '80%', inFreshText: null, cacheReadText: null, costText: null, ctxText: '100/200·50%',
    });
  });
  it('validates known cache buckets in partial records and exact equality for complete records', () => {
    expect(tokenUsageMetrics({ ...usage, cacheReadTokens: 101 }).totalInputTokens).toBeNull();
    expect(tokenUsageMetrics({ totalInputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 21 }).totalInputTokens).toBeNull();
    expect(tokenUsageMetrics({ totalInputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 20 })).toMatchObject({ totalInputTokens: 100, cacheHitText: '80%', inputTokens: null });
    expect(tokenUsageMetrics({ ...usage, inputTokens: 10, cacheWriteTokens: 0 }).totalInputTokens).toBeNull();
    expect(tokenUsageMetrics({ ...usage, inputTokens: 20, cacheWriteTokens: 0 })).toMatchObject({ totalInputTokens: 100, inputTokens: 20, inFreshText: '20', cacheHitText: '80%' });
  });
});
