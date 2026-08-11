import { genId12, nowIso } from '../../storage';
import { createLogger } from '../../logger';
import { getWorkspacePath } from '../user_workspace';
import { captureRuntimeKstarClosure, type RuntimeKstarClosureInput } from '../kstar/task-closure';
import { defaultRuntimeWorkerService, type RuntimeWorkerService } from './worker-process';
import {
  normalizeRuntimeRunRequest,
  type RuntimeEventEnvelope,
  type RuntimeRunRequest,
} from './protocol';
import {
  appendRuntimeRunEvent,
  writeRuntimeRunMeta,
} from './store';



function clipped(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Keep KSTAR input to bounded execution facts; the full runtime event log remains separate. */
function kstarEventFact(event: RuntimeEventEnvelope): RuntimeEventEnvelope | null {
  if (event.type === 'result') {
    return {
      type: 'result', request_id: event.request_id, runtime_session_id: event.runtime_session_id, status: event.status,
      ...(clipped(event.text, 4_000) ? { text: clipped(event.text, 4_000) } : {}),
      ...(typeof event.metadata?.code === 'string' ? { metadata: { code: event.metadata.code } } : {}),
    };
  }
  if (event.type === 'error') {
    return {
      type: 'error', request_id: event.request_id, runtime_session_id: event.runtime_session_id, status: event.status,
      ...(typeof event.metadata?.code === 'string' ? { metadata: { code: event.metadata.code } } : {}),
    };
  }
  const metadata = event.metadata || {};
  if (metadata.kernel_event !== 'tool_call' && metadata.kernel_event !== 'tool_result') return null;
  const safeMetadata: Record<string, unknown> = {
    kernel_event: metadata.kernel_event,
    ...(typeof metadata.id === 'string' ? { id: metadata.id } : {}),
    ...(typeof metadata.name === 'string' ? { name: clipped(metadata.name, 120) } : {}),
  };
  if (metadata.kernel_event === 'tool_call') {
    const args = metadata.arguments;
    safeMetadata.arguments = args && typeof args === 'object' && !Array.isArray(args)
      ? Object.keys(args as Record<string, unknown>).sort()
      : [];
  } else if (typeof metadata.isError === 'boolean') {
    safeMetadata.isError = metadata.isError;
  }
  return {
    type: 'event', request_id: event.request_id, runtime_session_id: event.runtime_session_id, status: event.status,
    metadata: safeMetadata,
  };
}

export interface MateAgentRuntimeInput {
  task: string;
  request_id?: string;
  runtime_session_id?: string;
  context?: unknown[];
  attachments?: unknown[];
  agent_id?: string;
  model_profile?: string;
  working_dir?: string;
  /** Main-process-derived capability grants (Commander-only tools). */
  capabilities?: string[];
}

export interface RuntimeResultProjector {
  (uid: string, event: RuntimeEventEnvelope, request: RuntimeRunRequest): void | Promise<void>;
}

export interface MateAgentRuntimeOptions {
  worker?: RuntimeWorkerService;
  allowedRootsForUser?: (uid: string) => readonly string[];
  projectResult?: RuntimeResultProjector;
  captureClosure?: (input: RuntimeKstarClosureInput) => Promise<unknown>;
}

export interface MateAgentRuntimeFacade {
  run(uid: string, raw: MateAgentRuntimeInput, opts?: { signal?: AbortSignal | null }): AsyncGenerator<RuntimeEventEnvelope, void, unknown>;
  shutdown(): Promise<void>;
}

export function createMateAgentRuntime(options: MateAgentRuntimeOptions = {}): MateAgentRuntimeFacade {
  const worker = options.worker || defaultRuntimeWorkerService;
  const allowedRootsForUser = options.allowedRootsForUser || ((uid: string) => {
    try { const root = getWorkspacePath(uid); return root ? [root] : []; }
    catch { return []; }
  });
  const projectResult = options.projectResult;
  const captureClosure = options.captureClosure || captureRuntimeKstarClosure;
  const log = createLogger('cogseed-runtime');

  async function* run(uid: string, raw: MateAgentRuntimeInput, opts: { signal?: AbortSignal | null } = {}): AsyncGenerator<RuntimeEventEnvelope, void, unknown> {
    const normalized = normalizeRuntimeRunRequest(uid, raw, { allowedRoots: allowedRootsForUser(uid) });
    if (normalized.ok === false) throw new Error(normalized.error);
    const request = normalized.request;
    const runId = `run_${genId12()}`;
    const createdAt = nowIso();
    await writeRuntimeRunMeta(uid, runId, {
      run_id: runId,
      request_id: request.request_id,
      runtime_session_id: request.runtime_session_id,
      status: 'running',
      created_at: createdAt,
    });
    const capturedEvents: RuntimeEventEnvelope[] = [];
    let terminalCaptured = false;
    const captureTerminal = async (): Promise<void> => {
      if (terminalCaptured || !capturedEvents.some((event) => event.type === 'result' || event.type === 'error')) return;
      terminalCaptured = true;
      try {
        await captureClosure({ userId: uid, runId, request, events: capturedEvents });
      } catch (error) {
        // KSTAR is a learning/observability side effect; it must not change task delivery.
        log.warn('kstar runtime capture failed', {
          userId: uid,
          runId,
          requestId: request.request_id,
          errorCode: 'runtime_capture_failed',
        });
      }
    };
    try {
      for await (const event of worker.run(request, { signal: opts.signal || null })) {
        const projectedEvent: RuntimeEventEnvelope = {
          ...event,
          metadata: { ...(event.metadata ?? {}), runtime_run_id: runId },
        };
        const fact = kstarEventFact(projectedEvent);
        if (fact) capturedEvents.push(fact);
        await appendRuntimeRunEvent(uid, runId, projectedEvent);
        yield projectedEvent;
        if (projectedEvent.type === 'result' || projectedEvent.type === 'error') {
          const terminalStatus = projectedEvent.status === 'completed'
            ? 'completed'
            : projectedEvent.status === 'cancelled'
              ? 'cancelled'
              : 'failed';
          await writeRuntimeRunMeta(uid, runId, {
            run_id: runId,
            request_id: request.request_id,
            runtime_session_id: request.runtime_session_id,
            status: terminalStatus,
            created_at: createdAt,
            updated_at: nowIso(),
            ...(projectedEvent.error ? { error: projectedEvent.error } : {}),
          });
          // KSTAR is explicitly best-effort: do not hold result delivery on its disk/Recall work.
          void captureTerminal();
          if (projectedEvent.type === 'result' && projectedEvent.status === 'completed') {
            await projectResult?.(uid, projectedEvent, request);
          }
        }
      }
    } catch (err) {
      await writeRuntimeRunMeta(uid, runId, {
        run_id: runId,
        request_id: request.request_id,
        runtime_session_id: request.runtime_session_id,
        status: 'failed',
        created_at: createdAt,
        updated_at: nowIso(),
        error: (err as Error).message || String(err),
      });
      if (!terminalCaptured) {
        capturedEvents.push({
          type: 'error',
          request_id: request.request_id,
          runtime_session_id: request.runtime_session_id,
          status: 'failed',
          metadata: { code: 'runtime_worker_failed' },
        });
        void captureTerminal();
      }
      throw err;
    }
  }

  return { run, shutdown: () => worker.shutdown() };
}

export const mateAgentRuntime = createMateAgentRuntime();
export const runMateAgentRuntime = mateAgentRuntime.run;
