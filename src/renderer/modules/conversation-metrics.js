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

// 悬停明细 i18n：运行时全局 t 可用（i18n.js 经典 script 先行加载）则用翻译
// 键；测试 CJS 桥环境 t 不存在，退回中文文案保持既有断言不破。
const tt = (key, vars, fallback) => (typeof t === 'function' ? t(key, vars) : fallback);

// 缓存命中率口径（对齐 DSH dsh-client-ui-chat::formatCacheHitPercent）：
// 分母 = 完整 prompt 侧用量 billedInput = input+cacheRead+cacheWrite（含 cacheWrite）；
// 且"部分命中"不得四舍五入到 100%——命中率接近整百时用额外精度保持诚实。
function cacheHitPercentText(cacheReadTokens, inputTokens, cacheWriteTokens = 0) {
  const read = num(cacheReadTokens);
  const denom = num(inputTokens) + read + num(cacheWriteTokens);
  if (denom <= 0) return null;
  const missed = denom - read;
  if (missed <= 0) return '100%';
  // DSH roundedPercentUnits：在百分比单位（默认整数百分比）上用带进位的精确取整，
  // 避免 Math.round 的 .5 上取整把"未命中但极接近"误判为整百。
  const scale = 100;
  const doubledScale = scale * 2;
  const denominatorQuotient = Math.floor(denom / doubledScale);
  const denominatorRemainder = denom % doubledScale;
  let lower = 0;
  let upper = scale;
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2);
    const factor = candidate * 2 - 1;
    if (read >= factor * denominatorQuotient + Math.ceil(factor * denominatorRemainder / doubledScale)) lower = candidate;
    else upper = candidate - 1;
  }
  if (lower < 100) return `${lower}%`;
  // 会四舍五入成 100% 但实际仍有未命中 → 精化到能区分未命中的小数位。
  // DSH：从未命中 token 数反推需要的区分精度，返回 "99.<9重复><10-loss>"。
  let distinguishingPlaces = 1;
  let scaledDoubleGap = missed * 200;
  const denominatorTens = Math.floor(denom / 10);
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10;
    distinguishingPlaces += 1;
  }
  const denominatorOnes = denom % 10;
  let roundedLoss = 5;
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1;
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10);
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss;
      break;
    }
  }
  return `99.${'9'.repeat(distinguishingPlaces - 1)}${10 - roundedLoss}%`;
}

