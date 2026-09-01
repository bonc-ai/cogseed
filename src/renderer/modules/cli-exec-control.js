// ─── CLI 执行控制（统一执行入口 · 外接智能体）──────────────────────────
// 渲染层能力表 + 模型扫描客户端 + 上下文窗口解析。与主进程
// features/local_agents/models.ts 的 CLI_EXEC_CONTROL / 别名窗口映射同源
// （经典 script 无 import 能力，只能复制；一致性由
// test/renderer/cli-exec-control.test.ts 钉死——两边漂移测试即红）。
//
// 能力表：claude/codex 的模型与思考强度有真实下发链路（网关信封
// execution_prefs → --model / thread config），表外 CLI 不放假开关。
// 模型清单三层来源：运行时扫描（IPC p3394.external.listModels，问 CLI
// 本身）∪ 静态目录（主进程返回）∪ 手动输入（localStorage 记忆）——扫描
// 失败只是降级，永远不是失败。

const _cliExecLog = (typeof createLogger === 'function') ? createLogger('cli-exec-control') : null;

// 与主进程 CLI_EXEC_CONTROL 同源（测试钉一致性）。模型兜底全开：能力权威
// 是网关运行时协商（modelControllable），本表只在扫描未返回时给初始显隐。
const CLI_EXEC_CONTROL = {
  claude: { model: true, effort: true },
  codex: { model: true, effort: true },
  opencode: { model: true, effort: false },
  gemini: { model: true, effort: false },
  aider: { model: true, effort: false },
  workbuddy: { model: true, effort: false },
};

function execControlFor(cli) {
  return CLI_EXEC_CONTROL[String(cli || '').trim()] || { model: true, effort: false };
}

/** 模型是否可控：网关运行时协商（扫描响应的 modelControllable）优先，
 *  未协商时兜底表（model 全开——任意外接智能体都可控制，网关无通道即
 *  安全忽略跟随自身默认）。 */
function modelControllableFor(cli) {
  const entry = cachedCliModels(cli);
  if (entry && typeof entry.modelControllable === 'boolean') return entry.modelControllable;
  return execControlFor(cli).model;
}

// claude 别名 → 上下文窗口（公开规格；[1m] 变体 1M）。与主进程
// contextWindowForCliModel 的 claude 分支同源。codex 等其余 CLI 的完整 id
// 由主进程静态目录/公共目录兜底，渲染层扫描响应里已带 contextWindow。
const CLAUDE_ALIAS_WINDOW = {
  '[1m]': 1_048_576,
  _default: 200_000,
};

function contextWindowForCliModel(cli, modelId, scannedEntry) {
  const id = String(modelId || '').trim();
  if (!id) return null;
  const type = String(cli || '').trim();
  if (type === 'claude') {
    if (id.includes('[1m]')) return CLAUDE_ALIAS_WINDOW['[1m]'];
    if (/^(sonnet|opus|haiku|best|default|opusplan|fable)$/i.test(id)) return CLAUDE_ALIAS_WINDOW._default;
    if (/^claude-(sonnet|opus|haiku)/i.test(id)) return /1m/i.test(id) ? CLAUDE_ALIAS_WINDOW['[1m]'] : CLAUDE_ALIAS_WINDOW._default;
  }
  // 扫描/静态条目自带的窗口（主进程 IPC 响应已按目录解析过）。
  const fromEntry = scannedEntry && Array.isArray(scannedEntry.models)
    ? scannedEntry.models.find((m) => m && m.id === id)
    : null;
  if (fromEntry && typeof fromEntry.contextWindow === 'number' && fromEntry.contextWindow > 0) {
    return fromEntry.contextWindow;
  }
  const fromStatic = scannedEntry && Array.isArray(scannedEntry.staticModels)
    ? scannedEntry.staticModels.find((m) => m && m.id === id)
    : null;
  if (fromStatic && typeof fromStatic.contextWindow === 'number' && fromStatic.contextWindow > 0) {
    return fromStatic.contextWindow;
  }
  return null;
}

// ── 扫描客户端：per-cli 缓存 + single-flight + 失败不缓存 ────────────────
const _scanCache = new Map();   // cli → { state, models, current, staticModels, at }
const _scanInFlight = new Map(); // cli → Promise
const _SCAN_TTL_MS = 5 * 60_000;

