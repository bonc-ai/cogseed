/**
 * 渠道任务接续命令（/agent …）——同一渠道内切换执行智能体，任务不断线。
 *
 * 一手需求（2026-08-26 Richard）："我一开始用 Claude Code，换成 Codex，
 * 然后我在 Codex 上跟微信可以接着说话"。微信/Telegram 单聊没有 @ 提及，
 * 靠本命令切换；飞书群聊的 @ 提及路由（router.resolveRecipients）同样
 * 落在 active_recipient 楼层上，两条入口共用同一状态。
 *
 * 上下文交接不在此处实现：group_chat/context_handoff.ts 已按可见性切片
 * 为新执行的智能体自动注入有界摘要，切换楼层后首条消息即生效。
 *
 * handler 经 messaging/commands.ts 注册表接入 manager 的通用命令分发
 * （识别 → 消费 → ledger 回复），与 /权限 /遗忘 同一模式，不消耗
 * agent turn。
 */

import { createLogger } from '../../logger';
import { t } from '../../i18n';
import { registerDeferred } from '../../util/boot_init';
import { listAgents } from '../agents';
import { COMMANDER_ID, addMember, readState, setActiveRecipient } from '../group_chat/state';
import * as chats from '../chats';
import { registerInboundCommand, type InboundCommandContext, type InboundCommandOutcome } from './commands';
import * as bindings from './bindings';

const log = createLogger('messaging:continuity_commands');

/** 与 router._normalizeNameKey 同口径：小写 + 去空白，容纳 "Claude Code"
 *  这类带空格显示名与大小写差异。 */
function normalizeNameKey(s: string): string {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}

/** 解析用户输入的名字/Id → 目标 agent。匹配显示名（normalize 后）或
 *  原始 agent_id；"指挥官/commander" 视为切回指挥官（重置楼层）。 */
export async function resolveAgentTarget(name: string): Promise<
  { kind: 'commander' } | { kind: 'agent'; id: string; name: string } | null
> {
  const key = normalizeNameKey(name);
  if (!key) return null;
  if (key === '指挥官' || key === 'commander' || key === 'cogseed') return { kind: 'commander' };
  for (const agent of await listAgents()) {
    if (agent?.enabled === false) continue;
    if (agent.agent_id === name.trim()) return { kind: 'agent', id: agent.agent_id, name: agent.name };
    if (normalizeNameKey(agent.name) === key) return { kind: 'agent', id: agent.agent_id, name: agent.name };
  }
  return null;
}

async function handleAgent(ctx: InboundCommandContext): Promise<InboundCommandOutcome> {
  const { uid, instance, envelope } = ctx;
  const args = ctx.command.args.trim();
  const agents = (await listAgents()).filter((a) => a?.enabled !== false);

  // /agent（无参）：列出可切换的智能体，指挥官总在列。
  if (!args) {
    if (!agents.length) return { consumed: true, replyText: t('messaging.continuity.agent_none_available') };
    const list = [t('messaging.continuity.badge_commander'), ...agents.map((a) => a.name)].join('、');
    return { consumed: true, replyText: t('messaging.continuity.agent_list', { list }) };
  }

  const target = await resolveAgentTarget(args);
  if (!target) {
    return { consumed: true, replyText: t('messaging.continuity.agent_not_found', { name: args }) };
  }

  const binding = await bindings.resolveOrCreateBinding(uid, instance, envelope);
  if (target.kind === 'agent') {
    // 楼层路由只认 roster 内的成员：先把目标 agent 加进会话（幂等），
    // 再把 active_recipient 交到它手上。
    await addMember(uid, binding.cid, { kind: 'agent', id: target.id, name: target.name });
    await setActiveRecipient(uid, binding.cid, target.id);
    log.info('continuity agent switched', {
      uid,
      cid: binding.cid,
      instanceId: instance.id,
      agentId: target.id,
    });
    return { consumed: true, replyText: t('messaging.continuity.agent_switched', { name: target.name }) };
  }
  // 切回指挥官 = 清除楼层，恢复 user → commander 默认路由。
  await setActiveRecipient(uid, binding.cid, COMMANDER_ID);
  log.info('continuity agent switched back to commander', { uid, cid: binding.cid, instanceId: instance.id });
  return {
    consumed: true,
    replyText: t('messaging.continuity.agent_switched', { name: t('messaging.continuity.badge_commander') }),
  };
}

/** 当前执行者显示名：楼层 agent → 注册表名；无楼层 → 指挥官。 */
async function currentExecutorLabel(uid: string, cid: string): Promise<string> {
  const state = await readState(uid, cid);
  const floor = state.active_recipient;
  if (!floor) return t('messaging.continuity.badge_commander');
  for (const agent of await listAgents()) {
    if (agent.agent_id === floor && agent?.enabled !== false) return agent.name;
  }
  return t('messaging.continuity.badge_commander');
}

async function handleStatus(ctx: InboundCommandContext): Promise<InboundCommandOutcome> {
  const { uid, instance, envelope } = ctx;
  const binding = await bindings.resolveOrCreateBinding(uid, instance, envelope);
  const conversation = await chats.getConversation(uid, binding.cid);
  const title = conversation?.title || binding.externalChatTitle || binding.cid;
  const agent = await currentExecutorLabel(uid, binding.cid);
  return { consumed: true, replyText: t('messaging.continuity.status_line', { title, agent }) };
}

async function handleUnbind(ctx: InboundCommandContext): Promise<InboundCommandOutcome> {
  const { uid, instance, envelope } = ctx;
  const binding = await bindings.resolveOrCreateBinding(uid, instance, envelope);
  const updated = await bindings.setBindingUnbound(uid, binding.key, true);
  log.info('continuity chat unbound', {
    uid,
    cid: binding.cid,
    instanceId: instance.id,
    unboundedAt: updated?.unboundedAt || '',
  });
  return { consumed: true, replyText: t('messaging.continuity.unbind_done') };
}

// ── 安装 ─────────────────────────────────────────────────────────────────

let installed = false;

/** 注册 /agent /status /unbind handler。幂等；由 boot_init deferred 阶段调用。 */
export function installContinuityCommands(): void {
  if (installed) return;
  installed = true;
  registerInboundCommand('agent', handleAgent);
  registerInboundCommand('status', handleStatus);
  registerInboundCommand('unbind', handleUnbind);
  log.info('continuity commands installed (/agent /status /unbind)');
}

/** 测试辅助：重置安装状态。 */
export function _resetContinuityCommandsForTest(): void {
  installed = false;
}

// boot 的 deferred 阶段安装命令 handler（注册表全局，与用户无关）。
registerDeferred('continuity-commands-install', async () => {
  installContinuityCommands();
});
