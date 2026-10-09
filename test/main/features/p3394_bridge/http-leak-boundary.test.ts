/**
 * M-06 / S-04 跨 Channel 泄漏 fixture：真实 HTTP 入站全链路（listener →
 * 内核校验 → 审计）中，信封携带的 secret（Authorization token、payload
 * metadata 里的 token/api_key）不得进入 audit journal；关联 id
 * （session/task/message）保持可追溯。
 */

import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { P3394BridgeKernel } from '../../../../src/main/features/p3394_bridge/bridge';
import { P3394BridgeExecutor } from '../../../../src/main/features/p3394_bridge/executor';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';
import { buildP3394BridgeManifest } from '../../../../src/main/features/p3394_bridge/manifest';
import type { P3394RuntimeAdapter, P3394RuntimeEvent, P3394RuntimeSessionBinding, P3394RuntimeSnapshot } from '../../../../src/main/features/p3394_bridge/runtime-adapter';

let counter = 0;
const openChannels: P3394HttpChannel[] = [];

function nextPort(): number {
  counter += 1;
  return 46_600 + counter;
}

function manifest(agentId: string) {
  const result = buildP3394BridgeManifest({
    agent_id: agentId, name: agentId, description_zh: '', description_en: '', workflow: '', category: 'general',
  } as never);
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

function stubRuntime(taskId: string): P3394RuntimeAdapter {
  return {
    async openSession(input): Promise<P3394RuntimeSessionBinding> {
      return { session_id: input.session_id, native_session_id: 'native-' + input.session_id, agent_id: input.agent_id };
    },
    async deliver(): Promise<{ task_id: string }> { return { task_id: taskId }; },
    async *stream(): AsyncIterable<P3394RuntimeEvent> {
      yield { sequence: 1, task_id: taskId, kind: 'started', data: {} };
      yield { sequence: 2, task_id: taskId, kind: 'delta', data: { text: 'ok' } };
      yield { sequence: 3, task_id: taskId, kind: 'completed', data: {} };
    },
    async resume(): Promise<void> {},
    async cancel(): Promise<void> {},
    async snapshot(sessionId: string): Promise<P3394RuntimeSnapshot> {
      return { session_id: sessionId, native_session_id: 'native-' + sessionId, at: new Date().toISOString() };
    },
    async closeSession(): Promise<void> {},
  };
}

function postEnvelope(port: number, envelope: unknown, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/p3394/envelope', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ envelope }));
  });
}

afterEach(async () => {
  for (const channel of openChannels.splice(0)) await channel.close().catch(() => {});
});

describe('P3394 cross-channel leak boundary (M-06/S-04)', () => {
  it('HTTP 入站信封的 secret 不进入审计 journal，关联 id 保持可追溯', async () => {
    const port = nextPort();
    const secretToken = 'super-secret-http-token';
    const payloadSecret = 'sk-abcdef0123456789';
    const bridge = new P3394BridgeKernel();
    bridge.registry.register({ identity: { agent_id: 'peer-leak', display_name: 'Peer' }, manifest: manifest('peer-leak') });
    bridge.registry.register({ identity: { agent_id: 'local-agent', display_name: 'Local' }, manifest: manifest('local-agent') });
    const executor = new P3394BridgeExecutor({ bridge, runtime: stubRuntime('tsk-leak-1') });
    const channel = new P3394HttpChannel('leak-server', { listen: { host: '127.0.0.1', port }, authToken: secretToken });
    channel.setLocalManifest(manifest('local-agent'));
    channel.subscribe((envelope) => { executor.execute(envelope); });
    await channel.listen();
    openChannels.push(channel);

    const status = await postEnvelope(port, {
      spec_version: 'p3394/1.0',
      message_id: 'msg-leak-1',
      session_id: 'ses-leak-1',
      task_id: 'tsk-leak-1',
      kind: 'task',
      performative: 'request',
      sender: { agent_id: 'peer-leak' },
      recipients: [{ agent_id: 'local-agent' }],
      payload: { parts: [{ type: 'text', text: 'leak probe' }], metadata: { goal: 'leak probe', token: payloadSecret, api_key: payloadSecret } },
      extensions: { reply_token: 'reply-secret-value' },
      idempotency_key: 'idem-leak-1',
    }, secretToken);
    expect(status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const auditText = JSON.stringify(bridge.audit.list());
    expect(auditText).not.toContain(secretToken);
    expect(auditText).not.toContain(payloadSecret);
    expect(auditText).not.toContain('reply-secret-value');
    // message_id 保持可追溯（审计最小化：bridge.send 只记录 message_id）。
    expect(auditText).toContain('msg-leak-1');

    // 内核执行闭环：任务正常进入执行（secret 不影响业务）。
    expect(executor.sessions.list().map((session) => session.session_id)).toContain('ses-leak-1');
  });

  it('错误 token 的 HTTP 入站：审计只含 path，不含 token 本身', async () => {
    const port = nextPort();
    const audit: Array<Record<string, unknown>> = [];
    const channel = new P3394HttpChannel('leak-server-2', {
      listen: { host: '127.0.0.1', port },
      authToken: 'correct-token',
      audit: (record) => { audit.push(record as unknown as Record<string, unknown>); },
    });
    channel.setLocalManifest(manifest('local-agent'));
    await channel.listen();
    openChannels.push(channel);

    const status = await postEnvelope(port, { spec_version: 'p3394/1.0' }, 'wrong-token-value');
    expect(status).toBe(401);
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain('wrong-token-value');
    expect(auditText).toContain('http.auth.reject');
    expect(auditText).toContain('/p3394/envelope');
  });
});
