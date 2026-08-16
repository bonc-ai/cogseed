import * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import { P3394A2AChannel } from '../../../../src/main/features/p3394_bridge/a2a-channel';
import type { P3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';

function envelope(): P3394Envelope {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-a2a-1',
    session_id: 'ses-a2a-1',
    task_id: 'tsk-a2a-1',
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'cogseed' },
    recipients: [{ agent_id: 'a2a-peer' }],
    payload: { parts: [{ type: 'text', text: 'review this' }], metadata: { goal: 'review' } },
    idempotency_key: 'idem-a2a-1',
  };
}

function fakeA2AServer(): Promise<{ port: number; close: () => Promise<void>; calls: Array<{ method: string; params: Record<string, unknown> }> }> {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/.well-known/agent.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'fake-a2a', protocolVersion: '0.3.0', capabilities: { streaming: false } }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method: string; params: Record<string, unknown> };
        calls.push({ method: rpc.method, params: rpc.params });
        if (rpc.method === 'message/send') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { id: 'tsk-a2a-1', contextId: 'ses-a2a-1', status: { state: 'completed', message: { role: 'agent', parts: [{ kind: 'text', text: 'A2A 审核完成：3 处风险' }] } } } }));
          return;
        }
        if (rpc.method === 'tasks/get') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { id: 'tsk-a2a-1', contextId: 'ses-a2a-1', status: { state: 'completed', message: { role: 'agent', parts: [{ kind: 'text', text: 'polled result' }] } } } }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())), calls });
    });
  });
}

describe('P3394 A2A channel adapter (SDK §13)', () => {
  it('publishes a valid A2A mapping report declaring preserved/synthesized/dropped fields', () => {
    const channel = new P3394A2AChannel('a2a-1', { endpoint: 'http://127.0.0.1:9999' });
    expect(channel.mappingReport.target).toBe('a2a');
    expect(channel.mappingReport.session_semantics).toBe('binding-mapped');
    const session = channel.mappingReport.fields.find((m) => m.field === 'session_id');
    expect(session).toMatchObject({ disposition: 'synthesized', target: 'contextId' });
  });

  it('maps a UMF envelope to A2A message/send and converts the result back to a UMF reply', async () => {
    const server = await fakeA2AServer();
    const channel = new P3394A2AChannel('a2a-1', { endpoint: 'http://127.0.0.1:' + server.port });
    const replies: P3394Envelope[] = [];
    channel.subscribe((e) => replies.push(e));
    try {
      await channel.dial();
      const receipt = await channel.send(envelope());
      expect(receipt.accepted).toBe(true);
      expect(server.calls[0].method).toBe('message/send');
      const params = server.calls[0].params as { message: { messageId: string; role: string; parts: Array<{ kind: string; text: string }>; metadata: Record<string, unknown> }; contextId: string; taskId: string };
      expect(params.message.messageId).toBe('msg-a2a-1');
      expect(params.message.role).toBe('user');
      expect(params.message.parts[0]).toEqual({ kind: 'text', text: 'review this' });
      expect(params.message.metadata).toEqual({ goal: 'review' });
      expect(params.contextId).toBe('ses-a2a-1');
      expect(params.taskId).toBe('tsk-a2a-1');
      expect(replies).toHaveLength(1);
      expect(replies[0].session_id).toBe('ses-a2a-1');
      expect(replies[0].payload.parts[0].text).toContain('A2A 审核完成');
      expect(replies[0].reply_to).toBe('msg-a2a-1');
      expect(replies[0].role).toBe('responder');
    } finally {
      await channel.close();
      await server.close();
    }
  });
});
