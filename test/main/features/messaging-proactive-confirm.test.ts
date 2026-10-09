import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('messaging proactive send confirmation', () => {
  let confirm: typeof import('../../../src/main/features/messaging/proactive-confirm');
  let broadcast: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    confirm = await import('../../../src/main/features/messaging/proactive-confirm');
    broadcast = vi.fn(() => true);
    confirm._setBroadcastForTest(broadcast);
  });

  afterEach(() => {
    confirm._setBroadcastForTest(null);
  });

  function request() {
    return confirm.requestSendConfirm({
      cid: 'cid-1',
      instanceName: '飞书机器人',
      ownerLabel: '本人',
      text: '这是一条测试消息',
      timeoutMs: 200,
    });
  }

  it('broadcasts a confirm request and resolves approved on a single renderer answer', async () => {
    const waiting = request();
    expect(broadcast).toHaveBeenCalledWith('messaging:send-confirm', expect.objectContaining({
      cid: 'cid-1',
      instance_name: '飞书机器人',
      owner_label: '本人',
      text: '这是一条测试消息',
    }));
    const info = broadcast.mock.calls[0]?.[1] as { request_id: string };
    expect(typeof info.request_id).toBe('string');
    expect(confirm.respondSendConfirm(info.request_id, true)).toBe(true);
    await expect(waiting).resolves.toBe('approved');
  });

  it('resolves denied on a negative answer and consumes the request once', async () => {
    const waiting = request();
    const info = broadcast.mock.calls[0]?.[1] as { request_id: string };
    expect(confirm.respondSendConfirm(info.request_id, false)).toBe(true);
    expect(confirm.respondSendConfirm(info.request_id, true)).toBe(false);
    await expect(waiting).resolves.toBe('denied');
  });

  it('declines without a renderer broadcast', async () => {
    broadcast.mockReturnValue(false);
    await expect(request()).resolves.toBe('no_renderer');
  });

  it('times out to timed_out when the user never answers', async () => {
    await expect(request()).resolves.toBe('timed_out');
  });

  it('resolves aborted when the request signal aborts', async () => {
    const controller = new AbortController();
    const waiting = confirm.requestSendConfirm({
      cid: 'cid-1',
      instanceName: 'bot',
      ownerLabel: '本人',
      text: 'hi',
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    controller.abort();
    await expect(waiting).resolves.toBe('aborted');
  });

  it('resolves aborted for every pending request of a cancelled cid', async () => {
    const first = confirm.requestSendConfirm({ cid: 'cid-1', instanceName: 'a', ownerLabel: '本人', text: 'x', timeoutMs: 10_000 });
    const second = confirm.requestSendConfirm({ cid: 'cid-2', instanceName: 'b', ownerLabel: '本人', text: 'y', timeoutMs: 200 });
    confirm.cancelForCid('cid-1');
    await expect(first).resolves.toBe('aborted');
    await expect(second).resolves.toBe('timed_out');
  });

  it('rejects unknown or stale request ids', async () => {
    expect(confirm.respondSendConfirm('no-such-request', true)).toBe(false);
  });
});
