import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UID = 'p3394-bridge-adapter-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-bridge-adapter-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function load() {
  const adapterModule = await import('../../../../src/main/features/p3394_bridge/cogseed-runtime-adapter');
  const controllerModule = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
  const executionModule = await import('../../../../src/main/features/cogseed_backend/cogseed-execution-store');
  const executorModule = await import('../../../../src/main/features/p3394_bridge/executor');
  const bridgeModule = await import('../../../../src/main/features/p3394_bridge/bridge');
  const manifestModule = await import('../../../../src/main/features/p3394_bridge/manifest');
  const sessionModule = await import('../../../../src/main/features/p3394_bridge/session-manager');
  const taskModule = await import('../../../../src/main/features/p3394_bridge/task-manager');
  const kstarModule = await import('../../../../src/main/features/p3394_bridge/kstar-close-hook');
  return { adapterModule, controllerModule, executionModule, executorModule, bridgeModule, manifestModule, sessionModule, taskModule, kstarModule };
}

/** Fake CogSeed runtime. Modes: 'complete' (delta + result), 'fail' (error event), 'throw' (run throws → recoverable), 'hold' (runs forever). */
function fakeRuntime(delta = 'partial reply', mode: 'complete' | 'fail' | 'throw' | 'hold' | 'artifact' = 'complete') {
  return {
    shutdown: vi.fn(async () => {}),
    run: vi.fn(async function* () {
      await new Promise((resolve) => setTimeout(resolve, 10));
      yield { type: 'event', status: 'running', text: delta, metadata: {} };
      if (mode === 'throw') throw new Error('runtime exploded');
      if (mode === 'hold') {
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          yield { type: 'event', status: 'running', text: 'still working', metadata: {} };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (mode === 'artifact') {
        yield { type: 'event', status: 'running', text: '', metadata: { kernel_event: 'artifact', uri: 'p3394-object:sha256:abc', digest: 'abc', name: 'report.md', media_type: 'text/markdown', secret: 'must-not-cross' } };
        yield { type: 'result', status: 'completed', text: 'artifact done', metadata: {} };
      } else if (mode === 'fail') {
        yield { type: 'error', status: 'failed', text: 'boom', metadata: {} };
      } else {
        yield { type: 'result', status: 'completed', text: 'final answer', metadata: {} };
      }
    }),
  };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-1',
    session_id: 'ses-bridge-1',
    task_id: 'tsk-bridge-1',
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'remote-agent' },
    recipients: [{ agent_id: 'cogseed-agent' }],
    payload: { parts: [{ type: 'text', text: 'Summarize this contract' }] },
    idempotency_key: 'idem-bridge-1',
    ...overrides,
  };
}

