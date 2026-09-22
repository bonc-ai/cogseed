/**
 * 协作范围注入（PRD FR-017 / 设计 §4.2）。
 *
 * 把「这次提交的成员范围 + 本条点名」送进该看到它的 actor 的 LLM 输入：
 *   - commander：完整块（成员=可协作范围、点名=必须执行者、顺序要求、交付要求）
 *   - 内进程被点名成员：一行「本条点名对象是你」
 *   - 外接实例（cli / p3394-gateway）：什么都不注入（FR-021：不扩大成员可见范围）
 *
 * 纯函数 + 传入模板文本：既能在单测里直接校验，也避免在同步的 payload 组装里做 IO。
 * 追加位置在 payload 末尾（易变内容放最后，保持缓存前缀稳定）。
 */

import type { GroupMessage } from './visibility';
import { COMMANDER_ID } from './state';

/**
 * 顺序意图的确定性检测（设计 §4.4）：保守命中——宁可漏判也不误判，因为误判会把
 * 合法的并行任务判成"必须串行"。命中即写入 run 快照，供主机侧校验与范围块使用。
 */
const SEQUENTIAL_INTENT_RE = /先[^。；\n]{0,40}(再|然后|之后|而后)|(然后|之后|随后)[^。；\n]{0,40}(再|最后)|第一步|第二步|第三步|依次|逐个|按顺序|前一步|上一步|先[^。；\n]{0,30}后[^。；\n]{0,20}(再|验证|汇总|执行|处理)/;
const SEQUENTIAL_NEGATION_RE = /先(不|别|无需|不用)/;

export function detectSequentialIntent(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  if (SEQUENTIAL_NEGATION_RE.test(t)) return false;
  return SEQUENTIAL_INTENT_RE.test(t);
}

/** 模板里的运行期占位符（与 member_scope.md 的 Runtime injection 段一致）。 */
export const MEMBER_SCOPE_TEMPLATE = 'member_scope';
export const MEMBER_SCOPE_PLACEHOLDER = '{{scope_lines}}';

export interface MemberScopeInput {
  /** `src/main/prompts/member_scope.md` 的静态正文（含占位符）。 */
  template: string;
  msg: Pick<GroupMessage, 'member_snapshot' | 'mentions'>;
  recipientId: string;
  /** 该收件人是否为外接实例（facade 在提交时分类）。 */
  isExternal: boolean;
  /** agent_id → 显示名；缺失时回落 id。 */
  nameOf?: (agentId: string) => string;
}

function label(nameOf: MemberScopeInput['nameOf'], id: string): string {
  const name = nameOf ? nameOf(id) : '';
  return name || id;
}

/** 该收件人是否属于外接实例：快照里的 external_agent_ids 是唯一依据。 */
export function isExternalRecipient(msg: MemberScopeInput['msg'], recipientId: string): boolean {
  const external = msg?.member_snapshot?.external_agent_ids;
  return Array.isArray(external) && external.includes(recipientId);
}

/**
 * 生成注入块。返回空串表示本收件人不应收到任何范围信息（外接 / 无快照 / 未参与）。
 */
export function buildMemberScopeBlock(input: MemberScopeInput): string {
  const snapshot = input.msg?.member_snapshot;
  if (!snapshot) return '';
  const recipientId = String(input.recipientId || '');
  if (!recipientId) return '';
  // 外接实例不可见其他成员（设计 §4.2 D2）。
  if (input.isExternal || isExternalRecipient(input.msg, recipientId)) return '';
  const members = Array.isArray(snapshot.member_agent_ids) ? snapshot.member_agent_ids : [];
  if (!members.length) return '';
  const mentions = Array.isArray(snapshot.mention_agent_ids) ? snapshot.mention_agent_ids : [];
  const template = String(input.template || '');
  if (!template) return '';

  const memberList = members.map((id) => label(input.nameOf, id)).join('、');
  const isCommander = recipientId === COMMANDER_ID;
  const mentioned = mentions.includes(recipientId);

  // 非 commander 的内进程成员：只给「本条是否点名了你」，不泄露完整名单以外的信息。
  if (!isCommander) {
    if (!mentioned) return '';
    return `本条点名对象是你：请独立完成本条交给你的工作；无法完成时必须说明阻塞原因。`;
  }

  const lines: string[] = [];
  lines.push(`- Available collaborators: ${memberList}`);
  lines.push(mentions.length
    ? `- Required executors: ${mentions.map((id) => label(input.nameOf, id)).join('、')}`
    : '- Required executors: none named — continue from the task context and the current division of work.');
  if (snapshot.requires_sequential) {
    lines.push(`- Sequential requirement: the task states an order. Declare dependent steps in this order: ${
      (snapshot.mention_order && snapshot.mention_order.length ? snapshot.mention_order : mentions)
        .map((id) => label(input.nameOf, id)).join(' → ')}. Parallel dispatch violates the requirement.`);
  }
  const block = template.split(MEMBER_SCOPE_PLACEHOLDER).join(lines.join('\n'));
  return block.trim();
}

