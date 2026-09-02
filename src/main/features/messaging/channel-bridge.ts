/**
 * 第三期「渠道即节点」：把每个运行中的 messaging 渠道实例注册为
 * P3394 花名册节点（node_kind = channel_bridge），智能体经 p3394_send
 * 点名渠道节点即可主动触达用户（翻译官模式的出站方向）。
 *
 * 投递走本模块的 deliverToChannelBridge（host-adapter 分流），不经
 * outbound-hub 的 HTTP dial——渠道节点没有网络端点，它是进程内虚拟节点。
 */

import { getP3394PeerRegistry } from '../p3394_bridge/app-wiring';
import { buildP3394BridgeManifest } from '../p3394_bridge/manifest';
import type { P3394Envelope } from '../p3394_bridge/envelope';
import type { MessagingInstance } from './types';

export const CHANNEL_BRIDGE_NODE_KIND = 'channel_bridge' as const;

/** 渠道节点 agent_id：`channel-<instanceId>`（稳定、可反解）。 */
export function channelBridgeAgentId(instanceId: string): string {
  return `channel-${instanceId}`;
}

export function instanceIdFromChannelBridgeAgentId(agentId: string): string | null {
  return agentId.startsWith('channel-') ? agentId.slice('channel-'.length) : null;
}

