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
      /** 思考 token（DSH 口径单列；claude 的 thinking_tokens）。 */
      reasoningTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
      /** 输出为按实际文本的实测估算（CLI 无精确输出数；claude 的 result
       *  与 assistant 帧自报均不可用）——渲染层对 ↓/速度加 ≈ 前缀。 */
      measured?: boolean;
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
  const peer = peers.find((candidate) => candidate.agent_id === nodeId);
  if (!peer || peer.endpoints.length === 0) {
    const recoveryError = await recoverGateway();
    if (recoveryError) return recoveryError;
  }

  input.onCoordinatorActivity?.({ kind: 'activity' });
  input.onProcess?.({ type: 'progress', text: '正在通过 P3394 与 ' + (input.agent.name || nodeId) + ' 协作…' });
  // 信封按需重建：message_id/idempotency_key 每次发送都必须是新的（重试时
  // 复用旧信封会被对端按幂等去重，吞掉本条消息的语义）；session_id 由
  // sessionForGoal(scopeKey=cid, peer) 决定，天然保持稳定，用户可见的会话
  // 连续性不受影响。
  const buildEnvelope = () => buildP3394OutboundEnvelope(nodeId, prompt, `${input.cid}:turn:${input.executionId || 'legacy'}:${Date.now().toString(36)}`, {
    scopeKey: input.cid,
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
    if (typeof usageIn?.reasoning === 'number') usage.reasoningTokens = usageIn.reasoning;
    if (typeof usageIn?.cacheRead === 'number') usage.cacheReadTokens = usageIn.cacheRead;
    if (typeof usageIn?.cacheCreate === 'number') usage.cacheWriteTokens = usageIn.cacheCreate;
    if (typeof usageIn?.costUsd === 'number') usage.costUsd = usageIn.costUsd;
    // 实测口径标记（CLI 无精确输出数时的按文本估算）——渲染层对带此
    // 标记的 ↓/速度加 ≈ 前缀，与账单精确值明确区分。
    if (usageIn?.measured === true) usage.measured = true;
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
        const reply = await hub.sendAndWait(nodeId, envelope, (event) => {
          if (input.signal?.aborted) return;
          // progress 帧（openclaw 的 [skills]/[tools] 过程日志、claude 的
          // 工具调用/思考结构化事件等）→ process rail；不置 streamed，正文
          // 仍由终态回复一次性落地。
          if (event.kind === 'progress') {
            // 生成窗口的起点：思考（stream:'item'）与工具调用（'tool'）都是
            // 模型在逐 token 产出的活动——首 token 打点必须覆盖它们，否则
            // 分子含思考而分母（首文本→终态）不含思考时段，速度虚高。
            const structured = (event as { event?: { stream?: unknown } }).event;
            if (firstTokenAt === null && structured && (structured.stream === 'item' || structured.stream === 'tool')) {
              firstTokenAt = Date.now();
            }
            input.onProcess?.({
              type: 'progress',
              text: event.text,
              ...((event as { event?: unknown }).event
                ? { event: (event as { event: unknown }).event }
                : {}),
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
      if (!recoverable || !presetNodeId) throw firstError;
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
    return {
      text: '',
      error: message,
      failureKind: 'runtime',
      failureCode: message.includes('p3394_reply_timeout') ? 'p3394_reply_timeout' : 'p3394_send_failed',
      infrastructureFailure: true,
    };
  }
}
