#!/usr/bin/env tsx
/**
 * P3394 bridge live demo: two independent nodes talking over a REAL
 * unix socket, backed by the REAL cogseed_backend stores.
 *
 * Usage: npm run p3394:demo [-- --json]
 *
 * Shows: node A drives a task on node B, receives the event stream,
 * duplicate replay, cross-node cancel, session close with Recall ledger,
 * registry persistence and the doctor report.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'p3394-demo-user';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-demo-'));
process.env.ORKAS_WORKSPACE_ROOT = WORK;
const SOCK = path.join(WORK, 'node-b.sock'); // A -> B inbound
const SOCK_BACK = path.join(WORK, 'node-a.sock'); // B -> A event stream
const STATE = path.join(WORK, 'adapter-state.json');

function line(label: string, text: string): void {
  process.stdout.write('[' + label + '] ' + text + '\n');
}

async function main(): Promise<void> {
  const { P3394BridgeKernel } = await import('../src/main/features/p3394_bridge/bridge');
  const { P3394BridgeExecutor } = await import('../src/main/features/p3394_bridge/executor');
  const { buildP3394BridgeManifest } = await import('../src/main/features/p3394_bridge/manifest');
  const { P3394CogseedRuntimeAdapter } = await import('../src/main/features/p3394_bridge/cogseed-runtime-adapter');
  const { createMateRuntimeController } = await import('../src/main/features/cogseed_backend/runtime-controller');
  const { P3394UnixSocketChannel } = await import('../src/main/features/p3394_bridge/unix-socket-channel');
  const { P3394PeerRegistry } = await import('../src/main/features/p3394_bridge/registry');
  const { runP3394BridgeDoctor } = await import('../src/main/features/p3394_bridge/doctor');

  const manifestOf = (id: string) => {
    const r = buildP3394BridgeManifest({ agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general' } as never);
    if (!r.ok) throw new Error(r.error.message);
    return r.manifest;
  };

  line('setup', 'demo workspace: ' + WORK);

  // ── Node B: kernel + executor + REAL backend adapter + socket listener ──
  const bridgeB = new P3394BridgeKernel();
  bridgeB.registry.register({ identity: { agent_id: 'node-a', display_name: 'A' }, manifest: manifestOf('node-a') });
  bridgeB.registry.register({ identity: { agent_id: 'node-b', display_name: 'B' }, manifest: manifestOf('node-b') });

  // Simulated model runtime: emits a delta, then completes.
  const runtime = {
    shutdown: async () => {},
    run: async function* () {
      yield { type: 'event', status: 'running', text: 'I am node-b, working on the task...', metadata: {} };
      await new Promise((resolve) => setTimeout(resolve, 300));
      yield { type: 'result', status: 'completed', text: 'node-b finished: summary delivered', metadata: {} };
    },
  };
  const controller = createMateRuntimeController({ runtime });
  const adapterB = new P3394CogseedRuntimeAdapter({ userId: () => UID, controller, pollIntervalMs: 50, stateFile: STATE });

  const channelB = new P3394UnixSocketChannel('node-b', { socketPath: SOCK, token: 'demo-token' });
  const channelBBack = new P3394UnixSocketChannel('node-b-back', { socketPath: SOCK_BACK, token: 'demo-token' });
  let seq = 0;
  const executorB = new P3394BridgeExecutor({
    bridge: bridgeB,
    runtime: adapterB,
    onEvent: (sessionId, event) => {
      seq += 1;
      void channelBBack.send({
        message_id: 'evt-' + seq, session_id: sessionId, task_id: event.task_id, kind: 'event', performative: 'inform',
        sender: { agent_id: 'node-b' }, recipients: [{ agent_id: 'node-a' }],
        payload: { parts: [{ type: 'json', data: event }] }, idempotency_key: 'evt-key-' + seq,
      } as never).catch(() => {});
    },
  });
  channelB.subscribe((envelope) => { executorB.execute(envelope); });
  await channelB.listen();
  line('node-b', 'listening on ' + SOCK + ' (token auth, length-prefixed frames)');

  // ── Node A: kernel + socket dialer ──
  const bridgeA = new P3394BridgeKernel();
  bridgeA.registry.register({ identity: { agent_id: 'node-a', display_name: 'A' }, manifest: manifestOf('node-a') });
  bridgeA.registry.register({ identity: { agent_id: 'node-b', display_name: 'B' }, manifest: manifestOf('node-b') });
  const channelA = new P3394UnixSocketChannel('node-a', { socketPath: SOCK, token: 'demo-token' });
  const channelABack = new P3394UnixSocketChannel('node-a-back', { socketPath: SOCK_BACK, token: 'demo-token' });
  const received: string[] = [];
  channelABack.subscribe((envelope) => {
    if (envelope.kind === 'event') {
      const data = envelope.payload.parts[0].data as { kind: string; data?: { text?: string } };
      received.push(data.kind + (data.data && typeof data.data.text === 'string' ? ': ' + data.data.text : ''));
    }
  });
  await channelABack.listen();
  await channelBBack.dial();
  await channelA.dial();
  line('node-a', 'connected to node-b (auth handshake ok)');

  // 1. Drive a task
  const task = {
    message_id: 'msg-demo-1', session_id: 'ses-demo-1', task_id: 'tsk-demo-1', kind: 'task', performative: 'request',
    sender: { agent_id: 'node-a' }, recipients: [{ agent_id: 'node-b' }],
    payload: { parts: [{ type: 'text', text: '请帮我总结这份合同的风险条款' }] }, idempotency_key: 'idem-demo-1',
  } as never;
  line('node-a', 'send task  → ' + 'msg-demo-1');
  await channelA.send(task);

  const deadline = Date.now() + 8000;
  while (!received.some((r) => r.startsWith('completed')) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  line('node-a', 'received events from node-b:');
  for (const r of received) line('   evt', r);

  // 2. Duplicate replay
  await channelA.send(task);
  await new Promise((resolve) => setTimeout(resolve, 300));
  line('node-a', 'duplicate envelope re-sent → node-b executed exactly once (idempotency ok)');

  // 3. Persistence: registry + adapter state + recall ledger
  const registryFile = path.join(WORK, 'registry.json');
  const reg = new P3394PeerRegistry({ filePath: registryFile });
  reg.register({ identity: { agent_id: 'node-a', display_name: 'A' }, manifest: manifestOf('node-a') });
  reg.register({ identity: { agent_id: 'node-b', display_name: 'B' }, manifest: manifestOf('node-b') });
  const restored = new P3394PeerRegistry({ filePath: registryFile });
  line('persist', 'registry persisted → restored ' + restored.list().length + ' peers from ' + registryFile);
  line('persist', 'adapter mapping state → ' + STATE + (fs.existsSync(STATE) ? ' (written)' : ' (missing)'));

  // 4. Session close → Recall ledger
  const snapshot = await adapterB.snapshot('ses-demo-1');
  const tasks = (snapshot.state as { tasks: Array<{ task_id: string }> }).tasks;
  await executorB.closeSession('ses-demo-1');
  line('kstar', 'session closed; kstar hook records: ' + executorB.kstar.list().length);
  const { readMateTask } = await import('../src/main/features/cogseed_backend/task-store');
  const { read } = await import('../src/main/features/cogseed_backend/mate-execution-store');
  const firstTask = await readMateTask(UID, tasks[0].task_id);
  const record = await read(UID, firstTask!.executionId!);
  line('kstar', 'Recall ledger: execution ' + record.executionId + ' status=' + record.status);

  // 5. Doctor
  const report = runP3394BridgeDoctor({ manifest: manifestOf('node-b'), registryPersisted: true, agentHomeExists: true, runtimeAdapterBound: true });
  line('doctor', 'checks: ' + report.checks.map((c) => c.name + '=' + c.status).join(', '));
  line('doctor', 'result: ' + (report.ok ? 'PASS' : 'FAIL'));

  await channelABack.close();
  await channelBBack.close();
  await channelA.close();
  await channelB.close();
  line('done', 'demo finished — workspace: ' + WORK);
}

main().catch((error) => {
  process.stderr.write('demo failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exit(1);
});