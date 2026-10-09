import { nowIso } from '../../../storage';
import { DEFAULT_RUNTIME_KERNEL_CONFIG } from './config';
import { createNativeRuntimeSession, appendNativeSessionRecord } from './session-store';
import { runRuntimeExecutionLoop, type RuntimeExecutionLoopDeps } from './execution-loop';
import type { RuntimeKernelEvent, RuntimeKernelRequest, RuntimeKernelRunOptions } from './types';

export interface RuntimeSessionRunnerDeps extends RuntimeExecutionLoopDeps {}

export interface RuntimeSessionRunner {
  run(request: RuntimeKernelRequest, options?: RuntimeKernelRunOptions): AsyncIterable<RuntimeKernelEvent>;
}

export function createRuntimeSessionRunner(deps: RuntimeSessionRunnerDeps): RuntimeSessionRunner {
  return {
    async *run(request: RuntimeKernelRequest, options: RuntimeKernelRunOptions = {}): AsyncGenerator<RuntimeKernelEvent, void, unknown> {
      if (options.signal?.aborted) {
        yield { type: 'cancelled', requestId: request.requestId, runtimeSessionId: request.runtimeSessionId, metadata: { code: 'aborted' } };
        return;
      }
      await createNativeRuntimeSession(request.userId, request.runtimeSessionId, nowIso());
      yield* runRuntimeExecutionLoop(request, {
        ...deps,
        maxToolRounds: deps.maxToolRounds ?? DEFAULT_RUNTIME_KERNEL_CONFIG.maxToolRounds,
      }, {
        signal: options.signal ?? null,
        onRecord: async (role, content) => {
          await appendNativeSessionRecord(request.userId, request.runtimeSessionId, {
            type: 'turn',
            request_id: request.requestId,
            role,
            content,
            created_at: nowIso(),
          });
        },
      });
    },
  };
}
