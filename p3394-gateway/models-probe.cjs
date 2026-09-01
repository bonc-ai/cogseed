'use strict';
// ── 外接智能体执行控制：模型发现 + 单轮偏好 + 用量提取（纯函数模块）──────
// 从 gateway.cjs 抽出的可测单元：gateway.cjs 顶层即起 HTTP 服务，无法被测试
// 直接 require；本模块保持零顶层副作用（不监听、不 spawn），探测函数通过
// deps 注入 cli/spawnFn，测试用 fake spawn 覆盖行为分支。
// npm 分发（p3394-gateway 包）随 files 数组一起发布。

const { spawn: defaultSpawn } = require('node:child_process');

// ── CogSeed 扩展：extensions.execution_prefs（单轮执行偏好透传） ──
// CogSeed 主机可按轮次携带 { reasoning_effort, model }。旧版宿主不发
// 该字段 → null，行为与既往完全一致；未知/白名单外的值一律视为"跟随
// CLI 自身默认"。档位→token 预算为启发式映射，与 CogSeed 本地直连
// backend 保持同一份取值。
const EXEC_EFFORT_TOKENS = Object.freeze({ low: '8192', high: '32000' });
// 档位全集：off 只对参数模板通道（effortArgs）有意义——hermes
// --reasoning none / openclaw --thinking off 有真实禁用语义；claude 的
// maxThinkingTokens 无 off 入口，off 不产出 token 预算。
const EXEC_EFFORT_LEVELS = Object.freeze(['off', 'low', 'high']);

function executionPrefsFor(envelope) {
  const ext = (envelope && envelope.extensions) || {};
  const prefs = ext.execution_prefs;
  if (!prefs || typeof prefs !== 'object') return null;
  const effort = typeof prefs.reasoning_effort === 'string' ? prefs.reasoning_effort.trim().toLowerCase() : '';
  const hasEffort = EXEC_EFFORT_LEVELS.includes(effort);
  const model = typeof prefs.model === 'string' ? prefs.model.trim().slice(0, 200) : '';
  if (!hasEffort && !model) return null;
  return {
    // maxThinkingTokens：claude 系 runtime 的档位→预算映射（off 无此语义，
    // 不产出）；reasoningEffort：原始档位（codex 的 config 与参数模板通道
    // effortArgs 都消费它）。
    ...(hasEffort && effort !== 'off' ? { maxThinkingTokens: EXEC_EFFORT_TOKENS[effort] } : {}),
    ...(hasEffort ? { reasoningEffort: effort } : {}),
    ...(model ? { model } : {}),
  };
}

/** claude stream-json 终态 result 帧的用量提取（与 CogSeed 直连 backend 的
 *  extractClaudeUsage 同一字段集）：token 计数 + CLI 自报成本 + 实际模型名。
 *  随回复信封 payload.metadata.usage 带回宿主，宿主折进消息 metrics——
 *  网关路径的回合统计由此而来。 */
function extractClaudeResultUsage(ev) {
  const u = ev && ev.usage;
  if (!u || typeof u !== 'object') return undefined;
  const out = {};
  if (typeof u.input_tokens === 'number') out.input = u.input_tokens;
  if (typeof u.output_tokens === 'number') out.output = u.output_tokens;
  if (typeof u.cache_read_input_tokens === 'number') out.cacheRead = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === 'number') out.cacheCreate = u.cache_creation_input_tokens;
  if (typeof ev.total_cost_usd === 'number' && Number.isFinite(ev.total_cost_usd)) out.costUsd = ev.total_cost_usd;
  // 实际模型名与直连 backend 同一双路径（result 帧 message.model 优先、根级
  // model 兜底）——metrics.model 是会话统计 ctx 分母的解析键。
  const model = (ev && ev.message && typeof ev.message.model === 'string' && ev.message.model)
    || (typeof ev.model === 'string' ? ev.model : '');
  if (model) out.model = model;
  return Object.keys(out).length ? out : undefined;
}

