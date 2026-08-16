/**
 * P3394 external-agent turn runner (group-chat dispatch path).
 *
 * Agents created through the agent-modal 「外接」tab carry
 * runtime.kind === 'p3394-gateway'. Their turns go through the bridge
 * outbound hub to the managed p3394-gateway node — the SAME protocol
 * path any external Agent uses, so one implementation covers Hermes,
 * Claude Code, Codex, OpenClaw, WorkBuddy and user-built agents.
 */

import { detectOne } from '../local_agents/registry.js';
import { getP3394OutboundHub } from './app-wiring';
import { buildP3394OutboundEnvelope } from '../cogseed_backend/p3394-host-adapter';
import { p3394ExternalGatewayIdFor, startExternalGateway } from './external-gateways';
import { createLogger } from '../../logger';

const log = createLogger('p3394-bridge:gateway-turn');

export interface P3394GatewayTurnResult {
  text: string;
  error?: string;
  aborted?: boolean;
  produced?: string[];
  failureKind?: string;
  failureCode?: string;
  infrastructureFailure?: boolean;
}

export interface P3394GatewayTurnInput {
  uid: string;
  cid: string;
  agent: { agent_id: string; name?: string };
  cli: string;
  prompt: string;
  signal?: AbortSignal;
  onCoordinatorActivity?: (event: { kind: string }) => void;
  onProcess?: (data: Record<string, unknown>) => void;
}

/**
 * Runs one conversation turn against the agent's P3394 gateway node.
 * Auto-starts the managed gateway when the node is offline (self-heal).
 */
export async function runP3394GatewayTurn(input: P3394GatewayTurnInput): Promise<P3394GatewayTurnResult> {
  // 已知 CLI → 预设节点 id；未知（自研网关自报的 agent_id）→ 直接用该 id
  // （注册表里存在即视为可协作节点）。
  const presetNodeId = p3394ExternalGatewayIdFor(input.cli);
  const nodeId = presetNodeId ?? String(input.cli || '').trim();
  if (!nodeId) {
    return { text: '', error: 'p3394_unsupported_cli: ' + input.cli, failureKind: 'runtime', failureCode: 'p3394_unsupported_cli' };
  }
  const hub = getP3394OutboundHub();
  if (!hub) {
    return { text: '', error: 'p3394_bridge_unavailable', failureKind: 'runtime', failureCode: 'p3394_bridge_unavailable' };
  }
  const prompt = String(input.prompt || '').trim();
  if (!prompt) {
    return { text: '', error: 'p3394_empty_prompt' };
  }

  const recoverGateway = async (): Promise<P3394GatewayTurnResult | null> => {
    if (input.signal?.aborted) return { text: '', aborted: true };
    if (!presetNodeId) {
      return {
        text: '',
        error: '节点未接入：' + nodeId + ' 不在线且不是 CogSeed 可自动托管的 CLI。请让对方启动网关（p3394-gateway）后重试。',
        failureKind: 'runtime',
        failureCode: 'p3394_node_offline',
      };
    }
    input.onProcess?.({ type: 'progress', text: '正在唤起 ' + (input.agent.name || nodeId) + ' 的 P3394 网关…' });
    const detected = await detectOne(input.cli as never);
    const started = await startExternalGateway({
      cli: input.cli,
      ...(detected.path ? { binPath: detected.path } : {}),
      ...(input.agent.name ? { alias: input.agent.name } : {}),
    });
    if (started.ok === false) {
      return {
        text: '',
        error: '节点未接入：' + started.error + '。请在 AI 团队 → 新建智能体 → 外接 里重新接入该智能体。',
        failureKind: 'runtime',
        failureCode: 'p3394_gateway_start_failed',
      };
    }
    return null;
  };

  const peers = await import('./app-wiring').then((m) => m.listP3394Peers());
  const peer = peers.find((candidate) => candidate.agent_id === nodeId);
  if (!peer || peer.endpoints.length === 0) {
    const recoveryError = await recoverGateway();
    if (recoveryError) return recoveryError;
  }

  input.onCoordinatorActivity?.({ kind: 'activity' });
  input.onProcess?.({ type: 'progress', text: '正在通过 P3394 与 ' + (input.agent.name || nodeId) + ' 协作…' });
  const envelope = buildP3394OutboundEnvelope(nodeId, prompt, input.cid + ':turn:' + Date.now().toString(36), {
    scopeKey: input.cid,
  });
  const send = async (): Promise<{ text: string }> => {
    const reply = await hub.sendAndWait(nodeId, envelope);
    return { text: reply.text.trim() };
  };
  try {
    let result: { text: string };
    try {
      result = await send();
    } catch (firstError) {
      const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
      const recoverable = /ECONNREFUSED|ECONNRESET|EPIPE|p3394_(?:manifest|send)_(?:timeout|failed)|p3394_manifest_http_5/.test(firstMessage);
      if (!recoverable || !presetNodeId) throw firstError;
      const recoveryError = await recoverGateway();
      if (recoveryError) return recoveryError;
      result = await send();
    }
    input.onProcess?.({ type: 'delta', text: result.text });
    input.onProcess?.({ type: 'final', text: result.text });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('P3394 gateway turn failed', { cli: input.cli, nodeId, error: message });
    if (input.signal?.aborted) return { text: '', aborted: true };
    return {
      text: '',
      error: message,
      failureKind: 'runtime',
      failureCode: message.includes('p3394_reply_timeout') ? 'p3394_reply_timeout' : 'p3394_send_failed',
      infrastructureFailure: true,
    };
  }
}
