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

/** p3394_send 到渠道节点：取信封文本 → 经渠道主动发给 owner → 回执信封。 */
export async function deliverToChannelBridge(
  uid: string,
  agentId: string,
  envelope: P3394Envelope,
  send: (uid: string, input: { instanceId: string; recipientId: string; text: string; sourceKey: string }) => Promise<unknown>,
  ownerResolver: (uid: string, instanceId: string) => Promise<{ recipientId: string } | null>,
): Promise<{ ok: true; receipt: P3394Envelope } | { ok: false; error: string }> {
  const instanceId = instanceIdFromChannelBridgeAgentId(agentId);
  if (!instanceId) return { ok: false, error: 'p3394_not_a_channel_bridge' };
  const text = (envelope.payload?.parts || [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
  if (!text) return { ok: false, error: 'p3394_channel_bridge_empty_text' };
  const owner = await ownerResolver(uid, instanceId);
  if (!owner) return { ok: false, error: 'p3394_channel_bridge_no_owner' };
  try {
    await send(uid, {
      instanceId,
      recipientId: owner.recipientId,
      text,
      sourceKey: `p3394:${envelope.message_id}`,
    });
  } catch (error) {
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
