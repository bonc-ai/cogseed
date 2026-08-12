/**
 * capability-load.ts — 目标端加载执行侧（FR-REU-04 / 8-12 连接 Spike 缺口）
 *
 * 能力包只有打包/存储侧（capability-pack.ts），这里是"目标 Agent 真实加载 →
 * 产出首个 Action Plan → ContextReuseReceipt"的执行侧。
 *
 * 约束（AGENTS.md）：
 * - 目标 Agent 调度只走 local_agents/runner.ts（唯一 CLI spawn 路径），
 *   内部 one-shot 用 synthetic agentId + skipDispatchCheck（同 onboarding 模式）；
 * - 零新增 spawn 路径、零新增 npm 依赖；
 * - 边界三态：real（CLI 真实执行成功）/ degraded（CLI 缺失或执行失败，不冒充）/
 *   test-double（仅测试注入）；
 * - 先事件后资产：执行事件流（lifecycle）记录先于回执完成，失败零残留。
 */
import { randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { isPathAllowed } from '../../util/path-sandbox';
import { maskId } from '../../util/log-redact';
import { readCapabilityPack, isCapabilityPackExpired, type MinimumCapabilityPack } from './capability-pack';
import { prepareReceipt, completeReceipt } from './context-reuse-receipt';
import { createLifecycleSink, type ExecutionBoundary } from '../execution-records';
import { detectOne, type LocalCliEntry, type LocalCliType } from '../local_agents/registry';
import { run, type RunCliAgentOpts, type RunCliAgentResult } from '../local_agents/runner';
import type { LocalEvent } from '../local_agents/backends/base';

const log = createLogger('p3394.capability-load');

/** ACTION_PLAN 块：`ACTION_PLAN` / `行动计划`（允许 Markdown 标题 `##`、加粗、冒号任意组合，
 *  如 `## ACTION_PLAN` / `**ACTION_PLAN:**` / `ACTION_PLAN:`）起，到下一个标题或空行或文本结束。 */
const ACTION_PLAN_BLOCK_RE = /(?:^|\n)\s*#{0,3}\s*\*{0,2}\s*(?:ACTION_PLAN|行动计划|Action Plan)\s*[\*:：]{0,3}\s*\r?\n([\s\S]*?)(?=\r?\n\s*#{1,6}\s|\r?\n\s*\r?\n|$)/;
/** 步骤行：`- ` / `* ` / `1. ` / `1) ` 开头。 */
const ACTION_STEP_RE = /^\s*(?:[-*]\s+|(?:\d+[.)]\s+))/m;
const MIN_ACTION_PLAN_STEPS = 3;
const TASK_PROMPT_MAX = 100_000;

export interface CapabilityLoadInput {
  uid: string;
  /** 能力包 id（readCapabilityPack 校验）。 */
  packId: string;
  /** 目标 Agent（synthetic id，内部 one-shot，不要求是注册 Agent）。 */
  targetAgentId: string;
  /** 目标 CLI 类型（hermes / claude / codex / opencode / openclaw）。 */
  cli: LocalCliType;
  /** 目标任务描述（目标 Agent 要干的事）。 */
  taskPrompt: string;
  /** 工作目录（必须落在 allowedRoots 内，路径沙箱）。 */
  cwd: string;
  allowedRoots: readonly string[];
  /** 默认 read-only（加载是只读引用，不写资产）。 */
  permissionMode?: string;
  signal?: AbortSignal;
  /** 透传 runner 的流式事件（可选）。 */
  onEvent?: (event: LocalEvent) => void;
}

export type CapabilityLoadReason =
  | 'invalid_input'
  | 'pack_not_found'
  | 'expired'
  | 'cwd_denied'
  | 'missing_cli'
  | 'receipt_failed'
  | 'execution_failed'
  | 'no_action_plan'
  | 'cancelled';

export interface CapabilityLoadResult {
  ok: boolean;
  boundary: ExecutionBoundary;
  reason?: CapabilityLoadReason;
  /** 目标 Agent 产出的 Action Plan 块（仅 ok=true）。 */
  actionPlan?: string;
  runId?: string;
  sessionId?: string;
  receiptId?: string;
  executionId?: string;
}

