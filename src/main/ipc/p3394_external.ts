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

export const p3394ExternalHandlers = {
  'p3394.external.list': async (args: { force?: boolean }) => {
    const entries = await detectAll({ force: args?.force === true });
    const gateways = listExternalGateways();
    return { ok: true, entries, gateways };
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
