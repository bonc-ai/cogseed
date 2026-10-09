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
    // 顺序只能来自任务描述本身：选择/点名排列不代表执行顺序（PRD FR-017，
    // 验收报告 MA-03）。这里只说明「本条有先后要求」，方向由协调者按任务文本
    // 与分工建立依赖——给出由点名顺序推导的箭头会把错误顺序强加给协调者。
    lines.push('- Sequential requirement: the task description states an order or dependencies. '
      + 'Declare each step\'s dependencies from the task text itself; the selection or mention order is NOT an execution order. '
      + 'Dispatch in parallel only for genuinely independent work.');
  }
  const block = template.split(MEMBER_SCOPE_PLACEHOLDER).join(lines.join('\n'));
  return block.trim();
}

// ─── 顺序约束校验（PRD FR-017 / 验收报告 MA-03） ───────────────────────────
// 校验只针对**与顺序来源无关**的一致性：本条点名的执行者都必须有计划步骤
// （不静默忽略本条点名），且依赖图无环。谁先谁后由任务分工决定；主机侧不再比较
// 点名/选择排列——PRD FR-017 明确「选择顺序不代表执行顺序」。

export interface SequentialPlanStep {
  step_id: string;
  agent_id: string;
  depends_on: string[];
}

export type SequentialVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing_member' | 'cycle'; detail: string };

/** 依赖图无环检测（有环时报出环上的 step）。 */
function detectDependencyCycle(steps: SequentialPlanStep[]): SequentialVerdict {
  const byStep = new Map(steps.map((step) => [step.step_id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (step: SequentialPlanStep): SequentialPlanStep | null => {
    if (visited.has(step.step_id)) return null;
    if (visiting.has(step.step_id)) return step;
    visiting.add(step.step_id);
    for (const depId of step.depends_on || []) {
      const dep = byStep.get(depId);
      if (dep) {
        const hit = visit(dep);
        if (hit) return hit;
      }
    }
    visiting.delete(step.step_id);
    visited.add(step.step_id);
    return null;
  };
  for (const step of steps) {
    const cycle = visit(step);
    if (cycle) return { ok: false, reason: 'cycle', detail: cycle.step_id };
  }
  return { ok: true };
}

/** 计划级校验：被点名的执行者都要有步骤，且依赖图无环。
 *  `requiredAgentIds` 是集合语义（本条点名对象），不是顺序。 */
export function verifySequentialPlan(input: {
  requiresSequential: boolean;
  requiredAgentIds: string[];
  steps: SequentialPlanStep[];
}): SequentialVerdict {
  if (!input.requiresSequential) return { ok: true };
  const required = (input.requiredAgentIds || []).filter((id) => !!id);
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const dispatched = new Set(steps.map((step) => step.agent_id).filter((id) => !!id));
  for (const agentId of required) {
    if (!dispatched.has(agentId)) return { ok: false, reason: 'missing_member', detail: agentId };
  }
  return detectDependencyCycle(steps);
}

export type StepStartVerdict =
  | { ok: true }
  | { ok: false; reason: 'cycle' | 'run_binding'; detail: string };

/** 步骤启动校验：只判「这一步的依赖闭包是否绕回自身」——与谁先谁后无关的真实
 *  一致性错误。点名位次不再参与判定：任务要求的先后可能与选择顺序相反
 *  （验收报告 MA-03 的隔离复现即为该场景）。 */
export function verifySequentialStepStart(input: {
  requiresSequential: boolean;
  steps: SequentialPlanStep[];
  stepToStart: SequentialPlanStep;
}): StepStartVerdict {
  if (!input.requiresSequential) return { ok: true };
  const step = input.stepToStart;
  if (!step || !step.step_id) return { ok: true };
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const byStep = new Map(steps.map((item) => [item.step_id, item]));
  const seen = new Set<string>([step.step_id]);
  const walk = (node: SequentialPlanStep): boolean => {
    for (const depId of node.depends_on || []) {
      if (depId === step.step_id) return true;
      if (seen.has(depId)) continue;
      seen.add(depId);
      const dep = byStep.get(depId);
      if (dep && walk(dep)) return true;
    }
    return false;
  };
  if (walk(step)) return { ok: false, reason: 'cycle', detail: step.step_id };
  return { ok: true };
}

/** 校验失败时交回协调者的纠正说明（不静默降级为并行）。 */
export function sequentialViolationMessage(verdict: SequentialVerdict | StepStartVerdict): string {
  if (verdict.ok) return '';
  const { reason, detail } = verdict as { reason: string; detail: string };
  const why = reason === 'missing_member'
    ? `被点名的 ${detail} 没有被派发`
    : reason === 'run_binding'
      ? `${detail} 不属于本次协作运行`
      : `依赖图存在环（${detail}）`;
  return `本条要求按任务分工协作，但当前派发不满足：${why}。请按任务描述为被点名成员建立依赖步骤后重试。`;
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