async function loadCliModels(agentId, cli, opts) {
  const key = String(cli || '').trim();
  if (!key || typeof window === 'undefined' || !window.cogseed) {
    return { state: 'unavailable', models: [], staticModels: [], current: null };
  }
  const refresh = !!(opts && opts.refresh);
  if (!refresh) {
    const cached = _scanCache.get(key);
    if (cached && (cached.state === 'ready' || cached.state === 'unavailable')
      && Date.now() - cached.at < _SCAN_TTL_MS) return cached;
  }
  const inflight = _scanInFlight.get(key);
  if (inflight && !refresh) return inflight;
  const attempt = (async () => {
    try {
      const res = await window.cogseed.invoke('p3394.external.listModels', {
        agentId,
        ...(refresh ? { refresh: true } : {}),
      });
      if (!res || !res.ok) {
        return { state: 'unavailable', models: [], staticModels: [], current: null, reason: (res && res.error) || 'ipc_failed', at: Date.now() };
      }
      const models = (res.scanned && res.scanned.status === 'ready' && Array.isArray(res.scanned.models))
        ? res.scanned.models
        : [];
      const entry = {
        // ready=扫描成功；unavailable=扫描失败（静态目录仍可用于展示）。
        state: models.length ? 'ready' : 'unavailable',
        models,
        current: (res.scanned && typeof res.scanned.current === 'string' && res.scanned.current) || null,
        currentEffort: (res.scanned && typeof res.scanned.currentEffort === 'string' && res.scanned.currentEffort) || null,
        // 能力协商独立于清单：unavailable 也可能可控（无枚举接口但有参数通道）。
        modelControllable: !!(res.scanned && res.scanned.modelControllable),
        staticModels: Array.isArray(res.staticModels) ? res.staticModels : [],
        reason: models.length ? null : ((res.scanned && res.scanned.reason) || 'empty_scan'),
        at: Date.now(),
      };
      // ready 长缓存（5 分钟）；unavailable 只缓存 10 秒——主进程侧对失败
      // 本就不缓存，渲染层这里短缓存只为防抖（典型场景：应用启动时网关
      // 尚未 respawn 完成而扫了个空，几秒后应自动重试填上当前模型）。
      if (entry.state === 'ready') _scanCache.set(key, entry);
      else _scanCache.set(key, { ...entry, at: Date.now() - (_SCAN_TTL_MS - 10_000) });
      return entry;
    } catch (err) {
      return { state: 'unavailable', models: [], staticModels: [], current: null, reason: 'ipc_error', error: (err && err.message) || String(err), at: Date.now() };
    }
  })();
  _scanInFlight.set(key, attempt);
  try {
    return await attempt;
  } finally {
    _scanInFlight.delete(key);
  }
}

function cachedCliModels(cli) {
  return _scanCache.get(String(cli || '').trim()) || null;
}

/** 扫描是否在途（chip 的 loading 态：显示「正在加载」而非占位符）。 */
function scanInFlight(cli) {
  return _scanInFlight.has(String(cli || '').trim());
}

// ── 手输记忆：清单外的自定义模型 id（per-cli，localStorage） ─────────────
const _CUSTOM_KEY = 'cli-custom-models';
function customModelsFor(cli) {
  const key = String(cli || '').trim();
  if (!key) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(_CUSTOM_KEY) || '{}');
    const list = raw && typeof raw === 'object' && Array.isArray(raw[key]) ? raw[key] : [];
    return list.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()).slice(0, 20);
  } catch (_) { return []; }
}
function rememberCustomModel(cli, modelId) {
  const key = String(cli || '').trim();
  const id = String(modelId || '').trim();
  if (!key || !id) return;
  try {
    const raw = JSON.parse(localStorage.getItem(_CUSTOM_KEY) || '{}');
    const safe = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const list = (Array.isArray(safe[key]) ? safe[key] : []).filter((x) => typeof x === 'string' && x.trim() && x.trim() !== id);
    list.unshift(id);
    safe[key] = list.slice(0, 20);
    localStorage.setItem(_CUSTOM_KEY, JSON.stringify(safe));
  } catch (err) {
    if (_cliExecLog) _cliExecLog.warn('remember custom model failed', { error: (err && err.message) || String(err) });
  }
}

// ── 合并视图：扫描 ∪ 静态 ∪ 手输（menu 渲染直接消费） ─────────────────────
function mergedCliModels(cli, scanEntry) {
  const seen = new Set();
  const out = [];
  const push = (id, label, source, contextWindow, isDefault, description) => {
    const key = String(id || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({
      id: key,
      label: (label || key),
      source,
      isDefault: !!isDefault,
      ...(typeof contextWindow === 'number' && contextWindow > 0 ? { contextWindow } : {}),
      // 客户端同款副标题（静态目录条目携带；扫描/手输条目回落显示 id）。
      ...(description ? { description } : {}),
    });
  };
  for (const m of (scanEntry && scanEntry.staticModels) || []) push(m.id, m.label, 'static', m.contextWindow, m.default, m.description);
  for (const m of (scanEntry && scanEntry.models) || []) push(m.id, m.label, 'scan', undefined, m.id === 'default' || m.id === 'auto');
  for (const id of customModelsFor(cli)) push(id, id, 'custom');
  // CodexHost 对标排序：default 条目永远第一（claude 的 'default'、
  // workbuddy 的 'auto'），其余保持原序——chip 的默认显示取清单头。
  out.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
  return out;
}

/** 无任务级覆盖时 chip 显示的模型（CodexHost 显示规则：永远显示具体模型
 *  名，不显示「默认」占位）。优先级：扫描 current（CLI 自报当前）> 清单
 *  default 条目 > 清单第一项 > null（完全无数据才允许占位）。 */
function effectiveModelLabel(cli, scanEntry) {
  const entry = scanEntry || cachedCliModels(cli);
  if (entry && entry.current) return { label: entry.current, source: 'current' };
  const merged = mergedCliModels(cli, entry);
  const hit = merged.find((m) => m.isDefault) || merged[0] || null;
  return hit ? { label: hit.label, source: hit.isDefault ? 'default' : 'first' } : null;
}

if (typeof window !== 'undefined') {
  window.cliExecControl = {
    execControlFor,
    modelControllableFor,
    contextWindowForCliModel,
    loadCliModels,
    cachedCliModels,
    scanInFlight,
    effectiveModelLabel,
    customModelsFor,
    rememberCustomModel,
    mergedCliModels,
  };
}

// Test bridge — guarded CommonJS export（照 conversation-metrics.js 模式）。
if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = {
    CLI_EXEC_CONTROL,
    execControlFor,
    modelControllableFor,
    contextWindowForCliModel,
    mergedCliModels,
    effectiveModelLabel,
    customModelsFor,
    rememberCustomModel,
  };
}
