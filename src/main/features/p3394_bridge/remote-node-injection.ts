/**
 * remote-nodes → PeerRegistry 注入（跨机出站断点修复，§7.2）。
 *
 * 背景：remote-nodes 的存储（p3394-remote-nodes.json）此前只被展示投影
 * 消费，从不进入注册表——用户显式配置的远端节点无法被 p3394_send /
 * findByCapability 命中，跨机出站断在"配置已存在但路由不认识"这一步。
 *
 * 信任边界（S-02 差异说明）：hello 自报端点只接受回环（入站自注册不应把
 * 出站引向任意第三方）；而 remote-nodes 是用户在 UI 里主动添加的显式信任
 * （token/expected_identity 都是用户录入的），注入的 endpoint 不受 hello
 * 回环白名单约束——该白名单只管 hello 自报端点，两者是不同的信任来源。
 */

import { createLogger } from '../../logger';
import { buildP3394BridgeManifest } from './manifest';
import { listRemoteNodesInternal } from './remote-nodes';
import type { P3394PeerRegistry, P3394Locality } from './registry';

const log = createLogger('p3394-bridge:remote-node-injection');

/** remote-node 注入记录的 trust_policy 标记：sweep 豁免 + 对账 revoke 都
 *  以它识别"这条注册来自用户显式配置的远端节点"，不碰 hello 自注册。 */
export const P3394_REMOTE_NODE_TRUST_POLICY = 'p3394-remote-node';

export interface P3394RemoteNodeSyncResult {
  registered: string[];
  updated: string[];
  revoked: string[];
  /** 跳过（无 expected_identity 无法确定 agent_id 等）。 */
  skipped: string[];
}

