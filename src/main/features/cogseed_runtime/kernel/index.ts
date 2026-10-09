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
    })
    : null;
  return {
    run: runner ? runner.run : unsupportedNativeRun,
    async cancel(_requestId: string): Promise<void> {},
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
