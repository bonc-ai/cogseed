import { describe, expect, it } from 'vitest';
import { P3394InProcessChannel } from '../../../../src/main/features/p3394_bridge/in-process-channel';
import { P3394HttpChannel } from '../../../../src/main/features/p3394_bridge/http-channel';
import { runP3394ChannelAdapterConformance } from '../../../../src/main/features/p3394_bridge/channel-testkit';

describe('P3394 channel adapter test kit', () => {
  it('passes the in-process adapter through the full contract suite', async () => {
    const report = await runP3394ChannelAdapterConformance(new P3394InProcessChannel());
    expect(report.adapter).toBe('org.p3394.channel.in_process');
    expect(report.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('covers descriptor, delivery, unsubscribe, health and close semantics', async () => {
    const report = await runP3394ChannelAdapterConformance(new P3394InProcessChannel());
    const names = report.checks.map((c) => c.name);
    for (const expected of ['descriptor.id', 'descriptor.schemes', 'descriptor.roles', 'descriptor.bindings', 'descriptor.capabilities', 'delivery.receipt', 'delivery.roundtrip', 'delivery.unsubscribe', 'health', 'close.graceful', 'close.send_rejected']) {
      expect(names).toContain(expected);
    }
  });

  it('flags a malformed adapter', async () => {
    const bad = {
      descriptor: { id: '', schemes: [], roles: [], bindings: ['not-umf'], capabilities: null },
      async listen() {},
      async dial() {},
      async send() { return { channel_id: 'x', message_id: 'm', accepted: false }; },
      subscribe() { return () => {}; },
      async close() {},
    } as unknown as Parameters<typeof runP3394ChannelAdapterConformance>[0];
    const report = await runP3394ChannelAdapterConformance(bad);
    expect(report.ok).toBe(false);
    expect(report.checks.filter((c) => c.status === 'fail').length).toBeGreaterThan(0);
  });

  it('treats the http adapter as a remote channel (no loopback delivery expected)', async () => {
    const report = await runP3394ChannelAdapterConformance(new P3394HttpChannel('tk-http', {}));
    expect(report.checks.find((c) => c.name === 'delivery.roundtrip')?.status).toBe('skip');
  });
});