/** 测试注入点：detect/run/receipt 全部可替换（test-double 边界不真 spawn）。 */
export interface CapabilityLoadDeps {
  detectCli?: (cli: LocalCliType) => Promise<LocalCliEntry>;
  runCli?: (opts: RunCliAgentOpts) => Promise<RunCliAgentResult>;
  prepareReceipt?: typeof prepareReceipt;
  completeReceipt?: typeof completeReceipt;
}

/** 组装目标端加载指令：任务 + 能力包引用清单（只给引用，不复制正文，守 AC-06）。 */
export function buildCapabilityLoadPrompt(
  pack: MinimumCapabilityPack,
  taskPrompt: string,
): string {
  const refs = (label: string, values: string[]): string | null =>
    values.length ? `${label}: ${values.join(', ')}` : null;
  const lines = [
    refs('规则引用', pack.rule_refs),
    refs('模板引用', pack.template_refs),
    refs('本体切片', pack.ontology_slice_refs),
    refs('Artifact 版本', pack.artifact_version_refs),
  ].filter((value): value is string => value !== null);

  return `任务目标：${taskPrompt.trim()}

你正在接手一个已有工作上下文（能力包 ${pack.pack_id}）。该包只携带资产引用、不携带正文——以下资产请按需读取：
- Main Skill: ${pack.main_skill_ref.asset_id}@${pack.main_skill_ref.version}
${lines.map((line) => `- ${line}`).join('\n')}
${pack.personal_context_ref ? `- 个人上下文: ${pack.personal_context_ref}\n` : ''}- 作用域: ${pack.scope}；权限: ${pack.permissions.join(', ') || '默认'}

要求：
1. 先输出一段「任务理解」（1-3 句：你打算如何使用上述资产完成任务）。
2. 再输出行动计划块，严格按以下格式（每步一行，以 - 开头，至少 ${MIN_ACTION_PLAN_STEPS} 步）：

ACTION_PLAN:
- 步骤 1: ...
- 步骤 2: ...
- 步骤 3: ...`;
}

/** 提取并校验 ACTION_PLAN 块：标记存在 + 非空 + ≥3 个步骤行；不合格返回 null。 */
export function extractActionPlan(output: string): string | null {
  const match = ACTION_PLAN_BLOCK_RE.exec(output ?? '');
  if (!match) return null;
  const block = match[1].trim();
  if (!block) return null;
  const steps = block.split(/\r?\n/).filter((line) => ACTION_STEP_RE.test(line));
  if (steps.length < MIN_ACTION_PLAN_STEPS) return null;
  return block;
}

function fail(reason: CapabilityLoadReason, boundary: ExecutionBoundary = 'degraded'): CapabilityLoadResult {
  return { ok: false, boundary, reason };
}