function messageMetricsLine(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const { startedAt, firstTokenAt, completedAt } = metrics;
  // CLI 回合统计已下线（bus 剥 usage）：metrics 只带时间戳是常态而非异常。
  // 宿主对象归一化后，inputTokens 等字段全部经 num() 安全取值。
  const usage = metrics.usage || {};
  const hasUsage = usage && (num(usage.inputTokens) + num(usage.outputTokens)
    + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)) > 0;
  if (typeof startedAt !== 'number' || typeof completedAt !== 'number') return null;
  const durationMs = Math.max(0, completedAt - startedAt);
  const ttft = typeof firstTokenAt === 'number' ? Math.max(0, firstTokenAt - startedAt) : null;
  const decodeMs = typeof firstTokenAt === 'number' ? Math.max(0, completedAt - firstTokenAt) : null;
  // 速率已停显（2026-09：step 级/时间口径反复不收敛，宁可展示可核对字段）。
  const rateText = null;
  if (!hasUsage && ttft === null) return null;
  const titleLines = [];
  if (hasUsage) {
    // 对齐 DeepSeek 官方 harness 的四字段明细：未缓存输入 / 缓存读取 /
    // 缓存写 / （命中率为独立标注）。缓存读行在最前——官方次序。
    titleLines.push(tt('chat.metrics.uncachedInputK', { v: formatTokens(usage.inputTokens) }, `未缓存输入 ${formatTokens(usage.inputTokens)} tok`));
    if (num(usage.cacheReadTokens) > 0) {
      titleLines.push(tt('chat.metrics.cacheReadK', { v: formatTokens(usage.cacheReadTokens) }, `缓存读取 ${formatTokens(usage.cacheReadTokens)} tok`));
      // 命中率 = cacheRead/billedInput（input+cacheRead+cacheWrite），与 DSH 口径一致
      const hitText = cacheHitPercentText(usage.cacheReadTokens, usage.inputTokens, usage.cacheWriteTokens) || '0%';
      titleLines.push(tt('chat.metrics.cacheHitK', { v: hitText }, `缓存命中 ${hitText}`));
    }
    if (num(usage.cacheWriteTokens) > 0) titleLines.push(tt('chat.metrics.cacheWriteK', { v: formatTokens(usage.cacheWriteTokens) }, `缓存写 ${formatTokens(usage.cacheWriteTokens)} tok`));
  }
  // 缓存命中分层（交互设计 2026-09-08 合并定稿）：
  // - cacheHitText：DSH billedInput 口径的命中率（PR198 语义，供模板/
  //   悬停/对账，总可计算）；
  // - cacheBadgeText：主显示正向标记，命中率 ≥50% 才显示「缓存 xx%」
  //   （大数不吓人，省钱变亮点；分母 input+cacheRead）。
  const hitDenom = num(usage.inputTokens) + num(usage.cacheReadTokens);
  const cacheBadgeText = hasUsage && hitDenom > 0 && num(usage.cacheReadTokens) / hitDenom >= 0.5
    ? `缓存 ${Math.round((num(usage.cacheReadTokens) / hitDenom) * 100)}%`
    : null;
  // CLI 自报成本（claude 的 total_cost_usd 等，美元）——比价格表估算准。
  const costUsd = (usage && typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0)
    ? usage.costUsd
    : null;
  if (costUsd !== null) titleLines.push(tt('chat.metrics.cliCostK', { v: `$${costUsd.toFixed(4)}` }, `CLI 自报成本 $${costUsd.toFixed(4)}`));
  // 单回合命中率（主读数行内标注用，与 DSH billedInput 口径一致）。
  const cacheHitText = hasUsage
    ? cacheHitPercentText(usage.cacheReadTokens, usage.inputTokens, usage.cacheWriteTokens)
    : null;
  return {
    durationMs,
    latencyText: ttft === null ? null : formatLatency(ttft),
    rateText,
    // 对账口径（PR198）：三项和；主显示读数用 inFreshText（裸输入）。
    inText: hasUsage ? formatTokens(num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)) : null,
    // 展示层拆分（PR198 4a + 2026-09-08 分层定稿）：主读数 = 纯 fresh 输入，
    // 缓存读全量走悬停，命中率达标走 cacheBadgeText 正向标记。
    inFreshText: hasUsage && num(usage.inputTokens) > 0 ? formatTokens(num(usage.inputTokens)) : null,
    cacheReadText: hasUsage && num(usage.cacheReadTokens) > 0 ? formatTokens(num(usage.cacheReadTokens)) : null,
    cacheBadgeText,
    outText: hasUsage ? formatTokens(num(usage.outputTokens)) : null,
    cacheHitText,
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
  let cacheRead = 0;
  let cacheWrite = 0;
  let reportedCostUsd = 0;   // CLI/网关自报成本合计（美元）
  let reportedCostTurns = 0;
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
      const u = m.usage || {};
      if (num(u.outputTokens) > 0) { decodeMs += d; decodeTok += num(u.outputTokens); }
    }
    const u = m.usage || {};
    input += num(u.inputTokens);
    output += num(u.outputTokens);
    cacheRead += num(u.cacheReadTokens);
    cacheWrite += num(u.cacheWriteTokens);
    if (typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) && u.costUsd >= 0) {
      reportedCostUsd += u.costUsd;
      reportedCostTurns += 1;
    }
    if (num(u.inputTokens) + num(u.outputTokens) > 0) {
      lastUsage = u;
      lastUsageModel = typeof m.model === 'string' && m.model ? m.model : null;
    }
  }
  // 命中率分母 = billedInput = input+cacheRead+cacheWrite（与 DSH billedInputTokens 口径一致，§101）
  const cacheDenom = input + cacheRead + cacheWrite;
  const totalIn = input + cacheRead + cacheWrite;
  // cacheRead=0 且有输入时也显示 0%（DSH 统计行同：有 prompt 输入就出命中率，无缓存读为 0%）
  const cacheHitText = cacheDenom > 0
    ? cacheHitPercentText(cacheRead, input, cacheWrite)
    : null;
  // 上下文占用 = 最近一次 usage 的 prompt 侧压力 pressureFrom = input+cacheRead+cacheWrite
  // （与 DSH pressureFrom 口径一致，不含 output）。分母解析：
  // 该回合自报模型 → 调用方给的 resolveWindowForModel（CLI 回合按实际模型
  // 查窗口）→ 全局 contextWindow 兜底 → 无分母只显示已用量。
  const resolveWindow = typeof opts.resolveWindowForModel === 'function' ? opts.resolveWindowForModel : null;
  const windowFromModel = (resolveWindow && lastUsageModel) ? resolveWindow(lastUsageModel) : null;
  const ctxWindow = (typeof windowFromModel === 'number' && windowFromModel > 0)
    ? windowFromModel
    : num(opts.contextWindow);
  const ctxUsed = lastUsage
    ? num(lastUsage.inputTokens) + num(lastUsage.cacheReadTokens) + num(lastUsage.cacheWriteTokens)
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
  // 速率已停显（与 messageMetricsLine 一致）。
  const rateText = null;
  const ttftAvgText = ttftN > 0 ? formatDuration(ttftMs / ttftN) : null;
  // 成本：任一回合有 CLI 自报成本（美元）→ 显示自报合计（准确，CLI 侧计价）；
  // 否则用价格表估算（¥，下界估算）。两种币种不混算——混算需要汇率，编数字。
  let costText = null;
  let costReported = false;
  if (reportedCostTurns > 0) {
    costText = `$${reportedCostUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    costReported = true;
  } else if (opts.price && (totalIn > 0 || output > 0)) {
    // 单价为 ¥/百万 token，费用需除以 1_000_000
    const cost = (input * num(opts.price.in) + output * num(opts.price.out)
      + cacheRead * num(opts.price.cacheRead) + cacheWrite * num(opts.price.cacheWrite)) / 1_000_000;
    costText = `¥${cost.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return {
    turns, steps, llmMs, ttftAvgText, rateText, cacheHitText,
    ctxText, ctxHot,
    // 对账口径（PR198）：三项和；主显示读数 inFreshText（裸输入）+
    // cacheHitText 命中率（会话统计行的既有消费方不变）。
    inText: formatTokens(totalIn), outText: formatTokens(output), costText, costReported,
    // 展示层拆分（PR198 4a）：与单回合口径一致——纯 fresh 输入 + 缓存读。
    inFreshText: input > 0 ? formatTokens(input) : null,
    cacheReadText: cacheRead > 0 ? formatTokens(cacheRead) : null,
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
