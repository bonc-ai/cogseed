import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { MateAgentRuntimeFacade } from '../../../../src/main/features/cogseed_runtime';
import type { RuntimeEventEnvelope } from '../../../../src/main/features/cogseed_runtime/protocol';

const USER = 'mate-controller-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-runtime-controller-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();

});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function eventually(assertion: () => Promise<void> | void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

function runtimeFrom(events: RuntimeEventEnvelope[]): MateAgentRuntimeFacade & { inputs: unknown[] } {
  const inputs: unknown[] = [];
  return {
    inputs,
    async *run(_userId: string, input: unknown) {
      inputs.push(input);
      for (const event of events) yield event;
    },
    async shutdown() {},
  } as MateAgentRuntimeFacade & { inputs: unknown[] };
}

describe('CogSeed Runtime controller', () => {
  it('projects persisted Runtime lifecycle events back to the original Group Chat conversation', async () => {
    const runtime = runtimeFrom([
      { type: 'event', request_id: 'req-projection', runtime_session_id: 'mruntime-projection', status: 'running', text: 'working' },
      { type: 'event', request_id: 'req-projection', runtime_session_id: 'mruntime-projection', status: 'running', metadata: { kernel_event: 'tool_call', name: 'read_file' } },
      { type: 'event', request_id: 'req-projection', runtime_session_id: 'mruntime-projection', status: 'running', metadata: { kernel_event: 'tool_result', name: 'read_file', isError: false } },
      { type: 'result', request_id: 'req-projection', runtime_session_id: 'mruntime-projection', status: 'completed', text: 'projected answer' },
    ]);
    const projected: any[] = [];
    const { createMateRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createMateRuntimeController({
      runtime,
      projectTaskEvent: vi.fn(async (input) => { projected.push(input); }),
    } as any);

    await controller.startMateTask(USER, {
      requestId: 'req-projection',
      task: 'Project this run.',
      conversationId: 'cid-projection',
      agentId: 'agent-projection',
    });

    await eventually(() => {
      expect(projected.map((item) => item.event.type)).toEqual([
        'task.started',
        'model.delta',
        'tool.started',
        'tool.finished',
        'task.completed',
      ]);
    });
    expect(projected.at(-1)).toMatchObject({
      conversationId: 'cid-projection',
      agentId: 'agent-projection',
      event: { payload: { text: 'projected answer' } },
    });
  });

  it('routes local-cli tasks through the Backend adapter without invoking native Runtime', async () => {
    const runtime = runtimeFrom([]);
    const localCliAdapter = {
      async *run(input: any) {
        yield { type: 'event', request_id: input.requestId, runtime_session_id: input.runtimeSessionId, status: 'running', text: 'cli working' };
        yield { type: 'result', request_id: input.requestId, runtime_session_id: input.runtimeSessionId, status: 'completed', text: 'cli done' };
      },
    };
    const { createMateRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createMateRuntimeController({ runtime, localCliAdapter } as any);

    const task = await controller.startMateTask(USER, {
      requestId: 'req-cli-controller',
      task: 'Run the CLI Agent.',
      conversationId: 'cid-cli-controller',
      agentId: 'agent-cli-controller',
      executionKind: 'local-cli',
      localCli: { cli: 'claude' },
    } as any);

    await eventually(async () => {
      await expect(tasks.readMateTask(USER, task.taskId)).resolves.toMatchObject({ status: 'completed' });
    });
    expect(runtime.inputs).toEqual([]);
  });

  it('keeps Agent identity separate from the optional model profile', async () => {
    const runtime = runtimeFrom([
      { type: 'result', request_id: 'req-agent-identity', runtime_session_id: 'mruntime-agent-identity', status: 'completed', text: 'done' },
    ]);
    const { createMateRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createMateRuntimeController({ runtime });

    await controller.startMateTask(USER, {
      requestId: 'req-agent-identity',
      task: 'Use the formal Agent identity.',
      agentId: 'agent-identity',
    });

    await eventually(() => {
      expect(runtime.inputs).toEqual([expect.objectContaining({ agent_id: 'agent-identity' })]);
      expect(runtime.inputs[0]).not.toHaveProperty('model_profile');
    });
  });

  it('returns a running task immediately, consumes Runtime events in the background, and never re-runs a duplicate request', async () => {
    const runtime = runtimeFrom([
      { type: 'event', request_id: 'req-controller', runtime_session_id: 'mruntime-controller', status: 'started' },
      { type: 'event', request_id: 'req-controller', runtime_session_id: 'mruntime-controller', status: 'running', text: 'thinking' },
      { type: 'event', request_id: 'req-controller', runtime_session_id: 'mruntime-controller', status: 'running', metadata: { kernel_event: 'tool_call', name: 'read_file' } },
      { type: 'result', request_id: 'req-controller', runtime_session_id: 'mruntime-controller', status: 'completed', text: 'final answer' },
    ]);
    const { createMateRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createMateRuntimeController({ runtime });

    const first = await controller.startMateTask(USER, {
      requestId: 'req-controller',
      task: 'Read the file.',
      agentId: 'agent-controller',
      profileId: 'openai-compatible:mate',
    });
    const duplicate = await controller.startMateTask(USER, {
      requestId: 'req-controller',
      task: 'This must not execute again.',
    });

    expect(first.status).toBe('running');
    expect(duplicate.taskId).toBe(first.taskId);
    expect(runtime.inputs).toEqual([expect.objectContaining({
      task: 'Read the file.',
      agent_id: 'agent-controller',
      model_profile: 'openai-compatible:mate',
    })]);

    await eventually(async () => {
      await expect(tasks.readMateTask(USER, first.taskId)).resolves.toMatchObject({ status: 'completed' });
    });
    await expect(events.readMateTaskEvents(USER, first.taskId, 0, 20)).resolves.toEqual([
      expect.objectContaining({ type: 'task.created' }),
      expect.objectContaining({ type: 'task.queued' }),
      expect.objectContaining({ type: 'task.started' }),
      expect.objectContaining({ type: 'model.delta', payload: { text: 'thinking' } }),
      expect.objectContaining({ type: 'tool.started', payload: { name: 'read_file' } }),
      expect.objectContaining({ type: 'task.completed', payload: { outputChars: 12 } }),
    ]);
  });

  it('cancels a background task through its own AbortController without fallback or retry', async () => {
    let signalSeen: AbortSignal | null = null;
    const runtime: MateAgentRuntimeFacade = {
      async *run(_userId, _input, opts) {
        signalSeen = opts?.signal ?? null;
        await new Promise<void>((resolve) => signalSeen?.addEventListener('abort', () => resolve(), { once: true }));
        yield { type: 'error', request_id: 'req-cancel', runtime_session_id: 'mruntime-cancel', status: 'cancelled', error: 'cancelled' };
      },
      async shutdown() {},
    };
    const { createMateRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const controller = createMateRuntimeController({ runtime });

    const task = await controller.startMateTask(USER, { requestId: 'req-cancel', task: 'Wait until cancelled.' });
    await eventually(() => expect(signalSeen).not.toBeNull());
    const cancelled = await controller.cancelMateTask(USER, task.taskId);

    expect(cancelled.status).toBe('cancelled');
    expect(signalSeen?.aborted).toBe(true);
    await eventually(async () => {
      await expect(events.readMateTaskEvents(USER, task.taskId, 0, 20)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'task.cancelled' }),
      ]));
    });
  });

  it('cancels every non-terminal Backend task for a conversation without touching other conversations', async () => {
    const signals = new Map<string, AbortSignal>();
    const runtime: MateAgentRuntimeFacade = {
      async *run(_userId, input, opts) {
        signals.set(String((input as any).request_id), opts?.signal as AbortSignal);
        await new Promise<void>((resolve) => opts?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        yield { type: 'error', request_id: String((input as any).request_id), runtime_session_id: String((input as any).runtime_session_id), status: 'cancelled', error: 'cancelled' };
      },
      async shutdown() {},
    };
    const { createMateRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createMateRuntimeController({ runtime, projectTaskEvent: vi.fn(async () => {}) });
    const first = await controller.startMateTask(USER, { requestId: 'req-cancel-cid-a', task: 'A', conversationId: 'cid-cancel-all', agentId: 'agent-a' });
    const second = await controller.startMateTask(USER, { requestId: 'req-cancel-cid-b', task: 'B', conversationId: 'cid-cancel-all', agentId: 'agent-b' });
    const other = await controller.startMateTask(USER, { requestId: 'req-cancel-other', task: 'Other', conversationId: 'cid-other', agentId: 'agent-c' });

    const cancelled = await controller.cancelConversationTasks(USER, 'cid-cancel-all');

    expect(cancelled.map((task) => task.taskId).sort()).toEqual([first.taskId, second.taskId].sort());
    await expect(tasks.readMateTask(USER, first.taskId)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(tasks.readMateTask(USER, second.taskId)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(tasks.readMateTask(USER, other.taskId)).resolves.toMatchObject({ status: 'running' });
    expect(signals.get('req-cancel-cid-a')?.aborted).toBe(true);
    expect(signals.get('req-cancel-cid-b')?.aborted).toBe(true);
    expect(signals.get('req-cancel-other')?.aborted).toBe(false);
    await controller.cancelMateTask(USER, other.taskId);
  });
  it('schedules an explicit retry as a new CogSeed task after a worker failure', async () => {
    let runs = 0;
    const runtime: MateAgentRuntimeFacade & { inputs: unknown[] } = {
      inputs: [],
      async *run(_userId, input) {
        this.inputs.push(input);
        runs += 1;
        if (runs === 1) throw new Error('worker crashed');
        yield { type: 'result', request_id: 'req-retry', runtime_session_id: 'mruntime-retry', status: 'completed', text: 'retried' };
      },
      async shutdown() {},
    };
    const { createMateRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createMateRuntimeController({ runtime });

    const original = await controller.startMateTask(USER, { requestId: 'req-original', task: 'Run once.' });
    await eventually(async () => expect(await tasks.readMateTask(USER, original.taskId)).toMatchObject({ status: 'recoverable' }));

    const retried = await controller.retryMateTask(USER, original.taskId, 'req-retry');
    expect(retried).toMatchObject({ status: 'running', retryOfTaskId: original.taskId, requestId: 'req-retry' });
    await eventually(async () => expect(await tasks.readMateTask(USER, retried.taskId)).toMatchObject({ status: 'completed' }));
    expect(runtime.inputs).toHaveLength(2);
    expect(runtime.inputs[1]).toMatchObject({ task: 'Run once.' });
  });

  it('resumes a recoverable task only with an explicit continuation and keeps the CogSeed runtime session', async () => {
    let runs = 0;
    const runtime: MateAgentRuntimeFacade & { inputs: unknown[] } = {
      inputs: [],
      async *run(_userId, input) {
        this.inputs.push(input);
        runs += 1;
        if (runs === 1) throw new Error('worker crashed');
        yield { type: 'result', request_id: 'req-resume', runtime_session_id: 'mruntime-resume', status: 'completed', text: 'continued' };
      },
      async shutdown() {},
    };
    const { createMateRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createMateRuntimeController({ runtime });

    const original = await controller.startMateTask(USER, { requestId: 'req-resume-original', task: 'Original prompt must not be replayed.' });
    await eventually(async () => expect(await tasks.readMateTask(USER, original.taskId)).toMatchObject({ status: 'recoverable' }));

    const resumed = await controller.resumeMateTask(USER, original.taskId, {
      requestId: 'req-resume',
      continuation: 'Continue from the persisted runtime state.',
    });
    expect(resumed).toMatchObject({ taskId: original.taskId, status: 'running' });
    await eventually(async () => expect(await tasks.readMateTask(USER, original.taskId)).toMatchObject({ status: 'completed' }));
    expect(runtime.inputs[1]).toMatchObject({
      task: 'Continue from the persisted runtime state.',
      request_id: 'req-resume',
      runtime_session_id: original.runtimeSessionId,
    });
    expect((runtime.inputs[1] as { task: string }).task).not.toContain('Original prompt');
  });

  it('reports independent CogSeed runtime status and can restart its worker service', async () => {
    const shutdown = vi.fn(async () => undefined);
    const runtime = runtimeFrom([]);
    runtime.shutdown = shutdown;
    const { createMateRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createMateRuntimeController({ runtime });

    await expect(controller.runtimeStatus()).resolves.toMatchObject({ activeTaskCount: 0, backend: 'mate' });
    await expect(controller.restartRuntime()).resolves.toEqual({ restarted: true });
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

});
