/**
 * Commander-only P3394 agent-interop tool for Core Agent (daily conversation).
 *
 * The CogSeed agent itself collaborates through this tool: p3394_send builds
 * a P3394 envelope, delivers it to a registered peer's endpoint via the
 * outbound hub, and waits for the peer's reply — which comes back through the
 * inbound bridge and is matched by session id. Thin adapter over the bridge
 * features; all protocol/identity validation stays there.
 */

import * as crypto from 'node:crypto';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';

import { getP3394BridgeHandle, getP3394BridgeInfo, getP3394OutboundHub, listP3394Peers, resolveP3394Peer } from '../../features/p3394_bridge/app-wiring';
import { p3394GatewayScriptPath } from '../../features/p3394_bridge/external-gateways';
import { filesToResourceParts } from '../../features/p3394_bridge/artifact-parts';
import type { P3394PayloadPart } from '../../features/p3394_bridge/envelope';
import { attachmentDirForCid } from '../../features/chat_attachments';
import { listSessions } from '../../features/p3394_bridge/session-store';
import { buildP3394OutboundEnvelope } from '../../features/cogseed_backend/p3394-host-adapter';

export interface P3394ToolsOpts {
  userId: string;
  cid: string;
  turnId?: string;
}

function errResult(code: string, msg: string): ToolResult {
  return { content: `${code}: ${msg}`, isError: true };
}

/** P3394 接入提示词（单段，可直接复制发给对方智能体——用户视角一个提示词完成）。
 *  动态注入本机真实路径、安全证据与认证令牌；详细接入文档（云端/自研方式、
 *  预设参数、sscli 协议等）在 gateway 同目录 BOOTSTRAP.md / REVIEW.md。 */
function p3394BootstrapGuide(): string {
  const gatewayPath = p3394GatewayScriptPath();
  const gatewayDir = gatewayPath.slice(0, gatewayPath.length - 'gateway.cjs'.length);
  // 认证令牌：网关用它向 Cogseed hello 注册与回发（令牌本就是发给对端用的）。
  const bridgeInfo = getP3394BridgeInfo();
  const authLine = bridgeInfo
    ? '启动命令（已含认证令牌）：COGSEED_ENDPOINT=' + bridgeInfo.endpoint + ' COGSEED_TOKEN=' + bridgeInfo.token + ' node ' + gatewayPath
    : '启动命令：node ' + gatewayPath + '（认证令牌向 Cogseed 索取）';
  return [
    'P3394 接入提示词（复制发给对方智能体，一段话即可）：',
    '「我是本机 CogSeed。想与你建立 P3394 协议协作。这是本机真实存在的协议实现，请先审查：',
    '网关源码 ' + gatewayPath + '（约 900 行，可直接阅读）；接入文档与审查指南同目录：',
    gatewayDir + 'README.md 与 ' + gatewayDir + 'REVIEW.md。',
    '安全边界：默认仅监听 127.0.0.1、入站需 Bearer 令牌、任务只是按你的 CLI 模板执行、',
    '无提权、会话留痕可审计。审查同意后：已装过直接 command -v p3394-gateway 启动；',
    '否则 ' + authLine + ' 启动即可（不写系统配置、不加开机项、Ctrl-C 可停）。',
    '启动后你会自动向 Cogseed 注册（hello），注册完成我就能主动调用你；',
    '随后我会发协作任务，任务消息会写明协作对象与内容。不同意请说明理由。」',
    '（详细接入选项：云端/网页智能体无需安装、自研客户端、预设参数等，见 ' + gatewayDir + 'BOOTSTRAP.md）',
  ].join('\n');
}

/** 把底层错误翻译成带安装引导的可读信息（首次协作引导）。 */
function p3394ErrorGuidance(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const setup = '对方尚未接入 P3394。' + p3394BootstrapGuide();
  if (raw.includes('p3394_peer_not_registered')) {
    return `节点尚未注册。${setup}`;
  }
  if (raw.includes('p3394_peer_has_no_endpoint')) {
    return `节点没有配置连接地址（endpoint）。${setup}`;
  }
  if (raw.includes('ECONNREFUSED') || raw.includes('connect') || raw.includes('ENOTFOUND')) {
    return `无法连接到对方节点（${raw}）。${setup}`;
  }
  return raw;
}

