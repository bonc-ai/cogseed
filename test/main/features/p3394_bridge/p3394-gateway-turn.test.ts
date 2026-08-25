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
  waitForSessionFree: vi.fn(async () => true),
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
    hub.waitForSessionFree.mockReset();
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
    hub.waitForSessionFree.mockResolvedValue(true);
  });

  it('routes openclaw-style progress frames to the process rail and still lands the final text', async () => {
    mocks.listP3394Peers.mockResolvedValueOnce([{ agent_id: 'hermes', endpoints: ['http://127.0.0.1:9100'] }]);
    // openclaw 网关：运行中只发 progress 帧（[skills]/[tools] 过程日志），
    // 正文由终态回复一次性落地。progress 不得置 streamed，否则正文会被吞掉。
    hub.sendAndWait.mockImplementation(async (_nodeId, _envelope, onStream) => {
      onStream?.({ text: '[tools] run bash build', kind: 'progress', envelope: {} as never, sequence: 1 });
      onStream?.({ text: '[skills] web_search', kind: 'progress', envelope: {} as never, sequence: 2 });
      return { text: 'final openclaw reply' };
    });
    const processes: Array<{ type: string; text: string }> = [];
    const result = await runP3394GatewayTurn({ ...baseInput, onProcess: (event) => { processes.push(event as never); } });

    expect(result).toEqual({ text: 'final openclaw reply' });
    // 过程日志进 process rail（progress 事件），每条一行。
    expect(processes.filter((e) => e.type === 'progress' && e.text === '[tools] run bash build')).toHaveLength(1);
    expect(processes.filter((e) => e.type === 'progress' && e.text === '[skills] web_search')).toHaveLength(1);
    // 正文不因 progress 帧丢失：终态回复仍以 delta 一次性落地。
    expect(processes.filter((e) => e.type === 'delta' && e.text === 'final openclaw reply')).toHaveLength(1);
  });

  it('waits for a busy session to drain instead of failing on p3394_session_conflict', async () => {
    mocks.listP3394Peers.mockResolvedValueOnce([{ agent_id: 'hermes', endpoints: ['http://127.0.0.1:9100'] }]);
    // 第一次 sendAndWait：同一会话上一轮仍在途 → 冲突；等待会话排空后重发成功。
    hub.sendAndWait
      .mockRejectedValueOnce(new Error('p3394_session_conflict'))
      .mockResolvedValueOnce({ text: 'hermes second reply' });
    const processes: Array<{ type: string; text: string }> = [];
    const result = await runP3394GatewayTurn({ ...baseInput, onProcess: (event) => { processes.push(event as never); } });

    expect(result).toEqual({ text: 'hermes second reply' });
    expect(hub.sendAndWait).toHaveBeenCalledTimes(2);
    expect(hub.waitForSessionFree).toHaveBeenCalledTimes(1);
    // 排队等待时给用户进度提示，而不是静默判死。
    expect(processes.some((event) => event.type === 'progress' && /上一轮对话尚未完成/.test(event.text))).toBe(true);
  });

  it('rebuilds the envelope with a fresh message id when retrying after a conflict', async () => {
    mocks.listP3394Peers.mockResolvedValueOnce([{ agent_id: 'hermes', endpoints: ['http://127.0.0.1:9100'] }]);
    // 每次 buildEnvelope 都返回新 message_id（幂等键随之更新），session_id 保持稳定。
    let call = 0;
    mocks.buildP3394OutboundEnvelope.mockImplementation(() => {
      call += 1;
      return {
        spec_version: 'p3394/1.0', message_id: 'msg-rebuilt-' + call, session_id: 'ses-1', task_id: 'tsk-rebuilt-' + call,
        kind: 'task', performative: 'request', sender: { agent_id: 'cogseed' }, recipients: [{ agent_id: 'hermes' }],
        payload: { parts: [{ type: 'text', text: 'hi' }] }, idempotency_key: 'idem-rebuilt-' + call,
      };
    });
    hub.sendAndWait
      .mockRejectedValueOnce(new Error('p3394_session_conflict'))
      .mockResolvedValueOnce({ text: 'hermes second reply' });

    const result = await runP3394GatewayTurn({ ...baseInput, onProcess: () => {} });

    expect(result).toEqual({ text: 'hermes second reply' });
    expect(call).toBe(2);
    const firstEnvelope = hub.sendAndWait.mock.calls[0][1] as { message_id: string; session_id: string };
    const secondEnvelope = hub.sendAndWait.mock.calls[1][1] as { message_id: string; session_id: string };
    // 重试不能用同一个信封：message_id/幂等键必须全新，session_id 保持稳定。
    expect(secondEnvelope.message_id).not.toBe(firstEnvelope.message_id);
    expect(secondEnvelope.session_id).toBe(firstEnvelope.session_id);
  });

  it('bails out with aborted when the user cancels while waiting for the busy session', async () => {
    mocks.listP3394Peers.mockResolvedValueOnce([{ agent_id: 'hermes', endpoints: ['http://127.0.0.1:9100'] }]);
    const controller = new AbortController();
    hub.sendAndWait.mockRejectedValue(new Error('p3394_session_conflict'));
    // 等待期间用户取消：waitForSessionFree 立即放行（abort），turn 必须返回
    // aborted 而不是继续等/再发。
    hub.waitForSessionFree.mockImplementation(async () => { controller.abort(); return true; });

    const result = await runP3394GatewayTurn({ ...baseInput, signal: controller.signal });

    expect(result).toEqual({ text: '', aborted: true });
    expect(hub.sendAndWait).toHaveBeenCalledTimes(1);
  });

  it('reports the original conflict when the busy session never drains', async () => {
    mocks.listP3394Peers.mockResolvedValueOnce([{ agent_id: 'hermes', endpoints: ['http://127.0.0.1:9100'] }]);
    hub.sendAndWait.mockRejectedValue(new Error('p3394_session_conflict'));
    hub.waitForSessionFree.mockResolvedValue(false); // 上一轮一直未回，等待超限

    const result = await runP3394GatewayTurn(baseInput);

    expect(result.failureCode).toBe('p3394_send_failed');
    expect(result.infrastructureFailure).toBe(true);
    expect(hub.sendAndWait).toHaveBeenCalledTimes(1);
  });

  it('fails fast with p3394_cli_not_found when the CLI is not installed (no binary path)', async () => {
    mocks.detectOne.mockResolvedValueOnce({ type: 'hermes', path: null, version: null, available: false, error: 'not_found' });

    const result = await runP3394GatewayTurn(baseInput);

    expect(result.failureCode).toBe('p3394_cli_not_found');
    expect(result.failureKind).toBe('runtime');
    expect(mocks.startExternalGateway).not.toHaveBeenCalled();
    expect(hub.sendAndWait).not.toHaveBeenCalled();
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

  it('passes the working directory through to the outbound envelope extensions', async () => {
    mocks.listP3394Peers.mockResolvedValueOnce([{ agent_id: 'hermes', endpoints: ['http://127.0.0.1:9100'] }]);
    const result = await runP3394GatewayTurn({ ...baseInput, workingDir: '/tmp/proj-a' });

    expect(result.text).toBe('hermes reply');
    // 信封必须携带工作目录，否则外部 agent 会退回根目录 `/`。
    const [, , , opts] = mocks.buildP3394OutboundEnvelope.mock.calls[0] as unknown as [string, string, string, { workingDir?: string }];
    expect(opts?.workingDir).toBe('/tmp/proj-a');
  });

  it('forwards the turn goal to the envelope builder for topic-isolated sessions (G-28)', async () => {
    mocks.listP3394Peers.mockResolvedValueOnce([{ agent_id: 'hermes', endpoints: ['http://127.0.0.1:9100'] }]);
    // G-28 话题隔离：goal 透传给信封构造（buildP3394OutboundEnvelope 内的
    // sessionForGoal 按 (scope, peer, goal) 分会话——同 goal 复用、异 goal
    // 开新会话的行为由 session-store.test.ts 覆盖）。
    await runP3394GatewayTurn({ ...baseInput, goal: 'req:req-42' });
    const [, , , withGoal] = mocks.buildP3394OutboundEnvelope.mock.calls[0] as unknown as [string, string, string, { goal?: string; scopeKey?: string }];
    expect(withGoal?.goal).toBe('req:req-42');
    expect(withGoal?.scopeKey).toBe('cid-1');

    // goal 缺省（闲聊 / KStar 无开放需求）：信封构造不收 goal 字段，保持
    // (cid, peer) 稳定会话的原行为。
    mocks.buildP3394OutboundEnvelope.mockClear();
    await runP3394GatewayTurn({ ...baseInput });
    const [, , , withoutGoal] = mocks.buildP3394OutboundEnvelope.mock.calls[0] as unknown as [string, string, string, { goal?: string }];
    expect(withoutGoal?.goal).toBeUndefined();
  });
});
