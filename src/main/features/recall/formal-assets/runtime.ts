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

/** 准入模式。比布尔值多一档，因为 PRD 3.6 区分「只能主动选」和「可默认注入」。 */
export type AssetRuntimeMode =
  /** 不得进入本次运行。 */
  | 'blocked'
  /** 只有用户主动挑选才能用，不得静默默认注入。 */
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
  | 'sensitivity_above_destination'
  | 'sensitivity_unclassified'
  | 'source_unavailable';

export interface AssetRuntimeCandidate extends AssetPolicyInput {
  scope: string;
  applicableWhen?: readonly string[];
  forbiddenWhen?: readonly string[];
  targetAgents?: readonly string[];
  sensitivity?: string;
}

export interface AssetRuntimeContext {
  /** 目的地作用域。undefined = 不限定，视为同作用域。 */
  scope?: string;
  /** 本次运行的 Agent 标识。资产声明了 targetAgents 时用它比对。 */
  agentId?: string;
  /** 目的地能接受的最高敏感级。声明了就必须比对。 */
  maxSensitivity?: string;
  sensitivityRank?: Readonly<Record<string, number>>;
  /** 来源是否仍然可读。false = 授权已撤回或来源失效。 */
  sourceAvailable?: boolean;
  /** 当前任务的自由文本，用于比对 applicable/forbidden 条件。 */
  taskText?: string;
  /** true = 这是"用户没有主动挑选"的自动注入路径。 */
  silentDefaultInjection?: boolean;
}

export interface AssetRuntimeEligibility {
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
  const sameScope = context.scope === undefined || context.scope === asset.scope;
  const usePolicy = resolveAssetUsePolicy(asset, sameScope);

  if (asset.status !== 'active') reasons.push('status_not_active');

  // 来源撤权后停止新的读取与默认注入（PRD 3.4）。
  if (context.sourceAvailable === false) reasons.push('source_unavailable');

  // 禁止范围命中即出局，优先于适用范围——"哪里不能用"比"哪里能用"更强。
  if (matchesAnyCondition(asset.forbiddenWhen, context.taskText)) reasons.push('forbidden_context');

  // 声明了适用范围却对不上当前任务：不阻断人工选择，但不能自动带入。
  const declaredApplicable = (asset.applicableWhen?.length || 0) > 0;
  const applicableMatched = matchesAnyCondition(asset.applicableWhen, context.taskText);

  // 注入白名单（PRD 3.5 target_agents）。缺失 = 没限制过，不拦；
  // 一旦声明，未列出的 Agent 就不得注入。
  if ((asset.targetAgents?.length || 0) > 0 && context.agentId
    && !asset.targetAgents!.includes(context.agentId)) {
    reasons.push('target_agent_not_allowed');
  }

  // 敏感级。缺失不等于 L0：目的地声明了上限就必须先分级。
  if (context.maxSensitivity !== undefined) {
    const rank = context.sensitivityRank;
    if (asset.sensitivity === undefined) reasons.push('sensitivity_unclassified');
    else if (rank && (rank[asset.sensitivity] ?? 0) > (rank[context.maxSensitivity] ?? 0)) {
      reasons.push('sensitivity_above_destination');
    }
  }

  if (usePolicy === 'never' && asset.status === 'active') {
    // status 已经解释过的不重复记——never 在这里专指"成熟度还不够"。
    reasons.push('maturity_below_default_use');
  }

  // 静默默认注入这条路，PRD 3.6 只放行 Transfer Verified 及以上。
  const silentBlocked = context.silentDefaultInjection === true && usePolicy !== 'auto';
  if (silentBlocked && !reasons.includes('maturity_below_default_use')) {
    reasons.push('maturity_below_default_use');
  }
  if (context.silentDefaultInjection === true && declaredApplicable && !applicableMatched) {
    reasons.push('not_applicable_context');
  }

  if (reasons.length) return { eligible: false, mode: 'blocked', reasons, usePolicy };

  const mode: AssetRuntimeMode = usePolicy === 'auto'
    ? (asset.maturity === 'effectiveness_validated' ? 'preferred' : 'default_allowed')
    : 'manual_only';
  return { eligible: true, mode, reasons: [], usePolicy };
}