// ── claude stream-json 过程帧分类（CodexHost 式工具调用/思考可见性）────
// 每轮一个分类器实例（有状态：content_block index → 块类型）。输入原始
// stream-json 行对象，输出宿主过程栏已支持的结构化事件（stream:'tool'/
// 'item'reasoning），文本 delta/终态帧不归它管（返回 null 走原路径）。
function createClaudeStreamEventClassifier() {
  const blockTypes = new Map(); // index → { type, name }
  let thinkingOpen = false;
  return function classify(line) {
    let ev;
    try { ev = typeof line === 'string' ? JSON.parse(line) : line; } catch { return null; }
    if (!ev || ev.type !== 'stream_event' || !ev.event || typeof ev.event !== 'object') return null;
    const inner = ev.event;
    const idx = typeof inner.index === 'number' ? inner.index : -1;
    if (inner.type === 'content_block_start') {
      const block = (inner.content_block && typeof inner.content_block === 'object') ? inner.content_block : {};
      const type = String(block.type || '');
      const name = typeof block.name === 'string' ? block.name : '';
      blockTypes.set(idx, { type, name });
      if (type === 'tool_use') {
        const input = (block.input && typeof block.input === 'object' && Object.keys(block.input).length)
          ? block.input : null;
        return { stream: 'tool', data: { name: name || 'tool', phase: 'start', ...(input ? { arguments: input } : {}) } };
      }
      if (type === 'thinking' && !thinkingOpen) {
        thinkingOpen = true;
        return { stream: 'item', data: { itemType: 'reasoning', phase: 'start' } };
      }
      return null;
    }
    if (inner.type === 'content_block_stop') {
      const block = blockTypes.get(idx);
      blockTypes.delete(idx);
      if (!block) return null;
      if (block.type === 'tool_use') {
        return { stream: 'tool', data: { name: block.name || 'tool', phase: 'end' } };
      }
      if (block.type === 'thinking' && thinkingOpen) {
        thinkingOpen = false;
        return { stream: 'item', data: { itemType: 'reasoning', phase: 'end' } };
      }
      return null;
    }
    return null;
  };
}

/** claude init 帧 models 数组（[{value,displayName,resolvedModel?}]）→ 统一
 *  {id,label}。init.model 是 CLI 当前解析到的默认模型，一并带回。 */
function normalizeClaudeInit(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const models = Array.isArray(ev.models)
    ? ev.models
        .filter((m) => m && typeof m === 'object' && typeof m.value === 'string' && m.value.trim())
        .map((m) => ({ id: m.value.trim(), label: (typeof m.displayName === 'string' && m.displayName.trim()) || m.value.trim() }))
    : null;
  const current = typeof ev.model === 'string' && ev.model.trim() ? ev.model.trim() : null;
  if (!models || !models.length) return null;
  return { models, current };
}

// 最近一次 claude init 帧的归一化结果（常驻/每轮两个 runtime 的解析器都会
// 写）。init.model 是 CLI 当前解析到的默认模型 full id——/model 探测的
// current 用它补全（探测只拿得到展示名）；未来版本若 init 恢复 models
// 数组则直接采用。
const claudeModelsCache = (() => {
  let last = null; // { models, current } | null
  return {
    get() { return last; },
    set(v) { last = (v && Array.isArray(v.models) && v.models.length) ? v : null; },
    clear() { last = null; },
  };
})();

function inspectTimeoutMs(env) {
  const n = Number((env && env.P3394_INSPECT_TIMEOUT_MS) || process.env.P3394_INSPECT_TIMEOUT_MS || 25_000);
  return Number.isFinite(n) && n > 0 ? n : 25_000;
}

/** claude 冷启动探测（实测路径，2026-08 claude Code）：
 *  `claude -p "/model" --output-format json` 是纯本地命令（duration_api_ms=0、
 *  total_cost_usd=0、num_turns=0——零模型调用），result 里带 Current model
 *  与 Available 别名清单。别名清单是 CLI 自家披露的真实可选集（随账号/订阅
 *  变化），比任何预置表都可信；完整模型 ID 也被接受（"or a full model
 *  ID"）——宿主侧手输兜底因此天然成立。
 *  deps: { cli, spawnFn, env }——spawnFn 注入以便测试 fake 子进程。 */
/** claude 模型探测：走通用枚举探测（claude-model-list parser），结果写入
 *  init 缓存；current 优先用缓存里的 full id（常驻会话 init 帧披露），
 *  探测只得展示名。deps: { cli, spawnFn, env }。 */
