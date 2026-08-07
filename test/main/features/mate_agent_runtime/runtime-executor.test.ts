import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

import * as paths from '../../../../src/main/paths';
import { MATE_RUNTIME_TOOL_POLICY } from '../../../../src/main/features/mate_agent_runtime/kernel/config';
import {
  kernelEventToRuntimeEnvelope,
  runtimeKernelRequestFromProtocol,
  type RuntimeExecutor,
} from '../../../../src/main/features/mate_agent_runtime/runtime-executor';
import { MATE_AGENT_RUNTIME_PROTOCOL_VERSION, type RuntimeRunRequest } from '../../../../src/main/features/mate_agent_runtime/protocol';

const UID = 'runtime-executor-user';

function request(overrides: Partial<RuntimeRunRequest> = {}): RuntimeRunRequest {
  return {
    protocol_version: MATE_AGENT_RUNTIME_PROTOCOL_VERSION,
    type: 'run',
    request_id: 'req-executor',
    runtime_session_id: 'mruntime-executor',
    user_id: UID,
    task: 'Execute through selected runtime.',
    context: [],
    attachments: [],
    read_only_roots: [],
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function executor(label: string, seen: string[]): RuntimeExecutor {
  return async function* (req: RuntimeRunRequest) {
    seen.push(label);
    yield { type: 'result' as const, request_id: req.request_id, runtime_session_id: req.runtime_session_id, status: 'completed' as const, text: label };
  };
}

afterEach(() => {
  fs.rmSync(paths.userRoot(UID), { recursive: true, force: true });
});

describe('Mate Agent Runtime native executor', () => {
  it('keeps native executor request mapping independent from any Core selection config', async () => {
    const kernelRequest = runtimeKernelRequestFromProtocol(request({
      agent_id: 'agent-a',
      model_profile: 'profile-a',
      working_dir: paths.userLocalRoot(UID),
      read_only_roots: [paths.userLocalRoot(UID)],
    }));

    expect(kernelRequest).toEqual(expect.objectContaining({
      userId: UID,
      requestId: 'req-executor',
      runtimeSessionId: 'mruntime-executor',
      task: 'Execute through selected runtime.',
      agentId: 'agent-a',
      modelProfile: 'profile-a',
      workingDir: paths.userLocalRoot(UID),
      readOnlyRoots: [paths.userLocalRoot(UID)],
      writableRoots: [],
      toolPolicy: MATE_RUNTIME_TOOL_POLICY,
    }));
    expect(JSON.stringify(kernelRequest)).not.toContain('cid');
  });

  it('maps native kernel events to the stable Runtime protocol envelopes', () => {
    expect(kernelEventToRuntimeEnvelope({ type: 'started', requestId: 'req-executor', runtimeSessionId: 'mruntime-executor' }))
      .toEqual({ type: 'event', request_id: 'req-executor', runtime_session_id: 'mruntime-executor', status: 'started' });
    expect(kernelEventToRuntimeEnvelope({ type: 'model_delta', requestId: 'req-executor', runtimeSessionId: 'mruntime-executor', text: 'hi' }))
      .toEqual({ type: 'event', request_id: 'req-executor', runtime_session_id: 'mruntime-executor', status: 'running', text: 'hi' });
    expect(kernelEventToRuntimeEnvelope({ type: 'tool_call', requestId: 'req-executor', runtimeSessionId: 'mruntime-executor', metadata: { name: 'read_file' } }))
      .toEqual({ type: 'event', request_id: 'req-executor', runtime_session_id: 'mruntime-executor', status: 'running', metadata: { kernel_event: 'tool_call', name: 'read_file' } });
    expect(kernelEventToRuntimeEnvelope({ type: 'result', requestId: 'req-executor', runtimeSessionId: 'mruntime-executor', text: 'done' }))
      .toEqual({ type: 'result', request_id: 'req-executor', runtime_session_id: 'mruntime-executor', status: 'completed', text: 'done' });
    expect(kernelEventToRuntimeEnvelope({ type: 'cancelled', requestId: 'req-executor', runtimeSessionId: 'mruntime-executor' }))
      .toEqual({ type: 'error', request_id: 'req-executor', runtime_session_id: 'mruntime-executor', status: 'cancelled', error: 'cancelled' });
  });
});
