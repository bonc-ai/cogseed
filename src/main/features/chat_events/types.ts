// ─── Chat stream events — 静态类型（从 zod schema 推导） ────────────────────
//
// 事实源在 schema.ts（运行时校验）；此处只做类型导出与常量复出，
// 保证「校验过的形状」与「编译期类型」永不错位。

import type { z } from 'zod';

import type {
  CHAT_APPROVAL_DECISIONS,
  CHAT_INTERACTION_KINDS,
  CHAT_ITEM_KINDS,
  CHAT_ITEM_STATUSES,
  CHAT_TURN_TERMINAL_STATUSES,
  chatApprovalReplySchema,
  chatInteractionClosedSchema,
  chatInteractionRequestedSchema,
  chatItemEventSchema,
  chatQuestionReplySchema,
  chatStreamEventSchema,
  chatTurnCompletedSchema,
  chatTurnStartedSchema,
} from './schema';

export type ChatTurnTerminalStatus = (typeof CHAT_TURN_TERMINAL_STATUSES)[number];
export type ChatItemStatus = (typeof CHAT_ITEM_STATUSES)[number];
export type ChatItemKind = (typeof CHAT_ITEM_KINDS)[number];
export type ChatInteractionKind = (typeof CHAT_INTERACTION_KINDS)[number];
export type ChatApprovalDecision = (typeof CHAT_APPROVAL_DECISIONS)[number];

export type ChatTurnStarted = z.infer<typeof chatTurnStartedSchema>;
export type ChatTurnCompleted = z.infer<typeof chatTurnCompletedSchema>;
export type ChatItemEvent = Omit<z.infer<typeof chatItemEventSchema>, 'payload'> & {
  /** 静态联合窄化；运行时形状由 schema 的按 kind superRefine 保证。 */
  payload:
    | ReasoningPayload
    | ToolExecutionPayload
    | FileChangePayload
    | TextPayload
    | UsagePayload;
};
export type ChatInteractionRequested = z.infer<typeof chatInteractionRequestedSchema>;
export type ChatInteractionClosed = z.infer<typeof chatInteractionClosedSchema>;

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;

export type ChatApprovalReply = z.infer<typeof chatApprovalReplySchema>;
export type ChatQuestionReply = z.infer<typeof chatQuestionReplySchema>;

/** Item 载荷的具体形状（渲染层按 kind 窄化用）。 */
export type ReasoningPayload = { text: string };
export type ToolExecutionPayload = {
  toolName: string;
  argsSummary?: string;
  output?: string;
  error?: string;
  /** item 级计时（epoch ms；语义对齐 assistant-ui ToolCallTiming，见 schema 注）。 */
  timing?: {
    startedAtMs: number;
    completedAtMs?: number;
  };
};
export type FileChangePayload = {
  filePath: string;
  diff: string;
  summary?: string;
};
export type TextPayload = { delta: string };
export type UsagePayload = {
  inputTokens?: number;
  outputTokens?: number;
  /** 缓存读/写（2026-09-09 PR209 评审 M10：与 usagePayloadSchema 对齐，
   *  此前手抄版缺这两个字段——与 zod schema 漂移，运行时字段存在但类型
   *  不可见。schema 仍为事实源，此处保持同步）。 */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** 最后一次调用的 prompt 侧用量（2026-09-11）：当前上下文占用的权威
   *  口径；上方字段为整轮累加（消耗口径）。与 schema 保持同步。 */
  lastCallUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  estimatedCost?: number;
  contextWindowRatio?: number;
};
