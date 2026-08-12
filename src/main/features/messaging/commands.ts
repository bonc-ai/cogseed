/**
 * Inbound slash commands for messaging channels（飞书/微信私聊命令）。
 *
 * 复用现有 `/new` `/reset` 会话重置命令的拦截模式（manager.ts 的
 * `isNewSessionCommand` 先例）：入站文本在进入 group-chat bus 之前被识别，
 * 由注册的 handler 消费，不消耗 agent turn。
 *
 * 本模块只做「识别 + 分发注册表」，是纯函数、零业务依赖：
 *   - `matchInboundCommand`：文本 → 命令（/权限、/遗忘 [确认|取消|scope]）
 *   - `registerInboundCommand` / `dispatchInboundCommand`：handler 注册表，
 *     业务 handler 由上层注册（personal_context/commands.ts 注册
 *     /权限 /遗忘），messaging 不静态依赖任何业务模块。
 *
 * 命令语法（草案 docs/research/2026-08-10-permission-forget-command-draft.md）：
 *   /权限                  → 只读展示授权全景
 *   /遗忘 <scope>          → 预览将遗忘的范围（不执行）
 *   /遗忘 确认             → 执行上一条预览（绑定预览快照）
 *   /遗忘 取消             → 放弃预览
 */

import type { InboundEnvelope, MessagingInstance } from './types';

export type InboundCommandName = 'permission' | 'forget';

export type ForgetCommandAction = 'preview' | 'confirm' | 'cancel';

export interface InboundCommand {
  name: InboundCommandName;
  /** 命令名之后的原始参数（trim 后；无参数为空串） */
  args: string;
  /** forget 子动作：无参数/带 scope → preview；确认 → confirm；取消 → cancel */
  action?: ForgetCommandAction;
}

export interface InboundCommandContext {
  uid: string;
  instance: MessagingInstance;
  envelope: InboundEnvelope;
  command: InboundCommand;
}

export interface InboundCommandOutcome {
  /** true = 命令已被消费，消息不应继续进入对话流 */
  consumed: boolean;
  /** 可选：需要回给用户的文本（经 ledger 投递，幂等） */
  replyText?: string;
}

export type InboundCommandHandler = (ctx: InboundCommandContext) => Promise<InboundCommandOutcome>;

const handlers = new Map<InboundCommandName, InboundCommandHandler>();

/** 注册命令 handler（同名覆盖）。由业务模块在启动时注册。 */
export function registerInboundCommand(name: InboundCommandName, handler: InboundCommandHandler): void {
  handlers.set(name, handler);
}

export function unregisterInboundCommand(name: InboundCommandName): void {
  handlers.delete(name);
}

/** 测试辅助：当前已注册的命令名。 */
export function registeredCommandNames(): InboundCommandName[] {
  return [...handlers.keys()];
}

// ── 识别（纯函数）─────────────────────────────────────────────────────────

const PERMISSION_RE = /^\/权限(?:\s|$)/;
const FORGET_RE = /^\/遗忘(?:\s|$)/;

/**
 * 把入站文本解析为命令。只识别本模块维护的命令名；未知 `/xxx` 返回 null
 * （走正常对话流，不劫持）。`/new` `/reset` 由既有会话重置分支先行处理。
 */
export function matchInboundCommand(text: string): InboundCommand | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  if (PERMISSION_RE.test(trimmed)) {
    return { name: 'permission', args: trimmed.replace(PERMISSION_RE, '').trim() };
  }
  if (FORGET_RE.test(trimmed)) {
    const args = trimmed.replace(FORGET_RE, '').trim();
    if (args === '确认') return { name: 'forget', args, action: 'confirm' };
    if (args === '取消') return { name: 'forget', args, action: 'cancel' };
    return { name: 'forget', args, action: 'preview' };
  }
  return null;
}

// ── 分发 ─────────────────────────────────────────────────────────────────

/** 分发命令给已注册 handler；未注册（无业务接线）时返回未消费，消息走正常流程。 */
export async function dispatchInboundCommand(ctx: InboundCommandContext): Promise<InboundCommandOutcome> {
  const handler = handlers.get(ctx.command.name);
  if (!handler) return { consumed: false };
  try {
    return await handler(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      consumed: true,
      replyText: `命令处理失败：${message}`,
    };
  }
}
