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
  const hasUsage = usage && (num(usage.inputTokens) + num(usage.outputTokens) + num(usage.reasoningTokens)
    + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)) > 0;
  if (typeof startedAt !== 'number' || typeof completedAt !== 'number') return null;
  const durationMs = Math.max(0, completedAt - startedAt);
  const ttft = typeof firstTokenAt === 'number' ? Math.max(0, firstTokenAt - startedAt) : null;
  // 生成窗口（decode）：首个生成活动 → 终态。firstTokenAt 由 gateway-turn
  // 在首个思考/工具/文本事件时打点（思考段计入窗口，速度不失真）。
  const decodeMs = typeof firstTokenAt === 'number' ? Math.max(0, completedAt - firstTokenAt) : null;
  const hasTools = num(toolCalls) > 0;
  // DSH 口径：速度 = 生成阶段（decode）吞吐，分子「思考+可见输出」（实测
  // 估算，measured 标 ≈）。注意不用 billedOutput 做分子：claude 的计费输出
  // 把缓存写入等折算计入（实测思考 0+可见 18 时计费 9251），÷窗口得出
  // 1509 tok/s 的"计费单位吞吐"——不是模型打字速度（用户参照 ~156 是
  // 可见生成口径）。billedOutput 只进 title（账单口径真值）。
  const measured = !!(usage && usage.measured);
  const genTokens = num(usage && usage.reasoningTokens) + num(usage && usage.outputTokens);
  const rateText = !hasTools && decodeMs > 0 && hasUsage && genTokens > 0
    ? (measured ? '≈' : '') + formatRate(genTokens / (decodeMs / 1_000))
    : null;
  if (!hasUsage && ttft === null) return null;
  const titleLines = [];
  const billedOut = num(usage && usage.billedOutputTokens);
  if (hasUsage) {
    if (billedOut > 0) titleLines.push(`计费输出 ${formatTokens(billedOut)} tok（含思考与内部处理）`);
    if (num(usage.reasoningTokens) > 0) titleLines.push(`思考 ${formatTokens(usage.reasoningTokens)} tok`);
    if (num(usage.outputTokens) > 0) titleLines.push(`输出 ${formatTokens(usage.outputTokens)} tok`);
    if (num(usage.cacheReadTokens) > 0) titleLines.push(`缓存读 ${formatTokens(usage.cacheReadTokens)} tok`);
    if (num(usage.cacheWriteTokens) > 0) titleLines.push(`缓存写 ${formatTokens(usage.cacheWriteTokens)} tok`);
  }
  // CLI 自报成本（claude 的 total_cost_usd 等，美元）——比价格表估算准。
  const costUsd = (usage && typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0)
    ? usage.costUsd
    : null;
  if (costUsd !== null) titleLines.push(`CLI 自报成本 $${costUsd.toFixed(4)}`);
  return {
    durationMs,
    latencyText: ttft === null ? null : formatLatency(ttft),
    rateText,
    inText: hasUsage ? formatTokens(num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)) : null,
    // ↓ = 思考 + 输出合计（DSH 口径；拆分悬停可见）。实测估算口径标 ≈。
    outText: hasUsage ? (measured ? '≈' : '') + formatTokens(genTokens) : null,
    costText: costUsd !== null
      ? `$${costUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : null,
    model: (typeof metrics.model === 'string' && metrics.model) || null,
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
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reportedCostUsd = 0;   // CLI/网关自报成本合计（美元）
  let reportedCostTurns = 0;
  let hasMeasured = false;   // 任一轮输出为实测估算口径 → 会话级 ↓/速度标 ≈
  let billedOutTotal = 0;    // 计费口径输出总量合计（真值）——速度分子优先
  let lastUsage = null;
  let lastUsageModel = null; // 自报模型 id——ctx 分母按它解析（CLI 回合不再错用全局模型窗口）
  for (const m of list) {
    if (num(m.toolCalls) > 0) steps += num(m.toolCalls);
    if (typeof m.startedAt === 'number' && typeof m.completedAt === 'number') {
      llmMs += Math.max(0, m.completedAt - m.startedAt);
    }
    if (typeof m.firstTokenAt === 'number' && typeof m.startedAt === 'number') {
      ttftMs += Math.max(0, m.firstTokenAt - m.startedAt);
      ttftN += 1;
      const d = Math.max(0, m.completedAt - m.firstTokenAt);
      const u0 = m.usage || {};
      // DSH 口径：decode 吞吐分子 = 思考 + 可见输出（估算口径；计费输出
      // 含缓存写入折算，不是生成吞吐，不做分子）。
      const gen = num(u0.reasoningTokens) + num(u0.outputTokens);
      if (gen > 0) { decodeMs += d; decodeTok += gen; }
    }
    const u = m.usage || {};
    input += num(u.inputTokens);
    output += num(u.outputTokens);
    reasoning += num(u.reasoningTokens);
    billedOutTotal += num(u.billedOutputTokens);
    cacheRead += num(u.cacheReadTokens);
    cacheWrite += num(u.cacheWriteTokens);
    if (u.measured === true) hasMeasured = true;
    if (typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) && u.costUsd >= 0) {
      reportedCostUsd += u.costUsd;
      reportedCostTurns += 1;
    }
    if (num(u.inputTokens) + num(u.outputTokens) + num(u.reasoningTokens) > 0) {
      lastUsage = u;
      lastUsageModel = typeof m.model === 'string' && m.model ? m.model : null;
    }
  }
  // 命中率分母 = input+cacheRead（与 usage_ledger dashboard 口径一致，§101，不含 cacheWrite）
  const cacheDenom = input + cacheRead;
  const totalIn = input + cacheRead + cacheWrite;
  const cacheHitText = cacheDenom > 0
    ? `${Math.min(100, Math.round((cacheRead / cacheDenom) * 100))}%`
    : null;
  // 上下文占用 = 最近一次 usage 的「窗口内全部内容」：input + cacheRead +
  // cacheWrite（缓存的部分也在窗口里，漏算会把 48K 缓存读报成 1.1K 的
  // 严重低估）+ 输出。分母解析：该回合自报模型 → resolveWindowForModel
  // （CLI 回合按实际模型查窗口）→ 全局 contextWindow 兜底 → 无分母只显示
  // 已用量。
  const resolveWindow = typeof opts.resolveWindowForModel === 'function' ? opts.resolveWindowForModel : null;
  const windowFromModel = (resolveWindow && lastUsageModel) ? resolveWindow(lastUsageModel) : null;
  const ctxWindow = (typeof windowFromModel === 'number' && windowFromModel > 0)
    ? windowFromModel
    : num(opts.contextWindow);
  const ctxUsed = lastUsage
    ? num(lastUsage.inputTokens) + num(lastUsage.cacheReadTokens) + num(lastUsage.cacheWriteTokens) + num(lastUsage.outputTokens)
    : 0;
  const ctx = lastUsage && ctxWindow > 0
    ? { used: ctxUsed, window: ctxWindow }
    : (lastUsage ? { used: ctxUsed, window: 0 } : null);
  const ctxText = ctx
    ? (ctx.window > 0
      ? `${formatTokens(ctx.used)}/${formatTokens(ctx.window)}·${Math.min(100, Math.round((ctx.used / ctx.window) * 100))}%`
      : formatTokens(ctx.used))
    : null;
  const ctxHot = !!(ctx && ctx.window > 0 && ctx.used / ctx.window >= 0.8);
  const rateText = decodeMs > 0 ? (hasMeasured ? '≈' : '') + formatRate(decodeTok / (decodeMs / 1_000)) : null;
  const ttftAvgText = ttftN > 0 ? formatDuration(ttftMs / ttftN) : null;
  // 成本：任一回合有 CLI 自报成本（美元）→ 显示自报合计（准确，CLI 侧计价）；
  // 否则用价格表估算（¥，下界估算）。两种币种不混算——混算需要汇率，编数字。
  let costText = null;
  let costReported = false;
  if (reportedCostTurns > 0) {
    costText = `$${reportedCostUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    costReported = true;
  } else if (opts.price && (totalIn > 0 || output + reasoning > 0)) {
    // 单价为 ¥/百万 token，费用需除以 1_000_000（思考与输出同价计）
    const cost = (input * num(opts.price.in) + (output + reasoning) * num(opts.price.out)
      + cacheRead * num(opts.price.cacheRead) + cacheWrite * num(opts.price.cacheWrite)) / 1_000_000;
    costText = `¥${cost.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return {
    turns, steps, llmMs, ttftAvgText, rateText, cacheHitText,
    ctxText, ctxHot,
    inText: formatTokens(totalIn),
    // ↓ = 思考+输出合计；任一轮为实测估算口径 → 标 ≈。
    outText: (hasMeasured ? '≈' : '') + formatTokens(output + reasoning),
    costText, costReported,
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