function buildManifest(module: typeof import('../../../../src/main/features/p3394_bridge/manifest'), id: string) {
  const result = module.buildP3394BridgeManifest({
    agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

describe('P3394CogseedRuntimeAdapter real backend wiring', () => {
  it('openSession creates a real CogSeed session and maps ids', async () => {
    const { adapterModule, controllerModule } = await load();
    const controller = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime() });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller });
    const binding = await adapter.openSession({ session_id: 'ses-bridge-1', agent_id: 'cogseed-agent' });
    expect(binding.session_id).toBe('ses-bridge-1');
    expect(binding.native_session_id).toMatch(/^cogseed-session-/);
    // Second open reuses the same CogSeed session.
    const again = await adapter.openSession({ session_id: 'ses-bridge-1', agent_id: 'cogseed-agent' });
    expect(again.native_session_id).toBe(binding.native_session_id);
  });

  it('deliver admits a real task and stream emits started/delta/completed', async () => {
    const { adapterModule, controllerModule } = await load();
    const controller = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime() });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({
      userId: () => UID, controller, pollIntervalMs: 30,
    });
    await adapter.openSession({ session_id: 'ses-bridge-1', agent_id: 'cogseed-agent' });
    const { task_id } = await adapter.deliver(envelope() as never);
    expect(task_id).toBe('tsk-bridge-1');

    const kinds: string[] = [];
    const deltas: string[] = [];
    for await (const event of adapter.stream(task_id)) {
      kinds.push(event.kind);
      if (event.kind === 'delta' && event.data && typeof event.data.text === 'string') deltas.push(event.data.text);
      if (event.kind === 'completed') break;
    }
    expect(kinds).toContain('started');
    expect(kinds).toContain('delta');
    expect(deltas).toContain('partial reply');
    expect(kinds[kinds.length - 1]).toBe('completed');
  });

  it('maps persisted artifact events with bounded fields', async () => {
    const m = await load();
    const controller = m.controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime('partial reply', 'artifact') });
    const adapter = new m.adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller, pollIntervalMs: 20 });
    await adapter.openSession({ session_id: 'ses-artifact', agent_id: 'cogseed-agent' });
    const { task_id } = await adapter.deliver(envelope({ session_id: 'ses-artifact', task_id: 'tsk-artifact' }) as never);
    const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    for await (const event of adapter.stream(task_id)) events.push(event);
    const artifact = events.find((event) => event.kind === 'artifact');
    expect(artifact).toMatchObject({
      kind: 'artifact',
      data: {
        uri: 'p3394-object:sha256:abc',
        digest: 'abc',
        name: 'report.md',
        media_type: 'text/markdown',
      },
    });
    expect(artifact?.data).not.toHaveProperty('secret');
    expect(events.at(-1)?.kind).toBe('completed');
  });

  it('restores session and task mappings across adapter instances', async () => {
    const { adapterModule, controllerModule } = await load();
    const stateFile = path.join(tmpDir, 'agent-home', 'p3394-adapter-state.json');
    const controller = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime() });
    const first = new adapterModule.P3394CogseedRuntimeAdapter({
      userId: () => UID, controller, stateFile,
    });
    const binding = await first.openSession({ session_id: 'ses-persisted', agent_id: 'cogseed-agent' });
    const delivered = await first.deliver(envelope({ session_id: 'ses-persisted', task_id: 'tsk-persisted' }) as never);
    expect(delivered.task_id).toBe('tsk-persisted');

    const second = new adapterModule.P3394CogseedRuntimeAdapter({
      userId: () => UID, controller, stateFile,
    });
    const snapshot = await second.snapshot('ses-persisted');
    expect(snapshot.native_session_id).toBe(binding.native_session_id);
    expect((snapshot.state as { tasks: { task_id: string }[] }).tasks).toEqual(
      expect.arrayContaining([{ task_id: expect.any(String), status: expect.any(String) }]),
    );
    const resumedEvents: string[] = [];
    for await (const event of second.stream('tsk-persisted')) {
      resumedEvents.push(event.kind);
      if (event.kind === 'completed') break;
    }
    expect(resumedEvents).toContain('completed');
  });

  it('deliver without a text part is rejected', async () => {
    const { adapterModule, controllerModule } = await load();
    const controller = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime() });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller });
    await adapter.openSession({ session_id: 'ses-bridge-1', agent_id: 'cogseed-agent' });
    await expect(adapter.deliver(envelope({ payload: { parts: [{ type: 'json', data: { a: 1 } }] } }) as never))
      .rejects.toThrow('p3394_message_has_no_text_part');
  });

  it('cancel stops a running task with a cancelled terminal event', async () => {
    const { adapterModule, controllerModule } = await load();
    const controller = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime('long delta', 'hold') });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller, pollIntervalMs: 20 });
    await adapter.openSession({ session_id: 'ses-bridge-1', agent_id: 'cogseed-agent' });
    const { task_id } = await adapter.deliver(envelope() as never);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await adapter.cancel(task_id);

    let terminal = '';
    for await (const event of adapter.stream(task_id)) {
      if (event.kind === 'completed' || event.kind === 'failed' || event.kind === 'cancelled') {
        terminal = event.kind;
        break;
      }
    }
    expect(terminal).toBe('cancelled');
  });

  it('failed runtime run surfaces a failed terminal event', async () => {
    const { adapterModule, controllerModule } = await load();
    const controller = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime('x', 'fail') });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller, pollIntervalMs: 20 });
    await adapter.openSession({ session_id: 'ses-bridge-1', agent_id: 'cogseed-agent' });
    const { task_id } = await adapter.deliver(envelope() as never);
    let terminal = '';
    for await (const event of adapter.stream(task_id)) {
      if (event.kind === 'completed' || event.kind === 'failed' || event.kind === 'cancelled') {
        terminal = event.kind;
        break;
      }
    }
    expect(terminal).toBe('failed');
  });

  it('snapshot reports the task ledger for the session', async () => {
    const { adapterModule, controllerModule } = await load();
    const controller = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime() });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller, pollIntervalMs: 20 });
    await adapter.openSession({ session_id: 'ses-bridge-1', agent_id: 'cogseed-agent' });
    await adapter.deliver(envelope() as never);
    const snapshot = await adapter.snapshot('ses-bridge-1');
    expect(snapshot.native_session_id).toMatch(/^cogseed-session-/);
    expect(snapshot.state).toBeDefined();
    const tasks = (snapshot.state as { tasks: { status: string }[] }).tasks;
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('closeSession records terminal tasks into the Recall execution ledger', async () => {
    const { adapterModule, controllerModule, executionModule } = await load();
    const controller = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime() });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller, pollIntervalMs: 20 });
    await adapter.openSession({ session_id: 'ses-bridge-1', agent_id: 'cogseed-agent' });
    const { task_id } = await adapter.deliver(envelope() as never);
    for await (const event of adapter.stream(task_id)) {
      if (event.kind === 'completed') break;
    }
    const snapshot = await adapter.snapshot('ses-bridge-1');
    const cogseedTaskId = (snapshot.state as { tasks: { task_id: string }[] }).tasks[0].task_id;
    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const task = await taskStore.readCogSeedTask(UID, cogseedTaskId);
    expect(task).not.toBeNull();
    const executionId = task!.executionId || `cogseed-exec-${cogseedTaskId.slice('cogseed-task-'.length)}`;
    await adapter.closeSession('ses-bridge-1');

    const record = await executionModule.read(UID, executionId);
    expect(record.status).toBe('completed');
    // Session mapping is released after close.
    await expect(adapter.snapshot('ses-bridge-1')).rejects.toThrow('p3394_session_not_found');
  });

  it('resume continues a recoverable task on the same session', async () => {
    const { adapterModule, controllerModule } = await load();
    // First run throws → task becomes recoverable.
    const runtime = fakeRuntime('first', 'throw');
    const controller = controllerModule.createCogSeedRuntimeController({ runtime });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller, pollIntervalMs: 20 });
    await adapter.openSession({ session_id: 'ses-bridge-1', agent_id: 'cogseed-agent' });
    const { task_id } = await adapter.deliver(envelope() as never);
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Swap in a completing runtime for the resumed run.
    runtime.run.mockImplementation(async function* () {
      yield { type: 'result', status: 'completed', text: 'resumed answer', metadata: {} };
    });
    await adapter.resume('ses-bridge-1');

    let terminal = '';
    for await (const event of adapter.stream(task_id)) {
      if (event.kind === 'completed' || event.kind === 'failed' || event.kind === 'cancelled') {
        terminal = event.kind;
        break;
      }
    }
    expect(terminal).toBe('completed');
  });

  it('resume without a recoverable task fails', async () => {
    const { adapterModule, controllerModule } = await load();
    const controller = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime() });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller });
    await adapter.openSession({ session_id: 'ses-bridge-1', agent_id: 'cogseed-agent' });
    await expect(adapter.resume('ses-bridge-1')).rejects.toThrow('p3394_no_recoverable_task');
  });
});

