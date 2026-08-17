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

import { getP3394OutboundHub, listP3394Peers, resolveP3394Peer } from '../../features/p3394_bridge/app-wiring';
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

/** P3394 自举接入指南（内嵌，引导时直接输出——不依赖外部包是否发布）。 */
const P3394_BOOTSTRAP_GUIDE = [
  'P3394 接入指南（把它发给对方智能体，它能自行接入）：',
  '1) 本机 CLI 智能体（Claude Code / Codex / 自研 CLI 等）：先检查本机是否已有',
  '   P3394 网关（CogSeed 自带/已装），按顺序，有就直接用、不要从 NPM 拉：',
  '   a) 已全局安装过：先跑 command -v p3394-gateway，有输出就直接用 p3394-gateway 启动；',
  '   b) CogSeed 自带副本（CogSeed 桌面版内置此包，无需 NPM）：找 gateway.cjs——',
  '      开发仓库在 <仓库根>/p3394-gateway/gateway.cjs；已安装的 macOS 应用在',
  '      /Applications/CogSeed*.app/Contents/Resources/app.asar.unpacked/p3394-gateway/gateway.cjs',
  '      （Windows: <安装目录>/resources/app.asar.unpacked/p3394-gateway/gateway.cjs）。',
  '      找到后 node <该路径> 启动即等同于装了包；',
  '   c) 以上都没有才：npm install -g @cogseed/p3394-gateway（包发布中；失败就回退 b 用 CogSeed 自带副本）。',
  '   启动参数：预设 P3394_AGENT=hermes/claude/codex/opencode/gemini/aider，',
  '   自研 CLI 用 P3394_AGENT_CLI 与 P3394_AGENT_CLI_ARGS 自定义，',
  '   用 P3394_AGENT_ALIAS 自报显示名（CogSeed 对话里就显示这个名字）；',
  '   网关启动时会自动向 CogSeed 发 hello 注册（自报地址），注册完我就能主动调用它；',
  '   支持附件传递（resource part）与会话连续性；自研 Agent 可另用 P3394_AGENT_MODE=sscli 接 JSONL 会话协议；',
  '2) 云端/网页智能体（如 ChatGPT，有网络工具）：无需安装，',
  '   用 HTTP 直接 POST 信封到 http://127.0.0.1:8444/p3394/envelope',
  '   （Authorization: Bearer <CogSeed token>，信封格式：message_id、session_id、',
  '   kind=message、performative=request、sender.agent_id（+ 可选 sender.alias',
  '   自报显示名）、recipients=[cogseed]、',
  '   payload.parts=[{type:text,text:消息}]、idempotency_key）；',
  '3) 自研智能体：用上面的信封格式写最小客户端代码（Python 十余行）即可入网。',
].join('\n');

/** 把底层错误翻译成带安装引导的可读信息（首次协作引导）。 */
function p3394ErrorGuidance(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const setup = '对方尚未接入 P3394。' + P3394_BOOTSTRAP_GUIDE;
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
      });
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
      'display name, declared capabilities, locality, endpoints and online status (ECS ' +
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