export async function loadCapabilityPackToTarget(
  uid: string,
  input: CapabilityLoadInput,
  deps: CapabilityLoadDeps = {},
): Promise<CapabilityLoadResult> {
  const detectCli = deps.detectCli ?? detectOne;
  const runCli = deps.runCli ?? run;
  const prep = deps.prepareReceipt ?? prepareReceipt;
  const complete = deps.completeReceipt ?? completeReceipt;

  // ── 1. 输入与沙箱 ──────────────────────────────────────────────
  if (!safeId(input.packId) || !input.taskPrompt?.trim() || input.taskPrompt.length > TASK_PROMPT_MAX) {
    return fail('invalid_input');
  }
  if (!isPathAllowed(input.cwd, input.allowedRoots)) return fail('cwd_denied');

  // ── 2. 能力包：存在 + 未过期 ───────────────────────────────────
  const pack = await readCapabilityPack(uid, input.packId);
  if (!pack) return fail('pack_not_found');
  if (isCapabilityPackExpired(pack)) return fail('expired');

  // ── 3. pre-flight：目标 CLI 真实探测（缺失 → degraded，不冒充 real）──
  const entry = await detectCli(input.cli);
  if (!entry?.available) {
    log.warn('capability load refused: target cli missing', {
      user_id: maskId(uid),
      pack_id: maskId(input.packId),
      cli: input.cli,
    });
    return fail('missing_cli');
  }

  // ── 4. 组装加载指令 ────────────────────────────────────────────
  const prompt = buildCapabilityLoadPrompt(pack, input.taskPrompt);

  const executionId = `run-${randomUUID()}`;
  const receiptId = `rcp-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const cid = `cap-${executionId.replace(/^run-/, '')}`;
  const targetSessionId = `s-${executionId.replace(/^run-/, '')}`;
  // CLI 探测通过 = real（test-double 仅测试注入）；探测失败已在上一步拒绝。
  const boundary: ExecutionBoundary = 'real';
  const permissionMode = input.permissionMode ?? 'read-only';

  const lifecycle = createLifecycleSink(uid, {
    executionId,
    kind: 'local-agent',
    cli: input.cli,
    agentId: input.targetAgentId,
    receiptId,
    boundary,
    permissionMode,
    sessionId: targetSessionId,
  });
  await lifecycle.queued({ sessionId: targetSessionId });

  // ── 5. 回执 prepare（先事件后资产：事件失败则零残留）──────────
  try {
    await prep(uid, {
      executionId,
      receiptId,
      targetSessionId,
      reusedRefs: pack.asset_ids,
      omittedRefs: [],
      permissionMode,
      allowedScopes: ['default'],
      boundary,
    }, { sessionId: targetSessionId });
    await lifecycle.event('receipt_prepared', { receiptId, packId: pack.pack_id });
  } catch (err) {
    await lifecycle.terminal({ status: 'failed', output: (err as Error).message });
    return fail('receipt_failed');
  }

  // ── 6. 真实执行（唯一 spawn 路径：local_agents/runner）─────────
  const result = await runCli({
    uid,
    cid,
    agentId: input.targetAgentId,
    cli: input.cli,
    prompt,
    cwd: input.cwd,
    signal: input.signal ?? new AbortController().signal,
    skipDispatchCheck: true,
    onEvent: (event) => input.onEvent?.(event),
  });

  // ── 7. 输出校验 + 收尾 ─────────────────────────────────────────
  const actionPlan = extractActionPlan(result.output ?? '');
  const completed = result.status === 'completed' && !!actionPlan;
  const cancelled = result.status === 'cancelled';

  if (completed) {
    await lifecycle.event('capability_loaded', {
      packId: pack.pack_id,
      boundary: 'real',
      refs: pack.asset_ids,
      runId: result.runId,
    });
    await lifecycle.terminal({ status: 'completed', output: actionPlan });
    await complete(uid, executionId, {
      status: 'completed',
      treatmentExecutionId: executionId,
      targetSessionId,
      reusedRefs: pack.asset_ids,
      permissionMode,
    });
    log.info('capability pack loaded to target', {
      user_id: maskId(uid),
      pack_id: maskId(pack.pack_id),
      execution_id: maskId(executionId),
      cli: input.cli,
      boundary,
      run_id: maskId(result.runId),
    });
    return {
      ok: true,
      boundary: 'real',
      actionPlan,
      runId: result.runId,
      sessionId: targetSessionId,
      receiptId,
      executionId,
    };
  }

  // 状态优先级：取消/失败是执行问题，先于 Action Plan 缺失判定
  const reason: CapabilityLoadReason = cancelled
    ? 'cancelled'
    : result.status === 'completed'
      ? 'no_action_plan'
      : 'execution_failed';
  await lifecycle.terminal({
    status: cancelled ? 'cancelled' : 'failed',
    ...(result.error ? { output: result.error } : {}),
  });
  await complete(uid, executionId, {
    status: 'degraded',
    targetSessionId,
    permissionMode,
  });
  log.warn('capability load failed', {
    user_id: maskId(uid),
    pack_id: maskId(pack.pack_id),
    execution_id: maskId(executionId),
    reason,
    cli_status: result.status,
    cli_error: result.error || undefined,
  });
  return { ...fail(reason), executionId, receiptId };
}