describe('P3394BridgeExecutor inbound pipeline', () => {
  it('executes an envelope end-to-end: kernel → session → task → events → settle → close', async () => {
    const m = await load();
    const bridge = new m.bridgeModule.P3394BridgeKernel();
    const reg1 = bridge.registry.register({ identity: { agent_id: 'remote-agent', display_name: 'Remote' }, manifest: buildManifest(m.manifestModule, 'remote-agent') });
    const reg2 = bridge.registry.register({ identity: { agent_id: 'cogseed-agent', display_name: 'CogSeed' }, manifest: buildManifest(m.manifestModule, 'cogseed-agent') });
    if (!reg1.ok || !reg2.ok) {
      throw new Error(`register failed: ${JSON.stringify([reg1, reg2])}`);
    }

    const controller = m.controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime('inbound delta') });
    const runtime = new m.adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller, pollIntervalMs: 20 });

    const events: string[] = [];
    const executor = new m.executorModule.P3394BridgeExecutor({
      bridge,
      runtime,
      onEvent: (_sessionId, event) => { events.push(event.kind); },
    });

    const result = executor.execute(envelope() as never);
    if (!result.ok) {
      throw new Error(`execute failed: ${JSON.stringify(result.error)}`);
    }
    expect(result.ok).toBe(true);
    expect(result.executed).toBe(true);
    expect(result.task_id).toBe('tsk-bridge-1');
    expect(result.receipt.replay).toBe(false);

    // Duplicate envelope is rejected by idempotency before reaching the runtime.
    const dup = executor.execute(envelope() as never);
    expect(dup.ok).toBe(true);
    if (dup.ok) expect(dup.receipt.replay).toBe(true);

    await executor.awaitForward('tsk-bridge-1');
    expect(events).toContain('started');
    expect(events).toContain('delta');
    expect(events[events.length - 1]).toBe('completed');

    const settled = executor.tasks.require('tsk-bridge-1');
    expect(settled.state).toBe('completed');

    await executor.closeSession('ses-bridge-1');
    expect(executor.sessions.require('ses-bridge-1').state).toBe('closed');
    expect(executor.kstar.list()).toHaveLength(1);
  });

  it('rejects envelopes with unresolved peers before runtime contact', async () => {
    const m = await load();
    const bridge = new m.bridgeModule.P3394BridgeKernel();
    const runtime = new m.adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID });
    const executor = new m.executorModule.P3394BridgeExecutor({ bridge, runtime });
    const result = executor.execute(envelope() as never);
    expect(result.ok).toBe(false);
  });
});

