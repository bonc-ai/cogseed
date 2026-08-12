import type {
  RuntimeHostToolCall,
  RuntimeHostToolName,
  RuntimeHostToolResult,
} from '../../protocol';
import type { RuntimeToolResult } from './file-tools';

export interface RuntimeHostToolClient {
  call(input: {
    requestId: string;
    runtimeSessionId: string;
    name: RuntimeHostToolName;
    input: Record<string, unknown>;
    signal?: AbortSignal | null;
  }): Promise<RuntimeToolResult>;
  resolve(result: RuntimeHostToolResult): boolean;
  rejectAll(error: Error): void;
}

export function createRuntimeHostToolClient(write: (message: RuntimeHostToolCall) => void): RuntimeHostToolClient {
  let sequence = 0;
  const pending = new Map<string, {
    resolve: (value: RuntimeToolResult) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal | null;
    onAbort?: () => void;
  }>();

  function settle(callId: string) {
    const item = pending.get(callId);
    if (!item) return undefined;
    pending.delete(callId);
    if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort);
    return item;
  }

  return {
    call(input) {
      if (input.signal?.aborted) return Promise.reject(new Error('Runtime host tool call aborted'));
      const callId = `host-call-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
      return new Promise<RuntimeToolResult>((resolve, reject) => {
        const onAbort = () => {
          const item = settle(callId);
          item?.reject(new Error('Runtime host tool call aborted'));
        };
        pending.set(callId, { resolve, reject, signal: input.signal, onAbort });
        input.signal?.addEventListener('abort', onAbort, { once: true });
        write({
          type: 'host_tool_call',
          request_id: input.requestId,
          runtime_session_id: input.runtimeSessionId,
          call_id: callId,
          name: input.name,
          input: input.input,
        });
      });
    },
    resolve(result) {
      const item = settle(result.call_id);
      if (!item) return false;
      item.resolve({ content: result.content, isError: result.is_error === true });
      return true;
    },
    rejectAll(error) {
      for (const callId of Array.from(pending.keys())) settle(callId)?.reject(error);
    },
  };
}
