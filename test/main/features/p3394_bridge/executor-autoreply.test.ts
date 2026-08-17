import * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import { P3394BridgeKernel } from '../../../../src/main/features/p3394_bridge/bridge';
import { P3394BridgeExecutor, postP3394AutoReplyHttp } from '../../../../src/main/features/p3394_bridge/executor';
import { buildP3394BridgeManifest } from '../../../../src/main/features/p3394_bridge/manifest';
import type { P3394RuntimeAdapter, P3394RuntimeEvent, P3394RuntimeSessionBinding, P3394RuntimeSnapshot } from '../../../../src/main/features/p3394_bridge/runtime-adapter';
import type { P3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';

function manifest(id: string) {
  const r = buildP3394BridgeManifest({ agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general' } as never);
  if (!r.ok) throw new Error(r.error.message);
  return r.manifest;
}

function envelope(overrides: Record<string, unknown> = {}): P3394Envelope {
  return {
    message_id: 'msg-ar-1',
    session_id: 'ses-ar-1',
    task_id: 'tsk-ar-1',
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'hermes' },
    recipients: [{ agent_id: 'cogseed' }],
    payload: { parts: [{ type: 'text', text: 'help me' }] },
    idempotency_key: 'idem-ar-1',
    ...overrides,
  } as P3394Envelope;
}

function fakeRuntime(taskId: string, events: Array<Partial<P3394RuntimeEvent> & { kind: P3394RuntimeEvent['kind'] }>): P3394RuntimeAdapter {
  return {
    async openSession(_input): Promise<P3394RuntimeSessionBinding> {
      return { session_id: 'ses-ar-1', native_session_id: 'native-1', agent_id: 'cogseed' };
    },
    async deliver(): Promise<{ task_id: string }> { return { task_id: taskId }; },
    async *stream(): AsyncIterable<P3394RuntimeEvent> {
      let seq = 0;
      for (const e of events) { seq += 1; yield { sequence: seq, task_id: taskId, ...e } as P3394RuntimeEvent; }
    },
    async resume(): Promise<void> {},
    async cancel(): Promise<void> {},
    async snapshot(): Promise<P3394RuntimeSnapshot> {
      return { session_id: 'ses-ar-1', native_session_id: 'native-1', at: new Date().toISOString() };
    },
    async closeSession(): Promise<void> {},
  };
}

function bridge() {
  const b = new P3394BridgeKernel();
  b.registry.register({ identity: { agent_id: 'cogseed', display_name: 'CogSeed' }, manifest: manifest('cogseed') });
  b.registry.register({ identity: { agent_id: 'hermes', display_name: 'Hermes' }, manifest: manifest('hermes') });
  return b;
}

function events(): Array<Partial<P3394RuntimeEvent> & { kind: P3394RuntimeEvent['kind'] }> {
  return [
    { kind: 'started' },
    { kind: 'delta', data: { text: '这是 CogSeed 的回答' } },
    { kind: 'completed' },
  ];
}

describe('P3394 executor §11 result auto-reply', () => {
  it('posts the CogSeed answer back to a loopback reply_endpoint', async () => {
    const b = bridge();
    const posts: Array<{ endpoint: string; token: string; envelope: P3394Envelope }> = [];
    const executor = new P3394BridgeExecutor({
      bridge: b,
      runtime: fakeRuntime('tsk-ar-1', events()),
      autoReply: { post: async (endpoint, token, env) => { posts.push({ endpoint, token, envelope: env }); } },
    });
    const input = envelope({ extensions: { reply_endpoint: 'http://127.0.0.1:9000', reply_token: 'tok-1' } });
    const result = executor.execute(input);
    expect(result.ok).toBe(true);
    if (result.ok) await executor.awaitForward(result.task_id as string);
    expect(posts).toHaveLength(1);
    const reply = posts[0].envelope;
    expect(reply.kind).toBe('message');
    expect(reply.performative).toBe('inform');
    expect(reply.role).toBe('responder');
    expect(reply.session_id).toBe('ses-ar-1');
    expect(reply.task_id).toBe('tsk-ar-1');
    expect(reply.reply_to).toBe('msg-ar-1');
    expect(reply.sender.agent_id).toBe('cogseed');
    expect(reply.recipients[0].agent_id).toBe('hermes');
    expect(reply.payload.parts[0].text).toBe('这是 CogSeed 的回答');
    expect(reply.idempotency_key).toBe('auto-reply:msg-ar-1');
  });

  it('rejects non-loopback endpoints unless explicitly allowed (SSRF guard)', async () => {
    const b = bridge();
    const posts: Array<P3394Envelope> = [];
    const executor = new P3394BridgeExecutor({
      bridge: b,
      runtime: fakeRuntime('tsk-ar-1', events()),
      autoReply: { post: async (_e, _t, env) => { posts.push(env); } },
    });
    const result = executor.execute(envelope({ extensions: { reply_endpoint: 'http://evil.example.com:4444' } }));
    if (result.ok) await executor.awaitForward(result.task_id as string);
    expect(posts).toHaveLength(0);
    expect(b.audit.list()).toContainEqual(expect.objectContaining({ event: 'autoreply.reject' }));

    // 注入 allowEndpoint 后放行
    const executor2 = new P3394BridgeExecutor({
      bridge: b,
      runtime: fakeRuntime('tsk-ar-2', events()),
      autoReply: { post: async (_e, _t, env) => { posts.push(env); }, allowEndpoint: (ep) => ep.startsWith('http://evil.example.com') },
    });
    const result2 = executor2.execute(envelope({ message_id: 'msg-ar-2', task_id: 'tsk-ar-2', idempotency_key: 'idem-ar-2', extensions: { reply_endpoint: 'http://evil.example.com:4444' } }));
    if (result2.ok) await executor2.awaitForward(result2.task_id as string);
    expect(posts).toHaveLength(1);
  });

  it('sends an error envelope when the task fails', async () => {
    const b = bridge();
    const posts: Array<P3394Envelope> = [];
    const executor = new P3394BridgeExecutor({
      bridge: b,
      runtime: fakeRuntime('tsk-ar-1', [{ kind: 'started' }, { kind: 'failed', data: { error: 'boom' } }]),
      autoReply: { post: async (_e, _t, env) => { posts.push(env); } },
    });
    const result = executor.execute(envelope({ extensions: { reply_endpoint: 'http://localhost:9000' } }));
    if (result.ok) await executor.awaitForward(result.task_id as string);
    expect(posts).toHaveLength(1);
    expect(posts[0].kind).toBe('error');
    expect(posts[0].performative).toBe('error');
    expect((posts[0].payload.parts[0] as { data: { error: string } }).data.error).toBe('boom');
  });

  it('stays silent when disabled or when no reply_endpoint is declared', async () => {
    const b = bridge();
    const posts: Array<P3394Envelope> = [];
    const executor = new P3394BridgeExecutor({
      bridge: b,
      runtime: fakeRuntime('tsk-ar-1', events()),
      autoReply: { enabled: false, post: async (_e, _t, env) => { posts.push(env); } },
    });
    const result = executor.execute(envelope({ extensions: { reply_endpoint: 'http://127.0.0.1:9000' } }));
    if (result.ok) await executor.awaitForward(result.task_id as string);
    expect(posts).toHaveLength(0);

    const executor2 = new P3394BridgeExecutor({
      bridge: b,
      runtime: fakeRuntime('tsk-ar-1', events()),
      autoReply: { post: async (_e, _t, env) => { posts.push(env); } },
    });
    const result2 = executor2.execute(envelope({}));
    if (result2.ok) await executor2.awaitForward(result2.task_id as string);
    expect(posts).toHaveLength(0);
  });

  it('delivers a real HTTP auto reply over POST /p3394/envelope', async () => {
    const received: Array<{ auth?: string; body: unknown }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    try {
      await postP3394AutoReplyHttp('http://127.0.0.1:' + address.port, 'tok-x', envelope() as P3394Envelope);
      expect(received).toHaveLength(1);
      expect(received[0].auth).toBe('Bearer tok-x');
      const body = received[0].body as { envelope: { message_id: string } };
      expect(body.envelope.message_id).toBe('msg-ar-1');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
