/** 选择层：面对这一次任务，从「这个 Agent 出生时被允许带走的」里算出「这次真该用的」。
 *
 *  这是四层里的第三层，四层不得互相吞：
 *
 *    Asset               长期事实——资产本体，这里只读不写
 *    InheritanceSnapshot 出生时事实——不可变，这里只读不写
 *    Selection           本次运行的决策——就是本模块的产出，用完即弃
 *    Receipt             运行后的事实——由注入侧写，本模块不碰
 *
 *  **产出是决策结果，不是新的资产类型。** `SelectedCognition` 里的 content 是
 *  一份只读快照，不回写、不加字段、不做二次加工。真正的资产还是原资产。
 *
 *  两个消费方共用这一层，各自渲染：
 *    - 本地 Agent 运行时 → 渲染成正文块进 system prompt
 *    - 跨 Agent 交付     → 渲染成引用清单进 capability pack
 *
 *  **适用/禁用条件是携带，不是判定。** `applicableWhen` / `forbiddenWhen` 是
 *  自然语言短句（见 asset-semantics 的约束），这里刻意不去匹配它们——能做的
 *  只有关键词匹配，而那会以看不见的方式漏掉该带的认知，或带上该拦的。条件
 *  原样交给模型自限，并展示给用户看。机械过滤只做能确定的那几项。
 */

import type { CapabilityPackAssetRef } from '../p3394/capability-pack';
import type { AgentGlossaryEntry } from '../agent_inheritance';
import type { RecallAbilityAssetRecord } from './candidate-service';
import type { RecallAbilityAssetScopePolicy } from './scope-policy';
import {
  type AbilityAssetSensitivity,
  type AbilityAssetUsePolicy,
} from './asset-semantics';
import { resolveAssetUsePolicy } from './formal-assets/policy';
import { evaluateAssetRuntimeEligibility } from './formal-assets/runtime';
import { inheritedAssetContentHash } from '../agent_inheritance';

/** 一条资产没被带入的原因。**可能同时成立多条**——一条资产完全可以既被暂停、
 *  又不在作用域白名单里。只记第一条会让用户看到的解释取决于代码判断顺序。 */
export type WithheldReason =
  // —— 权限/安全类 ——
  | 'scope_agent_not_allowed'
  | 'scope_role_not_allowed'
  | 'scope_project_not_allowed'
  | 'scope_workspace_not_allowed'
  | 'sensitivity_above_destination'
  | 'sensitivity_unclassified'
  // —— 状态类 ——
  | 'asset_paused'
  | 'asset_archived'
  | 'asset_revoked'
  | 'asset_deleted'
  | 'asset_purged'
  | 'use_policy_never'
  // —— 内容完整性 ——
  | 'asset_missing'
  | 'content_changed'
  | 'version_changed';

/** 主原因的优先级——**领域规则，不是判断顺序**。
 *
 *  回执的 omittedRefs 尾段只容得下一个原因（格式 `asset:<id>@v<n>:<reason>`），
 *  必须由固定规则挑，否则 reasons[] 留全了、回执里那一个仍然会随实现顺序漂，
 *  而回执是给日后追溯看的，漂了就再也对不上。
 *
 *  分档理由：先说最硬的边界。「不该给你」比「暂时停用」重，「暂时停用」比
 *  「内容对不上」重，因为前者是决定、后者是状况。 */
const WITHHELD_REASON_TIER: Record<WithheldReason, number> = {
  // 1 权限/安全：用户或策略明确不允许
  scope_agent_not_allowed: 1,
  scope_role_not_allowed: 1,
  scope_project_not_allowed: 1,
  scope_workspace_not_allowed: 1,
  sensitivity_above_destination: 1,
  sensitivity_unclassified: 1,
  // 2 状态：资产当下不可用
  asset_revoked: 2,
  asset_purged: 2,
  asset_deleted: 2,
  asset_archived: 2,
  asset_paused: 2,
  use_policy_never: 2,
  // 3 内容完整性：拿到的不是当初继承的那份
  asset_missing: 3,
  content_changed: 3,
  version_changed: 3,
};

/** 同档内的次序：数组里靠前的先出。只在同档时用得上，跨档一律看档位。 */
const WITHHELD_REASON_ORDER: WithheldReason[] = [
  'scope_agent_not_allowed',
  'scope_role_not_allowed',
  'scope_project_not_allowed',
  'scope_workspace_not_allowed',
  'sensitivity_above_destination',
  'sensitivity_unclassified',
  'asset_revoked',
  'asset_purged',
  'asset_deleted',
  'asset_archived',
  'asset_paused',
  'use_policy_never',
  'asset_missing',
  'content_changed',
  'version_changed',
];

/** 按固定领域规则从多条原因里挑出写进回执的那一条。 */
export function primaryWithheldReason(reasons: WithheldReason[]): WithheldReason {
  if (!reasons.length) throw new Error('withheld cognition requires at least one reason');
  return [...reasons].sort((a, b) => (
    WITHHELD_REASON_TIER[a] - WITHHELD_REASON_TIER[b]
    || WITHHELD_REASON_ORDER.indexOf(a) - WITHHELD_REASON_ORDER.indexOf(b)
  ))[0];
}