function syntheticChannelAgent(instance: MessagingInstance) {
  return {
    agent_id: channelBridgeAgentId(instance.id),
    name: `${instance.displayName}`,
    description_zh: `消息渠道节点（${instance.platform}）`,
    description_en: `Messaging channel node (${instance.platform})`,
    workflow: '',
    category: 'general',
    source: 'custom' as const,
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
}

/** 注册/刷新渠道节点（实例启用后调用；幂等，重复注册即 touch）。 */
export function registerChannelBridgeNode(instance: MessagingInstance): { ok: boolean; error?: string } {
  const registry = getP3394PeerRegistry();
  if (!registry) return { ok: false, error: 'p3394_bridge_unavailable' };
  const manifestResult = buildP3394BridgeManifest(syntheticChannelAgent(instance) as never);
  if (!manifestResult.ok) {
    const failure = manifestResult as Extract<typeof manifestResult, { ok: false }>;
    return { ok: false, error: failure.error.message };
  }
  const registered = registry.register({
    identity: { agent_id: channelBridgeAgentId(instance.id), display_name: instance.displayName },
    aliases: [instance.displayName],
    manifest: manifestResult.manifest,
    endpoints: [],
    capabilities: ['messaging.relay', 'messaging.proactive'],
    node_kind: 'channel_bridge',
    locality: 'in_process',
  });
  if (registered.ok) return { ok: true };
  const regFailure = registered as Extract<typeof registered, { ok: false }>;
  return { ok: false, error: regFailure.error.message };
}

export function unregisterChannelBridgeNode(instanceId: string): void {
  const registry = getP3394PeerRegistry();
  registry?.revoke(channelBridgeAgentId(instanceId));
}

/** p3394_send 到渠道节点：取信封文本 → 经渠道主动发给 owner → 回执信封。
 *
 * 护栏（设计风险表：渠道即节点后智能体滥发消息）：
 * - 白名单：allowedSenders 为 sender agent_id 列表；undefined = 全放行
 *   （现状兼容），空数组 = 拒绝所有。
 * - 限流：内存滑动窗口，per (uid, instance, sender) 10 条/分钟 +
 *   per (uid, instance) 总 30 条/分钟。进程内护栏（重启清零），
 *   防的是失控智能体刷屏，不是计费精度。
 * - 卡片：parts 中 {type:'json', data:{card}} 格子还原为投递 card 参数
 *   （飞书交互卡片等渠道特有结构，信封不丢特性）。 */
export async function deliverToChannelBridge(
  uid: string,
  agentId: string,
  envelope: P3394Envelope,
  send: (uid: string, input: { instanceId: string; recipientId: string; text: string; sourceKey: string; card?: Record<string, unknown> }) => Promise<unknown>,
  ownerResolver: (uid: string, instanceId: string) => Promise<{ recipientId: string } | null>,
  options?: { allowedSenders?: string[] },
): Promise<{ ok: true; receipt: P3394Envelope } | { ok: false; error: string }> {
  const instanceId = instanceIdFromChannelBridgeAgentId(agentId);
  if (!instanceId) return { ok: false, error: 'p3394_not_a_channel_bridge' };
  const senderId = envelope.sender?.agent_id || '';
  if (options && Array.isArray(options.allowedSenders) && !options.allowedSenders.includes(senderId)) {
    return { ok: false, error: 'p3394_channel_bridge_sender_not_allowed' };
  }
  if (!admitChannelBridgeSend(uid, instanceId, senderId)) {
    return { ok: false, error: 'p3394_channel_bridge_rate_limited' };
  }
  const text = (envelope.payload?.parts || [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
  if (!text) return { ok: false, error: 'p3394_channel_bridge_empty_text' };
  const cardPart = (envelope.payload?.parts || []).find((part) => part.type === 'json'
    && part.data && typeof part.data === 'object' && 'card' in (part.data as Record<string, unknown>));
  const card = cardPart ? (cardPart.data as { card?: Record<string, unknown> }).card : undefined;
  const owner = await ownerResolver(uid, instanceId);
  if (!owner) return { ok: false, error: 'p3394_channel_bridge_no_owner' };
  try {
    await send(uid, {
      instanceId,
      recipientId: owner.recipientId,
      text,
      sourceKey: `p3394:${envelope.message_id}`,
      ...(card ? { card } : {}),
    });
  } catch (error) {
    // AbortError 单独识别：调用方（如 proactive sendToSelf）依赖它区分
    // "turn 中止"（not_sent/aborted）与真实投递失败。
    if ((error as Error)?.name === 'AbortError') {
      return { ok: false, error: 'p3394_channel_bridge_aborted' };
    }
    return { ok: false, error: (error as Error).message || 'p3394_channel_bridge_delivery_failed' };
  }
  const receipt: P3394Envelope = {
    ...envelope,
    message_id: `${envelope.message_id}:receipt`,
    kind: 'event',
    performative: 'inform',
    sender: { agent_id: agentId },
    recipients: [envelope.sender],
    payload: { parts: [{ type: 'text', text: 'channel bridge delivered' }] },
  };
  return { ok: true, receipt };
}

// ── 系统触达统一信封入口（触达与对话同路）───────────────────────
// touchpoints / 个人简报 / sendToSelf 等系统侧主动通知，不再直调
// sendProactive，而是构造 P3394 信封经 deliverToChannelBridge 投递——
// 与智能体触达同一条路（护栏 + 回执 + 台账运单号）。sendProactive 退为
// 底层物理传输（台账/重试/幂等能力保留，只被本路径与 agent 分流调用）。
// 系统身份（cogseed:<uid>）不走白名单（白名单管智能体，不管用户自配置
// 的系统通知），但仍受实例级限流保护（防系统 bug 刷屏）。




// ── 限流（进程内滑动窗口）──────────────────────────────────────────────

const RATE_WINDOW_MS = 60_000;
const PER_SENDER_LIMIT = 10;
const PER_INSTANCE_LIMIT = 30;

/** sender 维度窗口：`<uid>\0<instance>\0<sender>` → 时间戳数组。 */
const _senderWindows = new Map<string, number[]>();
/** 实例维度窗口：`<uid>\0<instance>` → 时间戳数组。 */
const _instanceWindows = new Map<string, number[]>();

function admitWindow(windowKey: string, store: Map<string, number[]>, limit: number, now: number): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  const stamps = (store.get(windowKey) || []).filter((ts) => ts > cutoff);
  if (stamps.length >= limit) {
    store.set(windowKey, stamps);
    return false;
  }
  stamps.push(now);
  store.set(windowKey, stamps);
  return true;
}

/** 限流判定 + 记账。放行时两级窗口都记账；任一级超限拒绝（不记账，重试
 * 仍会被同一窗口挡住直到滑出）。系统身份（cogseed:* 前缀，sendSystemVia
 * ChannelBridge 的 sender）聚合了全部系统通知（简报/触达点/提醒），单个
 * 系统身份的 10 条/分钟会误伤正常业务——系统身份只受实例级 30 条/分钟
 * 约束（防 bug 刷屏依然有效）。 */
function admitChannelBridgeSend(uid: string, instanceId: string, senderAgentId: string, now = Date.now()): boolean {
  const isSystemSender = senderAgentId.startsWith('cogseed:');
  if (!isSystemSender) {
    const senderOk = admitWindow(`${uid}\0${instanceId}\0${senderAgentId}`, _senderWindows, PER_SENDER_LIMIT, now);
    if (!senderOk) return false;
  }
  const instanceOk = admitWindow(`${uid}\0${instanceId}`, _instanceWindows, PER_INSTANCE_LIMIT, now);
  if (!instanceOk) {
    // 回滚 sender 记账，避免实例级限流白白消耗单个 sender 的配额
    if (!isSystemSender) {
      const key = `${uid}\0${instanceId}\0${senderAgentId}`;
      const stamps = _senderWindows.get(key);
      if (stamps && stamps.length) {
        stamps.pop();
        _senderWindows.set(key, stamps);
      }
    }
    return false;
  }
  return true;
}

/** 测试专用：清空限流窗口。 */
export function resetChannelBridgeRateLimitsForTests(): void {
  _senderWindows.clear();
  _instanceWindows.clear();
}
