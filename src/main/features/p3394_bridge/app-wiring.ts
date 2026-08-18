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
 *   COGSEED_P3394_CONVERSATION  ('0' switches to the cogseed-task runtime)
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { createLogger } from '../../logger';
import { getActiveUserId } from '../users';
import { p3394StateFile, variantRoot } from './runtime-paths';
import { P3394BridgeKernel } from './bridge';
import { P3394BridgeExecutor, isP3394LoopbackEndpoint } from './executor';
import { buildP3394BridgeManifest } from './manifest';
import { P3394CogseedRuntimeAdapter } from './cogseed-runtime-adapter';
import { P3394ConversationRuntimeAdapter } from './conversation-runtime';
import { P3394HttpChannel } from './http-channel';
import { missingP3394ChannelCapabilities } from './channel-adapter';
import { P3394OutboundHub } from './outbound-hub';
import { P3394PeerRegistry, type P3394Locality, type P3394NodeKind } from './registry';
import type { P3394Envelope } from './envelope';
import { recordP3394Episode } from './kstar-episodes';
import { projectP3394NodeToTeam, projectedTeamAgentId } from './team-projection';
import { buildP3394WiringDoctorInput, runP3394BridgeDoctor, type P3394DoctorReport } from './doctor';
import { loadP3394EventCursors, persistP3394EventCursors, recordP3394EventCursor } from './event-cursor-store';
import { P3394RecoveryController } from './recovery-controller';
import { redactP3394Secrets } from './secrets';
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
  /** 出站会话绑定：conversation 模式下把 session 绑定到发起对话，对端
   *  回复路由回同一对话（不新建 [P3394] peer 独立对话）。 */
  bindSessionCid?: (sessionId: string, cid: string) => void;
  close: () => Promise<void>;
}

let activeHandle: P3394AppBridgeHandle | null = null;
let outboundHub: P3394OutboundHub | null = null;
/**
 * Idempotency ledger for forwarded envelopes (H-05, M-03). Persisted so a
 * bridge restart does not re-forward a (target, idempotency_key) the old
 * process already forwarded (at-least-once without a fresh duplicate). Bounded
 * LRU-ish cap; forwarding volume is low, so 4096 is far above realistic load.
 */
const FORWARD_IDEM_FILE = () => p3394StateFile('p3394-forward-idempotency.json');

function loadForwardIdempotency(): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(FORWARD_IDEM_FILE(), 'utf8')) as { keys?: string[] };
    if (Array.isArray(parsed.keys)) return new Set(parsed.keys.slice(-4096));
  } catch { /* first run / unreadable -> empty */ }
  return new Set();
}