/** Collects the first error an async iterable throws ('' when it completes). */
async function streamError(iterable: AsyncIterable<unknown>): Promise<string> {
  try {
    for await (const _event of iterable) void _event;
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Wraps a real controller and fails exactly one admission/control method,
 * delegating everything else (including runtimeStatus) to the real controller.
 */
function failingController(real: any, failOn: 'start' | 'resume' | 'cancel'): never {
  const failure = new Error(`injected ${failOn} failure`);
  const fail = vi.fn(async () => { throw failure; });
  const pass = (method: string) => vi.fn(async (...args: unknown[]) => (real as Record<string, (...a: unknown[]) => unknown>)[method](...args));
  return {
    startCogSeedTask: failOn === 'start' ? fail : pass('startCogSeedTask'),
    resumeCogSeedTask: failOn === 'resume' ? fail : pass('resumeCogSeedTask'),
    cancelCogSeedTask: failOn === 'cancel' ? fail : pass('cancelCogSeedTask'),
    retryCogSeedTask: pass('retryCogSeedTask'),
    cancelConversationTasks: pass('cancelConversationTasks'),
    runtimeStatus: pass('runtimeStatus'),
    restartRuntime: pass('restartRuntime'),
  } as never;
}

describe('P3394CogseedRuntimeAdapter R-08 failure discipline (no ledger mutation on failure)', () => {
  // 注：P3394 adapter 任务不携带 conversationId，group-chat projection 按设计跳过；
  // 这里把断言绑定到 P3394 任务真实涉及的 ledger：task-store、event-store 与 activeRuns。
  it('a failed task admission leaves no task record, mapping, or active run', async () => {
    const { adapterModule, controllerModule } = await load();
    const real = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime() });
    const controller = failingController(real, 'start');
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller });
    const binding = await adapter.openSession({ session_id: 'ses-fail-admit', agent_id: 'cogseed-agent' });

    await expect(
      adapter.deliver(envelope({ session_id: 'ses-fail-admit', task_id: 'tsk-fail-admit' }) as never),
    ).rejects.toThrow('injected start failure');

    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const tasks = await taskStore.listCogSeedTasks(UID);
    expect(tasks.filter((task) => task.sessionId === binding.native_session_id)).toHaveLength(0);
    expect(await streamError(adapter.stream('tsk-fail-admit'))).toBe('p3394_task_not_found');
    const status = await controller.runtimeStatus();
    expect(status.activeTaskCount).toBe(0);
  });

  it('a failed resume keeps the task recoverable, spawns no run, and appends no event', async () => {
    const { adapterModule, controllerModule } = await load();
    const stateFile = path.join(tmpDir, 'agent-home', 'p3394-adapter-fail-resume.json');
    const real = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime('first', 'throw') });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({
      userId: () => UID, controller: real, pollIntervalMs: 20, stateFile,
    });
    await adapter.openSession({ session_id: 'ses-fail-resume', agent_id: 'cogseed-agent' });
    await adapter.deliver(envelope({ session_id: 'ses-fail-resume', task_id: 'tsk-fail-resume' }) as never);

    await vi.waitFor(async () => {
      const snapshot = await adapter.snapshot('ses-fail-resume');
      const tasks = (snapshot.state as { tasks: { status: string }[] }).tasks;
      expect(tasks.some((task) => task.status === 'recoverable')).toBe(true);
    });
    const snapshot = await adapter.snapshot('ses-fail-resume');
    const cogseedTaskId = (snapshot.state as { tasks: { task_id: string }[] }).tasks[0].task_id;
    const eventStore = await import('../../../../src/main/features/cogseed_backend/event-store');
    const eventsBefore = await eventStore.readCogSeedTaskEvents(UID, cogseedTaskId, 0, 200);

    const failing = failingController(real, 'resume');
    const adapter2 = new adapterModule.P3394CogseedRuntimeAdapter({
      userId: () => UID, controller: failing, pollIntervalMs: 20, stateFile,
    });
    await expect(adapter2.resume('ses-fail-resume')).rejects.toThrow('injected resume failure');

    // 给任何（错误的）恢复运行留出启动时间，再验证 ledger 未变化。
    await new Promise((resolve) => setTimeout(resolve, 80));
    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const tasks = await taskStore.listCogSeedTasks(UID);
    const cogseedTask = tasks.find((task) => task.taskId === cogseedTaskId);
    expect(cogseedTask?.status).toBe('recoverable');
    const status = await failing.runtimeStatus();
    expect(status.activeTaskCount).toBe(0);
    const eventsAfter = await eventStore.readCogSeedTaskEvents(UID, cogseedTaskId, 0, 200);
    expect(eventsAfter.length).toBe(eventsBefore.length);
  });

  it('a failed cancel leaves a running task running and active with no cancelled event', async () => {
    const { adapterModule, controllerModule } = await load();
    const stateFile = path.join(tmpDir, 'agent-home', 'p3394-adapter-fail-cancel.json');
    const real = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime('long delta', 'hold') });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({
      userId: () => UID, controller: real, pollIntervalMs: 20, stateFile,
    });
    await adapter.openSession({ session_id: 'ses-fail-cancel', agent_id: 'cogseed-agent' });
    await adapter.deliver(envelope({ session_id: 'ses-fail-cancel', task_id: 'tsk-fail-cancel' }) as never);

    await vi.waitFor(async () => {
      const status = await real.runtimeStatus();
      expect(status.activeTaskCount).toBe(1);
    });

    const failing = failingController(real, 'cancel');
    const adapter2 = new adapterModule.P3394CogseedRuntimeAdapter({
      userId: () => UID, controller: failing, pollIntervalMs: 20, stateFile,
    });
    await expect(adapter2.cancel('tsk-fail-cancel')).rejects.toThrow('injected cancel failure');

    const snapshot = await adapter2.snapshot('ses-fail-cancel');
    const cogseedTaskId = (snapshot.state as { tasks: { task_id: string }[] }).tasks[0].task_id;
    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const task = await taskStore.readCogSeedTask(UID, cogseedTaskId);
    expect(task?.status).not.toBe('cancelled');
    const status = await failing.runtimeStatus();
    expect(status.activeTaskCount).toBe(1);
    const eventStore = await import('../../../../src/main/features/cogseed_backend/event-store');
    const storedEvents = await eventStore.readCogSeedTaskEvents(UID, cogseedTaskId, 0, 500);
    expect(storedEvents.map((event) => event.type)).not.toContain('task.cancelled');

    // 清理：通过真实控制器取消，结束 hold 运行。
    await real.cancelCogSeedTask(UID, cogseedTaskId);
  });

  it('event-store 读取失败只传播错误，不修改后端任务账本', async () => {
    const { adapterModule, controllerModule } = await load();
    const real = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime('long delta', 'hold') });
    const readEvents = async () => { throw new Error('event store down'); };
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({
      userId: () => UID, controller: real, pollIntervalMs: 20, readEvents: readEvents as never,
    });
    await adapter.openSession({ session_id: 'ses-read-fail', agent_id: 'cogseed-agent' });
    const { task_id } = await adapter.deliver(envelope({ session_id: 'ses-read-fail', task_id: 'tsk-read-fail' }) as never);
    await vi.waitFor(async () => {
      const status = await real.runtimeStatus();
      expect(status.activeTaskCount).toBe(1);
    });

    // 读取失败：错误传播（不吞掉），任务保持 running。
    expect(await streamError(adapter.stream(task_id))).toBe('event store down');
    const snapshot = await adapter.snapshot('ses-read-fail');
    const cogseedTaskId = (snapshot.state as { tasks: Array<{ task_id: string }> }).tasks[0].task_id;
    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const record = await taskStore.readCogSeedTask(UID, cogseedTaskId);
    expect(record?.status).toBe('running'); // 读取失败不把任务标记为 failed
    const eventStore = await import('../../../../src/main/features/cogseed_backend/event-store');
    const events = await eventStore.readCogSeedTaskEvents(UID, cogseedTaskId, 0, 500);
    expect(events.map((event) => event.type)).not.toContain('task.failed');

    // 清理：结束 hold 运行。
    await real.cancelCogSeedTask(UID, cogseedTaskId);
  });
});

