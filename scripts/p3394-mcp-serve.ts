#!/usr/bin/env tsx
/**
 * P3394 SA-MCP bridge surface CLI (SDK design §10.2).
 *
 * Starts a stdio MCP server for MCP hosts (Claude-style desktops,
 * user-built agents) with the five p3394.* bridge tools:
 *
 *   npx tsx scripts/p3394-mcp-serve.ts
 *
 * The process opens its own loopback reply listener (COGSEED_P3394_PORT +
 * 10000 by default, P3394_MCP_REPLY_PORT override) so peers can answer
 * p3394.peer.send calls directly to this process. Peer registry and
 * CogSeed bridge token are read from the p3394 runtime-variant state
 * files — nothing is invented or written.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
process.env.COGSEED_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-mcp-serve-'));

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}

async function main(): Promise<void> {
  // 动态 import：必须在 COGSEED_WORKSPACE_ROOT 设置之后加载 src/main 模块。
  const { P3394HttpChannel } = await import('../src/main/features/p3394_bridge/http-channel');
  const { P3394OutboundHub } = await import('../src/main/features/p3394_bridge/outbound-hub');
  const { P3394PeerRegistry } = await import('../src/main/features/p3394_bridge/registry');
  const { P3394McpBridgeServer } = await import('../src/main/features/p3394_bridge/mcp-surface');
  const { p3394ObjectStoreGet } = await import('../src/main/features/p3394_bridge/object-store');
  const { p3394StateFile, variantRoot } = await import('../src/main/features/p3394_bridge/runtime-paths');
  const { buildP3394OutboundEnvelope } = await import('../src/main/features/cogseed_backend/p3394-host-adapter');
  const registry = new P3394PeerRegistry({ filePath: p3394StateFile('p3394-peers.json') });
  const replyPort = Number(process.env.P3394_MCP_REPLY_PORT || 18444);
  const replyToken = 'p3394-mcp-' + Math.random().toString(36).slice(2);
  const replyChannel = new P3394HttpChannel('mcp-reply', { listen: { host: '127.0.0.1', port: replyPort }, authToken: replyToken });
  await replyChannel.listen();

  const hub = new P3394OutboundHub({ listPeers: () => registry.list(), replyTimeoutMs: 10 * 60 * 1000 });
  replyChannel.subscribe((envelope) => { hub.tryResolveReply(envelope); });

  const server = new P3394McpBridgeServer({
    listPeers: () => {
      const now = Date.now();
      return registry.list().map((peer) => ({
        agent_id: peer.identity.agent_id,
        display_name: peer.identity.display_name,
        capabilities: [...(peer.capabilities ?? [])],
        online: !!peer.last_seen_at && now - new Date(peer.last_seen_at).getTime() < 90_000,
      }));
    },
    sendToPeer: async (peer, message, opts) => {
      const resolved = registry.resolve(peer);
      if (resolved.ok === false) {
        const byCap = registry.findByCapability(peer, { preferLocal: true });
        if (byCap.ok === false) return { status: 'error', peer, error: 'p3394_peer_not_registered' };
        return doSend(byCap.value.identity.agent_id, message, opts);
      }
      return doSend(resolved.value.identity.agent_id, message, opts);
    },
    getTask: () => null,
    cancelTask: async () => {},
    getResource: (digest) => { const r = p3394ObjectStoreGet(digest); return r.ok ? r.value : null; },
  });

  function doSend(agentId: string, message: string, opts?: { session_id?: string; goal?: string }): Promise<{ status: 'ok' | 'error'; peer: string; reply?: string; error?: string }> {
    const envelope = {
      spec_version: 'p3394/1.0',
      message_id: 'msg-mcp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      session_id: opts?.session_id || 'ses-mcp-' + agentId,
      kind: 'task',
      performative: 'request',
      role: 'requester',
      sender: { agent_id: 'cogseed', alias: 'CogSeed (MCP)' },
      recipients: [{ agent_id: agentId }],
      payload: {
        parts: [{ type: 'text', text: message.slice(0, 20_000) }],
        ...(opts?.goal ? { metadata: { goal: opts.goal.slice(0, 200) } } : {}),
      },
      idempotency_key: 'idem-mcp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      extensions: { reply_endpoint: 'http://127.0.0.1:' + replyPort, reply_token: replyToken },
    };
    return hub.sendAndWait(agentId, envelope).then((reply) => ({ status: 'ok' as const, peer: agentId, reply: reply.text.slice(0, 24_000) }))
      .catch((error) => ({ status: 'error' as const, peer: agentId, error: error instanceof Error ? error.message : String(error) }));
  }

  const state = readJson<{ token?: string }>(path.join(variantRoot(), 'p3394-bridge.json'));
  process.stderr.write('[p3394-mcp] SA-MCP bridge surface ready (reply port ' + replyPort + ', peers ' + registry.list().length + ', cogseed token ' + (state?.token ? 'present' : 'absent') + ')\n');
  server.start();
}

void main().catch((error) => {
  process.stderr.write('[p3394-mcp] failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exit(1);
});