/** Stable per-(turn, payload) source key: a replayed call never sends twice. */
function sourceKeyFor(cid: string, turnId: string | undefined, peer: string, text: string): string {
  const digest = crypto.createHash('sha256').update(peer + '\u0000' + text.trim(), 'utf8').digest('hex').slice(0, 24);
  return cid + ':' + (turnId || 'turn') + ':' + digest;
}

function createSendTool(opts: P3394ToolsOpts): AgentTool {
  return {
    name: 'p3394_send',
    description:
      'Send a P3394 task to a registered peer Agent (e.g. hermes) and wait for its reply — ' +
      'agent-to-agent collaboration through the CogSeed P3394 bridge. Use this when the user ' +
      'asks you to talk to, delegate to, or check with another Agent. ' +
      'peer: the registered peer agent id, alias, or a capability (e.g. hermes, or ' +
      'contract.clause-risk-review to pick the best local-first peer declaring it). ' +
      'message: the task or question text for that Agent. ' +
      'files: optional absolute paths of workspace/attachment files to send along (documents, images…). ' +
      'goal: optional collaboration goal (a short phrase). The SAME conversation + peer + goal reuses ' +
      'one P3394 session (multi-turn continuity); a different goal opens a separate session (goal isolation). ' +
      "The reply is the peer's answer text; report it back to the user verbatim. " +
      'If the call fails (peer not registered or unreachable), do NOT retry blindly — tell the ' +
      'user in plain language that the other Agent needs the P3394 gateway, which is BUNDLED ' +
      'with CogSeed (no NPM needed): run `command -v p3394-gateway` on that machine, or use the ' +
      'CogSeed bundled copy under …/app.asar.unpacked/p3394-gateway/gateway.cjs (dev repo: ' +
      'p3394-gateway/gateway.cjs) and start it with node; only fall back to ' +
      '"npm install -g @cogseed/p3394-gateway" when neither exists (see the error message for details).',
    inputSchema: {
      type: 'object',
      properties: {
        peer: {
          type: 'string',
          description: 'Registered peer agent id to call (e.g. hermes).',
        },
        message: {
          type: 'string',
          minLength: 1,
          maxLength: 20_000,
          description: 'The task or question text to send to the peer Agent.',
        },
        files: {
          type: 'array',
          maxItems: 3,
          items: { type: 'string' },
          description: 'Optional absolute paths of workspace or attachment files to send with the message (each <= 2MB).',
        },
        goal: {
          type: 'string',
          maxLength: 200,
          description: 'Optional collaboration goal phrase; same goal reuses the session, different goal isolates it.',
        },
      },
      required: ['peer', 'message'],
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const raw = input as { peer?: unknown; message?: unknown; files?: unknown; goal?: unknown };
      const peer = typeof raw.peer === 'string' ? raw.peer.trim() : '';
      const message = typeof raw.message === 'string' ? raw.message.trim() : '';
      const goal = typeof raw.goal === 'string' ? raw.goal.trim().slice(0, 200) : '';
      if (!peer || !message) {
        return errResult('E_P3394_INVALID_INPUT', 'peer and message are required');
      }
      const hub = getP3394OutboundHub();
      if (!hub) {
        return errResult('E_P3394_BRIDGE_UNAVAILABLE', 'P3394 bridge is not running');
      }
      // id / alias / capability → canonical agent_id (capability picks local-first).
      const resolved = resolveP3394Peer(peer);
      if (resolved.ok === false) {
        return errResult('E_P3394_SEND_FAILED', p3394ErrorGuidance(new Error(resolved.error)));
      }
      // Optional attachments: workspace + current conversation attachment dir.
      const filePaths = Array.isArray(raw.files) ? raw.files.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : [];
      let parts: P3394PayloadPart[] = [];
      if (filePaths.length) {
        const allowedRoots: string[] = [];
        if (ctx.workingDir) allowedRoots.push(ctx.workingDir);
        try { allowedRoots.push(attachmentDirForCid(opts.userId, opts.cid)); } catch { /* best effort */ }
        const built = filesToResourceParts(filePaths.map((filePath) => ({ path: filePath })), allowedRoots);
        if (built.ok === false) return errResult('E_P3394_ATTACHMENT', built.error);
        parts = built.parts;
      }
      const envelope = buildP3394OutboundEnvelope(resolved.agent_id, message, sourceKeyFor(opts.cid, opts.turnId, resolved.agent_id, message), {
        // 同一会话与同一对端的多轮协作保持同一个 P3394 session；
        // 提供 goal 时按 goal 隔离（同 goal 复用、异 goal 新会话）。
        scopeKey: opts.cid,
        ...(parts.length ? { parts } : {}),
        ...(goal ? { goal } : {}),
        ...(ctx.workingDir ? { workingDir: ctx.workingDir } : {}),
      });
      // 出站会话绑定到当前对话：对端回复路由回本对话（不新建独立对话）。
      try {
        getP3394BridgeHandle()?.bindSessionCid?.(envelope.session_id, opts.cid);
      } catch { /* binding is best-effort */ }
      // 第三期「渠道即节点」：channel_bridge 节点是进程内虚拟节点（无网络
      // 端点），不走 HTTP dial，直接经 messaging 主动投递并回执。
      const peerRecord = getP3394BridgeHandle()?.registry.list()
        .find((candidate) => candidate.identity.agent_id === resolved.agent_id);
      if (peerRecord?.node_kind === 'channel_bridge') {
        try {
          const { deliverToChannelBridge } = await import('../../features/messaging/channel-bridge');
          const { sendProactive } = await import('../../features/messaging/manager');
          const { getInstanceWithSecret } = await import('../../features/messaging/registry');
          const delivered = await deliverToChannelBridge(
            opts.userId,
            resolved.agent_id,
            envelope,
            sendProactive,
            async (uid2, instanceId) => {
              const loaded = await getInstanceWithSecret(uid2, instanceId);
              const ownerExternalUserId = (loaded?.instance as { ownerExternalUserId?: string } | undefined)?.ownerExternalUserId;
              return ownerExternalUserId ? { recipientId: ownerExternalUserId } : null;
            },
          );
          if (delivered.ok) {
            return { content: JSON.stringify({ status: 'ok', peer: resolved.agent_id, reply: 'channel bridge delivered' }) };
          }
          const deliverFailure = delivered as Extract<typeof delivered, { ok: false }>;
          return errResult('E_P3394_SEND_FAILED', deliverFailure.error);
        } catch (err) {
          return errResult('E_P3394_SEND_FAILED', (err as Error).message);
        }
      }
      try {
        const reply = await hub.sendAndWait(resolved.agent_id, envelope);
        return { content: JSON.stringify({ status: 'ok', peer: resolved.agent_id, reply: reply.text.slice(0, 24_000) }) };
      } catch (err) {
        return errResult('E_P3394_SEND_FAILED', p3394ErrorGuidance(err));
      }
    },
  };
}

function createPeersTool(): AgentTool {
  return {
    name: 'p3394_peers',
    description:
      'List the P3394 peer Agents currently registered in the CogSeed bridge: agent id, ' +
      'display name, declared capabilities, locality, endpoints and online status ' +
      'liveness: a peer is online when it recently sent a hello/heartbeat). Use this to ' +
      'discover who is available for p3394_send (you may pass an id, an alias, or a capability).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(): Promise<ToolResult> {
      const peers = listP3394Peers();
      return { content: JSON.stringify({ status: 'ok', peers }) };
    },
  };
}

function createSessionsTool(opts: P3394ToolsOpts): AgentTool {
  return {
    name: 'p3394_sessions',
    description:
      'List the P3394 sessions opened from THIS conversation: session id, peer, collaboration goal ' +
      'and last-used time. Use it to keep multi-turn work on the right session — the same goal with ' +
      'the same peer reuses one session, different goals stay isolated.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(): Promise<ToolResult> {
      const sessions = listSessions(opts.cid);
      return { content: JSON.stringify({ status: 'ok', sessions }) };
    },
  };
}

export function createP3394Tools(opts: P3394ToolsOpts): AgentTool[] {
  return [createSendTool(opts), createPeersTool(), createSessionsTool(opts)];
}
