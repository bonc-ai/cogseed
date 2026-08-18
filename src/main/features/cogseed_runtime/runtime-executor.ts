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
    task: request.task,
    context: request.context,
    attachments: request.attachments,
    readOnlyRoots: request.read_only_roots ?? [],
    writableRoots: request.writable_roots ?? [],
    toolPolicy: allowedSkillIds.length
      ? { ...COGSEED_RUNTIME_TOOL_POLICY, skillRun: 'allowlisted_skills' }
      : COGSEED_RUNTIME_TOOL_POLICY,
    capabilities: request.capabilities ?? [],
    executionKind: 'cogseed-native',
    allowedSkillIds,
    skillVersionPins: request.skill_version_pins ?? [],
    ...(request.agent_id ? { agentId: request.agent_id } : {}),
    ...(request.model_profile ? { modelProfile: request.model_profile } : {}),
    ...(request.working_dir ? { workingDir: request.working_dir } : {}),
  };
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
    return {
      type: 'event',
      ...base,
      status: 'running',
      ...(event.text ? { text: event.text } : {}),
      metadata: { kernel_event: event.type, ...(event.metadata ?? {}) },
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
      maxToolRounds: deps.maxToolRounds ?? DEFAULT_RUNTIME_KERNEL_CONFIG.maxToolRounds,
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
      allowedRoots: request.readOnlyRoots,
      writableRoots: request.writableRoots,
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
    maxToolRounds: DEFAULT_RUNTIME_KERNEL_CONFIG.maxToolRounds,
  });
}