describe('P3394CogseedRuntimeAdapter R-09 状态文件损坏恢复', () => {
  function writeStateFile(stateFile: string, content: string): void {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, content);
  }

  it('损坏的 state 文件以空映射启动，并重写有效状态', async () => {
    const { adapterModule, controllerModule } = await load();
    const stateFile = path.join(tmpDir, 'agent-home', 'p3394-adapter-corrupt.json');
    writeStateFile(stateFile, '{not-json');
    const controller = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime() });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({
      userId: () => UID, controller, stateFile, pollIntervalMs: 20,
    });
    await adapter.openSession({ session_id: 'ses-corrupt', agent_id: 'cogseed-agent' });
    await adapter.deliver(envelope({ session_id: 'ses-corrupt', task_id: 'tsk-corrupt' }) as never);

    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
      schemaVersion: number;
      sessions: Array<Record<string, unknown>>;
      tasks: Array<Record<string, unknown>>;
    };
    expect(parsed.schemaVersion).toBe(1);
    for (const entry of parsed.sessions) {
      expect(typeof entry.p3394_session_id).toBe('string');
      expect(typeof entry.cogseed_session_id).toBe('string');
    }
    for (const entry of parsed.tasks) {
      expect(typeof entry.p3394_task_id).toBe('string');
      expect(typeof entry.cogseed_task_id).toBe('string');
    }
    expect(parsed.sessions.some((session) => session.p3394_session_id === 'ses-corrupt')).toBe(true);
    expect(parsed.tasks.some((task) => task.p3394_task_id === 'tsk-corrupt')).toBe(true);
  });

  it('不支持的 schema 版本被忽略，映射从零开始', async () => {
    const { adapterModule, controllerModule } = await load();
    const stateFile = path.join(tmpDir, 'agent-home', 'p3394-adapter-v2.json');
    writeStateFile(stateFile, JSON.stringify({
      schemaVersion: 2,
      sessions: [{ p3394_session_id: 'old', cogseed_session_id: 'cogseed-session-old' }],
      tasks: [],
    }));
    const controller = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime() });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller, stateFile });
    const binding = await adapter.openSession({ session_id: 'ses-v2', agent_id: 'cogseed-agent' });
    expect(binding.native_session_id).toMatch(/^cogseed-session-/);
    expect(binding.native_session_id).not.toBe('cogseed-session-old');
    await expect(adapter.snapshot('old')).rejects.toThrow('p3394_session_not_found');
  });

  it('跳过畸形条目，持久化只包含良构映射', async () => {
    const { adapterModule, controllerModule } = await load();
    const stateFile = path.join(tmpDir, 'agent-home', 'p3394-adapter-malformed.json');
    writeStateFile(stateFile, JSON.stringify({
      schemaVersion: 1,
      sessions: [
        { cogseed_session_id: 'cogseed-session-phantom' }, // 缺 p3394_session_id
        { p3394_session_id: 'ses-ok', cogseed_session_id: 'cogseed-session-ok' },
      ],
      tasks: [{ cogseed_task_id: 'cogseed-task-phantom' }], // 缺 p3394_task_id
    }));
    const controller = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime() });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller, stateFile });
    await adapter.openSession({ session_id: 'ses-new', agent_id: 'cogseed-agent' });
    await adapter.deliver(envelope({ session_id: 'ses-new', task_id: 'tsk-new' }) as never);

    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
      sessions: Array<{ p3394_session_id?: string; cogseed_session_id?: string }>;
      tasks: Array<{ p3394_task_id?: string; cogseed_task_id?: string }>;
    };
    for (const entry of parsed.sessions) {
      expect(typeof entry.p3394_session_id).toBe('string');
      expect(typeof entry.cogseed_session_id).toBe('string');
    }
    for (const entry of parsed.tasks) {
      expect(typeof entry.p3394_task_id).toBe('string');
      expect(typeof entry.cogseed_task_id).toBe('string');
    }
    expect(parsed.sessions.some((session) => session.cogseed_session_id === 'cogseed-session-phantom')).toBe(false);
    expect(parsed.tasks.some((task) => task.cogseed_task_id === 'cogseed-task-phantom')).toBe(false);
  });
});

