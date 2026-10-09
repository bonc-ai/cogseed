/**
 * M-05 / §12 跨 Channel artifact 总量闭环：发送方（Node B）真实对象存储
 * 落盘 artifact 字节 → 事件流携带 p3394-object 引用 → 自动回发 artifact
 * 信封（引用 + digest）→ 接收方（Node A）通过发送方 HTTP 资源端点
 * （/p3394/objects/<digest>，Bearer 认证）拉取真实字节 → sha256 校验一致。
 *
 * 对象字节只走内容寻址引用跨节点传输，总量由 digest 白名单 + 认证端点
 * 约束（fail-closed）。
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { P3394BridgeKernel } from '../../../../src/main/features/p3394_bridge/bridge';
import { P3394BridgeExecutor } from '../../../../src/main/features/p3394_bridge/executor';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';
import { buildP3394BridgeManifest } from '../../../../src/main/features/p3394_bridge/manifest';
import { p3394ObjectStorePut } from '../../../../src/main/features/p3394_bridge/object-store';
import type { P3394RuntimeAdapter, P3394RuntimeEvent, P3394RuntimeSessionBinding, P3394RuntimeSnapshot } from '../../../../src/main/features/p3394_bridge/runtime-adapter';

let counter = 0;
const openChannels: P3394HttpChannel[] = [];

function nextPort(): number {
  counter += 1;
  return 46_800 + counter;
}

function manifest(agentId: string) {
  const result = buildP3394BridgeManifest({
    agent_id: agentId, name: agentId, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

function stubRuntime(taskId: string, events: P3394RuntimeEvent[]): P3394RuntimeAdapter {
  return {
    async openSession(input): Promise<P3394RuntimeSessionBinding> {
      return { session_id: input.session_id, native_session_id: 'native-' + input.session_id, agent_id: input.agent_id };
    },
    async deliver(): Promise<{ task_id: string }> { return { task_id: taskId }; },
    async *stream(): AsyncIterable<P3394RuntimeEvent> { yield* events; },
    async resume(): Promise<void> {},
    async cancel(): Promise<void> {},
    async snapshot(sessionId: string): Promise<P3394RuntimeSnapshot> {
      return { session_id: sessionId, native_session_id: 'native-' + sessionId, at: new Date().toISOString() };
    },
    async closeSession(): Promise<void> {},
  };
}

function getObject(port: number, digest: string, token: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/p3394/objects/' + digest, method: 'GET', headers: { Authorization: 'Bearer ' + token } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

afterEach(async () => {
  for (const channel of openChannels.splice(0)) await channel.close().catch(() => {});
});

describe('P3394 artifact object loop across HTTP channels (M-05/§12)', () => {
  it('对象引用自动回发 → 对端经认证资源端点拉取真实字节 → digest 校验一致', async () => {
    const portA = nextPort();
    const portB = nextPort();
    const objectBytes = 'real artifact bytes stored in object store';
    const put = p3394ObjectStorePut(objectBytes);
    if (!put.ok) throw new Error(put.error);
    const { digest, uri } = put.value;
    const taskId = 'tsk-art-loop';

    // Node B：发送方——事件流携带真实对象引用，自动回发 artifact 信封。
    const bridgeB = new P3394BridgeKernel();
    bridgeB.registry.register({ identity: { agent_id: 'node-b', display_name: 'B' }, manifest: manifest('node-b') });
    bridgeB.registry.register({ identity: { agent_id: 'node-a', display_name: 'A' }, manifest: manifest('node-a') });
    const executorB = new P3394BridgeExecutor({
      bridge: bridgeB,
      runtime: stubRuntime(taskId, [
        { sequence: 1, task_id: taskId, kind: 'started', data: {} },
        { sequence: 2, task_id: taskId, kind: 'artifact', data: { uri, digest, name: 'payload.bin', media_type: 'application/octet-stream' } },
        { sequence: 3, task_id: taskId, kind: 'completed', data: {} },
      ]),
      selfIdentity: { agent_id: 'node-b', alias: 'B' },
    });
    const channelB = new P3394HttpChannel('node-b-http', { listen: { host: '127.0.0.1', port: portB }, authToken: 'b-token' });
    channelB.setLocalManifest(manifest('node-b'));
    channelB.subscribe((envelope) => { executorB.execute(envelope); });
    await channelB.listen();
    openChannels.push(channelB);

    // Node A：接收方——收到 artifact 回发后从 B 的资源端点拉取真实字节。
    const bridgeA = new P3394BridgeKernel();
    bridgeA.registry.register({ identity: { agent_id: 'node-a', display_name: 'A' }, manifest: manifest('node-a') });
    bridgeA.registry.register({ identity: { agent_id: 'node-b', display_name: 'B' }, manifest: manifest('node-b') });
    const executorA = new P3394BridgeExecutor({ bridge: bridgeA, runtime: stubRuntime('tsk-a', []) });
    const receivedArtifacts: Array<{ uri?: string; digest?: string }> = [];
    const channelA = new P3394HttpChannel('node-a-http', { listen: { host: '127.0.0.1', port: portA }, authToken: 'a-token' });
    channelA.setLocalManifest(manifest('node-a'));
    channelA.subscribe((envelope) => {
      if (envelope.kind === 'artifact') {
        const part = (envelope.payload.parts ?? [])[0] as { uri?: string; digest?: string } | undefined;
        receivedArtifacts.push({ uri: part?.uri, digest: part?.digest });
        return;
      }
      executorA.execute(envelope);
    });
    await channelA.listen();
    openChannels.push(channelA);

    // A → B 发送 task（携带 reply_endpoint 指向 A）。
    const dialer = new P3394HttpChannel('node-a-dial', {
      dial: { endpoints: [`http://127.0.0.1:${portB}`], bearerToken: 'b-token', expected_identity: 'node-b' },
    });
    openChannels.push(dialer);
    await dialer.dial('node-b');
    await dialer.send({
      spec_version: 'p3394/1.0',
      message_id: 'msg-art-loop-1',
      session_id: 'ses-art-loop-1',
      task_id: taskId,
      kind: 'task',
      performative: 'request',
      sender: { agent_id: 'node-a' },
      recipients: [{ agent_id: 'node-b' }],
      payload: { parts: [{ type: 'text', text: 'send me the artifact' }] },
      extensions: { reply_endpoint: `http://127.0.0.1:${portA}`, reply_token: 'a-token' },
      idempotency_key: 'idem-art-loop-1',
    } as never);

    // A 收到 artifact 自动回发（引用 + digest）。
    const deadline = Date.now() + 8000;
    while (receivedArtifacts.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(receivedArtifacts).toHaveLength(1);
    const ref = receivedArtifacts[0];
    expect(ref.digest).toBe(digest);
    expect(ref.uri).toBe(uri);

    // A 经 B 的认证资源端点拉取真实字节并校验 digest。
    const fetched = await getObject(portB, digest, 'b-token');
    expect(fetched.status).toBe(200);
    expect(fetched.body.toString('utf8')).toBe(objectBytes);
    expect(crypto.createHash('sha256').update(fetched.body).digest('hex')).toBe(digest);

    // 无认证拉取被拒（总量边界：对象只能经认证端点获取）。
    const unauth = await getObject(portB, digest, 'wrong-token');
    expect(unauth.status).toBe(401);
  }, 15_000);
});
