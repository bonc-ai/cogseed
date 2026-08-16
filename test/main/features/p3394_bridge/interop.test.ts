import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UID = 'p3394-interop-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;
let counter = 0;

function sockPath(prefix: string): string {
  counter += 1;
  return path.join(tmpDir, prefix + '-' + process.pid + '-' + counter + '.sock');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-interop-'));
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
  const bridgeModule = await import('../../../../src/main/features/p3394_bridge/bridge');
  const executorModule = await import('../../../../src/main/features/p3394_bridge/executor');
  const manifestModule = await import('../../../../src/main/features/p3394_bridge/manifest');
  const adapterModule = await import('../../../../src/main/features/p3394_bridge/cogseed-runtime-adapter');
  const controllerModule = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
  const socketModule = await import('../../../../src/main/features/p3394_bridge/unix-socket-channel');
  return { bridgeModule, executorModule, manifestModule, adapterModule, controllerModule, socketModule };
}

function manifest(module: typeof import('../../../../src/main/features/p3394_bridge/manifest'), id: string) {
  const result = module.buildP3394BridgeManifest({
    agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

function envelope(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-interop-' + counter,
    session_id: 'ses-interop-1',
    task_id: 'tsk-interop-' + counter,
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'node-a' },
    recipients: [{ agent_id: 'node-b' }],
    payload: { parts: [{ type: 'text', text: 'interop task' }] },
    idempotency_key: 'idem-interop-' + counter,
    ...overrides,
  } as never;
}

function eventEnvelope(sessionId: string, taskId: string, event: unknown, seq: number) {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'evt-' + seq,
    session_id: sessionId,
    task_id: taskId,
    kind: 'event',
    performative: 'inform',
    sender: { agent_id: 'node-b' },
    recipients: [{ agent_id: 'node-a' }],
    payload: { parts: [{ type: 'json', data: event }] },
    idempotency_key: 'evt-key-' + seq,
  } as never;
}

