/**
 * 双 Bridge 进程级验收（C-06）的 Node B 子进程 fixture。
 *
 * 完整桥节点：Kernel + Registry + Executor + runtime + HTTP listener +
 * §11 自动回发，Agent Home 由 P3394_CHILD_AGENT_HOME 指定；终态 episode
 * 写入 P3394_CHILD_RESULT 后短暂排空回发并退出。
 *
 * 环境：P3394_CHILD_PORT / P3394_CHILD_TOKEN / P3394_CHILD_AGENT_HOME /
 *       P3394_CHILD_RESULT
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { P3394BridgeKernel } from '../../../../../src/main/features/p3394_bridge/bridge';
import { P3394BridgeExecutor } from '../../../../../src/main/features/p3394_bridge/executor';
import { buildP3394BridgeManifest } from '../../../../../src/main/features/p3394_bridge/manifest';
import { P3394HttpChannel } from '../../../../../src/main/features/p3394_bridge/http-channel';
import type { P3394RuntimeAdapter, P3394RuntimeEvent, P3394RuntimeSessionBinding, P3394RuntimeSnapshot } from '../../../../../src/main/features/p3394_bridge/runtime-adapter';

function manifestOf(id: string) {
  const result = buildP3394BridgeManifest({
    agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

async function main(): Promise<void> {
  const port = Number(process.env.P3394_CHILD_PORT ?? '');
  const token = process.env.P3394_CHILD_TOKEN ?? 'child-token';
  const agentHome = process.env.P3394_CHILD_AGENT_HOME ?? '';
  const resultFile = process.env.P3394_CHILD_RESULT ?? '';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !agentHome || !resultFile) {
    process.stderr.write('bridge-node-child: missing env (P3394_CHILD_PORT/AGENT_HOME/RESULT)\n');
    process.exit(2);
  }
  fs.mkdirSync(path.join(agentHome, 'sessions'), { recursive: true });

  const bridge = new P3394BridgeKernel();
  bridge.registry.register({ identity: { agent_id: 'child-node', display_name: 'ChildNode' }, manifest: manifestOf('child-node') });
  bridge.registry.register({ identity: { agent_id: 'parent-node', display_name: 'ParentNode' }, manifest: manifestOf('parent-node') });

  let currentTaskId = '';
  const runtime: P3394RuntimeAdapter = {
    async openSession(input): Promise<P3394RuntimeSessionBinding> {
      return { session_id: input.session_id, native_session_id: 'native-' + input.session_id, agent_id: input.agent_id };
    },
    async deliver(envelope): Promise<{ task_id: string }> {
      currentTaskId = envelope.task_id || 'task-' + envelope.message_id;
      return { task_id: currentTaskId };
    },
    async *stream(): AsyncIterable<P3394RuntimeEvent> {
      yield { sequence: 1, task_id: currentTaskId, kind: 'started', data: {} };
      yield { sequence: 2, task_id: currentTaskId, kind: 'delta', data: { text: 'child answer' } };
      yield { sequence: 3, task_id: currentTaskId, kind: 'completed', data: {} };
    },
    async resume(): Promise<void> {},
    async cancel(): Promise<void> {},
    async snapshot(sessionId: string): Promise<P3394RuntimeSnapshot> {
      return { session_id: sessionId, native_session_id: 'native-' + sessionId, at: new Date().toISOString() };
    },
    async closeSession(): Promise<void> {},
  };

  const executor = new P3394BridgeExecutor({
    bridge,
    runtime,
    selfIdentity: { agent_id: 'child-node', alias: 'ChildNode' },
    sessionFileFor: (sessionId) => {
      const safe = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
      return safe ? path.join(agentHome, 'sessions', safe + '.json') : null;
    },
    recordEpisode: (episode) => {
      fs.writeFileSync(resultFile, JSON.stringify({
        status: episode.status,
        session_id: episode.session_id,
        task_id: episode.task_id,
        agent_id: episode.agent_id,
      }));
    },
    autoReply: {
      enabled: true,
      allowEndpoint: (endpoint) => {
        try {
          const url = new URL(endpoint);
          return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
        } catch {
          return false;
        }
      },
    },
  });

  const channel = new P3394HttpChannel('child-http', { listen: { host: '127.0.0.1', port }, authToken: token });
  channel.setLocalManifest(manifestOf('child-node'));
  channel.subscribe((envelope) => { executor.execute(envelope); });
  await channel.listen();
  process.stdout.write('CHILD_READY\n');

  // 终态证据落盘 + 自动回发排空后退出；10s 兜底退出。
  const poll = setInterval(() => {
    if (fs.existsSync(resultFile)) {
      clearInterval(poll);
      setTimeout(() => process.exit(0), 500);
    }
  }, 50);
  setTimeout(() => process.exit(3), 10_000);
}

void main().catch((error) => {
  process.stderr.write('bridge-node-child error: ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)) + '\n');
  process.exit(1);
});
