/**
 * IPC handlers for the P3394 external-agent gateway host — the
 * agent-modal 「外接」tab (P3394 way).
 *
 * Channels:
 *  - p3394.external.list   → detected CLIs + managed gateway status
 *  - p3394.external.start  → start the managed P3394 gateway for a CLI
 *  - p3394.external.stop   → stop a managed gateway
 *  - p3394.peers.revoke    → remove a registered node (registry + projection
 *                            + its managed gateway)
 *  - p3394.peers.toggle    → disable/enable a registered node
 *
 * The renderer never spawns gateways directly; all lifecycle goes through
 * features/p3394_bridge/external-gateways.ts.
 */

import { detectAll } from '../features/local_agents/registry.js';
import {
  listExternalGateways, startExternalGateway, stopExternalGateway,
} from '../features/p3394_bridge/external-gateways';
import { listP3394Peers, revokeP3394Peer, setP3394PeerEnabled } from '../features/p3394_bridge/app-wiring';
import {
  listRemoteNodes, addRemoteNode, removeRemoteNode, testRemoteNode, testRemoteNodeById,
} from '../features/p3394_bridge/remote-nodes';
import { listAgents } from '../features/agents';

export const p3394ExternalHandlers = {
  'p3394.external.list': async (args: { force?: boolean }) => {
    const entries = await detectAll({ force: args?.force === true });
    const gateways = listExternalGateways();
    // 同 CLI 允许多个外接 agent：统计已绑定的 agent（名字列表），渲染端
    // 用它给「外接」tab 打「已连接」标记（不禁用，只提示当前实例已有该
    // 本地 CLI 的成员，避免无意识重复创建造成困惑）。
    let bound: Record<string, string[]> = {};
    try {
      const all = await listAgents();
      bound = {};
      for (const agent of all) {
        const rt = agent.runtime as { kind?: string; cli?: string } | undefined;
        if (rt && rt.kind === 'p3394-gateway' && rt.cli) {
          (bound[rt.cli] ??= []).push(agent.name || rt.cli);
        }
      }
    } catch { /* best effort — 标记缺失不阻塞外接 */ }
    // P3：一次往返带回注册表快照（在线状态/能力/端点），「外接」tab 据此
    // 渲染"已接入节点"管理区，不再单独拉 p3394.peers.list。
    return { ok: true, entries, gateways, bound, peers: listP3394Peers() };
  },
  'p3394.external.start': async (args: { cli?: unknown; alias?: unknown; binPath?: unknown }) => {
    const cli = typeof args?.cli === 'string' ? args.cli.trim() : '';
    if (!cli) return { ok: false, error: 'p3394_cli_required' };
    const alias = typeof args?.alias === 'string' ? args.alias.trim() : '';
    const binPath = typeof args?.binPath === 'string' ? args.binPath.trim() : undefined;
    const result = await startExternalGateway({ cli, ...(alias ? { alias } : {}), ...(binPath ? { binPath } : {}) });
    if (result.ok === false) return { ok: false, error: result.error };
    // 用户显式重新外接该 CLI → 解除投影抑制（允许再次自动投影）。
    try {
      const { unsuppressNodeProjection } = await import('../features/p3394_bridge/team-projection');
      unsuppressNodeProjection(cli);
    } catch { /* best effort */ }
    return { ok: true, gateway: result.value };
  },
  'p3394.external.stop': async (args: { cli?: unknown }) => {
    const cli = typeof args?.cli === 'string' ? args.cli.trim() : '';
    if (!cli) return { ok: false, error: 'p3394_cli_required' };
    const result = await stopExternalGateway(cli);
    if (result.ok === false) return { ok: false, error: result.error };
    return { ok: true };
  },
  // ── 统一注册表管理（已注册节点）────────────────────────────────────
  // 注：不再提供独立的 p3394.peers.list —— 注册表快照已随
  // p3394.external.list 一次往返带回（peers 字段），渲染端只消费那一个
  // 通道，避免双通道两套缓存。
  'p3394.peers.revoke': async (args: { agentId?: unknown }) => {
    const agentId = typeof args?.agentId === 'string' ? args.agentId.trim() : '';
    if (!agentId) return { ok: false, error: 'p3394_peer_id_required' };
    return revokeP3394Peer(agentId);
  },
  'p3394.peers.toggle': async (args: { agentId?: unknown; disabled?: unknown }) => {
    const agentId = typeof args?.agentId === 'string' ? args.agentId.trim() : '';
    if (!agentId) return { ok: false, error: 'p3394_peer_id_required' };
    return setP3394PeerEnabled(agentId, args?.disabled === true);
  },

  // 第二期 Dashboard：远端节点配置管理（token 只落机器私有文件，视图打码）
  'p3394.remote.list': async () => listRemoteNodes(),
  'p3394.remote.add': async (args: { label?: unknown; endpoint?: unknown; token?: unknown; expected_identity?: unknown }) =>
    addRemoteNode(args ?? {}),
  // 移除远端节点 = 删配置 + 撤销花名册注册（同一 agent_id），否则节点
  // 下次 hello 又会重新出现，用户视角"删不掉"。
  'p3394.remote.remove': async (args: { id?: unknown }) => {
    const removed = removeRemoteNode(args?.id);
    if (removed.ok && removed.expected_identity) {
      try { revokeP3394Peer(removed.expected_identity); } catch { /* best effort */ }
    }
    return removed.ok ? { ok: true } : removed;
  },
  'p3394.remote.test': async (args: { id?: unknown; endpoint?: unknown; token?: unknown; expected_identity?: unknown }) =>
    (typeof args?.id === 'string' && args.id
      ? testRemoteNodeById(args.id)
      : testRemoteNode(args ?? {})),
};
