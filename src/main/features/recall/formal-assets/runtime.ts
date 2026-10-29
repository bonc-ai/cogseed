/**
 * Runtime 准入的唯一闸门（PRD 3.6 默认使用契约 + 3.5 共通元数据）。
 *
 * 收口理由：注入侧此前各查各的。`cognition-selection` 查了成熟度、作用域、
 * 敏感级；`context-projection`（每轮对话的自动投影）只查了 status 和来源可用性，
 * **完全不看成熟度**，然后把 status 置成 confirmed 直接进提示词；
 * `prompt-injection` / `projection-card` 又各有一套判断。
 *
 * 这里回答一个问题：**这条资产在当前 context 下能不能进，以什么方式进。**
 * 调用方不再自己判断 seed 能不能用、bud 要不要提示、跨作用域怎么办。
 *
 * 与 policy 层的分工：
 *   policy.ts   资产自身的三条轴怎么读（来源 / 验证阶段 / 治理态）
 *   runtime.ts  把这三条轴 + context 的约束合起来，给一个准入结论
 */

import { resolveAssetUsePolicy, type AbilityAssetUsePolicy, type AssetPolicyInput } from './policy';
import {
  isAssetScopeAllowed,
  type AssetScopeContext,
  type RecallAbilityAssetScopePolicy,
} from '../scope-policy';

/** 准入模式。比布尔值多一档，因为 PRD 3.6 区分「只能主动选」和「可默认注入」。 */
export type AssetRuntimeMode =
  /** 不得进入本次运行。 */
  | 'blocked'
  /** 本次任务明确选用或按需查阅；不得静默默认注入。 */
  | 'manual_only'
  /** 可在同作用域权限内默认注入。 */
  | 'default_allowed'
  /** 已验证有效，同等条件下优先。 */
  | 'preferred';

export type AssetRuntimeBlockReason =
  | 'status_not_active'
  | 'maturity_below_default_use'
  | 'scope_mismatch'
  | 'forbidden_context'
  | 'not_applicable_context'
  | 'target_agent_not_allowed'
  | 'source_unavailable';

/** 稳定规则标识（2026-09-25 验收修复 US-604 AC1 / SC-004）：把资产状态与运行时
 *  阻断原因收敛成一个不随界面语言变的标识，界面据此说清"到底哪条规则拦的"。
 *  顺序即优先级：状态最具体，作用域最笼统。**只给标识——不给原因码原文、不含正文。**
 *  挂载时（explicit attach）与每轮注入（prompt injection）共用同一份映射，两处
 *  说法才不会打架。 */
export type AssetRuntimeBlockRule =
  | 'paused' | 'archived' | 'revoked' | 'deleted' | 'purged' | 'inactive'
  | 'missing' | 'source_unavailable' | 'agent' | 'scope'
  | 'maturity'
  | 'forbidden_context' | 'not_applicable_context'
  | 'version_changed' | 'versions_missing' | 'unknown';

export function assetRuntimeBlockRule(
  assetStatus: string,
  reasons: readonly AssetRuntimeBlockReason[],
): AssetRuntimeBlockRule {
  if (reasons.includes('status_not_active')) {
    return ['paused', 'archived', 'revoked', 'deleted', 'purged'].includes(assetStatus)
      ? assetStatus as AssetRuntimeBlockRule
      : 'inactive';
  }
  if (reasons.includes('source_unavailable')) return 'source_unavailable';
  if (reasons.includes('target_agent_not_allowed')) return 'agent';
  if (reasons.includes('maturity_below_default_use')) return 'maturity';
  if (reasons.includes('forbidden_context')) return 'forbidden_context';
  if (reasons.includes('not_applicable_context')) return 'not_applicable_context';
  if (reasons.includes('scope_mismatch')) return 'scope';
  return 'unknown';
}

export interface AssetRuntimeCandidate extends AssetPolicyInput {
  scope: string;
  scopePolicy?: RecallAbilityAssetScopePolicy;
  applicableWhen?: readonly string[];
  forbiddenWhen?: readonly string[];
  targetAgents?: readonly string[];
}

/** 查阅不等于选用，显式选用不等于允许后台自动带入。 */
export type AssetRuntimeOperation = 'inspect' | 'explicit_use' | 'default_injection';
export type AssetRuntimeRelevance = 'unspecified' | 'matched' | 'mismatched' | 'unknown';

