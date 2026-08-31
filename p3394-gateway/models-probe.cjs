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

function executionPrefsFor(envelope) {
  const ext = (envelope && envelope.extensions) || {};
  const prefs = ext.execution_prefs;
  if (!prefs || typeof prefs !== 'object') return null;
  const effort = typeof prefs.reasoning_effort === 'string' ? prefs.reasoning_effort.trim().toLowerCase() : '';
  const hasEffort = Object.prototype.hasOwnProperty.call(EXEC_EFFORT_TOKENS, effort);
  const model = typeof prefs.model === 'string' ? prefs.model.trim().slice(0, 200) : '';
  if (!hasEffort && !model) return null;
  return {
    // maxThinkingTokens：claude 系 runtime 的档位→预算映射；reasoningEffort：
    // 原始档位（codex 的 config.model_reasoning_effort 直接消费）。
    ...(hasEffort ? { maxThinkingTokens: EXEC_EFFORT_TOKENS[effort], reasoningEffort: effort } : {}),
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
function probeClaudeModels(deps = {}) {
  const cli = deps.cli || 'claude';
  const spawnFn = deps.spawnFn || defaultSpawn;
  return new Promise((resolve) => {
    const args = ['-p', '/model', '--output-format', 'json'];
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
    child.stdout.on('data', (chunk) => { if (out.length < 64 * 1024) out += chunk; });
    child.stderr.on('data', (chunk) => { if (stderrTail.length < 2048) stderrTail += chunk; });
    child.on('error', (error) => {
      finish({ status: 'unavailable', reason: 'spawn_failed', error: error.message });
    });
    child.on('close', () => {
      if (settled) return;
      try {
        const parsed = JSON.parse(out.trim());
        const resultText = typeof parsed.result === 'string' ? parsed.result : '';
        const currentDisplay = /Current model:\s*(.+?)(?:\s*\(effort:[^)]*\))?\s*$/.exec(resultText.split('\n')[0] || '');
        const avail = /Available:\s*([^.]+)/.exec(resultText);
        const ids = (avail && avail[1] ? avail[1] : '')
          .split(',')
          .map((s) => s.trim())
          // 别名不含空格；", or a full model ID" 尾注与杂项一并滤掉。
          .filter((id) => id && !id.includes(' '));
        if (ids.length) {
          const models = ids.map((id) => ({ id, label: id }));
          const current = (claudeModelsCache.get() || {}).current
            || (currentDisplay ? currentDisplay[1].trim() : null);
          claudeModelsCache.set({ models, current });
          finish({ status: 'ready', models, current });
        } else {
          finish({ status: 'unavailable', reason: 'no_model_list', stderrTail: stderrTail.slice(-300) || undefined });
        }
      } catch (error) {
        finish({ status: 'unavailable', reason: 'parse_failed', error: error && error.message ? error.message : String(error), stderrTail: stderrTail.slice(-300) || undefined });
      }
    });
  });
}

/** 子命令枚举表（opencode models 等）：新 CLI 在此登记一条即接入扫描。 */
const INSPECT_SUBCOMMANDS = Object.freeze({ opencode: 'models' });

/** 子命令枚举探测：每行一个模型 id（`provider/model` 或裸 id）。
 *  deps: { cli, presetName, subcommands, spawnFn, env }。 */
function probeSubcommandModels(deps = {}) {
  const cli = deps.cli || '';
  const presetName = deps.presetName || '';
  const spawnFn = deps.spawnFn || defaultSpawn;
  const sub = (deps.subcommands || INSPECT_SUBCOMMANDS)[presetName];
  if (!sub) return Promise.resolve({ status: 'unavailable', reason: 'no_inspect_command' });
  return new Promise((resolve) => {
    let out = '';
    let stderrTail = '';
    let settled = false;
    const child = spawnFn(cli, [sub], { stdio: ['ignore', 'pipe', 'pipe'] });
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
      const models = [];
      const seen = new Set();
      for (const line of out.split(/\r?\n/)) {
        const id = line.trim();
        if (!id || id.includes(' ')) continue; // 帮助文本/杂项行
        if (!seen.has(id)) {
          seen.add(id);
          const slash = id.indexOf('/');
          models.push({ id, label: slash > 0 ? id.slice(slash + 1) : id });
        }
      }
      if (models.length) finish({ status: 'ready', models });
      else finish({ status: 'unavailable', reason: code === 0 ? 'empty_output' : 'exit_' + code, stderrTail: stderrTail.slice(-300) || undefined });
    });
  });
}

module.exports = {
  EXEC_EFFORT_TOKENS,
  executionPrefsFor,
  extractClaudeResultUsage,
  normalizeClaudeInit,
  claudeModelsCache,
  probeClaudeModels,
  probeSubcommandModels,
  INSPECT_SUBCOMMANDS,
};
