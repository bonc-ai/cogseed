import type {
  RuntimeKernelEvent,
  RuntimeKernelRequest,
  RuntimeKernelRunOptions,
  RuntimeKernelSessionSummary,
} from './types';
import { readNativeRuntimeSession } from './session-store';
import { createRuntimeSessionRunner, type RuntimeSessionRunnerDeps } from './session-runner';

export interface CogSeedAgentKernel {
  run(request: RuntimeKernelRequest, options?: RuntimeKernelRunOptions): AsyncIterable<RuntimeKernelEvent>;
  cancel(requestId: string): Promise<void>;
  getSession(userId: string, runtimeSessionId: string): Promise<RuntimeKernelSessionSummary>;
}

export interface CogSeedAgentKernelDeps extends Partial<RuntimeSessionRunnerDeps> {}

async function* unsupportedNativeRun(request: RuntimeKernelRequest): AsyncIterable<RuntimeKernelEvent> {
  yield {
    type: 'error',
    requestId: request.requestId,
    runtimeSessionId: request.runtimeSessionId,
    error: 'native kernel execution loop is not implemented in Phase 1',
    metadata: { code: 'native_kernel_not_ready' },
  };
}

export function createCogSeedAgentKernel(deps: CogSeedAgentKernelDeps = {}): CogSeedAgentKernel {
  const runner = deps.modelAdapter && deps.toolRunner
    ? createRuntimeSessionRunner({
      modelAdapter: deps.modelAdapter,
      toolRunner: deps.toolRunner,
      maxToolRounds: deps.maxToolRounds,
      ...(deps.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: deps.maxParallelToolCalls } : {}),
      ...(deps.toolTimeoutMs !== undefined ? { toolTimeoutMs: deps.toolTimeoutMs } : {}),
      ...(deps.toolHistoryBudget !== undefined ? { toolHistoryBudget: deps.toolHistoryBudget } : {}),
    })
    : null;
  const active = new Map<string, AbortController>();
  return {
    async *run(request, options = {}) {
      if (!runner) { yield* unsupportedNativeRun(request); return; }
      if (active.has(request.requestId)) throw new Error('runtime request already running');
      const controller = new AbortController();
      active.set(request.requestId, controller);
      try {
        yield* runner.run(request, { ...options, signal: options.signal
          ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
      } finally { active.delete(request.requestId); }
    },
    async cancel(requestId: string): Promise<void> { active.get(requestId)?.abort(); },
    async getSession(userId: string, runtimeSessionId: string): Promise<RuntimeKernelSessionSummary> {
      const session = await readNativeRuntimeSession(userId, runtimeSessionId);
      const lastTurn = [...session.records]
        .reverse()
        .find((record): record is Extract<typeof record, { request_id: string }> => 'request_id' in record && typeof record.request_id === 'string');
      return {
        runtimeSessionId,
        version: session.header.version,
        kernel: session.header.kernel,
        recordCount: session.records.length,
        ...(lastTurn ? { lastRequestId: lastTurn.request_id } : {}),
      };
    },
  };
}