function probeClaudeModels(deps = {}) {
  return probeInspectCommand({
    cli: deps.cli || 'claude',
    args: ['-p', '/model', '--output-format', 'json'],
    parser: 'claude-model-list',
    spawnFn: deps.spawnFn,
    env: deps.env,
  }).then((result) => {
    if (result.status === 'ready') {
      const cachedCurrent = (claudeModelsCache.get() || {}).current;
      const current = cachedCurrent || result.current || null;
      claudeModelsCache.set({ models: result.models, current });
      return { ...result, current };
    }
    return result;
  });
}

/** 子命令枚举表：新 CLI 在 gateway PRESETS 的 inspect 声明里登记，不再
 *  维护独立映射（INSPECT_SUBCOMMANDS 保留兼容导出）。 */
const INSPECT_SUBCOMMANDS = Object.freeze({ opencode: 'models' });

// ── 模型参数通道（通用）：任意外接智能体的模型控制声明 ───────────────────
// 模板形如 '--model {model}' / '-m {model}'；'{model}' 替换为所选模型 id。
// 预设表（gateway PRESETS.modelArgs）之外，自定义智能体用
// P3394_AGENT_MODEL_ARGS 声明同一模板即可接入模型控制——无需改代码。

/** 生效的模型参数模板：env 覆盖（自定义声明）优先，其次预设声明。返回
 *  null = 该 CLI 无模型参数通道（信封里的 model 会被网关安全忽略）。 */
function modelArgsFor(preset, env = process.env) {
  const fromEnv = String((env && env.P3394_AGENT_MODEL_ARGS) || '').trim();
  if (fromEnv) return fromEnv;
  const fromPreset = preset && typeof preset.modelArgs === 'string' ? preset.modelArgs.trim() : '';
  return fromPreset || null;
}

/** 该 CLI 的模型是否可控：有参数模板，或走专有通道（codex 的
 *  app-server thread 参数，预设里以 modelControllable 声明）。 */
function modelControllableFor(preset, env = process.env) {
  if (modelArgsFor(preset, env)) return true;
  return !!(preset && preset.modelControllable);
}

/** 单轮强度参数模板（与 modelArgsFor 同模式）：预设 effortArgs 声明
 *  （'{effort}' 占位）或 P3394_AGENT_EFFORT_ARGS 自定义声明；null = 该
 *  CLI 无强度参数通道（信封 reasoning_effort 被网关安全忽略）。 */
function effortArgsFor(preset, env = process.env) {
  const fromEnv = String((env && env.P3394_AGENT_EFFORT_ARGS) || '').trim();
  if (fromEnv) return fromEnv;
  const fromPreset = preset && typeof preset.effortArgs === 'string' ? preset.effortArgs.trim() : '';
  return fromPreset || null;
}

/** CogSeed 档位（off/low/high）→ CLI 取值。预设 effortLevels 声明映射
 *  （如 hermes off→none）；未声明的档位恒等（openclaw 的 off|low|high
 *  与 CogSeed 同名零配置）；不在档位全集内返回 null（不下发，跟随 CLI
 *  自身默认）。 */
function effortLevelFor(preset, level) {
  const key = String(level || '').trim().toLowerCase();
  if (!EXEC_EFFORT_LEVELS.includes(key)) return null;
  const map = (preset && preset.effortLevels && typeof preset.effortLevels === 'object')
    ? preset.effortLevels
    : null;
  const mapped = map && Object.prototype.hasOwnProperty.call(map, key) ? String(map[key]) : key;
  return mapped.trim() || null;
}

/** 引号感知的 argv 切分（模板可含带空格的参数；{model} 先替换再切分，
 *  模型 id 含空格时按引号包裹语义处理）。 */
function splitModelArgs(template, modelId) {
  const raw = String(template || '').replace(/\{model\}/g, String(modelId || ''));
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(raw)) !== null) out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  return out.filter((part) => part !== '');
}

