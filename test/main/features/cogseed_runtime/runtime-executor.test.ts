import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

import * as paths from '../../../../src/main/paths';
import { COGSEED_RUNTIME_TOOL_POLICY } from '../../../../src/main/features/cogseed_runtime/kernel/config';
import {
  createNativeRuntimeExecutor,
  kernelEventToRuntimeEnvelope,
  LIGHT_RUNTIME_MAX_TOOL_ROUNDS,
  maxToolRoundsForRuntimeRequest,
  runtimeKernelRequestFromProtocol,
  type RuntimeExecutor,
} from '../../../../src/main/features/cogseed_runtime/runtime-executor';
import { COGSEED_AGENT_RUNTIME_PROTOCOL_VERSION, type RuntimeRunRequest } from '../../../../src/main/features/cogseed_runtime/protocol';

const UID = 'runtime-executor-user';

function request(overrides: Partial<RuntimeRunRequest> = {}): RuntimeRunRequest {
  return {
    protocol_version: COGSEED_AGENT_RUNTIME_PROTOCOL_VERSION,
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

describe('CogSeed Runtime native executor', () => {
  it('keeps native executor request mapping independent from any Core selection config', async () => {
    const kernelRequest = runtimeKernelRequestFromProtocol(request({
      agent_id: 'agent-a',
      model_profile: 'profile-a',
      working_dir: paths.userLocalRoot(UID),
      read_only_roots: [paths.userLocalRoot(UID)],
      execution_kind: 'cogseed-native',
      allowed_skill_ids: ['skill-alpha'],
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
      executionKind: 'cogseed-native',
      allowedSkillIds: ['skill-alpha'],
      toolPolicy: { ...COGSEED_RUNTIME_TOOL_POLICY, skillRun: 'allowlisted_skills' },
    }));
    expect(JSON.stringify(kernelRequest)).not.toContain('cid');
  });

  it('maps native kernel events to the stable Runtime protocol envelopes', () => {
    expect(kernelEventToRuntimeEnvelope({ type: 'started', requestId: 'req-executor', runtimeSessionId: 'mruntime-executor' }))
      .toEqual({ type: 'event', request_id: 'req-executor', runtime_session_id: 'mruntime-executor', status: 'started' });
    expect(kernelEventToRuntimeEnvelope({ type: 'model_delta', requestId: 'req-executor', runtimeSessionId: 'mruntime-executor', text: 'hi' }))
      .toEqual({ type: 'event', request_id: 'req-executor', runtime_session_id: 'mruntime-executor', status: 'running', text: 'hi' });
    expect(kernelEventToRuntimeEnvelope({ type: 'tool_call', requestId: 'req-executor', runtimeSessionId: 'mruntime-executor', metadata: { name: 'read_file' } }))
      .toEqual({
        type: 'event',
        request_id: 'req-executor',
        runtime_session_id: 'mruntime-executor',
        status: 'running',
        metadata: { kernel_event: 'tool_call', name: 'read_file' },
        // Conversation-facing projection: group_chat persists a process item only when the
        // event carries `stream`, so the kernel must speak the same tool-event vocabulary the
        // core-agent path already uses. Dropping this field silences the whole run in the UI.
        event: { stream: 'tool', data: { phase: 'start', name: 'read_file' } },
      });
    expect(kernelEventToRuntimeEnvelope({
      type: 'tool_result',
      requestId: 'req-executor',
      runtimeSessionId: 'mruntime-executor',
      text: `line one\n${'x'.repeat(400)}`,
      metadata: { id: 'call-1', name: 'bash', isError: false },
    })).toEqual({
      type: 'event',
      request_id: 'req-executor',
      runtime_session_id: 'mruntime-executor',
      status: 'running',
      text: `line one\n${'x'.repeat(400)}`,
      metadata: { kernel_event: 'tool_result', id: 'call-1', name: 'bash', isError: false },
      event: {
        stream: 'tool',
        data: {
          phase: 'end',
          id: 'call-1',
          name: 'bash',
          isError: false,
          // Collapsed to one line and bounded, so a single large tool result cannot blow up
          // the 300-item process trail.
          result_preview: `${`line one ${'x'.repeat(400)}`.slice(0, 300)}…`,
        },
      },
    });
    expect(kernelEventToRuntimeEnvelope({ type: 'result', requestId: 'req-executor', runtimeSessionId: 'mruntime-executor', text: 'done' }))
      .toEqual({ type: 'result', request_id: 'req-executor', runtime_session_id: 'mruntime-executor', status: 'completed', text: 'done' });
    expect(kernelEventToRuntimeEnvelope({ type: 'cancelled', requestId: 'req-executor', runtimeSessionId: 'mruntime-executor' }))
      .toEqual({ type: 'error', request_id: 'req-executor', runtime_session_id: 'mruntime-executor', status: 'cancelled', error: 'cancelled' });
  });

  it('classifies only simple native user requests as lightweight tool-round work', () => {
    expect(LIGHT_RUNTIME_MAX_TOOL_ROUNDS).toBe(24);
    expect(maxToolRoundsForRuntimeRequest(request())).toBe(24);
    expect(maxToolRoundsForRuntimeRequest(request({ agent_id: 'agent-a' }))).toBe(80);
    expect(maxToolRoundsForRuntimeRequest(request({ allowed_skill_ids: ['skill-a'] }))).toBe(80);
    expect(maxToolRoundsForRuntimeRequest(request({ writable_roots: [paths.userLocalRoot(UID)] }))).toBe(80);
    expect(maxToolRoundsForRuntimeRequest(request({ execution_kind: 'local-cli' }))).toBe(80);
  });

  it('passes the lightweight runtime budget into the native kernel while preserving explicit overrides', async () => {
    const seen: number[] = [];
    const kernelFactory = (deps: any) => ({
      async *run(req: any) {
        seen.push(deps.maxToolRounds);
        yield { type: 'result', requestId: req.requestId, runtimeSessionId: req.runtimeSessionId, text: 'done' };
      },
    });

    const lightExecutor = createNativeRuntimeExecutor({ kernelFactory });
    await collect(lightExecutor(request()));
    const explicitExecutor = createNativeRuntimeExecutor({ kernelFactory, maxToolRounds: 7 });
    await collect(explicitExecutor(request()));

    expect(seen).toEqual([24, 7]);
  });
});
