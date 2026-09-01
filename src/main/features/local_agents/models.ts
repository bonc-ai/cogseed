/**
 * Static model catalogs for local CLI agents.
 *
 * Two CLIs ship with a curated list users can pick from (claude, codex);
 * the others (openclaw, opencode, hermes) return [] which the UI treats
 * as "free-text entry" — these CLIs either route by user account
 * (openclaw bonds models to pre-registered agents), enumerate via their
 * own `models` subcommand we don't shell yet (opencode), or advertise
 * via ACP at runtime (hermes). Dynamic discovery is a future option;
 * for v1 we keep the surface tiny and let users type the id.
 *
 * 统一执行入口 · 外接智能体执行控制（feat/external-agent-exec-control）：
 * 运行时扫描（网关 /p3394/models，问 CLI 本身）是模型清单的主数据源，
 * 本静态目录降级为扫描失败时的兜底 + 上下文窗口的别名映射源。
 * `default: true` is a UI hint only — at execute time, an empty
 * `agent.runtime.model` field tells the backend to pass nothing and let
 * the CLI resolve its own default (which tracks the user's account /
 * environment more accurately than any list we bake here).
 */

import type { LocalCliType } from './registry.js';
import { publicContextWindowFor } from '../../model/public_model_catalog.js';

export type LocalModel = {
  id: string;
  label: string;
  /** Optional display hint; UI badges this entry as the recommended pick. */
  default?: boolean;
  /** Context window in tokens (alias resolution + session-stats denominator). */
  contextWindow?: number;
};

const CATALOG: Record<LocalCliType, LocalModel[]> = {
  // claude：别名清单与 CLI `/model` 本地命令披露的可用集对齐（2026-08 实测），
  // 作为运行时扫描的静态镜像/兜底。窗口为公开规格：sonnet/opus/haiku 系
  // 200K，[1m] 长上下文变体 1M；best/default/opusplan/fable 跟随 CLI 自身
  // 解析，不标窗口（诚实省略，不编数字）。
  claude: [
    { id: 'default', label: '默认（跟随 CLI）', default: true },
    { id: 'sonnet', label: 'Sonnet', contextWindow: 200_000 },
    { id: 'opus', label: 'Opus', contextWindow: 200_000 },
    { id: 'haiku', label: 'Haiku', contextWindow: 200_000 },
    { id: 'sonnet[1m]', label: 'Sonnet 1M', contextWindow: 1_048_576 },
    { id: 'opus[1m]', label: 'Opus 1M', contextWindow: 1_048_576 },
  ],
  // codex：窗口未在静态目录标注的条目走 public_model_catalog（gpt-5.6 系
  // 已有 272K/372K 数据）。
  codex: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', default: true, contextWindow: 272_000 },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', contextWindow: 272_000 },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', contextWindow: 272_000 },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
  ],
  // Free-text entry; the UI renders an <input> instead of a <select>.
  openclaw: [],
  opencode: [],
  hermes: [],
  gemini: [],
  aider: [],
  // WorkBuddy (Tencent) routes models by account; `auto` lets the CLI pick
  // (verified: init reports model:"auto"). The list below mirrors the CLI's
  // own --help disclosure (2026-08 实测 "Currently supported" 括号清单)——
  // 运行时扫描同源；an empty runtime.model still means "let the CLI decide".
  workbuddy: [
    { id: 'auto', label: '自动（由 WorkBuddy 选择）', default: true },
    { id: 'hy4-preview', label: 'hy4-preview' },
    { id: 'hy3', label: 'Hunyuan 3' },
    { id: 'hy3-x', label: 'hy3-x' },
    { id: 'glm-5.3', label: 'GLM-5.3' },
    { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash' },
    { id: 'glm-5.2', label: 'GLM-5.2' },
    { id: 'glm-5.1', label: 'GLM-5.1' },
    { id: 'glm-5v-turbo', label: 'GLM-5v Turbo' },
    { id: 'minimax-m3', label: 'MiniMax M3' },
    { id: 'kimi-k3-1', label: 'Kimi K3.1' },
    { id: 'kimi-k2.7', label: 'Kimi K2.7' },
    { id: 'kimi-k2.6', label: 'Kimi K2.6' },
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  ],
};

/** Return the static model list for a CLI type. Empty = free-text entry. */
export function listModels(cli: LocalCliType): LocalModel[] {
  return CATALOG[cli] ?? [];
}

/**
 * The default model id for a CLI, or null if either the catalog is
 * empty or no entry is flagged `default: true`. Callers that need a
 * value to pre-fill the form use this; runner code never relies on it
 * (empty `agent.runtime.model` is a valid intent — "let the CLI pick").
 */
export function defaultModel(cli: LocalCliType): string | null {
  const list = listModels(cli);
  return list.find((m) => m.default)?.id ?? null;
}

// ── 外接智能体执行控制（统一执行入口）──────────────────────────────────
// 能力权威来源是网关运行时协商（/p3394/models 的 model_controllable：
// 预设 modelArgs 模板或 P3394_AGENT_MODEL_ARGS 自定义声明）。本表只是
// 渲染层冷启动兜底（扫描未返回时的初始显隐）：
// - model：预设 8 个 CLI 中 6 个有参数通道（claude/opencode/gemini/aider/
//   workbuddy 模板 + codex 专有通道），自定义智能体经 env 声明——兜底全开，
//   协商回 false（如 hermes/openclaw 无通道）时渲染层收起控件。
// - effort：各家强度参数语义差异大（claude 思考预算/codex effort/其余无），
//   只对有真实链路的 CLI 开放，不通用化。
export interface CliExecControl {
  model: boolean;
  effort: boolean;
}
const CLI_EXEC_CONTROL: Record<string, CliExecControl> = {
  claude: { model: true, effort: true },
  codex: { model: true, effort: true },
  opencode: { model: true, effort: false },
  gemini: { model: true, effort: false },
  aider: { model: true, effort: false },
  workbuddy: { model: true, effort: false },
};
export function execControlFor(cli: string): CliExecControl {
  // model 兜底全开（任意外接智能体都可尝试控制，网关无通道即安全忽略）；
  // effort 仅表内 CLI。
  const type = String(cli || '').trim();
  const known = CLI_EXEC_CONTROL[type];
  return known ?? { model: true, effort: false };
}

/** 别名/模型 id → 上下文窗口（会话统计的 ctx 分母）。优先级：claude 别名
 *  公开规格 → 静态目录条目 → 公共模型目录。未知返回 null（渲染层诚实省略
 *  分母，只显示已用量）。 */
export function contextWindowForCliModel(cli: string, modelId: string): number | null {
  const id = String(modelId || '').trim();
  if (!id) return null;
  const type = String(cli || '').trim();
  if (type === 'claude') {
    if (id.includes('[1m]')) return 1_048_576;
    if (/^(sonnet|opus|haiku|best|default|opusplan|fable)$/i.test(id)) return 200_000;
    if (/-1m\b|\[1m\]/i.test(id) || /1m$/i.test(id)) return 1_048_576;
    if (/^claude-(sonnet|opus|haiku)/i.test(id)) return 200_000;
  }
  const staticHit = (CATALOG[type as LocalCliType] ?? []).find((m) => m.id === id);
  if (staticHit && typeof staticHit.contextWindow === 'number' && staticHit.contextWindow > 0) {
    return staticHit.contextWindow;
  }
  const fromCatalog = publicContextWindowFor(id);
  return typeof fromCatalog === 'number' && fromCatalog > 0 ? fromCatalog : null;
}