describe('P3394CogseedRuntimeAdapter R-04 多 Agent 任务账本隔离', () => {
  it('同一会话下不同 Agent 的任务记录各自保留 agentId', async () => {
    const { adapterModule, controllerModule } = await load();
    const controller = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime() });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller, pollIntervalMs: 20 });
    await adapter.openSession({ session_id: 'ses-multi-agent', agent_id: 'agent-a' });
    await adapter.deliver(envelope({
      session_id: 'ses-multi-agent', task_id: 'tsk-agent-a', message_id: 'msg-a',
      recipients: [{ agent_id: 'agent-a' }],
    }) as never);
    // 同一会话切换到 agent-b 再投递。
    await adapter.openSession({ session_id: 'ses-multi-agent', agent_id: 'agent-b' });
    await adapter.deliver(envelope({
      session_id: 'ses-multi-agent', task_id: 'tsk-agent-b', message_id: 'msg-b',
      recipients: [{ agent_id: 'agent-b' }],
    }) as never);

    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const snapshot = await adapter.snapshot('ses-multi-agent');
    const tasks = (snapshot.state as { tasks: Array<{ task_id: string }> }).tasks;
    expect(tasks).toHaveLength(2);
    const agentIds = new Set<string>();
    for (const entry of tasks) {
      const record = await taskStore.readCogSeedTask(UID, entry.task_id);
      expect(record).not.toBeNull();
      if (record?.agentId) agentIds.add(record.agentId);
    }
    expect(agentIds).toEqual(new Set(['agent-a', 'agent-b']));
  });

  it('一个 Agent 的 admission 失败不产生任务，也不影响另一 Agent 的账本', async () => {
    const { adapterModule, controllerModule } = await load();
    const failing = failingController(controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime() }), 'start');
    const failingAdapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller: failing });
    await failingAdapter.openSession({ session_id: 'ses-fail-agent', agent_id: 'agent-a' });
    await expect(failingAdapter.deliver(envelope({
      session_id: 'ses-fail-agent', task_id: 'tsk-fail-agent', message_id: 'msg-fail',
      recipients: [{ agent_id: 'agent-a' }],
    }) as never)).rejects.toThrow('injected start failure');

    const real = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime() });
    const realAdapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller: real, pollIntervalMs: 20 });
    await realAdapter.openSession({ session_id: 'ses-ok-agent', agent_id: 'agent-b' });
    await realAdapter.deliver(envelope({
      session_id: 'ses-ok-agent', task_id: 'tsk-ok-agent', message_id: 'msg-ok',
      recipients: [{ agent_id: 'agent-b' }],
    }) as never);

    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const tasks = await taskStore.listCogSeedTasks(UID);
    // 失败路径零残留：账本里只有 agent-b 的一个任务。
    expect(tasks).toHaveLength(1);
    expect(tasks[0].agentId).toBe('agent-b');
  });
});