// ─── 顺序强约束校验（设计 §4.4） ────────────────────────────────────────────
// 纯函数：给定依赖图与点名顺序，判断"必须先方案、后验证"这类要求是否被满足。
// 主机侧在校验不过时不启动后续步骤，并把原因交回协调者（纠正上限 1 轮）。

export interface SequentialPlanStep {
  step_id: string;
  agent_id: string;
  depends_on: string[];
}

export type SequentialVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing_member' | 'missing_dependency' | 'wrong_order' | 'cycle'; detail: string };

export function verifySequentialPlan(input: {
  requiresSequential: boolean;
  mentionOrder: string[];
  steps: SequentialPlanStep[];
}): SequentialVerdict {
  const order = (input.mentionOrder || []).filter((id) => !!id);
  if (!input.requiresSequential || order.length < 2) return { ok: true };
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const byStep = new Map(steps.map((step) => [step.step_id, step]));
  const stepOfAgent = new Map<string, SequentialPlanStep>();
  for (const step of steps) {
    if (!step.agent_id) continue;
    if (!stepOfAgent.has(step.agent_id)) stepOfAgent.set(step.agent_id, step);
  }
  for (const agentId of order) {
    if (!stepOfAgent.has(agentId)) {
      return { ok: false, reason: 'missing_member', detail: agentId };
    }
  }
  /** 该步骤是否（直接或间接）依赖某个 agent 的步骤。 */
  const dependsOnAgent = (step: SequentialPlanStep, agentId: string, seen = new Set<string>()): boolean => {
    for (const depId of step.depends_on || []) {
      if (seen.has(depId)) continue;
      seen.add(depId);
      const dep = byStep.get(depId);
      if (!dep) continue;
      if (dep.agent_id === agentId) return true;
      if (dependsOnAgent(dep, agentId, seen)) return true;
    }
    return false;
  };
  // 顺序被调换（前一步依赖了后一步）比"缺依赖"更具体，先判它，给出准确原因。
  for (let i = 1; i < order.length; i += 1) {
    const earlier = stepOfAgent.get(order[i - 1])!;
    if (dependsOnAgent(earlier, order[i])) {
      return { ok: false, reason: 'wrong_order', detail: `${order[i - 1]}<-${order[i]}` };
    }
  }
  for (let i = 1; i < order.length; i += 1) {
    const step = stepOfAgent.get(order[i])!;
    if (!dependsOnAgent(step, order[i - 1])) {
      return { ok: false, reason: 'missing_dependency', detail: `${order[i]}<-${order[i - 1]}` };
    }
  }
  // 环检测：依赖图必须无环。
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (step: SequentialPlanStep): boolean => {
    if (visited.has(step.step_id)) return false;
    if (visiting.has(step.step_id)) return true;
    visiting.add(step.step_id);
    for (const depId of step.depends_on || []) {
      const dep = byStep.get(depId);
      if (dep && hasCycle(dep)) return true;
    }
    visiting.delete(step.step_id);
    visited.add(step.step_id);
    return false;
  };
  for (const step of steps) {
    if (hasCycle(step)) return { ok: false, reason: 'cycle', detail: step.step_id };
  }
  return { ok: true };
}

