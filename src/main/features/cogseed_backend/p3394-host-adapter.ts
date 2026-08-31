/**
 * CogSeed Runtime host-tool adapter for P3394 agent interop (outbound).
 *
 * The CogSeed agent itself collaborates through this adapter: p3394_send
 * builds a P3394 envelope, delivers it to a registered peer's endpoint via
 * the outbound hub, and waits for the peer's reply — which comes back through
 * the inbound bridge and is matched by session id. The host router already
 * verified the Commander p3394.interop capability before dispatching here.
 */

import { createLogger } from '../../logger';
import { genId12 } from '../../storage';
import { getP3394BridgeInfo, getP3394OutboundHub, resolveP3394Peer } from '../p3394_bridge/app-wiring';
import { sessionForGoal } from '../p3394_bridge/session-store';
import { filesToResourceParts } from '../p3394_bridge/artifact-parts';
import type { P3394Envelope, P3394PayloadPart } from '../p3394_bridge/envelope';

const log = createLogger('p3394-host-adapter');

export interface P3394HostToolContext {
  userId: string;
  /** Stable per-(request, call) key so a replayed host call never sends twice. */
  sourceKey: string;
  /** Workspace roots the caller may attach files from (path-sandbox gate). */
  allowedRoots?: string[];
  /** Current validated Runtime working directory. */
  workingDir?: string;
  signal?: AbortSignal | null;
}

/** Shared envelope builder — used by both the host-tool path and the
 *  core-agent (daily conversation) path of p3394_send. Carries the reply
 *  endpoint + token in extensions so the peer's gateway can answer back
 *  with zero configuration.
 *
 *  Session id is STABLE per (scope, peer): multi-turn collaboration with the
 *  same peer in the same conversation keeps one P3394 session (guide §5.2).
 *  `scopeKey` = conversation id on the conversation path, user id on the
 *  host-tool path. */
export function buildP3394OutboundEnvelope(
  peer: string,
  message: string,
  sourceKey: string,
  opts: { scopeKey?: string; parts?: P3394PayloadPart[]; goal?: string; workingDir?: string; executionPrefs?: { reasoningEffort?: 'off' | 'low' | 'high' } } = {},): P3394Envelope {
  // Goal 自动隔离（指南 §5.3）：同 (scope, peer) 同 Goal 复用会话，不同 Goal 开新会话。
  const sessionId = sessionForGoal(opts.scopeKey ?? peer, peer, opts.goal);
  // 约定（S-04 关联 id 脱敏前提）：P3394 的 message/session/task id 一律由
  // 无信息量随机值生成（genId12 / 前缀拼接），**禁止把任何 secret/token 编进
  // 这些 id**——审计/KSTAR 会"先掩码后还原"关联 id，id 内含秘密会绕过脱敏。
  const messageId = `msg-${genId12()}`;
  const bridgeInfo = getP3394BridgeInfo();
  return {
    spec_version: 'p3394/1.0',
    message_id: messageId,
    session_id: sessionId,
    task_id: `tsk-${messageId}`,
    kind: 'task',
    performative: 'request',
    role: 'requester',
    sender: { agent_id: 'cogseed', alias: 'CogSeed', channel_instance_id: 'cogseed-app', delegation: [] },
    recipients: [{ agent_id: peer }],
    payload: {
      parts: [{ type: 'text', text: message.slice(0, 20_000) }, ...(opts.parts ?? [])],
      ...(opts.goal && opts.goal.trim() ? { metadata: { goal: opts.goal.trim().slice(0, 200) } } : {}),
    },
    idempotency_key: `${sourceKey}:${messageId}`,
    // 外接 agent 需要知道它在哪个工作区执行（否则 WorkBuddy/Codex 会退到
    // 根目录 `/`）。透传到 extensions，让 peer 的 gateway 注入其 CLI 的 cwd。
    extensions: {
      ...(bridgeInfo
        ? {
            reply_endpoint: bridgeInfo.endpoint,
            reply_token: bridgeInfo.token,
          }
        : {}),
      ...(opts.workingDir && opts.workingDir.trim()
        ? { working_dir: opts.workingDir.trim() }
        : {}),
      // CogSeed 私有扩展（对端旧版忽略未知 extension 字段，向后兼容）：
      // 单轮执行偏好。仅 claude 网关 runtime 消费 reasoning_effort。
      ...(opts.executionPrefs?.reasoningEffort
        ? { execution_prefs: { reasoning_effort: opts.executionPrefs.reasoningEffort } }
        : {}),
    },
  };
}

export async function runP3394HostTool(
  input: Record<string, unknown>,
  context: P3394HostToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const peer = typeof input.peer === 'string' ? input.peer.trim() : '';
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  const goal = typeof input.goal === 'string' ? input.goal.trim().slice(0, 200) : '';
  if (!peer || !message) {
    return { content: JSON.stringify({ status: 'error', code: 'E_P3394_INVALID_INPUT', message: 'peer and message are required' }), isError: true };
  }
  const hub = getP3394OutboundHub();
  if (!hub) {
    return { content: JSON.stringify({ status: 'error', code: 'E_P3394_BRIDGE_UNAVAILABLE', message: 'P3394 bridge is not running' }), isError: true };
  }

  // id / alias / capability → canonical agent_id (capability picks local-first).
  const resolved = resolveP3394Peer(peer);
  if (resolved.ok === false) {
    return { content: JSON.stringify({ status: 'error', code: 'E_P3394_SEND_FAILED', message: resolved.error }), isError: true };
  }

  const filePaths = Array.isArray(input.files)
    ? input.files.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  let parts: P3394PayloadPart[] = [];
  if (filePaths.length) {
    if (!context.allowedRoots || context.allowedRoots.length === 0) {
      return { content: JSON.stringify({ status: 'error', code: 'E_P3394_ATTACHMENT', message: 'no workspace roots available for file attachments' }), isError: true };
    }
    const built = filesToResourceParts(filePaths.map((filePath) => ({ path: filePath })), context.allowedRoots);
    if (built.ok === false) {
      return { content: JSON.stringify({ status: 'error', code: 'E_P3394_ATTACHMENT', message: built.error }), isError: true };
    }
    parts = built.parts;
  }

  const envelope: P3394Envelope = buildP3394OutboundEnvelope(resolved.agent_id, message, context.sourceKey, {
    scopeKey: context.userId,
    ...(parts.length ? { parts } : {}),
    ...(goal ? { goal } : {}),
    ...(context.workingDir ? { workingDir: context.workingDir } : {}),
  });

  try {
    const reply = await hub.sendAndWait(resolved.agent_id, envelope);
    return { content: JSON.stringify({ status: 'ok', peer: resolved.agent_id, reply: reply.text.slice(0, 24_000) }) };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    log.warn('P3394 outbound send failed', { peer, error: messageText });
    return { content: JSON.stringify({ status: 'error', code: 'E_P3394_SEND_FAILED', message: messageText }), isError: true };
  }
}
