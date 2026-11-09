// Metrics formatting/folding — pure functions, no DOM, no state.
// input=裸输入；缓存命中=cacheRead/权威完整输入总量（旧数据回退三项和）。
// 缺失分量不补零；完整观测显示精确值，部分观测显示下界且隐藏精确比例。
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
function cacheHitPercentText(cacheReadTokens, inputTokens, cacheWriteTokens) {
  if ([cacheReadTokens, inputTokens, cacheWriteTokens].some((v) => knownTokenCount(v) === null)) return null;
  return cacheReadPercentText(cacheReadTokens, inputTokens + cacheReadTokens + cacheWriteTokens);
}

function cacheReadPercentText(read, denom) {
  if (knownTokenCount(read) === null || knownTokenCount(denom) === null || denom <= 0 || read > denom) return null;
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

function knownTokenCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Numeric notation needs no new locale prose. Round lower bounds DOWN at the
// displayed precision so an abbreviation cannot overstate an observed count.
function formatObservedTokens(observed, complete) {
  if (complete) return formatTokens(observed);
  if (observed <= 0) return '—';
  const unit = observed >= 1_000_000 ? 1_000_000 : (observed >= 1_000 ? 1_000 : 1);
  const step = unit === 1 ? 1 : (observed / unit >= 100 ? unit : unit / 10);
  return `≥${formatTokens(Math.floor(observed / step) * step)}`;
}

/** One presence-aware input contract for all existing metrics surfaces. */
function tokenUsageMetrics(usage) {
  const u = usage || {};
  const rawInputTokens = knownTokenCount(u.inputTokens);
  const outputTokens = knownTokenCount(u.outputTokens);
  const cacheReadTokens = knownTokenCount(u.cacheReadTokens);
  const cacheWriteTokens = knownTokenCount(u.cacheWriteTokens);
  const hasTotal = Object.prototype.hasOwnProperty.call(u, 'totalInputTokens');
  const allBucketsKnown = rawInputTokens !== null && cacheReadTokens !== null && cacheWriteTokens !== null;
  // With a raw total and an incomplete cache split, SDK input may still be
  // the inclusive prompt count. It is not a known fresh-input observation.
  const inputTokens = hasTotal && !allBucketsKnown ? null : rawInputTokens;
  const cacheSum = (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  const sum = (inputTokens ?? 0) + cacheSum;
  const completeBuckets = allBucketsKnown && Number.isSafeInteger(sum);
  const rawTotal = knownTokenCount(u.totalInputTokens);
  // Full buckets must reconcile exactly. Partial records validate only known
  // caches against the authoritative total; never infer fresh/write residuals.
  // An invalid explicit total cannot silently fall back to legacy buckets.
  const totalInputTokens = hasTotal
    ? (rawTotal !== null && (allBucketsKnown
      ? completeBuckets && rawTotal === sum
      : rawTotal >= cacheSum) ? rawTotal : null)
    : (completeBuckets ? sum : null);
  const completeInputBreakdown = completeBuckets && totalInputTokens === sum;
  const observedInputTokens = totalInputTokens ?? Math.min(sum, Number.MAX_SAFE_INTEGER);
  const cacheHitText = cacheReadPercentText(cacheReadTokens, totalInputTokens);
  return {
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    hasUsage: [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalInputTokens].some((v) => v !== null),
    totalInputTokens, completeInputBreakdown,
    observedInputTokens,
    inText: formatObservedTokens(observedInputTokens, totalInputTokens !== null),
    outText: outputTokens === null ? '—' : formatTokens(outputTokens),
    // Split templates require complete buckets; an authoritative total alone
    // supports the compact ratio without inventing an uncached/write split.
    inFreshText: completeInputBreakdown ? formatTokens(inputTokens) : null,
    cacheReadText: completeInputBreakdown && cacheReadTokens > 0 ? formatTokens(cacheReadTokens) : null,
    cacheHitText,
    cacheBadgeText: cacheHitText !== null && cacheReadTokens / totalInputTokens >= 0.5 ? `缓存 ${cacheHitText}` : null,
  };
}

function messageMetricsLine(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const { startedAt, firstTokenAt, completedAt } = metrics;
  // CLI 回合统计已下线（bus 剥 usage）：metrics 只带时间戳是常态而非异常。
  const usage = metrics.usage || {};
  const tokens = tokenUsageMetrics(usage);
  const hasUsage = tokens.hasUsage;
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
    if (tokens.inputTokens !== null) titleLines.push(tt('chat.metrics.uncachedInputK', { v: formatTokens(tokens.inputTokens) }, `未缓存输入 ${formatTokens(tokens.inputTokens)} tok`));
    if (tokens.cacheReadTokens !== null) {
      titleLines.push(tt('chat.metrics.cacheReadK', { v: formatTokens(usage.cacheReadTokens) }, `缓存读取 ${formatTokens(usage.cacheReadTokens)} tok`));
      // 命中率 = cacheRead/billedInput（input+cacheRead+cacheWrite），与 DSH 口径一致
      if (tokens.cacheHitText !== null) titleLines.push(tt('chat.metrics.cacheHitK', { v: tokens.cacheHitText }, `缓存命中 ${tokens.cacheHitText}`));
    }
    if (tokens.cacheWriteTokens !== null) titleLines.push(tt('chat.metrics.cacheWriteK', { v: formatTokens(usage.cacheWriteTokens) }, `缓存写 ${formatTokens(usage.cacheWriteTokens)} tok`));
  }
  // CLI 自报成本（claude 的 total_cost_usd 等，美元）——比价格表估算准。
  const costUsd = (usage && typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0)
    ? usage.costUsd
    : null;
  if (costUsd !== null) titleLines.push(tt('chat.metrics.cliCostK', { v: `$${costUsd.toFixed(4)}` }, `CLI 自报成本 $${costUsd.toFixed(4)}`));
  return {
    durationMs,
    latencyText: ttft === null ? null : formatLatency(ttft),
    rateText,
    inText: hasUsage ? tokens.inText : null,
    inFreshText: tokens.inFreshText,
    cacheReadText: tokens.cacheReadText,
    cacheBadgeText: tokens.cacheBadgeText,
    outText: hasUsage ? tokens.outText : null,
    cacheHitText: tokens.cacheHitText,
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
  let reportedCostUsd = 0;   // CLI/网关自报成本合计（美元）
  let reportedCostTurns = 0;
  let lastCtxUsage = null;   // 最新回合的 lastCallUsage 优先，不复用旧占用值。
  let lastUsageModel = null; // 自报模型 id——ctx 分母按它解析（CLI 回合不再错用全局模型窗口）
  const tokenKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  const complete = Object.fromEntries(tokenKeys.map((key) => [key, list.length > 0]));
  const observed = Object.fromEntries(tokenKeys.map((key) => [key, 0]));
  let totalIn = 0;
  let completeInput = list.length > 0;
  let completeInputBreakdown = list.length > 0;
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
    const tokens = tokenUsageMetrics(u);
    const nextTotal = totalIn + tokens.observedInputTokens;
    if (tokens.totalInputTokens === null || !Number.isSafeInteger(nextTotal)) completeInput = false;
    if (!tokens.completeInputBreakdown) completeInputBreakdown = false;
    totalIn = Math.min(nextTotal, Number.MAX_SAFE_INTEGER);
    for (const key of tokenKeys) {
      const value = knownTokenCount(u[key]);
      if (value === null) complete[key] = false;
      else {
        const sum = observed[key] + value;
        if (!Number.isSafeInteger(sum)) complete[key] = false;
        observed[key] = Math.min(sum, Number.MAX_SAFE_INTEGER);
      }
    }
    if (typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) && u.costUsd >= 0) {
      reportedCostUsd += u.costUsd;
      reportedCostTurns += 1;
    }
    lastUsageModel = typeof m.model === 'string' && m.model ? m.model : null;
    // 占用口径（2026-09-11）：优先最后一次调用的 prompt 侧用量
    // （usage.lastCallUsage）——上方累加 usage 把每步工具循环重发的历史
    // 求和，直接当窗口占用会虚高数倍（真机：单轮 33 步显示 566K，实际
    // 最后一步 prompt 仅数十 K）。缺失时回退累加值（CLI 回合等旧数据）。
    lastCtxUsage = (u.lastCallUsage && typeof u.lastCallUsage === 'object')
      ? u.lastCallUsage
      : u;
  }
  const input = observed.inputTokens;
  const output = observed.outputTokens;
  const cacheRead = observed.cacheReadTokens;
  const cacheWrite = observed.cacheWriteTokens;
  completeInputBreakdown = completeInputBreakdown && completeInput && complete.inputTokens && complete.cacheReadTokens && complete.cacheWriteTokens;
  const cacheHitText = completeInput && complete.cacheReadTokens ? cacheReadPercentText(cacheRead, totalIn) : null;
  // 上下文占用优先使用最近一次调用的完整输入总量，旧数据回退三项和；
  // 不含 output。窗口分母解析：
  // 该回合自报模型 → 调用方给的 resolveWindowForModel（CLI 回合按实际模型
  // 查窗口）→ 全局 contextWindow 兜底 → 无分母只显示已用量。
  const resolveWindow = typeof opts.resolveWindowForModel === 'function' ? opts.resolveWindowForModel : null;
  const windowFromModel = (resolveWindow && lastUsageModel) ? resolveWindow(lastUsageModel) : null;
  const ctxWindow = (typeof windowFromModel === 'number' && windowFromModel > 0)
    ? windowFromModel
    : num(opts.contextWindow);
  const ctxTokens = tokenUsageMetrics(lastCtxUsage);
  const ctxUsed = ctxTokens.totalInputTokens;
  const ctxText = ctxUsed !== null
    ? (ctxWindow > 0
      ? `${formatTokens(ctxUsed)}/${formatTokens(ctxWindow)}·${Math.min(100, Math.round((ctxUsed / ctxWindow) * 100))}%`
      : formatTokens(ctxUsed))
    : (ctxTokens.observedInputTokens > 0 ? ctxTokens.inText : null);
  const ctxHot = ctxUsed !== null && ctxWindow > 0 && ctxUsed / ctxWindow >= 0.8;
  // 速率已停显（与 messageMetricsLine 一致）。
  const rateText = null;
  const ttftAvgText = ttftN > 0 ? formatDuration(ttftMs / ttftN) : null;
  // 成本：任一回合有 CLI 自报成本（美元）→ 显示自报合计（准确，CLI 侧计价）；
  // 否则仅在输入分项和输出完整时用价格表估算（¥）。两种币种不混算。
  let costText = null;
  let costReported = false;
  if (reportedCostTurns > 0) {
    costText = `$${reportedCostUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    costReported = true;
  } else if (opts.price && completeInputBreakdown && complete.outputTokens && (totalIn > 0 || output > 0)) {
    // 单价为 ¥/百万 token，费用需除以 1_000_000
    const cost = (input * num(opts.price.in) + output * num(opts.price.out)
      + cacheRead * num(opts.price.cacheRead) + cacheWrite * num(opts.price.cacheWrite)) / 1_000_000;
    costText = `¥${cost.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return {
    turns, steps, llmMs, ttftAvgText, rateText, cacheHitText,
    ctxText, ctxHot,
    // Sum each turn's complete total (legacy: three buckets); partial turns
    // retain a lower bound. Split display requires every bucket to be known.
    inText: formatObservedTokens(totalIn, completeInput), outText: formatObservedTokens(output, complete.outputTokens), costText, costReported,
    // 展示层拆分（PR198 4a）：与单回合口径一致——纯 fresh 输入 + 缓存读。
    inFreshText: completeInputBreakdown ? formatTokens(input) : null,
    cacheReadText: completeInputBreakdown && cacheRead > 0 ? formatTokens(cacheRead) : null,
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
    tokenUsageMetrics,
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
    tokenUsageMetrics,
    // 命中率公式单独暴露：口径必须可被测试锁住（部分命中不得显示 100%）。
    cacheHitPercentText,
  };
}