function persistForwardIdempotency(set: Set<string>): void {
  try {
    const file = FORWARD_IDEM_FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    // 0600：幂等账本不含 token，但沿用私有文件惯例。
    fs.writeFileSync(tmp, JSON.stringify({ schema_version: 1, keys: [...set].slice(-4096) }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    log.warn('P3394 forward idempotency persist failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

const forwardedIdempotency = loadForwardIdempotency();
/**
 * In-flight (pending) forwards (P1-2). Kept in-memory only: pending is a
 * per-process reservation to dedupe concurrent duplicate forwards; it must NOT
 * survive a restart (a failed/unknown in-flight becomes retryable on boot,
 * which is correct for at-least-once — the target idempots the retry anyway).
 */
const forwardedPending = new Set<string>();


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
      // R-05（迁移）：修复前遗留的 0644 token 文件在此顺手续到 0600。
      try { fs.chmodSync(bridgeStateFile(), 0o600); } catch { /* best effort */ }
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
    // 0500/0600：桥 token 是唯一入站认证因子，必须仅本进程/本用户可读
    //（父目录 755 时 0644 会让同机用户读到）。
    fs.writeFileSync(tmp, JSON.stringify({ token }, null, 2) + '\n', { mode: 0o600 });
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

async function buildBridge(port: number, token: string, conversation: boolean): Promise<P3394AppBridgeHandle | null> {
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
  // H-01：不再硬编码注册 hermes→9000 类的"假节点"。外部/其他 CLI 节点一律
  // 通过 hello 自注册（loopback 端点）或用户外接流程建立；硬编码会让
  // @hermes 在 9000 无人监听时表现为"貌似在线实则误路由"（9000 可能被
  // 其它网关占用，如 claude）。Hermes 默认不注册静态地址——派发时由
  // p3394-gateway-turn 的 recoverGateway 自动拉起 Hermes 自己的 external
  // gateway（空闲端口）并动态注册。仅当显式配置 COGSEED_P3394_HERMES_ENDPOINT
  // （对端自托管网关）时按配置注册。
  const hermesEndpoint = process.env.COGSEED_P3394_HERMES_ENDPOINT || '';
  if (hermesEndpoint) {
    bridge.registry.register({
      identity: { agent_id: 'hermes', display_name: 'Hermes' },
      manifest: manifestOf('hermes'),
      endpoints: [hermesEndpoint],
    });
  }

  // Default: messages enter the normal conversation flow and are visible in
  // the UI. COGSEED_P3394_CONVERSATION=0 switches to the cogseed-task backend.
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
        teamAgentIdForPeer: projectedTeamAgentId,
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
    // C-04：认证失败进入内核审计（可追溯；入站速率限制兜底审计量）。
    audit: (record) => {
      bridge.audit.append({ ...record, actor_id: 'http-listener' });
    },
  });
  channel.setLocalManifest(manifestOf('cogseed'));

  outboundHub = new P3394OutboundHub({ listPeers: () => bridge.registry.list() });

  // 事件游标（R-06/S-05）：记录最后确认写入 resultFile 的事件序列，
  // 断线恢复按游标续读，不重放已确认事件。
  const eventCursors = loadP3394EventCursors();
  let cursorEventsSincePersist = 0;

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
      const line = redactP3394Secrets(JSON.stringify({ at: new Date().toISOString(), session_id: sessionId, event }));
      // 事件/结果文件改 0600 私有（含完整文本与转发扩展字段，同机用户不可读）。
      fs.mkdirSync(path.dirname(resultFile), { recursive: true });
      try {
        const fd = fs.openSync(resultFile, 'a', 0o600);
        try { fs.writeSync(fd, line + '\n'); } finally { fs.closeSync(fd); }
      } catch {
        fs.appendFileSync(resultFile, line + '\n');
      }
      try { fs.chmodSync(resultFile, 0o600); } catch { /* best effort */ }
      recordP3394EventCursor(eventCursors, event.task_id, event.sequence);
      cursorEventsSincePersist += 1;
      if (
        event.kind === 'completed' || event.kind === 'failed' || event.kind === 'cancelled'
        || cursorEventsSincePersist >= 10
      ) {
        persistP3394EventCursors(eventCursors);
        cursorEventsSincePersist = 0;
      }
    },
  });

  // 自动恢复（C-03/R-06/S-05）：transport 失败 → recoverable → 定时 sweep
  // 按持久化游标 resumeForward 续读；尝试受控制器 maxAttempts 封顶。
  const recoveryController = new P3394RecoveryController(executor, {
    cursorFor: (taskId) => eventCursors.get(taskId) ?? 0,
    onAttempt: (taskId, ok, error) => {
      log.info('P3394 recovery attempt', { task_id: taskId, ok, ...(error ? { error } : {}) });
    },
  });
  const recoveryTimer = setInterval(() => {
    void recoveryController.sweep().then((result) => {
      if (result.recovered.length > 0 || result.pending.length > 0) {
        log.info('P3394 recovery sweep', result);
      }
    });
  }, 30_000);
  if (typeof recoveryTimer.unref === 'function') recoveryTimer.unref();
  channel.subscribe(async (envelope) => {
    // 自举接入：本机已通过 Bearer 认证但尚未注册的 sender，自报身份即注册
    // （minimal manifest）。这样任何本机智能体/自研 Agent 无需预配置即可入网。
    // 发送方可用 sender.alias 声明人类可读的显示名（用户自建 Agent 用来自报名字）。
    // 对端网关启动时发的 hello 信封在 extensions.endpoints 里自报本端地址——
    // 记录它，CogSeed 随后就能主动回叫（p3394_send）该节点。
    //
    // 设计决策（S-02/冒用评估）：首次声明一个"此前未注册"的 id 仍会自举成功，
    // 这是"轻点即入网"的既有设计；依赖三点兜底——(1) 入站唯一认证因子是桥
    // token，已 0600 私有（本机恶意进程读不到）；(2) hello 端点仅接受回环，
    // 无法把出站引向任意第三方；(3) 已注册节点不被覆盖。若未来需要更强
    // 控管，可改为"受管 CLI 由 CogSeed 代注册、外部节点首次注册需 UI 确认"
    //（会破坏无头 hello 自动入网，故当前不做）。
    const senderId = envelope.sender.agent_id;
    const senderAlias =
      typeof envelope.sender.alias === 'string' && envelope.sender.alias.trim()
        ? envelope.sender.alias.trim().slice(0, 60)
        : '';
    const rawEndpoints = envelope.extensions && Array.isArray(envelope.extensions.endpoints)
      ? envelope.extensions.endpoints
      : [];
    // S-02/SSRF：hello 自报端点只接受 loopback（回环）——入站自注册不应
    // 把出站/对象拉取引向任意非回环地址（loose hello 自注册 + 端点即信任
    // 的组合会被冒用者扩展成 SSRF/端点劫持）。非回环端点记 warn 并丢弃。
    const helloEndpoints = rawEndpoints
      .filter((value): value is string => typeof value === 'string' && value.startsWith('http'))
      .filter((value) => isP3394LoopbackEndpoint(value))
      .slice(0, 8);
    const rejectedNonLoopback = rawEndpoints
      .filter((value): value is string => typeof value === 'string' && value.startsWith('http'))
      .filter((value) => !isP3394LoopbackEndpoint(value));
    if (rejectedNonLoopback.length > 0) {
      log.warn('P3394 hello endpoints rejected (non-loopback, S-02)', { from: senderId, endpoints: rejectedNonLoopback.slice(0, 4) });
    }
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
      // 已注册节点：hello/心跳带来的新信息刷新注册记录（能力/node_kind/
      // profile/位置更新），显示名只在首次注册时锁定。
      // L-02：hello 自报端点是节点"当前真实地址"的权威声明——用 hello 集合
      // 替换旧端点（而非合并），避免托管网关重启换端口后旧端口在 failover
      // 列表里无限累积。心跳（无端点）则保留既有端点。
      const fresh = {
        identity: existing.value.identity,
        aliases: existing.value.aliases,
        manifest: existing.value.manifest,
        endpoints: helloEndpoints.length > 0 ? helloEndpoints.slice(0, 8) : (existing.value.endpoints ?? []),
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
      try {
        await projectP3394NodeToTeam({
          nodeId: senderId,
          ...(senderAlias ? { alias: senderAlias } : {}),
          ...(helloEndpoints.length ? { endpoints: helloEndpoints } : {}),
        });
      } catch (error) {
        log.warn('P3394 identity projection failed; continuing inbound delivery', {
          sender_id: senderId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // 网关 A → 网关 B 互调（peer forwarding）：入站信封带
    // extensions.forward_to 时，本桥作为受信任中枢把任务转发给目标节点，
    // 并把目标回复回发给原 sender。不进入本地 executor（不本地执行）。
    // 安全：sender/target 都必须已注册；幂等按 (target, idempotency_key)；
    // 审计每条转发。gateway 永远只与本桥通信，不暴露其他节点端点。
    const rawForwardTo = ext && typeof ext.forward_to === 'string' ? ext.forward_to.trim() : '';
    if (rawForwardTo) {
      const { forwardEnvelopeToPeer } = await import('./peer-forward');
      try {
        const outcome = await forwardEnvelopeToPeer(envelope, rawForwardTo, {
          resolveAgent: (id) => bridge.registry.resolve(id),
          sendAndWait: (agentId, env) => outboundHub.sendAndWait(agentId, env),
          // P1-3: relay legs are terminal — delivery receipt only, no reply
          // waiter, no lingering outbox replay.
          sendOnce: (agentId, env) => outboundHub.sendOnce(agentId, env),
          audit: (record) => { bridge.audit.append(record); },
          // P1-2: pending/completed/failed 状态机——isDuplicate 只在 key 处于
          // in-flight 或已成功完成时返回 true；失败后 markFailed 释放 pending，
          // 同 key 可重试，不会被永久当作重复而丢弃。
          isDuplicate: (key) => forwardedIdempotency.has(key) || forwardedPending.has(key),
          markPending: (key) => { forwardedPending.add(key); },
          markCompleted: (key) => {
            forwardedPending.delete(key);
            forwardedIdempotency.add(key);
            if (forwardedIdempotency.size > 4096) {
              const first = forwardedIdempotency.values().next().value;
              if (first !== undefined) forwardedIdempotency.delete(first);
            }
            // 持久化幂等账本（H-05）：重启后不重转发已处理过的信封。
            persistForwardIdempotency(forwardedIdempotency);
          },
          markFailed: (key) => { forwardedPending.delete(key); },
          bridgeInfo: { endpoint: `http://${listenHost}:${port}`, token },
        });
        if (outcome.ok === false) {
          log.warn('P3394 peer forward rejected', { from: senderId, to: rawForwardTo, error: outcome.error });
          // 转发失败必须回传错误信封给 sender：否则发起方（gateway 的
          // /p3394/call）会因 bridge 只回 200-ack、失败仅记日志而空等
          // replyWaiters 直到自身超时（3 分钟）。带 reply_to 的错误信封
          // 会让 gateway 的 reply_to waiter 立即命中并返回失败原因。
          try {
            const errReply: P3394Envelope = {
              spec_version: 'p3394/1.0',
              message_id: 'fwd-err-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
              session_id: envelope.session_id,
              task_id: envelope.task_id,
              kind: 'message',
              performative: 'inform',
              role: 'responder',
              sender: { agent_id: 'cogseed', alias: 'CogSeed' },
              recipients: [{ agent_id: senderId }],
              payload: { parts: [{ type: 'text', text: '[p3394_forward_error] ' + outcome.error }] },
              reply_to: envelope.message_id,
              idempotency_key: 'forward-error:' + envelope.idempotency_key,
            };
            // P1-3: 错误信封同样是终端消息——sender 不会对它再回复，用
            // delivery-only 的 sendOnce（送达即 completed），避免登记回复
            // waiter 与 outbox 残留重放。
            await outboundHub.sendOnce(senderId, errReply);
          } catch (relayError) {
            log.warn('P3394 forward error relay failed', { from: senderId, to: rawForwardTo, error: relayError instanceof Error ? relayError.message : String(relayError) });
          }
        }
      } catch (error) {
        log.warn('P3394 peer forward failed', { from: senderId, to: rawForwardTo, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    executor.execute(envelope);
  });

  const handle: P3394AppBridgeHandle = {
    endpoint: `http://${listenHost}:${port}`,
    port,
    token,
    channel,
    registry: bridge.registry,
    // conversation 模式下出站会话绑定（对端回复回当前对话）。
    ...(adapter instanceof P3394ConversationRuntimeAdapter
      ? {
          bindSessionCid: (sessionId: string, cid: string) => {
            (adapter as P3394ConversationRuntimeAdapter).bindSession(sessionId, cid);
          },
        }
      : {}),
    close: async () => {
      clearInterval(recoveryTimer);
      await channel.close();
    },
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

  // 入站监听失败（如默认端口被本机其它实例占用）→ 立即失败返回 null，由
  // maybeStartP3394Bridge 换空闲端口重试。绝不让 bridge 以"监听失败但 handle
  // 存在"的假成功状态对外——否则对端网关按 bridgeInfo.endpoint 回发的回复
  // 无人应答（此前 8444 被安装版占用时正是如此，回复 401 丢失 → 5 分钟超时）。
  try {
    await channel.listen();
  } catch (error) {
    log.error('P3394 bridge listen failed', { error: error instanceof Error ? error.message : String(error) });
    try { await channel.close(); } catch { /* ignore */ }
    return null;
  }
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
  // 托管网关恢复：应用重启会清掉所有托管网关（quit/boot 清理），这里按
  // state 文件逐 CLI respawn，否则「外接」agent 依赖手动起的网关进程，
  // 重启后必然"接入失败"。startExternalGateway 幂等（存活实例直接复用）。
  // P1-1：bridgeInfo 必须显式传入——此处仍在 buildBridge 内部，activeHandle
  // 要等 maybeStartP3394Bridge 拿到 handle 之后才赋值，getP3394BridgeInfo()
  // 此刻一定返回 null；若让 respawn 回退到全局 bridgeInfo，重启恢复会全部
  // 以 p3394_bridge_unavailable 失败。显式带上本桥自己的 endpoint/token。
  try {
    const { respawnManagedGateways } = await import('./external-gateways');
    const outcome = await respawnManagedGateways({ bridgeInfo: { endpoint: `http://${listenHost}:${port}`, token } });
    if (outcome.restarted.length > 0 || outcome.failed.length > 0) {
      log.info('P3394 managed gateways recovered at boot', outcome);
    }
  } catch (error) {
    log.warn('P3394 managed gateway respawn failed', { error: error instanceof Error ? error.message : String(error) });
  }
  return handle;
}

/** Finds a free loopback port (bind-0 style allocation). */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Boot hook (serial task 'p3394:bridge'). Always starts; env only overrides. */
export async function maybeStartP3394Bridge(): Promise<P3394AppBridgeHandle | null> {
  try {
    const envPort = process.env.COGSEED_P3394_PORT;
    const port = envPort !== undefined ? Number(envPort) : P3394_DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      log.warn('COGSEED_P3394_PORT ignored (invalid port)', { port: envPort });
      return null;
    }
    const token = resolveToken();
    const conversation = process.env.COGSEED_P3394_CONVERSATION !== '0';
    let handle = await buildBridge(port, token, conversation);
    // 默认端口被本机其它实例（安装版 CogSeed / DSH 网关等）占用时，自动换
    // 空闲端口，保证 P3394 入站（对端网关回发地址）始终可用；显式配置的
    // COGSEED_P3394_PORT 不兜底（fail-loud，让配置错误暴露）。
    if (!handle && envPort === undefined) {
      const fallback = await freeLoopbackPort();
      log.warn('P3394 bridge default port in use — falling back to a free port', { desired: port, fallback });
      handle = await buildBridge(fallback, token, conversation);
    }
    activeHandle = handle;
    return handle;
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

/** 当前桥 handle（出站会话绑定等）。桥未启动返回 null。 */
export function getP3394BridgeHandle(): P3394AppBridgeHandle | null {
  return activeHandle;
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

/** Reconcile live local P3394 peers into the same Agent directory shown by
 * the AI team UI. The peer registry is the online truth; team-projection owns
 * idempotent Agent creation and stale-mapping recovery. */
export async function syncP3394TeamDirectory(): Promise<void> {
  const peers = listP3394Peers().filter((peer) => (
    peer.online
    && peer.locality === 'same_host'
    && peer.endpoints.length > 0
    && peer.agent_id !== 'cogseed'
  ));
  await Promise.all(peers.map((peer) => projectP3394NodeToTeam({
    nodeId: peer.agent_id,
    alias: peer.display_name,
    endpoints: peer.endpoints,
  })));
}

/** Fetches one content-addressed object from a peer's resource endpoint
 *  (§12). Uses the local store when the endpoint is our own. */
export function fetchP3394ObjectFromEndpoint(endpoint: string, digest: string, bearerToken: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    // H-01（SSRF 防御钳制）：对象拉取端点必须回环——hello 自注册已限 loopback，
    // 这里再加一道，防 registry 里出现非回环端点（显式配置等）时拉任意内网地址。
    if (!isP3394LoopbackEndpoint(endpoint)) {
      log.warn('P3394 object fetch rejected (non-loopback endpoint, H-01)', { endpoint: String(endpoint).slice(0, 120) });
      resolve(null);
      return;
    }
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
