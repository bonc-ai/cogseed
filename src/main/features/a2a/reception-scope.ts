/**
 * A2A reception scope — what the receiving assistant may do while answering a
 * contact (D-18/R-12).
 *
 * The hard boundary is the runtime tool policy, not a prompt instruction: a scope
 * the model was merely told about is a suggestion. This module takes the policy
 * derived from the receiving conversation (permission mode + workspace) and
 * narrows it for an A2A run.
 *
 * 口径（设计 §5 L2 + §3.6 L3）：
 * - 读：只在授权工作区内（`explicit_roots`）；
 * - 写 / 执行：**可以发生，但每一次都由宿主弹审批并路由给接收方本人**。这里给的是
 *   `explicit_writable_roots` / `allow_with_confirmation`——即"能问人，不能自己做主"；
 *   Runtime 由 `runtime-tool-policy.ts::shouldAutoApproveRuntimeAction` 禁止自动批准；
 *   SDK 接访回合由 `reception-approval.ts` 的逐次写入与 shell 回调审批。把能力改成 none 会让验收点
 *   AC-07（要求执行命令 → 弹审批）永远没有触发条件；
 * - 网络 / 连接器 / 技能脚本仍然关闭：连接器与网络在设计里就是 none；技能脚本没有
 *   逐次审批闸门，接待里放开等于绕开 L3，等有闸门再开。
 */

import type { RuntimeToolPolicy } from '../cogseed_runtime/kernel/types';
import { isInboundMarker, type A2AConversationMarker } from './conversation-marker';

/**
 * Immutable per-turn execution ceiling for a trusted inbound A2A reception turn.
 *
 * Established once from host-persisted state (conversation marker + validated
 * workspace grant) when the turn is admitted, then threaded unchanged through
 * model options, the runner and the tool layer. It is never derived from model
 * output, from a CID alone, or from `@name` text in prose.
 *
 * `root` is the single authorized workspace. Downstream consumers may narrow it
 * or refuse the turn; none may widen, replace or clear it.
 */
export interface TrustedReceptionScope {
  /** Host-attributed inbound source actor (`a2a_<peer>`), propagated to descendants. */
  readonly sourceActorId: string;
  readonly conversationId: string;
  /** Canonical, existing, already-confirmed workspace grant. */
  readonly root: string;
}

/**
 * The ceiling for a reception run: read inside the granted roots, write/execute only
 * through the receiver's per-action approval, no network, no connectors, no skills.
 */
export const A2A_RECEPTION_TOOL_POLICY: RuntimeToolPolicy = {
  fileRead: 'explicit_roots',
  // 写只在授权工作区内，且逐次审批（L3 路由给接收方本人）。
  fileWrite: 'explicit_writable_roots',
  // 每次执行都需接收方批准，包括低风险命令；不能复用整轮风险类别授权。
  shell: 'allow_with_confirmation',
  skillRun: 'none',
  network: 'none',
  connectors: 'none',
};

/** shell 的严格程度：用来判断基策略是否比接待上限更严（更严就保持不变）。 */
const SHELL_STRICTNESS: Record<RuntimeToolPolicy['shell'], number> = {
  none: 0,
  low_risk_only: 1,
  allow_with_confirmation: 2,
};

function isPolicy(value: unknown): value is RuntimeToolPolicy {
  return !!value && typeof value === 'object';
}

/**
 * Narrow a base policy to the reception ceiling.
 *
 * The result never widens anything: each dimension keeps whichever is stricter of
 * the base value and the ceiling. A conversation whose own policy is already
 * deny-all stays deny-all.
 */
export function applyA2AReceptionScope(base: RuntimeToolPolicy | null | undefined): RuntimeToolPolicy {
  const source = isPolicy(base) ? base : A2A_RECEPTION_TOOL_POLICY;
  // 只在基策略允许时才保留读写/执行；更严的基策略不被放宽。
  const shell = (SHELL_STRICTNESS[source.shell] ?? 0) <= SHELL_STRICTNESS[A2A_RECEPTION_TOOL_POLICY.shell]
    ? source.shell
    : A2A_RECEPTION_TOOL_POLICY.shell;
  return {
    // Reads stay enabled only if the base allowed them at all; the roots themselves
    // are enforced by the path sandbox, which the run already carries.
    fileRead: source.fileRead === 'explicit_roots' ? 'explicit_roots' : 'none',
    fileWrite: source.fileWrite === 'explicit_writable_roots' ? 'explicit_writable_roots' : 'none',
    shell,
    skillRun: 'none',
    network: 'none',
    connectors: 'none',
  };
}

/** Whether this conversation is a reception run at all. */
export function isReceptionRun(marker: A2AConversationMarker | null | undefined): boolean {
  return !!marker && isInboundMarker(marker) && marker.state === 'active';
}

/**
 * The policy a run in this conversation must use: reception ceiling for an active
 * receiving conversation, the base policy everywhere else.
 */
export function toolPolicyForConversation(
  base: RuntimeToolPolicy | null | undefined,
  marker: A2AConversationMarker | null | undefined,
): RuntimeToolPolicy | null | undefined {
  return isReceptionRun(marker) ? applyA2AReceptionScope(base) : base;
}

/** Read roots for a reception run: the granted workspace only (R-12). */
export function receptionReadRoots(marker: A2AConversationMarker | null | undefined, fallback?: string | null): string[] {
  if (!marker) return fallback ? [fallback] : [];
  const workspace = typeof marker.workspace === 'string' ? marker.workspace.trim() : '';
  if (workspace) return [workspace];
  return fallback ? [fallback] : [];
}
