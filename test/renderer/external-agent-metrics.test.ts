import { describe, it, expect } from 'vitest';
// 会话折叠的外接智能体扩展：CLI 自报成本优先、ctx 分母按回合自报模型解析。
const { foldSessionMetrics, messageMetricsLine } = require('../../src/renderer/modules/conversation-metrics.js') as {
  foldSessionMetrics: (list: unknown[], opts: unknown) => Record<string, unknown>;
  messageMetricsLine: (metrics: unknown) => Record<string, unknown> | null;
};

const NOW = 1_700_000_000_000;

function turn(overrides: Record<string, unknown> = {}) {
  return {
    startedAt: NOW,
    firstTokenAt: NOW + 500,
    completedAt: NOW + 3_000,
    usage: { inputTokens: 1_000, outputTokens: 200 },
    ...overrides,
  };
}

describe('foldSessionMetrics — CLI-reported cost precedence', () => {
  it('shows the CLI-reported USD total when any turn self-reports costUsd', () => {
    const f = foldSessionMetrics(
      [turn({ usage: { inputTokens: 1_000, outputTokens: 200, costUsd: 0.0123 } })],
      { price: { in: 10, out: 30, cacheRead: 0, cacheWrite: 0 } },
    ) as { costText: string; costReported: boolean };
    expect(f.costText).toBe('$0.01');
    expect(f.costReported).toBe(true);
  });

  it('falls back to the price-table CNY estimate when nothing self-reports', () => {
    const f = foldSessionMetrics(
      [turn()],
      { price: { in: 10, out: 30, cacheRead: 0, cacheWrite: 0 } },
    ) as { costText: string; costReported: boolean };
    expect(f.costText).toMatch(/^¥/);
    expect(f.costReported).toBe(false);
  });

  it('sums self-reported costs across turns and never mixes currencies', () => {
    const f = foldSessionMetrics(
      [
        turn({ usage: { inputTokens: 10, outputTokens: 2, costUsd: 1 } }),
        turn({ usage: { inputTokens: 10, outputTokens: 2, costUsd: 2 } }),
      ],
      { price: { in: 10, out: 30, cacheRead: 0, cacheWrite: 0 } },
    ) as { costText: string };
    expect(f.costText).toBe('$3.00');
  });
});

describe('foldSessionMetrics — per-model context window denominator', () => {
  it('uses resolveWindowForModel(lastUsage.model) over the global contextWindow', () => {
    const f = foldSessionMetrics(
      [turn({ model: 'claude-sonnet-5[1M]' })],
      {
        contextWindow: 128_000,
        resolveWindowForModel: (modelId: string) => (modelId.includes('1M') ? 1_048_576 : null),
      },
    ) as { ctxText: string };
    // used = 1200, window = 1M → 百分比按大窗口算。
    expect(f.ctxText).toContain('/1M');
    expect(f.ctxText).toContain('0%');
  });

  it('falls back to the global window when the model is unknown to the resolver', () => {
    const f = foldSessionMetrics(
      [turn({ model: 'mystery-model' })],
      {
        contextWindow: 128_000,
        resolveWindowForModel: () => null,
      },
    ) as { ctxText: string };
    expect(f.ctxText).toContain('/128K');
  });

  it('shows used-only (no denominator) when neither model nor global window is known', () => {
    const f = foldSessionMetrics([turn({ model: 'mystery-model' })], {
      resolveWindowForModel: () => null,
    }) as { ctxText: string };
    expect(f.ctxText).toBe('1.2K');
    expect(f.ctxText).not.toContain('/');
  });
});

describe('messageMetricsLine — CLI usage on the per-message meta row', () => {
  it('surfaces the self-reported cost and the model id', () => {
    const line = messageMetricsLine(turn({
      model: 'claude-sonnet-5[1M]',
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.0315 },
    })) as { costText: string; model: string; titleLines: string[] };
    expect(line?.costText).toBe('$0.03');
    expect(line?.model).toBe('claude-sonnet-5[1M]');
    expect(line?.titleLines?.some((l) => l.includes('CLI 自报成本'))).toBe(true);
  });

  it('DSH 口径：速度与 ↓ 按「思考+输出」合计，title 拆思考/输出', () => {
    // decode 窗口 2s（firstTokenAt→completedAt），思考 300 + 输出 100
    // → 400 tok / 2s = 200 tok/s；↓ 显示 400；title 里思考/输出分行。
    const line = messageMetricsLine({
      startedAt: 1_000,
      firstTokenAt: 3_000,
      completedAt: 5_000,
      usage: { reasoningTokens: 300, outputTokens: 100 },
    }) as { rateText: string; outText: string; titleLines: string[] };
    expect(line?.rateText).toBe('200');
    expect(line?.outText).toBe('400');
    expect(line?.titleLines?.some((l) => l.includes('思考 300'))).toBe(true);
    expect(line?.titleLines?.some((l) => l.includes('输出 100'))).toBe(true);
  });

  it("外接轮（source:'cli'）只留计时——token/速度/成本段不上线", () => {
    // 外接用量披露因家而异、输出为估算口径，不满足全量一致上线的标准；
    // 用时/首token 是本地打点（100% 通用真实），保留。
    const line = messageMetricsLine({
      startedAt: 1_000,
      firstTokenAt: 3_000,
      completedAt: 6_000,
      usage: { source: 'cli', inputTokens: 50_000, outputTokens: 9, costUsd: 0.18, measured: true },
    }) as Record<string, unknown>;
    expect(line?.rateText ?? null).toBeNull();
    expect(line?.inText ?? null).toBeNull();
    expect(line?.outText ?? null).toBeNull();
    expect(line?.costText ?? null).toBeNull();
    expect(line?.latencyText).toBe('2');
    expect(line?.durationMs).toBe(5_000);
  });

  it('measured 口径标 ≈（实测估算与账单精确值明确区分）', () => {
    // CLI 无精确输出数（claude result/assistant 帧自报均不可用），输出为
    // 按文本实测估算 → ↓ 与速度带 ≈ 前缀；精确值（账单/打点）不加。
    const line = messageMetricsLine({
      startedAt: 1_000,
      firstTokenAt: 3_000,
      completedAt: 5_000,
      usage: { outputTokens: 400, measured: true },
    }) as { rateText: string; outText: string };
    expect(line?.rateText).toBe('≈200');
    expect(line?.outText).toBe('≈400');
  });


  it('keeps the legacy shape when no cost/model is reported', () => {
    const line = messageMetricsLine(turn());
    expect(line?.costText ?? null).toBeNull();
    expect(line?.model ?? null).toBeNull();
  });
});
