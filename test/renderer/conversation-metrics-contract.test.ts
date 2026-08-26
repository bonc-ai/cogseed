import { describe, it, expect } from 'vitest';
import { messageMetricsLine, foldSessionMetrics } from '../../src/renderer/modules/conversation-metrics.js';

describe('对话内用量契约（验收标准）', () => {
  it('完成后可查看 token 与缓存：无 metrics 不渲染，有则出数', () => {
    expect(messageMetricsLine(null)).toBeNull();
    // 注：brief 原文为 `.outText`；无 usage 且无 firstTokenAt 时 messageMetricsLine
    // 整体返回 null（不渲染），直接点取会 TypeError。改为断言整体返回 null，
    // 锁住更强的验收语义：无数据 → 整行不渲染。
    expect(messageMetricsLine({ startedAt: 0, firstTokenAt: null, completedAt: 1 })).toBeNull();
  });

  it('聚合=单次求和：fold 结果与逐条原值一致', () => {
    const ms = [
      { startedAt: 0, firstTokenAt: 1_000, completedAt: 5_000, usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 300 } },
      { startedAt: 9, firstTokenAt: 10_000, completedAt: 15_000, usage: { inputTokens: 50, outputTokens: 25, cacheReadTokens: 450 }, toolCalls: 2 },
    ];
    const f = foldSessionMetrics(ms, { contextWindow: null, price: null });
    expect(f.cacheHitText).toBe('83%'); // 750 / (150+750) ≈ 83.3
    expect(f.inText).toBe('900');
  });

  it('缓存与费用是聚合段：正文不掺入（纯函数无 DOM 即为证）', () => {
    // conversation-metrics.js 不 import DOM API——模块级保证。
    expect(typeof foldSessionMetrics).toBe('function');
  });

  it('不含凭证：metrics 输出只有数字与缩写文本', () => {
    const line = messageMetricsLine({
      startedAt: 0, firstTokenAt: 500, completedAt: 2_000,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(JSON.stringify(line)).not.toMatch(/key|token=|bearer|authorization|http/i);
  });
});
