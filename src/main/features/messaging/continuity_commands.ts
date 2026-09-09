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
import { listAgents, type Agent } from '../agents';
import { COMMANDER_ID, addMember, readState, setActiveRecipient } from '../group_chat/state';
import * as chats from '../chats';
import { registerInboundCommand, type InboundCommandContext, type InboundCommandOutcome } from './commands';
import * as bindings from './bindings';

const log = createLogger('messaging:continuity_commands');

/** 列表最多直接展示的名字数；超出部分折叠为「等 N 个」。 */
export const AGENT_LIST_MAX = 15;

// ── 跨渠道配对（G2-1）─────────────────────────────────────────────────────

/** 配对码有效期（毫秒）：10 分钟内到另一渠道输入，过时作废。 */
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

/** 待消费配对：A 渠道生成 → B 渠道输入。仅存内存（重启即失效，可接受——
 *  配对是一次性动作）；一次性消费后即删。跨实例（渠道）由调用方校验。 */
interface PendingPair {
  uid: string;
  sourceInstanceId: string;
  sourceKey: string;
  targetCid: string;
  targetTitle: string;
  expiresAt: number;
}

const pendingPairs = new Map<string, PendingPair>();

function sweepExpiredPairs(now: number): void {
  for (const [code, pair] of pendingPairs) {
    if (pair.expiresAt <= now) pendingPairs.delete(code);
  }
}

/** 生成 6 位数字配对码（加密随机，前导零保留）。导出供测试。 */
export function generatePairCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, '0');
}

/** 供测试注入时钟与重置状态。 */
export const _pairTestHooks = {
  setNow: (fn: () => number) => { nowProvider = fn; },
  reset: () => { pendingPairs.clear(); nowProvider = defaultNow; },
  pendingCount: () => pendingPairs.size,
};
const defaultNow = () => Date.now();
let nowProvider = defaultNow;

/** 渲染 /agent 无参列表（纯函数，导出供测试）：截断 + 汇总 + 用法提示。 */
export function formatAgentList(names: readonly string[]): string {
  const shown = names.slice(0, AGENT_LIST_MAX).join('、');
  const list = names.length > AGENT_LIST_MAX
    ? `${shown} ${t('messaging.continuity.agent_list_more', { count: names.length - AGENT_LIST_MAX })}`
    : shown;
  return `${t('messaging.continuity.agent_list', { list })}\n${t('messaging.continuity.agent_list_usage')}`;
}

/** 与 router._normalizeNameKey 同口径：小写 + 去空白，容纳 "Claude Code"
 *  这类带空格显示名与大小写差异。 */
function normalizeNameKey(s: string): string {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}

/** 解析用户输入的名字/Id → 目标 agent。匹配顺序：精确（显示名 normalize
 *  后或原始 agent_id）→ 唯一前缀（"cod" 命中 Codex；多候选返回歧义名单
 *  供上层引导）。"指挥官/commander" 视为切回指挥官（重置楼层）。
 *  可传入调用方已取好的启用名单，避免一次命令重复读注册表。 */
