import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UID = 'p3394-bridge-adapter-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-bridge-adapter-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function load() {
  const adapterModule = await import('../../../../src/main/features/p3394_bridge/cogseed-runtime-adapter');
  const controllerModule = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
  const executionModule = await import('../../../../src/main/features/cogseed_backend/mate-execution-store');
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
    const controller = controllerModule.createMateRuntimeController({ runtime: fakeRuntime() });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller });
    const binding = await adapter.openSession({ session_id: 'ses-bridge-1', agent_id: 'cogseed-agent' });
    expect(binding.session_id).toBe('ses-bridge-1');
    expect(binding.native_session_id).toMatch(/^mate-session-/);
    // Second open reuses the same CogSeed session.
    const again = await adapter.openSession({ session_id: 'ses-bridge-1', agent_id: 'cogseed-agent' });
    expect(again.native_session_id).toBe(binding.native_session_id);
  });

  it('deliver admits a real task and stream emits started/delta/completed', async () => {
    const { adapterModule, controllerModule } = await load();
    const controller = controllerModule.createMateRuntimeController({ runtime: fakeRuntime() });
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
    const controller = m.controllerModule.createMateRuntimeController({ runtime: fakeRuntime('partial reply', 'artifact') });
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
    const controller = controllerModule.createMateRuntimeController({ runtime: fakeRuntime() });
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
    const controller = controllerModule.createMateRuntimeController({ runtime: fakeRuntime() });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller });
    await adapter.openSession({ session_id: 'ses-bridge-1', agent_id: 'cogseed-agent' });
    await expect(adapter.deliver(envelope({ payload: { parts: [{ type: 'json', data: { a: 1 } }] } }) as never))
      .rejects.toThrow('p3394_message_has_no_text_part');
  });

  it('cancel stops a running task with a cancelled terminal event', async () => {
    const { adapterModule, controllerModule } = await load();
    const controller = controllerModule.createMateRuntimeController({ runtime: fakeRuntime('long delta', 'hold') });
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
    const controller = controllerModule.createMateRuntimeController({ runtime: fakeRuntime('x', 'fail') });
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
    const controller = controllerModule.createMateRuntimeController({ runtime: fakeRuntime() });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller, pollIntervalMs: 20 });
    await adapter.openSession({ session_id: 'ses-bridge-1', agent_id: 'cogseed-agent' });
    await adapter.deliver(envelope() as never);
    const snapshot = await adapter.snapshot('ses-bridge-1');
    expect(snapshot.native_session_id).toMatch(/^mate-session-/);
    expect(snapshot.state).toBeDefined();
    const tasks = (snapshot.state as { tasks: { status: string }[] }).tasks;
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('closeSession records terminal tasks into the Recall execution ledger', async () => {
    const { adapterModule, controllerModule, executionModule } = await load();
    const controller = controllerModule.createMateRuntimeController({ runtime: fakeRuntime() });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller, pollIntervalMs: 20 });
    await adapter.openSession({ session_id: 'ses-bridge-1', agent_id: 'cogseed-agent' });
    const { task_id } = await adapter.deliver(envelope() as never);
    for await (const event of adapter.stream(task_id)) {
      if (event.kind === 'completed') break;
    }
    const snapshot = await adapter.snapshot('ses-bridge-1');
    const mateTaskId = (snapshot.state as { tasks: { task_id: string }[] }).tasks[0].task_id;
    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const task = await taskStore.readMateTask(UID, mateTaskId);
    expect(task).not.toBeNull();
    const executionId = task!.executionId || `mate-exec-${mateTaskId.slice('mate-task-'.length)}`;
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
    const controller = controllerModule.createMateRuntimeController({ runtime });
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
    const controller = controllerModule.createMateRuntimeController({ runtime: fakeRuntime() });
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

    const controller = m.controllerModule.createMateRuntimeController({ runtime: fakeRuntime('inbound delta') });
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
    startMateTask: failOn === 'start' ? fail : pass('startMateTask'),
    resumeMateTask: failOn === 'resume' ? fail : pass('resumeMateTask'),
    cancelMateTask: failOn === 'cancel' ? fail : pass('cancelMateTask'),
    retryMateTask: pass('retryMateTask'),
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
    const real = controllerModule.createMateRuntimeController({ runtime: fakeRuntime() });
    const controller = failingController(real, 'start');
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller });
    const binding = await adapter.openSession({ session_id: 'ses-fail-admit', agent_id: 'cogseed-agent' });

    await expect(
      adapter.deliver(envelope({ session_id: 'ses-fail-admit', task_id: 'tsk-fail-admit' }) as never),
    ).rejects.toThrow('injected start failure');

    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const tasks = await taskStore.listMateTasks(UID);
    expect(tasks.filter((task) => task.sessionId === binding.native_session_id)).toHaveLength(0);
    expect(await streamError(adapter.stream('tsk-fail-admit'))).toBe('p3394_task_not_found');
    const status = await controller.runtimeStatus();
    expect(status.activeTaskCount).toBe(0);
  });

  it('a failed resume keeps the task recoverable, spawns no run, and appends no event', async () => {
    const { adapterModule, controllerModule } = await load();
    const stateFile = path.join(tmpDir, 'agent-home', 'p3394-adapter-fail-resume.json');
    const real = controllerModule.createMateRuntimeController({ runtime: fakeRuntime('first', 'throw') });
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
    const mateTaskId = (snapshot.state as { tasks: { task_id: string }[] }).tasks[0].task_id;
    const eventStore = await import('../../../../src/main/features/cogseed_backend/event-store');
    const eventsBefore = await eventStore.readMateTaskEvents(UID, mateTaskId, 0, 200);

    const failing = failingController(real, 'resume');
    const adapter2 = new adapterModule.P3394CogseedRuntimeAdapter({
      userId: () => UID, controller: failing, pollIntervalMs: 20, stateFile,
    });
    await expect(adapter2.resume('ses-fail-resume')).rejects.toThrow('injected resume failure');

    // 给任何（错误的）恢复运行留出启动时间，再验证 ledger 未变化。
    await new Promise((resolve) => setTimeout(resolve, 80));
    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const tasks = await taskStore.listMateTasks(UID);
    const mateTask = tasks.find((task) => task.taskId === mateTaskId);
    expect(mateTask?.status).toBe('recoverable');
    const status = await failing.runtimeStatus();
    expect(status.activeTaskCount).toBe(0);
    const eventsAfter = await eventStore.readMateTaskEvents(UID, mateTaskId, 0, 200);
    expect(eventsAfter.length).toBe(eventsBefore.length);
  });

  it('a failed cancel leaves a running task running and active with no cancelled event', async () => {
    const { adapterModule, controllerModule } = await load();
    const stateFile = path.join(tmpDir, 'agent-home', 'p3394-adapter-fail-cancel.json');
    const real = controllerModule.createMateRuntimeController({ runtime: fakeRuntime('long delta', 'hold') });
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
    const mateTaskId = (snapshot.state as { tasks: { task_id: string }[] }).tasks[0].task_id;
    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const task = await taskStore.readMateTask(UID, mateTaskId);
    expect(task?.status).not.toBe('cancelled');
    const status = await failing.runtimeStatus();
    expect(status.activeTaskCount).toBe(1);
    const eventStore = await import('../../../../src/main/features/cogseed_backend/event-store');
    const storedEvents = await eventStore.readMateTaskEvents(UID, mateTaskId, 0, 500);
    expect(storedEvents.map((event) => event.type)).not.toContain('task.cancelled');

    // 清理：通过真实控制器取消，结束 hold 运行。
    await real.cancelMateTask(UID, mateTaskId);
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
    const controller = controllerModule.createMateRuntimeController({ runtime: fakeRuntime() });
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
      expect(typeof entry.mate_session_id).toBe('string');
    }
    for (const entry of parsed.tasks) {
      expect(typeof entry.p3394_task_id).toBe('string');
      expect(typeof entry.mate_task_id).toBe('string');
    }
    expect(parsed.sessions.some((session) => session.p3394_session_id === 'ses-corrupt')).toBe(true);
    expect(parsed.tasks.some((task) => task.p3394_task_id === 'tsk-corrupt')).toBe(true);
  });

  it('不支持的 schema 版本被忽略，映射从零开始', async () => {
    const { adapterModule, controllerModule } = await load();
    const stateFile = path.join(tmpDir, 'agent-home', 'p3394-adapter-v2.json');
    writeStateFile(stateFile, JSON.stringify({
      schemaVersion: 2,
      sessions: [{ p3394_session_id: 'old', mate_session_id: 'mate-session-old' }],
      tasks: [],
    }));
    const controller = controllerModule.createMateRuntimeController({ runtime: fakeRuntime() });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller, stateFile });
    const binding = await adapter.openSession({ session_id: 'ses-v2', agent_id: 'cogseed-agent' });
    expect(binding.native_session_id).toMatch(/^mate-session-/);
    expect(binding.native_session_id).not.toBe('mate-session-old');
    await expect(adapter.snapshot('old')).rejects.toThrow('p3394_session_not_found');
  });

  it('跳过畸形条目，持久化只包含良构映射', async () => {
    const { adapterModule, controllerModule } = await load();
    const stateFile = path.join(tmpDir, 'agent-home', 'p3394-adapter-malformed.json');
    writeStateFile(stateFile, JSON.stringify({
      schemaVersion: 1,
      sessions: [
        { mate_session_id: 'mate-session-phantom' }, // 缺 p3394_session_id
        { p3394_session_id: 'ses-ok', mate_session_id: 'mate-session-ok' },
      ],
      tasks: [{ mate_task_id: 'mate-task-phantom' }], // 缺 p3394_task_id
    }));
    const controller = controllerModule.createMateRuntimeController({ runtime: fakeRuntime() });
    const adapter = new adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller, stateFile });
    await adapter.openSession({ session_id: 'ses-new', agent_id: 'cogseed-agent' });
    await adapter.deliver(envelope({ session_id: 'ses-new', task_id: 'tsk-new' }) as never);

    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
      sessions: Array<{ p3394_session_id?: string; mate_session_id?: string }>;
      tasks: Array<{ p3394_task_id?: string; mate_task_id?: string }>;
    };
    for (const entry of parsed.sessions) {
      expect(typeof entry.p3394_session_id).toBe('string');
      expect(typeof entry.mate_session_id).toBe('string');
    }
    for (const entry of parsed.tasks) {
      expect(typeof entry.p3394_task_id).toBe('string');
      expect(typeof entry.mate_task_id).toBe('string');
    }
    expect(parsed.sessions.some((session) => session.mate_session_id === 'mate-session-phantom')).toBe(false);
    expect(parsed.tasks.some((task) => task.mate_task_id === 'mate-task-phantom')).toBe(false);
  });
});