// ── 枚举输出解析器（按 gateway PRESETS.inspect.parser 声明选用） ─────────
const INSPECT_PARSERS = {
  /** opencode models：每行一个 `provider/model` 或裸 id。 */
  lines(out) {
    const models = [];
    const seen = new Set();
    for (const line of String(out || '').split(/\r?\n/)) {
      const id = line.trim();
      if (!id || id.includes(' ')) continue; // 帮助文本/杂项行
      if (!seen.has(id)) {
        seen.add(id);
        const slash = id.indexOf('/');
        models.push({ id, label: slash > 0 ? id.slice(slash + 1) : id });
      }
    }
    return models.length ? { models } : null;
  },
  /** claude `claude -p /model --output-format json`：Current model（含
   *  effort 档位副信息）+ Available 别名清单（零模型调用的纯本地命令）。 */
  'claude-model-list'(out) {
    let parsed;
    try { parsed = JSON.parse(String(out || '').trim()); } catch { return null; }
    const resultText = typeof parsed.result === 'string' ? parsed.result : '';
    const head = resultText.split('\n')[0] || '';
    const currentDisplay = /Current model:\s*(.+?)(?:\s*\(effort:([^)]*)\))?\s*$/.exec(head);
    // effort 副信息（如 "xhigh"）——CLI 自报的当前思考强度，菜单展示用。
    const currentEffort = (currentDisplay && typeof currentDisplay[2] === 'string' && currentDisplay[2].trim()) || null;
    const avail = /Available:\s*([^.]+)/.exec(resultText);
    const ids = (avail && avail[1] ? avail[1] : '')
      .split(',')
      .map((s) => s.trim())
      // 别名不含空格；", or a full model ID" 尾注与杂项一并滤掉。
      .filter((id) => id && !id.includes(' '));
    if (!ids.length) return null;
    return {
      models: ids.map((id) => ({ id, label: id })),
      currentDisplay: currentDisplay ? currentDisplay[1].trim() : null,
      ...(currentEffort ? { currentEffort } : {}),
    };
  },
  /** workbuddy `--help`：`--model <model>` 行内 "Currently supported:
   *  (a, b, c)" 括号清单（CLI 自家披露的完整可选集）。 */
  'help-model-list'(out) {
    const text = String(out || '');
    const line = text.split(/\r?\n/).find((l) => /--model/.test(l) && /currently supported/i.test(l));
    if (!line) return null;
    const paren = /\(([^()]*)\)\s*(?:$|\n)/.exec(line);
    const ids = (paren && paren[1] ? paren[1] : '')
      .split(',')
      .map((s) => s.trim())
      .filter((id) => id && !id.includes(' '));
    if (!ids.length) return null;
    return { models: ids.map((id) => ({ id, label: id })) };
  },
};

/** 通用枚举探测：spawn cli + 声明的 args，按声明的 parser 解析 stdout。
 *  deps: { cli, args, parser, spawnFn, env, keepCurrentFrom }。 */
function probeInspectCommand(deps = {}) {
  const cli = deps.cli || '';
  const args = Array.isArray(deps.args) ? deps.args : [];
  const parser = INSPECT_PARSERS[deps.parser];
  const spawnFn = deps.spawnFn || defaultSpawn;
  if (!cli || !parser) return Promise.resolve({ status: 'unavailable', reason: 'no_inspect_declared' });
  return new Promise((resolve) => {
    let out = '';
    let stderrTail = '';
    let settled = false;
    const child = spawnFn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish({ status: 'unavailable', reason: 'timeout', stderrTail: stderrTail.slice(-300) });
    }, inspectTimeoutMs(deps.env));
    child.stdout.on('data', (chunk) => { if (out.length < 256 * 1024) out += chunk; });
    child.stderr.on('data', (chunk) => { if (stderrTail.length < 2048) stderrTail += chunk; });
    child.on('error', (error) => {
      finish({ status: 'unavailable', reason: 'spawn_failed', error: error.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      let parsed = null;
      try { parsed = parser(out); } catch { parsed = null; }
      if (parsed && parsed.models && parsed.models.length) {
        finish({
          status: 'ready',
          models: parsed.models,
          ...(parsed.currentDisplay ? { current: parsed.currentDisplay } : {}),
          ...(parsed.currentEffort ? { current_effort: parsed.currentEffort } : {}),
        });
      } else {
        finish({ status: 'unavailable', reason: code === 0 ? 'no_model_list' : 'exit_' + code, stderrTail: stderrTail.slice(-300) || undefined });
      }
    });
  });
}

