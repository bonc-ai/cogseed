import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CogSeedAgentRuntimeFacade } from '../../../../src/main/features/cogseed_runtime';
import type { RuntimeEventEnvelope } from '../../../../src/main/features/cogseed_runtime/protocol';

const USER = 'cogseed-controller-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-runtime-controller-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();

});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
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

function runtimeFrom(events: RuntimeEventEnvelope[]): CogSeedAgentRuntimeFacade & { inputs: unknown[] } {
  const inputs: unknown[] = [];
  return {
    inputs,
    async *run(_userId: string, input: unknown) {
      inputs.push(input);
      for (const event of events) yield event;
    },
    async shutdown() {},
  } as CogSeedAgentRuntimeFacade & { inputs: unknown[] };
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
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createCogSeedRuntimeController({
      runtime,
      projectTaskEvent: vi.fn(async (input) => { projected.push(input); }),
    } as any);

    await controller.startCogSeedTask(USER, {
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
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime, localCliAdapter } as any);

    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-cli-controller',
      task: 'Run the CLI Agent.',
      conversationId: 'cid-cli-controller',
      agentId: 'agent-cli-controller',
      executionKind: 'local-cli',
      localCli: { cli: 'claude' },
    } as any);

    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({ status: 'completed' });
    });
    expect(runtime.inputs).toEqual([]);
  });

  it('persists and restores the explicit handoff execution context across retry', async () => {
    let runs = 0;
    const adapterInputs: any[] = [];
    const localCliAdapter = {
      async *run(input: any) {
        adapterInputs.push(input);
        runs += 1;
        if (runs === 1) throw new Error('wake worker crashed');
        yield {
          type: 'result',
          request_id: input.requestId,
          runtime_session_id: input.runtimeSessionId,
          status: 'completed',
          text: 'retried gateway task',
        };
      },
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime: runtimeFrom([]), localCliAdapter } as any);

    const original = await controller.startCogSeedTask(USER, {
      requestId: 'req-wake-context-original',
      task: 'Use the approved handoff context.',
      executionKind: 'local-cli',
      localCli: { cli: 'claude', viaP3394Gateway: true },
      abilityAssetIds: ['asset-approved', 'asset-approved'],
      workingDir: '/tmp/approved-handoff-workspace',
    } as any);

    await eventually(async () => expect(await tasks.readCogSeedTask(USER, original.taskId)).toMatchObject({ status: 'recoverable' }));
    expect(await tasks.readCogSeedTask(USER, original.taskId)).toMatchObject({
      abilityAssetIds: ['asset-approved'],
      workingDir: '/tmp/approved-handoff-workspace',
    });

    const retried = await controller.retryCogSeedTask(USER, original.taskId, 'req-wake-context-retry');
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, retried.taskId)).toMatchObject({ status: 'completed' }));
    expect(adapterInputs).toHaveLength(2);
    expect(adapterInputs[0]).toMatchObject({
      abilityAssetIds: ['asset-approved'],
      workingDir: '/tmp/approved-handoff-workspace',
    });
    expect(adapterInputs[1]).toMatchObject({
      abilityAssetIds: ['asset-approved'],
      workingDir: '/tmp/approved-handoff-workspace',
    });
  });

  it('keeps Agent identity separate from the optional model profile', async () => {
    const runtime = runtimeFrom([
      { type: 'result', request_id: 'req-agent-identity', runtime_session_id: 'mruntime-agent-identity', status: 'completed', text: 'done' },
    ]);
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createCogSeedRuntimeController({ runtime });

    await controller.startCogSeedTask(USER, {
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
      { type: 'event', request_id: 'req-controller', runtime_session_id: 'mruntime-controller', status: 'running', metadata: { kernel_event: 'artifact', uri: 'p3394-object:sha256:abc', digest: 'abc', name: 'report.md', media_type: 'text/markdown', secret: 'must-not-cross' } },
      { type: 'result', request_id: 'req-controller', runtime_session_id: 'mruntime-controller', status: 'completed', text: 'final answer' },
    ]);
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });

    const first = await controller.startCogSeedTask(USER, {
      requestId: 'req-controller',
      task: 'Read the file.',
      agentId: 'agent-controller',
      profileId: 'openai-compatible:cogseed',
    });
    const duplicate = await controller.startCogSeedTask(USER, {
      requestId: 'req-controller',
      task: 'Read the file.',
      agentId: 'agent-controller',
      profileId: 'openai-compatible:cogseed',
    });

    expect(first.status).toBe('running');
    expect(duplicate.taskId).toBe(first.taskId);
    expect(runtime.inputs).toEqual([expect.objectContaining({
      task: 'Read the file.',
      agent_id: 'agent-controller',
      model_profile: 'openai-compatible:cogseed',
    })]);
    await expect(controller.startCogSeedTask(USER, {
      requestId: 'req-controller',
      task: 'This must not execute again.',
    })).rejects.toThrow(/payload conflict/i);

    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, first.taskId)).resolves.toMatchObject({ status: 'completed' });
    });
    await eventually(async () => {
      await expect(events.readCogSeedTaskEvents(USER, first.taskId, 0, 20)).resolves.toEqual([
        expect.objectContaining({ type: 'task.created' }),
        expect.objectContaining({ type: 'task.queued' }),
        expect.objectContaining({ type: 'task.started' }),
        expect.objectContaining({ type: 'model.delta', payload: { text: 'thinking' } }),
        expect.objectContaining({ type: 'tool.started', payload: { name: 'read_file' } }),
        expect.objectContaining({ type: 'artifact', payload: { uri: 'p3394-object:sha256:abc', digest: 'abc', name: 'report.md', media_type: 'text/markdown' } }),
        expect.objectContaining({ type: 'task.completed', payload: { outputChars: 12 } }),
      ]);
    });
  });

  it('cancels a background task through its own AbortController without fallback or retry', async () => {
    let signalSeen: AbortSignal | null = null;
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, _input, opts) {
        signalSeen = opts?.signal ?? null;
        await new Promise<void>((resolve) => signalSeen?.addEventListener('abort', () => resolve(), { once: true }));
        yield { type: 'error', request_id: 'req-cancel', runtime_session_id: 'mruntime-cancel', status: 'cancelled', error: 'cancelled' };
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const events = await import('../../../../src/main/features/cogseed_backend/event-store');
    const controller = createCogSeedRuntimeController({ runtime });

    const task = await controller.startCogSeedTask(USER, { requestId: 'req-cancel', task: 'Wait until cancelled.' });
    await eventually(() => expect(signalSeen).not.toBeNull());
    const cancelled = await controller.cancelCogSeedTask(USER, task.taskId);

    expect(cancelled.status).toBe('cancelled');
    expect(signalSeen?.aborted).toBe(true);
    await eventually(async () => {
      await expect(events.readCogSeedTaskEvents(USER, task.taskId, 0, 20)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'task.cancelled' }),
      ]));
    });
  });

  it('persists a safe runtime failure code for renderer task details', async () => {
    const runtime = runtimeFrom([
      {
        type: 'error',
        request_id: 'req-runtime-failure-code',
        runtime_session_id: 'mruntime-runtime-failure-code',
        status: 'failed',
        error: 'Provider request failed.',
        metadata: { code: 'provider_timeout' },
      },
    ]);
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });

    const task = await controller.startCogSeedTask(USER, {
      requestId: 'req-runtime-failure-code',
      task: 'This private prompt must not become the renderer title.',
    });

    await eventually(async () => {
      await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
        status: 'failed',
        errorCode: 'provider_timeout',
      });
    });
  });

  it('cancels every non-terminal Backend task for a conversation without touching other conversations', async () => {
    const signals = new Map<string, AbortSignal>();
    const runtime: CogSeedAgentRuntimeFacade = {
      async *run(_userId, input, opts) {
        signals.set(String((input as any).request_id), opts?.signal as AbortSignal);
        await new Promise<void>((resolve) => opts?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        yield { type: 'error', request_id: String((input as any).request_id), runtime_session_id: String((input as any).runtime_session_id), status: 'cancelled', error: 'cancelled' };
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent: vi.fn(async () => {}) });
    const first = await controller.startCogSeedTask(USER, { requestId: 'req-cancel-cid-a', task: 'A', conversationId: 'cid-cancel-all', agentId: 'agent-a' });
    const second = await controller.startCogSeedTask(USER, { requestId: 'req-cancel-cid-b', task: 'B', conversationId: 'cid-cancel-all', agentId: 'agent-b' });
    const other = await controller.startCogSeedTask(USER, { requestId: 'req-cancel-other', task: 'Other', conversationId: 'cid-other', agentId: 'agent-c' });

    const cancelled = await controller.cancelConversationTasks(USER, 'cid-cancel-all');

    expect(cancelled.map((task) => task.taskId).sort()).toEqual([first.taskId, second.taskId].sort());
    await expect(tasks.readCogSeedTask(USER, first.taskId)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(tasks.readCogSeedTask(USER, second.taskId)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(tasks.readCogSeedTask(USER, other.taskId)).resolves.toMatchObject({ status: 'running' });
    expect(signals.get('req-cancel-cid-a')?.aborted).toBe(true);
    expect(signals.get('req-cancel-cid-b')?.aborted).toBe(true);
    expect(signals.get('req-cancel-other')?.aborted).toBe(false);
    await controller.cancelCogSeedTask(USER, other.taskId);
  });
  it('schedules an explicit retry as a new CogSeed task after a worker failure', async () => {
    let runs = 0;
    const runtime: CogSeedAgentRuntimeFacade & { inputs: unknown[] } = {
      inputs: [],
      async *run(_userId, input) {
        this.inputs.push(input);
        runs += 1;
        if (runs === 1) throw new Error('worker crashed');
        yield { type: 'result', request_id: 'req-retry', runtime_session_id: 'mruntime-retry', status: 'completed', text: 'retried' };
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });

    const original = await controller.startCogSeedTask(USER, { requestId: 'req-original', task: 'Run once.' });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, original.taskId)).toMatchObject({ status: 'recoverable' }));

    const retried = await controller.retryCogSeedTask(USER, original.taskId, 'req-retry');
    expect(retried).toMatchObject({ status: 'running', retryOfTaskId: original.taskId, requestId: 'req-retry' });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, retried.taskId)).toMatchObject({ status: 'completed' }));
    expect(runtime.inputs).toHaveLength(2);
    expect(runtime.inputs[1]).toMatchObject({ task: 'Run once.' });
  });

  it('resumes a recoverable task only with an explicit continuation and keeps the CogSeed runtime session', async () => {
    let runs = 0;
    const runtime: CogSeedAgentRuntimeFacade & { inputs: unknown[] } = {
      inputs: [],
      async *run(_userId, input) {
        this.inputs.push(input);
        runs += 1;
        if (runs === 1) throw new Error('worker crashed');
        yield { type: 'result', request_id: 'req-resume', runtime_session_id: 'mruntime-resume', status: 'completed', text: 'continued' };
      },
      async shutdown() {},
    };
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime });

    const original = await controller.startCogSeedTask(USER, { requestId: 'req-resume-original', task: 'Original prompt must not be replayed.' });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, original.taskId)).toMatchObject({ status: 'recoverable' }));

    const resumed = await controller.resumeCogSeedTask(USER, original.taskId, {
      requestId: 'req-resume',
      continuation: 'Continue from the persisted runtime state.',
    });
    expect(resumed).toMatchObject({ taskId: original.taskId, status: 'running' });
    await eventually(async () => expect(await tasks.readCogSeedTask(USER, original.taskId)).toMatchObject({ status: 'completed' }));
    expect(runtime.inputs[1]).toMatchObject({
      task: 'Continue from the persisted runtime state.',
      request_id: 'req-resume',
      runtime_session_id: original.runtimeSessionId,
    });
    expect((runtime.inputs[1] as { task: string }).task).not.toContain('Original prompt');
    await expect(controller.resumeCogSeedTask(USER, original.taskId, {
      requestId: 'req-resume',
      continuation: 'Continue from the persisted runtime state.',
    })).resolves.toMatchObject({ taskId: original.taskId });
    await expect(controller.resumeCogSeedTask(USER, original.taskId, {
      requestId: 'req-resume',
      continuation: 'A conflicting continuation must not run.',
    })).rejects.toThrow(/payload conflict/i);
    expect(runtime.inputs).toHaveLength(2);
    const persisted = await tasks.readCogSeedTask(USER, original.taskId);
    expect(persisted?.lastResumeRequestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain('Continue from the persisted runtime state.');
  });

  it('reports independent CogSeed runtime status and can restart its worker service', async () => {
    const shutdown = vi.fn(async () => undefined);
    const runtime = runtimeFrom([]);
    runtime.shutdown = shutdown;
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createCogSeedRuntimeController({ runtime });

    await expect(controller.runtimeStatus()).resolves.toMatchObject({ activeTaskCount: 0, backend: 'cogseed' });
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
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createCogSeedRuntimeController({ runtime });

    await controller.startCogSeedTask(USER, {
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
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createCogSeedRuntimeController({ runtime });

    await controller.startCogSeedTask(USER, {
      requestId: 'req-noasset',
      task: 'Run without conversation context.',
    });

    await eventually(() => {
      expect(runtime.inputs).toHaveLength(1);
      const context = (runtime.inputs[0] as { context?: Array<{ type: string; content: string }> }).context ?? [];
      expect(context.some((item) => item.content.includes('<confirmed-ability-assets>'))).toBe(false);
    });
  });

  it('injects the live Commander-granted asset body into the runtime prompt', async () => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const candidate = await candidates.saveRecallCandidate(USER, {
      judgment: 'Always include the acceptance criteria in the implementation report.',
      summary: 'Implementation report acceptance criteria',
      suggestedType: 'rule',
      suggestedScope: 'project,review',
      sourceRefs: [{ kind: 'execution', id: 'exec-dispatched-asset' }],
    });
    const promoted = await candidates.promoteRecallCandidate(USER, candidate.id, { actor: 'user' });
    const runtime = runtimeFrom([
      { type: 'result', request_id: 'req-dispatched-asset', runtime_session_id: 'mruntime-dispatched-asset', status: 'completed', text: 'done' },
    ]);
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const controller = createCogSeedRuntimeController({ runtime });

    await controller.startCogSeedTask(USER, {
      requestId: 'req-dispatched-asset',
      task: 'Prepare the implementation report.',
      agentId: 'agent-dispatched-asset',
      abilityAssetIds: [promoted.asset.id],
    });

    await eventually(() => {
      const context = (runtime.inputs[0] as { context?: Array<{ type: string; content: string }> }).context ?? [];
      const dispatched = context.find((item) => item.content.includes('<commander-dispatched-assets>'));
      expect(dispatched).toBeDefined();
      expect(dispatched!.content).toContain('Always include the acceptance criteria');
    });
  });

});