export interface AssetRuntimeContext extends AssetScopeContext {
  /** 新消费者必须明确操作；旧调用以 silentDefaultInjection 映射兼容。 */
  operation?: AssetRuntimeOperation;
  /** 目的地作用域。undefined = 不限定，视为同作用域。 */
  scope?: string;
  /** 来源是否仍然可读。false = 授权已撤回或来源失效。 */
  sourceAvailable?: boolean;
  /** 当前任务的自由文本，用于比对 applicable/forbidden 条件。 */
  taskText?: string;
  /** true = 这是"用户没有主动挑选"的自动注入路径。 */
  silentDefaultInjection?: boolean;
}

export interface AssetRuntimeEligibility {
  operation: AssetRuntimeOperation;
  /** 状态、来源、权限与禁止条件的共同边界，不混入任务相关性和默认策略。 */
  accessAllowed: boolean;
  relevance: AssetRuntimeRelevance;
  /** 自动带入策略；查阅或明确选用不修改此策略。 */
  defaultUsePolicy: AbilityAssetUsePolicy;
  eligible: boolean;
  mode: AssetRuntimeMode;
  reasons: AssetRuntimeBlockReason[];
  /** 资产自身的使用契约档位，便于调用方解释结论。 */
  usePolicy: AbilityAssetUsePolicy;
}

function matchesAnyCondition(conditions: readonly string[] | undefined, taskText: string | undefined): boolean {
  if (!conditions?.length || !taskText) return false;
  const text = taskText.toLocaleLowerCase();
  return conditions.some((condition) => {
    const needle = String(condition || '').trim().toLocaleLowerCase();
    return needle.length > 0 && text.includes(needle);
  });
}

/**
 * 统一准入判定。
 *
 * 顺序上先收集所有阻断原因（不短路），这样调用方能一次看全为什么没带进去，
 * 而不是修完一条再发现还有一条——`classifyInheritedAsset` 已经证明这个形状好用。
 */
export function evaluateAssetRuntimeEligibility(
  asset: AssetRuntimeCandidate,
  context: AssetRuntimeContext = {},
): AssetRuntimeEligibility {
  const reasons: AssetRuntimeBlockReason[] = [];
  const operation = context.operation ?? (context.silentDefaultInjection === true ? 'default_injection' : 'explicit_use');
  const sameScope = context.scope === undefined || context.scope === asset.scope;
  const defaultUsePolicy = resolveAssetUsePolicy(asset, sameScope);

  if (asset.status !== 'active') reasons.push('status_not_active');
  if (context.sourceAvailable === false) reasons.push('source_unavailable');
  if (!isAssetScopeAllowed(asset.scopePolicy, context)) reasons.push('scope_mismatch');
  if (matchesAnyCondition(asset.forbiddenWhen, context.taskText)) reasons.push('forbidden_context');
  if ((asset.targetAgents?.length || 0) > 0
    && (!context.agentId || !asset.targetAgents!.includes(context.agentId))) {
    reasons.push('target_agent_not_allowed');
  }

  const declaredApplicable = (asset.applicableWhen?.length || 0) > 0;
  const relevance: AssetRuntimeRelevance = !declaredApplicable ? 'unspecified'
    : matchesAnyCondition(asset.applicableWhen, context.taskText) ? 'matched' : 'unknown';
  // These are free-text guidance conditions, not a typed operation predicate.
  // Missing the exact wording does not establish non-applicability: semantic
  // retrieval may find a paraphrase, and the answering model receives the full
  // condition/exception text for actual use and persisted-result assessment.
  // Scope, grants, explicit prohibitions and typed required operation checks
  // remain independent hard gates; unknown never means a condition was met.
  const accessAllowed = reasons.length === 0;

  if (operation === 'default_injection') {
    // 证明带入成功不等于效果成功；自动使用仍服从共同默认策略。
    // 跨场景确认只授权明确使用，不把 prompt/confirm 偷升为 auto。
    if (asset.status === 'active' && defaultUsePolicy !== 'auto') {
      if (!sameScope) reasons.push('scope_mismatch');
      else reasons.push('maturity_below_default_use');
    }
  }

  // seed 是未验证内容，不是“禁止查原文”。明确选用可带着未验证标签
  // 进入任务；所有硬边界仍成立，且不能据此将默认策略或成熟度升档。
  const usePolicy = !accessAllowed ? 'never'
    : operation !== 'default_injection' && defaultUsePolicy === 'never' ? 'prompt'
      : defaultUsePolicy;
  const uniqueReasons = [...new Set(reasons)];
  const eligible = uniqueReasons.length === 0;
  const mode: AssetRuntimeMode = !eligible ? 'blocked'
    : usePolicy === 'auto'
      ? asset.maturity === 'effectiveness_validated' ? 'preferred' : 'default_allowed'
      : 'manual_only';
  return { operation, accessAllowed, relevance, defaultUsePolicy, eligible, mode, reasons: uniqueReasons, usePolicy };
}
