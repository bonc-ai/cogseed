import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { P3394McpBridgeServer } from '../../../../src/main/features/p3394_bridge/mcp-surface';

describe('P3394 SA-MCP bridge surface (SDK §10.2)', () => {
  async function call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (c: Buffer) => chunks.push(c));
    const server = new P3394McpBridgeServer({
      listPeers: () => [{ agent_id: 'hermes', display_name: 'Hermes', capabilities: ['handle_message'], online: true }],
      sendToPeer: async (peer, message, opts) => {
        if (peer === 'hermes') return { status: 'ok', peer, reply: 'echo:' + message + (opts?.goal ? ' goal=' + opts.goal : '') };
        return { status: 'error', peer, error: 'p3394_peer_not_registered' };
      },
      getTask: (taskId) => ({ task_id: taskId, state: 'completed' }),
      cancelTask: async () => {},
      getResource: (digest) => Buffer.from('resource:' + digest),
    });
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    await server.handleLine(line, output);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  it('handles MCP initialize with tools capability', async () => {
    const response = await call('initialize', {}) as { result: { protocolVersion: string; capabilities: { tools: { listChanged: boolean } } } };
    expect(response.result.protocolVersion).toBe('2024-11-05');
    expect(response.result.capabilities.tools.listChanged).toBe(false);
  });

  it('lists the five SA-MCP bridge tools', async () => {
    const response = await call('tools/list', {}) as { result: { tools: Array<{ name: string }> } };
    const names = response.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['p3394.peer.discover', 'p3394.peer.send', 'p3394.resource.get', 'p3394.task.cancel', 'p3394.task.get']);
  });

  it('discovers peers and sends to a peer with goal routing', async () => {
    const discover = await call('tools/call', { name: 'p3394.peer.discover', arguments: {} }) as { result: { content: Array<{ text: string }> } };
    const peers = JSON.parse(discover.result.content[0].text) as { peers: Array<{ agent_id: string }> };
    expect(peers.peers[0].agent_id).toBe('hermes');

    const send = await call('tools/call', { name: 'p3394.peer.send', arguments: { peer: 'hermes', message: 'hi', goal: 'review' } }) as { result: { content: Array<{ text: string }> } };
    const sent = JSON.parse(send.result.content[0].text) as { status: string; reply: string };
    expect(sent).toEqual({ status: 'ok', peer: 'hermes', reply: 'echo:hi goal=review' });
  });

  it('keeps P3394 session semantics through the tool projection (E6, §17.4)', async () => {
    // 工具投影（tool call 形态）不得丢掉 P3394 会话语义：显式 session_id
    // 必须原样透传给 sendToPeer（指南 §7.4：as_tool 只是本地投影，内部
    // 仍须创建或恢复 P3394 Session）。
    const seen: Array<{ peer: string; opts?: { session_id?: string; goal?: string } }> = [];
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (c: Buffer) => chunks.push(c));
    const server = new P3394McpBridgeServer({
      listPeers: () => [{ agent_id: 'hermes', display_name: 'Hermes', capabilities: ['handle_message'], online: true }],
      sendToPeer: async (peer, message, opts) => {
        seen.push({ peer, opts });
        return { status: 'ok', peer, reply: message };
      },
      getTask: (taskId) => ({ task_id: taskId, state: 'completed' }),
      cancelTask: async () => {},
      getResource: (digest) => Buffer.from('resource:' + digest),
    });
    const callTool = async (args: Record<string, unknown>) => {
      chunks.length = 0;
      await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'p3394.peer.send', arguments: args } }), output);
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };
    await callTool({ peer: 'hermes', message: 'first', session_id: 'ses-proj-1', goal: 'review' });
    await callTool({ peer: 'hermes', message: 'second', session_id: 'ses-proj-1', goal: 'review' });
    expect(seen.map((s) => s.opts?.session_id)).toEqual(['ses-proj-1', 'ses-proj-1']);
    expect(seen.every((s) => s.peer === 'hermes' && s.opts?.goal === 'review')).toBe(true);
    // 未显式给 session_id 的调用不得伪造（undefined 透传，由下层会话存储决定）。
    await callTool({ peer: 'hermes', message: 'third', goal: 'review' });
    expect(seen[2].opts?.session_id).toBeUndefined();
  });

  it('reports errors for unknown peers and missing tools', async () => {
    const send = await call('tools/call', { name: 'p3394.peer.send', arguments: { peer: 'nobody', message: 'hi' } }) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(send.result.isError).toBe(true);
    const parsed = JSON.parse(send.result.content[0].text) as { status: string; error: string };
    expect(parsed.error).toBe('p3394_peer_not_registered');
  });

  it('gets tasks and resources', async () => {
    const task = await call('tools/call', { name: 'p3394.task.get', arguments: { task_id: 't1' } }) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(task.result.content[0].text)).toMatchObject({ status: 'ok', task: { task_id: 't1', state: 'completed' } });
    const resource = await call('tools/call', { name: 'p3394.resource.get', arguments: { digest: 'abc' } }) as { result: { content: Array<{ text: string }> } };
    const res = JSON.parse(resource.result.content[0].text) as { base64: string };
    expect(Buffer.from(res.base64, 'base64').toString('utf8')).toBe('resource:abc');
  });
});
