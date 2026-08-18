import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { MateAgentRuntimeFacade } from '../../../../src/main/features/mate_agent_runtime';
import type { RuntimeEventEnvelope } from '../../../../src/main/features/mate_agent_runtime/protocol';

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

describe('Mate Runtime controller', () => {
  it('returns a running task immediately, consumes Runtime events in the background, and never re-runs a duplicate request', async () => {
    const runtime = runtimeFrom([
      { type: 'event', request_id: 'req-controller', runtime_session_id: 'mruntime-controller', status: 'started' },
      { type: 'event', request_id: 'req-controller', runtime_session_id: 'mruntime-controller', status: 'running', text: 'thinking' },
      { type: 'event', request_id: 'req-controller', runtime_session_id: 'mruntime-controller', status: 'running', metadata: { kernel_event: 'tool_call', name: 'read_file' } },
      { type: 'result', request_id: 'req-controller', runtime_session_id: 'mruntime-controller', status: 'completed', text: 'final answer' },
    ]);
    const { createMateRuntimeController } = await import('../../../../src/main/features/mate_agent_backend/runtime-controller');
    const events = await import('../../../../src/main/features/mate_agent_backend/event-store');
    const tasks = await import('../../../../src/main/features/mate_agent_backend/task-store');
    const controller = createMateRuntimeController({ runtime });

    const first = await controller.startMateTask(USER, {
      requestId: 'req-controller',
      task: 'Read the file.',
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
    const { createMateRuntimeController } = await import('../../../../src/main/features/mate_agent_backend/runtime-controller');
    const events = await import('../../../../src/main/features/mate_agent_backend/event-store');
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
  it('schedules an explicit retry as a new Mate task after a worker failure', async () => {
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
    const { createMateRuntimeController } = await import('../../../../src/main/features/mate_agent_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/mate_agent_backend/task-store');
    const controller = createMateRuntimeController({ runtime });

    const original = await controller.startMateTask(USER, { requestId: 'req-original', task: 'Run once.' });
    await eventually(async () => expect(await tasks.readMateTask(USER, original.taskId)).toMatchObject({ status: 'recoverable' }));

    const retried = await controller.retryMateTask(USER, original.taskId, 'req-retry');
    expect(retried).toMatchObject({ status: 'running', retryOfTaskId: original.taskId, requestId: 'req-retry' });
    await eventually(async () => expect(await tasks.readMateTask(USER, retried.taskId)).toMatchObject({ status: 'completed' }));
    expect(runtime.inputs).toHaveLength(2);
    expect(runtime.inputs[1]).toMatchObject({ task: 'Run once.' });
  });

  it('resumes a recoverable task only with an explicit continuation and keeps the Mate runtime session', async () => {
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
    const { createMateRuntimeController } = await import('../../../../src/main/features/mate_agent_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/mate_agent_backend/task-store');
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

  it('reports independent Mate runtime status and can restart its worker service', async () => {
    const shutdown = vi.fn(async () => undefined);
    const runtime = runtimeFrom([]);
    runtime.shutdown = shutdown;
    const { createMateRuntimeController } = await import('../../../../src/main/features/mate_agent_backend/runtime-controller');
    const controller = createMateRuntimeController({ runtime });

    await expect(controller.runtimeStatus()).resolves.toMatchObject({ activeTaskCount: 0, backend: 'mate' });
    await expect(controller.restartRuntime()).resolves.toEqual({ restarted: true });
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('injects confirmed recall assets into the runtime context when a conversation is bound (M-1 / Decision 2)', async () => {
    // Seed a confirmed projection for the conversation, exactly like the
    // recall prompt-injection tests do.
    const [candidates, refs, projection, storage, layout] = await Promise.all([
      import('../../../../src/main/features/recall/candidate-service'),
      import('../../../../src/main/features/recall/workspace-refs'),
      import('../../../../src/main/features/recall/context-projection'),
      import('../../../../src/main/storage'),
      import('../../../../src/main/util/project-layout'),
    ]);
    const candidate = await candidates.saveRecallCandidate(USER, {
      judgment: 'Keep runtime boundaries explicit before changing them.',
      summary: 'Runtime boundary decision log',
      suggestedType: 'rule',
      suggestedScope: 'review,project',
      sourceRefs: [{ kind: 'execution', id: 'exec-m1' }],
    });
    const asset = await candidates.promoteRecallCandidate(USER, candidate.id, { actor: 'user' });
    await refs.addWorkspaceAssetReference(USER, { assetId: asset.asset.id, workspaceId: 'workspace-m1', scope: 'review' });
    const preview = await projection.previewContextProjection(USER, {
      taskRunId: 'task-m1', workspaceId: 'workspace-m1', purpose: 'review',
    });
    const confirmed = await projection.confirmContextProjection(USER, preview.id);
    const messageFile = layout.conversationMessageFile(USER, 'cid-m1');
    fs.mkdirSync(path.dirname(messageFile), { recursive: true });
    await storage.appendJsonlAtomic(messageFile, {
      id: 'msg-m1', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'preview',
      recall_projection_card: { projectionId: confirmed.id },
    });

    const runtime = runtimeFrom([
      { type: 'result', request_id: 'req-asset', runtime_session_id: 'mruntime-asset', status: 'completed', text: 'done' },
    ]);
    const { createMateRuntimeController } = await import('../../../../src/main/features/mate_agent_backend/runtime-controller');
    const controller = createMateRuntimeController({ runtime });

    await controller.startMateTask(USER, {
      requestId: 'req-asset',
      task: 'Apply the remembered rule.',
      conversationId: 'cid-m1',
    });

    await eventually(() => {
      expect(runtime.inputs).toHaveLength(1);
      const context = (runtime.inputs[0] as { context?: Array<{ type: string; content: string }> }).context ?? [];
      const assetItem = context.find((item) => item.type === 'text' && item.content.includes('<confirmed-ability-assets>'));
      expect(assetItem).toBeDefined();
      expect(assetItem!.content).toContain('Runtime boundary decision log');
    });
  });

  it('skips asset injection when no conversation is bound (soft degradation)', async () => {
    const runtime = runtimeFrom([
      { type: 'result', request_id: 'req-noasset', runtime_session_id: 'mruntime-noasset', status: 'completed', text: 'done' },
    ]);
    const { createMateRuntimeController } = await import('../../../../src/main/features/mate_agent_backend/runtime-controller');
    const controller = createMateRuntimeController({ runtime });

    await controller.startMateTask(USER, {
      requestId: 'req-noasset',
      task: 'Run without conversation context.',
    });

    await eventually(() => {
      expect(runtime.inputs).toHaveLength(1);
      const context = (runtime.inputs[0] as { context?: Array<{ type: string; content: string }> }).context ?? [];
      expect(context.some((item) => item.content.includes('<confirmed-ability-assets>'))).toBe(false);
    });
  });

});

