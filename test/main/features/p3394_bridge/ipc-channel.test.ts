import { describe, expect, it, vi } from 'vitest';
import { P3394IpcChannel } from '../../../../src/main/features/p3394_bridge/ipc-channel';

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 'msg-ipc-1',
    session_id: 'ses-ipc-1',
    kind: 'message',
    performative: 'request',
    sender: { agent_id: 'claimed-identity' },
    recipients: [{ agent_id: 'cogseed-agent' }],
    payload: { parts: [{ type: 'text', text: 'hello via ipc' }] },
    idempotency_key: 'idem-ipc-1',
    ...overrides,
  };
}

describe('P3394IpcChannel main-process port', () => {
  it('rewrites the sender to the local agent identity (renderer cannot claim an identity)', async () => {
    const port = new P3394IpcChannel('ipc', { resolveLocalAgentId: () => 'local-agent' });
    const received: string[] = [];
    port.subscribe((e) => received.push(e.sender.agent_id));
    const result = port.handleInbound(envelope() as never);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.sender.agent_id).toBe('local-agent');
    expect(received).toEqual(['local-agent']);
  });

  it('rejects malformed envelopes before dispatch', async () => {
    const port = new P3394IpcChannel('ipc');
    const received: string[] = [];
    port.subscribe(() => received.push('x'));
    const bad = port.handleInbound(envelope({ sender: undefined }) as never);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.reason).toBe('missing_sender');
    expect(received).toEqual([]);
  });

  it('rejects envelopes missing idempotency key', async () => {
    const port = new P3394IpcChannel('ipc');
    const result = port.handleInbound(envelope({ idempotency_key: undefined }) as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('missing_idempotency_key');
  });

  it('pushes envelopes to renderers through the injected transport', async () => {
    const sent: unknown[] = [];
    const port = new P3394IpcChannel('ipc', { sendToRenderer: (payload) => sent.push(payload) });
    await port.send(envelope() as never);
    expect(sent).toHaveLength(1);
    expect((sent[0] as { message_id: string }).message_id).toBe('msg-ipc-1');
  });

  it('unsubscribes listeners', async () => {
    const port = new P3394IpcChannel('ipc');
    const received: string[] = [];
    const unsubscribe = port.subscribe(() => received.push('x'));
    unsubscribe();
    port.handleInbound(envelope() as never);
    expect(received).toEqual([]);
  });

  it('rejects inbound after close and refuses send after close', async () => {
    const port = new P3394IpcChannel('ipc');
    await port.listen();
    await port.close();
    const result = port.handleInbound(envelope() as never);
    expect(result.ok).toBe(false);
    await expect(port.send(envelope() as never)).rejects.toThrow('p3394_channel_closed');
  });

  it('dispatches valid envelopes to all subscribers', async () => {
    const port = new P3394IpcChannel('ipc');
    const a: string[] = [];
    const b: string[] = [];
    port.subscribe((e) => a.push(e.message_id));
    port.subscribe((e) => b.push(e.message_id));
    const result = port.handleInbound(envelope() as never);
    expect(result.ok).toBe(true);
    expect(a).toEqual(['msg-ipc-1']);
    expect(b).toEqual(['msg-ipc-1']);
    expect(vi.isMockFunction(port.subscribe)).toBe(false);
  });
});
