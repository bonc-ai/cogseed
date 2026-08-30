// ─── Chat stream events (conv-core spec) ───────────────────────────────────
//
// 统一会话事件模型：主进程所有执行路径（hermes 直连 / P3394 网关 / local
// agent / commander）把执行过程投影为 ChatTurn / ChatItem / ChatInteraction
// 三层语义，经既有 SSE 通道（agents.chat.sendStream）叠加下发，渲染层
// chat-stream 组件群只消费这一套事件。老字段（delta/progress 纯文本）在
// 兼容期保留，见 spec.md「事件契约」。
//
// 本文件是运行时校验的事实源（zod）；静态类型由 schema 推导，见 types.ts。

import { z } from 'zod';

/** 一轮执行（Turn）的终态。started 由 turnStarted 事件表达。 */
export const CHAT_TURN_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

/** 单个可视单元（Item）的三态。 */
export const CHAT_ITEM_STATUSES = ['inProgress', 'completed', 'failed'] as const;

/** Item 的五种形态。 */
export const CHAT_ITEM_KINDS = [
  'reasoning',
  'toolExecution',
  'fileChange',
  'text',
  'usage',
] as const;

/** 双向交互（Interaction）的两种形态。 */
export const CHAT_INTERACTION_KINDS = ['approval', 'question'] as const;

/** 审批决策：无响应超时由主进程按拒绝处理（bridge.js 先例）。 */
export const CHAT_APPROVAL_DECISIONS = ['allow', 'allowAlways', 'deny'] as const;

const chatItemIdSchema = z.string().min(1);
const chatTurnIdSchema = z.string().min(1);

// ── Item 载荷（按 kind 区分） ──────────────────────────────────────────────

const reasoningPayloadSchema = z.object({
  /** 思考片段文本；增量到达时后到覆盖先到（同一 item 追加渲染）。 */
  text: z.string(),
});

const toolExecutionPayloadSchema = z.object({
  /** 工具名（如 Bash / Read / p3394_send）。 */
  toolName: z.string().min(1),
  /** 参数摘要：人读的一行话，不是原始 JSON（避免撑爆 UI）。 */
  argsSummary: z.string().optional(),
  /** 输出内容；工具流式输出时增量到达，渲染层可折叠。 */
  output: z.string().optional(),
  /** 失败时的错误信息（status=failed 时有意义）。 */
  error: z.string().optional(),
});

const fileChangePayloadSchema = z.object({
  /** 变更文件的绝对路径。 */
  filePath: z.string().min(1),
  /** 统一 diff 文本（无上下文行数的紧凑形式由发送端裁剪）。 */
  diff: z.string(),
  /** 变更方向概览，如 "+12 -3"。 */
  summary: z.string().optional(),
});

const textPayloadSchema = z.object({
  /** 正文文本块；流式增量（delta），渲染层按 item 聚合。 */
  delta: z.string(),
});

const usagePayloadSchema = z.object({
  /** 输入/输出 token 数（口径沿用 #84 对话内统计）。 */
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  /** 按用户默认单价估算的费用（非账单金额）。 */
  estimatedCost: z.number().nonnegative().optional(),
  /** 上下文窗口占用比（0-1），接近 1 触发压缩提示（矩阵 #10）。 */
  contextWindowRatio: z.number().min(0).max(1).optional(),
});

// ── 事件 ────────────────────────────────────────────────────────────────────

/** Turn 开始。 */
export const chatTurnStartedSchema = z.object({
  type: z.literal('chat.turn.started'),
  turnId: chatTurnIdSchema,
  /** 归属会话（conversation id）。 */
  cid: z.string().min(1),
  /** 执行方标识（agent/skill id），用于 UI 徽标。 */
  actorId: z.string().min(1),
  startedAt: z.string().min(1),
});

