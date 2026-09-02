// Metrics formatting/folding — pure functions, no DOM, no state.
// 口径照 DSH：input=裸输入；缓存命中=cacheRead/(input+cacheRead)；速率只计
// 有计时的回合；未知不显示，不编数字。
// steps = Σ 每条消息的 toolCalls（设计 §98：步 = 该消息内工具调用次数）。
// 渲染层是经典 script（见 index.html 头注释，无构建步、无 ESM import），
// 所以本文件以函数声明共享 + `window.conversationMetrics` 暴露给
// conversation.js；测试走底部 CJS 桥（同 utils.js / strip-structural-blocks.js）。

function formatTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  const scaled = (x) => (x >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10));
  if (v < 1_000) return String(Math.round(v));
  if (v < 1_000_000) return `${scaled(v / 1_000)}K`;
  return `${scaled(v / 1_000_000)}M`;
}

function formatDuration(ms) {
  const s = Math.max(0, ms) / 1_000;
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

function formatRate(tps) {
  const v = Math.max(0, tps);
  return v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
}

function formatLatency(ms) {
  const s = Math.max(0, ms) / 1_000;
  return s < 10 ? String(Math.round(s * 10) / 10) : String(Math.round(s));
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

function messageMetricsLine(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const { startedAt, firstTokenAt, completedAt, usage, toolCalls } = metrics;
  const hasUsage = usage && (num(usage.inputTokens) + num(usage.outputTokens)
    + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)) > 0;
  if (typeof startedAt !== 'number' || typeof completedAt !== 'number') return null;
  const durationMs = Math.max(0, completedAt - startedAt);
  const ttft = typeof firstTokenAt === 'number' ? Math.max(0, firstTokenAt - startedAt) : null;
  const decodeMs = typeof firstTokenAt === 'number' ? Math.max(0, completedAt - firstTokenAt) : null;
  const hasTools = num(toolCalls) > 0;
  const rateText = !hasTools && decodeMs > 0 && hasUsage && num(usage.outputTokens) > 0
    ? formatRate(num(usage.outputTokens) / (decodeMs / 1_000))
    : null;
  if (!hasUsage && ttft === null) return null;
  const titleLines = [];
  if (hasUsage) {
    if (num(usage.cacheReadTokens) > 0) titleLines.push(`缓存读 ${formatTokens(usage.cacheReadTokens)} tok`);
    if (num(usage.cacheWriteTokens) > 0) titleLines.push(`缓存写 ${formatTokens(usage.cacheWriteTokens)} tok`);
  }
  return {
    durationMs,
    latencyText: ttft === null ? null : formatLatency(ttft),
    rateText,
    inText: hasUsage ? formatTokens(num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)) : null,
    outText: hasUsage ? formatTokens(num(usage.outputTokens)) : null,
    titleLines,
  };
}

function foldSessionMetrics(metricsList, opts = {}) {
  const list = (Array.isArray(metricsList) ? metricsList : []).filter(Boolean);
  const turns = list.length;
  let steps = 0;
  let llmMs = 0;
  let ttftMs = 0;
  let ttftN = 0;
  let decodeMs = 0;
  let decodeTok = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let lastUsage = null;
  for (const m of list) {
    if (num(m.toolCalls) > 0) steps += num(m.toolCalls);
    if (typeof m.startedAt === 'number' && typeof m.completedAt === 'number') {
      llmMs += Math.max(0, m.completedAt - m.startedAt);
    }
    if (typeof m.firstTokenAt === 'number' && typeof m.startedAt === 'number') {
      ttftMs += Math.max(0, m.firstTokenAt - m.startedAt);
      ttftN += 1;
      const d = Math.max(0, m.completedAt - m.firstTokenAt);
      const u = m.usage || {};
      if (num(u.outputTokens) > 0) { decodeMs += d; decodeTok += num(u.outputTokens); }
    }
    const u = m.usage || {};
    input += num(u.inputTokens);
    output += num(u.outputTokens);
    cacheRead += num(u.cacheReadTokens);
    cacheWrite += num(u.cacheWriteTokens);
    if (num(u.inputTokens) + num(u.outputTokens) > 0) lastUsage = u;
  }
  // 命中率分母 = input+cacheRead（与 usage_ledger dashboard 口径一致，§101，不含 cacheWrite）
  const cacheDenom = input + cacheRead;
  const totalIn = input + cacheRead + cacheWrite;
  const cacheHitText = cacheDenom > 0
    ? `${Math.min(100, Math.round((cacheRead / cacheDenom) * 100))}%`
    : null;
  // 上下文占用 = 最近一次 usage 的 input+output（设计 §94）
  const ctx = lastUsage && num(opts.contextWindow) > 0
    ? { used: num(lastUsage.inputTokens) + num(lastUsage.outputTokens), window: num(opts.contextWindow) }
    : (lastUsage ? { used: num(lastUsage.inputTokens) + num(lastUsage.outputTokens), window: 0 } : null);
  const ctxText = ctx
    ? (ctx.window > 0
      ? `${formatTokens(ctx.used)}/${formatTokens(ctx.window)}·${Math.min(100, Math.round((ctx.used / ctx.window) * 100))}%`
      : formatTokens(ctx.used))
    : null;
  const ctxHot = !!(ctx && ctx.window > 0 && ctx.used / ctx.window >= 0.8);
  const rateText = decodeMs > 0 ? formatRate(decodeTok / (decodeMs / 1_000)) : null;
  const ttftAvgText = ttftN > 0 ? formatDuration(ttftMs / ttftN) : null;
  let costText = null;
  if (opts.price && (totalIn > 0 || output > 0)) {
    // 单价为 ¥/百万 token，费用需除以 1_000_000
    const cost = (input * num(opts.price.in) + output * num(opts.price.out)
      + cacheRead * num(opts.price.cacheRead) + cacheWrite * num(opts.price.cacheWrite)) / 1_000_000;
    costText = `¥${cost.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return {
    turns, steps, llmMs, ttftAvgText, rateText, cacheHitText,
    ctxText, ctxHot,
    inText: formatTokens(totalIn), outText: formatTokens(output), costText,
  };
}

// 经典 script 暴露：conversation.js（同为经典 script，无 import 能力）通过
// `window.conversationMetrics` 消费。jsdom 测试环境下同样生效，无副作用。
if (typeof window !== 'undefined') {
  window.conversationMetrics = {
    formatTokens,
    formatDuration,
    formatRate,
    formatLatency,
    messageMetricsLine,
    foldSessionMetrics,
  };
}

// Test bridge — guarded CommonJS export（照 utils.js / strip-structural-blocks.js
// 的既有模式）。浏览器里 `module` 未定义，整块 no-op。
if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = {
    formatTokens,
    formatDuration,
    formatRate,
    formatLatency,
    messageMetricsLine,
    foldSessionMetrics,
  };
}
