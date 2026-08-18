/**
 * 双 Bridge 进程级验收（C-06/C-09）的 Node B 子进程 fixture。
 *
 * 完整桥节点：Kernel + Registry + Executor + 真实 Runtime Adapter + HTTP
 * listener + §11 自动回发，Agent Home 由 P3394_CHILD_AGENT_HOME 指定。
 *
 * 流程：收到父进程（Node A）task → 真实执行 → episode 落盘到
 * P3394_CHILD_RESULT → 自动回发 response → 再主动向父进程发起一次
 * reverse task（P3394_CHILD_PARENT_ENDPOINT）→ 收到父的自动回发后写入
 * P3394_CHILD_REVERSE_RESULT → 退出（非 Hermes peer 双向任务闭环）。
 *
 * 环境：P3394_CHILD_PORT / P3394_CHILD_TOKEN / P3394_CHILD_AGENT_HOME /
 *       P3394_CHILD_RESULT / P3394_CHILD_PARENT_ENDPOINT /
 *       P3394_CHILD_PARENT_TOKEN / P3394_CHILD_REVERSE_RESULT /
 *       P3394_CHILD_STATE（可选：adapter 会话/任务映射持久化，供进程重启恢复）/
 *       P3394_CHILD_FAIL_DELIVERY（可选 N：前 N 次 onEvent 抛错，模拟对端
 *       断线 → executor 标记 recoverable → 恢复控制器 sweep 续读完成，R-08
 *       跨进程恢复注入）/
 *       P3394_CHILD_REPLAY_OUTBOX（可选 1：启动后重放 outbox 遗留的
 *       submitted/sent 信封——跨进程重启后的出站恢复，S-05 三方同框）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { P3394BridgeKernel } from '../../../../../src/main/features/p3394_bridge/bridge';
import { P3394BridgeExecutor } from '../../../../../src/main/features/p3394_bridge/executor';
import { buildP3394BridgeManifest } from '../../../../../src/main/features/p3394_bridge/manifest';
import { P3394HttpChannel } from '../../../../../src/main/features/p3394_bridge/http-channel';
import { P3394CogseedRuntimeAdapter } from '../../../../../src/main/features/p3394_bridge/cogseed-runtime-adapter';
import { P3394RecoveryController } from '../../../../../src/main/features/p3394_bridge/recovery-controller';
import { P3394OutboundHub, p3394EnvelopeReplyText } from '../../../../../src/main/features/p3394_bridge/outbound-hub';
import { createCogSeedRuntimeController } from '../../../../../src/main/features/cogseed_backend/runtime-controller';

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
  const parentEndpoint = (process.env.P3394_CHILD_PARENT_ENDPOINT || '').replace(/\/$/, '');
  const parentToken = process.env.P3394_CHILD_PARENT_TOKEN || '';
  const reverseResult = process.env.P3394_CHILD_REVERSE_RESULT || '';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !agentHome || !resultFile) {
    process.stderr.write('bridge-node-child: missing env (P3394_CHILD_PORT/AGENT_HOME/RESULT)\n');
    process.exit(2);
  }
  fs.mkdirSync(path.join(agentHome, 'sessions'), { recursive: true });

  const bridge = new P3394BridgeKernel();
  bridge.registry.register({ identity: { agent_id: 'child-node', display_name: 'ChildNode' }, manifest: manifestOf('child-node') });
  bridge.registry.register({
    identity: { agent_id: 'parent-node', display_name: 'ParentNode' },
    manifest: manifestOf('parent-node'),
    ...(parentEndpoint ? { endpoints: [parentEndpoint] } : {}),
    // 出站凭据：hub 建通道时携带 Bearer token（C-07 认证出站）。
    ...(parentToken ? { dial_token: parentToken } : {}),
  });
  // C-07/R-06：出站事务队列（outbox：submitted → sent → completed），
  // 回复命中 waiter 完成闭环。
  const outboundHub = new P3394OutboundHub({
    listPeers: () => bridge.registry.list(),
    replyTimeoutMs: 8000,
  });

  // 真实 Runtime Adapter：接 CogSeed Backend 会话/任务/事件存储与运行控制器，
  // 由 fake runtime run 生成多轮 delta 文本（长任务，R-05 跨进程事件流证据）。
  const childUserId = process.env.P3394_CHILD_USER_ID || 'p3394-child-node-user';
  const stateFile = process.env.P3394_CHILD_STATE || '';
  const controller = createCogSeedRuntimeController({
    runtime: {
      shutdown: async () => {},
      run: async function* () {
        for (const part of ['child answer one', 'child answer two', 'child answer three']) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          yield { type: 'event', status: 'running', text: part, metadata: {} };
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
        yield { type: 'result', status: 'completed', text: 'child answer three', metadata: {} };
      },
    } as never,
  });
  const runtime = new P3394CogseedRuntimeAdapter({
    userId: () => childUserId,
    controller,
    pollIntervalMs: 15,
    ...(stateFile ? { stateFile } : {}),
  });

  let reverseMessageId = '';
  let reverseTaskId = '';
  let reverseSent = false;

  // R-08 跨进程恢复注入：前 N 次 onEvent 抛错（模拟对端断线），随后
  // 由恢复控制器 sweep → resumeForward 续读完成。
  const failDelivery = Math.max(0, Number(process.env.P3394_CHILD_FAIL_DELIVERY || 0));
  let failDeliveryLeft = failDelivery;
  // 事件游标：每个确认送达的事件序列（只前进），恢复时从此续读。
  const cursors = new Map<string, number>();

  const executor = new P3394BridgeExecutor({
    bridge,
    runtime,
    outboundHub,
    selfIdentity: { agent_id: 'child-node', alias: 'ChildNode' },
    onEvent: (sessionId, event) => {
      if (failDeliveryLeft > 0) {
        failDeliveryLeft -= 1;
        throw new Error('p3394_injected_transport_failure');
      }
      const prev = cursors.get(event.task_id) ?? 0;
      if (event.sequence > prev) cursors.set(event.task_id, event.sequence);
      void sessionId;
    },
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
        // R-05：跨进程事件流证据——终态 episode 携带完整动作序列。
        actions: (episode.actions ?? []).map((action) => ({ kind: action.kind, text: action.text })),
      }));
      // 首任务终态 + 自动回发排空后，主动向父进程发起 reverse task（C-09 双向）。
      if (!reverseSent && parentEndpoint && reverseResult) {
        reverseSent = true;
        void sendReverseTask();
      }
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

  // R-08/S-05：自动恢复控制器——按持久化游标 sweep recoverable 任务。
  const recovery = new P3394RecoveryController(executor, {
    cursorFor: (taskId) => cursors.get(taskId) ?? 0,
    maxAttempts: 5,
  });
  const recoveryTimer = setInterval(() => { void recovery.sweep(); }, 250);
  recoveryTimer.unref();

  const channel = new P3394HttpChannel('child-http', { listen: { host: '127.0.0.1', port }, authToken: token });
  channel.setLocalManifest(manifestOf('child-node'));
  channel.subscribe((envelope) => {
    // reverse task 的回信（reply_to 指向其 message_id）：先让 outbound hub
    // 命中 waiter（sendAndWait 完成 outbox 闭环），再落盘证据。
    if (envelope.reply_to && envelope.reply_to === reverseMessageId) {
      outboundHub.tryResolveReply(envelope);
      if (reverseResult) {
        fs.writeFileSync(reverseResult, JSON.stringify({
          reply_to: envelope.reply_to,
          from: envelope.sender && envelope.sender.agent_id,
          reply_text: p3394EnvelopeReplyText(envelope),
        }));
      }
      return;
    }
    executor.execute(envelope);
  });
  await channel.listen();
  process.stdout.write('CHILD_READY\n');

  // S-05 跨进程出站恢复：启动后重放 outbox 遗留的 submitted/sent 信封
  // （对端按 idempotency_key 幂等，不重复执行）。
  if (process.env.P3394_CHILD_REPLAY_OUTBOX === '1') {
    const outcome = await outboundHub.replayOutbox();
    process.stdout.write('CHILD_OUTBOX_REPLAY ' + JSON.stringify(outcome) + '\n');
  }

  /** C-09/C-07：本节点主动向父进程发起一次任务，携带 reply_endpoint/reply_token。
   *  出站走事务 outbox（sendAndWait：submitted → sent → completed），
   *  回复由 subscribe → tryResolveReply 命中 waiter 完成闭环。 */
  async function sendReverseTask(): Promise<void> {
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const nonce = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      reverseMessageId = 'msg-reverse-' + nonce;
      reverseTaskId = 'task-reverse-' + nonce;
      const task = {
        spec_version: 'p3394/1.0',
        message_id: reverseMessageId,
        session_id: 'ses-reverse-' + nonce,
        task_id: reverseTaskId,
        kind: 'task',
        performative: 'request',
        sender: { agent_id: 'child-node' },
        recipients: [{ agent_id: 'parent-node' }],
        payload: { parts: [{ type: 'text', text: 'reverse task from child' }] },
        extensions: { reply_endpoint: `http://127.0.0.1:${port}`, reply_token: token },
        idempotency_key: 'idem-reverse-' + nonce,
      } as never;
      await outboundHub.sendAndWait('parent-node', task as never);
      // 回复由 subscribe 落盘 reverseResult；sendAndWait 返回即闭环完成。
    } catch (error) {
      process.stderr.write('bridge-node-child reverse task failed: ' + String(error) + '\n');
    }
  }

  // result + reverse result 都存在后退出；15s 兜底。
  const poll = setInterval(() => {
    const haveResult = fs.existsSync(resultFile);
    const haveReverse = !reverseResult || fs.existsSync(reverseResult);
    if (haveResult && haveReverse) {
      clearInterval(poll);
      setTimeout(() => process.exit(0), 500);
    }
  }, 50);
  setTimeout(() => process.exit(3), 15_000);
}

void main().catch((error) => {
  process.stderr.write('bridge-node-child error: ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)) + '\n');
  process.exit(1);
});