/** 本次运行的处境。缺省字段一律表示「这一维不设限」，不表示「限定为空」。 */
export interface CognitionSelectionContext {
  /** 目标 Agent。用来比对 scopePolicy.agentIds。 */
  agentId?: string;
  /** 本次任务的作用域。与资产 scope 相同即同域（规范 10.2 矩阵按同域/跨域分档）。 */
  scope?: string;
  roleId?: string;
  projectId?: string;
  workspaceId?: string;
  /** 目的地允许的最高敏感级。缺省 = 不额外设限。 */
  maxSensitivity?: AbilityAssetSensitivity;
}

/** 一条被选中的认知。content 是只读快照，不是资产本体。 */
export interface SelectedCognition {
  /** 出生时冻结的引用。 */
  assetRef: CapabilityPackAssetRef;
  /** 现在实际读到的版本。与 assetRef.version 不同就是漂了——那种情况不会走到这里。 */
  resolvedVersion: string;
  content: {
    type: RecallAbilityAssetRecord['type'];
    title: string;
    statement: string;
    scope: string;
  };
  /** 原样携带，交给模型自限并展示给用户。**本模块不判定它们。** */
  applicableWhen?: string[];
  forbiddenWhen?: string[];
  sensitivity?: AbilityAssetSensitivity;
  /** 规范 10.2 算出来的默认使用档，渲染侧据此决定是直接带入还是需要确认。
   *  已确认跨作用域的资产在这里已经从 confirm 抬到 prompt。 */
  usePolicy: Exclude<AbilityAssetUsePolicy, 'never'>;
  /** 是否与资产同作用域。跨域一律比同域更严，渲染侧要能说明白。 */
  sameScope: boolean;
  /** 这次之所以能跨作用域带入，是因为用户确认过。渲染侧要能说清来由。 */
  crossScopeConfirmed?: boolean;
}

export interface WithheldCognition {
  assetRef: CapabilityPackAssetRef;
  /** 全部成立的原因，供「使用与证明」页展示。 */
  reasons: WithheldReason[];
  /** 按固定领域规则挑出的那一条，写进回执 omittedRefs。 */
  primaryReason: WithheldReason;
}

export interface CognitionSelectionResult {
  selected: SelectedCognition[];
  withheld: WithheldCognition[];
  /**
   * 出生时冻结的术语表（N-3）。
   *
   * 它此前采集了却没有任何路径把它送进提示词——`collectAgentBirthContext`
   * 落盘、`inherited-cognition-prompt` 只渲染资产，于是「出生就该知道 KSTAR
   * 在这里指什么」实际没发生。这里把它从快照透传出去。
   *
   * **只透传 glossary，不透传 `memoryRefs`**：后者是裸 id，模型拿到解析不了，
   * 塞进提示词只是噪音。要让记忆参与，得走 recall 投影那条有内容的路径。
   */
  glossary: AgentGlossaryEntry[];
}

const SENSITIVITY_RANK: Record<AbilityAssetSensitivity, number> = { L0: 0, L1: 1, L2: 2 };

const STATUS_REASON: Record<Exclude<RecallAbilityAssetRecord['status'], 'active'>, WithheldReason> = {
  paused: 'asset_paused',
  archived: 'asset_archived',
  revoked: 'asset_revoked',
  deleted: 'asset_deleted',
  purged: 'asset_purged',
};

/** 一维作用域白名单的三态判断（见 scope-policy）：
 *  缺失=不设限放行；空数组=谁都不给；非空=只放行列出的。 */
function scopeDenies(allowed: string[] | undefined, actual: string | undefined): boolean {
  if (allowed === undefined) return false;
  if (allowed.length === 0) return true;
  if (actual === undefined) return true;
  return !allowed.includes(actual);
}

function scopePolicyReasons(
  policy: RecallAbilityAssetScopePolicy | undefined,
  context: CognitionSelectionContext,
): WithheldReason[] {
  if (!policy) return [];
  const reasons: WithheldReason[] = [];
  if (scopeDenies(policy.agentIds, context.agentId)) reasons.push('scope_agent_not_allowed');
  if (scopeDenies(policy.roleIds, context.roleId)) reasons.push('scope_role_not_allowed');
  if (scopeDenies(policy.projectIds, context.projectId)) reasons.push('scope_project_not_allowed');
  if (scopeDenies(policy.workspaceIds, context.workspaceId)) reasons.push('scope_workspace_not_allowed');
  return reasons;
}

/** 纯函数：这条资产这次要不要带，不带的话全部原因是什么。
 *
 *  `asset` 为 null 表示资产已经读不到了（被彻底清除或记录损坏）。 */
