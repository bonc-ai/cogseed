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
import type { P3394OutboundReference } from '../cogseed_backend/p3394-host-adapter';
import { p3394ExternalGatewayIdFor, startExternalGateway } from './external-gateways';
import { isP3394LoopbackEndpoint } from './executor';
import { createLogger } from '../../logger';

const log = createLogger('p3394-bridge:gateway-turn');

/** §12 流帧词表（与 outbound-hub 一致）：progress/status/artifact 是过程帧
 *  （process rail），delta 是正文增量（气泡）。此处只做展示文案组装。 */
type P3394TurnStreamKind = 'delta' | 'progress' | 'status' | 'artifact';

interface P3394TurnStreamEvent {
  text: string;
  kind: P3394TurnStreamKind;
  event?: Record<string, unknown>;
}

/** 过程帧（progress/status/artifact）的 process-rail 文案：status/artifact
 *  带 [status]/[artifact] 前缀与结构化数据里的 state/uri 信息（无正文时
 *  也能看到阶段/产物线索）；progress 原文透传。 */
function streamFrameRailText(event: P3394TurnStreamEvent): string {
  if (event.kind === 'progress') return event.text;
  const structured = event.event && typeof event.event === 'object' ? event.event : {};
  const state = typeof structured.state === 'string' && structured.state ? structured.state : '';
  const uri = typeof structured.uri === 'string' && structured.uri ? structured.uri : '';
  const label = event.kind === 'status' ? '[status]' : '[artifact]';
  const pieces = [label, event.text, state, uri].filter((piece) => typeof piece === 'string' && piece.trim());
  return pieces.join(' ');
}

export interface P3394GatewayTurnResult {
  text: string;
  error?: string;
  aborted?: boolean;
  produced?: string[];
  failureKind?: string;
  failureCode?: string;
  infrastructureFailure?: boolean;
  /** Settled-reply metrics from the reply envelope's CLI-reported usage
   *  (payload.metadata.usage — claude gateway runtime) plus local timing.
   *  Absent when the gateway/cli reported no usage (older gateways, CLIs
   *  without usage disclosure). */
  metrics?: {
    startedAt: number;
    firstTokenAt: number | null;
    completedAt: number;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
    };
    model?: string;
  };
}