/** 子命令枚举探测（兼容旧签名：cli/presetName/subcommands 注入）。
 *  deps: { cli, presetName, subcommands, spawnFn, env }。 */
function probeSubcommandModels(deps = {}) {
  const cli = deps.cli || '';
  const presetName = deps.presetName || '';
  const spawnFn = deps.spawnFn || defaultSpawn;
  const sub = (deps.subcommands || INSPECT_SUBCOMMANDS)[presetName];
  if (!sub) return Promise.resolve({ status: 'unavailable', reason: 'no_inspect_command' });
  return probeInspectCommand({ cli, args: [sub], parser: 'lines', spawnFn, env: deps.env });
}

/** claude 兼容 CLI（codebuddy 等）的当前模型探测：双工 stream-json 起进程、
 *  写一条 user 消息触发 init 帧、抓 model 字段即杀（模型调用不会发生）。
 *  deps: { cli, args, spawnFn, env }。CodexHost 对标：effectiveModel 的
 *  本地事实源之一。 */
function probeStreamJsonInitModel(deps = {}) {
  const cli = deps.cli || '';
  const baseArgs = Array.isArray(deps.args) ? deps.args : [];
  const spawnFn = deps.spawnFn || defaultSpawn;
  if (!cli) return Promise.resolve(null);
  return new Promise((resolve) => {
    const args = [...baseArgs, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    let lineBuf = '';
    let settled = false;
    const child = spawnFn(cli, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), inspectTimeoutMs(deps.env));
    child.stdout.on('data', (chunk) => {
      lineBuf += chunk.toString('utf8');
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev && ev.type === 'system' && ev.subtype === 'init') {
            // models 数组（若 CLI 披露）一并带回；current 即 model 字段。
            finish({
              current: (typeof ev.model === 'string' && ev.model) ? ev.model.trim() : null,
              models: normalizeClaudeInit(ev) ? normalizeClaudeInit(ev).models : null,
            });
            return;
          }
        } catch { /* non-JSON line */ }
      }
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    try {
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n');
    } catch { finish(null); }
  });
}

/** codex 当前默认模型：读本机 CODEX_HOME 的 config.toml `model = "..."`
 *  行（网关与 codex 同机，配置文件即事实源；无文件/无字段返回 null）。 */
function probeCodexConfigModel(fsLike, env = process.env) {
  try {
    const fsMod = fsLike || require('node:fs');
    const osMod = require('node:os');
    const pathMod = require('node:path');
    const home = (env && env.CODEX_HOME) || pathMod.join(osMod.homedir(), '.codex');
    const text = fsMod.readFileSync(pathMod.join(home, 'config.toml'), 'utf8');
    const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(text);
    return m ? m[1] : null;
  } catch { return null; }
}

// ── 声明式配置枚举（hermes / openclaw）──────────────────────────────────
// 这两家 CLI 的「已配置模型」躺在各自磁盘配置里（无通用枚举子命令）：
//   hermes   ~/.hermes/config.yaml（model.default/provider）
//            + ~/.hermes/provider_models_cache.json（CLI 自己维护的各
//              provider /v1/models 缓存——hermes model --refresh 会重建）
//   openclaw ~/.openclaw/openclaw.json（models.providers[].models 元数据
//            + agents.defaults.model.primary 当前绑定）
// 网关与 CLI 同机 → 读文件即事实源，比 spawn 探测快且零副作用。
// readFileSync 注入（测试 fake）；解析失败/无模型 → unavailable 降级，
// 宿主回落静态目录+手输（与 inspect 探测同一降级语义）。

/** hermes config.yaml 顶层 model: 段的 default/provider（两层小状态机：
 *  只认零缩进 `model:` 进入、下一个顶层 key 退出——providers: 段里的
 *  default_model 不属于本段，不误读）。 */
