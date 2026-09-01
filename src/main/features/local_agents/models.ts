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
  /** Client-style subtitle shown under the id (menu row secondary line). */
  description?: string;
  /** Context window in tokens (alias resolution + session-stats denominator). */
  contextWindow?: number;
};

const CATALOG: Record<LocalCliType, LocalModel[]> = {
  // claude：与 Claude Code 客户端模型选择器同款公开 id 目录（用户 2026-09
  // 以客户端截图为准对齐）——CLI `/model` 披露的别名（sonnet/opus[1m]…）
  // 经 canonicalClaudeModelId 规范化到这些 id，不再直接进清单。条目顺序即
  // 客户端顺序（能力降序：fable → haiku → opus → sonnet，1M 变体随后），
  // 因此不标 default（跟随 CLI 默认由菜单「跟随 CLI」行承担）。窗口为公开
  // 规格：基础款 200K，[1m] 长上下文变体 1M。
  claude: [
    { id: 'claude-fable-5', label: 'claude-fable-5', description: 'For your toughest challenges', contextWindow: 200_000 },
    { id: 'claude-fable-5[1m]', label: 'claude-fable-5[1m]', description: '1M context window', contextWindow: 1_048_576 },
    { id: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5-20251001', description: 'Fastest for quick answers', contextWindow: 200_000 },
    { id: 'claude-haiku-4-5-20251001[1m]', label: 'claude-haiku-4-5-20251001[1m]', description: '1M context window', contextWindow: 1_048_576 },
    { id: 'claude-opus-4-8', label: 'claude-opus-4-8', description: 'Most capable for ambitious work', contextWindow: 200_000 },
    { id: 'claude-opus-4-8[1m]', label: 'claude-opus-4-8[1m]', description: '1M context window', contextWindow: 1_048_576 },
    { id: 'claude-sonnet-5', label: 'claude-sonnet-5', description: 'Most efficient for everyday tasks', contextWindow: 200_000 },
    { id: 'claude-sonnet-5[1m]', label: 'claude-sonnet-5[1m]', description: '1M context window', contextWindow: 1_048_576 },
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

// ── claude 扫描别名规范化（客户端公开 id 对齐）──────────────────────────
// CLI `/model` 披露的是别名（sonnet/opus[1m]/default/best/opusplan…），
// 而 Claude Code 客户端按公开模型 id 展示。用户要求 CogSeed 的模型映射
// 与外接智能体（客户端）实际看到的完全一致——扫描结果在 IPC 组装处经
// 本表规范化后再进合并清单。

const CLAUDE_ALIAS_TO_MODEL: Record<string, string> = {
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5-20251001',
  fable: 'claude-fable-5',
  'sonnet[1m]': 'claude-sonnet-5[1m]',
  'opus[1m]': 'claude-opus-4-8[1m]',
  'fable[1m]': 'claude-fable-5[1m]',
};

/** CLI 别名 → 客户端公开 id。已是公开 id 的原样通过；客户端目录没有的
 *  CLI 路由别名（default/best/opusplan）返回 null = 从合并清单剔除
 *  （跟随默认由「跟随 CLI」行承担，其余手输仍可用）——不猜映射。 */
export function canonicalClaudeModelId(id: string): string | null {
  const key = String(id || '').trim();
  if (!key) return null;
  const mapped = CLAUDE_ALIAS_TO_MODEL[key] ?? CLAUDE_ALIAS_TO_MODEL[key.toLowerCase()];
  if (mapped) return mapped;
  return CATALOG.claude.some((m) => m.id === key) ? key : null;
}

/** CLI 自报当前模型（/model 输出的显示名，如 "Sonnet 5"）→ 公开 id。
 *  无法唯一映射（路由别名/未来新模型）返回 null = 保持 CLI 自报原值展示。 */
export function canonicalClaudeCurrentModel(display: string): string | null {
  const raw = String(display || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const exact = CATALOG.claude.find((m) => m.id.toLowerCase() === lower);
  if (exact) return exact.id;
  if (/opusplan/i.test(raw)) return null;
  const suffix = /\[1m\]/i.test(raw) ? '[1m]' : '';
  if (/fable/i.test(raw)) return 'claude-fable-5' + suffix;
  if (/haiku/i.test(raw)) return 'claude-haiku-4-5-20251001' + suffix;
  if (/opus/i.test(raw)) return 'claude-opus-4-8' + suffix;
  if (/sonnet/i.test(raw)) return 'claude-sonnet-5' + suffix;
  return null;
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
  /** 「关闭」档可表达（hermes --reasoning none / openclaw --thinking off）。
   *  claude/codex 无禁用入口，UI 置灰防语义欺骗。 */
  effortOff: boolean;
}
const CLI_EXEC_CONTROL: Record<string, CliExecControl> = {
  claude: { model: true, effort: true, effortOff: false },
  codex: { model: true, effort: true, effortOff: false },
  hermes: { model: true, effort: true, effortOff: true },
  openclaw: { model: true, effort: true, effortOff: true },
  // opencode --variant / workbuddy --effort（均 --help 实测）：low/high 恒等、
  // off 映射 minimal（最低档，非真关闭）→ effortOff=false 置灰 off。
  opencode: { model: true, effort: true, effortOff: false },
  gemini: { model: true, effort: false, effortOff: false },
  aider: { model: true, effort: false, effortOff: false },
  workbuddy: { model: true, effort: true, effortOff: false },
};
export function execControlFor(cli: string): CliExecControl {
  // 未知 CLI 的 model/effort 兜底全开（与渲染层同源）：自定义智能体可用
  // P3394_AGENT_MODEL_ARGS / P3394_AGENT_EFFORT_ARGS 声明通道，网关无模板
  // 时信封字段安全忽略——「声明即生效」。已知无通道的（gemini/aider）
  // 表内显式 false；运行时协商（effort_controllable）是 UI 显隐权威。
  const type = String(cli || '').trim();
  const known = CLI_EXEC_CONTROL[type];
  return known ?? { model: true, effort: true, effortOff: false };
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