export async function resolveAgentTarget(
  name: string,
  roster?: Agent[],
): Promise<
  | { kind: 'commander' }
  | { kind: 'agent'; id: string; name: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | null
> {
  const key = normalizeNameKey(name);
  if (!key) return null;
  if (key === '指挥官' || key === 'commander' || key === 'cogseed') return { kind: 'commander' };
  const agents = roster || (await listAgents()).filter((a) => a?.enabled !== false);
  for (const agent of agents) {
    if (agent.agent_id === name.trim()) return { kind: 'agent', id: agent.agent_id, name: agent.name };
    if (normalizeNameKey(agent.name) === key) return { kind: 'agent', id: agent.agent_id, name: agent.name };
  }
  const prefixed = agents.filter((a) => normalizeNameKey(a.name).startsWith(key));
  if (prefixed.length === 1) {
    const [only] = prefixed;
    return { kind: 'agent', id: only.agent_id, name: only.name };
  }
  if (prefixed.length > 1) return { kind: 'ambiguous', candidates: prefixed.map((a) => a.name) };
  return null;
}

async function handleAgent(ctx: InboundCommandContext): Promise<InboundCommandOutcome> {
  const { uid, instance, envelope } = ctx;
  const args = ctx.command.args.trim();
  const agents = (await listAgents()).filter((a) => a?.enabled !== false);

  // /agent（无参）：列出可切换的智能体，指挥官总在列。
  if (!args) {
    if (!agents.length) return { consumed: true, replyText: t('messaging.continuity.agent_none_available') };
    const list = [t('messaging.continuity.badge_commander'), ...agents.map((a) => a.name)];
    return { consumed: true, replyText: formatAgentList(list) };
  }

  const target = await resolveAgentTarget(args, agents);
  if (!target) {
    return { consumed: true, replyText: t('messaging.continuity.agent_not_found', { name: args }) };
  }
  if (target.kind === 'ambiguous') {
    return {
      consumed: true,
      replyText: t('messaging.continuity.agent_ambiguous', { list: target.candidates.join('、') }),
    };
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
  // G2-1：任务已接渠道——列出与本绑定同任务（同 cid）的其他启用渠道，
  // 含静音中的（静音只是不出声，仍是任务成员），当前渠道打头。
  const peers = await bindings.listBindingsForTask(uid, binding.cid);
  const other = peers.filter((b) => b.key !== binding.key);
  let channelsLine = '';
  if (other.length > 0) {
    const names: string[] = [];
    for (const b of other) {
      const label = b.instanceId === instance.id ? instance.displayName : await channelLabelFor(uid, b.instanceId);
      names.push(`${label}${b.mutedAt ? t('messaging.continuity.muted_tag') : ''}`);
    }
    channelsLine = `\n${t('messaging.continuity.status_channels', { list: names.join('、') })}`;
  }
  const selfMuted = binding.mutedAt ? `\n${t('messaging.continuity.muted_self')}` : '';
  return {
    consumed: true,
    replyText: `${t('messaging.continuity.status_line', { title, agent })}${channelsLine}${selfMuted}`,
  };
}

/** 绑定所属渠道的展示名：经实例注册表反查 displayName，查不到回退实例 id 前缀。 */
async function channelLabelFor(uid: string, instanceId: string): Promise<string> {
  try {
    const { getInstance } = await import('./registry');
    const inst = await getInstance(uid, instanceId);
    if (inst?.displayName) return inst.displayName;
  } catch {
    /* registry read is best-effort */
  }
  return instanceId.slice(0, 8);
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
  // PR209 评审 M2 复核补齐：解绑即清理该渠道实例收集的 peer 映射
  // （open_id + 显示名为私有数据，绑定解除即失效；重建走 ensure，别名
  // 纯函数生成保持稳定）。尽力而为，不阻塞解绑回执。
  try {
    const { removeChannelPeersForInstance } = await import('../p3394_bridge/channel-peer-map');
    const removed = removeChannelPeersForInstance(uid, instance.platform, instance.id);
    if (removed > 0) log.info('continuity unbind swept channel peers', { uid, instanceId: instance.id, removed });
  } catch (error) {
    log.warn('continuity unbind peer sweep failed', { error: error instanceof Error ? error.message : String(error) });
  }
  return { consumed: true, replyText: t('messaging.continuity.unbind_done') };
}

// ── 跨渠道配对（G2-1）：/pair ─────────────────────────────────────────────

async function handlePair(ctx: InboundCommandContext): Promise<InboundCommandOutcome> {
  const { uid, instance, envelope } = ctx;
  const args = ctx.command.args.trim();
  const binding = await bindings.resolveOrCreateBinding(uid, instance, envelope);

  // /pair（无参）：在当前任务上生成配对码，等另一渠道输入。
  if (!args) {
    sweepExpiredPairs(nowProvider());
    // 同一渠道同时只保留一个有效码：重新生成时作废旧码，避免多码并存
    // 让用户拿错（旧码未过期仍可用的困惑大于便利）。
    for (const [old, pair] of pendingPairs) {
      if (pair.sourceKey === binding.key) pendingPairs.delete(old);
    }
    const code = generatePairCode();
    const conversation = await chats.getConversation(uid, binding.cid);
    const title = conversation?.title || binding.externalChatTitle || binding.cid;
    pendingPairs.set(code, {
      uid,
      sourceInstanceId: instance.id,
      sourceKey: binding.key,
      targetCid: binding.cid,
      targetTitle: title,
      expiresAt: nowProvider() + PAIR_CODE_TTL_MS,
    });
    log.info('continuity pair code created', { uid, cid: binding.cid, instanceId: instance.id });
    return {
      consumed: true,
      replyText: t('messaging.continuity.pair_created', {
        code,
        minutes: Math.round(PAIR_CODE_TTL_MS / 60_000),
        title,
      }),
    };
  }

  // /pair CODE：把本渠道加入配对码所属任务。一次性消费（成功即删）。
  sweepExpiredPairs(nowProvider());
  const pair = pendingPairs.get(args);
  if (!pair || pair.expiresAt <= nowProvider() || pair.uid !== uid) {
    return { consumed: true, replyText: t('messaging.continuity.pair_invalid') };
  }
  if (pair.sourceInstanceId === instance.id && pair.sourceKey === binding.key) {
    return { consumed: true, replyText: t('messaging.continuity.pair_same_channel') };
  }
  const pointed = await bindings.pointBindingToTask(uid, binding.key, pair.targetCid);
  pendingPairs.delete(args);
  log.info('continuity pair joined', {
    uid,
    fromCid: binding.cid,
    toCid: pair.targetCid,
    instanceId: instance.id,
    sourceInstanceId: pair.sourceInstanceId,
  });
  return {
    consumed: true,
    replyText: t('messaging.continuity.pair_joined', {
      title: pointed ? pair.targetTitle : binding.externalChatTitle || pair.targetCid,
    }),
  };
}

// ── 跨渠道治理（G2-2）：/mute /unmute ──────────────────────────────────────

async function handleMute(ctx: InboundCommandContext, mute: boolean): Promise<InboundCommandOutcome> {
  const { uid, instance, envelope } = ctx;
  const binding = await bindings.resolveOrCreateBinding(uid, instance, envelope);
  const updated = await bindings.setBindingMuted(uid, binding.key, mute);
  log.info('continuity channel mute toggled', {
    uid,
    cid: binding.cid,
    instanceId: instance.id,
    muted: mute,
    mutedAt: updated?.mutedAt || '',
  });
  return {
    consumed: true,
    replyText: mute ? t('messaging.continuity.mute_on') : t('messaging.continuity.mute_off'),
  };
}

// ── 安装 ─────────────────────────────────────────────────────────────────

let installed = false;

/** 注册 /agent /status /unbind /pair /mute /unmute handler。幂等；由
 *  boot_init deferred 阶段调用。 */
export function installContinuityCommands(): void {
  if (installed) return;
  installed = true;
  registerInboundCommand('agent', handleAgent);
  registerInboundCommand('status', handleStatus);
  registerInboundCommand('unbind', handleUnbind);
  registerInboundCommand('pair', handlePair);
  registerInboundCommand('mute', (ctx) => handleMute(ctx, true));
  registerInboundCommand('unmute', (ctx) => handleMute(ctx, false));
  log.info('continuity commands installed (/agent /status /unbind /pair /mute /unmute)');
}

/** 测试辅助：重置安装状态。 */
export function _resetContinuityCommandsForTest(): void {
  installed = false;
}

// boot 的 deferred 阶段安装命令 handler（注册表全局，与用户无关）。
registerDeferred('continuity-commands-install', async () => {
  installContinuityCommands();
});
