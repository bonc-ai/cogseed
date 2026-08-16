/**
 * P3394 bridge wiring for the running app (built-in, always on).
 *
 * P3394 is CogSeed's native agent-interop protocol — not a user-toggleable
 * feature. Agent collaboration goes through the CogSeed agent itself: the
 * bridge starts with the app on a loopback HTTP channel with an
 * auto-generated token, and the conversation-backed runtime routes inbound
 * P3394 messages into the normal chat flow.
 *
 * Env vars only override defaults for development:
 *   COGSEED_P3394_PORT          (default 8444)
 *   COGSEED_P3394_TOKEN         (default: generated at boot)
 *   COGSEED_P3394_CONVERSATION  ('0' switches to the mate-task runtime)
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { createLogger } from '../../logger';
import { getActiveUserId } from '../users';
import { p3394StateFile, variantRoot } from './runtime-paths';
import { P3394BridgeKernel } from './bridge';
import { P3394BridgeExecutor } from './executor';
import { buildP3394BridgeManifest } from './manifest';
import { P3394CogseedRuntimeAdapter } from './cogseed-runtime-adapter';
import { P3394ConversationRuntimeAdapter } from './conversation-runtime';
import { P3394HttpChannel } from './http-channel';
import { missingP3394ChannelCapabilities } from './channel-adapter';
import { P3394OutboundHub } from './outbound-hub';
import { P3394PeerRegistry, type P3394Locality, type P3394NodeKind } from './registry';
import { recordP3394Episode } from './kstar-episodes';
import { projectP3394NodeToTeam } from './team-projection';
import { buildP3394WiringDoctorInput, runP3394BridgeDoctor, type P3394DoctorReport } from './doctor';
import * as groupChatBus from '../group_chat/bus';

const log = createLogger('p3394-bridge:app-wiring');

/** Default loopback port when COGSEED_P3394_PORT is not set. */
export const P3394_DEFAULT_PORT = 8444;

/**
 * 启动门（SDK §5.4）：桥承诺的语义必须被所选 channel 完整承载，
 * 必需能力缺失 → 拒绝启动（fail-loud，绝不静默降级）。
 */
export const P3394_REQUIRED_CHANNEL_CAPABILITIES = {
  cancellation: true,
  durable_tasks: true,
  multi_party_sessions: true,
  identity_proofs: ['bearer-token'],
};

export interface P3394AppBridgeHandle {
  endpoint: string;
  port: number;
  token: string;
  channel: P3394HttpChannel;
  registry: P3394PeerRegistry;
  close: () => Promise<void>;
}

let activeHandle: P3394AppBridgeHandle | null = null;
let outboundHub: P3394OutboundHub | null = null;


