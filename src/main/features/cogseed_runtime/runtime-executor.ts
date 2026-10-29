import { PC_ROOT } from '../../paths';
import { createCogSeedRuntimeProvider } from '../cogseed_backend/model-provider';
import { cogseedConnectorManager } from '../cogseed_backend/connector-manager';
import { cogseedKbManager } from '../cogseed_backend/cogseed-kb-store';
import { DEFAULT_RUNTIME_KERNEL_CONFIG, COGSEED_RUNTIME_TOOL_POLICY } from './kernel/config';
import { createCogSeedAgentKernel, type CogSeedAgentKernel, type CogSeedAgentKernelDeps } from './kernel';
import type { RuntimeKernelEvent, RuntimeKernelRequest } from './kernel/types';
import {
  createRuntimeModelAdapter,
  type RuntimeModelAdapter,
  type RuntimeModelProvider,
} from './kernel/model-adapter';
import { createRuntimeToolRunner, type RuntimeToolRunner } from './kernel/tools/runner';
import type { RuntimeHostToolClient } from './kernel/tools/host-tools';
import type { RuntimeEventEnvelope, RuntimeRunRequest } from './protocol';

export type RuntimeExecutor = (request: RuntimeRunRequest, opts?: { signal?: AbortSignal | null }) => AsyncIterable<RuntimeEventEnvelope>;
export const LIGHT_RUNTIME_MAX_TOOL_ROUNDS = 24;

export interface NativeRuntimeExecutorDeps {
  modelAdapter?: RuntimeModelAdapter;
  provider?: RuntimeModelProvider;
  toolRunnerFactory?: (request: RuntimeKernelRequest) => RuntimeToolRunner;
  kernelFactory?: (deps: CogSeedAgentKernelDeps) => CogSeedAgentKernel;
  maxToolRounds?: number;
  hostToolClient?: RuntimeHostToolClient;
}

export function runtimeKernelRequestFromProtocol(request: RuntimeRunRequest): RuntimeKernelRequest {
  const allowedSkillIds = request.allowed_skill_ids ?? [];
  return {
    userId: request.user_id,
    requestId: request.request_id,
    runtimeSessionId: request.runtime_session_id,
    ...(request.trace_id ? { traceId: request.trace_id } : {}),
    task: request.task,
    context: request.context,
    attachments: request.attachments,
    readOnlyRoots: request.read_only_roots ?? [],
    writableRoots: request.writable_roots ?? [],
    // 策略由主进程随请求下发（会话权限模式 + 工作区推导）；缺省仍是 deny-all。
    // skillRun 维持既有语义：仅当该 Agent 带 skill 白名单时升级。
    toolPolicy: (() => {
      const base = request.tool_policy ?? COGSEED_RUNTIME_TOOL_POLICY;
      return allowedSkillIds.length ? { ...base, skillRun: 'allowlisted_skills' } : base;
    })(),
    capabilities: request.capabilities ?? [],
    executionKind: 'cogseed-native',
    allowedSkillIds,
    skillVersionPins: request.skill_version_pins ?? [],
    ...(request.agent_id ? { agentId: request.agent_id } : {}),
    ...(request.model_profile ? { modelProfile: request.model_profile } : {}),
    ...(request.workspace_root || request.working_dir
      ? { workingDir: request.workspace_root || request.working_dir, workspaceRoot: request.workspace_root || request.working_dir }
      : {}),
  };
}

export function maxToolRoundsForRuntimeRequest(request: RuntimeRunRequest): number {
  if (request.execution_kind && request.execution_kind !== 'cogseed-native') return DEFAULT_RUNTIME_KERNEL_CONFIG.maxToolRounds;
  if (request.agent_id) return DEFAULT_RUNTIME_KERNEL_CONFIG.maxToolRounds;
  if ((request.allowed_skill_ids ?? []).length > 0) return DEFAULT_RUNTIME_KERNEL_CONFIG.maxToolRounds;
  if ((request.writable_roots ?? []).length > 0) return DEFAULT_RUNTIME_KERNEL_CONFIG.maxToolRounds;
  if (request.tool_policy?.fileWrite && request.tool_policy.fileWrite !== 'none') return DEFAULT_RUNTIME_KERNEL_CONFIG.maxToolRounds;
  return LIGHT_RUNTIME_MAX_TOOL_ROUNDS;
}