describe('P3394CogseedRuntimeAdapter R-07 Recall 执行账本治理', () => {
  it('失败任务 close 进入 Recall 执行账本，且重复 close 不重复记录', async () => {
    const { adapterModule, controllerModule, executionModule } = await load();
    const controller = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime('x', 'fail') });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller, pollIntervalMs: 20 });
    await adapter.openSession({ session_id: 'ses-recall-fail', agent_id: 'cogseed-agent' });
    const { task_id } = await adapter.deliver(envelope({ session_id: 'ses-recall-fail', task_id: 'tsk-recall-fail' }) as never);
    let terminal = '';
    for await (const event of adapter.stream(task_id)) {
      if (event.kind === 'completed' || event.kind === 'failed' || event.kind === 'cancelled') {
        terminal = event.kind;
        break;
      }
    }
    expect(terminal).toBe('failed');

    const snapshot = await adapter.snapshot('ses-recall-fail');
    const cogseedTaskId = (snapshot.state as { tasks: Array<{ task_id: string }> }).tasks[0].task_id;
    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const task = await taskStore.readCogSeedTask(UID, cogseedTaskId);
    const executionId = task!.executionId || `cogseed-exec-${cogseedTaskId.slice('cogseed-task-'.length)}`;

    await adapter.closeSession('ses-recall-fail');
    const first = await executionModule.read(UID, executionId);
    expect(first.status).toBe('failed');

    // 重复 close：Recall 记录幂等，不重复写。
    await adapter.closeSession('ses-recall-fail').catch(() => {});
    const second = await executionModule.read(UID, executionId);
    expect(second.status).toBe('failed');
    expect(second.executionId).toBe(first.executionId);
  });

  it('取消任务 close 进入 Recall 执行账本（status=cancelled），且不污染其他任务', async () => {
    const { adapterModule, controllerModule, executionModule } = await load();
    // hold：任务保持 running，供 cancel 打断。
    const controller = controllerModule.createCogSeedRuntimeController({ runtime: fakeRuntime('long delta', 'hold') });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller, pollIntervalMs: 20 });
    await adapter.openSession({ session_id: 'ses-recall-cancel', agent_id: 'cogseed-agent' });
    const { task_id } = await adapter.deliver(envelope({ session_id: 'ses-recall-cancel', task_id: 'tsk-recall-cancel' }) as never);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await adapter.cancel(task_id);

    let terminal = '';
    for await (const event of adapter.stream(task_id)) {
      if (event.kind === 'completed' || event.kind === 'failed' || event.kind === 'cancelled') {
        terminal = event.kind;
        break;
      }
    }
    expect(terminal).toBe('cancelled');

    const snapshot = await adapter.snapshot('ses-recall-cancel');
    const cogseedTaskId = (snapshot.state as { tasks: Array<{ task_id: string }> }).tasks[0].task_id;
    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const task = await taskStore.readCogSeedTask(UID, cogseedTaskId);
    const executionId = task!.executionId || `cogseed-exec-${cogseedTaskId.slice('cogseed-task-'.length)}`;

    await adapter.closeSession('ses-recall-cancel');
    const record = await executionModule.read(UID, executionId);
    expect(record.status).toBe('cancelled');
    // 会话映射在 close 后释放，cancelled 任务不再被引用。
    await expect(adapter.snapshot('ses-recall-cancel')).rejects.toThrow('p3394_session_not_found');
  });
});