function hermesModelSection(yamlText) {
  let inSection = false;
  const out = { default: '', provider: '' };
  for (const line of String(yamlText || '').split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const isTop = /^[^\s#]/.test(line);
    if (isTop) {
      inSection = /^model:\s*$/.test(line);
      continue;
    }
    if (!inSection) continue;
    let m = /^\s+default:\s*(\S+)\s*$/.exec(line);
    if (m) { out.default = m[1].replace(/^['"]|['"]$/g, ''); continue; }
    m = /^\s+provider:\s*(\S+)\s*$/.exec(line);
    if (m) { out.provider = m[1].replace(/^['"]|['"]$/g, ''); }
  }
  return out;
}

function hermesConfigModels(fsMod, pathMod, env, readFileSync) {
  const home = (env && env.HOME) || require('node:os').homedir();
  const section = hermesModelSection(readFileSync(pathMod.join(home, '.hermes', 'config.yaml'), 'utf8'));
  let cache = null;
  try {
    cache = JSON.parse(readFileSync(pathMod.join(home, '.hermes', 'provider_models_cache.json'), 'utf8'));
  } catch { /* 无缓存：只报 current，清单交给宿主静态/手输 */ }
  const ids = (cache && section.provider
    && cache[section.provider] && Array.isArray(cache[section.provider].models)
    ? cache[section.provider].models : []
  ).filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim());
  // 无 provider 清单也可用配置声明的默认模型（至少让 chip 显示 current）。
  if (!ids.length && !section.default) return { status: 'unavailable', reason: 'config_no_models' };
  return {
    status: 'ready',
    models: ids.map((id) => ({ id, label: id })),
    ...(section.default ? { current: section.default } : {}),
  };
}

function openclawConfigModels(fsMod, pathMod, env, readFileSync) {
  const home = (env && env.HOME) || require('node:os').homedir();
  const cfg = JSON.parse(readFileSync(pathMod.join(home, '.openclaw', 'openclaw.json'), 'utf8'));
  const providers = (cfg && cfg.models && typeof cfg.models.providers === 'object' && cfg.models.providers) || {};
  const models = [];
  for (const list of Object.values(providers)) {
    for (const m of ((list && Array.isArray(list.models)) ? list.models : [])) {
      if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id.trim()) continue;
      models.push({
        id: m.id.trim(),
        label: (typeof m.name === 'string' && m.name.trim()) || m.id.trim(),
        ...(Number.isFinite(m.contextWindow) && m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
      });
    }
  }
  if (!models.length) return { status: 'unavailable', reason: 'config_no_models' };
  const primary = String(((cfg.agents && cfg.agents.defaults && cfg.agents.defaults.model) || {}).primary || '').trim();
  // primary 形如 "agnes/agnes-2.5-flash"（provider 前缀）——剥前缀与清单
  // id 同口径，UI 的 isCurrent 才能命中；裸 id 原样。
  const current = primary ? (primary.includes('/') ? primary.split('/').slice(1).join('/') : primary) : '';
  return { status: 'ready', models, ...(current ? { current } : {}) };
}

const CONFIG_MODEL_PARSERS = {
  hermes: hermesConfigModels,
  openclaw: openclawConfigModels,
};

/** 声明式配置枚举入口。deps: { configModels（解析器键）, env, readFileSync }。
 *  返回与 probeInspectCommand 同形状（ready/unavailable + models/current）。 */
function probeConfigModels(deps = {}) {
  const parser = CONFIG_MODEL_PARSERS[String(deps.configModels || '')];
  const readFileSync = typeof deps.readFileSync === 'function' ? deps.readFileSync : null;
  if (!parser || !readFileSync) return { status: 'unavailable', reason: 'no_config_probe' };
  try {
    return parser(null, require('node:path'), deps.env || {}, readFileSync);
  } catch {
    return { status: 'unavailable', reason: 'config_read_failed' };
  }
}

module.exports = {
  EXEC_EFFORT_TOKENS,
  executionPrefsFor,
  extractClaudeResultUsage,
  normalizeClaudeInit,
  createClaudeStreamEventClassifier,
  claudeModelsCache,
  probeClaudeModels,
  probeSubcommandModels,
  probeInspectCommand,
  probeStreamJsonInitModel,
  probeCodexConfigModel,
  probeConfigModels,
  CONFIG_MODEL_PARSERS,
  INSPECT_SUBCOMMANDS,
  INSPECT_PARSERS,
  modelArgsFor,
  modelControllableFor,
  effortArgsFor,
  effortLevelFor,
  splitModelArgs,
};