export function kernelEventToRuntimeEnvelope(event: RuntimeKernelEvent): RuntimeEventEnvelope {
  const base = {
    request_id: event.requestId,
    runtime_session_id: event.runtimeSessionId,
  };
  if (event.type === 'started') {
    return { type: 'event', ...base, status: 'started', ...(event.text ? { text: event.text } : {}) };
  }
  if (event.type === 'model_delta') {
    return { type: 'event', ...base, status: 'running', ...(event.text ? { text: event.text } : {}) };
  }
  if (event.type === 'tool_call' || event.type === 'tool_result') {
    const isCall = event.type === 'tool_call';
    const meta = event.metadata ?? {};
    // Two projections of the same tool event, deliberately side by side:
    //   - `metadata.kernel_event` is the kernel-side protocol. Task-event persistence
    //     (cogseed_backend/runtime-controller.ts) and KSTAR episode building
    //     (kstar/episode-builder.ts) read it, and it also carries non-tool kinds such as
    //     `artifact` and `cli_status`. Do not reshape it.
    //   - `event` is the conversation-facing StreamEvent shape that
    //     `group_chat/bus.ts` persists into the process trail and the renderer formats
    //     (`_formatEventLine`), matching what the core-agent path already emits via
    //     `model/core-agent/event-mapper.ts`. Without it the trail mapper sees no
    //     `stream` and drops every tool event, so a kernel run shows no activity at all
    //     while it works. Same tool-event vocabulary, whichever runtime produced it.
    const streamData: Record<string, unknown> = {
      phase: isCall ? 'start' : 'end',
      ...(typeof meta.id === 'string' ? { id: meta.id } : {}),
      ...(typeof meta.name === 'string' ? { name: meta.name } : {}),
      ...(isCall
        ? (meta.arguments != null ? { arguments: meta.arguments } : {})
        : { isError: meta.isError === true }),
    };
    // Tool output can be tens of KB and the trail is capped at 300 items per turn, so the
    // result travels as a bounded one-line preview — the same rule
    // `model/core-agent/event-mapper.ts` applies on the core-agent path. The full text still
    // reaches the model through the tool-result channel; only the rail is trimmed.
    if (!isCall && event.text) {
      const oneLine = event.text.replace(/\s+/g, ' ').trim();
      if (oneLine) streamData.result_preview = oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
    }
    return {
      type: 'event',
      ...base,
      status: 'running',
      ...(event.text ? { text: event.text } : {}),
      metadata: { kernel_event: event.type, ...meta },
      event: { stream: 'tool', data: streamData },
    };
  }
  if (event.type === 'result') {
    return { type: 'result', ...base, status: 'completed', text: event.text ?? '' };
  }
  if (event.type === 'cancelled') {
    return { type: 'error', ...base, status: 'cancelled', error: event.error || 'cancelled', ...(event.metadata ? { metadata: event.metadata } : {}) };
  }
  return { type: 'error', ...base, status: 'failed', error: event.error || 'runtime native kernel error', ...(event.metadata ? { metadata: event.metadata } : {}) };
}

export function createNativeRuntimeExecutor(deps: NativeRuntimeExecutorDeps = {}): RuntimeExecutor {
  const kernelFactory = deps.kernelFactory ?? createCogSeedAgentKernel;
  return async function* runNativeRuntimeRequest(request: RuntimeRunRequest, opts: { signal?: AbortSignal | null } = {}) {
    const kernelRequest = runtimeKernelRequestFromProtocol(request);
    const toolRunner = deps.toolRunnerFactory?.(kernelRequest);
    const kernel = kernelFactory({
      ...(deps.modelAdapter ? { modelAdapter: deps.modelAdapter } : {}),
      ...(toolRunner ? { toolRunner } : {}),
      maxToolRounds: deps.maxToolRounds ?? maxToolRoundsForRuntimeRequest(request),
    });
    for await (const event of kernel.run(kernelRequest, opts)) {
      yield kernelEventToRuntimeEnvelope(event);
    }
  };
}

export function createDefaultNativeRuntimeExecutor(
  deps: Pick<NativeRuntimeExecutorDeps, 'modelAdapter' | 'provider' | 'kernelFactory' | 'hostToolClient'> = {},
): RuntimeExecutor {
  const modelAdapter = deps.modelAdapter ?? createRuntimeModelAdapter({
    provider: deps.provider ?? createCogSeedRuntimeProvider(),
  });
  return createNativeRuntimeExecutor({
    modelAdapter,
    ...(deps.kernelFactory ? { kernelFactory: deps.kernelFactory } : {}),
    toolRunnerFactory: (request) => createRuntimeToolRunner({
      userId: request.userId,
      runtimeSessionId: request.runtimeSessionId,
      requestId: request.requestId,
      ...(request.agentId ? { agentId: request.agentId } : {}),
      allowedRoots: request.readOnlyRoots,
      writableRoots: request.writableRoots,
      ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {}),
      pcDir: PC_ROOT,
      toolPolicy: request.toolPolicy,
      capabilities: request.capabilities,
      allowedSkillIds: request.allowedSkillIds,
      skillVersionPins: request.skillVersionPins,
      connectorManager: cogseedConnectorManager,
      kbManager: cogseedKbManager,
      ...(deps.hostToolClient ? { hostToolClient: deps.hostToolClient } : {}),
      maxInlineToolResultTokens: DEFAULT_RUNTIME_KERNEL_CONFIG.maxInlineToolResultChars,
    }),
  });
}