export function classifyInheritedAsset(
  ref: CapabilityPackAssetRef,
  asset: RecallAbilityAssetRecord | null,
  context: CognitionSelectionContext,
): WithheldReason[] {
  if (!asset) return ['asset_missing'];

  const reasons: WithheldReason[] = [];

  // 权限/安全。scopePolicy 是能力包继承独有的合同检查，留在这里；
  // 敏感级、状态、成熟度三项走统一 runtime 闸门，不再本地重写一遍规则。
  reasons.push(...scopePolicyReasons(asset.scopePolicy, context));

  const sameScope = context.scope === undefined || context.scope === asset.scope;
  const runtime = evaluateAssetRuntimeEligibility({
    status: asset.status,
    maturity: asset.maturity,
    scope: asset.scope,
    ...(asset.crossScopeConfirmedAt ? { crossScopeConfirmedAt: asset.crossScopeConfirmedAt } : {}),
    ...(asset.sensitivity ? { sensitivity: asset.sensitivity } : {}),
  }, {
    ...(context.scope !== undefined ? { scope: context.scope } : {}),
    ...(context.maxSensitivity !== undefined
      ? { maxSensitivity: context.maxSensitivity, sensitivityRank: SENSITIVITY_RANK }
      : {}),
  });
  for (const reason of runtime.reasons) {
    if (reason === 'status_not_active') reasons.push(STATUS_REASON[asset.status]);
    else if (reason === 'maturity_below_default_use') reasons.push('use_policy_never');
    else if (reason === 'sensitivity_unclassified') reasons.push('sensitivity_unclassified');
    else if (reason === 'sensitivity_above_destination') reasons.push('sensitivity_above_destination');
  }

  // 内容完整性：出生时冻结的是哪一版、哪一份内容，现在还对不对得上。
  if (ref.version !== asset.version) reasons.push('version_changed');
  if (ref.content_hash !== undefined && ref.content_hash !== inheritedAssetContentHash(asset)) {
    reasons.push('content_changed');
  }

  return reasons;
}

function toSelected(
  ref: CapabilityPackAssetRef,
  asset: RecallAbilityAssetRecord,
  context: CognitionSelectionContext,
): SelectedCognition {
  const sameScope = context.scope === undefined || context.scope === asset.scope;
  const crossScopeConfirmed = !sameScope && Boolean(asset.crossScopeConfirmedAt);
  // 策略只有一处解释：formal-assets/policy。这里不再自己拼
  // resolveDefaultUsePolicy + applyCrossScopeConfirmation。
  const usePolicy = resolveAssetUsePolicy(asset, sameScope);
  if (usePolicy === 'never') throw new Error('cannot select a cognition whose use policy is never');
  return {
    ...(crossScopeConfirmed ? { crossScopeConfirmed: true } : {}),
    assetRef: ref,
    resolvedVersion: asset.version,
    content: {
      type: asset.type,
      title: asset.title,
      statement: asset.statement,
      scope: asset.scope,
    },
    ...(asset.applicableWhen ? { applicableWhen: asset.applicableWhen } : {}),
    ...(asset.forbiddenWhen ? { forbiddenWhen: asset.forbiddenWhen } : {}),
    ...(asset.sensitivity ? { sensitivity: asset.sensitivity } : {}),
    usePolicy,
    sameScope,
  };
}

/**
 * 把一份出生快照解析并过滤成本次运行的选择结果。
 *
 * 读不到快照返回 null——「这个 Agent 生成时还没有继承机制」和「它继承了空」
 * 是两件事，调用方必须分开处理，本层不替它抹平。
 *
 * 单条资产读失败不让整体失败：记成 asset_missing 继续。一条资产漂了就让
 * 整个 Agent 起不来太重，但漂了还静默注入新正文，等于伪造「它一直继承的是
 * 这份内容」——所以是降级为不带入并说明原因。
 */
export async function selectInheritedCognition(
  userId: string,
  agentId: string,
  context: CognitionSelectionContext = {},
): Promise<CognitionSelectionResult | null> {
  const [{ readAgentInheritance }, assetService] = await Promise.all([
    import('../agent_inheritance'),
    import('./asset-service'),
  ]);

  const snapshot = await readAgentInheritance(userId, agentId);
  if (!snapshot) return null;

  const resolved: CognitionSelectionContext = { agentId, ...context };
  const selected: SelectedCognition[] = [];
  const withheld: WithheldCognition[] = [];

  for (const ref of snapshot.inheritedAssets) {
    let asset: RecallAbilityAssetRecord | null = null;
    try {
      asset = await assetService.readAbilityAsset(userId, ref.asset_id);
    } catch {
      asset = null;
    }

    const reasons = classifyInheritedAsset(ref, asset, resolved);
    if (reasons.length) {
      withheld.push({ assetRef: ref, reasons, primaryReason: primaryWithheldReason(reasons) });
      continue;
    }
    selected.push(toSelected(ref, asset!, resolved));
  }

  return { selected, withheld, glossary: snapshot.glossary || [] };
}