export interface P3394GatewayTurnInput {
  uid: string;
  cid: string;
  agent: { agent_id: string; name?: string };
  /** CogSeed attempt correlation. It is not exposed to the remote model. */
  executionId?: string;
  cli: string;
  prompt: string;
  /** Working directory to pass to the external agent/gateway (its CLI cwd).
   *  Without this an external agent may fall back to `/` and lose its
   *  project workspace context. */
  workingDir?: string;
  /** Per-task reasoning effort (unified execution entry). Carried in the
   *  envelope's CogSeed-private extensions.execution_prefs; claude (env) and
   *  codex (thread config) gateway runtimes consume it. */
  reasoningEffort?: 'off' | 'low' | 'high';
  /** Per-task model pick (unified execution entry · external-agent control).
   *  Carried in extensions.execution_prefs.model; claude (--model) and codex
   *  (thread/start model) gateway runtimes consume it. */
  model?: string;
  /** G-28 话题隔离：会话级话题标识（当前开放的 KStar 需求 id）。同 goal
   *  复用 P3394 会话、异 goal 开新会话（sessionForGoal）；缺省时保持
   *  (cid, peer) 稳定会话（原行为）。 */
  goal?: string;
  /** T1 引用信封化：本轮消息携带的结构化引用快照，进信封
   *  payload.metadata.references（正文文本已含人类可读版）。 */
  references?: P3394OutboundReference[];
  signal?: AbortSignal;
  /** Positive-integer process id of the external agent's gateway process,
   *  when the transport can surface one. Validated at the bus boundary. */
  onProcessInfo?: (pid: number) => void;
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
    // 区分「未安装」与「网关未起」：二进制缺失（not_found，path 为空）时
    // 直接快速失败——启动网关只会得到 spawn ENOENT / 15s 注册超时。探测
    // 失败但路径存在（version_unknown 等）仍照常尝试，让网关去实测。
    if (!detected || !detected.path) {
      return {
        text: '',
        error: '节点未接入：未在本机检测到 ' + input.cli + ' 命令。请先安装/配置该 CLI 后再试。',
        failureKind: 'runtime',
        failureCode: 'p3394_cli_not_found',
      };
    }
    const started = await startExternalGateway({
      cli: input.cli,
      binPath: detected.path,
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
  // 身份匹配：agent_id 优先；display_name（注册表显示名，远端节点注入时为
  // 用户录入的 label）作为别名兜底——按 label 建 runtime.cli 的智能体卡也
  // 能路由到对应 peer。
  const peer = peers.find((candidate) => candidate.agent_id === nodeId)
    ?? peers.find((candidate) => (candidate.display_name || '').trim() === nodeId);
  // 远端路由（X-4）：peer 带非回环端点（remote-nodes 显式注入的跨机节点，
  // dial_token/expected_identity 均为用户录入）→ 纯出站 turn：不做本机网关
  // 托管/自愈（远端网关不归本机管），错误按远端语义映射
  // （p3394_remote_timeout / p3394_peer_has_no_endpoint）。回环/本地 peer
  // 与查不到 peer 的场景落回既有托管网关 spawn 逻辑（零改动）。
  const isRemotePeerTurn = !!peer
    && (peer.endpoints ?? []).some((endpoint) => !isP3394LoopbackEndpoint(endpoint));
  // 规范路由目标：别名（display_name）命中后必须改按 peer 的 agent_id 出站
  // ——outbound-hub / 入站匹配都按 agent_id 识别，原始别名串会查不到 peer。
  const routeNodeId = peer ? peer.agent_id : nodeId;
  if (!peer || (peer.endpoints ?? []).length === 0) {
    const recoveryError = await recoverGateway();
    if (recoveryError) return recoveryError;
  }

  input.onCoordinatorActivity?.({ kind: 'activity' });
  // G-18：网关进程 pid 数据源——hello 自报进注册表（gateway_pid），turn
  // 开始即喂给内存协调器（正整数，与 bus 边界同一校验）。
  if (typeof peer?.gateway_pid === 'number' && Number.isInteger(peer.gateway_pid) && peer.gateway_pid > 0) {
    input.onProcessInfo?.(peer.gateway_pid);
  }
  input.onProcess?.({
    type: 'progress',
    text: (isRemotePeerTurn ? '正在通过 P3394 与远端节点 ' : '正在通过 P3394 与 ')
      + (input.agent.name || nodeId) + ' 协作…',
  });
  // 信封按需重建：message_id/idempotency_key 每次发送都必须是新的（重试时
  // 复用旧信封会被对端按幂等去重，吞掉本条消息的语义）；session_id 由
  // sessionForGoal(scopeKey=cid, peer, goal) 决定——goal 缺省时 (cid, peer)
  // 稳定复用，goal 变化（话题切换）自动开新会话（G-28）；executionId 入
  // message id 保持逐轮唯一，用户可见的会话连续性不受影响。
  const buildEnvelope = () => buildP3394OutboundEnvelope(routeNodeId, prompt, `${input.cid}:turn:${input.executionId || 'legacy'}:${Date.now().toString(36)}`, {
    scopeKey: input.cid,
    ...(input.goal && input.goal.trim() ? { goal: input.goal.trim() } : {}),
    ...(input.references && input.references.length ? { references: input.references } : {}),
    ...(input.workingDir ? { workingDir: input.workingDir } : {}),
    ...((input.reasoningEffort || input.model)
      ? { executionPrefs: {
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          ...(input.model ? { model: input.model } : {}),
        } }
      : {}),
  });
  let envelope = buildEnvelope();
  let streamed = false;
  // 同一 (cid, peer, goal) 会复用稳定的 P3394 会话（session-store），outbound
  // hub 同一时刻只允许该会话一条在途信封。若上一条 turn 还没收到回复，本条
  // sendAndWait 会抛 p3394_session_conflict —— 不能立刻判死（用户看到的就是
  // "第二条消息不回复/失败"），应等待上一轮排空后再发。等待上限独立封顶
  // （hub 回复超时是 5 分钟，排队不该让用户空等这么久），且与用户的 abort
  // 联动：取消立即返回，不拖满等待窗口。
  const SESSION_CONFLICT_WAIT_CAP_MS = 60_000;
  // 回合计时/用量：startedAt 在首轮发送前打点；firstTokenAt 以首个 delta 帧
  // 为准（无流式的 CLI 保持 null）；usage 来自回复信封的
  // payload.metadata.usage（CLI 自报，数字字段）。
  const turnStartedAt = Date.now();
  let firstTokenAt: number | null = null;
  const extractReplyMetrics = (completedAt: number, replyEnvelope: unknown) => {
    const meta = (replyEnvelope as { payload?: { metadata?: { usage?: Record<string, unknown>; model?: unknown } } } | undefined)
      ?.payload?.metadata;
    const raw = meta?.usage;
    const usageIn = (raw && typeof raw === 'object') ? raw : undefined;
    const usage: NonNullable<NonNullable<P3394GatewayTurnResult['metrics']>>['usage'] = {};
    if (typeof usageIn?.input === 'number') usage.inputTokens = usageIn.input;
    if (typeof usageIn?.output === 'number') usage.outputTokens = usageIn.output;
    if (typeof usageIn?.cacheRead === 'number') usage.cacheReadTokens = usageIn.cacheRead;
    if (typeof usageIn?.cacheCreate === 'number') usage.cacheWriteTokens = usageIn.cacheCreate;
    if (typeof usageIn?.costUsd === 'number') usage.costUsd = usageIn.costUsd;
    const model = (typeof usageIn?.model === 'string' && usageIn.model) || (typeof meta?.model === 'string' ? meta.model : '');
    const hasUsage = Object.keys(usage).length > 0;
    return {
      startedAt: turnStartedAt,
      firstTokenAt,
      completedAt,
      ...(hasUsage ? { usage } : {}),
      ...(model ? { model } : {}),
    };
  };
  const send = async (): Promise<{ text: string; replyEnvelope?: unknown }> => {
    let waited = false;
    for (;;) {
      if (input.signal?.aborted) {
        const abortError = new Error('p3394_aborted');
        (abortError as Error & { aborted?: boolean }).aborted = true;
        throw abortError;
      }
      try {
        const reply = await hub.sendAndWait(routeNodeId, envelope, (event) => {
          if (input.signal?.aborted) return;
          // 过程帧（§12 词表 progress/status/artifact：openclaw 的
          // [skills]/[tools] 过程日志、claude 的工具调用/思考结构化事件、
          // 阶段切换/产物通报）→ process rail；不置 streamed，正文仍由终态
          // 回复一次性落地。status/artifact 文案带前缀与 state/uri 信息。
          if (event.kind === 'progress' || event.kind === 'status' || event.kind === 'artifact') {
            input.onProcess?.({
              type: 'progress',
              text: streamFrameRailText(event),
              ...(event.event ? { event: event.event } : {}),
            });
            return;
          }
          if (firstTokenAt === null) firstTokenAt = Date.now();
          streamed = true;
          input.onProcess?.({ type: 'delta', text: event.text });
        });
        return { text: reply.text.trim(), replyEnvelope: reply.envelope };
      } catch (firstError) {
        const message = firstError instanceof Error ? firstError.message : String(firstError);
        if (message === 'p3394_session_conflict' && !waited) {
          // 上一条同会话 turn 仍在途：提示用户正在排队，等其排空后重发。
          waited = true;
          input.onProcess?.({ type: 'progress', text: '上一轮对话尚未完成，正在等待后继续…' });
          const drained = await hub.waitForSessionFree(envelope.session_id, SESSION_CONFLICT_WAIT_CAP_MS, input.signal);
          if (input.signal?.aborted) {
            const abortError = new Error('p3394_aborted');
            (abortError as Error & { aborted?: boolean }).aborted = true;
            throw abortError;
          }
          if (!drained) throw firstError; // 上一轮一直未回（达到上限）→ 按原冲突处理
          envelope = buildEnvelope(); // 重发前换新信封（幂等键/消息 id 全新）
          continue;
        }
        throw firstError;
      }
    }
  };
  try {
    let result: { text: string; replyEnvelope?: unknown };
    try {
      result = await send();
    } catch (firstError) {
      const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
      const recoverable = /ECONNREFUSED|ECONNRESET|EPIPE|p3394_(?:manifest|send)_(?:timeout|failed)|p3394_manifest_http_5/.test(firstMessage);
      // 远端 peer（非回环端点）不做本机网关自愈：远端网关进程不归本机托管，
      // recoverGateway 的 spawn 逻辑只会误起一个本机 CLI 实例。错误直接透传
      // 并按远端语义映射失败码。
      if (!recoverable || !presetNodeId || isRemotePeerTurn) throw firstError;
      const recoveryError = await recoverGateway();
      if (recoveryError) return recoveryError;
      envelope = buildEnvelope(); // 网关重启后重发：换新信封，避免旧幂等键
      result = await send();
    }
    // Legacy/oneshot gateways have no stream frames; preserve their original
    // one-shot rendering. A streaming gateway already emitted every chunk,
    // so sending the full body as another delta would duplicate the reply.
    if (!streamed) input.onProcess?.({ type: 'delta', text: result.text });
    input.onProcess?.({ type: 'final', text: result.text });
    return { text: result.text, metrics: extractReplyMetrics(Date.now(), result.replyEnvelope) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('P3394 gateway turn failed', { cli: input.cli, nodeId, error: message });
    if (input.signal?.aborted) return { text: '', aborted: true };
    // 失败码分类：远端 peer 用远端语义（回复超时=远端无响应、无端点=对端
    // 未注册端点）；本地路径保持既有词表，兼容上层重试/文案逻辑。
    let failureCode = 'p3394_send_failed';
    if (isRemotePeerTurn) {
      if (message.includes('p3394_reply_timeout')) failureCode = 'p3394_remote_timeout';
      else if (message.includes('p3394_peer_has_no_endpoint')) failureCode = 'p3394_peer_has_no_endpoint';
      else if (message.includes('p3394_peer_not_registered')) failureCode = 'p3394_peer_not_registered';
    } else if (message.includes('p3394_reply_timeout')) {
      failureCode = 'p3394_reply_timeout';
    }
    return {
      text: '',
      error: message,
      failureKind: 'runtime',
      failureCode,
      infrastructureFailure: true,
    };
  }
}
