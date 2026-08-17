/**
 * P3394 gateway turn runner — group-chat dispatch path (自愈/重试/错误分类).
 *
 * The runner is the conversation-side entry for 「外接」agents
 * (runtime.kind === 'p3394-gateway'): it resolves the node, auto-starts the
 * managed gateway when the node is offline, retries once on recoverable
 * transport errors, and maps failures to explicit failure codes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above the imports, so the fns must live in
// vi.hoisted to avoid TDZ ("Cannot access 'x' before initialization").
const mocks = vi.hoisted(() => ({
  detectOne: vi.fn(),
  getP3394OutboundHub: vi.fn(),
  listP3394Peers: vi.fn(),
  buildP3394OutboundEnvelope: vi.fn(),
  p3394ExternalGatewayIdFor: vi.fn(),
  startExternalGateway: vi.fn(),
}));

vi.mock('../../../../src/main/features/local_agents/registry.js', () => ({ detectOne: mocks.detectOne }));
vi.mock('../../../../src/main/features/p3394_bridge/app-wiring', () => ({
  getP3394OutboundHub: mocks.getP3394OutboundHub,
  listP3394Peers: mocks.listP3394Peers,
}));
vi.mock('../../../../src/main/features/cogseed_backend/p3394-host-adapter', () => ({ buildP3394OutboundEnvelope: mocks.buildP3394OutboundEnvelope }));
vi.mock('../../../../src/main/features/p3394_bridge/external-gateways', () => ({
  p3394ExternalGatewayIdFor: mocks.p3394ExternalGatewayIdFor,
  startExternalGateway: mocks.startExternalGateway,
}));

import { runP3394GatewayTurn } from '../../../../src/main/features/p3394_bridge/p3394-gateway-turn';

const baseInput = {
  uid: 'user-1',
  cid: 'cid-1',
  agent: { agent_id: 'agent-ext-1', name: 'Hermes' },
  cli: 'hermes',
  prompt: 'review this',
};

const hub = {
  sendAndWait: vi.fn(async () => ({ text: 'hermes reply' })),
};

describe('P3394 gateway turn runner', () => {
  beforeEach(() => {
    mocks.detectOne.mockReset();
    mocks.getP3394OutboundHub.mockReset();
    mocks.listP3394Peers.mockReset();
    mocks.buildP3394OutboundEnvelope.mockReset();
    mocks.p3394ExternalGatewayIdFor.mockReset();
    mocks.startExternalGateway.mockReset();
    hub.sendAndWait.mockReset();
    mocks.detectOne.mockResolvedValue({ type: 'hermes', path: '/usr/local/bin/hermes', version: '1.0.0', available: true });
    mocks.getP3394OutboundHub.mockReturnValue(hub);
    mocks.listP3394Peers.mockResolvedValue([]);
    mocks.buildP3394OutboundEnvelope.mockReturnValue({
      spec_version: 'p3394/1.0', message_id: 'msg-1', session_id: 'ses-1', task_id: 'tsk-1',
      kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }],
      payload: { parts: [{ type: 'text', text: 'hi' }] }, idempotency_key: 'idem-1',
    });
    mocks.p3394ExternalGatewayIdFor.mockImplementation((cli: string) => (cli === 'hermes' || cli === 'claude' || cli === 'codex' ? cli : null));
    mocks.startExternalGateway.mockResolvedValue({ ok: true, value: { cli: 'hermes', agent_id: 'hermes', alias: 'Hermes', bin: '/bin/echo', port: 9100, pid: 42, started_at: new Date().toISOString(), running: true } });
    hub.sendAndWait.mockResolvedValue({ text: 'hermes reply' });
  });

  it('returns the node reply when the peer is already online', async () => {
    mocks.listP3394Peers.mockResolvedValueOnce([{ agent_id: 'hermes', endpoints: ['http://127.0.0.1:9100'] }]);

    const result = await runP3394GatewayTurn(baseInput);

    expect(result).toEqual({ text: 'hermes reply' });
    expect(mocks.startExternalGateway).not.toHaveBeenCalled();
    expect(hub.sendAndWait).toHaveBeenCalledTimes(1);
  });

  it('auto-starts the managed gateway when the node is offline and retries successfully', async () => {
    const result = await runP3394GatewayTurn(baseInput);

    expect(result).toEqual({ text: 'hermes reply' });
    expect(mocks.startExternalGateway).toHaveBeenCalledTimes(1);
    expect(mocks.startExternalGateway).toHaveBeenCalledWith(expect.objectContaining({ cli: 'hermes', binPath: '/usr/local/bin/hermes', alias: 'Hermes' }));
    expect(hub.sendAndWait).toHaveBeenCalledTimes(1);
  });

  it('recovers once on a recoverable transport error and then succeeds', async () => {
    mocks.listP3394Peers.mockResolvedValueOnce([{ agent_id: 'hermes', endpoints: ['http://127.0.0.1:9100'] }]);
    hub.sendAndWait
      .mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:9100'))
      .mockResolvedValueOnce({ text: 'hermes after restart' });

    const result = await runP3394GatewayTurn(baseInput);

    expect(result).toEqual({ text: 'hermes after restart' });
    expect(mocks.startExternalGateway).toHaveBeenCalledTimes(1);
    expect(hub.sendAndWait).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty CLI with p3394_unsupported_cli', async () => {
    const result = await runP3394GatewayTurn({ ...baseInput, cli: '' });

    expect(result.failureCode).toBe('p3394_unsupported_cli');
    expect(result.failureKind).toBe('runtime');
    expect(hub.sendAndWait).not.toHaveBeenCalled();
  });

  it('returns p3394_node_offline for unmanaged offline nodes without auto-start', async () => {
    // cli 不是已知 preset → 无托管网关可自愈。
    mocks.p3394ExternalGatewayIdFor.mockReturnValueOnce(null);

    const result = await runP3394GatewayTurn({ ...baseInput, cli: 'custom-agent' });

    expect(result.failureCode).toBe('p3394_node_offline');
    expect(mocks.startExternalGateway).not.toHaveBeenCalled();
  });

  it('returns p3394_gateway_start_failed when the managed gateway cannot start', async () => {
    mocks.startExternalGateway.mockResolvedValueOnce({ ok: false, error: 'p3394_gateway_script_missing' });

    const result = await runP3394GatewayTurn(baseInput);

    expect(result.failureCode).toBe('p3394_gateway_start_failed');
    expect(hub.sendAndWait).not.toHaveBeenCalled();
  });

  it('maps an unrecoverable send failure to p3394_send_failed with infrastructure flag', async () => {
    mocks.listP3394Peers.mockResolvedValueOnce([{ agent_id: 'hermes', endpoints: ['http://127.0.0.1:9100'] }]);
    hub.sendAndWait.mockRejectedValueOnce(new Error('p3394_reply_timeout'));

    const result = await runP3394GatewayTurn(baseInput);

    expect(result.failureCode).toBe('p3394_reply_timeout');
    expect(result.infrastructureFailure).toBe(true);
    expect(mocks.startExternalGateway).not.toHaveBeenCalled();
  });
});