/** 校验失败时交回协调者的纠正说明（不静默降级为并行）。 */
export function sequentialViolationMessage(verdict: SequentialVerdict, mentionOrder: string[]): string {
  if (verdict.ok) return '';
  const { reason, detail } = verdict as { reason: string; detail: string };
  const order = (mentionOrder || []).join(' → ');
  const why = reason === 'missing_member' ? `${detail} 没有被派发`
    : reason === 'missing_dependency' ? `${detail} 之间缺少依赖`
      : reason === 'wrong_order' ? `${detail} 的依赖方向与点名顺序相反`
        : `依赖图存在环（${detail}）`;
  return `本条要求按顺序协作（${order}），但当前派发不满足：${why}。请为被点名成员建立依赖步骤后重试；不要并行派发。`;
}

/**
 * 是否把本条交给协调者编排（设计 §4.4 决策 D1 + 2026-09-20 决策 A）。
 *
 * 命中顺序意图且点名 ≥2 时，**不能**直接并行派发给这些成员：那样谁也建不了依赖，
 * 强约束等于没有牙齿（实测 17:48 那次就是这条路径）。改为强制路由给协调者，
 * 由它建依赖步骤，闸门再校验它的计划。
 */
export function shouldDeferToCommanderForOrder(input: {
  requiresSequential: boolean;
  mentionIds: string[];
}): boolean {
  return input.requiresSequential === true && (input.mentionIds || []).length >= 2;
}

/**
 * 步骤启动时的顺序校验（修订版，2026-09-20 复盘 21:34 误拦后）。
 *
 * 之前在"步骤启动"处拿完整计划链校验，导致 commander 派发第一位成员时
 * 因"后序成员还没计划"被误拦（missing_member）。正确语义只看**这一步**：
 *   - 非顺序运行 / 点名少于 2 / 该步骤的成员不在顺序里 → 放行；
 *   - 是顺序名单里的**首位成员** → 放行（它没有前置）；
 *   - 其它位次成员：前一位成员的步骤必须已经存在，且本步骤（直接或间接）
 *     依赖它；否则拦下并给原因。
 */
export type StepStartVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing_dependency' | 'wrong_order'; detail: string };

export function verifySequentialStepStart(input: {
  requiresSequential: boolean;
  mentionOrder: string[];
  steps: SequentialPlanStep[];
  stepToStart: SequentialPlanStep;
}): StepStartVerdict {
  const order = (input.mentionOrder || []).filter((id) => !!id);
  const step = input.stepToStart;
  if (!input.requiresSequential || order.length < 2 || !step) return { ok: true };
  const idx = order.indexOf(step.agent_id);
  if (idx < 0) return { ok: true };   // 不在顺序名单里：放行

  const steps = input.steps || [];
  const byStep = new Map(steps.map((s) => [s.step_id, s]));
  const dependsOn = (node: SequentialPlanStep, agentId: string, seen = new Set<string>()): boolean => {
    for (const depId of node.depends_on || []) {
      if (seen.has(depId)) continue;
      seen.add(depId);
      const dep = byStep.get(depId);
      if (!dep) continue;
      if (dep.agent_id === agentId) return true;
      if (dependsOn(dep, agentId, seen)) return true;
    }
    return false;
  };

  // 打乱检查：无论位次，依赖了"更靠后且步骤已存在"的成员 = 链反了。
  for (let i = idx + 1; i < order.length; i += 1) {
    if (dependsOn(step, order[i]) && steps.some((s) => s.agent_id === order[i])) {
      return { ok: false, reason: 'wrong_order', detail: `${step.agent_id} 依赖了更靠后的 ${order[i]}（且其步骤已存在）` };
    }
  }
  if (idx === 0) return { ok: true };  // 首位成员：无前置要求

  const priorAgent = order[idx - 1];
  const priorStep = steps.find((s) => s.agent_id === priorAgent);
  if (!priorStep) {
    return { ok: false, reason: 'missing_dependency', detail: `${step.agent_id}<-${priorAgent}（前序尚未派发）` };
  }
  if (!dependsOn(step, priorAgent)) {
    return { ok: false, reason: 'missing_dependency', detail: `${step.agent_id}<-${priorAgent}（缺少依赖）` };
  }
  return { ok: true };
}