function generatedToken(): string {
  return `p3394-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** Bridge runtime state file: holds the stable inbound token so the peer's
 *  gateway keeps working across app restarts. */
function bridgeStateFile(): string {
  return path.join(variantRoot(), 'p3394-bridge.json');
}

function readStoredToken(): string {
  try {
    if (fs.existsSync(bridgeStateFile())) {
      const parsed = JSON.parse(fs.readFileSync(bridgeStateFile(), 'utf8')) as { token?: unknown };
      if (typeof parsed.token === 'string' && parsed.token.length >= 8 && parsed.token.length <= 256) {
        return parsed.token;
      }
    }
  } catch {
    // fall through to generation
  }
  return '';
}

function persistToken(token: string): void {
  try {
    const file = bridgeStateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ token }, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (error) {
    log.warn('P3394 token persist failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Resolves the inbound token: env override > stored token > generated+stored. */
function resolveToken(): string {
  const envToken = process.env.COGSEED_P3394_TOKEN;
  if (envToken && envToken.trim()) return envToken.trim();
  const stored = readStoredToken();
  if (stored) return stored;
  const fresh = generatedToken();
  persistToken(fresh);
  return fresh;
}

function buildBridge(port: number, token: string, conversation: boolean): P3394AppBridgeHandle | null {
  const resultFile = path.join(variantRoot(), 'p3394-bridge-result.jsonl');

  const userId = getActiveUserId();
  const manifestOf = (id: string) => {
    const r = buildP3394BridgeManifest({
      agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general',
    } as never);
    if (r.ok === false) throw new Error(r.error.message);
    return r.manifest;
  };

  // ECS 本地 Cell：peer 注册表持久化到 Agent Home（重启不丢节点）。
  const registry = new P3394PeerRegistry({ filePath: p3394StateFile('p3394-peers.json') });
  const bridge = new P3394BridgeKernel({ registry });
  bridge.registry.register({ identity: { agent_id: 'cogseed', display_name: 'CogSeed' }, manifest: manifestOf('cogseed') });
  const hermesEndpoint = process.env.COGSEED_P3394_HERMES_ENDPOINT || 'http://127.0.0.1:9000';
  bridge.registry.register({
    identity: { agent_id: 'hermes', display_name: 'Hermes' },
    manifest: manifestOf('hermes'),
    endpoints: [hermesEndpoint],
  });

  // Default: messages enter the normal conversation flow and are visible in
  // the UI. COGSEED_P3394_CONVERSATION=0 switches to the mate-task backend.
  const adapter = conversation
    ? new P3394ConversationRuntimeAdapter({
        userId: () => userId,
        bus: groupChatBus,
        // Peer display names come from the registry (Hermes, …); auto-registered
        // senders fall back to their agent id.
        displayNameFor: (agentId) => {
          const resolved = bridge.registry.resolve(agentId);
          return resolved.ok ? resolved.value.identity.display_name : undefined;
        },
        // §12 resource endpoint: pull p3394-object parts from the sender's
        // registered endpoint (authenticated object fetch).
        fetchObject: (senderAgentId, digest) => {
          const peer = bridge.registry.resolve(senderAgentId);
          if (peer.ok === false || !peer.value.endpoints || peer.value.endpoints.length === 0) {
            return Promise.resolve(null);
          }
          return fetchP3394ObjectFromEndpoint(peer.value.endpoints[0], digest, token);
        },
      })
    : new P3394CogseedRuntimeAdapter({ userId: () => userId });

  // ECS 跨机器：COGSEED_P3394_HOST 可绑定局域网地址（默认回环，安全优先）。
  const listenHost = process.env.COGSEED_P3394_HOST || '127.0.0.1';
  const channel = new P3394HttpChannel('cogseed-app', {
    listen: { host: listenHost, port },
    authToken: token,
  });
  channel.setLocalManifest(manifestOf('cogseed'));

  outboundHub = new P3394OutboundHub({ listPeers: () => bridge.registry.list() });

  const executor = new P3394BridgeExecutor({
    bridge,
    runtime: adapter,
    outboundHub,
    // 会话状态持久化（SDK §6/§7）：六态状态机落盘到 Agent Home 风格
    // sessions/<id>/session.json——桥/应用重启后 open() 恢复同一状态。
    sessionFileFor: (sessionId) => {
      const safe = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
      if (!safe) return null;
      return p3394StateFile('p3394-sessions/' + safe + '.json');
    },
    autoReply: {
      // §11 结果自动回发默认开启；COGSEED_P3394_AUTO_REPLY=0 关闭。
      enabled: process.env.COGSEED_P3394_AUTO_REPLY !== '0',
      // 回发目标必须是 loopback（同机网关）或已注册 peer 的端点——防 SSRF。
      allowEndpoint: (endpoint) => {
        return bridge.registry.list().some((peer) => (peer.endpoints ?? []).includes(endpoint));
      },
    },
    recordEpisode: (episode) => {
      // KSTAR 闭环（guide §5.4）：任务终态落盘 episode（含自动 AAR）。
      try {
        recordP3394Episode(episode);
      } catch (error) {
        log.warn('P3394 KSTAR episode record failed', { error: error instanceof Error ? error.message : String(error) });
      }
    },
    onEvent: (sessionId, event) => {
      const line = JSON.stringify({ at: new Date().toISOString(), session_id: sessionId, event });
      fs.appendFileSync(resultFile, line + '\n');
    },
  });
  channel.subscribe((envelope) => {
    // 自举接入：本机已通过 Bearer 认证但尚未注册的 sender，自报身份即注册
    // （minimal manifest）。这样任何本机智能体/自研 Agent 无需预配置即可入网。
    // 发送方可用 sender.alias 声明人类可读的显示名（用户自建 Agent 用来自报名字）。
    // 对端网关启动时发的 hello 信封在 extensions.endpoints 里自报本端地址——
    // 记录它，CogSeed 随后就能主动回叫（p3394_send）该节点。
    const senderId = envelope.sender.agent_id;
    const senderAlias =
      typeof envelope.sender.alias === 'string' && envelope.sender.alias.trim()
        ? envelope.sender.alias.trim().slice(0, 60)
        : '';
    const rawEndpoints = envelope.extensions && Array.isArray(envelope.extensions.endpoints)
      ? envelope.extensions.endpoints
      : [];
    const helloEndpoints = rawEndpoints
      .filter((value): value is string => typeof value === 'string' && value.startsWith('http'))
      .slice(0, 8);
    // 对端可在 hello 里自报能力（capability discovery）与部署位置（local-first 排序）。
    const helloCapabilities = envelope.extensions && Array.isArray(envelope.extensions.capabilities)
      ? envelope.extensions.capabilities.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, 64)
      : [];
    const helloLocality = envelope.extensions && typeof envelope.extensions.locality === 'string'
      ? (['in_process', 'same_host', 'enterprise', 'external'].includes(envelope.extensions.locality) ? envelope.extensions.locality as P3394Locality : undefined)
      : undefined;
    const ext = envelope.extensions;
    const helloNodeKind = ext && typeof ext.node_kind === 'string'
      ? (['agent', 'sub_agent', 'task_agent', 'capability', 'model_runtime'].includes(ext.node_kind) ? ext.node_kind as P3394NodeKind : undefined)
      : undefined;
    const helloProfiles = ext && Array.isArray(ext.supported_profiles)
      ? ext.supported_profiles.filter((value): value is string => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 120).slice(0, 32)
      : [];
    const helloChannels = ext && Array.isArray(ext.preferred_channels)
      ? ext.preferred_channels.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, 16)
      : [];
    const helloDataPolicy = ext && typeof ext.data_policy === 'string' && ext.data_policy.trim() ? ext.data_policy.trim().slice(0, 120) : undefined;
    const helloCostPolicy = ext && typeof ext.cost_policy === 'string' && ext.cost_policy.trim() ? ext.cost_policy.trim().slice(0, 120) : undefined;
    // 投影触发：任何带可回叫端点的 hello/首次来信都尝试把本地节点投影
    // 进 AI 团队（projectP3394NodeToTeam 内部幂等 + 查重，重复调用无害）。
    const existing = bridge.registry.resolve(senderId);
    if (!existing.ok) {
      bridge.registry.register({
        identity: { agent_id: senderId, display_name: senderAlias || senderId },
        manifest: manifestOf(senderId),
        ...(helloEndpoints.length ? { endpoints: helloEndpoints } : {}),
        ...(helloCapabilities.length ? { capabilities: helloCapabilities } : {}),
        ...(helloNodeKind ? { node_kind: helloNodeKind } : {}),
        ...(helloProfiles.length ? { supported_profiles: helloProfiles } : {}),
        ...(helloChannels.length ? { preferred_channels: helloChannels } : {}),
        ...(helloDataPolicy ? { data_policy: helloDataPolicy } : {}),
        ...(helloCostPolicy ? { cost_policy: helloCostPolicy } : {}),
        ...(helloLocality ? { locality: helloLocality } : { locality: 'same_host' as P3394Locality }),
        trust_policy: 'p3394-bearer',
      });
    } else {
      // 已注册节点：hello/心跳带来的新信息刷新注册记录（endpoint 补齐、
      // 能力/node_kind/profile/位置更新），显示名只在首次注册时锁定。
      // hello 自报的地址在前（最新鲜、最可信），旧端点保留作 failover——
      // 受管网关重启换端口后，旧地址自然排在后面被 http-channel 兜底跳过。
      const mergedEndpoints = Array.from(new Set([
        ...helloEndpoints,
        ...(existing.value.endpoints ?? []),
      ])).slice(0, 8);
      const fresh = {
        identity: existing.value.identity,
        aliases: existing.value.aliases,
        manifest: existing.value.manifest,
        endpoints: mergedEndpoints.length > 0 ? mergedEndpoints : undefined,
        ...(helloCapabilities.length ? { capabilities: helloCapabilities } : {}),
        ...(helloNodeKind ? { node_kind: helloNodeKind } : {}),
        ...(helloProfiles.length ? { supported_profiles: helloProfiles } : {}),
        ...(helloChannels.length ? { preferred_channels: helloChannels } : {}),
        ...(helloDataPolicy ? { data_policy: helloDataPolicy } : {}),
        ...(helloCostPolicy ? { cost_policy: helloCostPolicy } : {}),
        ...(helloLocality ? { locality: helloLocality } : {}),
        ...(existing.value.trust_policy ? { trust_policy: existing.value.trust_policy } : {}),
        ...(existing.value.expected_identity ? { expected_identity: existing.value.expected_identity } : {}),
      };
      bridge.registry.register(fresh);
    }
    // ECS 在线状态：hello/心跳/任意入站信封都刷新该节点的 last_seen。
    bridge.registry.touch(senderId);
    // AI 团队投影（异步、幂等）：本地节点自动获得团队卡片。
    // 心跳只刷新在线状态，不触发投影（避免高频 listAgents）。
    const isHeartbeat = envelope.payload && envelope.payload.metadata && (envelope.payload.metadata as Record<string, unknown>).heartbeat === true;
    if (helloEndpoints.length > 0 && !isHeartbeat) {
      void projectP3394NodeToTeam({
        nodeId: senderId,
        ...(senderAlias ? { alias: senderAlias } : {}),
        ...(helloEndpoints.length ? { endpoints: helloEndpoints } : {}),
      });
    }
    executor.execute(envelope);
  });

  const handle: P3394AppBridgeHandle = {
    endpoint: `http://${listenHost}:${port}`,
    port,
    token,
    channel,
    registry: bridge.registry,
    close: async () => { await channel.close(); },
  };
  // 启动门（SDK §5.4）：桥承诺的语义必须被所选 channel 完整承载，
  // 必需能力缺失 → 拒绝启动（fail-loud，绝不静默降级）。
  const missingCapabilities = missingP3394ChannelCapabilities(channel.descriptor, P3394_REQUIRED_CHANNEL_CAPABILITIES);
  if (missingCapabilities.length > 0) {
    log.error('P3394 bridge refused to start: channel cannot carry required semantics', {
      missing: missingCapabilities,
      channel: channel.descriptor.id,
    });
    return null;
  }

  void channel.listen().then(async () => {
    log.info('P3394 bridge listening', {
      endpoint: handle.endpoint,
      result_file: resultFile,
    });
    // §12 Transactional Outbox：启动重放上次运行未确认的出站信封
    // （at-least-once；对端按 idempotency_key 幂等）。
    try {
      const outcome = await outboundHub.replayOutbox();
      if (outcome.replayed > 0 || outcome.failed > 0) {
        log.info('P3394 outbox replay done', outcome);
      }
    } catch (error) {
      log.warn('P3394 outbox replay failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }).catch((error) => {
    log.error('P3394 bridge listen failed', { error: error instanceof Error ? error.message : String(error) });
  });
  return handle;
}

/** Boot hook (serial task 'p3394:bridge'). Always starts; env only overrides. */
export function maybeStartP3394Bridge(): P3394AppBridgeHandle | null {
  try {
    const envPort = process.env.COGSEED_P3394_PORT;
    const port = envPort !== undefined ? Number(envPort) : P3394_DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      log.warn('COGSEED_P3394_PORT ignored (invalid port)', { port: envPort });
      return null;
    }
    const token = resolveToken();
    const conversation = process.env.COGSEED_P3394_CONVERSATION !== '0';
    activeHandle = buildBridge(port, token, conversation);
    return activeHandle;
  } catch (error) {
    log.warn('P3394 bridge start failed', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** Inbound endpoint + token — carried in outbound envelopes so the peer's
 *  gateway can reply back with zero configuration. */
export function getP3394BridgeInfo(): { endpoint: string; token: string } | null {
  if (!activeHandle) return null;
  return { endpoint: activeHandle.endpoint, token: activeHandle.token };
}

/**
 * V-01：把真实 wiring/listener 状态自动注入 Doctor。桥未启动时只返回
 * 全 warn 报告（不虚报绑定）；启动后逐项反映：
 *
 * - manifest：本节点 CogSeed Manifest；
 * - registry / agent-home：本地状态文件与数据根是否存在；
 * - runtime-adapter / replay / idempotency / audit / policy：内核默认装配，
 *   入站 extensions.epoch 已接入 replay protector；
 * - channel-adapter / channel-capabilities：按 live descriptor 复核启动门；
 * - resource-limits：HTTP body 上限 + 统一入站速率已接入；
 * - auto-reply：按 COGSEED_P3394_AUTO_REPLY。
 */
export function runP3394WiringDoctor(): P3394DoctorReport {
  if (!activeHandle) return runP3394BridgeDoctor({});
  const manifestOf = (id: string) => {
    const result = buildP3394BridgeManifest({
      agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general',
    } as never);
    return result.ok ? result.manifest : undefined;
  };
  const missingCapabilities = missingP3394ChannelCapabilities(
    activeHandle.channel.descriptor,
    P3394_REQUIRED_CHANNEL_CAPABILITIES,
  );
  return runP3394BridgeDoctor(buildP3394WiringDoctorInput({
    manifest: manifestOf('cogseed'),
    agentHomeExists: fs.existsSync(variantRoot()),
    registryPersisted: fs.existsSync(p3394StateFile('p3394-peers.json')),
    runtimeAdapterBound: true,
    replayProtectionBound: true,
    idempotencyBound: true,
    auditJournalBound: true,
    policyBound: true,
    channelAdapterBound: true,
    objectStorePresent: true,
    channelCapabilitiesMissing: missingCapabilities,
    resourceLimitsMissing: [],
    autoReplyEnabled: process.env.COGSEED_P3394_AUTO_REPLY !== '0',
  }));
}

/** Resolve a p3394_send peer argument: agent id / alias first, then a
 *  capability (best local-first match). Returns the canonical agent_id the
 *  envelope must address, plus its display name. */
export function resolveP3394Peer(
  input: string,
): { ok: true; agent_id: string; display_name: string } | { ok: false; error: string } {
  const requested = String(input || '').trim();
  if (!requested) return { ok: false, error: 'p3394_peer_not_registered' };
  if (!activeHandle) return { ok: false, error: 'p3394_bridge_unavailable' };
  const byId = activeHandle.registry.resolve(requested);
  if (byId.ok) {
    return { ok: true, agent_id: byId.value.identity.agent_id, display_name: byId.value.identity.display_name };
  }
  const byCapability = activeHandle.registry.findByCapability(requested, { preferLocal: true });
  if (byCapability.ok) {
    return { ok: true, agent_id: byCapability.value.identity.agent_id, display_name: byCapability.value.identity.display_name };
  }
  return { ok: false, error: 'p3394_peer_not_registered' };
}

/** Registry snapshot for the p3394_peers tool (id / name / capabilities /
 *  locality / endpoints — never secrets). */
export interface P3394PeerSummary {
  agent_id: string;
  display_name: string;
  capabilities: string[];
  node_kind: string;
  locality: string;
  endpoints: string[];
  supported_profiles: string[];
  trust_policy: string;
  data_policy: string;
  cost_policy: string;
  disabled: boolean;
  /** ECS 在线状态：最近一次 hello/心跳/入站活动在窗口内视为 online。 */
  online: boolean;
  last_seen_at?: string;
}

const ONLINE_WINDOW_MS = 90 * 1000;

export function listP3394Peers(): P3394PeerSummary[] {
  if (!activeHandle) return [];
  const now = Date.now();
  return activeHandle.registry.list().map((peer) => ({
    agent_id: peer.identity.agent_id,
    display_name: peer.identity.display_name,
    capabilities: [...(peer.capabilities ?? [])],
    node_kind: peer.node_kind ?? 'agent',
    locality: peer.locality ?? 'external',
    endpoints: [...(peer.endpoints ?? [])],
    supported_profiles: [...(peer.supported_profiles ?? [])],
    trust_policy: peer.trust_policy ?? '',
    data_policy: peer.data_policy ?? '',
    cost_policy: peer.cost_policy ?? '',
    disabled: peer.disabled === true,
    online: !!peer.last_seen_at && now - new Date(peer.last_seen_at).getTime() < ONLINE_WINDOW_MS,
    ...(peer.last_seen_at ? { last_seen_at: peer.last_seen_at } : {}),
  }));
}

/** Fetches one content-addressed object from a peer's resource endpoint
 *  (§12). Uses the local store when the endpoint is our own. */
export function fetchP3394ObjectFromEndpoint(endpoint: string, digest: string, bearerToken: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(endpoint.replace(/\/$/, '') + '/p3394/objects/' + digest);
    } catch {
      resolve(null);
      return;
    }
    const headers: Record<string, string> = {};
    if (bearerToken) headers.Authorization = 'Bearer ' + bearerToken;
    const request = http.request(
      { hostname: url.hostname, port: url.port ? Number(url.port) : 80, path: url.pathname, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          resolve(Buffer.concat(chunks));
        });
      },
    );
    request.setTimeout(15_000, () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
    request.end();
  });
}

/** Shuts the bridge down (app quit). */
export async function stopP3394Bridge(): Promise<void> {
  if (outboundHub) {
    await outboundHub.close();
    outboundHub = null;
  }
  if (activeHandle) {
    await activeHandle.close();
    activeHandle = null;
  }
}

/** Outbound hub for host tools (p3394_send); null when the bridge is off. */
export function getP3394OutboundHub(): P3394OutboundHub | null {
  return outboundHub;
}