function manifestOf(agentId: string) {
  const result = buildP3394BridgeManifest({
    agent_id: agentId, name: agentId, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (result.ok === false) throw new Error(result.error.message);
  return result.manifest;
}

/** endpoint 主机名回环 → same_host；非回环（跨机）→ external。 */
export function p3394LocalityForEndpoint(endpoint: string): P3394Locality {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') return 'same_host';
  } catch { /* fall through to external */ }
  return 'external';
}

/**
 * 把 enabled 的 remote node 同步注册进 PeerRegistry（对账式，幂等）：
 * - endpoints=[endpoint]、dial_token=token、expected_identity、locality 按
 *   主机名判定；已存在同 identity 的 peer 更新连接字段（保留 hello 带来
 *   的 manifest/能力/显示名）；
 * - 注册表里带 remote-node 标记、但已不在 enabled 集合（移除/停用）的
 *   记录 → revoke。
 */
export function syncP3394RemoteNodesToRegistry(registry: P3394PeerRegistry): P3394RemoteNodeSyncResult {
  const result: P3394RemoteNodeSyncResult = { registered: [], updated: [], revoked: [], skipped: [] };
  // agent_id 来源是 expected_identity（用户录入的对端身份）；没有它无法
  // 确定注册身份，跳过而不是编造。
  const desired = new Map<string, ReturnType<typeof listRemoteNodesInternal>[number]>();
  for (const node of listRemoteNodesInternal()) {
    if (!node.enabled) continue;
    if (!node.expected_identity || !node.expected_identity.trim()) {
      result.skipped.push(node.endpoint);
      continue;
    }
    desired.set(node.expected_identity.trim(), node);
  }

  for (const [agentId, node] of desired) {
    const existing = registry.list().find((peer) => peer.identity.agent_id === agentId);
    if (existing) {
      // 更新连接字段，保留 hello/既有注册带来的身份与能力声明。
      const fresh = {
        identity: existing.identity,
        aliases: existing.aliases,
        manifest: existing.manifest,
        endpoints: [node.endpoint],
        ...(existing.capabilities?.length ? { capabilities: [...existing.capabilities] } : {}),
        ...(existing.node_kind ? { node_kind: existing.node_kind } : {}),
        ...(existing.supported_profiles?.length ? { supported_profiles: [...existing.supported_profiles] } : {}),
        ...(existing.preferred_channels?.length ? { preferred_channels: [...existing.preferred_channels] } : {}),
        ...(existing.data_policy ? { data_policy: existing.data_policy } : {}),
        ...(existing.cost_policy ? { cost_policy: existing.cost_policy } : {}),
        locality: p3394LocalityForEndpoint(node.endpoint),
        // 打上 remote-node 标记：移除该 remote node 时对账 revoke 它。
        trust_policy: P3394_REMOTE_NODE_TRUST_POLICY,
        expected_identity: node.expected_identity,
        ...(node.token ? { dial_token: node.token } : {}),
        ...(existing.disabled ? { disabled: true } : {}),
        now: existing.last_seen_at ?? new Date().toISOString(),
      };
      const updated = registry.register(fresh);
      if (updated.ok) result.updated.push(agentId);
      else result.skipped.push(node.endpoint);
      continue;
    }
    const registered = registry.register({
      identity: { agent_id: agentId, display_name: node.label || agentId },
      manifest: manifestOf(agentId),
      endpoints: [node.endpoint],
      // 最小可寻址能力声明：agent_id 本身可作为能力词——按 id 派发也能走
      // 能力路由（findByCapability）；远端真实能力声明由协商/UI 后续补充。
      capabilities: [agentId],
      locality: p3394LocalityForEndpoint(node.endpoint),
      trust_policy: P3394_REMOTE_NODE_TRUST_POLICY,
      expected_identity: node.expected_identity,
      ...(node.token ? { dial_token: node.token } : {}),
    });
    if (registered.ok) result.registered.push(agentId);
    else result.skipped.push(node.endpoint);
  }

  // 对账 revoke：remote-node 注入、但已不在 desired 集合的记录。hello 自
  // 注册（trust_policy 'p3394-bearer' 等）永不被这里删除。
  for (const peer of registry.list()) {
    if (peer.trust_policy !== P3394_REMOTE_NODE_TRUST_POLICY) continue;
    if (desired.has(peer.identity.agent_id)) continue;
    registry.revoke(peer.identity.agent_id);
    result.revoked.push(peer.identity.agent_id);
  }

  if (result.registered.length || result.updated.length || result.revoked.length || result.skipped.length) {
    log.info('P3394 remote nodes synced into registry', result);
  }
  return result;
}

/** §16-13 本地判定：in_process/same_host 视为本地；locality 未声明的老
 *  记录按本地处理（注册表只管本机可见节点，保守放行维持既有行为）。 */
function isLocalLocality(locality: P3394Locality | undefined): boolean {
  return locality === undefined || locality === 'in_process' || locality === 'same_host';
}

/**
 * 能力路由 Policy 门（§16 第 13 条）：本地能力不足时是否允许按 Policy 选
 * 远程节点。默认（allowRemoteCapability=false）只允许本地命中，能力只在
 * 远端时明确报 p3394_capability_not_available_locally——不允许静默外呼
 * （标准反模式）；允许远端时不带 preferLocal（enterprise/external 皆可
 * 选，registry 的 data_policy 匹配仍生效）。
 */
export function resolveP3394PeerByPolicy(
  registry: P3394PeerRegistry,
  input: string,
  opts: { allowRemoteCapability?: boolean } = {},
): { ok: true; agent_id: string; display_name: string } | { ok: false; error: string } {
  const requested = String(input || '').trim();
  if (!requested) return { ok: false, error: 'p3394_peer_not_registered' };
  const byId = registry.resolve(requested);
  if (byId.ok) {
    return { ok: true, agent_id: byId.value.identity.agent_id, display_name: byId.value.identity.display_name };
  }
  if (opts.allowRemoteCapability) {
    const remote = registry.findByCapability(requested);
    if (remote.ok) {
      return { ok: true, agent_id: remote.value.identity.agent_id, display_name: remote.value.identity.display_name };
    }
    return { ok: false, error: 'p3394_peer_not_registered' };
  }
  const local = registry.findByCapability(requested, { preferLocal: true });
  if (local.ok && isLocalLocality(local.value.locality)) {
    return { ok: true, agent_id: local.value.identity.agent_id, display_name: local.value.identity.display_name };
  }
  // 能力存在但只在远端（或完全无人声明）→ 明确报错；绝不静默选远端。
  if (local.ok) return { ok: false, error: 'p3394_capability_not_available_locally' };
  return { ok: false, error: 'p3394_peer_not_registered' };
}
