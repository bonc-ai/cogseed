import { nowIso } from '../../../storage';
import { DEFAULT_RUNTIME_KERNEL_CONFIG } from './config';
import { createNativeRuntimeSession, appendNativeSessionRecord, readNativeRuntimeSession } from './session-store';
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
      const history = await readNativeRuntimeSession(request.userId, request.runtimeSessionId);
      // Only this actor's native session; never scan chat/SDK history to recover
      // a token. Keep complete recent records, with an explicit bounded window.
      const priorRecords = history.records.filter((row): row is import('./session-store').NativeRuntimeTurnRecord =>
        row.type === 'turn' && row.role !== 'system' && row.request_id !== request.requestId);
      let size = 0;
      const retained = [];
      for (const row of priorRecords.slice(-80).reverse()) {
        const chars = JSON.stringify(row).length;
        if (size + chars > 240_000) break;
        retained.unshift(row); size += chars;
      }
      yield* runRuntimeExecutionLoop(request, {
        ...deps,
        maxToolRounds: deps.maxToolRounds ?? DEFAULT_RUNTIME_KERNEL_CONFIG.maxToolRounds,
      }, {
        signal: options.signal ?? null,
        priorRecords: retained,
        onRecord: async (role, content, tool) => {
          await appendNativeSessionRecord(request.userId, request.runtimeSessionId, {
            type: 'turn',
            request_id: request.requestId,
            role,
            content,
            ...(tool ? { tool } : {}),
            created_at: nowIso(),
          });
        },
      });
    },
  };
}
