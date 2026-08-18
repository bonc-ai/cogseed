/**
 * IPC handlers for the P3394 external-agent gateway host — the
 * agent-modal 「外接」tab (P3394 way).
 *
 * Channels:
 *  - p3394.external.list   → detected CLIs + managed gateway status
 *  - p3394.external.start  → start the managed P3394 gateway for a CLI
 *  - p3394.external.stop   → stop a managed gateway
 *
 * The renderer never spawns gateways directly; all lifecycle goes through
 * features/p3394_bridge/external-gateways.ts.
 */

import { detectAll } from '../features/local_agents/registry.js';
import { listExternalGateways, startExternalGateway, stopExternalGateway } from '../features/p3394_bridge/external-gateways';
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
    return { ok: true, entries, gateways, bound };
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
};
