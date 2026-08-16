import * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import { P3394ModelRuntimeAdapter } from '../../../../src/main/features/p3394_bridge/model-runtime-adapter';
import type { P3394Envelope } from '../../../../src/main/features/p3394_bridge/envelope';

function envelope(): P3394Envelope {
  return {
    spec_version: 'p3394/1.0',
    message_id: 'msg-model-1',
    session_id: 'ses-model-1',
    task_id: 'tsk-model-1',
    kind: 'task',
    performative: 'request',
    sender: { agent_id: 'cogseed' },
    recipients: [{ agent_id: 'local-model' }],
    payload: { parts: [{ type: 'text', text: 'summarize' }] },
    idempotency_key: 'idem-model-1',
  };
}

describe('P3394 OpenAI-compatible model runtime adapter (guide §2.7/§12)', () => {
  it('declares a reduced local-bridge mapping (a model is never an agent)', () => {
    const adapter = new P3394ModelRuntimeAdapter('m1', { endpoint: 'http://127.0.0.1:8000/v1', model: 'qwen' });
    expect(adapter.mappingReport.target).toBe('openai-model');
    expect(adapter.mappingReport.session_semantics).toBe('local-bridge');
    expect(adapter.mappingReport.fields.find((m) => m.field === 'session_id')).toMatchObject({ disposition: 'synthesized', target: 'bridge-held session' });
    expect(adapter.descriptor.capabilities.artifacts).toBe('none');
  });

  it('maps a UMF envelope to chat completions and back to a UMF reply', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '模型摘要结果' } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const adapter = new P3394ModelRuntimeAdapter('m1', { endpoint: 'openai+http://127.0.0.1:' + port + '/v1', model: 'qwen', systemPrompt: 'be brief' });
    const replies: P3394Envelope[] = [];
    adapter.subscribe((e) => replies.push(e));
    try {
      await adapter.dial();
      const receipt = await adapter.send(envelope());
      expect(receipt.accepted).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].model).toBe('qwen');
      expect(calls[0].messages).toEqual([
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'summarize' },
      ]);
      expect(replies).toHaveLength(1);
      expect(replies[0].payload.parts[0].text).toBe('模型摘要结果');
      expect(replies[0].session_id).toBe('ses-model-1');
      expect(replies[0].reply_to).toBe('msg-model-1');
    } finally {
      await adapter.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