/** Turn 终态。durationMs 为空表示未知（如进程崩溃后补发）。 */
export const chatTurnCompletedSchema = z.object({
  type: z.literal('chat.turn.completed'),
  turnId: chatTurnIdSchema,
  status: z.enum(CHAT_TURN_TERMINAL_STATUSES),
  durationMs: z.number().nonnegative().optional(),
  /** status=failed 时的错误说明。 */
  error: z.string().optional(),
  endedAt: z.string().min(1),
});

const chatItemPayloadSchemaByKind = {
  reasoning: reasoningPayloadSchema,
  toolExecution: toolExecutionPayloadSchema,
  fileChange: fileChangePayloadSchema,
  text: textPayloadSchema,
  usage: usagePayloadSchema,
} as const;

/** Item 出现/更新（status 流转与载荷增量都走本事件，幂等覆盖式渲染）。 */
export const chatItemEventSchema = z
  .object({
    type: z.literal('chat.item'),
    turnId: chatTurnIdSchema,
    itemId: chatItemIdSchema,
    kind: z.enum(CHAT_ITEM_KINDS),
    status: z.enum(CHAT_ITEM_STATUSES),
    payload: z.unknown(),
  })
  .superRefine((value, ctx) => {
    // payload 形状必须与 kind 匹配：union 会被全可选分支（如 usage）
    // 放行错配载荷，故按 kind 精确校验。
    const result = chatItemPayloadSchemaByKind[value.kind].safeParse(value.payload);
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `payload does not match kind "${value.kind}"`,
      });
    }
  });

/** 双向交互请求：渲染层弹卡等待用户，回复走 chat.interaction.reply IPC 通道。 */
export const chatInteractionRequestedSchema = z.object({
  type: z.literal('chat.interaction.requested'),
  turnId: chatTurnIdSchema,
  interactionId: z.string().min(1),
  kind: z.enum(CHAT_INTERACTION_KINDS),
  /** approval：危险动作描述（命令/文件/服务三类）；question：问题文本。 */
  prompt: z.string().min(1),
  /** 呈现用的细节（如完整命令行）。 */
  detail: z.string().optional(),
  /** 主进程侧超时毫秒数；超时按 deny/放弃处理，渲染层展示倒计时。 */
  timeoutMs: z.number().positive(),
  /** approval 专用：动作类别，UI 图标用。 */
  approvalCategory: z.enum(['bash', 'fileWrite', 'externalService']).optional(),
});

/** 交互结束（用户已回复或超时关闭）。渲染层据此撤卡。 */
export const chatInteractionClosedSchema = z.object({
  type: z.literal('chat.interaction.closed'),
  interactionId: z.string().min(1),
  /** 谁关的：用户回复 / 超时 / Turn 取消连带。 */
  reason: z.enum(['answered', 'timeout', 'turnCancelled']),
});

/** SSE 通道下发的统一事件联合。chatItemEventSchema 带 superRefine（按
 * kind 校验载荷），不能进 discriminatedUnion，改普通 union：各分支的
 * type 字面量不匹配时快速失败，判别语义不变。 */
export const chatStreamEventSchema = z.union([
  chatTurnStartedSchema,
  chatTurnCompletedSchema,
  chatItemEventSchema,
  chatInteractionRequestedSchema,
  chatInteractionClosedSchema,
]);

// ── 渲染层 → 主进程的回复（IPC 请求体，不走 SSE） ─────────────────────────

/** 审批决策。answeredLate（交互已关闭后才回复）由主进程幂等吞掉。 */
export const chatApprovalReplySchema = z.object({
  interactionId: z.string().min(1),
  decision: z.enum(CHAT_APPROVAL_DECISIONS),
});

/** 提问回复：自由文本。 */
export const chatQuestionReplySchema = z.object({
  interactionId: z.string().min(1),
  answer: z.string(),
});

/** 校验失败返回 null 而不是抛错：SSE 出口对未知事件宽容跳过（向前兼容）。 */
export function parseChatStreamEvent(input: unknown) {
  const result = chatStreamEventSchema.safeParse(input);
  return result.success ? result.data : null;
}