async function waitFor(probe: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('P3394 peer-to-peer interoperability (Phase 5)', () => {
  it('node A drives a task on node B and receives the event stream back', async () => {
    const m = await load();
    const inbound = sockPath('ab-in');   // A -> B
    const outbound = sockPath('ab-out'); // B -> A

    const bridgeB = new m.bridgeModule.P3394BridgeKernel();
    bridgeB.registry.register({ identity: { agent_id: 'node-a', display_name: 'A' }, manifest: manifest(m.manifestModule, 'node-a') });
    bridgeB.registry.register({ identity: { agent_id: 'node-b', display_name: 'B' }, manifest: manifest(m.manifestModule, 'node-b') });

    const runtimeB = { shutdown: async () => {}, run: vi.fn(async function* () {
      yield { type: 'event', status: 'running', text: 'working...', metadata: {} };
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield {
        type: 'event',
        status: 'running',
        text: '',
        metadata: {
          kernel_event: 'artifact',
          uri: 'p3394-object:sha256:' + 'a'.repeat(64),
          digest: 'a'.repeat(64),
          name: 'report.md',
          media_type: 'text/markdown',
          secret: 'must-not-cross',
        },
      };
      yield { type: 'result', status: 'completed', text: 'node-b answer', metadata: {} };
    }) };
    const controllerB = m.controllerModule.createMateRuntimeController({ runtime: runtimeB });
    const adapterB = new m.adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller: controllerB, pollIntervalMs: 20 });

    const channelBIn = new m.socketModule.P3394UnixSocketChannel('node-b-in', { socketPath: inbound, token: 'tok' });
    const channelBOut = new m.socketModule.P3394UnixSocketChannel('node-b-out', { socketPath: outbound, token: 'tok' });
    let eventSeq = 0;
    const executorB = new m.executorModule.P3394BridgeExecutor({
      bridge: bridgeB,
      runtime: adapterB,
      onEvent: (sessionId, event) => {
        eventSeq += 1;
        void channelBOut.send(eventEnvelope(sessionId, event.task_id, event, eventSeq)).catch(() => {});
      },
    });
    channelBIn.subscribe((envelope) => { executorB.execute(envelope); });
    await channelBIn.listen();

    const bridgeA = new m.bridgeModule.P3394BridgeKernel();
    bridgeA.registry.register({ identity: { agent_id: 'node-a', display_name: 'A' }, manifest: manifest(m.manifestModule, 'node-a') });
    bridgeA.registry.register({ identity: { agent_id: 'node-b', display_name: 'B' }, manifest: manifest(m.manifestModule, 'node-b') });
    const channelAIn = new m.socketModule.P3394UnixSocketChannel('node-a-in', { socketPath: outbound, token: 'tok' });
    const channelAOut = new m.socketModule.P3394UnixSocketChannel('node-a-out', { socketPath: inbound, token: 'tok' });
    const receivedEvents: unknown[] = [];
    channelAIn.subscribe((envelope) => {
      if (envelope.kind === 'event') receivedEvents.push(envelope.payload.parts[0].data);
    });
    // Node A must listen on the outbound socket BEFORE node B dials it.
    await channelAIn.listen();
    await channelBOut.dial();
    await channelAOut.dial();

    await channelAOut.send(envelope());
    await waitFor(() => {
      const kinds = (receivedEvents as Array<{ kind: string }>).map((e) => e.kind);
      return kinds.includes('completed');
    });

    const kinds = (receivedEvents as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds).toContain('started');
    expect(kinds).toContain('delta');
    expect(kinds).toContain('artifact');
    const artifact = receivedEvents.find((event) => (event as { kind: string }).kind === 'artifact') as { data?: Record<string, unknown> } | undefined;
    expect(artifact?.data).toMatchObject({
      uri: 'p3394-object:sha256:' + 'a'.repeat(64),
      digest: 'a'.repeat(64),
      name: 'report.md',
      media_type: 'text/markdown',
    });
    expect(artifact?.data).not.toHaveProperty('secret');
    expect(kinds[kinds.length - 1]).toBe('completed');
    expect(executorB.tasks.require((receivedEvents[0] as { task_id: string }).task_id).state).toBe('completed');

    await channelAIn.close();
    await channelAOut.close();
    await channelBIn.close();
    await channelBOut.close();
  });

  /*
   * Event cursor continuation is covered at the Runtime Adapter and Executor
   * contract layers. A full live-channel version is intentionally not kept
   * here until the peer-side recovery controller owns the reconnect lifecycle.
   */
  /* it('resumes event delivery after channel loss without re-sending the first event', async () => {
    const m = await load();
    const inbound = sockPath('cursor-in');
    const outbound = sockPath('cursor-out');
    const bridgeB = new m.bridgeModule.P3394BridgeKernel();
    bridgeB.registry.register({ identity: { agent_id: 'node-a', display_name: 'A' }, manifest: manifest(m.manifestModule, 'node-a') });
    bridgeB.registry.register({ identity: { agent_id: 'node-b', display_name: 'B' }, manifest: manifest(m.manifestModule, 'node-b') });
    const runtimeB = { shutdown: async () => {}, run: vi.fn(async function* () {
      yield { type: 'event', status: 'running', text: 'working...', metadata: {} };
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield { type: 'result', status: 'completed', text: 'recovered answer', metadata: {} };
    }) };
    const controllerB = m.controllerModule.createMateRuntimeController({ runtime: runtimeB });
    const adapterB = new m.adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller: controllerB, pollIntervalMs: 10 });
    const channelBIn = new m.socketModule.P3394UnixSocketChannel('cursor-node-b-in', { socketPath: inbound, token: 'tok' });
    let channelBOut = new m.socketModule.P3394UnixSocketChannel('cursor-node-b-out-1', { socketPath: outbound, token: 'tok' });
    const receivedEvents: Array<{ kind: string; sequence: number }> = [];
    const channelAIn = new m.socketModule.P3394UnixSocketChannel('cursor-node-a-in', { socketPath: outbound, token: 'tok' });
    channelAIn.subscribe((received) => {
      if (received.kind === 'event') {
        const data = received.payload.parts[0].data as { kind: string; sequence: number };
        receivedEvents.push(data);
      }
    });
    await channelAIn.listen();
    await channelBOut.dial();
    let firstEvent: Promise<void> | null = null;
    let firstEventResolve: (() => void) | null = null;
    let resumed = false;
    firstEvent = new Promise<void>((resolve) => { firstEventResolve = resolve; });
    const executorB = new m.executorModule.P3394BridgeExecutor({
      bridge: bridgeB,
      runtime: adapterB,
      onEvent: async (sessionId, event) => {
        if (event.sequence === 1) {
          firstEventResolve?.();
          await channelBOut.send(eventEnvelope(sessionId, event.task_id, event, event.sequence));
          return;
        }
        if (resumed) await channelBOut.send(eventEnvelope(sessionId, event.task_id, event, event.sequence));
      },
    });
    channelBIn.subscribe((received) => { executorB.execute(received); });
    await channelBIn.listen();
    const channelAOut = new m.socketModule.P3394UnixSocketChannel('cursor-node-a-out', { socketPath: inbound, token: 'tok' });
    await channelAOut.dial();
    await channelAOut.send(envelope({ message_id: 'msg-cursor-recovery', task_id: 'tsk-cursor-recovery', idempotency_key: 'idem-cursor-recovery' }));
    await firstEvent;
    await channelBOut.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(receivedEvents.map((event) => event.sequence)).toEqual([1]);

    channelBOut = new m.socketModule.P3394UnixSocketChannel('cursor-node-b-out-2', { socketPath: outbound, token: 'tok' });
    await channelBOut.dial();
    resumed = true;
    await executorB.resumeForward('tsk-cursor-recovery', 'ses-interop-1', 1);
    await waitFor(() => receivedEvents.some((event) => event.kind === 'completed'));
    expect(receivedEvents.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(runtimeB.run).toHaveBeenCalledTimes(1);
    await channelAOut.close();
    await channelAIn.close();
    await channelBIn.close();
    await channelBOut.close();
  }); */

  /* Experimental live reconnect fixture remains disabled until the Channel
   * owns reconnect/replay coordination instead of the test callback.
   */
  /* it('recovers a live event stream after Unix Socket loss without re-delivery', async () => {
    const m = await load();
    const inbound = sockPath('cursor-live-in');
    const outbound = sockPath('cursor-live-out');
    const bridgeB = new m.bridgeModule.P3394BridgeKernel();
    bridgeB.registry.register({ identity: { agent_id: 'node-a', display_name: 'A' }, manifest: manifest(m.manifestModule, 'node-a') });
    bridgeB.registry.register({ identity: { agent_id: 'node-b', display_name: 'B' }, manifest: manifest(m.manifestModule, 'node-b') });
    const runtimeB = { shutdown: async () => {}, run: vi.fn(async function* () {
      yield { type: 'event', status: 'running', text: 'working...', metadata: {} };
      yield { type: 'event', status: 'running', text: 'continued', metadata: {} };
      yield { type: 'result', status: 'completed', text: 'done', metadata: {} };
    }) };
    const controllerB = m.controllerModule.createMateRuntimeController({ runtime: runtimeB });
    const adapterB = new m.adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller: controllerB, pollIntervalMs: 10 });
    const channelBIn = new m.socketModule.P3394UnixSocketChannel('cursor-live-b-in', { socketPath: inbound, token: 'tok' });
    let channelBOut = new m.socketModule.P3394UnixSocketChannel('cursor-live-b-out-1', { socketPath: outbound, token: 'tok' });
    const receivedEvents: Array<{ kind: string; sequence: number }> = [];
    const channelAIn = new m.socketModule.P3394UnixSocketChannel('cursor-live-a-in', { socketPath: outbound, token: 'tok' });
    channelAIn.subscribe((received) => {
      if (received.kind === 'event') receivedEvents.push(received.payload.parts[0].data as { kind: string; sequence: number });
    });
    await channelAIn.listen();
    await channelBOut.dial();
    let firstEventSeen: (() => void) | null = null;
    const firstEvent = new Promise<void>((resolve) => { firstEventSeen = resolve; });
    const executorB = new m.executorModule.P3394BridgeExecutor({
      bridge: bridgeB,
      runtime: adapterB,
      onEvent: async (sessionId, event) => {
        await channelBOut.send(eventEnvelope(sessionId, event.task_id, event, event.sequence));
        if (event.sequence === 1) {
          firstEventSeen?.();
          await channelBOut.close();
        }
      },
    });
    channelBIn.subscribe((received) => { executorB.execute(received); });
    await channelBIn.listen();
    const channelAOut = new m.socketModule.P3394UnixSocketChannel('cursor-live-a-out', { socketPath: inbound, token: 'tok' });
    await channelAOut.dial();
    const task = envelope({ message_id: 'msg-cursor-live', task_id: 'tsk-cursor-live', idempotency_key: 'idem-cursor-live' });
    await channelAOut.send(task);
    await firstEvent;
    await waitFor(() => executorB.tasks.require('tsk-cursor-live').state === 'recoverable');
    expect(receivedEvents.map((event) => event.sequence)).toEqual([1]);
    expect(runtimeB.run).toHaveBeenCalledTimes(1);

    channelBOut = new m.socketModule.P3394UnixSocketChannel('cursor-live-b-out-2', { socketPath: outbound, token: 'tok' });
    await channelBOut.dial();
    await executorB.resumeForward('tsk-cursor-live', 'ses-interop-1', 1);
    await waitFor(() => executorB.tasks.require('tsk-cursor-live').state === 'completed');
    expect(receivedEvents.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(runtimeB.run).toHaveBeenCalledTimes(1);
    await channelAIn.close();
    await channelAOut.close();
    await channelBIn.close();
    await channelBOut.close();
  }); */

  it('duplicate envelopes are replayed-rejected and executed exactly once', async () => {
    const m = await load();
    const inbound = sockPath('dup-in');
    const bridgeB = new m.bridgeModule.P3394BridgeKernel();
    bridgeB.registry.register({ identity: { agent_id: 'node-a', display_name: 'A' }, manifest: manifest(m.manifestModule, 'node-a') });
    bridgeB.registry.register({ identity: { agent_id: 'node-b', display_name: 'B' }, manifest: manifest(m.manifestModule, 'node-b') });
    const runtimeB = { shutdown: async () => {}, run: vi.fn(async function* () {
      yield { type: 'result', status: 'completed', text: 'once', metadata: {} };
    }) };
    const controllerB = m.controllerModule.createMateRuntimeController({ runtime: runtimeB });
    const adapterB = new m.adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller: controllerB, pollIntervalMs: 20 });
    const channelB = new m.socketModule.P3394UnixSocketChannel('node-b', { socketPath: inbound, token: 'tok' });
    const executorB = new m.executorModule.P3394BridgeExecutor({ bridge: bridgeB, runtime: adapterB });
    channelB.subscribe((envelope) => { executorB.execute(envelope); });
    await channelB.listen();

    const channelA = new m.socketModule.P3394UnixSocketChannel('node-a', { socketPath: inbound, token: 'tok' });
    await channelA.dial();
    const first = envelope();
    await channelA.send(first);
    await channelA.send(first);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(runtimeB.run).toHaveBeenCalledTimes(1);
    // Exactly one task was admitted (first submission only).
    expect(executorB.tasks.require((first as { task_id: string }).task_id).state).toBe('completed');
    await channelA.close();
    await channelB.close();
  });

  it('recovers after a mid-session socket disconnect without duplicate execution', async () => {
    const m = await load();
    const inbound = sockPath('recover-in');
    const bridgeB = new m.bridgeModule.P3394BridgeKernel();
    bridgeB.registry.register({ identity: { agent_id: 'node-a', display_name: 'A' }, manifest: manifest(m.manifestModule, 'node-a') });
    bridgeB.registry.register({ identity: { agent_id: 'node-b', display_name: 'B' }, manifest: manifest(m.manifestModule, 'node-b') });
    const runtimeB = { shutdown: async () => {}, run: vi.fn(async function* () {
      yield { type: 'result', status: 'completed', text: 'once after recovery', metadata: {} };
    }) };
    const controllerB = m.controllerModule.createMateRuntimeController({ runtime: runtimeB });
    const adapterB = new m.adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller: controllerB, pollIntervalMs: 20 });
    const channelB1 = new m.socketModule.P3394UnixSocketChannel('node-b-1', { socketPath: inbound, token: 'tok', reconnectBaseMs: 30 });
    const executorB = new m.executorModule.P3394BridgeExecutor({ bridge: bridgeB, runtime: adapterB });
    channelB1.subscribe((received) => { executorB.execute(received); });
    await channelB1.listen();

    const channelA = new m.socketModule.P3394UnixSocketChannel('node-a-recover', { socketPath: inbound, token: 'tok', reconnectBaseMs: 30 });
    await channelA.dial();
    const task = envelope({ message_id: 'msg-recover-interop', task_id: 'tsk-recover-interop', idempotency_key: 'idem-recover-interop' });
    await channelA.send(task);
    await waitFor(() => {
      try { return executorB.tasks.require('tsk-recover-interop').state === 'completed'; } catch { return false; }
    });
    expect(runtimeB.run).toHaveBeenCalledTimes(1);

    await channelB1.close();
    const channelB2 = new m.socketModule.P3394UnixSocketChannel('node-b-2', { socketPath: inbound, token: 'tok', reconnectBaseMs: 30 });
    channelB2.subscribe((received) => { executorB.execute(received); });
    await channelB2.listen();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await channelA.send(task);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(runtimeB.run).toHaveBeenCalledTimes(1);
    expect(executorB.tasks.require('tsk-recover-interop').state).toBe('completed');
    await channelA.close();
    await channelB2.close();
  });

  it('cross-node cancel stops a running task and settles it cancelled', async () => {
    const m = await load();
    const inbound = sockPath('cancel-in');
    const bridgeB = new m.bridgeModule.P3394BridgeKernel();
    bridgeB.registry.register({ identity: { agent_id: 'node-a', display_name: 'A' }, manifest: manifest(m.manifestModule, 'node-a') });
    bridgeB.registry.register({ identity: { agent_id: 'node-b', display_name: 'B' }, manifest: manifest(m.manifestModule, 'node-b') });
    const runtimeB = { shutdown: async () => {}, run: vi.fn(async function* () {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        yield { type: 'event', status: 'running', text: 'still going', metadata: {} };
      }
    }) };
    const controllerB = m.controllerModule.createMateRuntimeController({ runtime: runtimeB });
    const adapterB = new m.adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller: controllerB, pollIntervalMs: 20 });
    const channelB = new m.socketModule.P3394UnixSocketChannel('node-b', { socketPath: inbound, token: 'tok' });
    const executorB = new m.executorModule.P3394BridgeExecutor({ bridge: bridgeB, runtime: adapterB });
    channelB.subscribe((envelope) => { executorB.execute(envelope); });
    await channelB.listen();

    const channelA = new m.socketModule.P3394UnixSocketChannel('node-a', { socketPath: inbound, token: 'tok' });
    await channelA.dial();
    const task = envelope();
    await channelA.send(task);
    await new Promise((resolve) => setTimeout(resolve, 100));

    await channelA.send({
      spec_version: 'p3394/1.0', message_id: 'ctl-cancel-1', session_id: 'ses-interop-1', task_id: (task as { task_id: string }).task_id,
      kind: 'control', performative: 'cancel', sender: { agent_id: 'node-a' }, recipients: [{ agent_id: 'node-b' }],
      payload: { parts: [{ type: 'control', data: { action: 'cancel' } }] }, idempotency_key: 'ctl-cancel-key-1',
    } as never);
    await waitFor(() => executorB.tasks.require((task as { task_id: string }).task_id).state === 'cancelled');
    expect(executorB.tasks.require((task as { task_id: string }).task_id).state).toBe('cancelled');
    await channelA.close();
    await channelB.close();
  });

  it('session close records KSTAR hook + Recall ledger on the executing node', async () => {
    const m = await load();
    const inbound = sockPath('kstar-in');
    const bridgeB = new m.bridgeModule.P3394BridgeKernel();
    bridgeB.registry.register({ identity: { agent_id: 'node-a', display_name: 'A' }, manifest: manifest(m.manifestModule, 'node-a') });
    bridgeB.registry.register({ identity: { agent_id: 'node-b', display_name: 'B' }, manifest: manifest(m.manifestModule, 'node-b') });
    const runtimeB = { shutdown: async () => {}, run: vi.fn(async function* () {
      yield { type: 'result', status: 'completed', text: 'done', metadata: {} };
    }) };
    const controllerB = m.controllerModule.createMateRuntimeController({ runtime: runtimeB });
    const adapterB = new m.adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller: controllerB, pollIntervalMs: 20 });
    const channelB = new m.socketModule.P3394UnixSocketChannel('node-b', { socketPath: inbound, token: 'tok' });
    const executorB = new m.executorModule.P3394BridgeExecutor({ bridge: bridgeB, runtime: adapterB });
    channelB.subscribe((envelope) => { executorB.execute(envelope); });
    await channelB.listen();

    const channelA = new m.socketModule.P3394UnixSocketChannel('node-a', { socketPath: inbound, token: 'tok' });
    await channelA.dial();
    const task = envelope();
    await channelA.send(task);
    // Wait until the executing node has opened the session and registered the
    // forward before awaiting it (channel delivery is asynchronous).
    await waitFor(() => {
      try {
        executorB.sessions.require('ses-interop-1');
        return true;
      } catch {
        return false;
      }
    });
    await executorB.awaitForward((task as { task_id: string }).task_id);

    // Capture the mapping snapshot BEFORE closing (close releases it).
    const snapshot = await adapterB.snapshot('ses-interop-1');
    const tasks = snapshot.state as { tasks: Array<{ task_id: string }> };
    expect(tasks.tasks.length).toBeGreaterThan(0);
    const mateTaskId = tasks.tasks[0].task_id;

    await executorB.closeSession('ses-interop-1');
    expect(executorB.sessions.require('ses-interop-1').state).toBe('closed');
    expect(executorB.kstar.list()).toHaveLength(1);
    await expect(adapterB.snapshot('ses-interop-1')).rejects.toThrow('p3394_session_not_found');

    const executionModule = await import('../../../../src/main/features/cogseed_backend/mate-execution-store');
    const taskStore = await import('../../../../src/main/features/cogseed_backend/task-store');
    const taskRecord = await taskStore.readMateTask(UID, mateTaskId);
    const record = await executionModule.read(UID, taskRecord!.executionId!);
    expect(record.status).toBe('completed');

    await channelA.close();
    await channelB.close();
  });

  it('rejects envelopes with digest mismatch at the socket layer (fail closed)', async () => {
    const m = await load();
    const inbound = sockPath('digest-in');
    const bridgeB = new m.bridgeModule.P3394BridgeKernel();
    bridgeB.registry.register({ identity: { agent_id: 'node-a', display_name: 'A' }, manifest: manifest(m.manifestModule, 'node-a') });
    bridgeB.registry.register({ identity: { agent_id: 'node-b', display_name: 'B' }, manifest: manifest(m.manifestModule, 'node-b') });
    const runtimeB = { shutdown: async () => {}, run: vi.fn(async function* () {}) };
    const controllerB = m.controllerModule.createMateRuntimeController({ runtime: runtimeB });
    const adapterB = new m.adapterModule.P3394CogseedRuntimeAdapter({ userId: () => UID, controller: controllerB, pollIntervalMs: 20 });
    const channelB = new m.socketModule.P3394UnixSocketChannel('node-b', { socketPath: inbound, token: 'tok' });
    const seen: string[] = [];
    channelB.subscribe((e) => seen.push(e.message_id));
    await channelB.listen();

    const channelA = new m.socketModule.P3394UnixSocketChannel('node-a', { socketPath: inbound, token: 'tok' });
    await channelA.dial();
    const bad = envelope({
      message_id: 'msg-bad-digest',
      payload: { parts: [{ type: 'resource', uri: 'p3394-object:sha256:x', digest: '0'.repeat(64) }] },
    });
    await channelA.send(bad).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).not.toContain('msg-bad-digest');
    await channelA.close();
    await channelB.close();
  });
});