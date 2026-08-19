import { createInterface } from 'node:readline';

import {
  COGSEED_AGENT_RUNTIME_PROTOCOL_VERSION,
  type RuntimeEventEnvelope,
  type RuntimeHostToolResult,
  type RuntimeRunRequest,
} from './protocol';
import {
  createDefaultNativeRuntimeExecutor,
  type RuntimeExecutor,
} from './runtime-executor';
import { createRuntimeHostToolClient } from './kernel/tools/host-tools';

export type { RuntimeExecutor } from './runtime-executor';

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function* echoExecutor(request: RuntimeRunRequest, opts: { signal?: AbortSignal | null } = {}): AsyncIterable<RuntimeEventEnvelope> {
  if (opts.signal?.aborted) {
    yield { type: 'error', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'cancelled', error: 'cancelled' };
    return;
  }
  yield { type: 'event', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'started', text: 'started' };
  yield { type: 'result', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'completed', text: request.task };
}


function createHostSmokeExecutor(hostToolClient: ReturnType<typeof createRuntimeHostToolClient>): RuntimeExecutor {
  return async function* hostSmoke(request, opts = {}) {
    yield { type: 'event', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'started', text: 'started' };
    const parsed = JSON.parse(request.task) as { hostTools?: Array<{ name: any; input?: Record<string, unknown> }> };
    const results: Array<{ name: string; content: string }> = [];
    for (const item of parsed.hostTools ?? []) {
      const result = await hostToolClient.call({ requestId: request.request_id, runtimeSessionId: request.runtime_session_id, name: item.name, input: item.input ?? {}, signal: opts.signal });
      if (result.isError) {
        yield { type: 'error', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: opts.signal?.aborted ? 'cancelled' : 'failed', error: result.content };
        return;
      }
      results.push({ name: item.name, content: result.content });
    }
    yield { type: 'result', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'completed', text: JSON.stringify(results) };
  };
}

/** Production always selects the CogSeed Native executor. The echo path is test-only. */
export function selectRuntimeExecutor(deps: {
  env?: Record<string, string | undefined>;
  nativeExecutor?: RuntimeExecutor;
  echo?: RuntimeExecutor;
} = {}): RuntimeExecutor {
  const env = deps.env ?? process.env;
  if (env.COGSEED_COGSEED_RUNTIME_TEST_ECHO === '1') return deps.echo ?? echoExecutor;
  return deps.nativeExecutor ?? createDefaultNativeRuntimeExecutor();
}

export async function runRuntimeWorker(executor?: RuntimeExecutor): Promise<void> {
  const hostToolClient = createRuntimeHostToolClient(write);
  const selectedExecutor = executor ?? (process.env.COGSEED_COGSEED_RUNTIME_TEST_HOST_ECHO === '1'
    ? createHostSmokeExecutor(hostToolClient)
    : selectRuntimeExecutor({ nativeExecutor: createDefaultNativeRuntimeExecutor({ hostToolClient }) }));
  const rl = createInterface({ input: process.stdin });
  const controllers = new Map<string, AbortController>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: any;
    try { msg = JSON.parse(line); }
    catch { continue; }
    if (msg.type === 'host_tool_result') {
      hostToolClient.resolve(msg as RuntimeHostToolResult);
      continue;
    }
    if (msg.type === 'hello') {
      write({ type: 'hello', protocol_version: COGSEED_AGENT_RUNTIME_PROTOCOL_VERSION, capabilities: ['run', 'cancel', 'health', 'shutdown', 'cogseed-host-tools-v1'] });
      continue;
    }
    if (msg.type === 'health') {
      write({ type: 'event', request_id: msg.request_id || 'health', runtime_session_id: '', status: 'running', text: 'ok' });
      continue;
    }
    if (msg.type === 'shutdown') break;
    if (msg.type === 'cancel') {
      controllers.get(msg.request_id)?.abort();
      continue;
    }
    if (msg.type !== 'run') continue;
    const req = msg as RuntimeRunRequest;
    if (req.protocol_version !== COGSEED_AGENT_RUNTIME_PROTOCOL_VERSION) {
      write({ type: 'error', request_id: req.request_id, runtime_session_id: req.runtime_session_id, status: 'failed', error: 'protocol version mismatch' });
      continue;
    }
    const controller = new AbortController();
    controllers.set(req.request_id, controller);
    void (async () => {
      try {
        for await (const event of selectedExecutor(req, { signal: controller.signal })) write(event);
      } catch (err) {
        write({ type: 'error', request_id: req.request_id, runtime_session_id: req.runtime_session_id, status: controller.signal.aborted ? 'cancelled' : 'failed', error: (err as Error).message || String(err) });
      } finally {
        controllers.delete(req.request_id);
      }
    })();
  }
  hostToolClient.rejectAll(new Error('CogSeed Runtime worker stopped'));
}
